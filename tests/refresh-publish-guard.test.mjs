/**
 * @fileoverview The default-branch publish guard (refresh-publish-guard.mjs).
 *
 * Incident (storyline, 2026-09-29): a local refresh on a feature branch
 * (3a099f75) and a `workflow_dispatch` on a branch (2aea3a7c) each became the
 * ACTIVE index; the scheduled `main` refresh then anchored its incremental diff
 * on those non-`main` commits and copied stale symbols forward — 7 false
 * duplicate clusters against 3 real ones.
 *
 * Every case runs against a real `git` fixture repo, never a mocked answer:
 * the defect was in which commit git said HEAD was, so the thing under test is
 * git's own answer. The runner strips GIT_DIR & co. (`gitFixtureEnv`) so a run
 * from inside the pre-push hook cannot redirect to the real repo.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessPublishEligibility, checkRefreshPublishEligibility, resolveDefaultBranch, ALLOW_BRANCH_PUBLISH_ENV,
} from '../scripts/symbol-index/refresh-publish-guard.mjs';
import { parseArgs, KNOWN_FLAGS } from '../scripts/symbol-index/refresh-args.mjs';
import { gitInit, commit, gitFixtureEnv, makeGitRunner as makeCheckedGit, makeRepoTemplate } from './helpers/fixtures.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

/** Unchecked runner in the shape the guard expects ({status, stdout}). */
const runnerFor = (dir) => (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', env: gitFixtureEnv() });

const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

/** A repo on `main` (named explicitly — init.defaultBranch varies by host) with two commits. */
function initMainRepo(dir) {
  gitInit(dir);
  makeCheckedGit(() => dir)(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  commit(dir, 'a.txt', 'one\n', 'first');
  commit(dir, 'a.txt', 'two\n', 'second');
}

/** `git rev-parse` of a rev in `dir` (copies of a template share their shas). */
const revParse = (dir, rev) => makeCheckedGit(() => dir)(['rev-parse', rev]).trim();

// Built once per file, copied per test (makeRepoTemplate: ~20x cheaper than
// re-running git init + commits in every beforeEach).
const mainRepo = makeRepoTemplate(initMainRepo);
const clonedRepo = makeRepoTemplate((root) => {
  const remote = path.join(root, 'remote');
  fs.mkdirSync(remote);
  initMainRepo(remote);
  makeCheckedGit(() => root)(['clone', '-q', remote, path.join(root, 'clone')]);
});

describe('publish guard — no remote (main/master fallback)', () => {
  let dir; let git; let shas;
  beforeEach(() => {
    dir = mainRepo('publish-guard-');
    git = makeCheckedGit(() => dir);
    shas = { first: revParse(dir, 'HEAD~1'), second: revParse(dir, 'HEAD') };
  });
  afterEach(() => rm(dir));

  it('publishes on the default branch', () => {
    const r = assessPublishEligibility({ run: runnerFor(dir) });
    assert.equal(r.publish, true);
    assert.equal(r.reason, 'default-branch');
    assert.equal(r.defaultBranch, 'main');
    assert.equal(r.branch, 'main');
  });

  it('does NOT publish from a feature branch — even one whose tip equals main', () => {
    // Freshly cut, zero commits of its own: SHA-equality would wrongly say yes.
    git(['checkout', '-q', '-b', 'feature/x']);
    let r = assessPublishEligibility({ run: runnerFor(dir) });
    assert.equal(r.publish, false);
    assert.equal(r.reason, 'not-default-branch');
    assert.equal(r.branch, 'feature/x');

    commit(dir, 'b.txt', 'branch-only\n', 'branch commit');
    r = assessPublishEligibility({ run: runnerFor(dir) });
    assert.equal(r.publish, false);
    assert.equal(r.reason, 'not-default-branch');
  });

  it('publishes when detached at the main tip or at an older main commit (CI checks out a SHA)', () => {
    git(['checkout', '-q', '--detach', shas.second]);
    let r = assessPublishEligibility({ run: runnerFor(dir) });
    assert.equal(r.publish, true, r.detail);
    assert.equal(r.reason, 'detached-on-default-branch');
    assert.equal(r.branch, null);
    assert.equal(r.head, shas.second);

    git(['checkout', '-q', '--detach', shas.first]);
    r = assessPublishEligibility({ run: runnerFor(dir) });
    assert.equal(r.publish, true, r.detail);
  });

  it('does NOT publish when detached at a commit main does not contain (e.g. a branch-only SHA)', () => {
    git(['checkout', '-q', '-b', 'feature/y']);
    const branchOnly = commit(dir, 'c.txt', 'x\n', 'branch-only');
    git(['checkout', '-q', '--detach', branchOnly]);
    const r = assessPublishEligibility({ run: runnerFor(dir) });
    assert.equal(r.publish, false);
    assert.equal(r.reason, 'detached-off-default-branch');
  });

  it('the override publishes from a feature branch — flag and env var', () => {
    git(['checkout', '-q', '-b', 'feature/z']);
    const viaFlag = checkRefreshPublishEligibility({ repoRoot: dir, allowBranchPublish: true, env: {}, run: runnerFor(dir) });
    assert.equal(viaFlag.publish, true);
    assert.equal(viaFlag.reason, 'override');

    const viaEnv = checkRefreshPublishEligibility({ repoRoot: dir, env: { [ALLOW_BRANCH_PUBLISH_ENV]: '1' }, run: runnerFor(dir) });
    assert.equal(viaEnv.publish, true);
    assert.equal(viaEnv.reason, 'override');

    // Only '1' opts in; anything else is the default refusal.
    for (const v of ['0', 'false', '', 'yes']) {
      const r = checkRefreshPublishEligibility({ repoRoot: dir, env: { [ALLOW_BRANCH_PUBLISH_ENV]: v }, run: runnerFor(dir) });
      assert.equal(r.publish, false, `env=${JSON.stringify(v)} must not opt in`);
    }
  });

  it('falls back to master when there is no main', () => {
    git(['branch', '-q', '-m', 'main', 'master']);
    const r = assessPublishEligibility({ run: runnerFor(dir) });
    assert.equal(r.defaultBranch, 'master');
    assert.equal(r.publish, true);
  });

  it('fails CLOSED when no default branch can be resolved', () => {
    git(['branch', '-q', '-m', 'main', 'trunk']);
    const r = assessPublishEligibility({ run: runnerFor(dir) });
    assert.equal(r.publish, false);
    assert.equal(r.reason, 'default-branch-unresolvable');
  });
});

describe('publish guard — cloned repo (origin/HEAD)', () => {
  let root; let remote; let clone; let git;
  beforeEach(() => {
    root = clonedRepo('publish-guard-clone-');
    remote = path.join(root, 'remote');
    clone = path.join(root, 'clone');
    // The clone recorded the remote's path at template-build time; point it at this copy.
    git = makeCheckedGit(() => clone);
    git(['remote', 'set-url', 'origin', remote]);
  });
  afterEach(() => rm(root));

  it('resolves the default branch from origin/HEAD, not from a branch merely named main', () => {
    // The remote's default is `trunk`; a local `main` is then just a branch.
    makeCheckedGit(() => remote)(['branch', '-q', 'trunk']);
    git(['fetch', '-q', 'origin']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    const def = resolveDefaultBranch({ run: runnerFor(clone) });
    assert.equal(def.ok, true);
    assert.equal(def.name, 'trunk');
    assert.equal(def.source, 'origin-head');
    const r = assessPublishEligibility({ run: runnerFor(clone) });
    assert.equal(r.publish, false);
    assert.equal(r.reason, 'not-default-branch');
  });

  it('CI shape: detached at the main SHA with no local main — publishes against origin/main', () => {
    const sha = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', '--detach', sha]);
    git(['branch', '-q', '-D', 'main']);
    const r = assessPublishEligibility({ run: runnerFor(clone) });
    assert.equal(r.publish, true, r.detail);
    assert.equal(r.reason, 'detached-on-default-branch');
    assert.match(r.detail, /refs\/remotes\/origin\/main/);
  });

  it('a PR merge-style detached commit on top of main does NOT publish', () => {
    git(['checkout', '-q', '--detach']);
    commit(clone, 'pr.txt', 'pr\n', 'merge-ish');
    const r = assessPublishEligibility({ run: runnerFor(clone) });
    assert.equal(r.publish, false);
    assert.equal(r.reason, 'detached-off-default-branch');
  });

  it('a dangling origin/HEAD is a refusal, not a guess at main', () => {
    fs.writeFileSync(path.join(clone, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/gone\n');
    const r = assessPublishEligibility({ run: runnerFor(clone) });
    assert.equal(r.publish, false);
    assert.equal(r.reason, 'default-branch-unresolvable');
  });
});

describe('publish guard — git failure fails closed', () => {
  it('a runner that never produced a status never yields publish', () => {
    const dead = () => ({ status: null, error: new Error('spawn ENOENT'), stdout: '' });
    const r = assessPublishEligibility({ run: dead });
    assert.equal(r.publish, false);
    assert.equal(r.reason, 'head-unresolvable');
  });
});

describe('refresh-args — --allow-branch-publish', () => {
  const argv = (...rest) => ['node', 'refresh.mjs', ...rest];
  it('is allow-listed and parsed; off by default', () => {
    assert.ok(KNOWN_FLAGS.includes('--allow-branch-publish'));
    assert.equal(parseArgs(argv()).allowBranchPublish, false);
    assert.equal(parseArgs(argv('--allow-branch-publish')).allowBranchPublish, true);
  });
  it('rejects an inline value', () => {
    assert.throws(() => parseArgs(argv('--allow-branch-publish=true')), /does not take a value/);
  });
});

describe('refresh.mjs wiring (source inspection)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'symbol-index', 'refresh.mjs'), 'utf-8');
  const main = src.slice(src.indexOf('async function main()'));
  it('checks eligibility BEFORE taking the lock or publishing, and exits without either', () => {
    const guard = main.indexOf('checkRefreshPublishEligibility(');
    assert.ok(guard > 0, 'refresh.mjs must call checkRefreshPublishEligibility in main()');
    assert.ok(guard < main.indexOf('acquireRefreshLock('), 'guard must run before the per-repo lock');
    assert.ok(guard < main.indexOf('publishRefreshRun('), 'guard must run before publish');
    assert.match(main, /allowBranchPublish: args\.allowBranchPublish/, 'the CLI flag must reach the guard');
    assert.match(main, /reason: 'not-default-branch'/, 'the skip must be machine-readable on stdout');
  });
});
