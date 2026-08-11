/**
 * @fileoverview THE PIN for the 2026-07-23 GIT_DIR-leak incident: six live
 * HEAD corruptions in one session, root-caused to git's own hook-invocation
 * machinery exporting GIT_DIR/GIT_WORK_TREE into the pre-push hook's
 * process (documented, githooks(5)), inherited by `npm run check`, then
 * inherited again by every test fixture helper that spawned `git` with an
 * explicit `cwd` and no `env` override — so git ignored `cwd` entirely and
 * fixture commits ("seed", "init", "add data + readme") landed on the real
 * repo's real HEAD.
 *
 * This test reproduces the leak DELIBERATELY, against two disposable
 * throwaway repos (never the real repo), and proves the fixture helpers in
 * tests/helpers/fixtures.mjs are now immune to it. Without this test, "we
 * patched it" is unverifiable by inspection alone — which is exactly how
 * six incidents happened despite the vulnerable code being, in isolation,
 * unremarkable-looking `execFileSync('git', ..., {cwd})` calls.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitInit, gitInitWithEmptyCommit, commit, makeGitRunner, gitFixtureEnv, makeRepoTemplate } from './helpers/fixtures.mjs';

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

function headOf(dir, env) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8', env }).trim();
  } catch {
    return null; // no commits yet — a valid, expected state for a fresh gitInit()
  }
}

describe('fixture helpers are immune to a leaked GIT_DIR/GIT_WORK_TREE', () => {
  let victim;
  let savedGitDir;
  let savedGitWorkTree;
  let hadGitDir;
  let hadGitWorkTree;

  before(() => {
    // A real, disposable git repo standing in for "the real checkout" whose
    // HEAD a leak would otherwise hijack. This is the ONLY repo any escaped
    // command could reach — never the actual claude-engineering-skills repo.
    //
    // 2026-07-24 audit fix (H3): these setup calls now use gitFixtureEnv(),
    // not the ambient env — this before() hook runs BEFORE this test poisons
    // process.env itself, but if the AMBIENT process already had a leaked
    // GIT_DIR (e.g. this very test running inside the sandboxed pre-push hook
    // this whole plan is about), the victim repo's own setup would be
    // misdirected before the test even begins, silently invalidating it.
    victim = fs.mkdtempSync(path.join(os.tmpdir(), 'git-leak-victim-'));
    const setupEnv = gitFixtureEnv();
    execFileSync('git', ['init', '-q'], { cwd: victim, env: setupEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: victim, env: setupEnv });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: victim, env: setupEnv });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'victim baseline'], { cwd: victim, env: setupEnv });

    // Simulate exactly what a git hook invocation leaks into a child process
    // (githooks(5)): GIT_DIR/GIT_WORK_TREE pointing at the victim repo.
    hadGitDir = 'GIT_DIR' in process.env;
    hadGitWorkTree = 'GIT_WORK_TREE' in process.env;
    savedGitDir = process.env.GIT_DIR;
    savedGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = path.join(victim, '.git');
    process.env.GIT_WORK_TREE = victim;
  });

  after(() => {
    // Restore exactly (present vs. absent), not just "delete" — a test file
    // that runs after this one in the same process must not inherit a
    // leftover GIT_DIR that was never actually part of its own environment.
    if (hadGitDir) process.env.GIT_DIR = savedGitDir; else delete process.env.GIT_DIR;
    if (hadGitWorkTree) process.env.GIT_WORK_TREE = savedGitWorkTree; else delete process.env.GIT_WORK_TREE;
    rmrf(victim);
  });

  it('the leak is real: an UNPROTECTED git call (no env override) does redirect to the victim', () => {
    // Proves the injected GIT_DIR/GIT_WORK_TREE actually work as a leak
    // simulation — if this assertion ever fails, the whole test's premise is
    // broken and the "immune" assertions below would be meaningless.
    const before_ = headOf(victim, { ...process.env });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'git-leak-scratch-unprotected-'));
    try {
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'UNPROTECTED-should-hit-victim'], { cwd: scratch });
      const after_ = headOf(victim, { ...process.env });
      assert.notEqual(after_, before_, 'the leak simulation itself must move the victim HEAD when unprotected');
      assert.equal(fs.existsSync(path.join(scratch, '.git')), false, 'no .git should appear in the scratch dir — that IS the bug');
    } finally {
      rmrf(scratch);
    }
  });

  it('gitInit + commit() build a fixture in its OWN dir, not the victim', () => {
    const victimHeadBefore = headOf(victim, { ...process.env });
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'git-leak-fixture-'));
    try {
      gitInit(fixture);
      const sha = commit(fixture, 'file.txt', 'hello', 'seed');

      assert.equal(fs.existsSync(path.join(fixture, '.git')), true, 'the fixture dir must get its own .git');
      assert.equal(headOf(fixture, gitFixtureEnv()), sha, 'the fixture repo must actually contain the commit');
      assert.equal(headOf(victim, { ...process.env }), victimHeadBefore, 'the victim repo must be COMPLETELY untouched');
    } finally {
      rmrf(fixture);
    }
  });

  it('gitInitWithEmptyCommit does not leak its "init" commit onto the victim', () => {
    const victimHeadBefore = headOf(victim, { ...process.env });
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'git-leak-fixture-'));
    try {
      gitInitWithEmptyCommit(fixture);
      const fixtureHead = headOf(fixture, gitFixtureEnv());
      assert.notEqual(fixtureHead, null, 'the fixture must have its own init commit');
      assert.equal(headOf(victim, { ...process.env }), victimHeadBefore, 'the victim repo must be COMPLETELY untouched');
    } finally {
      rmrf(fixture);
    }
  });

  it('makeGitRunner()-produced runner operates on its own cwd, not the victim', () => {
    const victimHeadBefore = headOf(victim, { ...process.env });
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'git-leak-fixture-'));
    try {
      gitInitWithEmptyCommit(fixture);
      const git = makeGitRunner(() => fixture);
      git(['commit', '--allow-empty', '-m', 'via-runner']);
      const log = git(['log', '--oneline']);

      assert.match(log, /via-runner/);
      assert.equal(headOf(victim, { ...process.env }), victimHeadBefore, 'the victim repo must be COMPLETELY untouched');
    } finally {
      rmrf(fixture);
    }
  });
});

// ── makeRepoTemplate — build once, copy many (2026-08-11) ───────────────────
//
// `ship-commit-cli.test.mjs` rebuilt an identical git repo in `beforeEach`:
// 406 ms x 26 tests = 10.6 s of a 44.9 s file, none of it testing anything.
// Building once and `fs.cpSync`-ing costs 19 ms (21.9x measured), and took the
// file to 26.5 s with identical pass/fail/skip counts.
//
// The optimisation is only sound if a COPY is a real, independent repo. The
// dangerous failure is silent: hand out the template itself (or a shallow
// alias) and tests corrupt each other's fixtures in ways that surface as
// unrelated flakes months later. So these pin independence and functionality,
// not merely that a directory appeared.
describe('makeRepoTemplate — copies are real, private repos', () => {
  const made = [];
  const seeded = makeRepoTemplate((dir) => {
    gitInit(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
    const g = makeGitRunner(() => dir);
    g(['add', 'README.md']);
    g(['commit', '-q', '-m', 'seed']);
  });
  const mk = (p) => { const d = seeded(p); made.push(d); return d; };
  after(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('a copy is a WORKING git repo — the equivalence the speed-up rests on', () => {
    const repo = mk('tpl-a-');
    const rev = execFileSync('git', ['rev-list', '--count', 'HEAD'],
      { cwd: repo, encoding: 'utf-8', env: gitFixtureEnv() }).trim();
    assert.equal(rev, '1', 'the copied repo must have the template\'s commit and be queryable');
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf-8'), 'seed\n');
  });

  it('a copy can be committed into — it is not a frozen or detached artifact', () => {
    const repo = mk('tpl-b-');
    fs.writeFileSync(path.join(repo, 'next.txt'), 'x\n');
    const g = makeGitRunner(() => repo);
    g(['add', 'next.txt']);
    g(['commit', '-q', '-m', 'second']);
    const rev = execFileSync('git', ['rev-list', '--count', 'HEAD'],
      { cwd: repo, encoding: 'utf-8', env: gitFixtureEnv() }).trim();
    assert.equal(rev, '2');
  });

  it('copies are INDEPENDENT — the failure mode that would corrupt tests silently', () => {
    const a = mk('tpl-c-');
    const b = mk('tpl-d-');
    assert.notEqual(a, b, 'each call must yield its own directory');

    fs.writeFileSync(path.join(a, 'only-in-a.txt'), 'a\n');
    fs.rmSync(path.join(a, 'README.md'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

    assert.equal(fs.existsSync(path.join(b, 'only-in-a.txt')), false, 'a write in one copy must not reach another');
    assert.equal(fs.existsSync(path.join(b, 'README.md')), true, 'a delete in one copy must not reach another');

    // …and the TEMPLATE itself must survive, or copy N+1 inherits copy N's damage.
    const c = mk('tpl-e-');
    assert.equal(fs.existsSync(path.join(c, 'README.md')), true,
      'a later copy must come from the pristine template, not from a mutated sibling');
    assert.equal(fs.existsSync(path.join(c, 'only-in-a.txt')), false);
  });

  it('builds exactly ONCE however many copies are taken', () => {
    // If the build ran per call the helper would be a rename of the problem.
    let builds = 0;
    const t = makeRepoTemplate((dir) => { builds += 1; fs.writeFileSync(path.join(dir, 'f'), 'x'); });
    const dirs = [t('tpl-f-'), t('tpl-f-'), t('tpl-f-')];
    made.push(...dirs);
    assert.equal(builds, 1, `expected one build for three copies, got ${builds}`);
    for (const d of dirs) assert.equal(fs.readFileSync(path.join(d, 'f'), 'utf-8'), 'x');
  });

  it('a failing build THROWS and is never handed out as an empty fixture', () => {
    // Fail-closed: a silently degraded fixture is how a suite goes green having
    // tested a repo that is not the one it describes.
    const t = makeRepoTemplate(() => { throw new Error('git exploded'); });
    assert.throws(() => t('tpl-g-'), /fixture template build failed: git exploded/);
  });
});
