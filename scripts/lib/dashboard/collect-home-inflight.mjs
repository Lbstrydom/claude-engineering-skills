/**
 * @fileoverview Home collector: In flight — worktrees, branches ahead of base, and
 * overlaps, via `gatherFacts` + `buildStatusFrom` (the /fleet read path).
 *
 * Three guards, each pinned by a test:
 *   - `prs:false` — no `gh` call; the card says "PRs: not queried".
 *   - `checks:false` — the `.fleet.json` extension hook is CONSUMER code and a
 *     dashboard build must not execute it. The config handed to `gatherFacts` also
 *     carries only `baseBranch` and the `hotFiles` patterns (data), never the hook list.
 *   - `maxBranches: 30` — bounds the per-branch git calls; the overflow is listed as
 *     "+N not analysed", never silently skipped.
 * Rows are capped at 15 with a true "+N more".
 *
 * SYNCHRONOUS (spawnSync under the hood): run it inside the Home worker thread.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (In flight).
 *
 * @module scripts/lib/dashboard/collect-home-inflight
 */
import { gatherFacts, buildStatusFrom } from '../fleet/facts.mjs';
import { resolveConfig, ConfigError } from '../fleet/config.mjs';
import { makeMeasurement, clip } from './home-model.mjs';

export const INFLIGHT_ROW_CAP = 15;
export const INFLIGHT_MAX_BRANCHES = 30;
export const PRS_NOTE = 'PRs: not queried (not requested for the dashboard build)';

/**
 * Is a status item "in flight" for the card? The integration checkout itself is not, and
 * neither is a branch MEASURED to have nothing ahead. An unknown count (`ahead: null`) is
 * not "nothing ahead" — it stays, the same unknown-keeps-visible rule `fleet status` uses.
 */
export function isInFlight(item, baseName) {
  if (item.branch === baseName && item.kind === 'worktree') return false;
  return !(item.kind === 'branch' && item.ahead === 0);
}

/** A readable, bounded label for a row: the branch, else the worktree path. */
const labelOf = (i) => clip(i.branch ?? i.worktree ?? i.id, 400);

/**
 * @param {string} root
 * @param {{now?: Date, env?: NodeJS.ProcessEnv}} [opts]
 */
export function collectInflight(root, { now = new Date(), env = process.env } = {}) {
  const base = { id: 'inflight', label: 'In flight', card: 'inflight', asOf: now.toISOString(), source: 'git worktree/branch facts (fleet gatherFacts, PRs and checks off)' };
  try {
    const cfg = resolveConfig(root, { env });
    // Only `baseBranch` and the `hotFiles` patterns (data) cross: the consumer-owned `checks` hook list must not.
    const config = { baseBranch: cfg.baseBranch, hotFiles: cfg.hotFiles };
    const facts = gatherFacts({ cwd: root, config, now, env, prs: false, checks: false, maxBranches: INFLIGHT_MAX_BRANCHES });
    const status = buildStatusFrom(facts);
    const baseName = cfg.baseBranch;
    const items = status.items.filter((i) => isInFlight(i, baseName));
    const rows = items.slice(0, INFLIGHT_ROW_CAP).map((i) => ({
      id: clip(i.id), kind: i.kind, label: labelOf(i), ahead: i.ahead ?? null, behind: i.behind ?? null,
      state: clip(i.display ?? i.state ?? ''), overlaps: (i.overlaps ?? []).length,
    }));
    const na = facts.branchesNotAnalysed ?? null;
    return makeMeasurement({
      ...base, status: 'ok',
      value: { baseBranch: baseName, rows, more: items.length - rows.length, total: items.length, notAnalysed: na ? { count: na.count } : null, prs: PRS_NOTE },
      detail: na ? `+${na.count} branch(es) not analysed (cap ${INFLIGHT_MAX_BRANCHES})` : '',
    });
  } catch (err) {
    // An explicitly supplied but INVALID configuration (.fleet.json, FLEET_*) is not an absent optional source.
    // "Not a git repository" is the one ConfigError that IS an expected absence.
    if (err instanceof ConfigError) {
      const first = String(err.errors?.[0] ?? err.message).split('\n')[0];
      return /^not a git repository/.test(first)
        ? makeMeasurement({ ...base, status: 'missing-optional', detail: first })
        : makeMeasurement({ ...base, status: 'invalid', detail: `fleet configuration invalid: ${first}` });
    }
    return makeMeasurement({ ...base, status: 'unexpected-error', detail: `in-flight facts failed: ${String(err.message).split('\n')[0]}` });
  }
}
