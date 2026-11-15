/**
 * @fileoverview git's `safe.directory` refusal reaches the user WHOLE, with git's own remedy (consumer report 2026-11-15:
 * every fleet verb failed with "cannot locate the git common dir" and only the first stderr line, which names no fix).
 * Driven by git's real refusal: `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` is git's own switch for exercising this check.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { dubiousOwnership, gitCommonDir } from '../scripts/lib/fleet/git-facts.mjs';

after(cleanupFleetRoots);

const STDERR = "fatal: detected dubious ownership in repository at 'C:/w/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/w/repo\n";

describe('dubious ownership', () => {
  it('dubiousOwnership passes git\'s message and remedy through; anything else is null', () => {
    const r = dubiousOwnership(STDERR);
    assert.match(r, /detected dubious ownership in repository at 'C:\/w\/repo'/);
    assert.match(r, /run: git config --global --add safe\.directory C:\/w\/repo/);
    assert.equal(dubiousOwnership('fatal: not a git repository (or any of the parent directories): .git'), null);
  });

  it('gitCommonDir reports it with its own code (real git refusal)', () => {
    const fx = makeFleetRepo();
    const prev = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    try {
      const r = gitCommonDir(fx.repo);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'DUBIOUS_OWNERSHIP');
      assert.match(r.reason, /safe\.directory/);
    } finally {
      if (prev === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER; else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = prev;
    }
  });

  it('a fleet verb prints git\'s refusal and the safe.directory remedy, not "cannot locate the git common dir"', () => {
    const fx = makeFleetRepo();
    const r = runFleet(['status'], { cwd: fx.repo, env: scrubbedEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /cannot locate the git common dir/);
    assert.match(r.stderr, /git refuses this repository: detected dubious ownership/);
    assert.match(r.stderr, /git config --global --add safe\.directory \S+/);
  });
});
