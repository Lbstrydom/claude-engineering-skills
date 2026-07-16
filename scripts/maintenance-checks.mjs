#!/usr/bin/env node
/**
 * @fileoverview Local replica of the 5 weekly GitHub Actions maintenance
 * workflows (architectural-drift, migration-drift, model-freshness,
 * memory-health, learning-weekly-review) plus cache-hitrate-check, for
 * operators whose org blocks GitHub-hosted Actions runners (or who just
 * prefer local-only). Opt-in, default-OFF — see docs/runbooks/local-maintenance-checks.md.
 *
 * Deliberately NOT an OS-scheduled job (schtasks/launchd/cron). This repo's
 * standing local-first-CI convention treats calendar workflows as
 * "opportunistic catch-up" driven from the pre-push hook, not a
 * background daemon — see install-prepush-hook.mjs's opportunistic block.
 * A machine-scheduled job invites a class of silent failure (wrong PATH/cwd,
 * no loaded .env, asleep-at-trigger-time) this repo has already been burned
 * by twice (the dead cache-hitrate weekly routine; the tiered-recall
 * "met" window that was 20/20 silent fallbacks).
 *
 * IMPORTANT: this script itself runs synchronously and can take minutes (6
 * checks, one of which bundles 3 subprocess steps). The pre-push hook
 * backgrounds + detaches it (round-1 audit H1: an earlier version appended
 * `|| true`, which only suppresses the exit code — it does NOT make a
 * command asynchronous, so `git push` was blocking for up to ~40 minutes).
 * Every run — manual or opportunistic — takes a single-instance lock
 * (`.audit-loop/.maintenance.lock`, via `lib/brainstorm/file-lock.mjs`) so
 * two overlapping invocations can't run the same DB-mutating checks
 * concurrently (round-3 audit H1: the lock originally covered only the
 * opportunistic path, so an attended `maintenance:run` could still overlap
 * a backgrounded push-triggered run).
 *
 * Each check is individually skippable when its required env var is
 * absent — never hard-fails the whole run because one check's dependency
 * is missing. Every invocation writes a heartbeat to
 * `.audit-loop/last-maintenance.json` (gitignored — generated, volatile
 * provenance) so `--opportunistic` mode and `--status` can tell how
 * overdue the last run is. A check that was skipped last time for missing
 * env, but now has that env available, runs immediately rather than
 * waiting out the rest of the interval (round-1 audit M1/M5/H2).
 *
 * Usage:
 *   node scripts/maintenance-checks.mjs                 — run all checks now (human output)
 *   node scripts/maintenance-checks.mjs --json           — machine-readable
 *   node scripts/maintenance-checks.mjs --status         — report last-run heartbeat, run nothing
 *   node scripts/maintenance-checks.mjs --opportunistic  — no-op unless AUDIT_LOOP_WEEKLY_MAINTENANCE=1
 *                                                          AND (the heartbeat is overdue (default 7 days)
 *                                                          OR a previously-skipped check's env is now available)
 *
 * @module scripts/maintenance-checks
 */

// config.mjs (not bare 'dotenv/config') so a shared ~/.audit-loop.env DSN is
// picked up the same way cache-hitrate-check.mjs and every other CLI here does.
import './lib/config.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
// Round-3 audit M3 (accepted, not relocated here): this module lives under
// lib/brainstorm/ despite being generic filesystem-lock infrastructure —
// scripts/requirements.mjs is ALSO an independent non-brainstorm consumer,
// which is real evidence it's misplaced, not a violation this feature
// introduces. Root cause: historical placement, no cross-cutting lib/
// home existed when it was written. Minimal fix considered and rejected
// as out-of-scope here: moving it (updating both existing import sites +
// domain-map.json + re-running arch:refresh) is a legitimate but separate
// cleanup, not something to bundle into an unrelated opt-in feature.
// Residual risk: architecture-intent.md will keep flagging this edge for
// every future consumer until the module is relocated.
import { withFileLock, LockTimeoutError } from './lib/brainstorm/file-lock.mjs';

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

const REPO_ROOT = findRepoRootFromScript(import.meta.url);
const SCRIPTS_DIR = import.meta.dirname;
const HEARTBEAT_PATH = path.join(REPO_ROOT, '.audit-loop', 'last-maintenance.json');
const LOCK_PATH = path.join(REPO_ROOT, '.audit-loop', '.maintenance.lock');
const DEFAULT_INTERVAL_DAYS = 7;

/**
 * One entry per replicated workflow. `requiredEnv` gates the whole check —
 * missing env → `skipped`, never attempted. `steps` mirror what the matching
 * npm script(s) actually run, so this stays a straight port rather than a
 * reimplementation. `arch-maintenance` bundles refresh+drift+prune into one
 * check (matching architectural-drift.yml, which runs all three as one job,
 * each step independent of the previous step's exit) — kept as ONE entry,
 * not three, so "6 checks" is accurate everywhere it's documented (round-1
 * audit L2/L3 caught a 6-vs-8 miscount from the earlier 3-way split).
 *
 * NOTE (round-1 audit M7, accepted as documented debt, not fixed here): this
 * list is a hand-maintained parallel of the workflow YAML + npm scripts,
 * with no shared source of truth or drift check between them. Root cause:
 * consumer repos don't get this repo's package.json scripts synced (only
 * scripts/*.mjs are), so shelling to `npm run <name>` isn't reliable in a
 * consumer — each entry must name its own script + args directly. Minimal
 * fix considered and rejected as over-engineering for a v1 opt-in feature:
 * deriving this list at runtime from the workflow YAML. Residual risk: a
 * renamed CLI flag or added required env in the corresponding workflow (see
 * the file pointer per entry below) can silently diverge until a manual run
 * fails. Revisit if that actually happens in practice.
 */
export const CHECKS = [
  {
    key: 'arch-maintenance', // .github/workflows/architectural-drift.yml
    label: 'Architectural memory refresh + drift sweep + retention prune',
    requiredEnv: ['AUDIT_DB_URL'],
    steps: [
      { script: 'symbol-index/refresh.mjs', args: [] },
      { script: 'symbol-index/drift.mjs', args: [] },
      { script: 'symbol-index/prune.mjs', args: [] },
    ],
  },
  {
    key: 'migration-drift', // .github/workflows/migration-drift.yml
    label: 'Postgres migration drift',
    requiredEnv: ['AUDIT_DB_URL'],
    steps: [{ script: 'setup-postgres.mjs', args: ['--check-drift'] }],
  },
  {
    key: 'model-freshness', // .github/workflows/model-freshness.yml
    label: 'Model catalog freshness',
    requiredEnv: [],
    steps: [{ script: 'check-model-freshness.mjs', args: [] }],
  },
  {
    key: 'memory-health', // .github/workflows/memory-health.yml
    label: 'Findings-memory health gate',
    requiredEnv: ['AUDIT_DB_URL'],
    steps: [{ script: 'memory-health.mjs', args: [] }],
  },
  {
    key: 'learning-weekly-review', // .github/workflows/learning-weekly-review.yml
    label: 'Learning-system weekly review',
    requiredEnv: ['AUDIT_DB_URL', 'LEARNING_REPO_NAME'],
    steps: [{ script: 'cross-skill.mjs', args: ['learning-weekly-review'] }],
  },
  {
    key: 'cache-hitrate', // ad hoc weekly routine (no dedicated workflow file)
    label: 'Cache hit-rate check',
    requiredEnv: ['AUDIT_DB_URL'],
    steps: [{ script: 'cache-hitrate-check.mjs', args: [] }],
  },
];

export function missingEnv(requiredEnv) {
  return requiredEnv.filter((name) => !process.env[name]);
}

/** Validated positive-integer env parse — a bare `Number(x) || fallback` accepts
 * Infinity/negative/fractional truthy values (round-1 audit M2). Mirrors the
 * `numEnv` pattern already used in scripts/memory-health.mjs. */
export function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    process.stderr.write(`maintenance-checks: WARNING — ${name}="${raw}" is not a positive integer; using ${fallback}\n`);
    return fallback;
  }
  return n;
}

/**
 * Run one check as a child process — never `import`, since several of the
 * replicated scripts (e.g. memory-health.mjs) call `process.exit()` at
 * module scope unconditionally and would kill this orchestrator if pulled
 * in via ESM import instead of spawned. Every step runs regardless of a
 * prior step's exit (matches the workflow's per-step `|| true` semantics).
 */
export function runCheck(check) {
  const missing = missingEnv(check.requiredEnv);
  if (missing.length > 0) {
    return { key: check.key, label: check.label, status: 'skipped', reason: `missing env: ${missing.join(', ')}` };
  }

  const stepResults = check.steps.map(({ script, args }) => {
    const scriptPath = path.join(SCRIPTS_DIR, script);
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: process.env,
      timeout: 5 * 60 * 1000,
    });
    // Round-1 audit M3: capture BOTH streams (a bare `||` discarded stderr —
    // usually the actionable part — whenever stdout was non-empty), plus a
    // spawn-level failure (bad path, ENOENT) or a timeout/signal kill, neither
    // of which sets `result.status`.
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    const tail = combined.split('\n').slice(-6).join('\n');
    const launchError = result.error ? `spawn failed: ${result.error.message}` : (result.signal ? `killed by signal ${result.signal}` : null);
    return { script, exitCode: result.status, output: launchError ? `${launchError}\n${tail}`.trim() : tail, failed: result.status !== 0 || Boolean(launchError) };
  });

  const anyFailed = stepResults.some((s) => s.failed);
  return {
    key: check.key,
    label: check.label,
    status: anyFailed ? 'attention' : 'ok',
    exitCode: stepResults[stepResults.length - 1].exitCode,
    output: stepResults.map((s) => (check.steps.length > 1 ? `[${s.script}]\n${s.output}` : s.output)).filter(Boolean).join('\n\n'),
  };
}

export function loadHeartbeat(heartbeatPath = HEARTBEAT_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8'));
    // Round-1 audit L1: a shape-valid-but-incomplete file (or a future
    // timestamp, which would suppress opportunistic work indefinitely) is
    // treated as "never run" rather than trusted or crashing `--status`.
    if (!parsed || typeof parsed.lastRunAt !== 'string' || !Array.isArray(parsed.results)) return null;
    const last = Date.parse(parsed.lastRunAt);
    if (Number.isNaN(last) || last > Date.now()) return null;
    return parsed;
  } catch { return null; }
}

export function writeHeartbeat(results, mode, heartbeatPath = HEARTBEAT_PATH) {
  atomicWriteFileSync(heartbeatPath, JSON.stringify({
    lastRunAt: new Date().toISOString(),
    mode,
    results: results.map(({ key, status, exitCode }) => ({ key, status, exitCode: exitCode ?? null })),
  }, null, 2) + '\n');
}

export function isOverdue(heartbeat, intervalDays) {
  if (!heartbeat || !heartbeat.lastRunAt) return true;
  const last = Date.parse(heartbeat.lastRunAt);
  if (Number.isNaN(last)) return true;
  return (Date.now() - last) > intervalDays * 24 * 60 * 60 * 1000;
}

/**
 * Round-1 audit M1/M5/H2: a single aggregate timestamp conflated "ran and
 * did real work" with "ran but every check was skipped for missing env" —
 * adding AUDIT_DB_URL right after an all-skipped run still waited out the
 * full interval. A check whose requiredEnv is now fully satisfied, but was
 * `skipped` last time, forces an immediate run regardless of the interval.
 *
 * Deliberately NOT extended to retry a check that ran and returned
 * `attention` (a real failure/finding) — that matches the GH Actions
 * precedent this replicates: those workflows don't re-trigger early on
 * failure either, they wait for next week's schedule. Only the "env
 * became available" case has no such upstream analog (a scheduled cloud
 * workflow's secrets don't change week to week; a local `.env` does).
 */
export function hasNewlyEligibleCheck(heartbeat) {
  if (!heartbeat) return false;
  const priorStatus = new Map(heartbeat.results.map((r) => [r.key, r.status]));
  return CHECKS.some((c) => priorStatus.get(c.key) === 'skipped' && missingEnv(c.requiredEnv).length === 0);
}

/**
 * Single-instance guard so two overlapping opportunistic runs (e.g. two
 * quick pushes) can't run DB-mutating checks concurrently. Reuses the
 * existing sentinel-file lock (round-2 audit M3/M4: a hand-rolled
 * acquire/release here would have re-implemented — with a real TOCTOU gap —
 * what `lib/brainstorm/file-lock.mjs` already solved across several of its
 * own audit rounds, including stale-lock recovery and token-verified
 * release). `maxWaitMs: 0` makes this try-once-and-give-up rather than the
 * module's default bounded wait-and-retry — an opportunistic run should
 * skip immediately if another instance already holds the lock, not queue
 * behind it. Returns `null` when the lock is held elsewhere, so the caller
 * can silently no-op exactly like the old `acquireLock() === false` path.
 */
export async function runExclusive(lockPath, fn) {
  try {
    return await withFileLock(lockPath, { maxWaitMs: 0 }, fn);
  } catch (err) {
    if (err instanceof LockTimeoutError) return null;
    throw err;
  }
}

function printHuman(results) {
  process.stdout.write('Local maintenance checks\n========================\n');
  for (const r of results) {
    const icon = r.status === 'ok' ? 'OK' : r.status === 'skipped' ? 'SKIP' : 'ATTN';
    process.stdout.write(`[${icon}] ${r.label}\n`);
    if (r.status === 'skipped') process.stdout.write(`       ${r.reason}\n`);
    if (r.status === 'attention' && r.output) {
      process.stdout.write(r.output.split('\n').map((l) => `       ${l}`).join('\n') + '\n');
    }
  }
}

export async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const statusOnly = args.includes('--status');
  const opportunistic = args.includes('--opportunistic');
  const intervalDays = positiveIntEnv('AUDIT_LOOP_MAINTENANCE_INTERVAL_DAYS', DEFAULT_INTERVAL_DAYS);

  if (statusOnly) {
    const heartbeat = loadHeartbeat();
    if (json) { process.stdout.write(JSON.stringify({ heartbeat }, null, 2) + '\n'); return; }
    if (!heartbeat) { process.stdout.write('No maintenance run recorded yet.\n'); return; }
    process.stdout.write(`Last run: ${heartbeat.lastRunAt} (${heartbeat.mode})\n`);
    for (const r of heartbeat.results) process.stdout.write(`  ${r.key}: ${r.status}\n`);
    return;
  }

  // Round-3 audit H1: the lock must cover BOTH execution modes — an
  // attended `maintenance:run` and a backgrounded opportunistic push can
  // otherwise overlap and run the same DB-mutating checks concurrently.
  // Manual mode gets a LOUD message on contention (the user is watching);
  // opportunistic stays a silent no-op (nothing is watching it live).
  if (opportunistic) {
    if (process.env.AUDIT_LOOP_WEEKLY_MAINTENANCE !== '1') return; // opt-in gate — silent no-op
    const heartbeat = loadHeartbeat();
    if (!isOverdue(heartbeat, intervalDays) && !hasNewlyEligibleCheck(heartbeat)) return; // not due yet — silent no-op
    process.stderr.write(`[maintenance] running weekly local maintenance checks...\n`);
  }

  const results = await runExclusive(LOCK_PATH, () => CHECKS.map(runCheck));
  if (results === null) {
    if (opportunistic) return; // another instance already running — silent no-op
    process.stdout.write('Another maintenance run is already in progress — try again shortly.\n');
    return;
  }

  writeHeartbeat(results, opportunistic ? 'opportunistic' : 'manual');
  if (json) { process.stdout.write(JSON.stringify({ results }, null, 2) + '\n'); return; }
  printHuman(results);
}

const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname.toLowerCase();
    const argvPath = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname.toLowerCase() : '';
    return metaPath.endsWith('/maintenance-checks.mjs') && argvPath.endsWith('/maintenance-checks.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`maintenance-checks: fatal: ${err.stack || err.message}\n`);
    process.exit(99);
  });
}
