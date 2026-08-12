/**
 * The durable-write registry (plan `docs/plans/audit-store-write-durability.md`,
 * Phase 1).
 *
 * The assertions that carry weight here are the ones separating states that
 * used to be one state:
 *
 *  - `written` / `spilled` / `lost` are three OUTCOMES, not "worked" and "did
 *    not". The defect being replaced had exactly one (a stderr line).
 *  - RETENTION is not REPLAY ELIGIBILITY. Every writer gets an envelope; only a
 *    writer declaring a `rowKey` gets its envelope into the replay queue. A
 *    keyless failure lands in `lost/` — kept, never replayed. At-least-once on a
 *    non-idempotent writer would corrupt the rows this is protecting.
 *  - Silence is not success. A `replay` resolving `undefined` — which is what an
 *    early cloud-off `return` produces — must NOT delete the envelope.
 *  - An empty registry is a BOOTSTRAP FAILURE, not an empty queue.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  registerWriter, durableWrite, drainSpill, spillSummary,
  registeredWriters, _resetRegistry, SPILL_DIR, LOST_SUBDIR,
} from '../scripts/lib/durable-write.mjs';

const mkTmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmTmp = (d) => {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
};
const spill = (root) => path.join(root, SPILL_DIR);
const lost = (root) => path.join(spill(root), LOST_SUBDIR);
const queued = (root) => {
  try { return fs.readdirSync(spill(root)).filter((f) => f.endsWith('.json')); } catch { return []; }
};

beforeEach(() => _resetRegistry());

// ── Registration ────────────────────────────────────────────────────────────

test('registration refuses a writer nothing could replay', () => {
  assert.throws(() => registerWriter('', { schemaVersion: 1, replay: async () => ({}) }), /non-empty string/);
  assert.throws(() => registerWriter('w', { schemaVersion: 1 }), /replay must be a function/);
  assert.throws(() => registerWriter('w', { replay: async () => ({}) }), /schemaVersion/);
  assert.throws(() => registerWriter('w', { schemaVersion: 1, replay: async () => ({}), rowKey: 'nope' }), /rowKey/);
});

test('an unregistered writer is a LOUD error, not a silent drop', async () => {
  // The whole point of the module is that a write nobody can replay never
  // happens quietly.
  await assert.rejects(() => durableWrite('nope', {}), /no writer registered/);
});

// ── The three outcomes ──────────────────────────────────────────────────────

test('a successful write is `written` and leaves no envelope behind', async () => {
  const root = mkTmp('ces-dw-ok-');
  try {
    registerWriter('w', { schemaVersion: 1, rowKey: (r) => r.id, replay: async () => ({ applied: true }) });
    const res = await durableWrite('w', { id: 1 }, { repoRoot: root });
    assert.equal(res.outcome, 'written');
    assert.deepEqual(queued(root), []);
  } finally { rmTmp(root); }
});

test('a KEYED writer that fails is `spilled` — the envelope stays in the replay queue', async () => {
  const root = mkTmp('ces-dw-spill-');
  try {
    registerWriter('w', { schemaVersion: 1, rowKey: (r) => r.id, replay: async () => { throw new Error('db down'); } });
    const res = await durableWrite('w', { id: 1 }, { repoRoot: root });
    assert.equal(res.outcome, 'spilled');
    assert.equal(queued(root).length, 1, 'a replayable failure stays queued');
  } finally { rmTmp(root); }
});

test('a KEYLESS writer that fails is `lost` — kept as evidence, never queued', async () => {
  // The retention/eligibility split. Both halves are asserted, because "not
  // replayed" and "not kept" are different claims and conflating them is the
  // contradiction the plan's gate caught.
  const root = mkTmp('ces-dw-lost-');
  try {
    registerWriter('w', { schemaVersion: 1, replay: async () => { throw new Error('db down'); } });
    const res = await durableWrite('w', { id: 1 }, { repoRoot: root });
    assert.equal(res.outcome, 'lost');
    assert.deepEqual(queued(root), [], 'never enters the replay queue');
    assert.equal(fs.readdirSync(lost(root)).length, 1, 'but IS kept as evidence');
  } finally { rmTmp(root); }
});

test('silence is not success — a replay resolving undefined does not delete', async () => {
  // What an early `if (!await isCloudEnabled()) return;` produces. Reading it
  // as applied would delete undelivered data.
  const root = mkTmp('ces-dw-silent-');
  try {
    registerWriter('w', { schemaVersion: 1, rowKey: (r) => r.id, replay: async () => undefined });
    const res = await durableWrite('w', { id: 1 }, { repoRoot: root });
    assert.equal(res.outcome, 'spilled');
    assert.equal(queued(root).length, 1);
  } finally { rmTmp(root); }
});

test('a truthy non-receipt is not applied either', async () => {
  const root = mkTmp('ces-dw-truthy-');
  try {
    registerWriter('w', { schemaVersion: 1, rowKey: (r) => r.id, replay: async () => ({ ok: true }) });
    const res = await durableWrite('w', { id: 1 }, { repoRoot: root });
    assert.equal(res.outcome, 'spilled', 'only {applied:true} is a receipt');
  } finally { rmTmp(root); }
});

test('write-ahead: the envelope exists BEFORE the attempt resolves', async () => {
  // Spill-on-failure loses the payload if the process dies during the await.
  // This asserts the ordering that closes that window.
  const root = mkTmp('ces-dw-wal-');
  try {
    let duringAttempt = null;
    registerWriter('w', {
      schemaVersion: 1, rowKey: (r) => r.id,
      replay: async () => { duringAttempt = queued(root).length; return { applied: true }; },
    });
    await durableWrite('w', { id: 1 }, { repoRoot: root });
    assert.equal(duringAttempt, 1, 'the envelope must be on disk while the write is in flight');
  } finally { rmTmp(root); }
});

// ── Drain ───────────────────────────────────────────────────────────────────

test('an EMPTY REGISTRY is a bootstrap failure, not an empty queue', async () => {
  // A fresh process (the operator CLI) that forgot to import the writers module
  // would otherwise quarantine every artifact as an unknown writerId.
  const root = mkTmp('ces-dw-noreg-');
  try {
    const res = await drainSpill({ repoRoot: root });
    assert.equal(res.state, 'unavailable');
    assert.match(res.reason, /no writers registered/);
  } finally { rmTmp(root); }
});

test('drain refuses to run with the store off, rather than churning', async () => {
  const root = mkTmp('ces-dw-cloudoff-');
  try {
    registerWriter('w', { schemaVersion: 1, rowKey: (r) => r.id, replay: async () => ({ applied: true }) });
    await durableWrite('w', { id: 1 }, { repoRoot: root }).catch(() => {});
    const before = queued(root).length;
    const res = await drainSpill({ repoRoot: root, isCloudEnabled: () => false });
    assert.equal(res.state, 'unavailable');
    assert.equal(queued(root).length, before, 'the queue is untouched');
  } finally { rmTmp(root); }
});

test('drain replays a spilled artifact and clears it', async () => {
  const root = mkTmp('ces-dw-replay-');
  try {
    let attempts = 0;
    registerWriter('w', {
      schemaVersion: 1, rowKey: (r) => r.id,
      replay: async () => (++attempts === 1 ? (() => { throw new Error('down'); })() : { applied: true }),
    });
    assert.equal((await durableWrite('w', { id: 1 }, { repoRoot: root })).outcome, 'spilled');

    const res = await drainSpill({ repoRoot: root, isCloudEnabled: () => true });
    assert.equal(res.state, 'drained');
    assert.equal(res.drained, 1);
    assert.deepEqual(queued(root), []);
  } finally { rmTmp(root); }
});

test('drain quarantines an artifact whose schemaVersion this build does not speak', async () => {
  const root = mkTmp('ces-dw-ver-');
  try {
    registerWriter('w', { schemaVersion: 2, rowKey: (r) => r.id, replay: async () => ({ applied: true }) });
    fs.mkdirSync(spill(root), { recursive: true });
    fs.writeFileSync(path.join(spill(root), 'w-old.json'), `${JSON.stringify({
      v: 1, fingerprint: 'w-old', writerId: 'w', schemaVersion: 1, payload: { id: 1 },
    })}\n`);
    const res = await drainSpill({ repoRoot: root, isCloudEnabled: () => true });
    assert.equal(res.rejected, 1, 'a schema this build cannot read is quarantined, never guessed at');
  } finally { rmTmp(root); }
});

test('drain refuses a git-TRACKED artifact — provenance, not just shape', async () => {
  // .gitignore does not stop `git add -f`, so a valid-shaped artifact can be
  // committed into the repo. A real spill artifact is written at runtime into a
  // gitignored dir and is never tracked.
  const root = mkTmp('ces-dw-tracked-');
  try {
    let replayed = 0;
    // ONE registration, and its replay SUCCEEDS — otherwise the counter can
    // never move and the test passes whether or not the check exists. That was
    // the first version of this test, and the mutation harness caught it: it
    // re-registered the writer with a throwing replay, so `replayed` stayed
    // false either way. A test that cannot distinguish the two states is not a
    // test of them.
    registerWriter('w', {
      schemaVersion: 1, rowKey: (r) => r.id,
      replay: async () => { replayed++; return { applied: true }; },
    });
    // Seed the queue directly so the artifact is present without depending on a
    // failing write to put it there.
    fs.mkdirSync(spill(root), { recursive: true });
    fs.writeFileSync(path.join(spill(root), 'w-seed.json'), `${JSON.stringify({
      v: 1, fingerprint: 'w-seed', writerId: 'w', schemaVersion: 1, payload: { id: 1 },
    })}\n`);

    const refused = await drainSpill({ repoRoot: root, isCloudEnabled: () => true, isTracked: () => true });
    assert.equal(replayed, 0, 'a tracked artifact must never reach replay');
    assert.equal(refused.drained, 0);

    // Positive control: the SAME artifact drains once it is not tracked. Without
    // this, "0 drained" could equally mean the drain never ran.
    const allowed = await drainSpill({ repoRoot: root, isCloudEnabled: () => true, isTracked: () => false });
    assert.equal(replayed, 1, 'and an untracked one does reach replay');
    assert.equal(allowed.drained, 1);
  } finally { rmTmp(root); }
});

// ── Summary ─────────────────────────────────────────────────────────────────

test('spillSummary distinguishes empty from unreadable', () => {
  const root = mkTmp('ces-dw-sum-');
  try {
    assert.deepEqual(spillSummary({ repoRoot: root }),
      { state: 'ok', spilled: 0, lost: 0, oldestAgeMs: null });

    // A regular file where the spill directory belongs → readdir fails.
    fs.mkdirSync(path.join(root, '.audit'), { recursive: true });
    fs.writeFileSync(spill(root), 'not a directory');
    const broken = spillSummary({ repoRoot: root });
    assert.equal(broken.state, 'unavailable', 'unreadable must not report as an empty queue');
  } finally { rmTmp(root); }
});

test('spillSummary counts the queue and the evidence drawer separately', async () => {
  const root = mkTmp('ces-dw-sum2-');
  try {
    registerWriter('keyed', { schemaVersion: 1, rowKey: (r) => r.id, replay: async () => { throw new Error('x'); } });
    registerWriter('keyless', { schemaVersion: 1, replay: async () => { throw new Error('x'); } });
    await durableWrite('keyed', { id: 1 }, { repoRoot: root });
    await durableWrite('keyless', { id: 2 }, { repoRoot: root });

    const s = spillSummary({ repoRoot: root });
    assert.equal(s.spilled, 1, 'only the replayable one is in the queue');
    assert.equal(s.lost, 1, 'the other is evidence');
    assert.ok(s.oldestAgeMs !== null && s.oldestAgeMs >= 0);
  } finally { rmTmp(root); }
});

test('registeredWriters reports the ids the call-site oracle checks', () => {
  registerWriter('a', { schemaVersion: 1, replay: async () => ({ applied: true }) });
  registerWriter('b', { schemaVersion: 1, replay: async () => ({ applied: true }) });
  assert.deepEqual(registeredWriters().sort(), ['a', 'b']);
});
