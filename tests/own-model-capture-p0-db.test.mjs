/**
 * @fileoverview Own-model capture P0 against a real Postgres (docs/plans/own-model-full-capture.md section 2.9;
 * migrations 20261123120000 and 20261123140000): the per-attempt identity and per-call tree columns round-trip
 * through the real `audit.llmCalls` writer, the closed outcome vocabulary is a CHECK, the weekly canary passes
 * and is seen to FAIL when its write is broken, and every completeness query runs on the real schema.
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND .github/workflows/postgres-parity.yml
 * (push paths, pull_request paths and the run list) - two edits, always.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is the URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';
const TREE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

describe('own-model capture P0 (DB integration)', { skip }, () => {
  let q, llm, repoId, runId, logicalId;
  const tag = crypto.randomUUID().slice(0, 8);
  const row = (i, over = {}) => ({
    call_id: crypto.randomUUID(), audit_run_id: runId, repo_id: repoId, work_item_id: null, producer: 'audit',
    purpose: `p${i}`, model_resolved: 'gpt-x', route: 'native', prompt_hash: 'abcd1234', prompt_variant: null,
    temperature: null, reasoning_effort: 'high', input_tokens: 10, cached_tokens: 0, output_tokens: 5,
    reasoning_tokens: 2, latency_ms: 100, cost_usd: 0.01, truncated: false, retried: false, fallback: false,
    schema_version: 1, logical_call_id: logicalId, attempt_no: i, attempt_outcome: i === 1 ? 'schema-reject' : 'success',
    capture_schema_version: 1, audited_tree: TREE, diff_base_sha: BASE, ...over,
  });
  const payload = (rows) => ({ runId, producer: 'audit', nonce: 'n1', rows, recorded: rows.length, dropped: 0 });

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    llm = await import('../scripts/lib/store/llm-calls.mjs');
    repoId = crypto.randomUUID(); runId = crypto.randomUUID(); logicalId = crypto.randomUUID();
    await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [repoId, `omp0-${tag}`]);
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [runId, repoId]);
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM llm_call_provenance WHERE audit_run_id = $1', [runId]);
    await q.query('DELETE FROM llm_call_log_summary WHERE audit_run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  test('attempt identity and per-call tree identity round-trip, and a replay inserts nothing', async () => {
    const rows = [row(1), row(2)];
    const first = await llm.recordLlmCalls(payload(rows));
    assert.equal(first.ok, true, first.error?.message);
    assert.equal(first.rows, 2);
    const got = await q.many('SELECT logical_call_id, attempt_no, attempt_outcome, capture_schema_version, audited_tree, diff_base_sha FROM llm_call_provenance WHERE audit_run_id = $1 ORDER BY attempt_no', [runId]);
    assert.equal(got.length, 2);
    assert.ok(got.every((r) => r.logical_call_id === logicalId && r.audited_tree === TREE && r.diff_base_sha === BASE && r.capture_schema_version === 1));
    assert.deepEqual(got.map((r) => r.attempt_outcome), ['schema-reject', 'success']);
    const replay = await llm.recordLlmCalls(payload(rows));
    assert.equal(replay.rows, 0, 'the deterministic call_id collapses a replay');
  });

  test('NEGATIVE CONTROL: a row without tree identity stores NULL, never another row value', async () => {
    const r = row(3, { audited_tree: null, diff_base_sha: null });
    await llm.recordLlmCalls(payload([r]));
    const [got] = await q.many('SELECT audited_tree, diff_base_sha FROM llm_call_provenance WHERE call_id = $1', [r.call_id]);
    assert.equal(got.audited_tree, null);
    assert.equal(got.diff_base_sha, null);
  });

  test('a replay after the migration backfills identity an older-tier insert dropped, and touches nothing else', async () => {
    const r = row(5, { audited_tree: null, diff_base_sha: null, model_resolved: 'first' });
    await llm.recordLlmCalls(payload([r]));
    const again = await llm.recordLlmCalls(payload([{ ...r, audited_tree: TREE, diff_base_sha: BASE, model_resolved: 'changed' }]));
    assert.equal(again.rows, 1, 'the NULL tree is filled');
    const [got] = await q.many('SELECT audited_tree, diff_base_sha, model_resolved FROM llm_call_provenance WHERE call_id = $1', [r.call_id]);
    assert.equal(got.audited_tree, TREE);
    assert.equal(got.diff_base_sha, BASE);
    assert.equal(got.model_resolved, 'first', 'no other column is overwritten');
    const third = await llm.recordLlmCalls(payload([{ ...r, audited_tree: 'c'.repeat(40) }]));
    assert.equal(third.rows, 0, 'a filled column is never overwritten');
  });

  test('pricing_version persists beside cost_usd, and a replay backfills it on a row written without it', async () => {
    const r = row(6, { pricing_version: null });
    const first = await llm.recordLlmCalls(payload([r]));
    assert.equal(first.degraded, undefined, 'the migrated store holds the column: nothing is dropped');
    await llm.recordLlmCalls(payload([{ ...r, pricing_version: '2026-09-23' }]));
    const [got] = await q.many('SELECT cost_usd, pricing_version FROM llm_call_provenance WHERE call_id = $1', [r.call_id]);
    assert.equal(got.pricing_version, '2026-09-23');
    assert.equal(Number(got.cost_usd), 0.01);
  });

  test('NEGATIVE CONTROLS: a replay never labels a different or absent stored cost, and never fills across runs', async () => {
    const differs = row(7, { pricing_version: null, cost_usd: 0.01 });
    await llm.recordLlmCalls(payload([differs]));
    await llm.recordLlmCalls(payload([{ ...differs, cost_usd: 0.02, pricing_version: '2026-09-23' }]));
    const noCost = row(8, { pricing_version: null, cost_usd: null });
    await llm.recordLlmCalls(payload([noCost]));
    await llm.recordLlmCalls(payload([{ ...noCost, pricing_version: '2026-09-23' }]));
    const got = await q.many('SELECT call_id, cost_usd, pricing_version FROM llm_call_provenance WHERE call_id IN ($1, $2)', [differs.call_id, noCost.call_id]);
    assert.ok(got.length === 2 && got.every((r) => r.pricing_version === null), JSON.stringify(got));
    // Cross-run: the same call_id replayed under another run fills nothing.
    const otherRun = crypto.randomUUID();
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [otherRun, repoId]);
    try {
      const cross = row(9, { audited_tree: null });
      await llm.recordLlmCalls(payload([cross]));
      const res = await llm.recordLlmCalls({ runId: otherRun, producer: 'audit', nonce: 'n2', rows: [{ ...cross, audit_run_id: otherRun, audited_tree: TREE }], recorded: 1, dropped: 0 });
      assert.equal(res.rows, 0);
      const [c] = await q.many('SELECT audit_run_id, audited_tree FROM llm_call_provenance WHERE call_id = $1', [cross.call_id]);
      assert.deepEqual([c.audit_run_id, c.audited_tree], [runId, null]);
    } finally {
      await q.query('DELETE FROM llm_call_log_summary WHERE audit_run_id = $1', [otherRun]);
      await q.query('DELETE FROM audit_runs WHERE id = $1', [otherRun]);
    }
  });

  test('the outcome vocabulary is a CHECK: an unknown outcome is refused by the store', async () => {
    const res = await llm.recordLlmCalls(payload([row(4, { attempt_outcome: 'made-up' })]));
    assert.equal(res.ok, false);
    assert.match(String(res.error?.message), /attempt_outcome_chk|check constraint/i);
  });

  test('the weekly canary passes on the real schema and FAILS when its write is broken', async () => {
    const { runCanary } = await import('../scripts/lib/capture/canary.mjs');
    const ok = await runCanary({});
    assert.equal(ok.result, 'ok', JSON.stringify(ok.checks.filter((c) => !c.ok)));
    const broken = await runCanary({ breakWrite: true });
    assert.equal(broken.result, 'failed');
  });

  test('every completeness query runs on the real schema (a schema fault must not read as an empty report)', async () => {
    const { buildReport } = await import('../scripts/lib/capture/report.mjs');
    const r = await buildReport({ days: 7, repo: `omp0-${tag}` });
    assert.equal(r.schema, 'capture-completeness/v1');
    assert.ok(Array.isArray(r.auditDispatch) && Array.isArray(r.chipLaunch) && Array.isArray(r.fleetLand));
    // The scoped run is one start, stamped with the schema version its rows carry: an empty or mis-grouped report fails here.
    const g = r.auditDispatch.find((x) => x.repo === `omp0-${tag}`);
    assert.ok(g, 'the scoped repo has a dispatch group');
    assert.equal(g.starts, 1);
    assert.equal(g.capture_schema_version, '1');
  });
});
