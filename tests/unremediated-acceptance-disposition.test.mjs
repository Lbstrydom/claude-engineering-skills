/**
 * @fileoverview `accepted-permanent` is a DECISION, not an open obligation
 * (migration `20260811160000_unremediated_acceptances_disposition`).
 *
 * `user_action = 'accepted-permanent'` is this repo's "declined on the merits"
 * disposition — in `audit_findings`'s CHECK constraint, written by
 * `adjudicateFinalReviewFinding` alongside `adjudication_outcome` and
 * `decided_at`. No view consulted it, so a properly recorded decision still
 * reported as an open obligation forever. Measured 2026-08-11: 36 of 231 rows
 * (15.6%) for this repo were already decided and still being nagged about.
 *
 * The load-bearing assertion here is the NULL one. 190 of those 231 rows have
 * `user_action IS NULL`, and `NULL <> 'accepted-permanent'` evaluates to NULL
 * rather than true — so a bare `<>` in place of `IS DISTINCT FROM` would drop
 * every one of them and silently empty the nag. That is the single most likely
 * implementation slip, and it fails in the success-shaped direction (a smaller
 * backlog looks like progress), which is exactly why it is pinned.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import { countUnremediatedAcceptances, countAcceptedPermanent } from '../scripts/lib/store/plans-ship.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl, repoId, otherRepoId;

/** Seed one run + one finding. `ageDays` drives which time band it lands in. */
async function seed(pool, repo, { ageDays, userAction, severity = 'HIGH', outcome = 'accepted', remediation = null, mode = 'code' }) {
  // `plan_file` and `mode` are NOT NULL with no default on audit_runs —
  // checked against information_schema rather than assumed, after omitting
  // plan_file threw 23502 on the first run.
  const { rows: runRows } = await pool.query(
    `INSERT INTO audit_runs (repo_id, mode, plan_file, commit_sha, created_at)
     VALUES ($1, $2, 'docs/plans/disposition-fixture.md', $3, now() - ($4 || ' days')::interval) RETURNING id`,
    [repo, mode, crypto.randomUUID().slice(0, 12), String(ageDays)],
  );
  const runId = runRows[0].id;
  const { rows } = await pool.query(
    `INSERT INTO audit_findings
       (run_id, finding_fingerprint, pass_name, severity, category, primary_file,
        detail_snapshot, adjudication_outcome, remediation_state, user_action)
     VALUES ($1, $2, 'backend', $3, 'test', 'a.mjs', 'd', $4, $5, $6) RETURNING id`,
    [runId, crypto.randomUUID().slice(0, 8), severity, outcome, remediation, userAction],
  );
  return rows[0].id;
}

describe('unremediated acceptances — accepted-permanent is excluded, and counted (disposable DB)', { skip }, () => {
  const seeded = {};

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const repo = await upsertRepoByUuid({ repoUuid: `disp-${crypto.randomUUID()}`, name: 'disposition-test-repo', fingerprint: null });
    repoId = repo.id;
    const other = await upsertRepoByUuid({ repoUuid: `disp-other-${crypto.randomUUID()}`, name: 'disposition-other-repo', fingerprint: null });
    otherRepoId = other.id;

    const pool = await getPool();
    // The matrix. 14d = inside the nag window; 3d = immature; 45d = aged.
    seeded.nullNag = await seed(pool, repoId, { ageDays: 14, userAction: null });
    seeded.triageNag = await seed(pool, repoId, { ageDays: 14, userAction: 'needs_triage' });
    seeded.deferredNag = await seed(pool, repoId, { ageDays: 14, userAction: 'deferred' });
    seeded.permNag = await seed(pool, repoId, { ageDays: 14, userAction: 'accepted-permanent' });
    seeded.permAged = await seed(pool, repoId, { ageDays: 45, userAction: 'accepted-permanent' });
    seeded.permFresh = await seed(pool, repoId, { ageDays: 3, userAction: 'accepted-permanent' });
    // Excluded by predicate P regardless of disposition — proves the new
    // predicate did not accidentally widen the population.
    seeded.dismissed = await seed(pool, repoId, { ageDays: 14, userAction: null, outcome: 'dismissed' });
    seeded.fixed = await seed(pool, repoId, { ageDays: 14, userAction: null, remediation: 'fixed' });
    seeded.low = await seed(pool, repoId, { ageDays: 14, userAction: null, severity: 'LOW' });
    // Scoping control.
    seeded.otherRepo = await seed(pool, otherRepoId, { ageDays: 14, userAction: null });
  });

  after(async () => {
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedUrl;
    await _resetForTest();
  });

  const nagIds = async () => {
    const pool = await getPool();
    const { rows } = await pool.query(`SELECT audit_finding_id FROM unremediated_acceptances WHERE repo_id = $1`, [repoId]);
    return new Set(rows.map((r) => r.audit_finding_id));
  };

  it('a user_action IS NULL row stays OPEN — the IS DISTINCT FROM guard', async () => {
    // THE regression test. `NULL <> 'accepted-permanent'` is NULL, not true, so
    // a bare `<>` drops all 190 null rows and silently empties the nag.
    assert.ok((await nagIds()).has(seeded.nullNag), 'a null-disposition row must remain in the nag view');
  });

  it('needs_triage and deferred stay OPEN — only accepted-permanent is excluded', async () => {
    const ids = await nagIds();
    assert.ok(ids.has(seeded.triageNag), 'needs_triage is a waypoint, not a terminal disposition');
    assert.ok(ids.has(seeded.deferredNag), 'deferred is not "decided on the merits"');
  });

  it('accepted-permanent is excluded from the nag view', async () => {
    assert.equal((await nagIds()).has(seeded.permNag), false);
  });

  it('the base view still returns accepted-permanent — it is the census, not the nag', async () => {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT audit_finding_id, is_open_disposition FROM unremediated_acceptances_all WHERE audit_finding_id = $1`,
      [seeded.permNag],
    );
    assert.equal(rows.length, 1, 'the row must remain visible in the unbounded view');
    assert.equal(rows[0].is_open_disposition, false);
  });

  it('countAcceptedPermanent is UNWINDOWED — a 45-day-old decision still counts', async () => {
    // A windowed count would expire the anti-dumping-ground guarantee exactly
    // when the dumping ground becomes worth auditing.
    const n = await countAcceptedPermanent({ repoId });
    assert.equal(n, 3, 'all three accepted-permanent rows (3d, 14d, 45d) must count');
  });

  it('total === byDisposition.open, and excludes every P-ineligible row', async () => {
    const byMode = await countUnremediatedAcceptances({ repoId });
    const ids = await nagIds();
    // nag window holds exactly: null, needs_triage, deferred.
    assert.equal(byMode.total, 3, `expected 3 open rows, got ${byMode.total}`);
    assert.equal(byMode.total, ids.size, 'the count and the rows must agree');
    for (const k of ['dismissed', 'fixed', 'low', 'permNag']) {
      assert.equal(ids.has(seeded[k]), false, `${k} must not be in the nag view`);
    }
  });

  it('is repo-scoped — another repo never leaks in', async () => {
    assert.equal((await nagIds()).has(seeded.otherRepo), false);
    assert.equal(await countAcceptedPermanent({ repoId: otherRepoId }), 0);
  });

  it('vacuous-pass guard: the nag view is not simply empty', async () => {
    // Every assertion above is satisfiable by a view that returns nothing.
    assert.ok((await nagIds()).size > 0, 'the nag view must still return ordinary open rows');
  });
});
