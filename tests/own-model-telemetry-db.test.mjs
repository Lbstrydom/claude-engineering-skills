/**
 * @fileoverview Own-model telemetry slice 1 (docs/plans/own-model-telemetry-slice-1.md)
 * against a real Postgres: the writers, the chronology columns, the campaign
 * provenance survival, the diff persistence and the census instrument.
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND
 * .github/workflows/postgres-parity.yml — two edits, always.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is the URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('own-model telemetry slice 1 (DB integration)', { skip }, () => {
  let q, store, diffs, capture, elig, repoId, runId;
  const tag = crypto.randomUUID().slice(0, 8);
  const fp = (n) => `omt-${tag}-${n}`;

  async function seedFinding(name, extra = {}) {
    const row = await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, round_raised)
       VALUES ($1, $2, 'structure', 'HIGH', 'test', 1) RETURNING id`, [runId, fp(name)]);
    if (Object.keys(extra).length) {
      const cols = Object.keys(extra);
      await q.query(`UPDATE audit_findings SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [row.id, ...cols.map((c) => extra[c])]);
    }
    return row.id;
  }
  const finding = (id) => q.one('SELECT * FROM audit_findings WHERE id = $1', [id]);
  const events = (id) => q.many('SELECT * FROM finding_adjudication_events WHERE finding_id = $1 ORDER BY created_at', [id]);
  const adjudicate = (name, over = {}) => store.recordAdjudicationEvent(runId, fp(name), {
    adjudicationOutcome: 'accepted', remediationState: 'pending', ruling: 'sustain',
    rulingRationale: 'test', round: 1, adjudicatorKind: 'pipeline', ...over,
  });

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    store = await import('../scripts/lib/store/runs-findings.mjs');
    diffs = await import('../scripts/lib/store/run-diffs.mjs');
    capture = await import('../scripts/lib/audit/diff-capture.mjs');
    elig = await import('../scripts/lib/store/training-eligibility.mjs');
    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [repoId, `omt-${tag}`]);
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [runId, repoId]);
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM finding_adjudication_events WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = $1)', [runId]);
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    await q.query('DELETE FROM audit_run_diffs WHERE diff_text LIKE $1', [`%omt-${tag}%`]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  test('gap 2: a normal-path event records kind, model and origin (negative control: refused without kind)', async () => {
    const id = await seedFinding('kind');
    const refused = await store.recordAdjudicationEvent(runId, fp('kind'), {
      adjudicationOutcome: 'accepted', remediationState: 'pending', ruling: 'sustain', round: 1,
    });
    assert.deepEqual([refused.ok, refused.reason], [false, 'bad-input']);
    assert.equal((await events(id)).length, 0, 'a refused event must write nothing');

    assert.equal((await adjudicate('kind', { adjudicatorModel: 'gpt-x' })).ok, true);
    const [ev] = await events(id);
    assert.equal(ev.adjudicator_kind, 'pipeline');
    assert.equal(ev.adjudicator_model, 'gpt-x');
    assert.equal(ev.event_origin, 'audit');
  });

  test('gap 2: re-recording replaces only audit-origin events; a campaign verdict survives', async () => {
    const id = await seedFinding('campaign');
    await adjudicate('campaign');
    await q.query(
      `INSERT INTO finding_adjudication_events
         (finding_id, adjudication_outcome, remediation_state, round, adjudicator_kind, adjudicator_model, method, event_origin)
       VALUES ($1, 'accepted', 'pending', 1, 'agent', 'campaign-model', 'verified', 'campaign')`, [id]);
    await adjudicate('campaign', { adjudicationOutcome: 'dismissed', dismissReasonClass: 'false-positive', ruling: 'overrule' });
    const evs = await events(id);
    assert.equal(evs.length, 2, 'one audit event (replaced) + the surviving campaign verdict');
    assert.equal(evs.filter((e) => e.event_origin === 'audit').length, 1);
    const camp = evs.find((e) => e.event_origin === 'campaign');
    assert.equal(camp.adjudicator_kind, 'agent');
    assert.equal(camp.method, 'verified');
  });

  test('gap 3: a dismissal without a class is refused; with one, the class lands atomically', async () => {
    const id = await seedFinding('dismiss');
    const bad = await adjudicate('dismiss', { adjudicationOutcome: 'dismissed', ruling: 'overrule' });
    assert.deepEqual([bad.ok, bad.reason], [false, 'bad-input']);
    assert.equal((await finding(id)).dismiss_reason_class, null);
    assert.equal((await adjudicate('dismiss', { adjudicationOutcome: 'dismissed', ruling: 'overrule', dismissReasonClass: 'duplicate' })).ok, true);
    assert.equal((await finding(id)).dismiss_reason_class, 'duplicate');
    await assert.rejects(q.query(`UPDATE audit_findings SET dismiss_reason_class = 'made-up' WHERE id = $1`, [id]),
      /afd_dismiss_class_chk/, 'the DB CHECK is the second wall');
  });

  test('a fix projection never rewrites a campaign-origin event', async () => {
    const id = await seedFinding('campproj', { remediation_state: 'pending' });
    await q.query(
      `INSERT INTO finding_adjudication_events
         (finding_id, adjudication_outcome, remediation_state, round, adjudicator_kind, method, event_origin)
       VALUES ($1, 'accepted', 'pending', 1, 'agent', 'verified', 'campaign')`, [id]);
    await adjudicate('campproj');
    await store.markFindingsRemediation(repoId, [{ id, findingFingerprint: fp('campproj'), state: 'fixed', resolvedRound: 3 }]);
    const evs = await events(id);
    const camp = evs.find((e) => e.event_origin === 'campaign');
    assert.equal(camp.remediation_state, 'pending');
    assert.equal(camp.round, 1);
    assert.equal(evs.find((e) => e.event_origin === 'audit').remediation_state, 'fixed');
  });

  test('gap 7: first decision stamps first_decided_at and time_to_resolution_ms once', async () => {
    const id = await seedFinding('ttr');
    await q.query(`UPDATE audit_findings SET created_at = now() - interval '2 seconds' WHERE id = $1`, [id]);
    await adjudicate('ttr');
    const a = await finding(id);
    assert.ok(a.first_decided_at && a.time_to_resolution_ms >= 2000, `ttr=${a.time_to_resolution_ms}`);
    await adjudicate('ttr', { adjudicationOutcome: 'dismissed', dismissReasonClass: 'other', ruling: 'overrule' });
    const b = await finding(id);
    assert.equal(new Date(b.first_decided_at).getTime(), new Date(a.first_decided_at).getTime(), 're-adjudication must not move the first-decision stamp');
    assert.equal(b.time_to_resolution_ms, a.time_to_resolution_ms);
  });

  test('gap 4: fix then decision = true; decision then fix = false; decision, fix, re-adjudication stays false', async () => {
    const projected = async (id, state) => {
      const row = await finding(id);
      void row;
      const { markFindingsRemediation } = store;
      return markFindingsRemediation(repoId, [{ id, findingFingerprint: row.finding_fingerprint, state }]);
    };
    // fix first, then the first decision
    const a = await seedFinding('fixfirst');
    assert.equal((await projected(a, 'fixed')).updated, 1);
    assert.ok((await finding(a)).fix_recorded_at);
    assert.equal((await finding(a)).fixed_before_adjudication, null, 'no decision yet: unknown, not false');
    await adjudicate('fixfirst', { remediationState: 'pending' });
    assert.equal((await finding(a)).fixed_before_adjudication, true);

    // decision first, then the fix
    const b = await seedFinding('decfirst');
    await adjudicate('decfirst');
    assert.equal((await projected(b, 'fixed')).updated, 1);
    assert.equal((await finding(b)).fixed_before_adjudication, false);
    // ...and a later re-adjudication cannot rewrite it
    await adjudicate('decfirst', { remediationState: 'fixed' });
    assert.equal((await finding(b)).fixed_before_adjudication, false);
  });

  test('gap 4: a LEGACY finding (already decided, no first_decided_at) never gets an invented flag', async () => {
    const id = await seedFinding('legacy', { decided_at: new Date(Date.now() - 86_400_000).toISOString(), adjudication_outcome: 'accepted' });
    const { markFindingsRemediation } = store;
    await markFindingsRemediation(repoId, [{ id, findingFingerprint: fp('legacy'), state: 'fixed' }]);
    await adjudicate('legacy', { remediationState: 'fixed' });
    const row = await finding(id);
    assert.equal(row.first_decided_at, null, 'a prior decision is unprovable-first: the stamp stays NULL');
    assert.equal(row.fixed_before_adjudication, null);
  });

  test('gap 4: the sweep commit lands in fix_verified_commit (COALESCE), never in fix_commit_sha', async () => {
    const id = await seedFinding('verified', { remediation_state: 'pending' });
    const commit = 'b'.repeat(40);
    const res = await store.applyRemediationVerificationResults(repoId, [
      { findingId: id, outcome: 'resolved', checkedAtCommit: commit },
    ]);
    assert.equal(res.updated, 1, JSON.stringify(res));
    const row = await finding(id);
    assert.equal(row.remediation_state, 'verified');
    assert.equal(row.fix_verified_commit, commit);
    assert.equal(row.fix_commit_sha, null, 'an upper bound must never masquerade as the fix commit');
    assert.ok(row.fix_recorded_at, 'the first terminal transition is stamped');
  });

  test('gap 1: recordRunDiff persists a captured diff; replay is idempotent; the content row is shared', async () => {
    const diff = `diff --git a/src/omt-${tag}.js b/src/omt-${tag}.js\n--- a/src/omt-${tag}.js\n+++ b/src/omt-${tag}.js\n@@ -1 +1 @@\n-a\n+b\n`;
    const artifact = capture.prepareDiffArtifact(diff);
    assert.equal(artifact.status, 'captured');
    const sha = 'a'.repeat(40);
    const r1 = await diffs.recordRunDiff(runId, { baseSha: sha, artifact });
    assert.equal(r1.applied, true);
    const r2 = await diffs.recordRunDiff(runId, { baseSha: sha, artifact });
    assert.equal(r2.applied, true, 'replay of the same payload must not fail');
    const run = await q.one('SELECT diff_ref, diff_base_sha, diff_capture_status, diff_truncated, diff_redactions FROM audit_runs WHERE id = $1', [runId]);
    assert.deepEqual([run.diff_ref, run.diff_base_sha, run.diff_capture_status, run.diff_truncated], [artifact.ref, sha, 'captured', false]);
    assert.equal((await q.one('SELECT count(*)::int n FROM audit_run_diffs WHERE diff_ref = $1', [artifact.ref])).n, 1);
  });

  test('gap 1: a refused capture records its status with a NULL ref; an absent run row is a failed write', async () => {
    const r = await diffs.recordRunDiff(runId, { baseSha: null, artifact: { status: 'refused-secret', redactions: 2 } });
    assert.equal(r.applied, true);
    const run = await q.one('SELECT diff_ref, diff_capture_status, diff_redactions FROM audit_runs WHERE id = $1', [runId]);
    assert.deepEqual([run.diff_ref, run.diff_capture_status, run.diff_redactions], [null, 'refused-secret', 2]);
    const ghostDiff = capture.prepareDiffArtifact(`diff --git a/src/g-${tag}.js b/src/g-${tag}.js
--- a/src/g-${tag}.js
+++ b/src/g-${tag}.js
@@ -1 +1 @@
-a
+b
`);
    const ghost = await diffs.recordRunDiff(crypto.randomUUID(), { baseSha: null, artifact: ghostDiff });
    assert.deepEqual([ghost.applied, ghost.reason], [false, 'run-row-absent']);
    assert.equal((await q.one('SELECT count(*)::int n FROM audit_run_diffs WHERE diff_ref = $1', [ghostDiff.ref])).n, 0,
      'no content row may be committed without a run to attach it to');
  });

  test('gap 1: a repo whose training_eligible is explicitly false never has diff content stored', async () => {
    const r2 = crypto.randomUUID(), run2 = crypto.randomUUID();
    await q.query('INSERT INTO audit_repos (id, name, training_eligible) VALUES ($1, $2, false)', [r2, `omt-ex-${tag}`]);
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [run2, r2]);
    try {
      const diff = `diff --git a/src/ex-${tag}.js b/src/ex-${tag}.js
--- a/src/ex-${tag}.js
+++ b/src/ex-${tag}.js
@@ -1 +1 @@
-a
+b
`;
      const artifact = capture.prepareDiffArtifact(diff);
      assert.equal(artifact.status, 'captured');
      assert.equal((await diffs.recordRunDiff(run2, { baseSha: null, artifact })).applied, true);
      const run = await q.one('SELECT diff_ref, diff_capture_status FROM audit_runs WHERE id = $1', [run2]);
      assert.deepEqual([run.diff_ref, run.diff_capture_status], [null, 'repo-excluded']);
      assert.equal((await q.one('SELECT count(*)::int n FROM audit_run_diffs WHERE diff_ref = $1', [artifact.ref])).n, 0);
    } finally {
      await q.query('DELETE FROM audit_runs WHERE id = $1', [run2]);
      await q.query('DELETE FROM audit_repos WHERE id = $1', [r2]);
    }
  });

  test('gap 6: eligibility is default-deny against the real table', async () => {
    let res = await elig.checkReposEligibleForExport([repoId]);
    assert.deepEqual([res.ok, res.refused[0].reason], [false, 'undecided']);
    assert.equal((await elig.setTrainingEligibility({ repoName: `omt-${tag}`, eligible: true, reason: '' })).reason, 'reason-required');
    assert.equal((await elig.setTrainingEligibility({ repoName: `omt-${tag}`, eligible: true, reason: 'test repo' })).ok, true);
    assert.equal((await elig.checkReposEligibleForExport([repoId])).ok, true);
    await elig.setTrainingEligibility({ repoName: `omt-${tag}`, eligible: false, reason: 'revoked' });
    res = await elig.checkReposEligibleForExport([repoId]);
    assert.deepEqual([res.ok, res.refused[0].reason], [false, 'ineligible']);
    assert.equal((await elig.checkReposEligibleForExport([crypto.randomUUID()])).refused[0].reason, 'unknown-repo');
  });

  test('census: every gap reports a count (not UNMIGRATED) on a migrated schema', async () => {
    const { CENSUS_GAPS } = await import('../scripts/own-model-telemetry-census.mjs');
    for (const gap of CENSUS_GAPS) {
      const [r] = await q.many(gap.sql);
      assert.ok(Number.isInteger(r.populated) && Number.isInteger(r.population), gap.id);
    }
  });
});
