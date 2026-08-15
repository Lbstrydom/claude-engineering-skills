/**
 * @fileoverview Integration test for security incident neighbourhood retrieval.
 * Exercises the path-overlap fallback (pgvector-off path) end-to-end against a
 * real Postgres. Skips gracefully when no DB is configured or the security
 * migration has not been applied.
 */
import '../scripts/lib/load-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, closePool } from '../scripts/lib/db/client.mjs';
import { isCloudEnabled } from '../scripts/lib/store/repo.mjs';
import { query } from '../scripts/lib/db/query.mjs';
import {
  resolveSecurityRepoId,
  recordSecurityIncidents,
  markIncidentsHistorical,
  queryIncidentNeighbourhood,
} from '../scripts/lib/store/security.mjs';

const REPO = '__test_secneigh__';

async function securityTableExists(pool) {
  try {
    const r = await pool.query("SELECT to_regclass('public.security_incidents') AS t");
    return !!r.rows[0].t;
  } catch {
    return false;
  }
}

test('incident neighbourhood — path-overlap fallback', async (t) => {
  if (!(await isCloudEnabled())) { t.skip('no AUDIT_DB_URL — skipping DB integration test'); return; }
  const pool = await getPool();
  if (!(await securityTableExists(pool))) {
    t.skip('security_incidents not migrated (run npm run db:setup-postgres)');
    await closePool();
    return;
  }

  try {
    const repoId = await resolveSecurityRepoId(REPO);
    await query('DELETE FROM security_incidents WHERE repo_id = $1', [repoId]);

    await recordSecurityIncidents(repoId, [
      { incident_id: 'INC-001', description: 'a', affected_paths: ['src/x.mjs', 'src/y.mjs'], commit_sha: 'c1', source_fingerprint: 'f1' },
      { incident_id: 'INC-002', description: 'b', affected_paths: ['src/z.mjs'], commit_sha: 'c2', source_fingerprint: 'f2' },
    ], { includeEmbedding: false });

    const rows = await queryIncidentNeighbourhood({
      repoId, targetPaths: ['src/x.mjs'], intentEmbedding: null, k: 5, hasVector: false,
    });
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].incidentId, 'INC-001');
    assert.equal(rows[0].pathOverlap, 1);

    // k limit honoured
    const limited = await queryIncidentNeighbourhood({
      repoId, targetPaths: ['src/x.mjs'], intentEmbedding: null, k: 1, hasVector: false,
    });
    assert.equal(limited.length, 1);

    // historical incidents are excluded
    await markIncidentsHistorical(repoId, ['INC-001']);
    const after = await queryIncidentNeighbourhood({
      repoId, targetPaths: ['src/x.mjs'], intentEmbedding: null, k: 5, hasVector: false,
    });
    assert.ok(!after.some(r => r.incidentId === 'INC-001'));

    // cleanup (repo cascade removes incidents + events)
    await query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
  } finally {
    await closePool();
  }
});
