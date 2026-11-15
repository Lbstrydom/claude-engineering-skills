/**
 * @fileoverview git's `safe.directory` refusal reaches the user WHOLE, with git's own remedy (consumer report 2026-11-15:
 * every fleet verb failed with "cannot locate the git common dir" and only the first stderr line, which names no fix).
 * Driven by git's real refusal: `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` is git's own switch for exercising this check.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { dubiousOwnership, gitCommonDir, unquoteShellArg } from '../scripts/lib/fleet/git-facts.mjs';

after(cleanupFleetRoots);

const STDERR = "fatal: detected dubious ownership in repository at 'C:/w/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/w/repo\n";

describe('dubious ownership', () => {
  it('dubiousOwnership passes git\'s message and remedy through; anything else is null', () => {
    const r = dubiousOwnership(STDERR);
    assert.match(r, /detected dubious ownership in repository at 'C:\/w\/repo'/);
    assert.match(r, /git config --global --add safe\.directory C:\/w\/repo/);
    // Both causes, both remedies, and that fleet itself changes nothing (second consumer report).
    assert.match(r, /owned by another account, or this process runs under a different \(sandboxed or elevated\) token/);
    assert.match(r, /takeown \/F C:\/w\/repo \/R \/D Y/);
    assert.match(r, /fleet changes nothing/);
    assert.equal(dubiousOwnership('fatal: not a git repository (or any of the parent directories): .git'), null);
  });

  it('a path with an apostrophe and a space is taken whole and quoted, never truncated (audit R1 H4)', () => {
    const r = dubiousOwnership("fatal: detected dubious ownership in repository at 'C:/w/O'Brien repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory \"C:/w/O'Brien repo\"\n");
    assert.ok(r.includes("takeown /F 'C:/w/O''Brien repo' /R /D Y"), r);
    assert.doesNotMatch(r, /takeown \/F 'C:\/w\/O' /);
    // git's own sq-quoting of an apostrophe ('O'\''Brien') is decoded, never passed through mangled (audit R4 H1/M1).
    const sq = dubiousOwnership("fatal: detected dubious ownership in repository at 'C:/w/O'Brien'\n\tgit config --global --add safe.directory 'C:/w/O'\\''Brien'\n");
    assert.ok(sq.includes("takeown /F 'C:/w/O''Brien' /R /D Y"), sq);
    assert.equal(unquoteShellArg("'C:/w/O'\\''Brien'"), "C:/w/O'Brien");
    assert.equal(unquoteShellArg('"C:/my \\"x\\" repo"'), 'C:/my "x" repo');
    assert.equal(unquoteShellArg("'unbalanced"), null);
    // A single-quoted suggestion is unwrapped the same way (audit R2 M1).
    const single = dubiousOwnership("fatal: detected dubious ownership in repository at 'C:/my repo'\n\tgit config --global --add safe.directory 'C:/my repo'\n");
    assert.ok(single.includes("takeown /F 'C:/my repo' /R /D Y"), single);
  });

  // The refusal must be REAL and must be shown to be real (CI #368, run 43759381100): on the ubuntu runner git did not refuse
  // under GIT_TEST_ASSUME_DIFFERENT_OWNER alone, because a machine/user `safe.directory` entry outside the test still applies.
  // So the test isolates git's config (no system file, an empty global one) and first PROBES that git refuses with exactly
  // that environment; if it does not, the test skips and says why — never a vacuous pass.
  const refusalEnv = () => {
    const dir = tmpRoot('dubious-cfg-');
    const globalCfg = path.join(dir, 'empty.gitconfig');
    fs.writeFileSync(globalCfg, '');
    return { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalCfg };
  };
  const probe = (repo, extra) => spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, env: { ...scrubbedEnv(), ...extra }, encoding: 'utf8' });
  const refuses = (r) => r.status !== 0 && /dubious ownership/i.test(r.stderr ?? '');
  const skipWhy = (r) => `git (${spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim()}) did not refuse with an isolated config and GIT_TEST_ASSUME_DIFFERENT_OWNER=1 (status ${r.status}, stderr ${JSON.stringify((r.stderr ?? '').trim().slice(0, 200))}): this platform cannot produce the refusal`;

  it('CONTROL: the isolated environment really makes git refuse (or the platform is named as unable to)', (t) => {
    const fx = makeFleetRepo();
    const extra = refusalEnv();
    const r = probe(fx.repo, extra);
    if (!refuses(r)) { t.skip(skipWhy(r)); return; }
    // And the refusal is the switch, not an accident of the isolation: without it the same environment succeeds.
    const { GIT_TEST_ASSUME_DIFFERENT_OWNER, ...noSwitch } = extra;
    assert.equal(probe(fx.repo, noSwitch).status, 0);
  });

  it('gitCommonDir reports it with its own code (real git refusal)', (t) => {
    const fx = makeFleetRepo();
    const extra = refusalEnv();
    const r0 = probe(fx.repo, extra);
    if (!refuses(r0)) { t.skip(skipWhy(r0)); return; }
    const prev = Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]]));
    Object.assign(process.env, extra);
    try {
      const r = gitCommonDir(fx.repo);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'DUBIOUS_OWNERSHIP');
      assert.match(r.reason, /safe\.directory/);
    } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('a fleet verb prints git\'s refusal and the safe.directory remedy, not "cannot locate the git common dir"', (t) => {
    const fx = makeFleetRepo();
    const extra = refusalEnv();
    const r0 = probe(fx.repo, extra);
    if (!refuses(r0)) { t.skip(skipWhy(r0)); return; }
    const r = runFleet(['status'], { cwd: fx.repo, env: scrubbedEnv(extra) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /cannot locate the git common dir/);
    assert.match(r.stderr, /git refuses this repository: detected dubious ownership/);
    assert.match(r.stderr, /git config --global --add safe\.directory \S+/);
  });
});
