/**
 * @fileoverview Contract tests for `scripts/update-auditloop.mjs`.
 *
 * The orchestration cases drive `updateClone` with a recording fake runner, so
 * every assertion is about the command sequence actually issued — including the
 * one that matters most: that no invocation is ever a `push`. A comment saying
 * "this never pushes" is not evidence; the recorded argv is.
 *
 * One test deliberately does NOT use the fake. `runs npm through the production
 * runner` spawns real npm via the real `createCommandRunner`, because the bug
 * this guards is a spawn-layer bug that a mock cannot express: on Windows the
 * npm on PATH is `npm.cmd`, and both `'npm'` (ENOENT) and `'npm.cmd'` (EINVAL
 * under Node's CVE-2024-27980 hardening) fail there while every mocked test
 * stays green. A dependency-repair step that cannot spawn npm is a no-op that
 * reports success, which is exactly the failure this whole script exists to
 * prevent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/fixtures.mjs';
import { createCommandRunner, updateClone } from '../scripts/update-auditloop.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts/update-auditloop.mjs');

const r = (status, stdout = '') => ({ status, stdout, stderr: '' });

/**
 * Recording fake runner. Dispatches on the command shape rather than an exact
 * string so a test states only the condition it cares about.
 */
function makeFake({
  dirty = '',
  statusStatus = 0,
  branch = 'main',
  heads = ['aaaaaaaa1111', 'bbbbbbbb2222'],
  pullStatus = 0,
  manifestDiff = '',
  lsStatus = 0,
  ciStatus = 0,
  skillsStatus = 0,
} = {}) {
  const calls = [];
  let headIdx = 0;
  function run(kind, args) {
    calls.push({ kind, args });
    const j = args.join(' ');
    if (kind === 'git') {
      if (j.startsWith('status')) return r(statusStatus, dirty);
      if (j.startsWith('symbolic-ref')) return branch ? r(0, `${branch}\n`) : r(1, '');
      if (j.startsWith('rev-parse')) return r(0, `${heads[Math.min(headIdx++, heads.length - 1)]}\n`);
      if (j.startsWith('pull')) return r(pullStatus);
      if (j.startsWith('diff')) return r(0, manifestDiff);
    } else if (kind === 'npm') {
      if (j.startsWith('ls')) return r(lsStatus);
      if (j === 'ci') return r(ciStatus);
      if (j.startsWith('run skills:check')) return r(skillsStatus);
    }
    throw new Error(`unexpected command: ${kind} ${j}`);
  }
  return { run, calls };
}

/** A cwd that looks like a clone far enough for the lockfile pre-check. */
function cloneDir() {
  const dir = mkdtemp('update-auditloop-');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  return dir;
}

const issued = (calls) => calls.map(c => `${c.kind} ${c.args.join(' ')}`);

describe('update-auditloop — CLI argument handling', () => {
  it('refuses an unknown flag with exit 2 instead of ignoring it', () => {
    const tmp = mkdtemp('update-auditloop-argv-');
    const res = spawnSync(process.execPath, [CLI, '--dry-runn'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /unknown flag "--dry-runn"/);
    // The typo must be refused BEFORE any repo work — the temp dir is not a git
    // repo, so any git activity would have produced a different failure.
    assert.doesNotMatch(res.stderr, /not a git repository/i);
  });

  it('--selfcheck-relocation prints OK and performs no update', () => {
    const tmp = mkdtemp('update-auditloop-selfcheck-');
    const res = spawnSync(process.execPath, [CLI, '--selfcheck-relocation'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'OK');
    assert.equal(res.stderr.trim(), '');
  });
});

describe('update-auditloop — production command runner', () => {
  it('runs npm through the production runner on this platform', () => {
    // Not a mock: proves the spawn layer works where `npm.cmd` handling bites.
    const run = createCommandRunner({ cwd: REPO_ROOT });
    const res = run('npm', ['--version'], { capture: true });
    assert.equal(res.status, 0, `npm --version failed: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});

describe('update-auditloop — happy path', () => {
  it('fast-forwards a clean clone and checks generated skills', () => {
    const { run, calls } = makeFake();
    const result = updateClone({ cwd: cloneDir(), run });

    assert.equal(result.ok, true);
    assert.equal(result.reason, 'updated');
    assert.equal(result.branch, 'main');
    assert.equal(result.updated, true);
    assert.equal(result.skillsFresh, true);

    const cmds = issued(calls);
    assert.ok(cmds.includes('git pull --ff-only'), cmds.join('\n'));
    assert.ok(cmds.includes('npm run skills:check'), cmds.join('\n'));
  });

  it('reports "already up to date" without a dependency reinstall', () => {
    const { run } = makeFake({ heads: ['aaaaaaaa1111', 'aaaaaaaa1111'] });
    const result = updateClone({ cwd: cloneDir(), run });
    assert.equal(result.ok, true);
    assert.equal(result.updated, false);
    assert.equal(result.ranNpmCi, false);
  });
});

describe('update-auditloop — never pushes', () => {
  it('issues no push in any scenario, successful or failed', () => {
    const scenarios = [
      makeFake(),
      makeFake({ manifestDiff: 'package-lock.json\n' }),
      makeFake({ lsStatus: 1 }),
      makeFake({ skillsStatus: 1 }),
      makeFake({ pullStatus: 1 }),
      makeFake({ dirty: ' M scripts/foo.mjs\n' }),
      makeFake({ branch: '' }),
    ];
    for (const s of scenarios) {
      updateClone({ cwd: cloneDir(), run: s.run });
      for (const call of s.calls) {
        assert.ok(
          !call.args.includes('push'),
          `a push was issued: ${call.kind} ${call.args.join(' ')}`,
        );
      }
    }
  });
});

describe('update-auditloop — dependency repair', () => {
  it('runs npm ci when the pull changed the dependency manifests', () => {
    const { run, calls } = makeFake({ manifestDiff: 'package-lock.json\n' });
    const result = updateClone({ cwd: cloneDir(), run });
    assert.equal(result.ok, true);
    assert.equal(result.manifestChanged, true);
    assert.equal(result.ranNpmCi, true);
    assert.ok(issued(calls).includes('npm ci'));
  });

  it('runs npm ci on an unhealthy tree even when HEAD did not change', () => {
    // The retry case: a previous run fast-forwarded, then died during install.
    // HEAD is unchanged, so the manifest arm sees nothing — only the health arm
    // can rescue this clone.
    const { run, calls } = makeFake({ heads: ['aaaaaaaa1111', 'aaaaaaaa1111'], lsStatus: 1 });
    const result = updateClone({ cwd: cloneDir(), run });
    assert.equal(result.ok, true);
    assert.equal(result.updated, false);
    assert.equal(result.manifestChanged, false);
    assert.equal(result.ranNpmCi, true);
    assert.ok(issued(calls).includes('npm ci'));
  });

  it('skips npm ci when nothing changed and the tree is healthy', () => {
    const { run, calls } = makeFake();
    const result = updateClone({ cwd: cloneDir(), run });
    assert.equal(result.ranNpmCi, false);
    assert.ok(!issued(calls).includes('npm ci'));
  });

  it('fails when a reinstall is needed but no lockfile exists', () => {
    const bare = mkdtemp('update-auditloop-nolock-');
    const { run, calls } = makeFake({ lsStatus: 1 });
    const result = updateClone({ cwd: bare, run });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-lockfile');
    assert.ok(!issued(calls).includes('npm ci'));
  });

  it('fails when npm ci itself fails, and says the pull already landed', () => {
    const { run } = makeFake({ manifestDiff: 'package.json\n', ciStatus: 1 });
    const result = updateClone({ cwd: cloneDir(), run });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'npm-ci-failed');
    assert.match(result.message, /pull succeeded/);
  });
});

describe('update-auditloop — refusals', () => {
  it('aborts on tracked modifications before pulling anything', () => {
    const { run, calls } = makeFake({ dirty: ' M scripts/foo.mjs\n M package.json\n' });
    const result = updateClone({ cwd: cloneDir(), run });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'dirty-tree');
    assert.match(result.message, /scripts\/foo\.mjs/);
    assert.ok(!issued(calls).some(c => c.includes('pull')), 'pulled despite a dirty tree');
  });

  it('ignores untracked and gitignored files (status is run with -uno)', () => {
    const { run, calls } = makeFake();
    const result = updateClone({ cwd: cloneDir(), run });
    assert.equal(result.ok, true);
    const statusCall = calls.find(c => c.args[0] === 'status');
    assert.ok(statusCall.args.includes('--untracked-files=no'), issued(calls).join('\n'));
  });

  it('aborts on a detached HEAD rather than guessing a branch', () => {
    const { run, calls } = makeFake({ branch: '' });
    const result = updateClone({ cwd: cloneDir(), run });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'detached-head');
    assert.ok(!issued(calls).some(c => c.includes('pull')));
  });

  it('aborts on a non-fast-forward pull without attempting recovery', () => {
    const { run, calls } = makeFake({ pullStatus: 1 });
    const result = updateClone({ cwd: cloneDir(), run });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pull-failed');
    const cmds = issued(calls);
    for (const forbidden of ['merge', 'rebase', 'reset', 'stash']) {
      assert.ok(!cmds.some(c => c.includes(forbidden)), `attempted ${forbidden} recovery`);
    }
    assert.ok(!cmds.some(c => c.startsWith('npm')), 'ran npm after a failed pull');
  });
});

describe('update-auditloop — inherited skill drift', () => {
  it('reports stale generated skills as advisory without failing the update', () => {
    const { run } = makeFake({ skillsStatus: 1 });
    const result = updateClone({ cwd: cloneDir(), run });

    // ok:true is the contract main() maps to exit 0 — the pull and the install
    // both landed, and the staleness describes the commit that was pulled.
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'updated-skills-stale');
    assert.equal(result.skillsFresh, false);
    assert.equal(result.updated, true);
  });
});
