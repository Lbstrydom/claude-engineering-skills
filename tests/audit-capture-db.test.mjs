/**
 * @fileoverview Audit telemetry capture against a real Postgres
 * (docs/plans/audit-telemetry-capture.md; migration 20261029120000).
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

describe('audit telemetry capture (DB integration)', { skip }, () => {
  let q, rf, repoId;
  const tag = crypto.randomUUID().slice(0, 8);
  const runIds = [];

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    rf = await import('../scripts/lib/store/runs-findings.mjs');
    repoId = crypto.randomUUID();
    await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [repoId, `capture-${tag}`]);
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM finding_adjudication_events WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = ANY($1::uuid[]))', [runIds]);
    await q.query('DELETE FROM audit_findings WHERE run_id = ANY($1::uuid[])', [runIds]);
    await q.query('DELETE FROM audit_runs WHERE repo_id = $1', [repoId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  async function start(opts) {
    const id = await rf.recordRunStart(repoId, 'docs/plans/x.md', 'code', opts);
    runIds.push(id);
    return q.one('SELECT audit_session_id, audit_round, capture_epoch FROM audit_runs WHERE id = $1', [id]);
  }

  // Phase 1: session identity and epoch
  {
    test('P1: two rounds of one session share the session id and get rounds 1 and 2; both carry the epoch', async () => {
      const a = await start({ auditSessionId: 'sess-1', auditRound: 1 });
      const b = await start({ auditSessionId: 'sess-1', auditRound: 2 });
      assert.equal(a.audit_session_id, 'sess-1');
      assert.equal(b.audit_session_id, 'sess-1');
      assert.deepEqual([a.audit_round, b.audit_round], [1, 2]);
      assert.equal(a.capture_epoch, 'capture-v1');
    });

    test('P1: an arm run (round null) and a unified run (explicit runId) carry no round', async () => {
      const arm = await start({ auditSessionId: 'bake-1', auditRound: null });
      assert.equal(arm.audit_round, null);
      assert.equal(arm.audit_session_id, 'bake-1');
      const unified = await start({ auditSessionId: 'sess-2', auditRound: 1, runId: crypto.randomUUID() });
      assert.equal(unified.audit_round, null);
    });

    test('P1: no identity: the run is stamped with the epoch but stays unlinked (never guessed)', async () => {
      const r = await start({});
      assert.equal(r.audit_session_id, null);
      assert.equal(r.audit_round, null);
      assert.equal(r.capture_epoch, 'capture-v1');
    });

    test('P1: the migration is idempotent (applied twice)', async () => {
      const sql = fs.readFileSync(path.resolve('supabase/migrations/20261029120000_audit_capture_v1.sql'), 'utf8');
      await q.query(sql);
      await q.query(sql);
    });
  }
  // Phase 2: source model on findings
  {
    const finding = (hash, extra = {}) => ({ _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd', ...extra });
    const modelOf = (runId, hash) => q.one('SELECT source_model FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2', [runId, hash]);

    test('P2: a re-record with a null _sourceModel keeps gpt-6.1-terra (a set value is not nulled)', async () => {
      const runId = crypto.randomUUID();
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [runId, repoId]);
      runIds.push(runId);
      const hash = `p2-${crypto.randomUUID().slice(0, 8)}`;
      await rf.recordFindings(runId, [finding(hash, { _sourceModel: 'gpt-6.1-terra' })], 'backend', 1);
      assert.equal((await modelOf(runId, hash)).source_model, 'gpt-6.1-terra');
      await rf.recordFindings(runId, [finding(hash)], 'backend', 1);
      assert.equal((await modelOf(runId, hash)).source_model, 'gpt-6.1-terra');
    });

    test('P2: a re-record with a different concrete model still updates it (negative control: COALESCE is not DO NOTHING)', async () => {
      const runId = crypto.randomUUID();
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [runId, repoId]);
      runIds.push(runId);
      const hash = `p2b-${crypto.randomUUID().slice(0, 8)}`;
      await rf.recordFindings(runId, [finding(hash, { _sourceModel: 'gpt-6.1-sol' })], 'backend', 1);
      await rf.recordFindings(runId, [finding(hash, { _sourceModel: 'gpt-6.1-terra' })], 'backend', 1);
      assert.equal((await modelOf(runId, hash)).source_model, 'gpt-6.1-terra');
    });

    test('P2: recordRunComplete with a null geminiVerdict does not erase a verdict already written', async () => {
      const runId = crypto.randomUUID();
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode, gemini_verdict) VALUES ($1, $2, 'docs/plans/x.md', 'code', 'APPROVE')`, [runId, repoId]);
      runIds.push(runId);
      await rf.recordRunComplete(runId, { rounds: 1, totalFindings: 0, accepted: 0, dismissed: 0, fixed: 0, geminiVerdict: null });
      assert.equal((await q.one('SELECT gemini_verdict FROM audit_runs WHERE id = $1', [runId])).gemini_verdict, 'APPROVE');
      await rf.recordRunComplete(runId, { rounds: 1, totalFindings: 0, accepted: 0, dismissed: 0, fixed: 0, geminiVerdict: 'CONCERNS' });
      assert.equal((await q.one('SELECT gemini_verdict FROM audit_runs WHERE id = $1', [runId])).gemini_verdict, 'CONCERNS');
    });
  }
});
