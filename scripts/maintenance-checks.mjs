#!/usr/bin/env node
/**
 * @fileoverview Local replica of the 5 weekly GitHub Actions maintenance
 * workflows (architectural-drift, migration-drift, model-freshness,
 * memory-health, learning-weekly-review) plus cache-hitrate-check,
 * debt-health, debt-ledger-claims, context-staleness, and accepted-debt (ad
 * hoc — no dedicated workflow file; accepted-debt is additionally
 * sourceRepoOnly, see its CHECKS entry), and one DISPOSABLE one-shot
 * (slice-recurrence, which retires itself — see its script header), for
 * operators whose org blocks GitHub-hosted Actions runners (or who just
 * prefer local-only). Opt-in, default-OFF — see
 * docs/runbooks/local-maintenance-checks.md.
 *
 * **`CHECKS` below is the inventory; this paragraph is prose beside it.** It
 * had already drifted (context-staleness was missing) before slice-recurrence
 * made it two short — the same drift the runbook's "7 checks" line carried.
 * `tests/maintenance-checks.test.mjs` pins the KEY SET, which is what actually
 * prevents a check being added or removed silently; if this sentence and that
 * test ever disagree, the test is right.
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
 * IMPORTANT: this script itself runs synchronously and can take minutes
 * (CHECKS.length checks, one of which bundles 3 subprocess steps). The pre-push hook
 * backgrounds + detaches it (round-1 audit H1: an earlier version appended
 * `|| true`, which only suppresses the exit code — it does NOT make a
 * command asynchronous, so `git push` was blocking for up to ~40 minutes).
 * Every run — manual or opportunistic — takes a single-instance lock
 * (`.audit-loop/.maintenance.lock`, via `lib/file-lock.mjs`) so
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
import { withFileLock, LockTimeoutError } from './lib/file-lock.mjs';
import { isSourceRepo } from './lib/is-source-repo.mjs';

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

const REPO_ROOT = findRepoRootFromScript(import.meta.url);
const SCRIPTS_DIR = import.meta.dirname;

// isSourceRepo() now lives in scripts/lib/is-source-repo.mjs (round-6
// code-audit Sustainability M5): a zero-side-effect module, so a caller that
// only wants the source-repo predicate doesn't also evaluate this file's
// config.mjs import (env loading) and scheduler machinery. Re-exported here
// so existing importers of this module (including this file's own tests)
// don't need to change their import path.
export { isSourceRepo };

/**
 * Where the heartbeat + lock live. Overridable so a test driving the real CLI
 * as a SUBPROCESS can point it at a throwaway directory.
 *
 * This is the process-boundary form of a seam that already exists: every pure
 * function here (`loadHeartbeat`, `writeHeartbeat`, `runExclusive`) takes its
 * path as a parameter, which is exactly how the unit tests isolate. A spawned
 * CLI cannot be given a parameter, and before this override the CLI test wrote
 * its lock fixture to — and `unlinkSync`'d — the REAL repo lock. That is worse
 * than flaky: unlinking the live lock would release it out from under a genuine
 * concurrent maintenance run and let a second one start, defeating the single-
 * instance guard the test exists to verify. Concurrent test processes also
 * deleted each other's fixture, so the CLI under test saw no lock and ran the
 * real checks until it hit the harness timeout.
 *
 * Unset (the normal case) → the repo path, byte-identical to previous behaviour.
 */
const STATE_DIR = process.env.AUDIT_LOOP_STATE_DIR || path.join(REPO_ROOT, '.audit-loop');
const HEARTBEAT_PATH = path.join(STATE_DIR, 'last-maintenance.json');
const LOCK_PATH = path.join(STATE_DIR, '.maintenance.lock');

// The override moves BOTH the single-instance lock and the heartbeat, so an
// invocation that has it set shares neither with one that does not: two runs
// can then execute the same DB-mutating checks concurrently — the exact failure
// the lock exists to prevent — and a redirected heartbeat makes
// `--opportunistic` believe every run is overdue (final-review shadow, LOW).
//
// Deliberately NOT "force the lock repo-relative": this seam exists because
// concurrent TEST processes were deleting each other's fixture and seeing no
// lock at all, so pinning the lock would reintroduce the defect it was added to
// fix. Nor a second, canonical lock alongside it — that is real complexity for
// a hazard that only arises when an operator exports the variable by hand.
// A run whose state is not the shared state says so, once, and an operator who
// sees this line beside a concurrent push knows why two runs overlapped.
if (process.env.AUDIT_LOOP_STATE_DIR) {
  process.stderr.write(
    `  [maintenance] AUDIT_LOOP_STATE_DIR override active (${STATE_DIR}) — this run does NOT share the repo's lock or heartbeat\n`,
  );
}
const DEFAULT_INTERVAL_DAYS = 7;

/**
 * One entry per replicated workflow. `requiredEnv` gates the whole check —
 * missing env → `skipped`, never attempted. `steps` mirror what the matching
 * npm script(s) actually run, so this stays a straight port rather than a
 * reimplementation. `arch-maintenance` bundles refresh+drift+prune into one
 * check (matching architectural-drift.yml, which runs all three as one job,
 * each step independent of the previous step's exit) — kept as ONE entry,
 * not three, so CHECKS.length stays an honest count (round-1 audit L2/L3
 * caught a 6-vs-8 miscount from the earlier 3-way split).
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
 *
 * 8 entries as of accepted-debt's addition — docs/runbooks/local-maintenance-
 * checks.md quotes a "6 checks" count that predates it; CHECKS.length is
 * the source of truth here, not a hand-copied number.
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
    // Mirrors the workflow's TWO steps, in its order: backfill drains
    // .audit/quickfix-hits.jsonl + resolves >30min-old outcomes, THEN the
    // review reads the resulting stats. The local replica previously ran only
    // the review — and since the JSONL is gitignored, the runner-side backfill
    // could never see it either. Net effect: the outcome resolver had no
    // reachable caller on any schedule, and 1815/1838 decisions sat unresolved.
    steps: [
      { script: 'cross-skill.mjs', args: ['learning-backfill-outcomes', '--rebuild-stats'] },
      { script: 'cross-skill.mjs', args: ['learning-weekly-review'] },
    ],
  },
  {
    key: 'cache-hitrate', // ad hoc weekly routine (no dedicated workflow file)
    label: 'Cache hit-rate check',
    requiredEnv: ['AUDIT_DB_URL'],
    steps: [{ script: 'cache-hitrate-check.mjs', args: [] }],
  },
  {
    // DISPOSABLE, one-shot — the only entry here that is not a standing
    // concern. It answers whether god-module slice 1 (`a7db0baf`) stopped the
    // usage-accounting cluster recurring, is a silent no-op until 2026-09-10,
    // and carries a retirement predicate in its own header: delete this entry,
    // the script, this key from tests/maintenance-checks.test.mjs's inventory,
    // and its runbook row once it has reported a non-`unknown` verdict once.
    // It lives here rather than in a scheduler because a date alone cannot
    // distinguish "cluster stopped" from "nobody audited" — see its header.
    key: 'slice-recurrence',
    label: 'God-module slice 1 recurrence verdict (one-shot, retires after reporting)',
    requiredEnv: ['AUDIT_DB_URL'],
    steps: [{ script: 'slice-recurrence-check.mjs', args: [] }],
  },
  {
    // Git-only, so no requiredEnv — it runs everywhere, including offline.
    // Deliberately a REPORT: it exits 0 whether or not it flags anything, so it
    // can never block a push. See the module header for why a guessing lint
    // must not be a gate (check-docs-refs.mjs's doctrine).
    key: 'context-staleness',
    label: 'AGENTS.md staleness (cited code moved after the line did)',
    requiredEnv: [],
    steps: [{ script: 'context-staleness.mjs', args: [] }],
  },
  {
    // Local-only, no requiredEnv, no dedicated GH workflow (same "ad hoc"
    // shape as cache-hitrate above). /audit-code Step 3.6 captures
    // out-of-scope findings into .audit/tech-debt.json on every audit run,
    // but nothing periodically surfaced the backlog back to an operator —
    // debt-review.mjs (clustering) and debt-budget-check.mjs (policy gate)
    // existed, were tested and synced to consumers, but were referenced by
    // no skill step, no CI gate, and no maintenance check. This closes that
    // discoverability gap. `attention` = stale (>TTL) and/or recurring
    // (>=3 distinct runs) and/or over-budget entries present; never blocks.
    key: 'debt-health',
    label: 'Tech-debt ledger health (staleness, recurrence, budgets)',
    requiredEnv: [],
    steps: [{ script: 'debt-health-check.mjs', args: [] }],
  },
  {
    // Local-only, no requiredEnv, no dedicated GH workflow — same "ad hoc"
    // shape as debt-health above, and it reads the same ledger file, but a
    // different question: not the ledger's OWN health, but whether
    // docs/plans/*.md claims ABOUT the ledger ("captured to / named in the
    // debt ledger") are true. Twice in this repo such a claim was
    // confidently wrong (cross-skill-cli-integrity.md, then
    // cross-skill-command-registry.md) and survived six audit rounds, a
    // Gemini gate, and a shadow reviewer each time — a claim about a record
    // elsewhere can't be falsified by reading the diff it's written in.
    // Deliberately NOT wired into `npm run check`: the ledger is gitignored,
    // machine-local state, always absent in the pre-push clean-checkout
    // sandbox, so a blocking gate here would either false-fail every push
    // touching docs/plans/ or silently pass having checked nothing. When the
    // ledger is absent this reports "unverifiable", not "clean" — see
    // scripts/lib/debt-ledger-claim-check.mjs's module header.
    // `attention` = a claim's topicId doesn't resolve in the ledger; never blocks.
    key: 'debt-ledger-claims',
    label: 'docs/plans/*.md ledger-capture claims vs. the actual ledger',
    requiredEnv: [],
    steps: [{ script: 'debt-ledger-claims-check.mjs', args: [] }],
  },
  {
    // Local-only, no requiredEnv, no dedicated GH workflow (same "ad hoc"
    // shape as cache-hitrate above) — self-hosted-runner-management.md D9:
    // "discoverability rides the opt-in weekly maintenance replica, not
    // check-setup", so the feature is not a command nobody knows to run.
    // `local --json --strict` (never --quiet-when-clean: --json already
    // emits exactly one envelope regardless of rollup, so that flag would be
    // a no-op here and is reserved for human-mode printing). requiredEnv is
    // deliberately [] — this check must run with nothing configured; an
    // absent runner install is the ordinary, non-error `rollup:'clean'` case
    // (§3), not a skip condition.
    key: 'runner-health',
    label: 'Self-hosted-runner inventory + health (this machine)',
    requiredEnv: [],
    steps: [{ script: 'actions-runner-doctor.mjs', args: ['local', '--json', '--strict'] }],
  },
  {
    // Local-only, no requiredEnv, no dedicated GH workflow — same "ad hoc"
    // shape as debt-health above, and deliberately NOT the same system: that
    // one covers .audit/tech-debt.json (audit-captured findings, TTL/
    // recurrence-based staleness); this one covers the hand-written
    // "Accepted Technical Debt" table in AGENTS.md, whose claims are
    // condition-based ("if X becomes true"), not time-based. Only one of
    // the table's 6 rows is mechanically checkable today (readFileOrDie's
    // "library context" trigger); the rest are reported as explicitly
    // unverifiable, never silently trusted. `attention` = a checked
    // predicate is contradicted/unknown, or a registry/table parity
    // mismatch; never blocks. Design: docs/plans/accepted-debt-table-verification.md.
    //
    // sourceRepoOnly (round-2 audit Quickfix M7): check-accepted-debt.mjs's
    // registry is hardcoded to THIS repo's own 6 AGENTS.md rows — running it
    // in a consumer would report every row unregistered forever, training
    // operators to ignore maintenance failures. This CHECKS entry (part of
    // the synced orchestrator) stays declared and documented; runCheck()
    // skips it in a consumer via isSourceRepo(), the same source-repo gate
    // /audit-code Step 6.5/6.5b already uses for other steps. The script
    // itself is deliberately excluded from CLI_SMOKE_SET / sync-to-repos.mjs
    // / sync-inventory.mjs — see its own module header.
    key: 'accepted-debt',
    label: 'AGENTS.md accepted-debt revisit-trigger drift',
    requiredEnv: [],
    sourceRepoOnly: true,
    steps: [{ script: 'check-accepted-debt.mjs', args: [] }],
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
  // Checked BEFORE requiredEnv: a source-repo-only check's script is excluded
  // from the sync manifest on purpose (see check-accepted-debt.mjs's own
  // header), so spawning it in a consumer would hit MODULE_NOT_FOUND rather
  // than a clean, informative skip.
  if (check.sourceRepoOnly && !isSourceRepo()) {
    return { key: check.key, label: check.label, status: 'skipped', reason: 'source-repo-only (not claude-engineering-skills)' };
  }

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
 * what `lib/file-lock.mjs` already solved across several of its
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
