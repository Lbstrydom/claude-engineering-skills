/**
 * @fileoverview Migration 20261123160000_persona_views_join_by_repo_id against a real Postgres.
 *
 * docs/plans/wine-org-move.md section 2.1 (step 2S, D2 = structural): `audit_effectiveness` and
 * `persona_density_per_repo` joined persona sessions by `audit_repos.name`, so a repo rename (a GitHub
 * transfer re-derives the name) silently dropped every session from both views. The migration joins by id,
 * backfills null ids, and STOPS (RAISE) when any session's association would change.
 *
 * Every test runs inside a transaction that is ALWAYS rolled back. The schema under test already carries the
 * migration, so each test first re-creates the PREVIOUS view definitions (OLD_VIEWS), seeds the legacy shape,
 * then runs the migration SQL.
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND .github/workflows/postgres-parity.yml - two edits, always.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is the URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';
const SQL = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations',
    '20261123160000_persona_views_join_by_repo_id.sql'), 'utf8');

// The definitions the migration replaces, verbatim apart from the join (20260419120000 / 20260508120000).
const OLD_VIEWS = `
CREATE OR REPLACE VIEW audit_effectiveness AS
SELECT r.id AS repo_id, r.name AS repo_name,
  COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')        AS confirmed_hits,
  COUNT(*) FILTER (WHERE c.correlation_type = 'audit_missed')         AS audit_misses,
  COUNT(*) FILTER (WHERE c.correlation_type = 'audit_false_positive') AS audit_false_positives,
  COUNT(*) FILTER (WHERE c.correlation_type = 'severity_understated') AS severity_understated,
  COUNT(*) FILTER (WHERE c.correlation_type = 'severity_overstated')  AS severity_overstated,
  ROUND(NULLIF(COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')::numeric, 0)
    / NULLIF(COUNT(*) FILTER (WHERE c.correlation_type IN ('confirmed_hit', 'audit_false_positive'))::numeric, 0), 3) AS user_visible_precision,
  ROUND(NULLIF(COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')::numeric, 0)
    / NULLIF(COUNT(*) FILTER (WHERE c.correlation_type IN ('confirmed_hit', 'audit_missed'))::numeric, 0), 3) AS user_visible_recall
FROM audit_repos r
LEFT JOIN persona_test_sessions s ON s.repo_name = r.name
LEFT JOIN persona_audit_correlations c ON c.persona_session_id = s.id
GROUP BY r.id, r.name;

CREATE OR REPLACE VIEW persona_density_per_repo WITH (security_invoker = true) AS
  SELECT r.id AS repo_id, r.name AS repo_name,
    COALESCE(count(pts.id) FILTER (WHERE pts.created_at > now() - interval '30 days'), 0)::integer AS density_30d
  FROM audit_repos r
  LEFT JOIN persona_test_sessions pts ON pts.repo_name = r.name
  GROUP BY r.id, r.name;
`;

describe('persona views join by repo id (DB integration)', { skip }, () => {
  let pool;
  before(async () => {
    const client = await import('../scripts/lib/db/client.mjs');
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    client._resetForTest?.();
    pool = await client.getPool();
  });
  after(async () => {
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  /** Run `fn(c)` in a transaction that is ALWAYS rolled back, starting from an empty persona/repo world on the OLD views. */
  async function inLegacyTx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM persona_test_sessions'); // cascades correlations; rolled back
      await c.query(OLD_VIEWS);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  const mkRepo = async (c, name) => {
    const id = crypto.randomUUID();
    await c.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [id, name]);
    return id;
  };
  const mkSession = async (c, { repoId = null, repoName, daysAgo = 1 }) => {
    const { rows } = await c.query(
      `INSERT INTO persona_test_sessions (session_id, persona, url, browser_tool, verdict, repo_id, repo_name, created_at)
       VALUES ($1, 'p', 'http://x', 'pw', 'Needs work', $2, $3, now() - ($4 || ' days')::interval) RETURNING id`,
      [crypto.randomUUID(), repoId, repoName, String(daysAgo)]);
    return rows[0].id;
  };
  const mkCorrelation = (c, sessionId, type) => c.query(
    `INSERT INTO persona_audit_correlations (persona_session_id, persona_finding_hash, persona_severity, correlation_type)
     VALUES ($1, $2, 'P1', $3)`, [sessionId, crypto.randomUUID(), type]);
  const views = async (c) => ({
    eff: (await c.query('SELECT * FROM audit_effectiveness ORDER BY repo_name')).rows,
    den: (await c.query('SELECT * FROM persona_density_per_repo ORDER BY repo_name')).rows,
  });
  const refuses = async (c, re) => {
    await c.query('SAVEPOINT s');
    await assert.rejects(() => c.query(SQL), re);
    await c.query('ROLLBACK TO SAVEPOINT s');
  };

  test('rows for wine-shaped and other repos are IDENTICAL before and after (same projected columns)', async () => {
    await inLegacyTx(async (c) => {
      const wine = await mkRepo(c, 'Lbstrydom/wine-cellar-app');
      const other = await mkRepo(c, 'Lbstrydom/other-repo');
      const s1 = await mkSession(c, { repoId: wine, repoName: 'Lbstrydom/wine-cellar-app' });
      const s2 = await mkSession(c, { repoId: wine, repoName: 'Lbstrydom/wine-cellar-app', daysAgo: 60 });
      const s3 = await mkSession(c, { repoId: other, repoName: 'Lbstrydom/other-repo' });
      await mkCorrelation(c, s1, 'confirmed_hit');
      await mkCorrelation(c, s2, 'audit_missed');
      await mkCorrelation(c, s3, 'audit_false_positive');
      const before = await views(c);
      await c.query(SQL);
      assert.deepEqual(await views(c), before);
      const w = before.den.find((r) => r.repo_id === wine);
      assert.equal(w.density_30d, 1, 'sanity: the 60-day-old session is outside the window');
    });
  });

  test('a null-id legacy session stays with its repo ACROSS a rename (backfill), and an id session does too', async () => {
    await inLegacyTx(async (c) => {
      const wine = await mkRepo(c, 'Lbstrydom/wine-cellar-app');
      const legacy = await mkSession(c, { repoId: null, repoName: 'Lbstrydom/wine-cellar-app' });
      const withId = await mkSession(c, { repoId: wine, repoName: 'Lbstrydom/wine-cellar-app' });
      await mkCorrelation(c, legacy, 'confirmed_hit');
      await mkCorrelation(c, withId, 'confirmed_hit');
      await c.query(SQL);
      assert.equal((await c.query('SELECT repo_id FROM persona_test_sessions WHERE id = $1', [legacy])).rows[0].repo_id, wine, 'backfilled');
      await c.query(`UPDATE audit_repos SET name = 'Creathyst/wine-cellar-app' WHERE id = $1`, [wine]); // the transfer
      const { eff, den } = await views(c);
      assert.equal(den.find((r) => r.repo_id === wine).density_30d, 2, 'both sessions survive the rename');
      assert.equal(Number(eff.find((r) => r.repo_id === wine).confirmed_hits), 2); // bigint arrives as a string
    });
  });

  test('CONTROL: the OLD views lose the sessions on the same rename (the failure the migration exists to stop)', async () => {
    await inLegacyTx(async (c) => {
      const wine = await mkRepo(c, 'Lbstrydom/wine-cellar-app');
      await mkSession(c, { repoId: wine, repoName: 'Lbstrydom/wine-cellar-app' });
      await c.query(`UPDATE audit_repos SET name = 'Creathyst/wine-cellar-app' WHERE id = $1`, [wine]);
      assert.equal((await views(c)).den.find((r) => r.repo_id === wine).density_30d, 0);
    });
  });

  test('is idempotent on re-run', async () => {
    await inLegacyTx(async (c) => {
      const wine = await mkRepo(c, 'a/b');
      await mkSession(c, { repoId: null, repoName: 'a/b' });
      await c.query(SQL);
      const once = await views(c);
      await c.query(SQL);
      assert.deepEqual(await views(c), once);
      assert.equal(once.den.find((r) => r.repo_id === wine).density_30d, 1);
    });
  });

  test('a re-run AFTER a rename does not stop on the stale names the rename leaves (idempotent in the migrated world)', async () => {
    await inLegacyTx(async (c) => {
      const wine = await mkRepo(c, 'Lbstrydom/wine-cellar-app');
      await mkSession(c, { repoId: wine, repoName: 'Lbstrydom/wine-cellar-app' });
      await c.query(SQL);
      await c.query(`UPDATE audit_repos SET name = 'Creathyst/wine-cellar-app' WHERE id = $1`, [wine]);
      await c.query(SQL); // must not raise
      assert.equal((await views(c)).den.find((r) => r.repo_id === wine).density_30d, 1);
    });
  });

  test('a re-run never backfills an AMBIGUOUS name to an arbitrary repo (preflight is skipped once migrated)', async () => {
    await inLegacyTx(async (c) => {
      await c.query(SQL); // migrated world: views join by id
      const { rows } = await c.query(`SELECT i.indexrelid::regclass::text AS idx, c.conname FROM pg_index i
                       LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid
                      WHERE i.indrelid = 'audit_repos'::regclass AND i.indisunique AND NOT i.indisprimary`);
      for (const r of rows) {
        const cols = (await c.query(`SELECT array_agg(a.attname ORDER BY a.attnum) AS cols FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indexrelid = $1::regclass`, [r.idx])).rows[0].cols;
        if (cols.length === 1 && cols[0] === 'name') await c.query(r.conname ? `ALTER TABLE audit_repos DROP CONSTRAINT ${r.conname}` : `DROP INDEX ${r.idx}`);
      }
      await mkRepo(c, 'dup/name');
      await mkRepo(c, 'dup/name');
      const s = await mkSession(c, { repoId: null, repoName: 'dup/name' });
      await c.query(SQL);
      assert.equal((await c.query('SELECT repo_id FROM persona_test_sessions WHERE id = $1', [s])).rows[0].repo_id, null);
    });
  });

  test('STOP: a same-basename different-owner session whose id points at another repo (association would change)', async () => {
    await inLegacyTx(async (c) => {
      const wine = await mkRepo(c, 'Lbstrydom/wine-cellar-app');
      await mkSession(c, { repoId: wine, repoName: 'other-owner/wine-cellar-app' });
      await refuses(c, /association changes=1/);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM persona_test_sessions WHERE repo_id IS NULL`)).rows[0].n, 0);
    });
  });

  test('STOP: an id session whose name matches no repo (joins nothing today, something after)', async () => {
    await inLegacyTx(async (c) => {
      const wine = await mkRepo(c, 'Lbstrydom/wine-cellar-app');
      await mkSession(c, { repoId: wine, repoName: 'wine-cellar-app' });
      await refuses(c, /association changes=1/);
    });
  });

  test('STOP: a null-id session whose name matches no repo; and nothing is backfilled when it stops', async () => {
    await inLegacyTx(async (c) => {
      await mkRepo(c, 'Lbstrydom/wine-cellar-app');
      await mkSession(c, { repoId: null, repoName: 'Lbstrydom/wine-cellar-app' }); // resolvable
      await mkSession(c, { repoId: null, repoName: 'nobody/nothing' });
      await refuses(c, /null repo_id unresolved=1/);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM persona_test_sessions WHERE repo_id IS NULL`)).rows[0].n, 2,
        'the RAISE aborts before the backfill');
    });
  });

  test('STOP: a null-id session whose name matches more than one repo, and duplicate repo names', async () => {
    await inLegacyTx(async (c) => {
      await c.query(`SELECT i.indexrelid::regclass::text AS idx, c.conname FROM pg_index i
                       LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid
                      WHERE i.indrelid = 'audit_repos'::regclass AND i.indisunique AND NOT i.indisprimary`)
        .then(async ({ rows }) => {
          for (const r of rows) {
            const cols = (await c.query(`SELECT array_agg(a.attname ORDER BY a.attnum) AS cols FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indexrelid = $1::regclass`, [r.idx])).rows[0].cols;
            if (cols.length === 1 && cols[0] === 'name') {
              await c.query(r.conname ? `ALTER TABLE audit_repos DROP CONSTRAINT ${r.conname}` : `DROP INDEX ${r.idx}`);
            }
          }
        });
      await mkRepo(c, 'dup/name');
      await mkRepo(c, 'dup/name');
      await mkSession(c, { repoId: null, repoName: 'dup/name' });
      await refuses(c, /null repo_id unresolved=1, duplicate repo names=1/);
    });
  });

  test('a duplicate repo name that NO session carries does not stop the migration (the primary store holds three such `r` rows)', async () => {
    await inLegacyTx(async (c) => {
      const { rows } = await c.query(`SELECT i.indexrelid::regclass::text AS idx, c.conname FROM pg_index i
                       LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid
                      WHERE i.indrelid = 'audit_repos'::regclass AND i.indisunique AND NOT i.indisprimary`);
      for (const r of rows) {
        const cols = (await c.query(`SELECT array_agg(a.attname ORDER BY a.attnum) AS cols FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indexrelid = $1::regclass`, [r.idx])).rows[0].cols;
        if (cols.length === 1 && cols[0] === 'name') await c.query(r.conname ? `ALTER TABLE audit_repos DROP CONSTRAINT ${r.conname}` : `DROP INDEX ${r.idx}`);
      }
      await mkRepo(c, 'r');
      await mkRepo(c, 'r');
      const wine = await mkRepo(c, 'Lbstrydom/wine-cellar-app');
      await mkSession(c, { repoId: wine, repoName: 'Lbstrydom/wine-cellar-app' });
      await c.query(SQL); // must not raise
      assert.equal((await views(c)).den.find((r) => r.repo_id === wine).density_30d, 1);
    });
  });

  test('STOP: a dangling repo_id (FK dropped inside the transaction to build the shape)', async () => {
    await inLegacyTx(async (c) => {
      const { rows } = await c.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'persona_test_sessions'::regclass AND contype = 'f'
                                       AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'persona_test_sessions'::regclass AND attname = 'repo_id')]`);
      assert.equal(rows.length, 1, 'the repo_id FK exists');
      await c.query(`ALTER TABLE persona_test_sessions DROP CONSTRAINT ${rows[0].conname}`);
      await mkSession(c, { repoId: crypto.randomUUID(), repoName: 'x/y' });
      await refuses(c, /dangling repo_id=1/);
    });
  });
});
