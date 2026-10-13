/**
 * @fileoverview Gate 2B verifies `.sync-receipt.json` STRUCTURALLY, never by a
 * pinned hash alone (upstream report fc843d6b-4f1a-49f5-ad11-4b9db5725086).
 *
 * ## The defect
 *
 * The receipt is an append-only, newest-first, bounded ledger: two concurrent
 * sync PRs both prepend to it, and the correct conflict resolution is a UNION
 * merge of both sides' `recentSyncs` — bytes no single sync ever wrote. Gate 2B
 * hash-pinned the file against the manifest, so every legitimate merge failed
 * it. Measured in wine-cellar-app: sync-pr wrote `a91db4db` (commit 5e7a8c2a4),
 * #893's union merge is `5cc59832`, and 2B failed on exactly that entry while
 * every other gate passed.
 *
 * The fixtures here build receipts with the sync's OWN writer
 * (`buildReceiptEntry` / `appendReceiptEntry`), so a merge is modelled from the
 * shape the sync actually emits rather than a hand-typed guess at it.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { _internals } from '../scripts/lib/sync-isolation-verify.mjs';
import {
  RECEIPT_PATH, RECEIPT_VERSION, RECEIPT_HISTORY_LIMIT,
  buildReceiptEntry, appendReceiptEntry, verifyReceiptStructure,
} from '../scripts/lib/sync-receipt.mjs';
import { writeFile } from './helpers/fixtures.mjs';

const { gate2B, formatText } = _internals;

let root;
const sha = (s) => `sha256:${crypto.createHash('sha256').update(Buffer.from(s)).digest('hex')}`;
const commit = (c) => c.repeat(40).slice(0, 40);

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-receipt-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const entry = (c, syncedAt) => buildReceiptEntry({
  syncedAt,
  source: { repo: 'Lbstrydom/claude-engineering-skills', branch: 'main', commitSha: commit(c), sourceDirty: false },
  updated: [`scripts/.claude-skills/lib/${c}.mjs`],
});

/** Prepend entries oldest→newest through the real writer. */
function ledger(entries) {
  let file = null;
  for (const e of entries) {
    const prior = file ? { entries: file.recentSyncs, dropped: file.olderSyncsDropped } : null;
    file = appendReceiptEntry(prior, e);
  }
  return file;
}

const body = (obj) => JSON.stringify(obj, null, 2) + '\n';

/**
 * A union merge of two sync branches that share history: both sides' entries,
 * newest first, the shared ancestor entries once, capped, drops counted.
 */
function unionMerge(a, b) {
  const seen = new Set();
  const all = [...a.recentSyncs, ...b.recentSyncs]
    .sort((x, y) => Date.parse(y.syncedAt) - Date.parse(x.syncedAt))
    .filter((e) => {
      const k = `${e.syncedAt}\0${e.source.commitSha}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const kept = all.slice(0, RECEIPT_HISTORY_LIMIT);
  return { ...a, olderSyncsDropped: Math.max(a.olderSyncsDropped, b.olderSyncsDropped) + (all.length - kept.length), recentSyncs: kept };
}

/**
 * Consumer fixture: this checkout's tooling came from the sync of `thisCommit`,
 * whose OWN bytes are what the manifest pinned; the disk holds `onDisk`.
 */
function consumer({ written, onDisk, thisCommit, commitSha = commit(thisCommit) }) {
  writeFile(root, RECEIPT_PATH, typeof onDisk === 'string' ? onDisk : body(onDisk));
  return { commitSha, files: { [RECEIPT_PATH]: sha(body(written)) } };
}

// Shared base: two syncs both branches already had.
const base = [entry('1', '2026-10-01T10:00:00.000Z'), entry('2', '2026-10-02T10:00:00.000Z')];
const sideA = ledger([...base, entry('a', '2026-10-03T10:00:00.000Z')]);              // other PR
const sideB = ledger([...base, entry('b', '2026-10-04T10:00:00.000Z')]);              // THIS checkout's sync
const merged = unionMerge(sideB, sideA);

describe('gate 2B — receipt merged from two syncs', () => {
  it('PASSES a correct union merge whose entry 0 is this sync, and says what it excused', () => {
    const manifest = consumer({ written: sideB, onDisk: merged, thisCommit: 'b' });
    assert.notEqual(sha(body(merged)), manifest.files[RECEIPT_PATH], 'fixture must not hash-match');
    const res = gate2B(root, manifest);
    assert.equal(res.pass, true, JSON.stringify(res.details));
    assert.equal(res.details.receipt.verified, 'structural');
    assert.equal(res.details.receipt.entries, 4);
    assert.equal(res.details.receipt.entry0, commit('b').slice(0, 8));
    // The default TEXT output is what an operator reads: a bare check mark
    // would hide that a divergent file was accepted on structure.
    assert.match(formatText([res]).text, /receipt\s+\.sync-receipt\.json .*verified structurally — 4 entries/);
  });

  it('FAILS when entry 0 is not this sync — and names both shas', () => {
    // sideA's sync is newer than this checkout's: the on-disk tooling is older
    // than the newest recorded sync.
    const newerA = ledger([...base, entry('a', '2026-10-05T10:00:00.000Z')]);
    const m = unionMerge(sideB, newerA);
    const res = gate2B(root, consumer({ written: sideB, onDisk: m, thisCommit: 'b' }));
    assert.equal(res.pass, false);
    const [mm] = res.details.mismatched;
    assert.equal(mm.path, RECEIPT_PATH);
    assert.ok(mm.problems.some((p) => p.includes(commit('a')) && p.includes(commit('b'))), mm.problems.join(' | '));
  });

  it('an untouched receipt still passes on the hash fast path, with no structural excusal', () => {
    const res = gate2B(root, consumer({ written: sideB, onDisk: sideB, thisCommit: 'b' }));
    assert.equal(res.pass, true);
    assert.equal(res.details?.receipt, undefined);
  });
});

describe('gate 2B — the relaxation is scoped (directions that must still fire)', () => {
  const fails = (onDisk, label) => {
    const res = gate2B(root, consumer({ written: sideB, onDisk, thisCommit: 'b' }));
    assert.equal(res.pass, false, `${label} should fail`);
    return res.details.mismatched[0].problems;
  };

  it('a duplicated ancestor entry fails', () => {
    const dup = { ...merged, recentSyncs: [...merged.recentSyncs, merged.recentSyncs[3]] };
    assert.ok(fails(dup, 'dup').some((p) => /duplicate/i.test(p)));
  });

  it('out-of-order entries fail', () => {
    const [e0, e1, e2, e3] = merged.recentSyncs;
    assert.ok(fails({ ...merged, recentSyncs: [e0, e2, e1, e3] }, 'order').some((p) => /newest-first/i.test(p)));
  });

  it('an over-cap list fails', () => {
    const many = Array.from({ length: RECEIPT_HISTORY_LIMIT + 1 }, (_, i) =>
      entry(i === 0 ? 'b' : String.fromCharCode(99 + i), new Date(Date.UTC(2026, 9, 30) - i * 3_600_000).toISOString()));
    assert.ok(fails({ ...merged, recentSyncs: many }, 'cap').some((p) => /limit/i.test(p)));
  });

  it('unparseable JSON fails as a finding, not a throw', () => {
    assert.ok(fails('{ "version": 2, ', 'json').some((p) => /JSON/.test(p)));
  });

  it('a future version is reported as unjudgeable, not as corrupt', () => {
    const problems = fails({ ...merged, version: RECEIPT_VERSION + 1 }, 'future');
    assert.ok(problems.some((p) => /newer/i.test(p)), problems.join(' | '));
  });

  it('manifest.commitSha null keeps the hash verdict — entry 0 cannot be attested', () => {
    const res = gate2B(root, consumer({ written: sideB, onDisk: merged, thisCommit: 'b', commitSha: null }));
    assert.equal(res.pass, false);
    assert.equal(res.details.mismatched[0].problems, undefined);
  });

  it('a non-receipt path with a hash mismatch still fails', () => {
    writeFile(root, '.claude/skills/plan/SKILL.md', 'changed\n');
    const manifest = consumer({ written: sideB, onDisk: merged, thisCommit: 'b' });
    manifest.files['.claude/skills/plan/SKILL.md'] = sha('original\n');
    const res = gate2B(root, manifest);
    assert.equal(res.pass, false);
    assert.deepEqual(res.details.mismatched.map((m) => m.path), ['.claude/skills/plan/SKILL.md']);
  });

  it('a structurally invalid receipt DECLARED as an override is held (the override decision is preserved)', () => {
    writeFile(root, '.sync-overrides.json', JSON.stringify({
      version: 1, overrides: [{ path: RECEIPT_PATH, reason: 'hand-curated receipt' }], gitignoreExtra: [],
    }));
    const [e0, e1, e2, e3] = merged.recentSyncs;
    const res = gate2B(root, consumer({ written: sideB, onDisk: { ...merged, recentSyncs: [e0, e2, e1, e3] }, thisCommit: 'b' }));
    assert.equal(res.pass, true);
    assert.deepEqual(res.details.held.map((h) => h.path), [RECEIPT_PATH]);
  });
});

describe('verifyReceiptStructure — pure', () => {
  it('lists every violated rule, not just the first', () => {
    const bad = { version: RECEIPT_VERSION, olderSyncsDropped: -1, recentSyncs: [merged.recentSyncs[1], merged.recentSyncs[0], { nope: 1 }] };
    const v = verifyReceiptStructure(bad, commit('b'));
    assert.equal(v.ok, false);
    // One assertion per violated rule, so dropping any single check fails here
    // rather than being masked by the others still firing.
    const has = (re) => assert.ok(v.problems.some((p) => re.test(p)), `${re} not in: ${v.problems.join(' | ')}`);
    has(/^olderSyncsDropped is -1/);
    has(/recentSyncs\[1\] .* not newest-first/);
    has(/recentSyncs\[2\] is not a well-formed entry/);
    has(/recentSyncs\[0\] is the sync of /);
    assert.equal(v.problems.length, 4, v.problems.join(' | '));
  });

  it('a negative olderSyncsDropped fails on its own', () => {
    const one = ledger([entry('b', '2026-10-04T10:00:00.000Z')]);
    const v = verifyReceiptStructure({ ...one, olderSyncsDropped: -1 }, commit('b'));
    assert.deepEqual(v.problems, ['olderSyncsDropped is -1, expected a non-negative integer']);
  });

  it('accepts a single-entry receipt from this sync', () => {
    assert.deepEqual(verifyReceiptStructure(ledger([entry('b', '2026-10-04T10:00:00.000Z')]), commit('b')),
      { ok: true, problems: [], entries: 1 });
  });

  it('rejects an empty list and a non-object', () => {
    assert.equal(verifyReceiptStructure({ version: RECEIPT_VERSION, olderSyncsDropped: 0, recentSyncs: [] }, commit('b')).ok, false);
    assert.equal(verifyReceiptStructure([], commit('b')).ok, false);
    assert.equal(verifyReceiptStructure(null, commit('b')).ok, false);
  });
});
