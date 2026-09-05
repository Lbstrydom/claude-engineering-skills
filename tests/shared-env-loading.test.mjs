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

  // ── An empty-but-SET DSN is the AIR-GAP signal, and it is now loud ─────────
  //
  // A consumer report (2026-09-04) asked for the opposite of these cases: treat
  // an empty DSN as absent so the shared file wins. Their motivating incident is
  // real — `env: AUDIT_DB_URL: ${{ secrets.AUDIT_DB_URL }}` with a secret that
  // does not exist expands to empty-but-SET, so every `arch:*` script ran
  // cloud-blind while `arch:drift` printed GREEN, score 0, 0 duplication pairs
  // against a repo that had measured 14 pairs an hour earlier. Three CI
  // dispatches died on it.
  //
  // It was implemented, and the suite said no: `tests/helpers/air-gap.mjs`
  // exists to set both DSN keys to `''` so a suite "must never resolve to a real
  // database", 20 test files use that idiom, and the flip made 20+ suites — some
  // of which `DROP SCHEMA public CASCADE` — resolve to whatever store the
  // developer's `~/.audit-loop.env` names. The two requirements are the same
  // literal state and cannot both hold.
  //
  // So the state is PRESERVED and made loud. These cases pin both halves: the
  // air-gap keeps working, and the operator is told why, with the remedy. What
  // actually makes the CI case self-diagnosing is the store line now printed in
  // the drift report — see tests/drift-signal-attribution.test.mjs.

  it('9. higher-layer DSN set to EMPTY (or whitespace) → cloud stays OFF (air-gap)', () => {
    // Whitespace too, because `resolveDbUrl` trims before testing: if the two
    // disagreed, `AUDIT_DB_URL=" "` would air-gap the reader while the loader
    // handed it a shared DSN it then discarded — a state neither side describes.
    for (const blank of ['', '   ']) {
      assert.equal(resolveInChild({
        sharedContent: 'AUDIT_DB_URL=postgres://shared/db\n',
        extraEnv: { AUDIT_DB_URL: blank },
      }).dsn, null, `blank=${JSON.stringify(blank)}`);
    }
  });

  it('10. the ALIAS set to EMPTY air-gaps the canonical key too (airGapDbUrl blanks both)', () => {
    // `airGapDbUrl()` sets AUDIT_DB_URL and AUDIT_POSTGRES_URL. Either one being
    // explicitly blank must suppress the whole DB group, or the helper only
    // half-works depending on which key the shared file happens to name.
    assert.equal(resolveInChild({
      sharedContent: 'AUDIT_DB_URL=postgres://shared/db\n',
      extraEnv: { AUDIT_POSTGRES_URL: '' },
    }).dsn, null);
  });

  it('11. an empty DSN suppresses the WHOLE DB group, not just the DSN', () => {
    // The old incoherence: `higherHasDsn` was false for an empty DSN, so the
    // shared AUDIT_DB_SSL_MODE was handed over while the DSN itself was
    // declined — half a bundle from a layer that gives all of it or none.
    const out = resolveInChild({
      sharedContent: 'AUDIT_DB_URL=postgres://shared/db\nAUDIT_DB_SSL_MODE=no-verify\n',
      extraEnv: { AUDIT_DB_URL: '' },
    });
    assert.equal(out.dsn, null);
    assert.equal(out.ssl, null, 'a shared SSL mode must not attach to a deliberately-absent DSN');
  });

  it('12. an UNSET DSN still adopts the shared one (the direction that must not regress)', () => {
    // The negative control for cases 9–11. Without it, "empty air-gaps" and
    // "the shared layer never contributes a DSN" pass identically — and the
    // second would silently undo case 1, this module's whole reason to exist.
    const out = resolveInChild({
      sharedContent: 'AUDIT_DB_URL=postgres://shared/db\nAUDIT_DB_SSL_MODE=no-verify\n',
    });
    assert.equal(out.dsn, 'postgres://shared/db');
    assert.equal(out.ssl, 'no-verify');
  });

  it('13. the empty-DSN state is announced WITH its remedy', () => {
    // The diagnostic that turns the consumer's three-hour debug into one line.
    // It must name the fix (UNSET, not `""`) and the CI shape that produces it.
    const home = freshTmp('home-notice');
    const cwd = freshTmp('cwd-notice');
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=postgres://shared/db\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { resolveDbUrl } from ${JSON.stringify(CLIENT_URL)}; resolveDbUrl();`,
    ], { cwd, env: hermeticEnv(home, { AUDIT_DB_URL: '' }), encoding: 'utf8' });
    assert.equal(r.status, 0, `child exited ${r.status}; stderr: ${(r.stderr || '').slice(0, 400)}`);
    assert.match(r.stderr, /set but EMPTY/);
    assert.match(r.stderr, /UNSET the variable/);
    assert.match(r.stderr, /AUDIT_LOOP_DISABLE_SHARED=1/);
  });

  it('14b. the notice sets the sentinel it reads, so a CHILD does not re-warn', () => {
    // Code-audit R1 M1/M10. The notice checks `_AUDIT_LOOP_SHARED_LOADED` but
    // originally never set it — one-directional dedup: suppress a parent's
    // notice, never suppress your own in a child. The `(sets: …)` line below it
    // DOES set the marker, which hid the bug: in the common case the shared
    // file also carries non-DB keys, so that branch fires and the marker lands
    // anyway. This fixture uses a shared file holding ONLY DB-group keys, so
    // nothing is contributed, that branch never runs, and the parent is the
    // only thing that can set it.
    const home = freshTmp('home-sentinel');
    const cwd = freshTmp('cwd-sentinel');
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=postgres://shared/db\n');
    const script =
      `import { resolveDbUrl } from ${JSON.stringify(CLIENT_URL)};`
      + `import { spawnSync } from 'node:child_process';`
      + `resolveDbUrl();` // parent: warns, and must set the marker
      + `const r = spawnSync(process.execPath, ['--input-type=module','-e',`
      + `  ${JSON.stringify(`import { resolveDbUrl } from ${JSON.stringify(CLIENT_URL)}; resolveDbUrl();`)}`
      + `], { encoding: 'utf8' });`
      + `process.stdout.write(JSON.stringify({ child: r.stderr || '' }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { cwd, env: hermeticEnv(home, { AUDIT_DB_URL: '' }), encoding: 'utf8' });
    assert.equal(r.status, 0, `parent exited ${r.status}: ${(r.stderr || '').slice(0, 400)}`);
    assert.match(r.stderr, /set but EMPTY/, 'the parent must warn once');
    const { child } = JSON.parse(r.stdout);
    assert.ok(!child.includes('set but EMPTY'),
      `the child re-warned — the sentinel was read but never set:\n${child}`);
  });

  it('14. the notice stays SILENT when the shared file has no DSN to offer', () => {
    // The direction that must not fire. Every air-gapped test run in this repo
    // passes through this path; a notice about a decision that changed nothing
    // would be 20 suites' worth of noise, and noise is how a real warning gets
    // ignored.
    const home = freshTmp('home-quiet');
    const cwd = freshTmp('cwd-quiet');
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'OPENROUTER_API_KEY=k\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { resolveDbUrl } from ${JSON.stringify(CLIENT_URL)}; resolveDbUrl();`,
    ], { cwd, env: hermeticEnv(home, { AUDIT_DB_URL: '' }), encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(!r.stderr.includes('set but EMPTY'), `unexpected notice: ${r.stderr}`);
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
