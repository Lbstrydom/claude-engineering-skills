// Contract guard for the shared-env reader-fix (plan: shared-env-loading-root-fix).
//
// The bug class: CLIs that read process.env.AUDIT_DB_URL but only load the cwd
// .env (never the shared ~/.audit-loop.env) run cloud-blind. The fix routes the
// shared-layer load through the single DSN reader, db/client.mjs::resolveDbUrl(),
// via loadSharedEnv({ includeCwd: false }) — the cwd .env is the entrypoint's
// job (every real CLI imports lib/load-env.mjs), so the
// reader only needs to add the shared layer. These tests lock that contract
// WHERE IT SHIPS (consumer repos have no CI), plus a structural assertion that
// the reader doesn't regress back to config.mjs's incidental import side-effect.
//
// Hermetic by construction: each behavioural case spawns a child node process
// with cwd = a temp dir (no .env), HOME/USERPROFILE = a temp home (the only
// place a shared file can live), and every DB/shared env var stripped unless
// the case sets it. The child only calls the pure resolver (never opens a
// socket), so this runs in the normal suite without AUDIT_DB_URL.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLIENT_ABS = path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'client.mjs');
const LOADER_ABS = path.join(REPO_ROOT, 'scripts', 'lib', 'load-shared-env.mjs');
const CLIENT_URL = pathToFileURL(CLIENT_ABS).href;
const LOADER_URL = pathToFileURL(LOADER_ABS).href;

const DB_ENV_KEYS = [
  'AUDIT_DB_URL', 'AUDIT_POSTGRES_URL',
  'AUDIT_DB_SSL_MODE', 'AUDIT_POSTGRES_SSL_MODE',
  'AUDIT_DB_POOL_MAX', 'AUDIT_STORE',
  'AUDIT_LOOP_DISABLE_SHARED', 'DOTENV_CONFIG_PATH',
  'SUPABASE_AUDIT_URL', 'SUPABASE_AUDIT_ANON_KEY', 'SUPABASE_AUDIT_SERVICE_ROLE_KEY',
  '_AUDIT_LOOP_SHARED_LOADED',
];

let _tmpSeq = 0;
const _createdDirs = [];
function freshTmp(label) {
  const dir = path.join(os.tmpdir(), `sev-${process.pid}-${_tmpSeq++}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  _createdDirs.push(dir);
  return dir;
}

// Clean up every temp dir this file created (mirrors the try/finally cleanup
// the migration tests use — don't litter os.tmpdir() across runs).
after(() => {
  for (const dir of _createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

// Build a hermetic child env: real env (so node can launch) minus every
// DB/shared key, with HOME/USERPROFILE pinned to a temp home + case overrides.
function hermeticEnv(home, extraEnv = {}) {
  const env = { ...process.env };
  for (const k of DB_ENV_KEYS) delete env[k];
  env.HOME = home;
  env.USERPROFILE = home;
  return Object.assign(env, extraEnv);
}

function runChild(scriptBody, { home, cwd, extraEnv = {} }) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', scriptBody], {
    cwd, env: hermeticEnv(home, extraEnv), encoding: 'utf8',
  });
  assert.equal(r.status, 0, `child exited ${r.status}; stderr: ${(r.stderr || '').slice(0, 400)}`);
  try { return JSON.parse(r.stdout); }
  catch { throw new Error(`child stdout not JSON: ${JSON.stringify((r.stdout || '').slice(0, 200))}`); }
}

/**
 * Run resolveDbUrl() (the reader, includeCwd:false) in a hermetic child.
 * `sharedContent` → <home>/.audit-loop.env. `extraEnv` is the "higher layer"
 * (shell/entrypoint already in process.env). Returns { dsn, ssl }.
 */
function resolveInChild({ sharedContent = null, extraEnv = {} } = {}) {
  const home = freshTmp('home');
  const cwd = freshTmp('cwd');
  if (sharedContent != null) fs.writeFileSync(path.join(home, '.audit-loop.env'), sharedContent);
  const script =
    `import { resolveDbUrl } from ${JSON.stringify(CLIENT_URL)};` +
    `const dsn = resolveDbUrl() ?? null;` +
    `process.stdout.write(JSON.stringify({ dsn, ssl: process.env.AUDIT_DB_SSL_MODE ?? null }));`;
  return runChild(script, { home, cwd, extraEnv });
}

describe('shared-env reader-fix — resolveDbUrl loads the shared layer (hermetic)', () => {
  it('1. shared file ONLY → resolveDbUrl returns the shared DSN (the core guard)', () => {
    assert.equal(resolveInChild({ sharedContent: 'AUDIT_DB_URL=postgres://shared-only/db\n' }).dsn,
      'postgres://shared-only/db');
  });

  it('2. no shared file + no DSN → null (cloud-off preserved)', () => {
    assert.equal(resolveInChild({}).dsn, null);
  });

  it('3. AUDIT_LOOP_DISABLE_SHARED=1 + shared file present → null (escape hatch)', () => {
    assert.equal(resolveInChild({
      sharedContent: 'AUDIT_DB_URL=postgres://shared/db\n',
      extraEnv: { AUDIT_LOOP_DISABLE_SHARED: '1' },
    }).dsn, null);
  });

  it('4. higher-layer DSN + shared DSN → higher wins (override:false)', () => {
    assert.equal(resolveInChild({
      sharedContent: 'AUDIT_DB_URL=postgres://shared/db\n',
      extraEnv: { AUDIT_DB_URL: 'postgres://higher/db' },
    }).dsn, 'postgres://higher/db');
  });

  it('5. higher-layer alias AUDIT_POSTGRES_URL + shared canonical AUDIT_DB_URL → alias wins (cross-key, R1-H1)', () => {
    assert.equal(resolveInChild({
      sharedContent: 'AUDIT_DB_URL=postgres://shared-cloud/db\n',
      extraEnv: { AUDIT_POSTGRES_URL: 'postgres://higher-local/db' },
    }).dsn, 'postgres://higher-local/db');
  });

  it('6. higher-layer DSN + shared SSL mode → shared SSL NOT applied (DB-group guard, R2-H1)', () => {
    const out = resolveInChild({
      sharedContent: 'AUDIT_DB_SSL_MODE=require\n',
      extraEnv: { AUDIT_DB_URL: 'postgres://higher/db' },
    });
    assert.equal(out.dsn, 'postgres://higher/db');
    assert.equal(out.ssl, null, 'shared SSL must not attach to a higher-layer DSN');
  });

  it('7. no higher DSN + shared DSN + shared SSL → both apply together (same layer)', () => {
    const out = resolveInChild({ sharedContent: 'AUDIT_DB_URL=postgres://shared/db\nAUDIT_DB_SSL_MODE=no-verify\n' });
    assert.equal(out.dsn, 'postgres://shared/db');
    assert.equal(out.ssl, 'no-verify');
  });

  it('8. unreadable shared file (a directory at the path) → no throw, returns null', () => {
    const home = freshTmp('home-eisdir');
    const cwd = freshTmp('cwd-eisdir');
    fs.mkdirSync(path.join(home, '.audit-loop.env'));
    const script =
      `import { resolveDbUrl } from ${JSON.stringify(CLIENT_URL)};` +
      `process.stdout.write(JSON.stringify({ dsn: resolveDbUrl() ?? null }));`;
    const out = runChild(script, { home, cwd });
    assert.equal(out.dsn, null);
  });
});

describe('shared-env loader — config.mjs path (includeCwd:true) layers cwd .env', () => {
  // loadSharedEnv() default loads the cwd/git-root .env first, then shared.
  // This is the config.mjs-at-module-load path.
  function loadInChild({ cwdEnv = null, sharedContent = null } = {}) {
    const home = freshTmp('home-cwd');
    const cwd = freshTmp('cwd-cwd');
    if (cwdEnv != null) fs.writeFileSync(path.join(cwd, '.env'), cwdEnv);
    if (sharedContent != null) fs.writeFileSync(path.join(home, '.audit-loop.env'), sharedContent);
    const script =
      `import { loadSharedEnv } from ${JSON.stringify(LOADER_URL)};` +
      `loadSharedEnv();` +
      `process.stdout.write(JSON.stringify({ dsn: process.env.AUDIT_DB_URL ?? null }));`;
    return runChild(script, { home, cwd });
  }

  it('loads the cwd .env DSN', () => {
    assert.equal(loadInChild({ cwdEnv: 'AUDIT_DB_URL=postgres://cwd/db\n' }).dsn, 'postgres://cwd/db');
  });

  it('cwd .env DSN wins over shared (DB-group: shared dropped)', () => {
    assert.equal(loadInChild({
      cwdEnv: 'AUDIT_DB_URL=postgres://cwd/db\n',
      sharedContent: 'AUDIT_DB_URL=postgres://shared/db\n',
    }).dsn, 'postgres://cwd/db');
  });
});

describe('shared-env reader-fix — structural import boundary', () => {
  // Static import-closure walk from client.mjs. The reader must NOT depend on
  // config.mjs (that would restore the incidental-side-effect coupling and let
  // the behavioural cases pass for the wrong reason), and MUST import the
  // dedicated load-shared-env seam.
  function importClosure(entryAbs) {
    const seen = new Set();
    const stack = [entryAbs];
    // Match BOTH `import/export … from '…'` AND bare side-effect `import '…'`
    // (e.g. `import '../config.mjs'`) + dynamic `import('…')` — a side-effect
    // import of config.mjs would re-introduce the coupling the guard forbids.
    const fromRe = /(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g;
    const bareRe = /import\s*\(?\s*['"](\.[^'"]+)['"]/g;
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file) || !fs.existsSync(file)) continue;
      seen.add(file);
      const src = fs.readFileSync(file, 'utf8');
      for (const re of [fromRe, bareRe]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
          let rel = m[1];
          if (!/\.[mc]?js$/.test(rel)) rel += '.mjs';
          stack.push(path.resolve(path.dirname(file), rel));
        }
      }
    }
    return seen;
  }

  it('client.mjs import closure excludes config.mjs', () => {
    const closure = importClosure(CLIENT_ABS);
    const configAbs = path.join(REPO_ROOT, 'scripts', 'lib', 'config.mjs');
    assert.ok(!closure.has(configAbs),
      'db/client.mjs must NOT depend on config.mjs (incidental env side-effect)');
  });

  it('client.mjs imports load-shared-env.mjs directly', () => {
    const src = fs.readFileSync(CLIENT_ABS, 'utf8');
    assert.match(src, /from\s*['"]\.\.\/load-shared-env\.mjs['"]/,
      'db/client.mjs must import the dedicated load-shared-env seam');
  });
});
