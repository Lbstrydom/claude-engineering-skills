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
 *   node scripts/sync-pr.mjs --base develop      # consumer's base branch (default: the remote's HEAD)
 *
 * The branch forks from a freshly fetched origin/<base>, never the checkout's
 * local branch; a refused push keeps the consumer hook's full output under
 * .claude/tmp/sync-pr/ and names the failing tests (lib/sync-pr.mjs header).
 * A consumer whose sync branch already exists (a same-bundle re-run) gets its
 * open PR's supersession retried — nothing is created or merged.
 *
 * Exit codes:
 *   0  every consumer was either handled or skipped for a named reason
 *   1  at least one consumer errored: its base could not be resolved or fetched,
 *      or it failed mid-sequence (its branch is left for inspection)
 *   2  bad CLI input
 *
 * @module scripts/sync-pr
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { resolveTargets, consumerAliases } from './lib/consumer-repos.mjs';
import { MANIFEST_RELATIVE_PATH } from './lib/sync-manifest.mjs';
import { classifyRepo } from './sync-status.mjs';
import { SKIP_REASON, planConsumerPr, runConsumerPr, gatherConsumerFacts, retrySupersession } from './lib/sync-pr.mjs';
import { scratchPath } from './lib/temp-paths.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

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
 * The lines printed for a failed `runConsumerPr`. A refused push names where
 * its full output was kept and which tests failed — the tail alone is the
 * consumer's summary line, which identified nothing on 2026-10-12.
 * @param {Extract<ReturnType<typeof runConsumerPr>, {ok: false}>} result
 * @returns {string}
 */
export function formatFailure(result) {
  const lines = [`  ${R}failed at ${result.step}${X}: ${result.error.split('\n').slice(-6).join('\n    ')}`];
  if (result.pushLog) {
    const { logPath, writeError, failingTests } = result.pushLog;
    lines.push(logPath ? `  full push/hook output: ${logPath}` : `  ${R}could not write the push log${X}: ${writeError}`);
    if (failingTests.length > 0) {
      lines.push('  failing test(s):', ...failingTests.map((n) => `    ${R}✗${X} ${n}`));
    } else {
      lines.push(`  ${D}no failing test names parsed — read the full output${X}`);
    }
  }
  lines.push(`  ${D}branch ${result.branch} left in place for inspection${X}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The lines printed for a `retrySupersession` result. A retry that ran prints
 * its status and every warning; one that did not names why. Never an error:
 * the existing PR is open either way, as on the first run.
 * @param {ReturnType<typeof retrySupersession>} retry
 * @returns {string}
 */
function formatRetry(retry) {
  const lines = retry.retried
    ? [`  supersession retried for ${retry.url}: ${retry.supersede.status}`]
    : [`  ${D}no supersession retry: ${retry.reason} — ${retry.detail}${X}`];
  for (const w of retry.warnings) lines.push(`  ${Y}⚠${X} ${w}`);
  if (retry.retried && retry.supersede.status === 'complete') {
    lines.push(`  ${D}auto-merge is not armed by a retry — merge ${retry.url} once its checks pass${X}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse sync-pr's flags. Options end at `--`, the same boundary
 * `assertKnownFlags` honours; this CLI takes no positionals, so anything
 * after it is ignored, never read as a flag.
 * @param {string[]} argv — full process argv
 * @returns {{dryRun: boolean, merge: boolean, baseOverride: string|null, target: string|undefined}}
 */
export function parseArgs(argv) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'sync-pr' });
  const all = argv.slice(2);
  const rest = all.includes('--') ? all.slice(0, all.indexOf('--')) : all;
  const flagValue = (name) => {
    const i = rest.indexOf(name);
    if (i === -1) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new ArgvError(`sync-pr: ${name} requires a value`);
    return v;
  };
  return {
    dryRun: rest.includes('--dry-run'),
    merge: !rest.includes('--no-merge'),
    baseOverride: flagValue('--base') ?? null,
    target: flagValue('--target'),
  };
}

/**
 * @param {string[]} argv
 * @param {NodeJS.WriteStream} out
 * @param {{run?: import('./lib/sync-pr.mjs').Runner, resolve?: typeof resolveTargets, classify?: typeof classifyRepo,
 *   ancestry?: (a: string, b: string) => 'yes'|'no'|'unknown'}} [deps] — test seam: fixture repos, never real consumers
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv, out = process.stdout, deps = {}) {
  const { run = spawnRunner, resolve = resolveTargets, classify = classifyRepo, ancestry } = deps;
  const { dryRun, merge, baseOverride, target } = parseArgs(argv);
  const targets = resolve(target);
  if (targets.length === 0) {
    throw new ArgvError(`sync-pr: unknown --target "${target}" — known: ${consumerAliases().join(', ')}`);
  }

  const log = (line) => out.write(`${line}\n`);
  let errored = 0;
  out.write(`${B}sync-pr${X} ${D}${dryRun ? '(dry run) ' : ''}${targets.length} consumer(s), base ${baseOverride ?? "each remote's default branch"}${X}\n`);

  for (const t of targets) {
    const repoRoot = t.path;
    out.write(`\n${B}→ ${t.name}${X} ${D}${repoRoot}${X}\n`);
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
      out.write(`  ${Y}skip${X} not a git checkout on this machine\n`);
      continue;
    }
    const classified = classify(repoRoot);
    const manifest = readManifest(repoRoot);
    const facts = gatherConsumerFacts(run, repoRoot, { baseBranch: baseOverride, commitSha: manifest?.commitSha });
    if (!facts.ok) {
      // Never fall back to the checkout's local branch: that is the stale base
      // the 2026-10-12 incident forked from.
      errored++;
      out.write(`  ${R}failed at ${facts.step}${X}: ${facts.error.split('\n').slice(-4).join('\n    ')}\n`);
      continue;
    }
    const { baseBranch } = facts;
    const plan = planConsumerPr({ consumerName: t.name, classified, manifest, ...facts });

    if (plan.action === 'skip') {
      out.write(`  ${Y}skip${X} ${plan.reason}${plan.detail ? ` ${D}— ${plan.detail}${X}` : ''}\n`);
      if (plan.reason === SKIP_REASON.BRANCH_EXISTS) {
        // This bundle's sync PR already exists: retry its supersession, which
        // a first run may have left unsettled (lib/sync-pr.mjs header rule 4).
        if (dryRun) {
          out.write(`  ${D}dry run: supersession retry not attempted${X}\n`);
          continue;
        }
        const retry = retrySupersession({
          branch: plan.branch, bundleSha: plan.bundleSha, repo: plan.repo, repoRoot, baseBranch, baseSha: facts.baseSha, run, log, ancestry,
        });
        out.write(formatRetry(retry));
      }
      continue;
    }

    const behind = plan.behindCount > 0 ? ` ${D}(this checkout is ${plan.behindCount} behind; origin left every synced path as the sync saw it)${X}` : '';
    out.write(`  branch ${plan.branch} from origin/${baseBranch} ${plan.startPoint.slice(0, 8)}${behind}\n`);
    out.write(`  ${plan.surface.length} surface path(s) + receipt, commit "${plan.title}"\n`);
    for (const p of plan.addPaths) out.write(`    ${D}${p}${X}\n`);
    if (plan.leftBehind.length > 0) {
      out.write(`  ${Y}left uncommitted (needs review)${X}: ${plan.leftBehind.join(', ')}\n`);
    }
    if (dryRun) continue;

    const result = runConsumerPr({
      plan, repoRoot, baseBranch, currentBranch: facts.currentBranch, merge, run, log, consumerName: t.name, pushLogDir: scratchPath('sync-pr'), ancestry,
    });
    for (const w of result.warnings) out.write(`  ${Y}⚠${X} ${w}\n`);
    if (result.ok) {
      const mergeNote = { armed: 'squash auto-merge armed', 'not-armed': 'auto-merge NOT armed', skipped: 'no auto-merge (--no-merge)' }[result.merged];
      out.write(`  ${G}PR opened${X} ${result.url ?? '(url not parsed)'} ${D}— ${mergeNote}${X}\n`);
    } else {
      errored++;
      out.write(formatFailure(result));
    }
  }

  out.write(`\n${errored === 0 ? G : R}sync-pr done${X} ${D}— ${errored} error(s)${X}\n`);
  return errored === 0 ? 0 : 1;
}

const isDirectRun = isInvokedAsScript(import.meta.url);
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
