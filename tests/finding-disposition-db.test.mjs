/**
 * @fileoverview `closeFindingById` against real Postgres.
 *
 * The motivating fact is the first test: `/ship` Step 0.5e told operators to
 * close an unremediated acceptance with `final-review-record-fix`, which is
 * scoped to final-review passes — so for an ordinary-pass finding (all 142
 * rows of the 2026-10-02 queue) it could only ever answer `no-match`. Each
 * disposition then has to (a) take the finding OUT of
 * `unremediated_acceptances_all`'s open set, the obligation reader, and
 * (b) refuse a finding that belongs to another repository.
 *
 * ENROLMENT IS TWO EDITS (AGENTS.md): `scripts/db-test-container.mjs` and
 * `.github/workflows/postgres-parity.yml`.
 *
 * @module tests/finding-disposition-db
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

describe('closeFindingById — by-id disposition of ordinary-pass findings', { skip }, () => {
  let q, mod, runsFindings, savedUrl;
  const REPO = randomUUID();
  const OTHER_REPO = randomUUID();
  const RUN = randomUUID();
  const OTHER_RUN = randomUUID();

  const insFinding = async (runId, fp) => (await q.one(
    `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, adjudication_outcome, remediation_state, round_raised)
     VALUES ($1, $2, 'be-services', 'HIGH', 'test', 'accepted', 'pending', 2) RETURNING id`,
    [runId, fp])).id;
  const isOpen = async (id) => (await q.many(
    `SELECT 1 FROM unremediated_acceptances_all WHERE audit_finding_id = $1 AND is_open_disposition`, [id])).length === 1;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    await _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    mod = await import('../scripts/lib/store/finding-disposition.mjs');
    runsFindings = await import('../scripts/lib/store/runs-findings.mjs');
    for (const [id, name] of [[REPO, 'test/disposition-a'], [OTHER_REPO, 'test/disposition-b']]) {
      await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, name]);
    }
    for (const [id, repo] of [[RUN, REPO], [OTHER_RUN, OTHER_REPO]]) {
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/fixture.md', 'code')
                     ON CONFLICT (id) DO NOTHING`, [id, repo]);
    }
  });

  after(async () => {
    try {
      await q.query('DELETE FROM audit_runs WHERE id = ANY($1)', [[RUN, OTHER_RUN]]).catch(() => {});
      await q.query('DELETE FROM audit_repos WHERE id = ANY($1)', [[REPO, OTHER_REPO]]).catch(() => {});
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
      const { closePool, _resetForTest } = await import('../scripts/lib/db/client.mjs');
      await closePool?.();
      await _resetForTest?.();
    }
  });

  it('the control: final-review-record-fix cannot touch an ordinary-pass finding', async () => {
    const id = await insFinding(RUN, 'fp-control');
    const res = await runsFindings.recordFinalReviewFix(RUN, 'fp-control', { state: 'fixed' });
    assert.equal(res.ok, false, 'if this ever succeeds, /ship 0.5e\'s printed command works again and this module may be redundant');
    assert.equal(await isOpen(id), true);
  });

  it('fixed: leaves the open set, records remediation_state and the fixing commit', async () => {
    const id = await insFinding(RUN, 'fp-fixed');
    assert.equal(await isOpen(id), true, 'precondition: an accepted, pending finding is an open obligation');
    const res = await mod.closeFindingById({ repoId: REPO, findingId: id, disposition: 'fixed', commitSha: 'abc1234' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.commitRecorded, true);
    const row = await q.one('SELECT remediation_state, fix_commit_sha FROM audit_findings WHERE id = $1', [id]);
    assert.deepEqual(row, { remediation_state: 'fixed', fix_commit_sha: 'abc1234' });
    assert.equal(await isOpen(id), false);
  });

  it('dismissed: records an overrule event with the reason and leaves the open set', async () => {
    const id = await insFinding(RUN, 'fp-dismissed');
    const res = await mod.closeFindingById({ repoId: REPO, findingId: id, disposition: 'dismissed', reason: 'claim is false on current code' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const ev = await q.one('SELECT adjudication_outcome, ruling, ruling_rationale, round FROM finding_adjudication_events WHERE finding_id = $1', [id]);
    assert.deepEqual(ev, { adjudication_outcome: 'dismissed', ruling: 'overrule', ruling_rationale: 'claim is false on current code', round: 2 });
    const f = await q.one('SELECT adjudication_outcome, dismiss_reason FROM audit_findings WHERE id = $1', [id]);
    assert.deepEqual(f, { adjudication_outcome: 'dismissed', dismiss_reason: 'claim is false on current code' });
    assert.equal(await isOpen(id), false);
  });

  it('accepted-permanent: stays visible as a disposition, not as an open obligation', async () => {
    const id = await insFinding(RUN, 'fp-permanent');
    const res = await mod.closeFindingById({ repoId: REPO, findingId: id, disposition: 'accepted-permanent', reason: 'documented trade-off' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(await isOpen(id), false);
    const still = await q.many('SELECT 1 FROM unremediated_acceptances_all WHERE audit_finding_id = $1', [id]);
    assert.equal(still.length, 1, 'a permanent acceptance is counted (acceptedPermanent), never hidden');
  });

  it('a finding from another repository is refused and left untouched', async () => {
    const foreign = await insFinding(OTHER_RUN, 'fp-foreign');
    const res = await mod.closeFindingById({ repoId: REPO, findingId: foreign, disposition: 'fixed' });
    assert.deepEqual(res, { ok: false, reason: 'not-found-in-repo' });
    assert.equal(await isOpen(foreign), true);
  });

  it('a dismissal without a reason is refused before anything is written', async () => {
    const id = await insFinding(RUN, 'fp-noreason');
    assert.deepEqual(await mod.closeFindingById({ repoId: REPO, findingId: id, disposition: 'dismissed', reason: '  ' }),
      { ok: false, reason: 'reason-required' });
    assert.equal(await isOpen(id), true);
  });
});
