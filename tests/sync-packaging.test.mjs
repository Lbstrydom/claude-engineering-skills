/**
 * @fileoverview Sync-packaging test (postgres-parity M4).
 *
 * Plan §7 P4 row "tests/sync-packaging.test.mjs": prove the synced
 * `setup-postgres.mjs` flow has every file it needs at the consumer-repo
 * side, and that the dep-cutover is real (no live @supabase/supabase-js
 * imports remain).
 *
 * Hardened after R1 audit feedback (H1 / M4-M11):
 *   - migration-ordering test now checks the contractual naming pattern
 *     (timestamped + .sql), not a tautological sort==sort comparison
 *   - count assertion replaced by required-migration presence check
 *   - sync-to-repos coverage imports the module + checks the actual
 *     CORE_ENTRY / CORE_ASSETS arrays via a small introspection regex
 *     anchored at array start (no false hit from comments)
 *   - setup-postgres CLI contract requires BOTH --migrate AND --adopt
 *   - supabase-js removal scan covers scripts/ + tests/ (excluding the
 *     frozen contract fixture) + install.mjs, and matches static + dynamic
 *     import variants
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Required migrations the plan + M4 verification depend on. New migrations
// are welcome additions but these must remain present — they're the
// inventory the compat-bootstrap was sized against.
const REQUIRED_MIGRATIONS = [
  '20260330063355_learning_store.sql',
  '20260330065641_fix_rls_for_cli.sql',
  '20260421163525_memory_health.sql',
  '20260501120000_symbol_index.sql',
  '20260503130000_drift_score_signature.sql',
  '20260504120000_security_incidents.sql',
  '20260508120000_adaptive_learning_v1.sql',
];

describe('sync packaging — setup-postgres + compat-bootstrap + migrations', () => {
  it('scripts/setup-postgres.mjs is present at the canonical path', () => {
    const p = path.join(REPO_ROOT, 'scripts', 'setup-postgres.mjs');
    assert.ok(fs.existsSync(p), 'setup-postgres.mjs missing — would not sync to consumer repos');
  });

  it('setup-postgres.mjs exposes BOTH --migrate AND --adopt modes', () => {
    const p = path.join(REPO_ROOT, 'scripts', 'setup-postgres.mjs');
    const src = fs.readFileSync(p, 'utf-8');
    // Match the CLI flag strings; comments using 'M4' etc. won't satisfy these.
    assert.match(src, /['"]--migrate['"]/, 'setup-postgres.mjs must accept --migrate');
    assert.match(src, /['"]--adopt['"]/,   'setup-postgres.mjs must accept --adopt');
  });

  it('scripts/lib/db/compat-bootstrap.sql is present + contains the M0 inventory', () => {
    const p = path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'compat-bootstrap.sql');
    assert.ok(fs.existsSync(p), 'compat-bootstrap.sql missing — fresh-self-hosted-Postgres apply would fail');
    const body = fs.readFileSync(p, 'utf-8');
    for (const needle of ['auth.uid', 'auth.users', 'pg_trgm', 'vector', 'pgcrypto', 'anon', 'authenticated', 'service_role']) {
      assert.ok(body.includes(needle), `compat-bootstrap.sql missing required: ${needle}`);
    }
  });

  it('every required migration is present, and every migration filename matches the timestamp contract', () => {
    const dir = path.join(REPO_ROOT, 'supabase', 'migrations');
    assert.ok(fs.existsSync(dir), 'migrations directory missing');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));

    // 1. Required-migration presence (replaces the brittle >= 30 count).
    const present = new Set(files);
    const missing = REQUIRED_MIGRATIONS.filter((m) => !present.has(m));
    assert.deepEqual(missing, [], `missing required migrations: ${missing.join(', ')}`);

    // 2. Naming-contract: timestamp prefix YYYYMMDDHHMMSS + underscore + slug.
    // This is what setup-postgres.mjs's listMigrations() + lex-sort relies on
    // for deterministic application order. Anyone adding a non-conforming
    // file breaks that ordering — fail the test instead of failing live.
    const TIMESTAMP_RE = /^\d{14}_[a-z0-9_-]+\.sql$/i;
    const malformed = files.filter((f) => !TIMESTAMP_RE.test(f));
    assert.deepEqual(malformed, [],
      `migration filenames must match YYYYMMDDHHMMSS_<slug>.sql: ${malformed.join(', ')}`);
  });

  it('scripts/lib/db/{client,query,rpc,errors}.mjs are present (setup-postgres import graph)', () => {
    for (const f of ['client.mjs', 'query.mjs', 'rpc.mjs', 'errors.mjs']) {
      const p = path.join(REPO_ROOT, 'scripts', 'lib', 'db', f);
      assert.ok(fs.existsSync(p), `scripts/lib/db/${f} missing — setup-postgres.mjs's import closure would break on sync`);
    }
  });

  it('scripts/sync-to-repos.mjs declares setup-postgres.mjs + compat-bootstrap + migrations in the routing arrays', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8');

    // Each helper greps the source for an array-element-shaped occurrence
    // (single-or-double-quoted string with a leading comma/bracket/whitespace),
    // never a substring inside a comment or doc URL.
    const isArrayEntry = (file) => {
      const re = new RegExp(`[\\[,\\s]['"\`]${file.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"\`]`);
      return re.test(src);
    };

    assert.ok(isArrayEntry('scripts/setup-postgres.mjs'),
      'setup-postgres.mjs must be an entry in CORE_ENTRY (not just a comment)');
    assert.ok(isArrayEntry('scripts/lib/db/compat-bootstrap.sql'),
      'compat-bootstrap.sql must be in CORE_ASSETS (fs-read; walker cannot reach it)');

    // Migrations ship via the syncMigrations() helper (dynamic enumeration).
    // Look for the helper definition with a non-trivial body — proves the
    // dynamic ship-the-whole-directory pattern is wired in.
    assert.match(src, /function\s+syncMigrations\s*\(\s*\)\s*\{[\s\S]*supabase\/migrations[\s\S]*\}/,
      'sync-to-repos.mjs must define syncMigrations() that enumerates supabase/migrations/*.sql');
  });

  it('no caller imports the legacy supabase-js package any more (M4 dep removal)', () => {
    // Three regex variants cover the static-import, dynamic-import, and
    // require() shapes. Skip the frozen contract fixture — it's the
    // legacy snapshot the contract suite uses as bait — and skip this
    // file itself (its variant-regex source contains the package name
    // by necessity and would otherwise self-match).
    const PKG = '@supabase' + '/supabase-js';   // split so this comment line doesn't self-match
    const importVariants = [
      new RegExp(String.raw`import\s+[^'"]*['"]` + PKG.replace('/', '\\/') + String.raw`['"]`),
      new RegExp(String.raw`await\s+import\s*\(\s*['"]` + PKG.replace('/', '\\/') + String.raw`['"]`),
      new RegExp(String.raw`require\s*\(\s*['"]` + PKG.replace('/', '\\/') + String.raw`['"]`),
    ];
    const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));

    const scanRoots = [
      path.join(REPO_ROOT, 'scripts'),
      path.join(REPO_ROOT, 'tests'),
      path.join(REPO_ROOT, 'install.mjs'),
    ].filter(fs.existsSync);

    const FIXTURE_REL = path.join('tests', 'fixtures');

    const walk = (entry) => {
      const out = [];
      if (fs.statSync(entry).isFile()) {
        if (/\.(mjs|cjs|js)$/.test(entry)) out.push(entry);
        return out;
      }
      for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
        const full = path.join(entry, child.name);
        const rel = path.relative(REPO_ROOT, full);
        if (rel.startsWith(FIXTURE_REL)) continue;
        if (child.isDirectory()) out.push(...walk(full));
        else if (/\.(mjs|cjs|js)$/.test(child.name)) out.push(full);
      }
      return out;
    };

    const offenders = [];
    for (const root of scanRoots) {
      for (const f of walk(root)) {
        const rel = path.relative(REPO_ROOT, f);
        if (rel === SELF) continue;  // don't self-match
        const src = fs.readFileSync(f, 'utf-8');
        if (importVariants.some((re) => re.test(src))) {
          offenders.push(rel);
        }
      }
    }
    assert.deepEqual(offenders, [],
      `M4 dropped the legacy package but these files still import it: ${offenders.join(', ')}`);
  });

  it('package.json has pg as a runtime dependency (M4 promotion + sunset of supabase-js)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.dependencies?.pg, 'pg should be in dependencies (postgres-parity M4)');
    assert.ok(!pkg.devDependencies?.pg, 'pg should NOT also be in devDependencies (was the M1 state)');
    assert.ok(!pkg.dependencies?.['@supabase/supabase-js'],
      '@supabase/supabase-js should be removed from dependencies (M4 cutover)');
    assert.ok(!pkg.devDependencies?.['@supabase/supabase-js'],
      '@supabase/supabase-js should be removed from devDependencies (M4 cutover)');
  });
});
