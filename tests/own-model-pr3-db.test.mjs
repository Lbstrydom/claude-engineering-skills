/**
 * @fileoverview Own-model telemetry PR 3 against a real Postgres
 * (docs/plans/own-model-telemetry-pr3.md; migration 20261028120000): decision
 * provenance columns, run version stamps, per-call provenance idempotency and per-producer
 * summaries, consent history, the label-history view and the coverage SQL.
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND
 * .github/workflows/postgres-parity.yml - two edits, always.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is the URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('own-model telemetry PR 3 (DB integration)', { skip }, () => {
  let q, ld, llm, elig, cov, adj, repoId, runId;
  const tag = crypto.randomUUID().slice(0, 8);
  const callRow = (i, over = {}) => ({
    call_id: crypto.randomUUID(), audit_run_id: runId, repo_id: repoId, work_item_id: null, producer: 'audit',
    purpose: `p${i}`, model_resolved: 'gpt-x', route: 'native', prompt_hash: 'abcd1234', prompt_variant: null,
    temperature: null, reasoning_effort: 'high', input_tokens: 10, cached_tokens: 0, output_tokens: 5,
    reasoning_tokens: 2, latency_ms: 100, cost_usd: null, truncated: false, retried: false, fallback: false,
    schema_version: 1, ...over,
  });

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    ld = await import('../scripts/lib/store/learning-decisions.mjs');
    llm = await import('../scripts/lib/store/llm-calls.mjs');
    elig = await import('../scripts/lib/store/training-eligibility.mjs');
    cov = await import('../scripts/lib/telemetry/coverage.mjs');
    adj = await import('../scripts/lib/store/adjudication-events.mjs');
    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [repoId, `omp3-${tag}`]);
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [runId, repoId]);
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM llm_call_provenance WHERE audit_run_id = $1', [runId]);
    await q.query('DELETE FROM llm_call_log_summary WHERE audit_run_id = $1', [runId]);
    await q.query('DELETE FROM learning_decisions WHERE audit_run_id = $1', [runId]);
    await q.query('DELETE FROM finding_adjudication_events WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = $1)', [runId]);
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM training_eligibility_events WHERE repo_id = $1', [repoId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  test('a decision row carries the provenance columns it was given, and null where it was not (negative control)', async () => {
    const stamped = await ld.insertLearningDecision({
      decisionKey: `${runId}:pass_selection:r1:s0`, auditRunId: runId, decisionType: 'pass_selection', round: 1, sequence: 0, repoId,
      context: { a: 1 }, contextHash: 'h1', choice: { chose: 'all' },
      toolSha: 'a'.repeat(40), policyVersion: '0123456789abcdef', schemaVersion: 1, selectionRule: 'all-passes', selectionProbability: 1,
      randomised: false, inputSnapshot: { diff_hash: 'abcdef12' }, optionsNotChosen: [], eligiblePopulation: 5,
    });
    assert.equal(stamped.ok, true);
    const bare = await ld.insertLearningDecision({
      decisionKey: `${runId}:pass_selection:r1:s1`, auditRunId: runId, decisionType: 'pass_selection', round: 1, sequence: 1, repoId,
      context: { a: 2 }, contextHash: 'h2', choice: { chose: 'all' },
    });
    assert.equal(bare.ok, true);
    const rows = await q.many('SELECT sequence, tool_sha, policy_version, schema_version, selection_rule, selection_probability, randomised, input_snapshot, options_not_chosen, eligible_population FROM learning_decisions WHERE audit_run_id = $1 ORDER BY sequence', [runId]);
    assert.equal(rows[0].tool_sha, 'a'.repeat(40));
    assert.equal(Number(rows[0].selection_probability), 1);
    assert.equal(rows[0].randomised, false);
    assert.deepEqual(rows[0].input_snapshot, { diff_hash: 'abcdef12' });
    assert.deepEqual(rows[0].options_not_chosen, []);
    assert.equal(rows[0].eligible_population, 5);
    assert.equal(rows[1].tool_sha, null, 'an omitted stamp is NULL, never fabricated');
  });

  test('run version stamps are written via the convergence patch and a malformed one is not', async () => {
    await ld.recordConvergenceState(runId, { tool_sha: 'b'.repeat(40), policy_version: 'fedcba9876543210' });
    let r = await q.one('SELECT tool_sha, policy_version FROM audit_runs WHERE id = $1', [runId]);
    assert.deepEqual([r.tool_sha, r.policy_version], ['b'.repeat(40), 'fedcba9876543210']);
    const bad = await ld.recordConvergenceState(runId, { tool_sha: 'not hex!', policy_version: 'short' });
    assert.equal(bad.reason, 'nothing-to-write');
    r = await q.one('SELECT tool_sha FROM audit_runs WHERE id = $1', [runId]);
    assert.equal(r.tool_sha, 'b'.repeat(40));
  });

  test('llm calls: a replay collapses on call_id, and two producers keep separate summaries', async () => {
    const rows = [callRow(1), callRow(2)];
    const a = await llm.recordLlmCalls({ runId, producer: 'audit', nonce: 'aaaa1111', rows, recorded: 2, dropped: 0 });
    assert.deepEqual([a.ok, a.applied, a.rows], [true, true, 2]);
    const again = await llm.recordLlmCalls({ runId, producer: 'audit', nonce: 'aaaa1111', rows, recorded: 2, dropped: 0 });
    assert.equal(again.rows, 0, 'replay inserts nothing');
    const fr = await llm.recordLlmCalls({ runId, producer: 'final-review', nonce: 'bbbb2222', rows: [callRow(3, { producer: 'final-review', prompt_hash: null })], recorded: 1, dropped: 0 });
    assert.equal(fr.rows, 1);
    assert.equal(Number((await q.one('SELECT count(*) AS n FROM llm_call_provenance WHERE audit_run_id = $1', [runId])).n), 3);
    const sums = await q.many('SELECT producer, recorded, dropped FROM llm_call_log_summary WHERE audit_run_id = $1 ORDER BY producer', [runId]);
    assert.deepEqual(sums.map((s) => [s.producer, s.recorded, s.dropped]), [['audit', 2, 0], ['final-review', 1, 0]]);
  });

  test('a dropped count is preserved in the summary (loss is never hidden), and a bad producer is refused by the CHECK', async () => {
    await llm.recordLlmCalls({ runId, producer: 'audit', nonce: 'cccc3333', rows: [callRow(4)], recorded: 600, dropped: 100 });
    const s = await q.one("SELECT recorded, dropped FROM llm_call_log_summary WHERE audit_run_id = $1 AND process_nonce = 'cccc3333'", [runId]);
    assert.deepEqual([s.recorded, s.dropped], [600, 100]);
    await assert.rejects(q.query('INSERT INTO llm_call_provenance (call_id, producer, schema_version) VALUES ($1, $2, 1)', [crypto.randomUUID(), 'nobody']), /llm_call_provenance_producer_chk|check/i);
  });

  test('consent history: approver required, every change appends, the repo row reflects the latest', async () => {
    const name = `omp3-${tag}`;
    assert.equal((await elig.setTrainingEligibility({ repoName: name, eligible: true, reason: 'public' })).reason, 'approved-by-required');
    assert.equal((await q.many('SELECT 1 FROM training_eligibility_events WHERE repo_id = $1', [repoId])).length, 0, 'a refused change writes nothing');
    assert.equal((await elig.setTrainingEligibility({ repoName: name, eligible: true, reason: 'public repo', approvedBy: 'louis' })).ok, true);
    assert.equal((await elig.setTrainingEligibility({ repoName: name, eligible: false, reason: 'terms changed', approvedBy: 'louis' })).ok, true);
    const hist = await q.many('SELECT eligible, reason, approved_by FROM training_eligibility_events WHERE repo_id = $1 ORDER BY set_at, ingested_at', [repoId]);
    assert.deepEqual(hist.map((h) => h.eligible), [true, false]);
    const repo = await q.one('SELECT training_eligible, training_eligibility_approved_by, training_eligibility_set_at FROM audit_repos WHERE id = $1', [repoId]);
    assert.equal(repo.training_eligible, false);
    assert.equal(repo.training_eligibility_approved_by, 'louis');
    assert.ok(repo.training_eligibility_set_at);
  });

  test('label history: ingested_at is observed on new rows and the view orders every adjudication per finding', async () => {
    const f = await q.one(`INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, round_raised) VALUES ($1, $2, 'structure', 'HIGH', 'test', 1) RETURNING id`, [runId, `omp3-${tag}-f`]);
    for (const outcome of ['accepted', 'dismissed']) {
      await q.query(`INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, round, adjudicator_kind, method, event_origin) VALUES ($1, $2, 'pending', 1, 'pipeline', 'verified', 'audit')`, [f.id, outcome]);
    }
    const hist = await q.many('SELECT outcome, ordinal, ingested_at_inferred FROM finding_label_history WHERE finding_id = $1 ORDER BY ordinal', [f.id]);
    assert.deepEqual(hist.map((h) => h.outcome), ['accepted', 'dismissed']);
    assert.deepEqual(hist.map((h) => Number(h.ordinal)), [1, 2]);
    assert.ok(hist.every((h) => h.ingested_at_inferred === false), 'a new row is OBSERVED, not inferred');
    const nullable = await q.one("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'finding_adjudication_events' AND column_name = 'ingested_at'");
    assert.equal(nullable.is_nullable, 'NO');
  });

  test('every tracked coverage entry executes against the real schema, and the measurement reads real fill', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.own-model-coverage.json'), 'utf8'));
    assert.ok(cfg.entries.length > 10, 'vacuous-pass guard');
    for (const e of cfg.entries) {
      const { sql, params } = cov.buildMeasureSql(e);
      const r = await q.one(sql, params);   // would throw on a bad column, table or predicate
      assert.ok(Number.isInteger(r.total) && Number.isInteger(r.filled), `${e.table}.${e.column}`);
    }
    // Seeded fill: two pass_selection decisions exist above, one with selection_rule set.
    const entry = { table: 'learning_decisions', column: 'selection_rule', since: '2000-01-01', where: 'pass_selection', expectFill: 0.9, tolerance: 0.05 };
    const { sql, params } = cov.buildMeasureSql(entry);
    const m = await q.one(`${sql} AND audit_run_id = '${runId}'`, params);
    assert.deepEqual([m.total, m.filled], [2, 1]);
    assert.equal(cov.evaluateEntry(entry, m).status, 'below-floor', 'a half-filled column fails its 0.9 floor');
  });

  test('adjudication writer module still exports the event writer used by the label history', () => {
    assert.equal(typeof adj.recordAdjudicationEvent, 'function');
  });
});
