#!/usr/bin/env node
/**
 * @fileoverview `sync-pr` — for every registered consumer, commit the group of
 * paths the last bundle sync wrote (and ONLY that group), push it on a
 * `chore/sync-<sha>` branch, open a PR and arm squash auto-merge.
 *
 * Zero-touch companion to `npm run sync`: the sync still never commits in a
 * consumer (see `lib/sync-receipt.mjs`), and a consumer's protected default
 * branch keeps its PR gate — this just does the branch/commit/push/PR dance
 * the maintainer used to do by hand after every upstream push. Decision
 * rules, and why a ruleset bypass was rejected: `lib/sync-pr.mjs`'s header.
 *
 * Usage:
 *   node scripts/sync-pr.mjs                     # every registered consumer
 *   node scripts/sync-pr.mjs --target wine       # one consumer, by alias or name
 *   node scripts/sync-pr.mjs --dry-run           # print the plan, touch nothing
 *   node scripts/sync-pr.mjs --no-merge          # open the PR, leave merging to a human
 *   node scripts/sync-pr.mjs --base develop      # consumer's base branch (default: main)
 *
 * Exit codes:
 *   0  every consumer was either handled or skipped for a named reason
 *   1  at least one consumer errored mid-sequence (its branch is left for inspection)
 *   2  bad CLI input
 *
 * @module scripts/sync-pr
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { resolveTargets, consumerAliases } from './lib/consumer-repos.mjs';
import { MANIFEST_RELATIVE_PATH } from './lib/sync-manifest.mjs';
import { classifyRepo } from './sync-status.mjs';
import { planConsumerPr, runConsumerPr, branchNameFor } from './lib/sync-pr.mjs';

const KNOWN_FLAGS = ['--target', '--dry-run', '--no-merge', '--base'];
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

/** @type {import('./lib/sync-pr.mjs').Runner} */
function spawnRunner(cmd, args, { cwd, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    // A consumer's pre-push hook can run its whole test suite; no timeout here.
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** @param {string} repoRoot @returns {{repo?: string, commitSha?: string|null}|null} */
function readManifest(repoRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, MANIFEST_RELATIVE_PATH), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Facts about the consumer checkout that `planConsumerPr` needs and cannot
 * derive itself: current branch, distance ahead of `origin/<base>`, and
 * whether the would-be branch already exists locally or on the remote.
 * @param {import('./lib/sync-pr.mjs').Runner} run
 */
function gatherFacts(run, repoRoot, baseBranch, commitSha) {
  const git = (args) => run('git', ['-C', repoRoot, ...args]);
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = head.status === 0 ? head.stdout.trim() : null;
  // Refresh the base ref first so "ahead" is measured against what is on the
  // remote NOW, not what this checkout last saw. A fetch failure (offline)
  // leaves aheadCount null, which the planner refuses rather than guesses.
  const fetched = git(['fetch', '--quiet', 'origin', baseBranch]);
  let aheadCount = null;
  if (fetched.status === 0) {
    const ahead = git(['rev-list', '--count', `origin/${baseBranch}..HEAD`]);
    if (ahead.status === 0 && /^\d+$/.test(ahead.stdout.trim())) aheadCount = Number(ahead.stdout.trim());
  }
  const branch = branchNameFor(commitSha ?? 'unknown');
  const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const remote = git(['ls-remote', '--heads', 'origin', branch]);
  const branchExists = local.status === 0 || (remote.status === 0 && remote.stdout.trim() !== '');
  return { currentBranch, aheadCount, branchExists, fetchFailed: fetched.status !== 0 };
}

/**
 * @param {string[]} argv
 * @param {NodeJS.WriteStream} out
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv, out = process.stdout) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'sync-pr' });
  const rest = argv.slice(2);
  const flagValue = (name) => {
    const i = rest.indexOf(name);
    if (i === -1) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new ArgvError(`sync-pr: ${name} requires a value`);
    return v;
  };
  const dryRun = rest.includes('--dry-run');
  const merge = !rest.includes('--no-merge');
  const baseBranch = flagValue('--base') ?? 'main';
  const target = flagValue('--target');
  const targets = resolveTargets(target);
  if (targets.length === 0) {
    throw new ArgvError(`sync-pr: unknown --target "${target}" — known: ${consumerAliases().join(', ')}`);
  }

  const run = spawnRunner;
  const log = (line) => out.write(`${line}\n`);
  let errored = 0;
  out.write(`${B}sync-pr${X} ${D}${dryRun ? '(dry run) ' : ''}${targets.length} consumer(s), base ${baseBranch}${X}\n`);

  for (const t of targets) {
    const repoRoot = t.path;
    out.write(`\n${B}→ ${t.name}${X} ${D}${repoRoot}${X}\n`);
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
      out.write(`  ${Y}skip${X} not a git checkout on this machine\n`);
      continue;
    }
    const classified = classifyRepo(repoRoot);
    const manifest = readManifest(repoRoot);
    const facts = gatherFacts(run, repoRoot, baseBranch, manifest?.commitSha);
    const plan = planConsumerPr({ consumerName: t.name, classified, manifest, baseBranch, ...facts });

    if (plan.action === 'skip') {
      out.write(`  ${Y}skip${X} ${plan.reason}${plan.detail ? ` ${D}— ${plan.detail}${X}` : ''}\n`);
      if (facts.fetchFailed) out.write(`  ${D}(git fetch origin ${baseBranch} failed — offline?)${X}\n`);
      continue;
    }

    out.write(`  branch ${plan.branch}: ${plan.surface.length} surface path(s) + receipt, commit "${plan.title}"\n`);
    for (const p of plan.addPaths) out.write(`    ${D}${p}${X}\n`);
    if (plan.leftBehind.length > 0) {
      out.write(`  ${Y}left uncommitted (needs review)${X}: ${plan.leftBehind.join(', ')}\n`);
    }
    if (dryRun) continue;

    const result = runConsumerPr({ plan, repoRoot, baseBranch, currentBranch: facts.currentBranch, merge, run, log });
    for (const w of result.warnings) out.write(`  ${Y}⚠${X} ${w}\n`);
    if (result.ok) {
      const mergeNote = { armed: 'squash auto-merge armed', 'not-armed': 'auto-merge NOT armed', skipped: 'no auto-merge (--no-merge)' }[result.merged];
      out.write(`  ${G}PR opened${X} ${result.url ?? '(url not parsed)'} ${D}— ${mergeNote}${X}\n`);
    } else {
      errored++;
      out.write(`  ${R}failed at ${result.step}${X}: ${result.error.split('\n').slice(-6).join('\n    ')}\n`);
      out.write(`  ${D}branch ${result.branch} left in place for inspection${X}\n`);
    }
  }

  out.write(`\n${errored === 0 ? G : R}sync-pr done${X} ${D}— ${errored} error(s)${X}\n`);
  return errored === 0 ? 0 : 1;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    const code = await main();
    await finishAndExit(code);
  } catch (err) {
    if (err instanceof ArgvError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}
