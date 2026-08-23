/**
 * @fileoverview Regression for 8c95c520 — proves the `is_identity`/
 * `identity_generation` columns added to BOTH copies of the tables query
 * (generate-expected-schema.mjs's QUERIES.tables and setup-postgres.mjs's
 * hand-duplicated SHARED_CATALOG_QUERIES.tables) actually round-trip AND
 * that drift detection catches a real divergence — not just that identical
 * schemas report no difference (a vacuous pass that says nothing about
 * whether the fields are even being compared).
 *
 * ENROLMENT IS TWO EDITS (AGENTS.md): `scripts/db-test-container.mjs`
 * (`*_SUITE_FILES`) **and** `.github/workflows/postgres-parity.yml`.
 * `npm run db:enrolment:gate` fails if either is missing.
 *
 * @module tests/postgres-parity-identity-columns
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { _internals as generatorInternals } from '../scripts/postgres-parity/generate-expected-schema.mjs';
import { _internals as setupInternals } from '../scripts/setup-postgres.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

const TABLE_NAME = `identity_probe_${randomUUID().replace(/-/g, '_')}`;

describe('postgres-parity identity columns (is_identity/identity_generation)', { skip }, () => {
  let savedUrl;

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const pool = await getPool();
    assert.ok(pool, 'pool must exist');
    // `serial` is Postgres's pseudo-type for the legacy pattern: an implicit
    // sequence + a nextval() column default — NOT an identity column.
    await pool.query(`
      CREATE TABLE ${TABLE_NAME} (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        legacy_id serial
      )
    `);
  });

  after(async () => {
    try {
      const pool = await getPool();
      // IF EXISTS already absorbs the one expected failure (setup never got
      // as far as creating the table) — so unlike a bare cleanup swallow,
      // anything this still catches IS a real problem (connection lost,
      // permissions, locking) and is worth a visible line rather than total
      // silence, even though the suite itself never fails on teardown.
      if (pool) {
        await pool.query(`DROP TABLE IF EXISTS ${TABLE_NAME} CASCADE`).catch((err) => {
          process.stderr.write(`  [teardown] DROP TABLE ${TABLE_NAME} failed: ${err.message}\n`);
        });
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      await closePool();
    }
  });

  it('(a) round-trips: is_identity distinguishes GENERATED ALWAYS AS IDENTITY from a legacy nextval() default', async () => {
    const pool = await getPool();
    const res = await pool.query(generatorInternals.QUERIES.tables);
    const row = res.rows.find((r) => r.table_name === TABLE_NAME);
    assert.ok(row, `${TABLE_NAME} must appear in the tables query result`);
    const byName = Object.fromEntries(row.columns.map((c) => [c.column_name, c]));
    assert.equal(byName.id.is_identity, 'YES', 'the GENERATED ALWAYS AS IDENTITY column');
    assert.ok(byName.id.identity_generation, 'identity_generation must be set for the identity column');
    assert.equal(byName.legacy_id.is_identity, 'NO', 'the legacy nextval()-default column is NOT an identity column');
  });

  it('(a) an identity column\'s owning sequence resolves via deptype=i, not just legacy deptype=a', async () => {
    // audit R1-M17: the pre-existing sequences query's owned_by subquery only
    // checked deptype='a' (legacy serial). GENERATED ALWAYS AS IDENTITY uses
    // an INTERNAL dependency (deptype='i'), so before this fix the identity
    // column's sequence resolved owned_by to null.
    const pool = await getPool();
    const rows = (await pool.query(generatorInternals.QUERIES.sequences)).rows;
    const idSeq = rows.find((r) => r.owned_by && r.owned_by.endsWith(`.id`) && r.owned_by.includes(TABLE_NAME));
    assert.ok(idSeq, 'the identity column\'s sequence must report a non-null owned_by');
    const legacySeq = rows.find((r) => r.owned_by && r.owned_by.endsWith('.legacy_id') && r.owned_by.includes(TABLE_NAME));
    assert.ok(legacySeq, 'the legacy serial sequence must still report owned_by (deptype=a, unaffected by this fix)');
  });

  it('(a) the two hand-duplicated query copies agree on the same live schema', async () => {
    const pool = await getPool();
    const generatorRows = (await pool.query(generatorInternals.QUERIES.tables)).rows;
    const setupRows = (await pool.query(setupInternals.SHARED_CATALOG_QUERIES.tables)).rows;
    assert.deepEqual(
      setupInternals.canonicalise(generatorRows.find((r) => r.table_name === TABLE_NAME)),
      setupInternals.canonicalise(setupRows.find((r) => r.table_name === TABLE_NAME)),
      'generate-expected-schema.mjs and setup-postgres.mjs must query identity columns identically',
    );
  });

  it('(b) diffSchemas reports NO difference when expected and live come from the SAME schema (no false positive)', async () => {
    const pool = await getPool();
    const rows = (await pool.query(setupInternals.SHARED_CATALOG_QUERIES.tables)).rows;
    const diffs = setupInternals.diffSchemas({ tables: rows }, { tables: rows });
    assert.deepEqual(diffs, []);
  });

  it('(c) diffSchemas DETECTS a real identity-column divergence (no false negative — the property the fix exists for)', async () => {
    const pool = await getPool();
    const rows = (await pool.query(setupInternals.SHARED_CATALOG_QUERIES.tables)).rows;
    const probeIdx = rows.findIndex((r) => r.table_name === TABLE_NAME);
    assert.ok(probeIdx >= 0);
    // Clone with exactly ONE column's is_identity flipped — everything else identical.
    const mutated = rows.map((r, i) => {
      if (i !== probeIdx) return r;
      return {
        ...r,
        columns: r.columns.map((c) => (c.column_name === 'id' ? { ...c, is_identity: 'NO', identity_generation: null } : c)),
      };
    });
    const diffs = setupInternals.diffSchemas({ tables: rows }, { tables: mutated });
    assert.ok(diffs.length > 0, 'a real is_identity divergence must be reported, not silently ignored');
    const tablesDiff = diffs.find((d) => d.category === 'tables');
    assert.ok(tablesDiff, 'the divergence must surface under the "tables" category');
  });
});
