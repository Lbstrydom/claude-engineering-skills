/**
 * @fileoverview DB-free tests for the nav-audit run-history store seam
 * (scripts/lib/store/nav-audit.mjs) — WS2 of
 * docs/completed/persona-nav-feedback-recovery.md. Per this repo's testing
 * doctrine, the actual INSERT/SELECT round trip is DB-side and covered by
 * the empirical verify doctrine, not asserted here against a mock. What IS
 * asserted, DB-free: schema validation catches malformed input before any
 * query is built, and the cloud-off path degrades gracefully without
 * attempting a connection (this dev machine has a real AUDIT_DB_URL — every
 * test file here must stay hermetic regardless of that).
 *
 * Not theoretical (code-audit H7 — "a green automated suite can still ship
 * a broken migration/conflict target"): an empirical smoke test against the
 * real DB DID catch a real bug during this feature's development —
 * `recordNavAuditRun` originally called `insertReturning` (a plain-INSERT
 * helper that silently ignores `onConflict`/`update`) instead of `upsert()`,
 * so the dedup path threw a raw constraint violation on every exact rerun.
 * No hermetic unit test here would have caught it (the conflict path never
 * executes when cloud is off). This repo's hermetic-test convention is
 * repo-wide and deliberate (safe `npm test` without live DB access/state),
 * so this file doesn't break that convention unilaterally — but the
 * empirical-verify step is treated as load-bearing, not optional, for this
 * store, and any DB-shape change here should be re-verified live before
 * being called done.
 */
process.env.AUDIT_DB_URL = ''; // must precede the dynamic import below

const { recordNavAuditRun, listNavAuditRunHistory, driftKeysContentHash } = await import('../scripts/lib/store/nav-audit.mjs');

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';

test('recordNavAuditRun: cloud off → {status: "unavailable"}, no query attempted', async () => {
  const r = await recordNavAuditRun({
    repoId: 'a0000000-0000-0000-0000-000000000000',
    headSha: 'deadbeef', scope: 'full', driftKeys: ['orphan:x'],
  });
  assert.equal(r.status, 'unavailable');
});

test('recordNavAuditRun: schema-invalid input rejected before any cloud check', async () => {
  const r = await recordNavAuditRun({ repoId: '', headSha: 'x', scope: 'full', driftKeys: [] });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /invalid args/);
});

test('recordNavAuditRun: missing required fields rejected', async () => {
  const r = await recordNavAuditRun({ repoId: 'r1' });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /invalid args/);
});

test('recordNavAuditRun: driftKeys must be an array of strings', async () => {
  const r = await recordNavAuditRun({ repoId: 'r1', headSha: 'x', scope: 'full', driftKeys: 'not-an-array' });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /invalid args/);
});

test('listNavAuditRunHistory: cloud off → {ok:true, rows:[]}', async () => {
  const r = await listNavAuditRunHistory({ repoId: 'a0000000-0000-0000-0000-000000000000' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, []);
});

test('listNavAuditRunHistory: missing repoId is rejected', async () => {
  const r = await listNavAuditRunHistory({});
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('listNavAuditRunHistory: sinceDays/limit default when omitted (no throw)', async () => {
  const r = await listNavAuditRunHistory({ repoId: 'r1' });
  assert.equal(r.ok, true);
});

test('listNavAuditRunHistory: sinceDays out of bounds is rejected', async () => {
  const r = await listNavAuditRunHistory({ repoId: 'r1', sinceDays: 9999 });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('listNavAuditRunHistory: limit out of bounds is rejected (code-audit M3/M10 — pins the raised default so a future edit can\'t silently reintroduce the truncation bug)', async () => {
  const tooHigh = await listNavAuditRunHistory({ repoId: 'r1', limit: 20001 });
  assert.equal(tooHigh.ok, false);
  assert.match(tooHigh.error, /invalid args/);
  const zero = await listNavAuditRunHistory({ repoId: 'r1', limit: 0 });
  assert.equal(zero.ok, false);
});

test('listNavAuditRunHistory: cloud off → truncated:false (never claims completeness dishonestly)', async () => {
  const r = await listNavAuditRunHistory({ repoId: 'r1' });
  assert.equal(r.truncated, false);
});

// ── driftKeysContentHash — the code-audit H2/H6/M3 data-loss fix ───────────
// Two diff-scope runs at the same head_sha with DIFFERENT audited content
// must no longer collide on (repo_id, head_sha, scope) alone.

describe('driftKeysContentHash', () => {
  it('is stable regardless of input key order (order-independent identity)', () => {
    assert.equal(
      driftKeysContentHash(['orphan:a', 'orphan:b']),
      driftKeysContentHash(['orphan:b', 'orphan:a']),
    );
  });

  it('is identical for two runs with the SAME drift_keys — an exact rerun still dedupes', () => {
    const a = driftKeysContentHash(['orphan:x', 'coverage-gap:y']);
    const b = driftKeysContentHash(['orphan:x', 'coverage-gap:y']);
    assert.equal(a, b);
  });

  it('differs for two runs with DIFFERENT drift_keys — the exact bug this fix closes', () => {
    const run1 = driftKeysContentHash(['orphan:a']);
    const run2 = driftKeysContentHash(['orphan:a', 'orphan:b']); // uncommitted tree changed between runs
    assert.notEqual(run1, run2, 'two diff-scope runs finding different drift must not collide on identity');
  });

  it('an empty drift_keys array (clean audit) produces a stable, non-throwing hash', () => {
    assert.doesNotThrow(() => driftKeysContentHash([]));
    assert.equal(driftKeysContentHash([]), driftKeysContentHash([]));
  });
});
