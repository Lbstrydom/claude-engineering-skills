/**
 * @fileoverview config.mjs ~/.audit-loop.env autoload tests.
 *
 * Subprocess pattern: spawn `node` with a controlled HOME (POSIX) /
 * USERPROFILE (Windows) pointing at a mkdtemp dir, then have the child
 * import config.mjs and print the relevant process.env keys to stdout.
 *
 * Plan: docs/plans/shared-cloud-config.md §8.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const CHILD_SCRIPT = path.join(REPO_ROOT, 'tests', 'fixtures', 'config-shared-env-child.mjs');

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cse-'));
}

// R1-audit M19: child script is a COMMITTED fixture at the path above.
// Tests no longer rewrite it on every run — confines generated artifacts
// to per-test temp dirs only (mkdtemp HOMEs).

function runChild({ home, cwd, env = {} }) {
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  // Start with parent env, strip vars-under-test so we see the loader
  // populating them (not test-runner inheritance), THEN apply the
  // caller's overrides last so they actually take effect.
  const subEnv = { ...process.env, [homeKey]: home };
  delete subEnv._AUDIT_LOOP_SHARED_LOADED;
  delete subEnv.AUDIT_DB_URL;
  delete subEnv.OPENAI_API_KEY;
  delete subEnv.GEMINI_API_KEY;
  delete subEnv.DOTENV_CONFIG_PATH;
  Object.assign(subEnv, env);
  const r = spawnSync(process.execPath, [CHILD_SCRIPT], {
    cwd, env: subEnv, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('config.mjs shared ~/.audit-loop.env loader', () => {
  it('cwd .env wins over shared', () => {
    const home = mkdtemp();
    const cwd  = mkdtemp();
    try {
      fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=shared-value\n');
      fs.writeFileSync(path.join(cwd, '.env'), 'AUDIT_DB_URL=cwd-value\n');
      const r = runChild({ home, cwd });
      assert.equal(r.status, 0, r.stderr);
      const env = JSON.parse(r.stdout);
      assert.equal(env.AUDIT_DB_URL, 'cwd-value');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd,  { recursive: true, force: true });
    }
  });

  it('shared file fills vars unset by cwd .env', () => {
    const home = mkdtemp();
    const cwd  = mkdtemp();
    try {
      fs.writeFileSync(path.join(home, '.audit-loop.env'),
        'AUDIT_DB_URL=postgres-shared\nOPENAI_API_KEY=sk-shared\n');
      fs.writeFileSync(path.join(cwd, '.env'), '# local has nothing\n');
      const r = runChild({ home, cwd });
      assert.equal(r.status, 0, r.stderr);
      const env = JSON.parse(r.stdout);
      assert.equal(env.AUDIT_DB_URL, 'postgres-shared');
      assert.equal(env.OPENAI_API_KEY, 'sk-shared');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd,  { recursive: true, force: true });
    }
  });

  it('shared file absent → loader is silent (no stderr line about it)', () => {
    const home = mkdtemp();
    const cwd  = mkdtemp();
    try {
      fs.writeFileSync(path.join(cwd, '.env'), 'AUDIT_DB_URL=only-cwd\n');
      const r = runChild({ home, cwd });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /loaded shared cloud config/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd,  { recursive: true, force: true });
    }
  });

  it('both absent → no crash, vars unset', () => {
    const home = mkdtemp();
    const cwd  = mkdtemp();
    try {
      const r = runChild({ home, cwd });
      assert.equal(r.status, 0, r.stderr);
      const env = JSON.parse(r.stdout);
      assert.equal(env.AUDIT_DB_URL, null);
      assert.equal(env.OPENAI_API_KEY, null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd,  { recursive: true, force: true });
    }
  });

  it('emits one stderr note when shared file is loaded + sets vars', () => {
    const home = mkdtemp();
    const cwd  = mkdtemp();
    try {
      fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=x\nOPENAI_API_KEY=y\n');
      fs.writeFileSync(path.join(cwd, '.env'), '');
      const r = runChild({ home, cwd });
      assert.equal(r.status, 0);
      const noteMatches = r.stderr.match(/loaded shared cloud config/g) || [];
      assert.equal(noteMatches.length, 1, `expected one note, got: ${r.stderr}`);
      assert.match(r.stderr, /AUDIT_DB_URL/);
      assert.match(r.stderr, /OPENAI_API_KEY/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd,  { recursive: true, force: true });
    }
  });

  it('shared file present but all vars already in process.env → no note', () => {
    const home = mkdtemp();
    const cwd  = mkdtemp();
    try {
      fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=shared\n');
      fs.writeFileSync(path.join(cwd, '.env'), 'AUDIT_DB_URL=cwd\n');
      const r = runChild({ home, cwd });
      assert.equal(r.status, 0);
      // The loader added AUDIT_DB_URL via cwd .env (layer 1); shared was
      // attempted but override:false meant it set 0 NEW vars → no note.
      assert.doesNotMatch(r.stderr, /loaded shared cloud config/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd,  { recursive: true, force: true });
    }
  });

  // R1-audit M17: sentinel must propagate via env to subprocesses so each
  // spawned child doesn't re-log the "loaded shared cloud config" notice.
  // Test: pass _AUDIT_LOOP_SHARED_LOADED=1 in the env (as if a parent had
  // already loaded the shared file); assert the child skips the note even
  // though the shared file IS present + IS adding new vars.
  it('child process with _AUDIT_LOOP_SHARED_LOADED=1 inherits the suppression', () => {
    const home = mkdtemp();
    const cwd  = mkdtemp();
    try {
      fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=x\nOPENAI_API_KEY=y\n');
      fs.writeFileSync(path.join(cwd, '.env'), '');
      // Pass the sentinel as if a parent process had already loaded.
      const r = runChild({ home, cwd, env: { _AUDIT_LOOP_SHARED_LOADED: '1' } });
      assert.equal(r.status, 0, r.stderr);
      // Vars must still be loaded (sentinel doesn't block loading, only logging).
      const env = JSON.parse(r.stdout);
      assert.equal(env.AUDIT_DB_URL, 'x');
      assert.equal(env._AUDIT_LOOP_SHARED_LOADED, '1');
      // Note must NOT fire (sentinel suppresses re-log).
      assert.doesNotMatch(r.stderr, /loaded shared cloud config/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd,  { recursive: true, force: true });
    }
  });
});
