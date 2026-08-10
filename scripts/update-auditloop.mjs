#!/usr/bin/env node
/**
 * @fileoverview `update-auditloop` — refresh THIS clone from its own upstream.
 * Pull-only, by construction: it contains no push.
 *
 * **Who this is for.** Deployment shape B in
 * `docs/runbooks/consumer-adoption.md` — a fork/mirror where the bundle IS the
 * repo, cloned by several people on a team. Shape A consumers (skills layered
 * into a product repo) want `sync:refresh` instead; the two are not
 * interchangeable and the distinction is the whole reason this exists:
 *
 *   - `update-auditloop` updates **this clone of the bundle** from its upstream.
 *   - `sync:refresh` copies the bundle **into a separate product repo**.
 *
 * **Why a script rather than three commands in a runbook.** The three commands
 * are `git pull --ff-only`, `npm ci`, `npm run skills:check`, and the failure
 * mode is not that people mistype them — it is that step 2 is conditional and
 * everyone skips it. A pull that changes `package-lock.json` leaves a clone
 * whose `node_modules` no longer matches the lockfile, and the symptom lands
 * later as an unrelated-looking `ERR_MODULE_NOT_FOUND` inside some audit run.
 * Encoding "when must deps be repaired?" once is the smallest honest fix.
 *
 * **Why it must never push.** A mirror's owner may have private remote topology
 * (an upstream to pull from, a private origin to mirror to). That belongs in a
 * machine-local, untracked wrapper on exactly one machine. A *tracked* script
 * that sometimes pushes would run in every teammate's clone, where its notion
 * of "the right remote" is at best unverified. So the tracked half is pull-only
 * and the push half is never written here — a property tested by inspecting the
 * commands actually issued, not by reading the source.
 *
 * **The dependency condition has two arms, and the second is the load-bearing
 * one.** Comparing `HEAD` before/after the pull catches a manifest change, but
 * a previous run could have completed its fast-forward and *then* failed during
 * install. On the retry `HEAD` is unchanged — no manifest delta — while the
 * tree is still broken. So an unhealthy `npm ls` triggers repair on its own.
 * Without that arm the retry is a silent no-op, which is precisely the state a
 * user runs this command to escape.
 *
 * **`npm ci`, never `npm install`.** A shared clone's job is to reproduce the
 * committed lockfile exactly; `npm install` may rewrite it, which then shows up
 * as a dirty tree that blocks the *next* update.
 *
 * **Fast-forward only, and no automatic recovery.** No merge, rebase, reset,
 * stash, or force. Divergence means someone committed to a mirror's `main`, and
 * silently resolving that is how a fork's history quietly stops matching
 * upstream. Report it and stop.
 *
 * Usage:
 *   npm run update-auditloop
 *   node scripts/update-auditloop.mjs --selfcheck-relocation
 *
 * Exit codes:
 *   0 — updated (including when `skills:check` reported inherited staleness,
 *       which is advisory: it describes what was pulled, not a local mistake)
 *   1 — dirty tracked tree, detached HEAD, pull failure, dependency failure
 *   2 — invalid CLI arguments
 *
 * @module scripts/update-auditloop
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { npmInvocation } from './lib/install/deps.mjs';

const KNOWN_FLAGS = ['--selfcheck-relocation'];

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

/**
 * Build the production command runner.
 *
 * Two command families, one deliberate asymmetry:
 *
 *   - **git** — spawned as a direct argument array. No shell, so nothing in a
 *     branch name or a remote URL can be reinterpreted as shell syntax.
 *   - **npm** — routed through {@link npmInvocation}, which runs npm's own JS
 *     entry point under the *current* node binary. On Windows the npm on PATH
 *     is `npm.cmd`; bare `'npm'` fails ENOENT and `'npm.cmd'` fails EINVAL
 *     under Node >= 22.19's CVE-2024-27980 hardening. The usual workaround is
 *     `shell: true`, which fixes the spawn and reopens quoting pitfalls.
 *     Running `npm-cli.js` directly needs no shell at all, and this repo
 *     already depends on that helper elsewhere — a second mechanism for the
 *     same problem would be a second thing to keep correct.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] — directory to run in
 * @param {typeof spawnSync} [opts.spawn] — injectable for tests
 * @returns {(kind: 'git'|'npm', args: string[], opts?: {capture?: boolean}) =>
 *   {status: number, stdout: string, stderr: string}}
 */
export function createCommandRunner({ cwd = process.cwd(), spawn = spawnSync } = {}) {
  return function run(kind, args, { capture = false } = {}) {
    const { bin, prefix } = kind === 'npm'
      ? npmInvocation()
      : { bin: 'git', prefix: [] };
    const res = spawn(bin, [...prefix, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (res.error) {
      return { status: 1, stdout: '', stderr: String(res.error.message || res.error) };
    }
    return {
      status: typeof res.status === 'number' ? res.status : 1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
    };
  };
}

/** @typedef {{ok: boolean, reason: string, message?: string, branch?: string,
 *   before?: string, after?: string, updated?: boolean, ranNpmCi?: boolean,
 *   depsHealthy?: boolean, manifestChanged?: boolean, skillsFresh?: boolean}} UpdateResult */

/**
 * Update the clone at `cwd`. Pure orchestration over an injected `run`, so the
 * tests can assert on the exact command sequence — including the absence of
 * any `push`, which is the one property a reader cannot verify by trusting a
 * comment.
 *
 * @param {object} opts
 * @param {string} opts.cwd — clone root
 * @param {ReturnType<typeof createCommandRunner>} opts.run
 * @param {(msg: string) => void} [opts.log]
 * @returns {UpdateResult}
 */
export function updateClone({ cwd, run, log = () => {} }) {
  // 1. Tracked cleanliness. `--untracked-files=no` is the point: a teammate's
  //    gitignored `.env` and stray local notes are none of this command's
  //    business, and refusing to update because of them would train people to
  //    stop running it.
  const status = run('git', ['status', '--porcelain', '--untracked-files=no'], { capture: true });
  if (status.status !== 0) {
    return { ok: false, reason: 'git-status-failed', message: status.stderr.trim() || 'git status failed' };
  }
  if (status.stdout.trim()) {
    // Split BEFORE trimming. Porcelain v1 is `XY <path>`, and for an unstaged
    // modification X is a space — so trimming the whole blob first eats the
    // first line's status column and `slice(3)` then bites a character off the
    // first filename. Caught by the fixture in the paired test.
    const files = status.stdout
      .split(/\r?\n/)
      .filter(l => l.trim() !== '')
      .map(l => l.slice(3).trimEnd());
    return {
      ok: false,
      reason: 'dirty-tree',
      message: `tracked changes present — commit, stash, or revert them first:\n  ${files.join('\n  ')}`,
    };
  }

  // 2. An attached branch. On a detached HEAD there is no "the branch I am
  //    updating", and guessing one is how a clone silently ends up somewhere
  //    nobody asked for.
  const branchRes = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { capture: true });
  const branch = branchRes.stdout.trim();
  if (branchRes.status !== 0 || !branch) {
    return {
      ok: false,
      reason: 'detached-head',
      message: 'HEAD is detached — check out the branch you want to update (e.g. `git checkout main`).',
    };
  }

  const headBefore = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();

  // 3. Fast-forward or nothing.
  log(`${D}→ git pull --ff-only (${branch})${X}`);
  const pull = run('git', ['pull', '--ff-only']);
  if (pull.status !== 0) {
    return {
      ok: false,
      reason: 'pull-failed',
      branch,
      message:
        'git pull --ff-only failed. Either the branch has diverged from its upstream '
        + '(a mirror\'s main should hold no local commits), or the remote was unreachable. '
        + 'Nothing was merged, rebased, or reset.',
    };
  }
  const headAfter = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();
  const updated = Boolean(headBefore && headAfter && headBefore !== headAfter);

  // 4. Dependency repair — either arm triggers it (see the file header).
  const manifestChanged = updated && run(
    'git',
    ['diff', '--name-only', `${headBefore}..${headAfter}`, '--', 'package.json', 'package-lock.json'],
    { capture: true },
  ).stdout.trim() !== '';

  const depsHealthy = run('npm', ['ls', '--depth=0'], { capture: true }).status === 0;
  const needsInstall = manifestChanged || !depsHealthy;

  let ranNpmCi = false;
  if (needsInstall) {
    if (!fs.existsSync(path.join(cwd, 'package-lock.json'))) {
      return {
        ok: false, reason: 'no-lockfile', branch, before: headBefore, after: headAfter, updated,
        message: 'package-lock.json is missing, so `npm ci` cannot reproduce the committed tree.',
      };
    }
    log(manifestChanged
      ? `${D}→ npm ci (dependency manifests changed in the pull)${X}`
      : `${D}→ npm ci (dependency tree reported unhealthy)${X}`);
    const ci = run('npm', ['ci']);
    if (ci.status !== 0) {
      return {
        ok: false, reason: 'npm-ci-failed', branch, before: headBefore, after: headAfter, updated,
        message: 'npm ci failed. The pull succeeded — re-running this command will retry the install.',
      };
    }
    ranNpmCi = true;
  }

  // 5. Generated-skill freshness. A failure here describes what was *pulled*,
  //    not anything done locally, so it cannot undo a successful update — it is
  //    reported and the exit stays 0.
  log(`${D}→ npm run skills:check${X}`);
  const skills = run('npm', ['run', 'skills:check']);
  const skillsFresh = skills.status === 0;

  return {
    ok: true,
    reason: skillsFresh ? 'updated' : 'updated-skills-stale',
    branch,
    before: headBefore,
    after: headAfter,
    updated,
    manifestChanged,
    depsHealthy,
    ranNpmCi,
    skillsFresh,
  };
}

/**
 * @param {string[]} argv — full `process.argv`
 * @returns {number} exit code
 */
export function main(argv = process.argv) {
  if (argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    return 0;
  }
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'update-auditloop' });

  const cwd = process.cwd();
  const run = createCommandRunner({ cwd });
  const log = (m) => process.stderr.write(`${m}\n`);

  const result = updateClone({ cwd, run, log });

  if (!result.ok) {
    process.stderr.write(`${R}✗${X} update-auditloop: ${result.reason}\n${result.message || ''}\n`);
    return 1;
  }

  const moved = result.updated
    ? `${result.before.slice(0, 8)} → ${result.after.slice(0, 8)}`
    : 'already up to date';
  process.stderr.write(`${G}✓${X} ${result.branch}: ${moved}${result.ranNpmCi ? ' · deps reinstalled' : ''}\n`);
  if (!result.skillsFresh) {
    process.stderr.write(
      `${Y}!${X} skills:check failed on the code you just pulled. This is an inherited\n`
      + `  freshness problem in the upstream commit, not a local mistake, and it did not\n`
      + `  undo the update. Report it upstream rather than regenerating here.\n`,
    );
  }
  process.stderr.write(`${D}  nothing was pushed — this command never pushes.${X}\n`);
  return 0;
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}

export const _internals = Object.freeze({ KNOWN_FLAGS });
