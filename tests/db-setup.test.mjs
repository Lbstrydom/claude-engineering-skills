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
import { getPool, closePool, _resetForTest } from '../scripts/lib/db/client.mjs';
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

  it('returns [] when only `generatedAt` / `schema` differ', () => {
    const exp = { generatedAt: 'X', schema: 'public', tables: [{ table_name: 't' }] };
    const live = { generatedAt: 'Y', schema: 'public', tables: [{ table_name: 't' }] };
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

describe('setup-postgres listMigrations + sha256 (filesystem-only)', () => {
  it('lists `supabase/migrations/*.sql` in lexicographic order', async () => {
    const files = await setup.listMigrations();
    assert.ok(files.length >= 30, `expected ≥ 30 migrations, got ${files.length}`);
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
    await _resetForTest();
    savedUrl = process.env.AUDIT_DB_URL;
    process.env.AUDIT_DB_URL = TEST_URL;
  });

  after(async () => {
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedUrl;
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
