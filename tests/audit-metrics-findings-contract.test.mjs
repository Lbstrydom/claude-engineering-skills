/**
 * @fileoverview The ONE DB-gated integration test this plan adds
 * (docs/plans/meta-assess-store-backed-source.md §9/M1). Asserts a REAL
 * `fetchCloudMetrics` call against seeded rows returns every column both
 * `adaptFindingsToOutcomes` and `passRatesFromPassStats` read — a mock
 * cannot prove the widened SELECT (M1) actually reaches the real
 * `audit_findings`/`audit_pass_stats` schema, which is exactly the class of
 * bug Gemini G1 caught in this plan's own draft (`repo_id`, a column that
 * does not exist on `audit_findings`).
 *
 * INC-002 (docs/security-strategy.md — the 2026-07-14 production wipe):
 * gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('fetchCloudMetrics — findings/pass-stats column contract (DB integration)', { skip }, () => {
  let fetchCloudMetrics, q, repoId, runId;
  const FP = `contract-${crypto.randomUUID().slice(0, 8)}`;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    ({ fetchCloudMetrics } = await import('../scripts/audit-metrics.mjs'));

    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query(
      `INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [repoId, `test-${repoId.slice(0, 8)}`]
    );
    await q.query(
      `INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code')
       ON CONFLICT (id) DO NOTHING`,
      [runId, repoId]
    );
    await q.query(
      `INSERT INTO audit_findings
         (run_id, finding_fingerprint, pass_name, severity, category, adjudication_outcome, round_raised, prompt_variant_id)
       VALUES ($1, $2, 'structure', 'HIGH', 'test', 'accepted', 2, $3)`,
      [runId, FP, crypto.randomUUID()]
    );
    await q.query(
      `INSERT INTO audit_pass_stats (run_id, pass_name, findings_raised, findings_accepted, findings_dismissed)
       VALUES ($1, 'structure', 3, 1, 1)`,
      [runId]
    );
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_pass_stats WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  test('the widened findings SELECT returns every column adaptFindingsToOutcomes reads', async () => {
    const cloud = await fetchCloudMetrics(null, 365, repoId);
    assert.ok(cloud, 'fetchCloudMetrics must return a real result against a live pool');
    const row = cloud.findings.find((f) => f.pass_name === 'structure');
    assert.ok(row, 'the seeded finding must come back');
    // Every field the M1(R1)+R3/H3 contract names — explicitly NOT repo_id
    // (Gemini G1: that column does not exist on audit_findings at all).
    for (const col of ['severity', 'adjudication_outcome', 'pass_name', 'created_at', 'round_raised', 'prompt_variant_id']) {
      assert.ok(col in row, `fetchCloudMetrics().findings rows must carry "${col}"`);
    }
    assert.equal('repo_id' in row, false, 'audit_findings has no repo_id column — selecting it would 42703');
    assert.equal(row.severity, 'HIGH');
    assert.equal(row.adjudication_outcome, 'accepted');
    assert.equal(row.round_raised, 2);
    assert.ok(row.created_at);
  });

  test('the pass-stats rows carry every column passRatesFromPassStats reads', async () => {
    const cloud = await fetchCloudMetrics(null, 365, repoId);
    const row = cloud.passStats.find((p) => p.pass_name === 'structure');
    assert.ok(row, 'the seeded pass-stat row must come back');
    for (const col of ['pass_name', 'findings_raised', 'findings_accepted', 'findings_dismissed']) {
      assert.ok(col in row, `fetchCloudMetrics().passStats rows must carry "${col}"`);
    }
    assert.equal(row.findings_raised, 3);
    assert.equal(row.findings_accepted, 1);
    assert.equal(row.findings_dismissed, 1);
  });

  test('the seeded rows round-trip through the real adapters end to end', async () => {
    const { adaptFindingsToOutcomes, passRatesFromPassStats } = await import('../scripts/lib/assessment-source.mjs');
    const cloud = await fetchCloudMetrics(null, 365, repoId);
    const { records, excluded } = adaptFindingsToOutcomes(cloud.findings);
    const seeded = records.find((r) => r.severity === 'HIGH' && r.round === 2);
    assert.ok(seeded, 'the seeded finding must survive adaptFindingsToOutcomes unexcluded');
    assert.equal(Object.values(excluded).reduce((a, b) => a + b, 0), 0, 'nothing about the seeded row should be excluded');

    const { byPass } = passRatesFromPassStats(cloud.passStats);
    assert.ok(byPass.structure);
    assert.equal(byPass.structure.raised >= 3, true);
  });
});
