/**
 * Tests for `scripts/setup-postgres.mjs` (M2 deliverable).
 *
 * Pure-unit tests run unconditionally:
 *  - parseArgs flag matrix
 *  - canonicalise (deterministic deep-sort)
 *  - diffSchemas (drift detection over canonicalised catalogs)
 *  - listMigrations / sha256 (filesystem-only)
 *
 * Integration tests (env-gated on AUDIT_DB_TEST_URL, same gate as
 * tests/db-withtx.test.mjs):
 *  - fresh-apply against an empty schema
 *  - idempotent re-apply (second run skips everything)
 *  - sha256 mismatch refuses to re-apply
 *  - adopt-mode against a fully-migrated DB seeds the ledger without
 *    replay
 *  - adopt-mode aborts on schema drift
 *
 * The integration tests live in their own `describe({skip})` block so
 * the suite stays green for everyone without `AUDIT_DB_TEST_URL`.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _internals as setup } from '../scripts/setup-postgres.mjs';
import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { query } from '../scripts/lib/db/query.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Pure unit tests ────────────────────────────────────────────────────────

describe('setup-postgres parseArgs', () => {
  it('parses --migrate / --adopt as exclusive modes', () => {
    assert.equal(setup.parseArgs(['--migrate']).mode, 'migrate');
    assert.equal(setup.parseArgs(['--adopt']).mode, 'adopt');
  });

  it('parses --dry-run / --preflight-only / --bootstrap-only flags', () => {
    const a = setup.parseArgs(['--migrate', '--dry-run']);
    assert.equal(a.dryRun, true);
    const b = setup.parseArgs(['--preflight-only']);
    assert.equal(b.preflightOnly, true);
    const c = setup.parseArgs(['--bootstrap-only']);
    assert.equal(c.bootstrapOnly, true);
  });
});

describe('setup-postgres canonicalise', () => {
  const { canonicalise } = setup;

  it('sorts object keys deeply', () => {
    const out = canonicalise({ b: 1, a: { z: 2, y: 3 } });
    assert.deepEqual(Object.keys(out), ['a', 'b']);
    assert.deepEqual(Object.keys(out.a), ['y', 'z']);
  });

  it('sorts arrays by stringified value (stable across input order)', () => {
    const a = canonicalise([{ x: 2 }, { x: 1 }]);
    const b = canonicalise([{ x: 1 }, { x: 2 }]);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('preserves null and primitives', () => {
    assert.equal(canonicalise(null), null);
    assert.equal(canonicalise(0), 0);
    assert.equal(canonicalise('s'), 's');
  });
});

describe('setup-postgres diffSchemas', () => {
  const { diffSchemas } = setup;

  it('returns [] when expected and live match exactly', () => {
    const exp = { tables: [{ table_name: 't', columns: [{ column_name: 'a' }] }] };
    const live = { tables: [{ table_name: 't', columns: [{ column_name: 'a' }] }] };
    assert.deepEqual(diffSchemas(exp, live), []);
  });

  it('returns [] when only `schema` differs (always \'public\' by contract)', () => {
    const exp = { schema: 'public', tables: [{ table_name: 't' }] };
    const live = { schema: 'live-value-ignored', tables: [{ table_name: 't' }] };
    assert.deepEqual(diffSchemas(exp, live), []);
  });

  it('detects missing rows in live', () => {
    const exp = { tables: [{ table_name: 'a' }, { table_name: 'b' }] };
    const live = { tables: [{ table_name: 'a' }] };
    const d = diffSchemas(exp, live);
    assert.equal(d.length, 1);
    assert.equal(d[0].category, 'tables');
    assert.equal(d[0].missingTotal, 1);
    assert.equal(d[0].extraTotal, 0);
  });

  it('detects extra rows in live', () => {
    const exp = { tables: [{ table_name: 'a' }] };
    const live = { tables: [{ table_name: 'a' }, { table_name: 'extra' }] };
    const d = diffSchemas(exp, live);
    assert.equal(d.length, 1);
    assert.equal(d[0].missingTotal, 0);
    assert.equal(d[0].extraTotal, 1);
  });

  it('reports both missing and extra in one category', () => {
    const exp = { tables: [{ table_name: 'a' }, { table_name: 'b' }] };
    const live = { tables: [{ table_name: 'a' }, { table_name: 'c' }] };
    const d = diffSchemas(exp, live);
    assert.equal(d[0].missingTotal, 1);
    assert.equal(d[0].extraTotal, 1);
  });
});

describe('setup-postgres diffSchemas — physical column layout vs schema semantics', () => {
  const { diffSchemas, denseRankColumnPositions } = setup;

  // Upstream report 8174dc51 (wine-cellar-app, 2026-09-05). `ordinal_position`
  // in `information_schema.columns` IS pg `attnum`: dropping a column leaves a
  // permanent hole in the numbering of the columns that outlive it. So a DB
  // built by REPLAYING the migration sequence and a DB built from final-state
  // DDL (a dump restore, a snapshot bootstrap) carry different attnums for
  // byte-identical schemas — and adopt-mode, whose whole purpose is to enrol a
  // pre-existing, differently-provisioned DB, aborted on exactly that.
  //
  // Measured 2026-09-05 against store d5a9d07b91225a93 (db=audit_loop, shared
  // by this repo, wine-cellar-app and ai-organiser):
  //   fixture `refresh_runs` ordinals  1-5, 12-21  (the faithful replay: the
  //     six columns 20260721150000 drops left an INTERIOR gap at 6-11)
  //   live    `refresh_runs` ordinals  1..15 contiguous, zero attisdropped
  //   every other field — column_name, data_type, is_nullable, column_default,
  //   is_identity, identity_generation — identical, in identical order.
  //
  // The fixture is CORRECT; the comparator was asserting column *history*,
  // which is not schema.
  const committedFixture = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'expected-schema.json'), 'utf-8')
  );

  /** Re-number a catalog's ordinals densely, preserving relative column order. */
  const asFinalStateDdl = (tables) => tables.map((t) => ({
    ...t,
    columns: t.columns.map((c, i) => ({ ...c, ordinal_position: i + 1 })),
  }));

  it('the committed fixture really does carry a gapped table (vacuous-pass guard)', () => {
    // Without a gap somewhere `asFinalStateDdl` is the identity function and
    // every assertion below passes having tested nothing. If a future
    // migration recreates `refresh_runs` contiguously this fails loudly —
    // re-point the guard at whichever table is gapped then, don't delete it.
    const gapped = committedFixture.tables.filter(
      (t) => t.columns.some((c, i) => c.ordinal_position !== i + 1)
    );
    assert.ok(
      gapped.length > 0,
      'expected-schema.json has no table with a non-contiguous ordinal sequence — '
      + 'this suite can no longer distinguish a replayed store from a final-state-DDL one'
    );
  });

  it('a semantically-identical store with renumbered attnums does NOT read as drift', () => {
    const expected = { schema: 'public', tables: committedFixture.tables };
    const live = { schema: 'public', tables: asFinalStateDdl(committedFixture.tables) };
    assert.deepEqual(diffSchemas(expected, live), []);
  });

  it('the report evidence exactly: fixture refresh_runs vs the store measured 2026-09-05', () => {
    const fixtureRow = committedFixture.tables.find((t) => t.table_name === 'refresh_runs');
    assert.ok(fixtureRow, 'refresh_runs missing from the committed fixture');
    assert.deepEqual(
      fixtureRow.columns.map((c) => c.ordinal_position),
      [1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
      'fixture refresh_runs ordinals changed — re-measure the store before editing this test'
    );
    const liveRow = {
      ...fixtureRow,
      columns: fixtureRow.columns.map((c, i) => ({ ...c, ordinal_position: i + 1 })),
    };
    assert.deepEqual(diffSchemas({ tables: [fixtureRow] }, { tables: [liveRow] }), []);
  });

  // ── The directions the gate must STILL fire in ──────────────────────────
  // Dropping the field altogether (the report's option 1) would have passed
  // the three assertions above and silently retired column-order checking:
  // `canonicalise` SORTS arrays, so array position carries no order
  // information after canonicalisation, and `ordinal_position` is the only
  // ordering assertion the comparator has.

  it('still reports drift when relative column ORDER differs', () => {
    const cols = (names) => names.map((n, i) => ({
      column_name: n, data_type: 'text', is_nullable: 'YES', column_default: null,
      is_identity: 'NO', identity_generation: null, ordinal_position: i + 1,
    }));
    const expected = { tables: [{ table_name: 't', columns: cols(['a', 'b', 'c']) }] };
    const live = { tables: [{ table_name: 't', columns: cols(['a', 'c', 'b']) }] };
    const d = diffSchemas(expected, live);
    assert.equal(d.length, 1, 'a reordered column set must still read as drift');
    assert.equal(d[0].category, 'tables');
  });

  it('still reports drift on a real column difference that happens to be renumbered', () => {
    const fixtureRow = committedFixture.tables.find((t) => t.table_name === 'refresh_runs');
    const mutated = {
      ...fixtureRow,
      columns: fixtureRow.columns.map((c, i) => ({
        ...c,
        ordinal_position: i + 1,
        data_type: c.column_name === 'ownership_rule_epoch' ? 'integer' : c.data_type,
      })),
    };
    assert.equal(diffSchemas({ tables: [fixtureRow] }, { tables: [mutated] }).length, 1,
      'a data_type change must not be normalised away');
  });

  it('still reports drift when live is missing a column, renumbering notwithstanding', () => {
    const fixtureRow = committedFixture.tables.find((t) => t.table_name === 'refresh_runs');
    const short = {
      ...fixtureRow,
      columns: fixtureRow.columns.slice(0, -1).map((c, i) => ({ ...c, ordinal_position: i + 1 })),
    };
    assert.equal(diffSchemas({ tables: [fixtureRow] }, { tables: [short] }).length, 1);
  });

  describe('denseRankColumnPositions', () => {
    it('collapses gaps to 1..N in ascending ordinal order and drops the raw attnum', () => {
      const out = denseRankColumnPositions({
        tables: [{
          table_name: 't',
          columns: [
            { column_name: 'a', ordinal_position: 1 },
            { column_name: 'b', ordinal_position: 12 },
            { column_name: 'c', ordinal_position: 21 },
          ],
        }],
      });
      assert.deepEqual(
        out.tables[0].columns,
        [
          { column_name: 'a', column_position: 1 },
          { column_name: 'b', column_position: 2 },
          { column_name: 'c', column_position: 3 },
        ],
        'the normalised value is a rank, not an attnum — it must not keep attnum’s name'
      );
    });

    it('ranks by ordinal_position, not by array order', () => {
      // json_agg(… ORDER BY ordinal_position) already orders the array, but the
      // rank must not depend on every caller having preserved that.
      const out = denseRankColumnPositions({
        tables: [{
          table_name: 't',
          columns: [
            { column_name: 'late', ordinal_position: 21 },
            { column_name: 'early', ordinal_position: 1 },
          ],
        }],
      });
      // The RANK is the contract, not the array's own order — `canonicalise`
      // re-sorts the array before comparison, so position in it says nothing.
      assert.deepEqual(
        Object.fromEntries(out.tables[0].columns.map((c) => [c.column_name, c.column_position])),
        { early: 1, late: 2 }
      );
    });

    it('leaves non-table categories untouched', () => {
      const cat = { functions: [{ function_name: 'f', args: '' }], views: [{ view_name: 'v' }] };
      assert.deepEqual(denseRankColumnPositions(cat), cat);
    });

    it('tolerates a tables row with no columns array', () => {
      const cat = { tables: [{ table_name: 't' }] };
      assert.deepEqual(denseRankColumnPositions(cat), cat);
    });
  });
});

describe('setup-postgres listMigrations + sha256 (filesystem-only)', () => {
  it('lists `supabase/migrations/*.sql` in lexicographic order', async () => {
    // Gemini-G1 (M3+M4 audit): no hardcoded count. The relevant invariants
    // are non-empty + already-sorted + .sql-only. Migration count grows
    // over time and pinning it here just creates churn.
    const files = await setup.listMigrations();
    assert.ok(files.length > 0, 'listMigrations should return at least one migration');
    const sorted = [...files].sort();
    assert.deepEqual(files, sorted, 'listMigrations result must be lexicographically sorted');
    for (const f of files) {
      assert.match(f, /\.sql$/, `entry "${f}" is not a .sql file`);
    }
  });

  it('sha256 is deterministic for the same file', async () => {
    const files = await setup.listMigrations();
    const sample = path.join(REPO_ROOT, 'supabase', 'migrations', files[0]);
    const a = await setup.sha256(sample);
    const b = await setup.sha256(sample);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});

describe('setup-postgres compat-bootstrap.sql is present + non-empty', () => {
  it('exists at the expected path', () => {
    const p = path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'compat-bootstrap.sql');
    assert.ok(fs.existsSync(p), `compat-bootstrap.sql missing at ${p}`);
    const body = fs.readFileSync(p, 'utf-8');
    // Mandatory references (the inventory) — guards against accidental
    // deletion / corruption of the bootstrap surface.
    for (const needle of ['CREATE SCHEMA IF NOT EXISTS auth', 'auth.users', 'auth.uid', 'pg_trgm', 'vector', 'pgcrypto', 'anon', 'authenticated', 'service_role']) {
      assert.ok(body.includes(needle), `compat-bootstrap.sql missing required reference: ${needle}`);
    }
  });

  it('never uses CREATE OR REPLACE for auth.uid() (plan R16)', () => {
    const p = path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'compat-bootstrap.sql');
    const body = fs.readFileSync(p, 'utf-8');
    // The bootstrap must not clobber a managed `auth.uid()` body. CREATE
    // FUNCTION (never CREATE OR REPLACE FUNCTION) is gated behind an
    // existence check.
    assert.doesNotMatch(
      body,
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+auth\.uid/i,
      'compat-bootstrap.sql uses CREATE OR REPLACE for auth.uid() — would clobber a managed body'
    );
  });
});

// ── Integration tests (env-gated) ──────────────────────────────────────────

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

// We never run the integration tests against the maintainer's prod DB.
// AUDIT_DB_TEST_URL must be a disposable Postgres + pgvector instance.

let savedUrl;

describe('setup-postgres integration (env-gated)', { skip }, () => {
  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    // Fail-closed BEFORE any pool reset / connection — 2026-07-14 incident
    // guard (see assertDisposableDbUrl's own doc comment for the full story).
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
  });

  after(async () => {
    // Env restoration before closePool() (Gemini final-review G2, cross-
    // applied from tests/symbol-index-drift-justification.test.mjs's round-2
    // fix) — closePool() doesn't read AUDIT_DB_URL, so this removes any
    // dependency on it succeeding before the process env is put back.
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedUrl;
    try { await closePool(); } catch { /* best-effort — env is already restored */ }
  });

  beforeEach(async () => {
    // Reset the database between tests. This is destructive; require the
    // test URL to be obviously disposable (we expect the maintainer to
    // point AUDIT_DB_TEST_URL at a throwaway container).
    const pool = await getPool();
    // Drop public schema cascade then recreate. This is sweepingly
    // destructive — acceptable only because we just asserted the env-gate
    // and the maintainer chose this URL deliberately.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('GRANT ALL ON SCHEMA public TO current_user');
  });

  it('preflight reports CREATEROLE + extension state without throwing', async () => {
    const pool = await getPool();
    const pre = await setup.preflight(pool);
    assert.equal(typeof pre.canCreateRole, 'boolean');
    for (const ext of ['pgcrypto', 'pg_trgm', 'vector']) {
      assert.ok(
        ['present', 'available', 'missing'].includes(pre.extensions[ext]),
        `unexpected state for ${ext}: ${pre.extensions[ext]}`
      );
    }
  });

  it('ensureLedger is idempotent', async () => {
    const pool = await getPool();
    await setup.ensureLedger(pool);
    await setup.ensureLedger(pool);  // second call must not throw
    const ledger = await setup.readLedger(pool);
    assert.ok(ledger instanceof Map);
    assert.equal(ledger.size, 0);
  });

  it('recordApplied is idempotent + reads back', async () => {
    const pool = await getPool();
    await setup.ensureLedger(pool);
    await setup.recordApplied(pool, 'fake-migration.sql', 'a'.repeat(64));
    await setup.recordApplied(pool, 'fake-migration.sql', 'a'.repeat(64));  // re-record same hash
    const ledger = await setup.readLedger(pool);
    assert.equal(ledger.size, 1);
    assert.equal(ledger.get('fake-migration.sql'), 'a'.repeat(64));
  });

  it('diffSchemas matches itself when capturing twice without changes', async () => {
    const pool = await getPool();
    // Capture a snapshot of the (empty-ish) public schema twice.
    const captureLive = async () => {
      const out = { schema: 'public' };
      for (const [k, sql] of Object.entries(setup.SHARED_CATALOG_QUERIES)) {
        out[k] = (await pool.query(sql)).rows;
      }
      return out;
    };
    const a = await captureLive();
    const b = await captureLive();
    assert.deepEqual(setup.diffSchemas(a, b), []);
  });

  it('detects when live has a table the manifest does not', async () => {
    const pool = await getPool();
    const baseline = async () => {
      const out = { schema: 'public' };
      for (const [k, sql] of Object.entries(setup.SHARED_CATALOG_QUERIES)) {
        out[k] = (await pool.query(sql)).rows;
      }
      return out;
    };
    const expected = await baseline();
    await pool.query('CREATE TABLE drift_test (id int PRIMARY KEY)');
    const live = await baseline();
    const d = setup.diffSchemas(expected, live);
    assert.ok(d.length >= 1, 'expected drift detection to fire');
    const tablesDiff = d.find((x) => x.category === 'tables');
    assert.ok(tablesDiff, 'tables category must appear in the diff');
    assert.ok(tablesDiff.extraTotal >= 1, 'drift_test should show as extra in live');
  });
});
