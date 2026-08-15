// Contract guard for the env-loading single oracle (`scripts/lib/load-env.mjs`).
//
// The bug class, measured 2026-08-15: `import 'dotenv/config'` reads exactly
// `${process.cwd()}/.env` — no walk-up, no git-root, no main-worktree fallback,
// no shared `~/.audit-loop.env`. `.env` is gitignored, so it is absent from
// every linked worktree; 43 call sites across `scripts/**` loaded env that way
// and ran credential-blind wherever cwd was not the checkout root. The failure
// is silent in both directions: nothing throws, `process.env` is just empty.
//
// Two halves, because either alone can pass while the bug is live:
//   1. STRUCTURAL — no `dotenv` import survives outside the oracle's own chain.
//      Carries a vacuous-pass guard: a scan that visits zero files would
//      otherwise report a clean repo.
//   2. BEHAVIOURAL — the loader actually finds a `.env` the cwd does not
//      contain, in both worktree layouts, with a negative control proving the
//      probe can report absence. Child processes throughout: a static import
//      hoists above any in-test `process.env` mutation, so an in-process
//      assertion here would silently test the wrong thing.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, gitFixtureEnv } from './helpers/fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');
const ORACLE = path.join(SCRIPTS, 'lib', 'load-env.mjs');

// The only modules allowed to name `dotenv`: the oracle and the chain it calls.
const DOTENV_CHAIN = new Set([
  path.join(SCRIPTS, 'lib', 'load-env.mjs'),
  path.join(SCRIPTS, 'lib', 'load-shared-env.mjs'),
  path.join(SCRIPTS, 'lib', 'shared-cloud-config.mjs'),
]);

// Matches a real import of the package, in any spelling. Comments mentioning
// `dotenv` are deliberately NOT matched — this repo's docstrings discuss the
// bug class at length, and a rule that fired on prose would be turned off.
const DOTENV_IMPORT = /(?:^|\n)\s*(?:import\s[^\n;]*from\s*['"]dotenv(?:\/[^'"]*)?['"]|import\s*['"]dotenv(?:\/[^'"]*)?['"]|(?:const|let|var)\s[^\n;]*=\s*require\(\s*['"]dotenv(?:\/[^'"]*)?['"]\s*\))/;

function collectMjsFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectMjsFiles(p, acc);
    else if (e.name.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

const cleanups = [];
after(() => {
  for (const dir of cleanups) {
    // Windows holds handles briefly after a git worktree teardown — retry form
    // is mandatory here (tests/rmsync-retry-guard.test.mjs).
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

describe('env loading — single oracle (structural)', () => {
  const files = collectMjsFiles(SCRIPTS);

  it('scans a non-trivial number of files (vacuous-pass guard)', () => {
    // Without this, a bad root or a broken walker reports "0 violations" and
    // reads exactly like a clean repo.
    assert.ok(files.length > 100, `expected >100 .mjs files under scripts/, walked ${files.length}`);
    assert.ok(files.includes(ORACLE), 'walker did not reach the oracle itself');
  });

  it('no module outside the oracle chain imports dotenv', () => {
    const offenders = files
      .filter((f) => !DOTENV_CHAIN.has(f))
      .filter((f) => DOTENV_IMPORT.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));

    assert.deepEqual(offenders, [],
      'These modules load env cwd-relative. Replace the import with the oracle:\n' +
      "  import './lib/load-env.mjs';   (adjust the relative depth)\n" +
      'Why: `dotenv/config` reads only ${cwd}/.env — see scripts/lib/load-env.mjs.\n' +
      `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('the detector actually fires on the pattern it forbids (negative control)', () => {
    // A regex that matched nothing would make the assertion above vacuous.
    for (const spelling of [
      "import 'dotenv/config';",
      'import dotenv from "dotenv";',
      "const dotenv = require('dotenv');",
    ]) {
      assert.ok(DOTENV_IMPORT.test(`\n${spelling}\n`), `detector missed: ${spelling}`);
    }
    // ...and does NOT fire on prose, which is why the rule survives review.
    assert.ok(!DOTENV_IMPORT.test("\n// never use import 'dotenv/config' here\n"),
      'detector fired on a comment — it would be disabled within a week');
  });
});

// ── Behavioural ────────────────────────────────────────────────────────────

/**
 * Run the oracle in a child whose cwd is `cwd`, and report what it loaded.
 * Deliberately a child process, and deliberately reading the value back out of
 * `process.env` rather than inspecting the resolver — this asserts what a real
 * CLI receives, not what the producer believes it sent.
 */
function loadEnvFrom(cwd, { home }) {
  const code =
    `await import(${JSON.stringify(pathToFileURL(ORACLE).href)});\n` +
    'process.stdout.write(JSON.stringify({ probe: process.env.LOAD_ENV_PROBE ?? null }));';
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd,
    encoding: 'utf8',
    env: {
      ...gitFixtureEnv(),
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,     // git/node need these on Windows
      ComSpec: process.env.ComSpec,
      HOME: home,
      USERPROFILE: home,                      // shared-layer lookup, Windows
      AUDIT_LOOP_DISABLE_SHARED: '1',         // isolate the cwd/.env layer
    },
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  return JSON.parse(res.stdout).probe;
}

describe('env loading — finds .env the cwd does not contain', () => {
  const git = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitFixtureEnv() } });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r;
  };

  function makeRepo() {
    const base = mkdtemp('load-env-');
    cleanups.push(base);
    const main = path.join(base, 'main');
    fs.mkdirSync(main, { recursive: true });
    git(['init', '-b', 'main'], main);
    fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
    fs.writeFileSync(path.join(main, '.gitignore'), '.env\n');
    git(['add', '.'], main);
    git(['commit', '-m', 'init'], main);
    // The value under test lives ONLY in the main checkout, and is gitignored —
    // exactly the production shape.
    fs.writeFileSync(path.join(main, '.env'), 'LOAD_ENV_PROBE=from-main-root\n');
    return { base, main, home: path.join(base, 'home') };
  }

  it('negative control: reports absence when no .env exists anywhere above cwd', () => {
    const base = mkdtemp('load-env-empty-');
    cleanups.push(base);
    const deep = path.join(base, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    // Proves the probe can say "nothing" — without it, every green below could
    // be an artefact of a value leaking in from the ambient environment.
    assert.equal(loadEnvFrom(deep, { home: base }), null);
  });

  it('from a subdirectory: walks up to the repo root', () => {
    const { main, home } = makeRepo();
    const sub = path.join(main, 'scripts', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(loadEnvFrom(sub, { home }), 'from-main-root');
  });

  it('from a NESTED linked worktree: walks up past .claude/worktrees', () => {
    // This repo's own layout (`<repo>/.claude/worktrees/<name>`), and the shape
    // that was measured broken: the worktree has no .env of its own.
    const { main, home } = makeRepo();
    const wt = path.join(main, '.claude', 'worktrees', 'wt');
    git(['worktree', 'add', '-b', 'wt', wt], main);
    assert.ok(!fs.existsSync(path.join(wt, '.env')), 'fixture invalid: worktree has its own .env');
    assert.equal(loadEnvFrom(wt, { home }), 'from-main-root');
  });

  it('from a DETACHED linked worktree: resolves via git --git-common-dir', () => {
    // A worktree outside the main checkout — no walk-up path to the main root,
    // so this is the ONLY case the --git-common-dir branch can satisfy. That
    // branch had zero coverage before this test.
    const { base, main, home } = makeRepo();
    const wt = path.join(base, 'detached-wt');
    git(['worktree', 'add', '-b', 'detached', wt], main);
    assert.ok(!fs.existsSync(path.join(wt, '.env')), 'fixture invalid: worktree has its own .env');
    assert.equal(loadEnvFrom(wt, { home }), 'from-main-root');
  });
});
