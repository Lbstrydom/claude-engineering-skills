/**
 * @fileoverview Poisoned-`GIT_DIR`-against-a-victim-repo coverage for every
 * Cluster A production module's new `opts.env` seam (2026-07-23 GIT_DIR-leak
 * sustainability plan). Mirrors tests/git-env-fixture-isolation.test.mjs's
 * pattern, extended to production functions beyond tests/helpers/fixtures.mjs:
 * a clean-environment pass proves `opts.env` is ACCEPTED, not that it reaches
 * every internal `execFileSync`/`spawnSync` hop (round-1 audit M3) — only an
 * actually-poisoned ambient environment proves the threading is real.
 *
 * Also proves the reverse for each module: omitting `opts.env` is byte-
 * identical to the pre-plan behaviour (default production callers are
 * completely unaffected).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { gitCommitSha } from '../scripts/lib/vcs.mjs';
import { resolveDiffScope, sweepStaleOrphanPreimages } from '../scripts/lib/audit/diff-scope-resolver.mjs';
import { countCommitsTouchingTopic } from '../scripts/lib/debt-git-history.mjs';
import { loadCorpusCase } from '../scripts/lib/model-eval/known-defect-corpus.mjs';
import { findRepoPragmas } from '../scripts/lib/duplicate-justification-pragma.mjs';
import { findStalePragmas } from '../scripts/lib/symbol-index/stale-pragma-sweep.mjs';
import { untrackNewlyIgnored } from '../scripts/lib/sync-untrack.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

// Round-4 audit fix: every call site in this file targets a repo that
// ALWAYS has a baseline commit (victim/fixture are both seeded with one in
// their own setup) — a null-swallowing catch here would let a broken
// fixture, a mis-threaded env, or a genuine git regression silently produce
// two matching `null`s and pass, which is exactly the false-green risk this
// file exists to rule out (AGENTS.md: "can this return green without having
// actually checked anything?"). Throw with the failing dir/cause instead.
function headOf(dir, env) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8', env }).trim();
  } catch (err) {
    throw new Error(`headOf(${dir}) failed — this repo is expected to always have a baseline commit: ${err.message}`);
  }
}

describe('Cluster A production modules are immune to a leaked GIT_DIR/GIT_WORK_TREE', () => {
  let victim;
  let victimHead;
  let fixture;
  let savedGitDir, savedGitWorkTree, hadGitDir, hadGitWorkTree;

  before(() => {
    // gitFixtureEnv() here (round-2 audit H2), not the ambient env — this
    // hook runs BEFORE this test poisons process.env itself, but if the
    // AMBIENT process already had a leaked GIT_DIR (e.g. this suite running
    // inside the sandboxed pre-push hook this whole plan is about), the
    // victim repo's own setup would be misdirected before the test even
    // begins. Same class of gap as tests/git-env-fixture-isolation.test.mjs's
    // before() hook, fixed the same way.
    victim = fs.mkdtempSync(path.join(os.tmpdir(), 'clustera-victim-'));
    const setupEnv = gitFixtureEnv();
    execFileSync('git', ['init', '-q'], { cwd: victim, env: setupEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: victim, env: setupEnv });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: victim, env: setupEnv });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'victim baseline'], { cwd: victim, env: setupEnv });
    // Round-3 audit fix (M1/M6): this ran with raw process.env — poisoning
    // hasn't happened YET at this line, but if the AMBIENT process already
    // had a leaked GIT_DIR before this suite even started, this read would
    // capture the WRONG repo's HEAD as the expected baseline, corrupting
    // every assertion below it. Use setupEnv here too, for the same reason
    // the git commands just above it do.
    victimHead = headOf(victim, setupEnv);

    hadGitDir = 'GIT_DIR' in process.env;
    hadGitWorkTree = 'GIT_WORK_TREE' in process.env;
    savedGitDir = process.env.GIT_DIR;
    savedGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = path.join(victim, '.git');
    process.env.GIT_WORK_TREE = victim;
  });

  after(() => {
    if (hadGitDir) process.env.GIT_DIR = savedGitDir; else delete process.env.GIT_DIR;
    if (hadGitWorkTree) process.env.GIT_WORK_TREE = savedGitWorkTree; else delete process.env.GIT_WORK_TREE;
    rmrf(victim);
  });

  // Fresh fixture repo per test, built while GIT_DIR is already poisoned —
  // proving each module's setup path also needs no ambient git state.
  function freshFixture(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const env = gitFixtureEnv();
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'fixture baseline'], { cwd: dir, env });
    return dir;
  }

  it('vcs.mjs::gitCommitSha resolves the fixture, not the victim, when env is supplied', () => {
    fixture = freshFixture('clustera-vcs-');
    try {
      const r = gitCommitSha(fixture, { env: gitFixtureEnv() });
      assert.equal(r.ok, true);
      assert.notEqual(r.sha, victimHead, 'must not silently resolve to the poisoned ambient repo');
      assert.equal(headOf(victim, { ...process.env }), victimHead, 'victim repo untouched');
    } finally { rmrf(fixture); }
  });

  it('diff-scope-resolver.mjs::sweepStaleOrphanPreimages sweeps a worktree registered on the fixture, never touches the victim', () => {
    // Highest-severity call chain: without env, `git worktree remove/list/
    // prune` would run against whatever GIT_DIR points to. A test that never
    // registers a real worktree can't actually exercise this — it would
    // pass identically whether or not env is threaded (verified: reverting
    // the fix left this false-positive green). Register a real stale
    // worktree ON THE FIXTURE and assert the sweep actually finds and
    // removes IT — which only happens if the git calls resolved the
    // fixture, not the leaked victim.
    fixture = freshFixture('clustera-dsr-');
    const fixtureEnv = gitFixtureEnv();
    const preimageHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clustera-dsr-home-'));
    try {
      const stale = path.join(preimageHome, 'orphan-preimage-stale');
      execFileSync('git', ['worktree', 'add', '--detach', '--quiet', stale, 'HEAD'], { cwd: fixture, env: fixtureEnv });
      const old = new Date(Date.now() - 2 * 3600_000);
      fs.utimesSync(stale, old, old);

      const r = sweepStaleOrphanPreimages({ repoPath: fixture, tmpDir: preimageHome, env: fixtureEnv });

      assert.deepEqual(r.swept, [stale], 'the worktree registered on the FIXTURE must be found and swept');
      assert.equal(fs.existsSync(stale), false);
      // The precise assertion: check the FIXTURE's own worktree metadata was
      // actually cleaned via `git worktree remove`, not just the directory
      // deleted by the catch-block's fs.rmSync fallback. That fallback exists
      // for genuine lock/permission failures and fires REGARDLESS of which
      // repo the git call actually targeted — so `fs.existsSync(stale) ===
      // false` alone does NOT prove the git operation hit the fixture (a
      // misdirected git call against the victim would still leave the
      // fixture's own registration dangling, papered over by the fs fallback
      // deleting the directory anyway). This is what actually caught the
      // regression (env threading removed) that the weaker assertions above
      // did not.
      const fixtureWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture, encoding: 'utf-8', env: fixtureEnv });
      assert.doesNotMatch(fixtureWorktrees, /orphan-preimage-stale/,
        'the fixture worktree registry must be genuinely clean, not just the directory deleted by the fs fallback');
      assert.equal(headOf(victim, { ...process.env }), victimHead, 'victim repo untouched');
      const victimWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: victim, encoding: 'utf-8', env: { ...process.env } });
      assert.doesNotMatch(victimWorktrees, /orphan-preimage-stale/, 'the victim must never have known about this worktree');
    } finally { rmrf(fixture); rmrf(preimageHome); }
  });

  it('diff-scope-resolver.mjs::resolveDiffScope resolves the fixture, not the victim', async () => {
    // Round-3 audit fix (M5): `state !== 'SKIPPED_NO_BASELINE'` alone doesn't
    // prove FIXTURE resolution — the victim also has a valid baseline commit,
    // so a misdirected call would produce the same non-skipped state. Give
    // the fixture a distinctive, uncommitted change and assert it's actually
    // FOUND — something only possible if git operated on the fixture, since
    // the victim has no such file at all.
    fixture = freshFixture('clustera-rds-');
    const fixtureEnv = gitFixtureEnv();
    try {
      fs.writeFileSync(path.join(fixture, 'only-in-fixture.mjs'), 'export const x = 1;\n');
      const scope = await resolveDiffScope({ repoPath: fixture, baseRef: 'HEAD', env: fixtureEnv });
      assert.notEqual(scope.state, 'SKIPPED_NO_BASELINE', 'HEAD must resolve inside the fixture, not fail against a mismatched victim');
      const found = scope.changedFiles.some((f) => f.headCallerPath === 'only-in-fixture.mjs' || f.baseCallerPath === 'only-in-fixture.mjs');
      assert.ok(found, 'must find the fixture-only untracked file — proves the diff was actually computed against the fixture, not the victim');
      assert.equal(headOf(victim, { ...process.env }), victimHead, 'victim repo untouched');
    } finally { rmrf(fixture); }
  });

  it('debt-git-history.mjs::countCommitsTouchingTopic queries the fixture, not the victim', () => {
    fixture = freshFixture('clustera-dgh-');
    try {
      fs.mkdirSync(path.join(fixture, '.audit'), { recursive: true });
      fs.writeFileSync(path.join(fixture, '.audit', 'tech-debt.json'), JSON.stringify({ entries: [{ topicId: 'xyz123' }] }));
      const env = gitFixtureEnv();
      execFileSync('git', ['add', '-A'], { cwd: fixture, env });
      execFileSync('git', ['commit', '-q', '-m', 'add xyz123'], { cwd: fixture, env });
      const count = countCommitsTouchingTopic('xyz123', { cwd: fixture, env });
      assert.equal(count, 1, 'must find the commit in the fixture, not silently miss it in the poisoned victim');
      assert.equal(headOf(victim, { ...process.env }), victimHead, 'victim repo untouched');
    } finally { rmrf(fixture); }
  });

  it('known-defect-corpus.mjs::loadCorpusCase reads the fixture, not the victim', () => {
    fixture = freshFixture('clustera-kdc-');
    try {
      const env = gitFixtureEnv();
      fs.writeFileSync(path.join(fixture, 'a.txt'), 'line1\n');
      execFileSync('git', ['add', '.'], { cwd: fixture, env });
      execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: fixture, env });
      const sha = headOf(fixture, env);
      const kd = {
        id: 'KD-ENV-001', repo: path.basename(fixture), buggyCommit: sha,
        files: ['a.txt'], defectDesc: 'x', expectedFindingRubric: 'y', severity: 'LOW',
      };
      const { visibleInput } = loadCorpusCase({ kdEntry: kd, repoRoots: [fixture], env });
      assert.ok(visibleInput.files.includes('a.txt'));
      assert.equal(headOf(victim, { ...process.env }), victimHead, 'victim repo untouched');
    } finally { rmrf(fixture); }
  });

  it('duplicate-justification-pragma.mjs::findRepoPragmas sweeps the fixture, not the victim', () => {
    fixture = freshFixture('clustera-djp-');
    try {
      fs.writeFileSync(path.join(fixture, 'a.mjs'), '// @duplicate-justification: target=b.mjs:foo reason=x\n');
      const pragmas = findRepoPragmas(fixture, { env: gitFixtureEnv() });
      assert.equal(pragmas.length, 1);
      assert.equal(headOf(victim, { ...process.env }), victimHead, 'victim repo untouched');
    } finally { rmrf(fixture); }
  });

  it('stale-pragma-sweep.mjs::findStalePragmas forwards env through to findRepoPragmas (the wrapper Gemini caught)', () => {
    fixture = freshFixture('clustera-sps-');
    try {
      fs.writeFileSync(path.join(fixture, 'a.mjs'), '// @duplicate-justification: target=does-not-exist.mjs:foo reason=x\n');
      const stale = findStalePragmas(fixture, { env: gitFixtureEnv() });
      assert.equal(stale.length, 1, 'must find the stale pragma in the fixture via the forwarded env');
      assert.equal(headOf(victim, { ...process.env }), victimHead, 'victim repo untouched');
    } finally { rmrf(fixture); }
  });

  it('sync-untrack.mjs::untrackNewlyIgnored untracks in the fixture, never removes from the victim index', () => {
    fixture = freshFixture('clustera-sut-');
    try {
      const env = gitFixtureEnv();
      fs.writeFileSync(path.join(fixture, 'cache.json'), '{}');
      execFileSync('git', ['add', 'cache.json'], { cwd: fixture, env });
      execFileSync('git', ['commit', '-q', '-m', 'add cache.json'], { cwd: fixture, env });
      const removed = untrackNewlyIgnored(fixture, ['cache.json'], { env });
      assert.deepEqual(removed, ['cache.json']);
      // The critical assertion: the victim's OWN tracked files must be
      // completely unaffected by this call.
      const victimTracked = execFileSync('git', ['ls-files'], { cwd: victim, encoding: 'utf-8', env: { ...process.env } }).trim();
      assert.doesNotMatch(victimTracked, /cache\.json/, 'must never have touched the victim index');
      assert.equal(headOf(victim, { ...process.env }), victimHead, 'victim repo untouched');
    } finally { rmrf(fixture); }
  });
});
