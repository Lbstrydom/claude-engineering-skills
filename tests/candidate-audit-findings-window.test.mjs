/**
 * @fileoverview `getCandidateAuditFindings` — the correlator's candidate
 * window. Integration test on a disposable DB; skips cleanly without
 * AUDIT_DB_TEST_URL.
 *
 * THE DEFECT (measured 2026-08-11 on the live store). The window's `LIMIT 5`
 * caps **runs**, then findings are fetched for those run ids — so a run that
 * found nothing still consumes one of the five slots. A repo that converges
 * clean often therefore goes blind: 112 of 188 (60%) of wine-cellar-app's
 * `mode=code` runs carry zero findings, and replaying every audit_run as an
 * as-of moment, **44 of 237 (19%)** of them build an entirely empty candidate
 * set. The 2026-07-28 persona session (3 real P1s) is one of those: its five
 * most recent runs had zero findings between them, so it reported
 * `no-candidate-runs` and correlated against nothing.
 *
 * Restricting the LIMIT to runs that HAVE findings takes wine from 44 blind
 * moments to 8 (19% -> 3%) and claude-engineering-skills from 1 to 0. The
 * residual 8 are correct — no findings-bearing run within the 14-day window at
 * all, which is what `no-candidate-runs` is FOR. That distinction is the point
 * of this suite: the filter must widen the window without ever making an empty
 * result unreachable.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import { getCandidateAuditFindings } from '../scripts/lib/store/plans-ship.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl, repoId, emptyRepoId;

/** Insert a run `agedDays` old, with `nFindings` findings attached. */
async function seedRun({ repo, agedDays, nFindings, commitSha = null }) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO audit_runs (repo_id, plan_file, mode, created_at, commit_sha)
     VALUES ($1, 'docs/plans/candidate-window.md', 'code', now() - ($2 || ' days')::interval, $3) RETURNING id`,
    [repo, String(agedDays), commitSha],
  );
  const runId = rows[0].id;
  for (let i = 0; i < nFindings; i += 1) {
    await pool.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, primary_file, detail_snapshot)
       VALUES ($1, $2, 'structure', 'HIGH', 'crash', 'src/checkout.tsx', 'Checkout throws on click.')`,
      [runId, crypto.randomUUID().slice(0, 8)],
    );
  }
  return runId;
}

describe('getCandidateAuditFindings — the LIMIT caps runs-with-findings, not runs', { skip }, () => {
  let signalRunId, oldShaRunId;

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;

    repoId = (await upsertRepoByUuid({
      repoUuid: `test-candidate-window-${crypto.randomUUID()}`,
      name: 'candidate-window-test-repo', fingerprint: null,
    })).id;
    emptyRepoId = (await upsertRepoByUuid({
      repoUuid: `test-candidate-window-empty-${crypto.randomUUID()}`,
      name: 'candidate-window-empty-repo', fingerprint: null,
    })).id;

    // The live shape, minimised: six runs inside the 14-day window, the five
    // most recent of which found nothing. Under the old query the LIMIT is
    // spent entirely on those five and the signal-bearing run never loads.
    for (const agedDays of [1, 2, 3, 4, 5]) {
      await seedRun({ repo: repoId, agedDays, nFindings: 0 });
    }
    signalRunId = await seedRun({ repo: repoId, agedDays: 6, nFindings: 3 });

    // Outside the window, reachable only via the exactCommitSha escape hatch.
    oldShaRunId = await seedRun({ repo: repoId, agedDays: 90, nFindings: 2, commitSha: 'deadbeefcafe' });

    // A repo whose only runs found nothing — `no-candidate-runs` must stay
    // reachable, or an empty result becomes unrepresentable and every session
    // manufactures an audit_missed against a run that never found anything.
    await seedRun({ repo: emptyRepoId, agedDays: 1, nFindings: 0 });
    await seedRun({ repo: emptyRepoId, agedDays: 2, nFindings: 0 });
  });

  after(async () => {
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedUrl;
    await _resetForTest();
  });

  it('finds the signal run behind five zero-finding runs (the 19%-of-moments bug)', async () => {
    const res = await getCandidateAuditFindings({ repoId });
    assert.equal(res.ok, true);
    assert.equal(res.rows.length, 3, 'the findings-bearing run must not be crowded out by empty runs');
    for (const row of res.rows) assert.equal(row.run_id, signalRunId);
  });

  it('still carries run_created_at on every row (the tie-breaker the matcher needs)', async () => {
    const res = await getCandidateAuditFindings({ repoId });
    for (const row of res.rows) {
      assert.ok(row.run_created_at instanceof Date || typeof row.run_created_at === 'string',
        `expected a run_created_at, got ${JSON.stringify(row.run_created_at)}`);
    }
  });

  it('the exactCommitSha escape hatch still reaches a run outside the window', async () => {
    const res = await getCandidateAuditFindings({ repoId, exactCommitSha: 'deadbeefcafe' });
    assert.equal(res.ok, true);
    const runIds = new Set(res.rows.map((r) => r.run_id));
    assert.ok(runIds.has(oldShaRunId), 'a 90-day-old run named by exact sha must still be a candidate');
    assert.ok(runIds.has(signalRunId), 'the in-window signal run must still be there too');
    assert.equal(res.rows.length, 5);
  });

  it('a repo whose runs all found nothing still returns ok with zero rows — never an error', async () => {
    // This is the `no-candidate-runs` path. It must stay REACHABLE: an empty
    // candidate set is not evidence of an audit miss, and the correlator
    // short-circuits on it rather than emitting audit_missed.
    const res = await getCandidateAuditFindings({ repoId: emptyRepoId });
    assert.equal(res.ok, true);
    assert.deepEqual(res.rows, []);
  });

  it('honours the run limit — 5 findings-bearing runs, not 5 runs', async () => {
    const many = (await upsertRepoByUuid({
      repoUuid: `test-candidate-window-many-${crypto.randomUUID()}`,
      name: 'candidate-window-many-repo', fingerprint: null,
    })).id;
    // 7 findings-bearing runs interleaved with empties; only the newest 5
    // findings-bearing ones may load (1 finding each => exactly 5 rows).
    for (let d = 1; d <= 7; d += 1) {
      await seedRun({ repo: many, agedDays: d, nFindings: 0 });
      await seedRun({ repo: many, agedDays: d, nFindings: 1 });
    }
    const res = await getCandidateAuditFindings({ repoId: many });
    assert.equal(res.rows.length, 5, 'the limit must still bound the query');
  });
});
