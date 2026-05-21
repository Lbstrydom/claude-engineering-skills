/**
 * @fileoverview Sync-packaging test (postgres-parity M4).
 *
 * Plan §7 P4 row "tests/sync-packaging.test.mjs": prove the synced
 * `setup-postgres.mjs` flow has every file it needs at the consumer-repo
 * side. Without this, a consumer running `node scripts/setup-postgres.mjs
 * --migrate` would hit a "file not found" on `compat-bootstrap.sql` or a
 * migration the moment their setup script tries to apply it.
 *
 * Structural assertions only — runs in `npm test`, no DB required.
 * For end-to-end packaging verification (synced setup-postgres against an
 * ephemeral DB), wire that into the CI workflow added in M4-G.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

describe('sync packaging — setup-postgres + compat-bootstrap + migrations', () => {
  it('scripts/setup-postgres.mjs is present at the canonical path', () => {
    const p = path.join(REPO_ROOT, 'scripts', 'setup-postgres.mjs');
    assert.ok(fs.existsSync(p), 'setup-postgres.mjs missing — would not sync to consumer repos');
    const src = fs.readFileSync(p, 'utf-8');
    assert.match(src, /--migrate|--adopt/, 'setup-postgres.mjs should expose --migrate / --adopt modes');
  });

  it('scripts/lib/db/compat-bootstrap.sql is present + non-empty', () => {
    const p = path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'compat-bootstrap.sql');
    assert.ok(fs.existsSync(p), 'compat-bootstrap.sql missing — fresh-self-hosted-Postgres apply would fail');
    const body = fs.readFileSync(p, 'utf-8');
    // Mandatory components the inventory promised.
    for (const needle of ['auth.uid', 'auth.users', 'pg_trgm', 'vector', 'pgcrypto', 'anon', 'authenticated', 'service_role']) {
      assert.ok(body.includes(needle), `compat-bootstrap.sql missing required: ${needle}`);
    }
  });

  it('supabase/migrations/ has the expected file shape', () => {
    const dir = path.join(REPO_ROOT, 'supabase', 'migrations');
    assert.ok(fs.existsSync(dir), 'migrations directory missing');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
    assert.ok(files.length >= 30, `expected ≥30 migrations, found ${files.length}`);
    // Sorted lexicographically = applied in timestamp order.
    const sorted = [...files].sort();
    assert.deepEqual(files.sort(), sorted, 'migrations should sort to their natural application order');
  });

  it('scripts/sync-to-repos.mjs declares setup-postgres.mjs in CORE_ENTRY', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8');
    assert.match(src, /['"]scripts\/setup-postgres\.mjs['"]/,
      'setup-postgres.mjs must be in CORE_ENTRY so consumer repos receive it');
  });

  it('scripts/sync-to-repos.mjs declares compat-bootstrap.sql + migrations in CORE_ASSETS', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8');
    assert.match(src, /scripts\/lib\/db\/compat-bootstrap\.sql/,
      'compat-bootstrap.sql must be in CORE_ASSETS (fs-read, not importable)');
    assert.match(src, /supabase\/migrations|syncMigrations/i,
      'migrations directory must ship via CORE_ASSETS (fs-read, not importable)');
  });

  it('scripts/lib/db/{client,query,rpc,errors}.mjs are present (reachable via setup-postgres import graph)', () => {
    for (const f of ['client.mjs', 'query.mjs', 'rpc.mjs', 'errors.mjs']) {
      const p = path.join(REPO_ROOT, 'scripts', 'lib', 'db', f);
      assert.ok(fs.existsSync(p), `scripts/lib/db/${f} missing — setup-postgres.mjs's import closure would break on sync`);
    }
  });

  it('no caller imports @supabase/supabase-js any more (M4 dep removal)', () => {
    // Grep through scripts/ for actual `import` / `require` statements
    // referencing the dropped package. Comments + docstrings are OK; live
    // import statements are not.
    const scanDir = (dir) => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip the frozen legacy snapshot fixture; it's contract-test bait.
          if (full.includes(path.join('tests', 'fixtures'))) continue;
          out.push(...scanDir(full));
        } else if (entry.isFile() && /\.(mjs|js|cjs)$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    };
    const offenders = [];
    for (const f of scanDir(path.join(REPO_ROOT, 'scripts'))) {
      const src = fs.readFileSync(f, 'utf-8');
      if (/^\s*import\s+[^'"]*['"]@supabase\/supabase-js['"]/m.test(src) ||
          /^\s*const\s+[^=]*=\s*await\s+import\s*\(\s*['"]@supabase\/supabase-js['"]/m.test(src) ||
          /require\s*\(\s*['"]@supabase\/supabase-js['"]/m.test(src)) {
        offenders.push(path.relative(REPO_ROOT, f));
      }
    }
    assert.deepEqual(offenders, [],
      `M4 dropped @supabase/supabase-js but these files still import it: ${offenders.join(', ')}`);
  });

  it('package.json has pg as a runtime dependency (M4 promotion)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.dependencies?.pg, 'pg should be in dependencies (postgres-parity M4)');
    assert.ok(!pkg.devDependencies?.pg, 'pg should NOT also be in devDependencies (was the M1 state)');
    assert.ok(!pkg.dependencies?.['@supabase/supabase-js'],
      '@supabase/supabase-js should be removed (M4 cutover)');
  });
});
