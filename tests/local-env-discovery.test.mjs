// Contract guard for `discoverLocalEnvPath` — which `.env` a process loads.
//
// The bug class, reproduced live 2026-08-17: the resolver walked up from cwd
// and returned the FIRST `.env` it found, consulting git only if that walk came
// up empty. A linked worktree at `C:/tmp/ces-bakeoff` sat one level below a
// stray, months-old `C:/tmp/.env`; the walk returned the stray, so the git
// branches — added to fix the 2026-08-15 worktree incident — were never
// reached. Five provider credentials were unset while the repo's own `.env`
// carried every one of them. The failure is silent AND expensive: a missing
// provider key makes a bake-off arm record `skipped-no-key` rather than error,
// so a campaign pays for five arms before the completeness check rejects the
// snapshot.
//
// The invariant under test: an `.env` outside the current git repository can
// never shadow the repository's own.
//
// Three things keep this suite from going vacuously green:
//   1. `legacyDiscover` — the pre-fix algorithm, verbatim. Every reproduction
//      asserts it picks the WRONG file, which is what makes the fixture a
//      reproduction rather than a shape that would have passed all along.
//   2. A cross-check that the stray fixture `.env` is genuinely readable, so
//      "the repo's .env won" can't be an artefact of an unbuilt fixture.
//   3. The end-to-end cases read the value back out of a child's `process.env`
//      — what a real CLI receives, not what the resolver believes it returned.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverLocalEnvPath } from '../scripts/lib/shared-cloud-config.mjs';
import { mkdtemp, gitFixtureEnv } from './helpers/fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE = path.join(REPO_ROOT, 'scripts', 'lib', 'load-env.mjs');

const cleanups = [];
after(() => {
  for (const dir of cleanups) {
    // Windows holds handles briefly after a git worktree teardown — the retry
    // form is mandatory here (tests/rmsync-retry-guard.test.mjs).
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: gitFixtureEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
};

/**
 * The pre-2026-08-17 implementation of `discoverLocalEnvPath`, copied verbatim
 * from `scripts/lib/shared-cloud-config.mjs`.
 *
 * It is here as a NEGATIVE CONTROL, not as a fallback: each reproduction below
 * asserts that this resolves the stray file. Without it a fixture could drift
 * into a shape the old code would also have got right, and the suite would keep
 * passing while proving nothing. When this control fails, the fixture stopped
 * reproducing the bug — fix the fixture, do not delete the assertion.
 */
function legacyDiscover(cwd) {
  let dir = cwd;
  while (dir) {
    const p = path.join(dir, '.env');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8' }).stdout.trim();
    const p = path.join(gitRoot, '.env');
    if (fs.existsSync(p)) return p;
  } catch { /* not a git repo */ }
  return null;
}

/** Resolver + the notices it emitted, so the stderr contract is assertable. */
function discover(cwd) {
  const notices = [];
  const resolved = discoverLocalEnvPath(cwd, { onNotice: (n) => notices.push(n) });
  return { resolved, notices };
}

/** Path equality that survives Windows drive-letter case and separators. */
function samePath(a, b) {
  assert.ok(a, `expected a path, got ${a}`);
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  assert.equal(norm(a), norm(b), `expected ${b}\n     got ${a}`);
}

/**
 * The exact production shape: a directory holding an unrelated `.env`, with a
 * git repo (and, on request, a linked worktree) beneath it.
 *
 * `base/.env`          — the stray. Not in any repository.
 * `base/main/.env`     — the repo's own. Gitignored, as in production.
 * `base/wt`            — a linked worktree of `base/main`, no `.env` of its own.
 */
function makeFixture({ stray = true, repoEnv = true, worktree = null } = {}) {
  const base = mkdtemp('local-env-');
  cleanups.push(base);
  if (stray) fs.writeFileSync(path.join(base, '.env'), 'ENV_PROBE=stray-outside-repo\n');

  const main = path.join(base, 'main');
  fs.mkdirSync(main, { recursive: true });
  git(['init', '-b', 'main'], main);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  git(['config', 'commit.gpgsign', 'false'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(main, '.gitignore'), '.env\n');
  git(['add', '.'], main);
  git(['commit', '-m', 'init'], main);
  if (repoEnv) fs.writeFileSync(path.join(main, '.env'), 'ENV_PROBE=repo-own\n');

  let wt = null;
  if (worktree) {
    // `sibling` — outside the checkout, below the stray: the measured shape.
    // `nested`  — this repo's own `<repo>/.claude/worktrees/<name>` layout.
    wt = worktree === 'nested'
      ? path.join(main, '.claude', 'worktrees', 'wt')
      : path.join(base, 'wt');
    git(['worktree', 'add', '-b', `wt-${worktree}`, wt], main);
    assert.ok(!fs.existsSync(path.join(wt, '.env')), 'fixture invalid: worktree has its own .env');
  }
  return { base, main, wt, strayEnv: path.join(base, '.env'), repoEnvPath: path.join(main, '.env') };
}

// ── The reproduction ───────────────────────────────────────────────────────

describe('discoverLocalEnvPath — an .env outside the repo cannot shadow the repo\'s own', () => {
  it('sibling worktree below a stray .env: the REPO\'s .env wins (the 2026-08-17 repro)', () => {
    const f = makeFixture({ worktree: 'sibling' });

    // The fixture actually discriminates: the old algorithm picks the stray.
    // If this line ever fails, the reproduction has gone vacuous.
    samePath(legacyDiscover(f.wt), f.strayEnv);
    assert.equal(fs.readFileSync(f.strayEnv, 'utf-8').trim(), 'ENV_PROBE=stray-outside-repo',
      'fixture invalid: the stray .env is not readable, so "the repo won" proves nothing');

    const { resolved, notices } = discover(f.wt);
    samePath(resolved, f.repoEnvPath);
    assert.deepEqual(notices.map((n) => n.reason), ['main-worktree'],
      'a resolution that is not this worktree\'s own root .env must not be silent');
    samePath(notices[0].path, f.repoEnvPath);
  });

  it('nested worktree (<repo>/.claude/worktrees/<name>): resolves to the main checkout', () => {
    const f = makeFixture({ worktree: 'nested' });
    const { resolved, notices } = discover(f.wt);
    samePath(resolved, f.repoEnvPath);
    assert.deepEqual(notices.map((n) => n.reason), ['main-worktree']);
  });

  it('repo with NO .env at all: returns null rather than the stray above it', () => {
    // The sharpest form of the invariant — there is a readable .env one level
    // up and the correct answer is still "this repo has none".
    const f = makeFixture({ repoEnv: false });
    samePath(legacyDiscover(f.main), f.strayEnv);   // control: the old code took it

    const { resolved, notices } = discover(f.main);
    assert.equal(resolved, null, `leaked an .env from outside the repo: ${resolved}`);
    assert.deepEqual(notices, []);
  });

  it('deep subdirectory of a repo with no .env: still never escapes upward', () => {
    const f = makeFixture({ repoEnv: false });
    const deep = path.join(f.main, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    samePath(legacyDiscover(deep), f.strayEnv);     // control

    assert.equal(discover(deep).resolved, null);
  });
});

// ── Preserved behaviour ────────────────────────────────────────────────────

describe('discoverLocalEnvPath — the cases that must keep working', () => {
  it('repo root: finds its own .env, silently', () => {
    const f = makeFixture({ stray: false });
    const { resolved, notices } = discover(f.main);
    samePath(resolved, f.repoEnvPath);
    assert.deepEqual(notices, [], 'the ordinary resolution must emit nothing');
  });

  it('consumer repo run from a subdirectory: finds the consumer\'s ROOT .env', () => {
    // The use case the old walk-up existed to serve. It is preserved because the
    // walk still happens — it just stops at the repo boundary.
    const f = makeFixture({ stray: true });
    const sub = path.join(f.main, 'scripts', 'deep');
    fs.mkdirSync(sub, { recursive: true });

    const { resolved, notices } = discover(sub);
    samePath(resolved, f.repoEnvPath);
    assert.deepEqual(notices, [], 'the repo root .env is the ordinary answer, even from a subdirectory');
  });

  it('nearest-wins INSIDE the repo: a package-level .env still beats the root one', () => {
    const f = makeFixture({ stray: false });
    const pkg = path.join(f.main, 'packages', 'api');
    fs.mkdirSync(pkg, { recursive: true });
    const pkgEnv = path.join(pkg, '.env');
    fs.writeFileSync(pkgEnv, 'ENV_PROBE=package-level\n');

    const { resolved, notices } = discover(pkg);
    samePath(resolved, pkgEnv);
    // Inside the repo, but not the root .env — named, per the same rule.
    assert.deepEqual(notices.map((n) => n.reason), ['repo-subdirectory']);
  });

  it('outside any git repository: the unbounded walk still applies', () => {
    // There is no repository boundary to respect here, so legacy behaviour is
    // the honest answer — and it is reported rather than assumed.
    const base = mkdtemp('local-env-nogit-');
    cleanups.push(base);
    fs.writeFileSync(path.join(base, '.env'), 'ENV_PROBE=loose\n');
    const deep = path.join(base, 'x', 'y');
    fs.mkdirSync(deep, { recursive: true });

    const { resolved, notices } = discover(deep);
    samePath(resolved, path.join(base, '.env'));
    assert.deepEqual(notices.map((n) => n.reason), ['outside-repo']);
  });

  it('negative control: no .env anywhere reachable reports absence', () => {
    // Without this, every green above could be a value leaking in from the
    // ambient environment rather than the fixture.
    const f = makeFixture({ stray: false, repoEnv: false });
    assert.equal(discover(f.main).resolved, null);
  });
});

// ── End-to-end: what the CLI actually receives ─────────────────────────────

/**
 * Import the env oracle in a child rooted at `cwd` and report what landed in
 * `process.env`. A child, deliberately: a static import hoists above any
 * in-test `process.env` mutation, so an in-process assertion would silently
 * test the wrong thing.
 */
function loadEnvFrom(cwd, { home, extraEnv = {} }) {
  const code =
    `await import(${JSON.stringify(pathToFileURL(ORACLE).href)});\n` +
    'process.stdout.write(JSON.stringify({ probe: process.env.ENV_PROBE ?? null }));';
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...gitFixtureEnv(),
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,   // git/node need these on Windows
      ComSpec: process.env.ComSpec,
      HOME: home,
      USERPROFILE: home,                    // shared-layer lookup, Windows
      AUDIT_LOOP_DISABLE_SHARED: '1',       // isolate the cwd/.env layer
      ENV_PROBE: undefined,
      ...extraEnv,
    },
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  return { probe: JSON.parse(res.stdout).probe, stderr: res.stderr };
}

describe('load-env oracle — end-to-end through the real loader', () => {
  it('a worktree below a stray .env loads the REPO\'s credentials', () => {
    const f = makeFixture({ worktree: 'sibling' });
    const { probe, stderr } = loadEnvFrom(f.wt, { home: path.join(f.base, 'home') });
    assert.equal(probe, 'repo-own', 'the CLI received the stray .env, not the repo\'s');
    assert.match(stderr, /\[env\] \.env resolved from the MAIN worktree/,
      'crossing out of this worktree must be visible on stderr');
  });

  it('DOTENV_CONFIG_PATH still short-circuits everything', () => {
    // `load-shared-env.mjs::loadCwdLayer` consults the resolver only when this
    // is unset. An explicit operator override outranks any discovery rule.
    const f = makeFixture({ worktree: 'sibling' });
    const explicit = path.join(f.base, 'explicit.env');
    fs.writeFileSync(explicit, 'ENV_PROBE=explicit-override\n');

    const { probe } = loadEnvFrom(f.wt, {
      home: path.join(f.base, 'home'),
      extraEnv: { DOTENV_CONFIG_PATH: explicit },
    });
    assert.equal(probe, 'explicit-override');
  });
});
