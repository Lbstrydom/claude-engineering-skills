/**
 * @fileoverview Is a consumer's synced bundle current? (docs/plans/fleet-handover-winddown.md §2.8, proposal 7970.)
 *
 * Which source changes reach a consumer is decided by the sync's own file selection (skill packaging, script lists, rewrites,
 * holds, deletions). A diff over directory roots over-reports (a skill's `gate-contract.json` is inside the roots and syncs
 * nothing), and a second derivation of that selection would be a second source of truth. So the oracle is the sync itself:
 * its `--dry-run` for the target, run from the source repo's MAIN checkout, and the one summary line it prints
 * (`Would create: N  update: N  unchanged: N`). It writes nothing.
 *
 * That line is a prose contract between a CLI and this reader, so the parser is tested against the tool's real output and an
 * unmatched line is `unknown`, never `current`.
 *
 * @module scripts/lib/fleet/consumer-bundle
 */
import { spawnSync } from 'node:child_process';
import { quoteArg } from './shell-quote.mjs';

export const SYNC_DRY_RUN_TIMEOUT_MS = 120_000;
/** The whole winddown's budget for asking every consumer: each probe gets what is left, not its own full timeout. */
export const BUNDLE_BUDGET_MS = 240_000;

// eslint-disable-next-line no-control-regex -- the sync colours its output; the escape byte is what is being stripped
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Read a sync dry run's output.
 * @returns {{state: 'current'|'behind'|'unknown', create?: number, update?: number, reason?: string}}
 */
export function parseSyncDryRun(output) {
  const text = String(output ?? '').replace(ANSI, '');
  // A run the real sync would refuse says nothing about whether the consumer is current.
  if (/would ABORT/.test(text)) return { state: 'unknown', reason: 'the sync dry run reports it would ABORT (an unowned collision)' };
  const m = /Would create:\s*(\d+)\s+update:\s*(\d+)/.exec(text);
  if (!m) return { state: 'unknown', reason: 'the sync dry run printed no "Would create: N  update: N" summary line' };
  const create = Number(m[1]);
  const update = Number(m[2]);
  return { state: create + update > 0 ? 'behind' : 'current', create, update };
}

/**
 * Ask the sync about one registered consumer. `run` is injectable: `(args, cwd) => {status, stdout, stderr, error}`.
 * @param {string} sourceMain the source repo's MAIN checkout (a stale linked worktree's sync can roll a consumer back)
 * @param {string} target the consumer's registry name or alias
 */
export function consumerBundleState(sourceMain, target, { run = defaultRun, timeoutMs = SYNC_DRY_RUN_TIMEOUT_MS } = {}) {
  if (timeoutMs <= 0) return { state: 'unknown', reason: 'the winddown time budget was spent before this consumer was asked' };
  const r = run(['scripts/sync-to-repos.mjs', '--dry-run', '--no-prompt', '--target', target], sourceMain, Math.min(timeoutMs, SYNC_DRY_RUN_TIMEOUT_MS));
  if (r.error) return { state: 'unknown', reason: `the sync dry run could not run (${r.error.code ?? r.error.message})` };
  if (r.status !== 0) return { state: 'unknown', reason: `the sync dry run exited ${r.status}` };
  return parseSyncDryRun(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
}

function defaultRun(args, cwd, timeout = SYNC_DRY_RUN_TIMEOUT_MS) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** The commands that bring a consumer current, run from the source repo's main checkout. */
export const syncCommands = (target) => [`node scripts/sync-to-repos.mjs --target ${quoteArg(target)}`, `node scripts/sync-pr.mjs --target ${quoteArg(target)} --no-merge`];
