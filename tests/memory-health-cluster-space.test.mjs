/**
 * @fileoverview `memory_health_semantic_cluster` — vector-space scoping
 * (migration 20260830150000). LIVE Postgres, because the thing under test is a
 * plpgsql function and a regex over the migration file proves only that a
 * string is present.
 *
 * Promoted from a one-off probe run while closing the last unscoped reader of
 * `finding_embeddings` (AGENTS.md testing doctrine — "promote a one-off check
 * that mattered"). It mattered: the sibling assertions in
 * `tests/embed-provenance.test.mjs` are source-level, so without this the RPC's
 * actual behaviour was unverified in every environment.
 *
 * Two directions, because a scoping predicate that fires on EVERYTHING is
 * indistinguishable from one that works, and both report "0 pairs":
 *   - SAME space  → the pair IS counted (positive control; without it, a
 *                   predicate that accidentally excludes every row passes).
 *   - CROSS space → the pair is NOT counted (the defect).
 *
 * Requires `AUDIT_DB_TEST_URL`; skips without one. Enrolled in
 * `db-test-container.mjs` SCHEMA_INTACT_SUITE_FILES *and*
 * `.github/workflows/postgres-parity.yml` — a DB suite no runner names has
 * never run, and node reports a suite that never ran as a clean pass.
 *
 * NOT destructive to the schema, but it DOES truncate the audit tables, so it
 * needs the disposable-DSN guard the same way the other data-writing suites do.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';

const DSN = process.env.AUDIT_DB_TEST_URL;

describe('memory_health_semantic_cluster — pairs are scoped to ONE vector space', { skip: !DSN ? 'AUDIT_DB_TEST_URL not set' : false }, () => {
  let pool;

  before(async () => {
    // Fail closed on a non-disposable DSN: this suite TRUNCATEs the audit
    // tables. Same guard the destructive suites use (INC-002, 2026-07-14).
    assertDisposableDbUrl(DSN);
    pool = new pg.Pool({ connectionString: DSN });
  });
  after(async () => { await pool?.end(); });

  /** A 768-dim vector; `jitter` makes a near-identical sibling (cosine ~1.0). */
  const vec = (jitter) => {
    const a = new Array(768).fill(0);
    a[0] = 1; a[1] = 0.05 + jitter;
    return `[${a.join(',')}]`;
  };

  /**
   * Two OPEN findings: same file, different runs, different fingerprints,
   * near-identical vectors — i.e. the exact same-file cross-run re-raise shape
   * the metric counts. The ONLY variable between the two cases is the space.
   */
  async function seed({ modelA, modelB }) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('TRUNCATE finding_embeddings, finding_adjudication_events, audit_findings, audit_runs, audit_repos CASCADE');
      const repo = (await c.query(
        `INSERT INTO audit_repos (name) VALUES ('probe/repo') RETURNING id`)).rows[0].id;
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const run = (await c.query(
          `INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1,'probe/plan.md','code') RETURNING id`,
          [repo])).rows[0].id;
        const f = (await c.query(
          `INSERT INTO audit_findings (run_id, finding_fingerprint, primary_file, detail_snapshot,
                                       severity, category, pass_name, round_raised, created_at)
           VALUES ($1,$2,'src/same-file.mjs',$3,'HIGH','probe','merged',1, now()) RETURNING id`,
          [run, `fp-${i}`, `a distinct detail snapshot number ${i} long enough to pass the 30 char floor`])).rows[0].id;
        ids.push(f);
      }
      await c.query(
        `INSERT INTO finding_embeddings (finding_id, embedding, embedding_model, dimension, snapshot_hash)
         VALUES ($1,$2::vector,$3,768,'h0'), ($4,$5::vector,$6,768,'h1')`,
        [ids[0], vec(0), modelA, ids[1], vec(0.0001), modelB]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  const call = async () => (await pool.query(
    'SELECT memory_health_semantic_cluster(30, 0.85, 200) AS r')).rows[0].r;

  const GEMINI = 'gemini-embedding-001';
  const AZURE = 'https://x.openai.azure.com::text-embedding-3-large';

  it('POSITIVE CONTROL — two near-identical vectors in the SAME space DO pair', async () => {
    // Without this direction, a predicate that excluded every row would look
    // identical to a working one: both report 0 pairs.
    await seed({ modelA: GEMINI, modelB: GEMINI });
    const r = await call();
    const repo = r.per_repo[0];
    assert.equal(Number(repo.similar_pairs), 1, 'a genuine same-space re-raise must still be counted');
    assert.equal(Number(repo.embedding_spaces), 1);
    assert.equal(Number(repo.comparable_findings), 2);
    assert.equal(Number(r.coverage.pct), 100);
  });

  it('the SAME pair across TWO spaces is NOT counted', async () => {
    // Identical vectors, identical file, identical runs — only the recorded
    // vector space differs. A cosine across two embedding models is not a
    // similarity, and counting it inflates the churn metric with noise.
    await seed({ modelA: GEMINI, modelB: AZURE });
    const r = await call();
    assert.equal(Number(r.per_repo[0].similar_pairs), 0);
    assert.equal(Number(r.median_similar_pairs), 0);
  });

  it('COVERAGE follows, so the scoped pair count cannot read as a confident clean', async () => {
    // The half that is easy to miss. Having excluded the cross-space pair, the
    // metric now reports 0 pairs — and if coverage still said "100% embedded",
    // that 0 would read as an authoritative GREEN over a population where half
    // the rows can never be compared to the other half. Coverage is therefore
    // comparable/open, not embedded/open, and the existing `clusterMinCoverage`
    // floor in memory-health.mjs degrades a split store to `unknown`.
    await seed({ modelA: GEMINI, modelB: AZURE });
    const r = await call();
    const repo = r.per_repo[0];
    assert.equal(Number(repo.embedded_findings), 2, 'both rows ARE embedded');
    assert.equal(Number(repo.comparable_findings), 1, 'but only the largest space can be compared');
    assert.equal(Number(repo.embedding_spaces), 2, 'and the breakdown says WHY');
    assert.equal(Number(repo.coverage_pct), 50, 'coverage must divide by comparable, not embedded');
    assert.equal(Number(r.coverage.comparable), 1);
    assert.equal(Number(r.coverage.embedded), 2, 'the embedded count keeps its old meaning');
    assert.equal(Number(r.coverage.pct), 50);
  });

  it('CREATE OR REPLACE kept the search_path pin AND the ACL', async () => {
    // Postgres resets the whole proconfig array and the ACL on replacement, so
    // a migration that forgets to re-state them silently drops a security
    // property. Asserted against pg_proc, never against the migration text.
    const { rows } = await pool.query(
      `SELECT proconfig, proacl::text AS acl FROM pg_proc WHERE proname = 'memory_health_semantic_cluster'`);
    assert.ok(rows[0].proconfig.includes('search_path=pg_catalog, public'), 'search_path pin must survive');
    assert.ok(rows[0].proconfig.some((c) => c.startsWith('statement_timeout=')), 'statement_timeout must survive');
    for (const role of ['anon', 'authenticated']) {
      assert.match(rows[0].acl, new RegExp(`${role}=X/`), `${role} EXECUTE grant must be re-stated`);
    }
  });
});
