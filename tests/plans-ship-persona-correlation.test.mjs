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
});
