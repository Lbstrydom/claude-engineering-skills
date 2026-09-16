/**
 * @fileoverview Phase D — debt-ledger tests.
 * Covers read/write/merge/remove + contentAliases + source-aware merge.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readDebtLedger,
  writeDebtEntries,
  removeDebtEntry,
  mergeLedgers,
  findDebtByAlias,
  markSuperseded,
  serializeLedgerForDisk,
  isLedgerTracked,
} from '../scripts/lib/debt-ledger.mjs';
import { findDuplicateTopicIds } from '../scripts/lib/debt-review-helpers.mjs';
import { gitInit, commit } from './helpers/fixtures.mjs';

let tmpDir;
let ledgerPath;

function makeEntry(overrides = {}) {
  return {
    source: 'debt',
    topicId: 'aa00',
    semanticHash: 'hash00',
    severity: 'HIGH',
    category: 'test',
    section: 'src/x.js:1',
    detailSnapshot: 'details',
    affectedFiles: ['src/x.js'],
    affectedPrinciples: [],
    pass: 'backend',
    deferredReason: 'out-of-scope',
    deferredAt: '2026-04-05T10:00:00.000Z',
    deferredRun: 'r1',
    deferredRationale: 'a sufficiently long rationale string for testing',
    contentAliases: [],
    sensitive: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-ledger-test-'));
  ledgerPath = path.join(tmpDir, 'tech-debt.json');
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

// ── readDebtLedger ──────────────────────────────────────────────────────────

describe('readDebtLedger', () => {
  test('reports UNAVAILABLE on ENOENT — not an empty ledger', () => {
    // This assertion used to read `deepEqual(r, {version:1, entries:[]})`, which
    // pinned the defect rather than the contract: an absent ledger and a real
    // empty one were the same value, so no caller could tell them apart and
    // five scripts reported "clean" having read nothing. `entries` still comes
    // back `[]` so existing destructuring callers are unaffected; the
    // discriminator is what makes the absence visible.
    // See docs/plans/backlog-and-drift-reduction.md §2 (availability contract).
    const r = readDebtLedger({ ledgerPath, events: [] });
    assert.deepEqual(r, {
      version: 1, entries: [], available: false, reason: 'clean-checkout-sandbox', budgets: {},
    });
  });

  test('throws on JSON parse error', () => {
    fs.writeFileSync(ledgerPath, '{ invalid json');
    assert.throws(() => readDebtLedger({ ledgerPath, events: [] }), /corrupted/);
  });

  test('throws on missing entries array', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1 }));
    assert.throws(() => readDebtLedger({ ledgerPath, events: [] }), /missing entries array/);
  });

  test('hydrates entries with event-derived fields', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      entries: [makeEntry()],
    }));
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'aa00', event: 'surfaced', matchCount: 2 },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'aa00', event: 'surfaced' },
    ];
    const r = readDebtLedger({ ledgerPath, events });
    assert.equal(r.entries[0].occurrences, 2);
    assert.equal(r.entries[0].distinctRunCount, 2);
    assert.equal(r.entries[0].matchCount, 3);
    assert.equal(r.entries[0].lastSurfacedRun, 'r2');
  });

  test('hydrates entries with no events → derived fields default to 0/false', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: [makeEntry()] }));
    const r = readDebtLedger({ ledgerPath, events: [] });
    assert.equal(r.entries[0].occurrences, 0);
    assert.equal(r.entries[0].distinctRunCount, 0);
    assert.equal(r.entries[0].escalated, false);
  });
});

// ── writeDebtEntries ────────────────────────────────────────────────────────

describe('writeDebtEntries', () => {
  test('inserts new entries', async () => {
    const r = await writeDebtEntries([makeEntry()], { ledgerPath });
    assert.equal(r.inserted, 1);
    assert.equal(r.updated, 0);
    assert.equal(r.total, 1);
    assert.equal(r.rejected.length, 0);
  });

  test('updates existing entries on topicId match', async () => {
    await writeDebtEntries([makeEntry()], { ledgerPath });
    const r = await writeDebtEntries([makeEntry({ deferredRationale: 'an updated rationale (also long)' })], { ledgerPath });
    assert.equal(r.inserted, 0);
    assert.equal(r.updated, 1);
    const read = readDebtLedger({ ledgerPath, events: [] });
    assert.equal(read.entries[0].deferredRationale, 'an updated rationale (also long)');
  });

  test('preserves immutable deferredAt/deferredRun on update', async () => {
    await writeDebtEntries([makeEntry({ deferredAt: '2026-04-01T00:00:00.000Z', deferredRun: 'original' })], { ledgerPath });
    await writeDebtEntries([makeEntry({ deferredAt: '2026-04-10T00:00:00.000Z', deferredRun: 'newer' })], { ledgerPath });
    const read = readDebtLedger({ ledgerPath, events: [] });
    assert.equal(read.entries[0].deferredAt, '2026-04-01T00:00:00.000Z');
    assert.equal(read.entries[0].deferredRun, 'original');
  });

  test('unions contentAliases on update', async () => {
    await writeDebtEntries([makeEntry({ contentAliases: ['cafe', 'face'] })], { ledgerPath });
    await writeDebtEntries([makeEntry({ contentAliases: ['face', 'dead'] })], { ledgerPath });
    const read = readDebtLedger({ ledgerPath, events: [] });
    assert.deepEqual(read.entries[0].contentAliases.sort(), ['cafe', 'dead', 'face']);
  });

  test('rejects entries missing required per-reason fields', async () => {
    const r = await writeDebtEntries([
      makeEntry({ topicId: 'bb00', deferredReason: 'blocked-by' }),  // no blockedBy
    ], { ledgerPath });
    assert.equal(r.inserted, 0);
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /blockedBy/);
  });

  test('rejects entries with short deferredRationale', async () => {
    const r = await writeDebtEntries([
      makeEntry({ topicId: 'cc00', deferredRationale: 'nope' }),
    ], { ledgerPath });
    assert.equal(r.rejected.length, 1);
  });

  test('returns empty result for empty input', async () => {
    const r = await writeDebtEntries([], { ledgerPath });
    assert.deepEqual(r, { inserted: 0, updated: 0, total: 0, rejected: [] });
  });

  test('sorts entries by topicId for stable diffs', async () => {
    await writeDebtEntries([
      makeEntry({ topicId: 'cc00' }),
      makeEntry({ topicId: 'aa00' }),
      makeEntry({ topicId: 'bb00' }),
    ], { ledgerPath });
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.deepEqual(raw.entries.map(e => e.topicId), ['aa00', 'bb00', 'cc00']);
  });

  test('mixed valid + invalid: valid persist, invalid rejected', async () => {
    const r = await writeDebtEntries([
      makeEntry({ topicId: 'good' }),
      makeEntry({ topicId: 'bad1', deferredReason: 'blocked-by' }),  // invalid
    ], { ledgerPath });
    assert.equal(r.inserted, 1);
    assert.equal(r.rejected.length, 1);
  });
});

// ── removeDebtEntry ─────────────────────────────────────────────────────────

describe('removeDebtEntry', () => {
  test('returns false when ledger missing', async () => {
    const r = await removeDebtEntry('aa00', { ledgerPath });
    assert.equal(r, false);
  });

  test('removes matching topicId', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'aa00' }), makeEntry({ topicId: 'bb00' })], { ledgerPath });
    const r = await removeDebtEntry('aa00', { ledgerPath });
    assert.equal(r, true);
    const read = readDebtLedger({ ledgerPath, events: [] });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].topicId, 'bb00');
  });

  test('returns false when topicId absent', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'aa00' })], { ledgerPath });
    const r = await removeDebtEntry('zz99', { ledgerPath });
    assert.equal(r, false);
  });

  test('preserves compact (one-line-per-entry) serialization after removal', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'aa00' }), makeEntry({ topicId: 'bb00' })], { ledgerPath });
    await removeDebtEntry('aa00', { ledgerPath });
    const raw = fs.readFileSync(ledgerPath, 'utf-8');
    const entryLines = raw.split('\n').filter((l) => l.includes('"topicId"'));
    assert.equal(entryLines.length, 1, 'the remaining entry must still be one line, not re-expanded to multi-line');
  });

  test('preserves budgets after removal', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'aa00' }), makeEntry({ topicId: 'bb00' })], { ledgerPath });
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    fs.writeFileSync(ledgerPath, JSON.stringify({ ...raw, budgets: { 'src/**': 5 } }));
    await removeDebtEntry('aa00', { ledgerPath });
    const after = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.deepEqual(after.budgets, { 'src/**': 5 });
  });
});

// ── mergeLedgers ────────────────────────────────────────────────────────────

describe('mergeLedgers', () => {
  test('disjoint topicIds → both in output with source markers', () => {
    const session = { entries: [{ topicId: 'a', source: 'session' }] };
    const debt = { entries: [{ topicId: 'b', source: 'debt' }] };
    const m = mergeLedgers(session, debt);
    assert.equal(m.entries.length, 2);
    const bySource = Object.fromEntries(m.entries.map(e => [e.topicId, e.source]));
    assert.deepEqual(bySource, { a: 'session', b: 'debt' });
  });

  test('topicId collision → session wins (fix M1)', () => {
    const session = { entries: [{ topicId: 'a', source: 'session', marker: 'session-version' }] };
    const debt = { entries: [{ topicId: 'a', source: 'debt', marker: 'debt-version' }] };
    const m = mergeLedgers(session, debt);
    assert.equal(m.entries.length, 1);
    assert.equal(m.entries[0].source, 'session');
    assert.equal(m.entries[0].marker, 'session-version');
  });

  test('null/undefined inputs safe', () => {
    assert.equal(mergeLedgers(null, null).entries.length, 0);
    assert.equal(mergeLedgers(undefined, { entries: [{ topicId: 'a' }] }).entries.length, 1);
    assert.equal(mergeLedgers({ entries: [{ topicId: 'b' }] }, null).entries.length, 1);
  });

  test('stamps source field on every entry', () => {
    // Input entries without source field get labeled
    const m = mergeLedgers(
      { entries: [{ topicId: 'a' }] },
      { entries: [{ topicId: 'b' }] }
    );
    const sources = m.entries.map(e => e.source).sort();
    assert.deepEqual(sources, ['debt', 'session']);
  });
});

// ── findDebtByAlias ─────────────────────────────────────────────────────────

describe('findDebtByAlias', () => {
  const entries = [
    { topicId: 'aa11', contentAliases: ['bb22', 'cc33'] },
    { topicId: 'xx99', contentAliases: [] },
  ];

  test('matches by topicId directly', () => {
    assert.equal(findDebtByAlias('aa11', entries)?.topicId, 'aa11');
  });

  test('matches by alias', () => {
    assert.equal(findDebtByAlias('bb22', entries)?.topicId, 'aa11');
    assert.equal(findDebtByAlias('cc33', entries)?.topicId, 'aa11');
  });

  test('returns null when not found', () => {
    assert.equal(findDebtByAlias('zz99', entries), null);
  });

  test('returns null for empty/falsy hash', () => {
    assert.equal(findDebtByAlias('', entries), null);
    assert.equal(findDebtByAlias(null, entries), null);
  });

  test('handles entries without contentAliases field', () => {
    const noAliases = [{ topicId: 'aa11' }];
    assert.equal(findDebtByAlias('aa11', noAliases)?.topicId, 'aa11');
    assert.equal(findDebtByAlias('other', noAliases), null);
  });
});

// ── Concurrent write safety (locking) ──────────────────────────────────────

describe('writeDebtEntries — concurrent writes', () => {
  test('serial writes produce consistent state', async () => {
    // Fire 10 sequential writes to the same topicId — all should be updates after the first
    for (let i = 0; i < 10; i++) {
      await writeDebtEntries([makeEntry({ topicId: 'concurrent' })], { ledgerPath });
    }
    const read = readDebtLedger({ ledgerPath, events: [] });
    assert.equal(read.entries.length, 1);
  });

  test('parallel writes to different topicIds all land', async () => {
    // Seed the file first (lockfile requires it to exist)
    await writeDebtEntries([makeEntry({ topicId: 'seed' })], { ledgerPath });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => writeDebtEntries([makeEntry({ topicId: `t${i}` })], { ledgerPath }))
    );
    const read = readDebtLedger({ ledgerPath, events: [] });
    // seed + 5 new entries
    assert.equal(read.entries.length, 6);
    const ids = read.entries.map(e => e.topicId).sort();
    assert.deepEqual(ids, ['seed', 't0', 't1', 't2', 't3', 't4']);
  });
});

// ── markSuperseded (§2 Fix D) ────────────────────────────────────────────────

describe('markSuperseded', () => {
  test('links the old entry to the new one when both exist', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'old1' }), makeEntry({ topicId: 'new1' })], { ledgerPath });
    const r = await markSuperseded('old1', 'new1', { ledgerPath });
    assert.equal(r.ok, true, r.error);
    const read = readDebtLedger({ ledgerPath, events: [] });
    assert.equal(read.entries.find(e => e.topicId === 'old1').supersededBy, 'new1');
  });

  test('refuses when the old topicId does not exist', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'new1' })], { ledgerPath });
    const r = await markSuperseded('missing', 'new1', { ledgerPath });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'old-topic-not-found');
  });

  test('refuses when the new topicId does not exist', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'old1' })], { ledgerPath });
    const r = await markSuperseded('old1', 'missing', { ledgerPath });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'new-topic-not-found');
  });

  test('refuses self-reference', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'old1' })], { ledgerPath });
    const r = await markSuperseded('old1', 'old1', { ledgerPath });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'self-reference');
  });

  test('refuses when the ledger does not exist yet', async () => {
    const r = await markSuperseded('old1', 'new1', { ledgerPath });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ledger-not-found');
  });

  test('preserves compact (one-line-per-entry) serialization after superseding', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'old1' }), makeEntry({ topicId: 'new1' })], { ledgerPath });
    await markSuperseded('old1', 'new1', { ledgerPath });
    const raw = fs.readFileSync(ledgerPath, 'utf-8');
    const entryLines = raw.split('\n').filter((l) => l.includes('"topicId"'));
    assert.equal(entryLines.length, 2, 'both entries must still be one line each, not re-expanded to multi-line');
  });

  test('normalizes a historical entry with no classification field before writing it back (Gemini gate round-2 G4)', async () => {
    // A "historical" entry has neither classification nor
    // classificationUnavailableReason — writeDebtEntries would normally
    // backfill this at write time, so construct the raw JSON directly to
    // simulate a genuinely old, un-normalized row already on disk.
    const oldRaw = makeEntry({ topicId: 'old1' });
    delete oldRaw.classificationUnavailableReason;
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: [oldRaw, makeEntry({ topicId: 'new1' })] }, null, 2));
    const r = await markSuperseded('old1', 'new1', { ledgerPath });
    assert.equal(r.ok, true, r.error);
    const read = readDebtLedger({ ledgerPath, events: [] });
    const updated = read.entries.find(e => e.topicId === 'old1');
    assert.equal(updated.supersededBy, 'new1');
    assert.equal(updated.classificationUnavailableReason, 'not-provided-by-capture-source');
  });
});

// ── serializeLedgerForDisk ───────────────────────────────────────────────────
// docs/plans/debt-ledger-merge-safety.md — final-gate G1: these were promised
// in the plan's §5/§6 but not written when the writers were first wired up.

describe('serializeLedgerForDisk', () => {
  test('renders one compact (single-line) JSON object per entry', () => {
    const out = serializeLedgerForDisk({ version: 1, entries: [makeEntry({ topicId: 'a' }), makeEntry({ topicId: 'b' })] });
    const lines = out.split('\n').filter((l) => l.includes('"topicId"'));
    assert.equal(lines.length, 2, 'each entry must be exactly one line');
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line.trim().replace(/,$/, '')));
  });

  test('round-trips: JSON.parse(serializeLedgerForDisk(ledger)) deep-equals the input', () => {
    const ledger = { version: 1, entries: [makeEntry({ topicId: 'a' }), makeEntry({ topicId: 'b' })], lastUpdated: '2026-01-01T00:00:00.000Z' };
    assert.deepEqual(JSON.parse(serializeLedgerForDisk(ledger)), ledger);
  });

  test('preserves an arbitrary top-level field (e.g. budgets) in its original position', () => {
    const ledger = { version: 1, budgets: { 'src/**': 5 }, entries: [makeEntry({ topicId: 'a' })] };
    const parsed = JSON.parse(serializeLedgerForDisk(ledger));
    assert.deepEqual(parsed.budgets, { 'src/**': 5 });
  });

  test('empty entries array renders as `[]`, not a malformed/empty-line array', () => {
    const parsed = JSON.parse(serializeLedgerForDisk({ version: 1, entries: [] }));
    assert.deepEqual(parsed.entries, []);
  });

  test('NEGATIVE CONTROL (round-1 audit H2): preserves BOTH copies of a pre-existing duplicate topicId unchanged — never deduplicates', () => {
    const dup1 = makeEntry({ topicId: 'dup', severity: 'MEDIUM' });
    const dup2 = makeEntry({ topicId: 'dup', severity: 'HIGH' }); // e.g. one resolved-looking copy
    const parsed = JSON.parse(serializeLedgerForDisk({ version: 1, entries: [dup1, dup2] }));
    assert.equal(parsed.entries.length, 2, 'the serializer must never collapse duplicates by topicId');
    assert.equal(findDuplicateTopicIds(parsed.entries).length, 1);
    assert.equal(parsed.entries[0].severity, 'MEDIUM');
    assert.equal(parsed.entries[1].severity, 'HIGH');
  });
});

// ── isLedgerTracked ──────────────────────────────────────────────────────────
// Safe to test in-process (unlike warnIfLedgerTracked below): a pure function,
// no module-level warn-once state to leak across cases. warnIfLedgerTracked's
// own tests live in tests/debt-ledger-durability.test.mjs, which already runs
// each case in a fresh child process for exactly that reason.

describe('isLedgerTracked', () => {
  let repoDir;
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-ledger-tracked-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  test('returns tracked:true for a committed file', () => {
    gitInit(repoDir);
    commit(repoDir, 'tech-debt.json', '{"version":1,"entries":[]}', 'add ledger');
    const r = isLedgerTracked(path.join(repoDir, 'tech-debt.json'), repoDir);
    assert.deepEqual(r, { tracked: true, degraded: false });
  });

  test('returns tracked:false, degraded:false for an untracked file in a real repo', () => {
    gitInit(repoDir);
    commit(repoDir, 'other.txt', 'x', 'unrelated commit'); // repo must have a HEAD for ls-files to behave normally
    fs.writeFileSync(path.join(repoDir, 'tech-debt.json'), '{"version":1,"entries":[]}');
    const r = isLedgerTracked(path.join(repoDir, 'tech-debt.json'), repoDir);
    assert.deepEqual(r, { tracked: false, degraded: false });
  });

  test('returns degraded:true for a path outside repoRoot (git ownership is not the right question there)', () => {
    gitInit(repoDir);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-ledger-outside-'));
    const r = isLedgerTracked(path.join(outside, 'tech-debt.json'), repoDir);
    assert.equal(r.degraded, true);
    try { fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  test('returns degraded:true when git cannot be consulted (not a work tree)', () => {
    // repoDir was mkdtemp'd but never `git init`'d.
    const r = isLedgerTracked(path.join(repoDir, 'tech-debt.json'), repoDir);
    assert.equal(r.degraded, true);
  });
});
