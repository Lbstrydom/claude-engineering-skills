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
 *   node scripts/sync-pr.mjs --lease-wait 30     # wait up to 30 min in the machine-lease queue per consumer (default: do not wait)
 *   node scripts/sync-pr.mjs --lease-for 60      # minutes of the heavy slot to ask for per consumer (default 45)
 *   node scripts/sync-pr.mjs --ci-window 25      # after the push, hand the slot to a 25-minute CI window for the consumer
 *
 * Each consumer's push runs the CONSUMER's own pre-push hook - a heavy job - so every consumer is handled under the machine
 * lease (`lib/fleet/lease-run.mjs`, the same code as `fleet lease run`): a refused acquire DEFERS that consumer (nothing is
 * created or pushed), and the slot is released when it finishes, handed to a CI window when anything may have reached the remote.
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
 *   3  nothing errored, but at least one consumer was DEFERRED (the machine lease was not granted); run again later
 *   128+n  stopped by a signal (130 SIGINT, 143 SIGTERM): the current step finished, the slot was released
 *
 * @module scripts/sync-pr
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { resolveTargets, consumerAliases } from './lib/consumer-repos.mjs';
import { MANIFEST_RELATIVE_PATH } from './lib/sync-manifest.mjs';
import { classifyRepo } from './sync-status.mjs';
import { planConsumerPr, runConsumerPr, gatherConsumerFacts, gatherSourceFacts, retrySupersession, supersessionRetryTarget, spawnRunner } from './lib/sync-pr.mjs';
import { scratchPath } from './lib/temp-paths.mjs';
import { repoIdentity } from './lib/fleet/lease-cmd.mjs';
import { LeaseConfigError, machineDir } from './lib/fleet/lease.mjs';
import { exitCodeForSignal, runUnderLease } from './lib/fleet/lease-run.mjs';
import { remoteReachedOf } from './lib/sync-pr-lease.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

const KNOWN_FLAGS = ['--target', '--dry-run', '--no-merge', '--base', '--lease-for', '--lease-wait', '--ci-window'];
/** The checkout this script lives in: the SOURCE repo whose turn a sync run takes (any worktree of it shares one repoKey). */
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

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
 * @returns {{dryRun: boolean, merge: boolean, baseOverride: string|null, target: string|undefined, leaseFor: number, leaseWait: number, ciWindow: number}}
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
  const whole = (name, def, min, max) => {
    const raw = flagValue(name);
    if (raw === undefined) return def;
    if (!/^\d{1,6}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new ArgvError(`sync-pr: ${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(raw)})`);
    return Number(raw);
  };
  return {
    dryRun: rest.includes('--dry-run'),
    merge: !rest.includes('--no-merge'),
    baseOverride: flagValue('--base') ?? null,
    target: flagValue('--target'),
    leaseFor: whole('--lease-for', 45, 1, 180),
    leaseWait: whole('--lease-wait', 0, 0, 720),
    ciWindow: whole('--ci-window', 0, 0, 180),
  };
}

/**
 * Run one consumer's job under the machine lease (the same code as `fleet lease run`). `lease === null` is a test seam that
 * disables it; production passes nothing and gets the real lease. A consumer whose repo cannot be identified, or whose lease
 * cannot be used, is DEFERRED - never run unleased.
 */
async function runLeased({ lease, repoRoot, name, job, opts, out }) {
  if (lease === null) return { ran: true, result: await job({ signal: undefined }) };
  let dir;
  try { dir = lease.dir ?? machineDir(process.env); } catch (e) {
    if (e instanceof LeaseConfigError) return { ran: false, outcome: 'lease-error', reason: e.message };
    throw e;
  }
  // D13: the work belongs to the SOURCE repo (CES started it and schedules it), so it queues and takes turns as that repo; the holder
  // names the target, so two runs for one target are still refused by `exclusive`. The CI window it records stays the TARGET's.
  const target = repoIdentity(repoRoot);
  if (!target) return { ran: false, outcome: 'lease-error', reason: 'could not identify the consumer repository for the lease' };
  const source = repoIdentity(lease.sourceRoot ?? SOURCE_ROOT);
  if (!source) return { ran: false, outcome: 'lease-error', reason: 'could not identify the source repository for the lease' };
  return runUnderLease({
    dir, identity: { repoKey: source.repoKey, holder: `sync-pr:${name}` }, repo: source.repo, windowRepo: { repoKey: target.repoKey, repo: target.repo }, kind: 'gate', forMin: opts.leaseFor, waitMin: opts.leaseWait,
    endTurn: true, releaseToCiWindow: opts.ciWindow, cmdName: 'node scripts/fleet.mjs', log: (m) => out.write(`  ${D}lease: ${m}${X}\n`), ...(lease.inject ?? {}),
  }, job);
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
  // Asked once per run: what the source's HEAD is, so a 'clean' consumer can be told apart from a CURRENT one (da9a).
  const sourceFacts = deps.sourceFacts ?? gatherSourceFacts(run, SOURCE_ROOT);
  const lease = 'lease' in deps ? deps.lease : {};
  const { dryRun, merge, baseOverride, target, leaseFor, leaseWait, ciWindow } = parseArgs(argv);
  const targets = resolve(target);
  if (targets.length === 0) {
    throw new ArgvError(`sync-pr: unknown --target "${target}" — known: ${consumerAliases().join(', ')}`);
  }

  const log = (line) => out.write(`${line}\n`);
  let errored = 0;
  let deferred = 0;
  let interrupted = null;
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
    const plan = planConsumerPr({ consumerName: t.name, classified, manifest, ...facts, ...sourceFacts });

    if (plan.action === 'skip') {
      out.write(`  ${Y}skip${X} ${plan.reason}${plan.detail ? ` ${D}— ${plan.detail}${X}` : ''}\n`);
      // This bundle's sync PR may already exist: retry its supersession, which
      // a first run may have left unsettled (lib/sync-pr.mjs header rule 4).
      const target = supersessionRetryTarget({ plan, manifest, branchExists: facts.branchExists });
      if (target && dryRun) {
        out.write(`  ${D}dry run: supersession retry not attempted${X}\n`);
      } else if (target) {
        out.write(formatRetry(retrySupersession({ ...target, repoRoot, baseBranch, baseSha: facts.baseSha, run, log, ancestry })));
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

    const job = async ({ signal }) => {
      const r = await runConsumerPr({
        plan, repoRoot, baseBranch, currentBranch: facts.currentBranch, merge, run, log, consumerName: t.name, pushLogDir: scratchPath('sync-pr'), ancestry, signal,
      });
      return { ...r, remoteReached: remoteReachedOf(r, { run, repoRoot }) };
    };
    const leased = await runLeased({ lease, repoRoot, name: t.name, job, opts: { leaseFor, leaseWait, ciWindow }, out });
    if (!leased.ran) {
      deferred++;
      out.write(`  ${Y}deferred${X} the machine lease was not granted (${leased.code ?? leased.outcome}): ${leased.reason}${leased.queued ? ` ${D}— queued; run again when it is this repo's turn${X}` : ''}\n`);
      continue;
    }
    const result = leased.result;
    if (leased.released?.mode === 'ci-window') out.write(`  ${D}lease: CI window recorded until ${leased.released.window.until.slice(11, 16)}Z for ${leased.released.window.repo}${X}\n`);
    else if (lease !== null && !ciWindow && result.ok) out.write(`  ${D}lease: the PR's CI is not recorded on the lease (pass --ci-window <min>, or announce it)${X}\n`);
    for (const w of result.warnings) out.write(`  ${Y}⚠${X} ${w}\n`);
    if (result.ok) {
      const mergeNote = { armed: 'squash auto-merge armed', 'not-armed': 'auto-merge NOT armed', skipped: 'no auto-merge (--no-merge)' }[result.merged];
      out.write(`  ${G}PR opened${X} ${result.url ?? '(url not parsed)'} ${D}— ${mergeNote}${X}\n`);
    } else {
      errored++;
      out.write(formatFailure(result));
    }
    if (leased.signalled) { interrupted = leased.signalled; break; }
  }

  out.write(`\n${errored === 0 ? G : R}sync-pr done${X} ${D}— ${errored} error(s)${deferred ? `, ${deferred} deferred` : ''}${interrupted ? `, stopped by ${interrupted}` : ''}${X}\n`);
  if (interrupted) return exitCodeForSignal(interrupted);
  return errored > 0 ? 1 : deferred > 0 ? 3 : 0;
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
