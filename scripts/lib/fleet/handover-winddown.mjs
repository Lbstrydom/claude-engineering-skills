/**
 * @fileoverview The wind-down stage's measurements (docs/plans/fleet-handover-winddown.md §2.1 to §2.4, §2.8, §2.9):
 * ONE readiness object per repo shared by `winddown` and `prepare`, the pre-switch safe-to-archive list, the spent
 * one-off tasks, and the standard directive. Pure over what prepare already derives; the command that gathers the facts
 * and prints them is `handover-winddown-cmd.mjs`.
 *
 * Readiness is MEASURED, never reported: a coordinator's "ready" in chat is not an input.
 *
 * @module scripts/lib/fleet/handover-winddown
 */
import path from 'node:path';
import { z } from 'zod';
import { quoteArg } from './shell-quote.mjs';
import { samePath } from '../harness-paths.mjs';
import { contextReasons } from './handover-context.mjs';
import { ARCHIVE_GUARD, blocksHandover, repoNeedsCoordination } from './handover-render.mjs';
import { syncCommands } from './consumer-bundle.mjs';
import { isPrepushSandbox } from './unregistered.mjs';

// ── readiness ───────────────────────────────────────────────────────────────

/**
 * @param {object[]} repos the per-repo states prepare records (`repoState`); the first is the invoking repo
 * @param {{contexts: Map<string, object>, isSwitchWait: (w: object) => boolean, bundles?: Map<string, object>|null,
 *   handedOver?: (repo: string, sha256: string) => string|null}} deps
 * @returns {{ready: boolean, repos: object[]}}
 *   `r3` (consumer bundle) is checked only when `bundles` is given: it runs the sync's own dry run, which prepare does not repeat.
 */
export function winddownReadiness(repos, { contexts, isSwitchWait, bundles = null, handedOver = () => null }) {
  const out = repos.map((r, i) => {
    const required = i === 0 || repoNeedsCoordination(r);
    const ctx = contexts.get(r.path) ?? { state: 'absent', path: null };
    const r1Reasons = required ? contextReasons(ctx, ctx.sha256 ? handedOver(r.path, ctx.sha256) : null) : [];
    // R2 is evaluated only over a MEASURED live state: an unreadable registry is not "no unparked claims".
    const measured = r.fleet === 'present';
    const unparked = measured ? r.sessions.filter((s) => !(s.waitingOn ?? []).some(isSwitchWait)).map((s) => s.id) : [];
    const r2Reasons = !required ? [] : !measured ? [`live state not measured${r.error ? ` (${r.error})` : ''}`]
      : unparked.length ? [`${unparked.length} live claim(s) not parked on human:account-switch: ${unparked.join(', ')}`] : [];
    const b = bundles?.get(r.path) ?? null;
    const r3Reasons = !b || b.state === 'current' ? [] : b.state === 'behind'
      ? [`consumer bundle behind (the sync would create ${b.create} and update ${b.update} file(s))`] : [`consumer bundle not measured (${b.reason})`];
    const blockers = [
      ...(r.fleet === 'error' ? [`state not measured: ${r.error ?? 'fleet error'}`] : []),
      ...(r.unregisteredUnknown ? [`unregistered work not measured: ${r.unregisteredUnknown}`] : []),
      ...((r.unregistered ?? []).filter(blocksHandover).length ? [`${(r.unregistered ?? []).filter(blocksHandover).length} item(s) of blocking unregistered work`] : []),
    ];
    const prerequisites = { r1: { ok: !r1Reasons.length, reasons: r1Reasons }, r2: { ok: !r2Reasons.length, reasons: r2Reasons }, r3: { ok: !r3Reasons.length, checked: Boolean(b), reasons: r3Reasons } };
    const reasons = [...r1Reasons, ...r2Reasons, ...r3Reasons, ...blockers];
    return { path: r.path, required, prerequisites, blockers, reasons, ready: reasons.length === 0 };
  });
  return { ready: out.every((r) => r.ready), repos: out };
}

/**
 * The manifest's record of the wind-down. `gate` is what PREPARE refuses on: only the prerequisites it can measure from its own
 * state (R1, R2). The blockers already have their own refusals, so repeating them here would print every failure twice; R3 runs the
 * sync's dry run, which prepare does not repeat.
 */
export function toManifestWinddown(readiness, waived = null) {
  return {
    ready: readiness.ready,
    ...(waived ? { waived } : {}),
    repos: readiness.repos.map((r) => ({ path: r.path, required: r.required, ready: r.ready, reasons: r.reasons, gate: [...r.prerequisites.r1.reasons, ...r.prerequisites.r2.reasons] })),
  };
}

export const WinddownSchema = z.object({
  ready: z.boolean(), waived: z.string().optional(),
  repos: z.array(z.object({ path: z.string(), required: z.boolean(), ready: z.boolean(), reasons: z.array(z.string()), gate: z.array(z.string()) }).strict()),
}).strict();

/** Prepare's ONE added refusal, or null when ready or WAIVED (a waiver is recorded in the manifest and printed in the handover). */
export function winddownRefusal(w) {
  if (w.waived) return null;
  const bad = w.repos.filter((r) => r.gate.length).map((r) => `${r.path}: ${r.gate.join('; ')}`);
  return bad.length ? `not ready: winddown incomplete in ${bad.join(' | ')}` : null;
}

// ── safe to archive ─────────────────────────────────────────────────────────

/** Is `inner` strictly inside `outer`? */
const isInside = (outer, inner) => {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  // The parent-directory SEGMENT, not a name that merely starts with dots (`..cache` is a real child).
  return Boolean(rel) && rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel);
};

/**
 * The worktrees whose sessions may be archived before the switch, measured from the unregistered-work scan. A worktree is
 * `safe` when no live claim covers it, it is not the main checkout, it is unlocked, it holds nothing the scan lists (clean) or only
 * commits already LANDED, and no other worktree is nested inside it (`archive_session` left a worktree on disk on 2026-10-21 because
 * one was). `heldRemotely` is clean but unlanded: removable without loss, but the work is not on base, so the user confirms.
 * A scan that did not reach everything measured nothing.
 * @param {{worktrees: object[], items: object[], claimedWorktrees: string[], partial?: string|null}} a
 */
export function safeToArchive({ worktrees, items, claimedWorktrees = [], partial = null }) {
  if (partial) return { measured: false, reason: partial, safe: [], heldRemotely: [], nested: [] };
  const first = worktrees[0];
  const mainPath = first && !first.bare ? first.path : null;
  const safe = []; const heldRemotely = []; const nested = [];
  for (const w of worktrees) {
    if (w.bare || w.missing || w.prunable || w.locked || (mainPath && samePath(w.path, mainPath))) continue;
    if (claimedWorktrees.some((c) => samePath(c, w.path)) || isPrepushSandbox(w)) continue;
    const item = items.find((i) => i.worktree && samePath(i.worktree, w.path));
    const clean = !item || (item.verdict === 'superseded' && item.via === 'landed');
    // Held by a remote ref (a branch, or a verified pushed tag) and nothing local: removable without loss, though not on base
    // (`unlanded`, or `unverified` where whether it landed is unknown). Nothing the scan marks blocking ever qualifies.
    const remote = Boolean(item) && item.blocks === false && item.preserved === 'remote';
    if (!clean && !remote) continue;
    const inner = worktrees.filter((o) => o !== w && !o.bare && isInside(w.path, o.path)).map((o) => o.path);
    if (inner.length) { nested.push({ path: w.path, branch: w.branch ?? null, nested: inner }); continue; }
    (clean ? safe : heldRemotely).push({ path: w.path, branch: w.branch ?? null, head: w.head ?? null });
  }
  return { measured: true, safe, heldRemotely, nested };
}

// ── spent one-off scheduled tasks ───────────────────────────────────────────

/**
 * One-offs whose time has passed AND that either ran at or after it or are disabled. A one-off past its time that has NOT run is not
 * spent: it fires at relaunch, which BEFORE YOU RELAUNCH covers.
 * @param {Map<string, object>} byId the parsed `list_scheduled_tasks` snapshot
 */
export function spentOneOffs(byId, now = new Date()) {
  const t = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const spent = [];
  for (const [id, s] of byId) {
    const fire = t(s.fireAt);
    if (fire === null || s.cronExpression || fire > now.getTime()) continue;
    const ran = t(s.lastRunAt);
    if (s.enabled === false || (ran !== null && ran >= fire)) spent.push({ id, fireAt: s.fireAt, lastRunAt: s.lastRunAt ?? null, enabled: s.enabled !== false });
  }
  return spent;
}

// ── the standard directive ──────────────────────────────────────────────────

/**
 * The ONE text a coordinator receives, with this repo's values filled in. `propose` is `fleetSupports(repo, cli, 'propose')`.
 * `proposeCli` is the source repo's CLI, used where the consumer's bundle lacks the verb.
 */
export function renderDirective({ repo, cli, contextFile, propose, proposeCli }) {
  // Every template carries the arguments `propose` requires (--what --where --why); the repo name is a quoted argument, never raw text.
  const theme = quoteArg(path.basename(repo));
  const args = '--what "<what>" --where "<where>" --why "<why>"';
  const card = propose === true ? `${cli} propose ${args} --theme "<theme>"`
    : propose === false ? `${proposeCli} propose ${args} --theme ${theme} (this repo's fleet has no propose verb, so the proposal lands in the source repo's queue)`
      : `${cli} propose ${args} --theme "<theme>" (if it refuses propose, use: ${proposeCli} propose ${args} --theme ${theme})`;
  return [
    `WIND-DOWN for ${path.basename(repo)} (account switch). Do exactly this, then reply with ONE line: "${path.basename(repo)} winddown done". Readiness is measured by the next winddown run, not taken from your reply.`,
    '  1. Finish merges that are already approved. Start no new work: no /plan, no audit, no new chip.',
    '  2. Commit and push work in progress to feature branches. Claim unclaimed work from INSIDE its worktree.',
    `  3. Park every live claim: ${cli} touch --id <id> --waiting-on human:account-switch`,
    `  4. File every pending New-task card as a proposal (cards die with the account): ${card}`,
    `  5. Fill in ${contextFile ?? '<context file>'} (every section; none is a valid body; names only, never key values), including the in-session timers you hold (ScheduleWakeup, CronCreate, /loop) and the proposal ids from step 4.`,
  ].join('\n');
}

export { ARCHIVE_GUARD, syncCommands };
