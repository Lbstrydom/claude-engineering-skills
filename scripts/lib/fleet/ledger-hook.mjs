/**
 * @fileoverview Capture hooks that feed the own-model decision ledger from the
 * fleet CLI and ship-train (docs/plans/own-model-decision-ledger.md decisions 9, 11).
 *
 * Two events, nothing else:
 *   - a `decision` when a fleet verb REFUSES or reports PENDING (the coordinator's
 *     WAIT/refusal moment), recording the option chosen AND the one not chosen;
 *   - an `outcome(merged)` per PR a ship-train `land` merged.
 *
 * Hot-path discipline: fleet is polled, so the decision hook never opens a store
 * connection. It prepares the event (repo shaping from the LOCAL eligibility cache,
 * `'unknown'` when stale or absent) and writes it to the spool; `cross-skill.mjs
 * ledger flush` delivers it. A hook failure appends to `hook-errors.log` and never
 * changes stdout or the exit code.
 *
 * Producer-to-field mapping: the work item comes from the branch (`wi-<uuidv7>`)
 * or the PR body footer (`Work-Item: <uuidv7>`); absent means NULL, counted as
 * uncorrelated, never guessed.
 *
 * @module scripts/lib/fleet/ledger-hook
 */
import { execFileSync } from 'node:child_process';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { submitLedgerEvent } from '../ledger/submit.mjs';
import { ledgerDir, appendHookError, ledgerEnabled } from '../ledger/spool.mjs';
import { workItemFromBranch, workItemFromPrBody } from '../ledger/work-item.mjs';

const DECISION_VERBS = new Set(['claim', 'land', 'ready', 'restack']);

/** Coordinator code from a canonical repo name; `other` when it is none of the four. */
export function coordinatorFor(repoName) {
  const n = String(repoName ?? '').toLowerCase();
  if (n.includes('claude-engineering-skills')) return 'CES';
  if (n.includes('wine-cellar')) return 'WCA';
  if (n.includes('storyline')) return 'STO';
  if (n.includes('ai-organiser') || n.includes('ai-organizer')) return 'AIO';
  return 'other';
}

/**
 * PURE. The ingress `decision` event for a fleet refusal / pending verb, or null.
 * @param {string} verb
 * @param {{flags?: object}|null} parsed
 * @param {{code?: string, reason?: string, branch?: string}|null} result
 * @param {{repoName?: string|null, nowIso: string}} ctx
 */
export function fleetDecisionEvent(verb, parsed, result, { repoName = null, nowIso }) {
  if (!DECISION_VERBS.has(verb) || !result) return null;
  const code = result.code;
  if (code !== 'refused' && code !== 'pending') return null;
  const chosen = code === 'refused' ? 'refuse' : 'wait';
  const branch = result.branch ?? parsed?.flags?.['--branch'] ?? null;
  return {
    kind: 'decision',
    work_item_id: workItemFromBranch(branch),
    repo: repoName,
    coordinator: coordinatorFor(repoName),
    actor: 'coordinator',
    event_at: nowIso,
    payload: {
      options: [{ id: 'proceed', label: 'Proceed' }, { id: chosen, label: code === 'refused' ? 'Refuse' : 'Wait' }],
      chosen_option_id: chosen,
      state_summary: `fleet ${verb} ${code}${result.reason ? `: ${String(result.reason).slice(0, 500)}` : ''}`,
    },
  };
}

/**
 * PURE. One `merged` outcome per PR in a ship-train `land` envelope.
 * @param {{trainId?: string, merges?: Array<{pr: number, mergeCommit?: string}>}} env
 * @param {{repoName: string|null, nowIso: string, workItemOf?: (pr: number) => string|null}} ctx
 */
export function trainMergeEvents(env, { repoName, nowIso, workItemOf = () => null }) {
  const out = [];
  for (const m of env?.merges ?? []) {
    if (!Number.isInteger(m?.pr)) continue;
    out.push({
      kind: 'outcome',
      work_item_id: workItemOf(m.pr),
      repo: repoName,
      coordinator: coordinatorFor(repoName),
      actor: 'system',
      event_at: nowIso,
      payload: {
        kind: 'merged', ref: `pr:${m.pr}`,
        ...(/^[0-9a-f]{40,64}$/.test(String(m.mergeCommit ?? '')) ? { merge_sha: m.mergeCommit } : {}),
      },
    });
  }
  return out;
}

/** Deps with no store: the fleet hook only ever prepares and spools. */
const spoolOnlyDeps = {
  resolveRepoName: (cwd) => resolveRepoIdentity(cwd).name,
  isCloudEnabled: async () => false,
  lookupRepoFlag: async () => ({ flag: 'unknown' }),
  readPurgeGeneration: async () => 0,
  recordLedgerEvents: async () => ({ ok: false, reason: 'spool-only', receipts: [] }),
  ledgerDir,
};

/** Fleet refusal/pending hook. Never throws, never touches stdout. */
export async function recordFleetDecision(verb, parsed, result, { cwd = process.cwd(), env = process.env, nowIso = new Date().toISOString() } = {}) {
  if (!ledgerEnabled(env)) return;   // disabled means NO work: no git, no repo resolution
  let dir = null;
  try {
    dir = ledgerDir(cwd);
    const repoName = resolveRepoIdentity(cwd).name;
    const ev = fleetDecisionEvent(verb, parsed, result, { repoName, nowIso });
    if (!ev) return;
    const r = await submitLedgerEvent(ev, { cwd, env, deps: spoolOnlyDeps });
    if (r.state === 'refused' || r.state === 'failed-permanent' || r.state === 'failed-retryable') appendHookError(dir, `fleet ${verb}: ${r.state} ${r.reason ?? r.error ?? ''}`);
  } catch (err) {
    if (dir) appendHookError(dir, `fleet ${verb}: ${err?.message ?? err}`);
  }
}

/** The work item of a PR via `gh pr view`; null on any failure (never guessed). */
export function workItemOfPr(pr, { cwd = process.cwd(), timeoutMs = 8000 } = {}) {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(pr), '--json', 'body,headRefName'], { cwd, encoding: 'utf8', timeout: Math.max(1, timeoutMs), stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out);
    return workItemFromPrBody(j.body) ?? workItemFromBranch(j.headRefName);
  } catch { return null; }
}

/** ship-train `land` hook: one merged outcome per landed PR, spooled. Never throws. */
export async function recordTrainLandings(env, { cwd = process.cwd(), nowIso = new Date().toISOString(), workItemOf = null, budgetMs = 30_000, processEnv = process.env } = {}) {
  if (!ledgerEnabled(processEnv)) return;   // disabled means NO work: no git, no `gh`, no repo resolution
  let dir = null;
  // This is optional telemetry on the landing path: `gh` lookups share one time budget (8 s each, 30 s in all), after which
  // the remaining PRs are recorded with NO work item (uncorrelated), never guessed and never allowed to stall the train.
  const deadline = Date.now() + budgetMs;
  // Each lookup is capped at what REMAINS of the shared budget, so one started near the deadline cannot overrun it.
  const lookup = workItemOf ?? ((pr) => (Date.now() < deadline ? workItemOfPr(pr, { cwd, timeoutMs: Math.min(8000, deadline - Date.now()) }) : null));
  try {
    dir = ledgerDir(cwd);
    const repoName = resolveRepoIdentity(cwd).name;
    for (const ev of trainMergeEvents(env, { repoName, nowIso, workItemOf: lookup })) {
      const r = await submitLedgerEvent(ev, { cwd, deps: spoolOnlyDeps });
      if (r.state === 'refused' || r.state === 'failed-permanent' || r.state === 'failed-retryable') appendHookError(dir, `train land: ${r.state} ${r.reason ?? r.error ?? ''}`);
    }
  } catch (err) {
    if (dir) appendHookError(dir, `train land: ${err?.message ?? err}`);
  }
}
