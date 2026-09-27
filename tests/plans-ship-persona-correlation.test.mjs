/**
 * @fileoverview Integration test (disposable DB) for
 * `recordPersonaAuditCorrelation`'s `hash_version` stamping —
 * docs/plans/persona-finding-hash-versioning.md, Gemini gate R3 finding
 * G2: this function is the SOLE writer to `persona_audit_correlations`
 * (both the automatic `decideCorrelations` path and the manual
 * `record-correlation` CLI repair path), and was never updated to stamp
 * the new `hash_version` column. Env-gated: requires AUDIT_DB_TEST_URL.
 * Skips cleanly when absent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import { recordPersonaAuditCorrelation } from '../scripts/lib/store/plans-ship.mjs';
import { PERSONA_FINDING_HASH_VERSION } from '../scripts/lib/persona/audit-correlator.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl, repoId, sessionId;
const REPO_UUID = `test-persona-correlation-hashver-${crypto.randomUUID()}`;

describe('recordPersonaAuditCorrelation hash_version stamping (disposable DB)', { skip }, () => {
  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'persona-correlation-hashver-test-repo', fingerprint: null });
    repoId = repo.id;
    const pool = await getPool();
    const { rows } = await pool.query(
      `INSERT INTO persona_test_sessions
         (session_id, persona, url, browser_tool, verdict, repo_id)
       -- 'Ready for users' | 'Needs work' | 'Blocked' are the only values the
       -- persona_test_sessions_verdict_check accepts (20260413224948). This
       -- fixture said 'pass' and had never been executed to find out — the
       -- suite was registered in neither db-test-container.mjs nor
       -- postgres-parity.yml, so it never ran anywhere until 2026-08-11.
       VALUES ($1, 'tester', 'https://example.com', 'playwright', 'Needs work', $2)
       RETURNING id`,
      [`session-${crypto.randomUUID()}`, repoId],
    );
    sessionId = rows[0].id;
  });

  after(async () => {
    const cleanupErrors = [];
    try {
      const pool = await getPool();
      if (pool) {
        const statements = [
          [`DELETE FROM persona_audit_correlations WHERE persona_session_id = $1`, [sessionId]],
          [`DELETE FROM persona_test_sessions WHERE id = $1`, [sessionId]],
        ];
        for (const [sql, params] of statements) {
          try { await pool.query(sql, params); } catch (err) { cleanupErrors.push(new Error(`${sql}: ${err?.message || err}`)); }
        }
        try {
          const { rowCount } = await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [repoId]);
          if (rowCount === 0) cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = ${repoId}: matched 0 rows`));
        } catch (err) { cleanupErrors.push(new Error(`audit_repos delete: ${err?.message || err}`)); }
      }
    } finally {
      process.env.AUDIT_DB_URL = savedUrl;
      await closePool();
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'teardown had errors');
    }
  });

  it('the automatic (audit_missed) path stamps hash_version = PERSONA_FINDING_HASH_VERSION', async () => {
    const hash = crypto.randomBytes(32).toString('hex');
    const result = await recordPersonaAuditCorrelation(sessionId, {
      personaFindingHash: hash, personaSeverity: 'P0',
      auditFindingId: null, auditRunId: null,
      correlationType: 'audit_missed', matchScore: null, matchRationale: 'no candidate',
      matcherVersion: 1,
    });
    assert.equal(result.ok, true);
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT hash_version FROM persona_audit_correlations WHERE persona_session_id = $1 AND persona_finding_hash = $2`,
      [sessionId, hash],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hash_version, PERSONA_FINDING_HASH_VERSION);
  });

  it('the manual record-correlation repair path (a confirmed match) ALSO stamps hash_version — the same write chokepoint covers both callers', async () => {
    const hash = crypto.randomBytes(32).toString('hex');
    const result = await recordPersonaAuditCorrelation(sessionId, {
      personaFindingHash: hash, personaSeverity: 'P1',
      auditFindingId: null, auditRunId: null,
      correlationType: 'confirmed_hit', matchScore: 1.0, matchRationale: 'manual repair',
      matcherVersion: null, // manual path may not always know a matcherVersion
    });
    assert.equal(result.ok, true);
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT hash_version FROM persona_audit_correlations WHERE persona_session_id = $1 AND persona_finding_hash = $2`,
      [sessionId, hash],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hash_version, PERSONA_FINDING_HASH_VERSION, 'hash_version must be stamped unconditionally, independent of matcherVersion being present');
  });

  it('rejects a v1-shaped (8-hex) hash — Gemini gate R2 shadow finding 6277c9df', async () => {
    const result = await recordPersonaAuditCorrelation(sessionId, {
      personaFindingHash: 'deadbeef', personaSeverity: 'P0',
      auditFindingId: null, auditRunId: null,
      correlationType: 'confirmed_hit', matchScore: 1.0, matchRationale: 'manual repair, wrong shape',
      matcherVersion: null,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /64-hex/);
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT 1 FROM persona_audit_correlations WHERE persona_session_id = $1 AND persona_finding_hash = $2`,
      [sessionId, 'deadbeef'],
    );
    assert.equal(rows.length, 0, 'a rejected write must never reach the table');
  });

  it('rejects (loud, not a silent ok:true) when a required field is missing — findings eef38861/bc8cea53', async () => {
    const hash = crypto.randomBytes(32).toString('hex');
    const result = await recordPersonaAuditCorrelation(sessionId, {
      personaFindingHash: hash, personaSeverity: 'P0',
      auditFindingId: null, auditRunId: null,
      correlationType: null, // missing — used to silently return {ok:true} with nothing written
      matchScore: null, matchRationale: null, matcherVersion: null,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /correlationType/);
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT 1 FROM persona_audit_correlations WHERE persona_session_id = $1 AND persona_finding_hash = $2`,
      [sessionId, hash],
    );
    assert.equal(rows.length, 0, 'a rejected write must never reach the table');
  });

  it('refuses an auditRunId belonging to a DIFFERENT repo when a scope is resolved — findings 62bee23e/0d5c4c8d', async () => {
    const otherRepo = await upsertRepoByUuid({
      repoUuid: `test-persona-correlation-other-repo-${crypto.randomUUID()}`,
      name: 'persona-correlation-other-repo', fingerprint: null,
    });
    const pool = await getPool();
    const { rows: runRows } = await pool.query(
      `INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1, 'n/a', 'code') RETURNING id`,
      [otherRepo.id],
    );
    const otherRepoRunId = runRows[0].id;
    try {
      const hash = crypto.randomBytes(32).toString('hex');
      const result = await recordPersonaAuditCorrelation(sessionId, {
        personaFindingHash: hash, personaSeverity: 'P1',
        auditFindingId: null, auditRunId: otherRepoRunId,
        correlationType: 'confirmed_hit', matchScore: 1.0, matchRationale: 'cross-tenant probe',
        matcherVersion: null,
      }, { repoId });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'audit-run-cross-tenant');
      const { rows } = await pool.query(
        `SELECT 1 FROM persona_audit_correlations WHERE persona_session_id = $1 AND persona_finding_hash = $2`,
        [sessionId, hash],
      );
      assert.equal(rows.length, 0, 'a cross-tenant write must never reach the table');
    } finally {
      await pool.query(`DELETE FROM audit_runs WHERE id = $1`, [otherRepoRunId]);
      await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [otherRepo.id]);
    }
  });

  // ── Audit H1/H2/H23: tenancy is derived from the SESSION row on every call,
  // not only when the caller resolved opts.repoId, and a finding must belong
  // to the supplied run. Each refusal below wrote a row before the fix.
  async function seedOtherRepoRunAndFinding() {
    const other = await upsertRepoByUuid({
      repoUuid: `test-persona-correlation-other-${crypto.randomUUID()}`,
      name: 'persona-correlation-other-repo', fingerprint: null,
    });
    const pool = await getPool();
    const { rows: [run] } = await pool.query(
      `INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1, 'n/a', 'code') RETURNING id`, [other.id]);
    const { rows: [finding] } = await pool.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, round_raised)
       VALUES ($1, $2, 'structure', 'HIGH', 'x', 1) RETURNING id`, [run.id, `fp-${crypto.randomUUID()}`]);
    return { repoId: other.id, runId: run.id, findingId: finding.id };
  }
  async function seedSameRepoRunWithFinding() {
    const pool = await getPool();
    const { rows: [run] } = await pool.query(
      `INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1, 'n/a', 'code') RETURNING id`, [repoId]);
    const { rows: [finding] } = await pool.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, round_raised)
       VALUES ($1, $2, 'structure', 'HIGH', 'x', 1) RETURNING id`, [run.id, `fp-${crypto.randomUUID()}`]);
    return { runId: run.id, findingId: finding.id };
  }
  async function dropSeeded({ runIds = [], repoIds = [] }) {
    const pool = await getPool();
    for (const id of runIds) {
      await pool.query(`DELETE FROM persona_audit_correlations WHERE audit_run_id = $1
                          OR audit_finding_id IN (SELECT id FROM audit_findings WHERE run_id = $1)`, [id]);
      await pool.query(`DELETE FROM audit_findings WHERE run_id = $1`, [id]);
      await pool.query(`DELETE FROM audit_runs WHERE id = $1`, [id]);
    }
    for (const id of repoIds) await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [id]);
  }
  async function rowCount(hash) {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT 1 FROM persona_audit_correlations WHERE persona_session_id = $1 AND persona_finding_hash = $2`, [sessionId, hash]);
    return rows.length;
  }
  const correlation = (over) => ({
    personaFindingHash: crypto.randomBytes(32).toString('hex'), personaSeverity: 'P1',
    correlationType: 'confirmed_hit', matchScore: 1.0, matchRationale: 'ownership probe', matcherVersion: null,
    auditFindingId: null, auditRunId: null, ...over,
  });

  it('H1: refuses another repo\'s auditRunId even with NO resolved scope (tenant derived from the session)', async () => {
    const other = await seedOtherRepoRunAndFinding();
    try {
      const c = correlation({ auditRunId: other.runId });
      const r = await recordPersonaAuditCorrelation(sessionId, c); // no opts.repoId
      assert.equal(r.ok, false);
      assert.equal(r.written, false);
      assert.equal(r.reason, 'audit-run-cross-tenant');
      assert.equal(await rowCount(c.personaFindingHash), 0);
    } finally { await dropSeeded({ runIds: [other.runId], repoIds: [other.repoId] }); }
  });

  it('H2: refuses another repo\'s auditFindingId with no resolved scope', async () => {
    const other = await seedOtherRepoRunAndFinding();
    try {
      const c = correlation({ auditFindingId: other.findingId });
      const r = await recordPersonaAuditCorrelation(sessionId, c);
      assert.equal(r.reason, 'audit-finding-cross-tenant');
      assert.equal(await rowCount(c.personaFindingHash), 0);
    } finally { await dropSeeded({ runIds: [other.runId], repoIds: [other.repoId] }); }
  });

  it('H23: refuses a same-repo finding that belongs to a DIFFERENT run than the one supplied', async () => {
    const a = await seedSameRepoRunWithFinding();
    const b = await seedSameRepoRunWithFinding();
    try {
      const c = correlation({ auditRunId: a.runId, auditFindingId: b.findingId });
      const r = await recordPersonaAuditCorrelation(sessionId, c, { repoId });
      assert.equal(r.reason, 'audit-finding-run-mismatch');
      assert.equal(await rowCount(c.personaFindingHash), 0);
    } finally { await dropSeeded({ runIds: [a.runId, b.runId] }); }
  });

  it('refuses a dangling session id as parent-not-found, and a scope that does not own the session as parent-not-owned', async () => {
    const dangling = await recordPersonaAuditCorrelation(crypto.randomUUID(), correlation({}));
    assert.equal(dangling.reason, 'parent-not-found');
    const other = await seedOtherRepoRunAndFinding();
    try {
      const c = correlation({});
      const r = await recordPersonaAuditCorrelation(sessionId, c, { repoId: other.repoId });
      assert.equal(r.reason, 'parent-not-owned');
      assert.equal(await rowCount(c.personaFindingHash), 0);
    } finally { await dropSeeded({ runIds: [other.runId], repoIds: [other.repoId] }); }
  });

  it('NEGATIVE CONTROL: a same-repo finding with ITS OWN run writes, scoped or not', async () => {
    const a = await seedSameRepoRunWithFinding();
    try {
      for (const opts of [{ repoId }, {}]) {
        const c = correlation({ auditRunId: a.runId, auditFindingId: a.findingId });
        const r = await recordPersonaAuditCorrelation(sessionId, c, opts);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.written, true);
        assert.equal(await rowCount(c.personaFindingHash), 1);
      }
    } finally { await dropSeeded({ runIds: [a.runId] }); }
  });

  it('accepts an auditRunId belonging to the SAME repo when a scope is resolved', async () => {
    const pool = await getPool();
    const { rows: runRows } = await pool.query(
      `INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1, 'n/a', 'code') RETURNING id`,
      [repoId],
    );
    const sameRepoRunId = runRows[0].id;
    try {
      const hash = crypto.randomBytes(32).toString('hex');
      const result = await recordPersonaAuditCorrelation(sessionId, {
        personaFindingHash: hash, personaSeverity: 'P1',
        auditFindingId: null, auditRunId: sameRepoRunId,
        correlationType: 'confirmed_hit', matchScore: 1.0, matchRationale: 'same-tenant probe',
        matcherVersion: null,
      }, { repoId });
      assert.equal(result.ok, true, result.error);
      const { rows } = await pool.query(
        `SELECT 1 FROM persona_audit_correlations WHERE persona_session_id = $1 AND persona_finding_hash = $2`,
        [sessionId, hash],
      );
      assert.equal(rows.length, 1);
    } finally {
      await pool.query(`DELETE FROM persona_audit_correlations WHERE audit_run_id = $1`, [sameRepoRunId]);
      await pool.query(`DELETE FROM audit_runs WHERE id = $1`, [sameRepoRunId]);
    }
  });
});
