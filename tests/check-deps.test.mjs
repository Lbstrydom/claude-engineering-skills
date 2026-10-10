// check-deps.mjs: env comes from the canonical loader, and `--fix` reports the
// post-install truth.
//
// Two defects, both measured against the pre-fix script (2026-10-10):
//   1. Env — it hand-parsed `${cwd}/.env` only, so the shared
//      `~/.audit-loop.env` layer and a repo `.env` seen from a subdirectory or
//      linked worktree were both invisible: run from this worktree it reported
//      GEMINI_API_KEY unset while every other entry point saw it.
//   2. `--fix` — it installed, then printed the PRE-install snapshot and exited
//      on it; with `--json` it exited before even attempting the install, and
//      a failed install still exited on the stale verdict.
//
// The env half runs the real CLI in a child process: `lib/load-env.mjs` is a
// side-effect import, so only a fresh process can observe what it loads. The
// fix half drives the exported `run()` with a fake installer, because a real
// install is network-bound and the property under test is the adjudication.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, gitFixtureEnv } from './helpers/fixtures.mjs';
import { PROVIDER_ENV_VARS } from './helpers/provider-env.mjs';
import { DB_GROUP_KEYS } from '../scripts/lib/shared-cloud-config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-deps.mjs');

const ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'AUDIT_DB_URL'];

const tmpDirs = [];
function tmp(prefix) {
  const d = mkdtemp(prefix);
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** A child env with none of the ambient answers this suite asks about. */
function hermeticEnv(home) {
  const env = gitFixtureEnv();
  for (const k of [...ENV_KEYS, ...PROVIDER_ENV_VARS, ...DB_GROUP_KEYS,
    'DOTENV_CONFIG_PATH', 'AUDIT_LOOP_DISABLE_SHARED']) delete env[k];
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function gitRepo() {
  const dir = tmp('check-deps-repo-');
  const r = spawnSync('git', ['init', '-q', dir], { env: gitFixtureEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  return dir;
}

/** Run the real CLI with `--json`; returns `{status, env: {KEY: set}}`. */
function runJson({ cwd, home }) {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
    cwd, env: hermeticEnv(home), encoding: 'utf8', timeout: 60_000,
  });
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    assert.fail(`check-deps --json printed no JSON (exit ${r.status}).\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return { status: r.status, env: Object.fromEntries(parsed.env.map(e => [e.key, e.set])) };
}

describe('check-deps env loading uses the canonical loader', () => {
  it('negative control: nothing anywhere -> keys unset, required key fails the run', () => {
    const repo = gitRepo();
    const home = tmp('check-deps-home-');
    const { status, env } = runJson({ cwd: repo, home });
    assert.deepEqual(env, { OPENAI_API_KEY: false, GEMINI_API_KEY: false, ANTHROPIC_API_KEY: false, AUDIT_DB_URL: false });
    assert.equal(status, 1, 'a missing required OPENAI_API_KEY must exit non-zero');
  });

  it('reads the shared ~/.audit-loop.env layer', () => {
    const repo = gitRepo();
    const home = tmp('check-deps-home-');
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'OPENAI_API_KEY=sk-from-shared\n');
    const { status, env } = runJson({ cwd: repo, home });
    assert.equal(env.OPENAI_API_KEY, true, 'shared layer key not seen — env not loaded via lib/load-env.mjs');
    assert.equal(status, 0);
  });

  it("finds the repo's .env when run from a subdirectory", () => {
    const repo = gitRepo();
    const home = tmp('check-deps-home-');
    fs.writeFileSync(path.join(repo, '.env'), 'OPENAI_API_KEY=sk-root\nGEMINI_API_KEY="g-root"\n');
    const sub = path.join(repo, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    const { status, env } = runJson({ cwd: sub, home });
    assert.equal(env.OPENAI_API_KEY, true, 'repo-root .env invisible from a subdirectory');
    assert.equal(env.GEMINI_API_KEY, true);
    assert.equal(status, 0);
  });
});

describe('check-deps --fix re-probes and reports the post-fix state', () => {
  let mod;
  before(async () => {
    // Dynamic import AFTER pinning the loader to nothing: the module's static
    // `lib/load-env.mjs` import would otherwise pull the developer's real
    // `.env` and `~/.audit-loop.env` into this test process.
    process.env.DOTENV_CONFIG_PATH = path.join(tmp('check-deps-noenv-'), 'absent.env');
    process.env.AUDIT_LOOP_DISABLE_SHARED = '1';
    mod = await import('../scripts/check-deps.mjs');
  });

  const ENV = { OPENAI_API_KEY: 'sk-test' };
  // proper-lockfile has no env gate, so it is wanted; the gated optionals are
  // not, because ENV leaves their keys unset.
  const WANTED = ['openai', 'zod', 'dotenv', 'micromatch', 'proper-lockfile'];

  /** A package root whose scripts/ dir is the probe origin. */
  function pkgRoot({ lockfiles = ['package-lock.json'] } = {}) {
    const root = tmp('check-deps-pkg-');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
    for (const f of lockfiles) fs.writeFileSync(path.join(root, f), '');
    const scriptDir = path.join(root, 'scripts');
    fs.mkdirSync(scriptDir);
    // Precondition: nothing above the fixture already satisfies the probe,
    // or every assertion below would pass having installed nothing.
    for (const p of WANTED) {
      assert.equal(mod.isPackageReachable(p, scriptDir), false, `${p} reachable from an ancestor of ${root}`);
    }
    return { root, scriptDir };
  }

  /** Fake installer: lands `pkgs` in `<cwd>/node_modules`, then optionally throws. */
  function installer({ land, throwAfter = null, calls = [] }) {
    const fn = (pm, args, { cwd }) => {
      calls.push({ pm, args, cwd });
      for (const p of land) {
        const dir = path.join(cwd, 'node_modules', p);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), `{"name":"${p}"}`);
      }
      if (throwAfter) throw throwAfter;
    };
    fn.calls = calls;
    return fn;
  }

  function runCli(argv, { scriptDir, install }) {
    const out = [];
    const err = [];
    const code = mod.run({
      argv, scriptDir, env: ENV, install,
      out: (s) => out.push(s), err: (s) => err.push(s),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('--json --fix installs, and the JSON is the post-install state', () => {
    const { root, scriptDir } = pkgRoot();
    const install = installer({ land: WANTED });
    const { code, out } = runCli(['--json', '--fix'], { scriptDir, install });
    assert.equal(install.calls.length, 1, '--json must not exit before attempting the fix');
    assert.deepEqual(install.calls[0], { pm: 'npm', args: ['install'], cwd: root });
    const json = JSON.parse(out);
    assert.ok(json.required.every(r => r.installed), 'report still shows the pre-install snapshot');
    assert.equal(json.fix.outcome, 'fixed');
    assert.equal(json.allOk, true);
    assert.equal(code, 0);
  });

  it('human mode prints the post-fix verdict', () => {
    const { scriptDir } = pkgRoot();
    const { code, out } = runCli(['--fix'], { scriptDir, install: installer({ land: WANTED }) });
    assert.equal(code, 0);
    assert.match(out, /All checks passed/);
    assert.doesNotMatch(out, /Missing required packages/);
  });

  it('a partial fix exits non-zero and names what is still missing', () => {
    const { scriptDir } = pkgRoot();
    const land = WANTED.filter(p => p !== 'zod');
    const { code, out } = runCli(['--json', '--fix'], { scriptDir, install: installer({ land }) });
    const json = JSON.parse(out);
    assert.equal(code, 1);
    assert.equal(json.fix.outcome, 'partial');
    assert.deepEqual(json.fix.stillMissing, ['zod']);
    assert.equal(json.required.find(r => r.package === 'zod').installed, false);
  });

  it('an optional package that does not land still fails the fix', () => {
    const { scriptDir } = pkgRoot();
    const land = WANTED.filter(p => p !== 'proper-lockfile');
    const { code, out } = runCli(['--json', '--fix'], { scriptDir, install: installer({ land }) });
    const json = JSON.parse(out);
    assert.equal(json.allOk, true, 'required set is complete');
    assert.equal(code, 1, 'a fix that left a requested package missing must exit non-zero');
  });

  it('a clean installer exit is not evidence: nothing landed -> failed', () => {
    const { scriptDir } = pkgRoot();
    const { code, out } = runCli(['--json', '--fix'], { scriptDir, install: installer({ land: [] }) });
    assert.equal(code, 1);
    assert.equal(JSON.parse(out).fix.outcome, 'failed');
  });

  it('a non-zero installer exit with every package landed is a success (pnpm ignored-builds)', () => {
    const { scriptDir } = pkgRoot({ lockfiles: ['pnpm-lock.yaml'] });
    const boom = Object.assign(new Error('ERR_PNPM_IGNORED_BUILDS'), { status: 1 });
    const install = installer({ land: WANTED, throwAfter: boom });
    const { code, out } = runCli(['--json', '--fix'], { scriptDir, install });
    const json = JSON.parse(out);
    assert.equal(install.calls[0].pm, 'pnpm', "uses the repo's own package manager");
    assert.equal(json.fix.outcome, 'fixed');
    assert.match(json.fix.error, /ERR_PNPM_IGNORED_BUILDS/);
    assert.equal(code, 0);
  });

  it('ambiguous lockfiles: refuses without installing, exits non-zero', () => {
    const { scriptDir } = pkgRoot({ lockfiles: ['package-lock.json', 'pnpm-lock.yaml'] });
    const install = installer({ land: WANTED });
    const { code, out } = runCli(['--json', '--fix'], { scriptDir, install });
    assert.equal(install.calls.length, 0);
    assert.equal(JSON.parse(out).fix.outcome, 'refused');
    assert.equal(code, 1);
  });

  it('a flag after the `--` terminator selects no mode (matches what was validated)', () => {
    const { scriptDir } = pkgRoot();
    const install = installer({ land: WANTED });
    const { out } = runCli(['--', '--fix', '--json'], { scriptDir, install });
    assert.equal(install.calls.length, 0, '`-- --fix` must not run an install');
    assert.throws(() => JSON.parse(out), '`-- --json` must not switch to JSON output');
  });

  it("the real installer's stdout goes to stderr, never the report stream", () => {
    // A child process, because the property is about file descriptors: an
    // in-process capture cannot see what a grandchild writes to fd 1.
    const dir = tmp('check-deps-stdio-');
    const probe = path.join(dir, 'probe.mjs');
    fs.writeFileSync(probe, `
      import { pathToFileURL } from 'node:url';
      const m = await import(pathToFileURL(${JSON.stringify(SCRIPT)}).href);
      m.execInstall('npm', ['install'], {
        cwd: ${JSON.stringify(dir)}, timeoutMs: 30000,
        invocation: { bin: process.execPath, shell: false, prefix: ['-e',
          'process.stdout.write("PM-OUT\\\\n"); process.stderr.write("PM-ERR\\\\n")'] },
      });
      process.stdout.write('REPORT');
    `);
    const env = hermeticEnv(tmp('check-deps-home-'));
    env.DOTENV_CONFIG_PATH = path.join(dir, 'absent.env');
    env.AUDIT_LOOP_DISABLE_SHARED = '1';
    const r = spawnSync(process.execPath, [probe], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'REPORT', 'installer output leaked onto stdout');
    // Vacuous-pass guard: the fake manager really ran and its output survived.
    assert.match(r.stderr, /PM-OUT/);
    assert.match(r.stderr, /PM-ERR/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    const { scriptDir } = pkgRoot();
    assert.throws(() => runCli(['--fixx'], { scriptDir, install: installer({ land: [] }) }),
      (e) => e.code === 'ARGV_ERROR');
  });
});
