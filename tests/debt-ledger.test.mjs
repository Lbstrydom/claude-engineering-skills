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
  readLedgerState,
  debtLedgerExists,
} from '../scripts/lib/debt-ledger.mjs';
import {
  fileKey, decodeFileKey, topicIdFilenameProblem, serializeEntryForDisk, MAX_ENTRY_BASENAME_BYTES,
  resolveLedgerLocation, withLedgerLock,
} from '../scripts/lib/debt-ledger-files.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { findDuplicateTopicIds } from '../scripts/lib/debt-review-helpers.mjs';
import { gitInit, commit, gitFixtureEnv } from './helpers/fixtures.mjs';

const LEDGER_URL = pathToFileURL(path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'debt-ledger.mjs')).href;

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
      conflicts: [], pendingReconcile: null, storage: null,
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
    // Per-entry storage: one file per topicId, and reads come back sorted.
    assert.deepEqual(fs.readdirSync(path.join(tmpDir, 'tech-debt', 'entries')).sort(), ['aa00.json', 'bb00.json', 'cc00.json']);
    assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).entries.map(e => e.topicId), ['aa00', 'bb00', 'cc00']);
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

  test("removes exactly that entry's file and leaves the others byte-identical", async () => {
    await writeDebtEntries([makeEntry({ topicId: 'aa00' }), makeEntry({ topicId: 'bb00' })], { ledgerPath });
    const bbFile = path.join(tmpDir, 'tech-debt', 'entries', 'bb00.json');
    const before = fs.readFileSync(bbFile, 'utf-8');
    assert.equal(await removeDebtEntry('aa00', { ledgerPath }), true);
    assert.deepEqual(fs.readdirSync(path.join(tmpDir, 'tech-debt', 'entries')), ['bb00.json']);
    assert.equal(fs.readFileSync(bbFile, 'utf-8'), before);
  });

  test('preserves budgets through the automatic migration and a removal', async () => {
    // An untracked legacy ledger carrying budgets is migrated on the first
    // write; the policy must survive both the move and the removal.
    fs.writeFileSync(ledgerPath, JSON.stringify({
      version: 1, budgets: { 'src/**': 5 }, entries: [makeEntry({ topicId: 'aa00' }), makeEntry({ topicId: 'bb00' })],
    }));
    assert.equal(await removeDebtEntry('aa00', { ledgerPath }), true);
    assert.equal(fs.existsSync(ledgerPath), false, 'the untracked legacy file was migrated away');
    assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).budgets, { 'src/**': 5 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmpDir, 'tech-debt', 'budgets.json'), 'utf-8')), { 'src/**': 5 });
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

  test("rewrites only the superseded entry's file", async () => {
    await writeDebtEntries([makeEntry({ topicId: 'old1' }), makeEntry({ topicId: 'new1' })], { ledgerPath });
    const newFile = path.join(tmpDir, 'tech-debt', 'entries', 'new1.json');
    const before = fs.readFileSync(newFile, 'utf-8');
    assert.equal((await markSuperseded('old1', 'new1', { ledgerPath })).ok, true);
    assert.equal(fs.readFileSync(newFile, 'utf-8'), before);
    const old = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tech-debt', 'entries', 'old1.json'), 'utf-8'));
    assert.equal(old.supersededBy, 'new1');
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

// ── Per-entry storage (docs/plans/debt-ledger-per-entry-files.md) ───────────

describe('per-entry storage — topicId ⇄ filename', () => {
  test('fileKey is lowercase and injective; decodeFileKey inverts it exactly', () => {
    for (const id of ['aa00', 'Abc1', 'ABC1', 'aud-2026-05-03-h11', 'x.Y_z-9']) {
      const key = fileKey(id);
      assert.equal(key, key.toLowerCase(), `${id} encodes to a lowercase name`);
      assert.equal(decodeFileKey(key), id);
    }
    assert.notEqual(fileKey('Abc1').toLowerCase(), fileKey('abc1').toLowerCase(), 'case variants never fold together');
    assert.equal(decodeFileKey('Abc1'), null, 'an uppercase filename was not written by fileKey');
    assert.equal(decodeFileKey('a~1'), null, 'a dangling escape was not written by fileKey');
  });

  test('unsafe topicIds are refused, never sanitised', () => {
    for (const id of ['../x', 'a/b', 'a\\b', '', '.hidden', 'trailing.', 'nul', 'con.txt', 'com1', 'x~y', 'a'.repeat(129)]) {
      assert.ok(topicIdFilenameProblem(id), `${JSON.stringify(id)} must be refused`);
    }
    // Reserved-name checks apply to the ENCODED name: 'NUL' is written as '~n~u~l.json', a legal name.
    assert.equal(topicIdFilenameProblem('NUL'), null);
    assert.equal(topicIdFilenameProblem('a'.repeat(128)), null, 'the 128-char raw cap encodes to 133 bytes and passes');
    assert.equal(topicIdFilenameProblem('A'.repeat(67)), null, '67 uppercase letters encode to 134+5=139 bytes');
    assert.match(topicIdFilenameProblem('A'.repeat(68)), /exceeds 140 bytes/, '68 encode to 141');
    assert.equal(MAX_ENTRY_BASENAME_BYTES, 140);
  });

  test('a writer rejects an unsafe topicId instead of writing outside the ledger', async () => {
    const r = await writeDebtEntries([makeEntry({ topicId: '../escape' }), makeEntry({ topicId: 'ok01' })], { ledgerPath });
    assert.equal(r.inserted, 1);
    assert.match(r.rejected[0].reason, /topicId-not-a-safe-filename/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'escape.json')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'tech-debt', 'escape.json')), false);
  });
});

describe('per-entry storage — no lastUpdated, deterministic bytes', () => {
  test('nothing written carries lastUpdated, and key order does not change the bytes', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'aa00' })], { ledgerPath });
    const file = path.join(tmpDir, 'tech-debt', 'entries', 'aa00.json');
    const first = fs.readFileSync(file, 'utf-8');
    assert.equal(first.includes('lastUpdated'), false);
    const reordered = Object.fromEntries(Object.entries(makeEntry({ topicId: 'aa00' })).reverse());
    assert.equal(serializeEntryForDisk(reordered), serializeEntryForDisk(makeEntry({ topicId: 'aa00' })));
    await writeDebtEntries([reordered], { ledgerPath });
    assert.equal(fs.readFileSync(file, 'utf-8'), first, 'a re-recorded identical entry is byte-identical');
  });

  test('an untracked legacy ledger is migrated on the first write and its lastUpdated is gone', async () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, lastUpdated: '2026-01-01T00:00:00.000Z', entries: [makeEntry({ topicId: 'aa00' })] }));
    await writeDebtEntries([makeEntry({ topicId: 'bb00' })], { ledgerPath });
    assert.equal(fs.existsSync(ledgerPath), false);
    assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).entries.map((e) => e.topicId), ['aa00', 'bb00']);
  });

  test('an empty entries directory is an AVAILABLE, empty ledger — not an absent one', () => {
    fs.mkdirSync(path.join(tmpDir, 'tech-debt', 'entries'), { recursive: true });
    const r = readDebtLedger({ ledgerPath, events: [] });
    assert.equal(r.available, true);
    assert.deepEqual(r.entries, []);
    assert.equal(debtLedgerExists(ledgerPath), true);
  });
});

describe('per-entry storage — storage form chosen under the one lock', () => {
  test('a TRACKED legacy-only ledger stays legacy: no directory, entry in the file, one warning', () => {
    gitInit(tmpDir);
    commit(tmpDir, 'tech-debt.json', JSON.stringify({ version: 1, entries: [makeEntry({ topicId: 'aa00' })] }), 'tracked ledger');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { writeDebtEntries } from ${JSON.stringify(LEDGER_URL)};`
      + `const e = ${JSON.stringify(makeEntry({ topicId: 'bb00' }))};`
      + `await writeDebtEntries([e], { ledgerPath: ${JSON.stringify(ledgerPath)} });`
      + `await writeDebtEntries([{ ...e, topicId: 'cc00' }], { ledgerPath: ${JSON.stringify(ledgerPath)} });`,
    ], { encoding: 'utf-8', env: gitFixtureEnv() });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.existsSync(path.join(tmpDir, 'tech-debt')), false, 'a tracked ledger is never auto-migrated');
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.deepEqual(raw.entries.map((e) => e.topicId), ['aa00', 'bb00', 'cc00']);
    assert.equal('lastUpdated' in raw, false);
    assert.equal((child.stderr.match(/single-file debt ledger/g) || []).length, 1, 'warned once per process');
  });

  test('locking creates nothing: the lock is <legacyFile>.lock and no directory appears', async () => {
    const location = resolveLedgerLocation(ledgerPath);
    await withLedgerLock(location, () => {
      assert.ok(fs.existsSync(`${ledgerPath}.lock`), 'lock directory at the legacy name');
      assert.equal(fs.existsSync(ledgerPath), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'tech-debt')), false);
    });
  });

  test('a writer waits on the lock pre-upgrade tooling holds (same lock name)', async () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: [] }));
    // Pre-upgrade writers lock the legacy file with proper-lockfile's DEFAULT options.
    const release = await lockfile.lock(ledgerPath, { stale: 30_000 });
    try {
      await assert.rejects(
        writeDebtEntries([makeEntry({ topicId: 'aa00' })], { ledgerPath }),
        /Failed to acquire debt-ledger lock/,
      );
    } finally {
      await release();
    }
    assert.equal(fs.existsSync(path.join(tmpDir, 'tech-debt')), false, 'nothing written while it was held');
  });
});

describe('per-entry storage — reads fail closed and survive races', () => {
  test('a directory link in the ledger path is refused by reads and writes', async (t) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-ledger-link-target-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'tech-debt'), { recursive: true });
      try {
        // A junction needs no privilege on Windows; elsewhere a plain dir symlink.
        fs.symlinkSync(outside, path.join(tmpDir, 'tech-debt', 'entries'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        if (err.code === 'EPERM') { t.skip('directory links need a privilege this host lacks'); return; }
        throw err;
      }
      assert.throws(() => readDebtLedger({ ledgerPath, events: [] }), /symbolic link/);
      await assert.rejects(writeDebtEntries([makeEntry({ topicId: 'aa00' })], { ledgerPath }), /symbolic link/);
      assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside the ledger');
    } finally {
      try { fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
    }
  });

  test('a file whose name does not match its topicId, or that is not JSON, is loud corruption', () => {
    const entries = path.join(tmpDir, 'tech-debt', 'entries');
    fs.mkdirSync(entries, { recursive: true });
    fs.writeFileSync(path.join(entries, 'aa00.json'), JSON.stringify(makeEntry({ topicId: 'bb00' })));
    assert.throws(() => readDebtLedger({ ledgerPath, events: [] }), /does not hold the entry its name declares/);
    fs.writeFileSync(path.join(entries, 'aa00.json'), '<<<<<<< ours\n');
    assert.throws(() => readDebtLedger({ ledgerPath, events: [] }), /aa00\.json/);
  });

  test('atomic-write temp files (dotfiles) are not entries', () => {
    const entries = path.join(tmpDir, 'tech-debt', 'entries');
    fs.mkdirSync(entries, { recursive: true });
    fs.writeFileSync(path.join(entries, '.tmp-123-456'), 'partial');
    fs.writeFileSync(path.join(entries, 'aa00.json'), JSON.stringify(makeEntry({ topicId: 'aa00' })));
    assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).entries.map((e) => e.topicId), ['aa00']);
  });

  test('a file listed then gone restarts the read instead of failing it', async () => {
    await writeDebtEntries([makeEntry({ topicId: 'aa00' }), makeEntry({ topicId: 'bb00' })], { ledgerPath });
    let vanishOnce = true;
    const racingFs = {
      ...fs,
      readFileSync(p, ...rest) {
        if (vanishOnce && String(p).endsWith('aa00.json')) {
          vanishOnce = false;
          throw Object.assign(new Error('ENOENT: simulated concurrent removal'), { code: 'ENOENT' });
        }
        return fs.readFileSync(p, ...rest);
      },
    };
    const state = readLedgerState(resolveLedgerLocation(ledgerPath), { fs: racingFs });
    assert.equal(vanishOnce, false, 'the race was actually injected');
    assert.deepEqual(state.entries.map((e) => e.topicId), ['aa00', 'bb00']);
  });

  // What protects this case is the READ ORDER — legacy bytes first, directory
  // second (negative control 2026-10-13: reading the directory first returns a
  // ledger without A). The bytes re-check is pinned by the next test instead:
  // with the order right, this interleaving cannot lose A even without it.
  test('a migration that copies an entry and shrinks the legacy file mid-read never loses the entry', () => {
    // Untracked both-forms: the directory has R, the legacy file has A and R.
    fs.writeFileSync(ledgerPath, serializeLedgerForDisk({ version: 1, entries: [makeEntry({ topicId: 'aa00' }), makeEntry({ topicId: 'rr00' })] }));
    const entries = path.join(tmpDir, 'tech-debt', 'entries');
    fs.mkdirSync(entries, { recursive: true });
    fs.writeFileSync(path.join(entries, 'rr00.json'), serializeEntryForDisk(makeEntry({ topicId: 'rr00' })));
    let migrated = false;
    const state = readLedgerState(resolveLedgerLocation(ledgerPath), {
      onDirectoryRead: () => {
        if (migrated) return;
        migrated = true;
        // The migration interleaves here: A is copied into the directory AFTER
        // the reader listed it, then the legacy file shrinks to its remainder.
        fs.writeFileSync(path.join(entries, 'aa00.json'), serializeEntryForDisk(makeEntry({ topicId: 'aa00' })));
        fs.writeFileSync(ledgerPath, serializeLedgerForDisk({ version: 1, entries: [makeEntry({ topicId: 'rr00' })] }));
      },
    });
    assert.ok(migrated, 'the interleaving actually happened');
    assert.deepEqual(state.entries.map((e) => e.topicId), ['aa00', 'rr00'], 'never a ledger without A');
  });

  test('every attempt racing → unavailable (ledger-unreadable), never empty and never a throw', () => {
    fs.mkdirSync(path.join(tmpDir, 'tech-debt', 'entries'), { recursive: true });
    let n = 0;
    const churningFs = {
      ...fs,
      readFileSync(p, ...rest) {
        if (String(p) === ledgerPath) {
          n++;
          return Buffer.from(serializeLedgerForDisk({ version: 1, entries: [makeEntry({ topicId: `x${n}` })] }));
        }
        return fs.readFileSync(p, ...rest);
      },
    };
    assert.throws(
      () => readLedgerState(resolveLedgerLocation(ledgerPath), { fs: churningFs }),
      (err) => err.name === 'TransientLedgerReadError',
    );
    assert.equal(n, 10, 'five whole attempts, each bracketing the directory read');
  });
});
