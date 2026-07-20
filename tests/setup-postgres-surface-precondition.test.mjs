/**
 * WS: migration ↔ compat-bootstrap coupling — the surface precondition.
 *
 * 35 of 74 migrations reference the Supabase auth surface (14 `TO anon`, 11
 * `auth.uid()`, 10 `auth.users`) and nothing verified it existed.
 * `setup-postgres --migrate` happened to satisfy it by running the bootstrap
 * first; any other route to the same files fails LATE and PARTIALLY, leaving a
 * ledger that disagrees with the schema.
 *
 * The fix asserts the SURFACE, not its provenance: it passes on managed Supabase
 * (platform-provided) and on a bootstrapped self-hosted DB alike, and fails
 * before migration 1 anywhere else. It does NOT claim to guard routes that bypass
 * the script — a preflight cannot, and the plan says so rather than implying it.
 *
 * Pure tests run unconditionally; the live checks are env-gated on
 * AUDIT_DB_TEST_URL (the DISPOSABLE container, never AUDIT_DB_URL).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRequiredSurface, findMissingSurface } from '../scripts/setup-postgres.mjs';
import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'compat-bootstrap.sql');
const MIGRATIONS = path.join(REPO_ROOT, 'supabase', 'migrations');

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

describe('parseRequiredSurface — derived from the bootstrap', () => {
  const required = parseRequiredSurface(fs.readFileSync(BOOTSTRAP, 'utf-8'));

  it('extracts exactly the documented inventory', () => {
    assert.deepEqual(required.schemas, ['auth']);
    assert.deepEqual(required.roles.sort(), ['anon', 'authenticated', 'service_role']);
    assert.deepEqual(required.extensions.sort(), ['pg_trgm', 'pgcrypto', 'vector']);
    assert.deepEqual(required.functions, ['auth.uid']);
    assert.deepEqual(required.tables, ['auth.users']);
  });

  it('strips comments before parsing — the file documents what it runs', () => {
    // Without comment-stripping the bootstrap's own prose ("stub roles: `anon`,
    // `authenticated`…") would invent preconditions from documentation.
    const withCommentNoise = '-- CREATE ROLE ghost_role_from_a_comment;\nCREATE ROLE real_role;\n';
    assert.deepEqual(parseRequiredSurface(withCommentNoise).roles, ['real_role']);
  });

  it('is empty-safe', () => {
    const empty = parseRequiredSurface('');
    assert.deepEqual(empty.roles, []);
    assert.deepEqual(empty.schemas, []);
  });
});

describe('WHY the list is not derived from the migrations (measured, 2026-07-19)', () => {
  // This is the alternative the plan originally proposed. Encoded as a test so
  // the rejection stays evidence-backed rather than becoming folklore — and so a
  // future contributor who tries it sees the number before spending an afternoon.
  const sqlFiles = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
  const corpus = sqlFiles.map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf-8')).join('\n');

  it('scanning migrations for `TO <role>` is wildly over-inclusive', () => {
    const scanned = new Set([...corpus.matchAll(/\bTO\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase()));
    const realRoles = ['anon', 'authenticated', 'service_role'];

    // It matches ordinary English out of SQL comment prose — "TO the", "TO avoid".
    assert.ok(scanned.size > 20,
      `expected the naive scan to be noisy; it found ${scanned.size} candidate "roles"`);
    for (const noise of ['the', 'avoid', 'make']) {
      assert.ok(scanned.has(noise),
        `"${noise}" should be matched by the naive scan — that is the point of this test`);
    }
    for (const r of realRoles) assert.ok(scanned.has(r), `real role ${r} is in there too, buried`);
  });

  it('...and simultaneously MISSES an extension the bootstrap provides', () => {
    const scannedExts = new Set(
      [...corpus.matchAll(/CREATE EXTENSION(?: IF NOT EXISTS)?\s+"?([a-z_]+)/gi)].map((m) => m[1].toLowerCase()),
    );
    assert.ok(!scannedExts.has('pgcrypto'),
      'no migration declares pgcrypto — the bootstrap creates it, so a migration-derived '
      + 'precondition would silently omit it');
    const fromBootstrap = parseRequiredSurface(fs.readFileSync(BOOTSTRAP, 'utf-8')).extensions;
    assert.ok(fromBootstrap.includes('pgcrypto'), 'the bootstrap-derived list has it');
  });
});

describe('findMissingSurface — against the disposable container', { skip }, () => {
  let pool;

  before(async () => {
    assertDisposableDbUrl(TEST_URL);      // fail-closed: never a production DSN
    _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    if (/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(TEST_URL)) process.env.AUDIT_DB_SSL_MODE = 'disable';
    pool = await getPool();
  });

  after(async () => { await closePool(); _resetForTest(); });

  it('reports nothing missing on a bootstrapped database', async () => {
    const required = parseRequiredSurface(fs.readFileSync(BOOTSTRAP, 'utf-8'));
    assert.deepEqual(await findMissingSurface(pool, required), [],
      'the container is bootstrapped, so every object must resolve');
  });

  it('names each missing object rather than failing generically', async () => {
    // A precondition that says only "something is wrong" sends the operator
    // hunting; the whole value here is converting a late partial failure into an
    // immediate, named one.
    const missing = await findMissingSurface(pool, {
      schemas: ['definitely_absent_schema'],
      roles: ['definitely_absent_role'],
      extensions: ['definitely_absent_ext'],
      functions: ['auth.definitely_absent_fn'],
      tables: ['auth.definitely_absent_table'],
    });
    assert.equal(missing.length, 5);
    assert.ok(missing.some((m) => m.includes('schema "definitely_absent_schema"')));
    assert.ok(missing.some((m) => m.includes('role "definitely_absent_role"')));
    assert.ok(missing.some((m) => m.includes('extension "definitely_absent_ext"')));
    assert.ok(missing.some((m) => m.includes('function "auth.definitely_absent_fn()"')));
    assert.ok(missing.some((m) => m.includes('table "auth.definitely_absent_table"')));
  });

  it('checks the surface, not who provided it', async () => {
    // `public` exists on every Postgres without any bootstrap — the check must
    // pass on it, which is what makes managed Supabase work unchanged.
    assert.deepEqual(
      await findMissingSurface(pool, { schemas: ['public'], roles: [], extensions: [], functions: [], tables: [] }),
      [],
    );
  });
});
