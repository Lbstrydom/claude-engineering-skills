/**
 * @fileoverview The prune plan, summarised so its evidence reaches a person (upstream 56773c7c): `fleet prune` proved
 * branches removable, but nothing showed the result unless someone ran it, so squash-merged leftovers piled up.
 *
 * `fleet status` plans a prune under a budget, prints ONE line from it and writes this derived cache; `fleet prune`
 * (read-only) writes it too. `fleet next` only READS the cache — it runs at every checkpoint — and relays it as
 * information for the user or coordinator, never as an action. This module only counts what `planPrune` decided: it
 * never judges a branch itself.
 *
 * Unmeasured is never zero: a plan whose global gate failed (`complete:false`) prints its reason, a budget-cut plan
 * prints its counts as lower bounds with how many were not judged, and a missing cache reads as unmeasured.
 *
 * A count known to be wrong is REPLACED, never deleted or left: a failed status plan and a `prune --apply` both
 * write an unmeasured record (`invalidatePruneCache`), so `next` can never relay the previous complete count, and a
 * write that fails is returned for a warning line.
 *
 * The cache is Category A (derived from git state, never committed) and lives in `<git-common-dir>/fleet-cache/`
 * beside `unregistered.json`, so every worktree of a repo reads the same file and `status` stays read-only towards
 * the registry.
 *
 * Plan: docs/plans/fleet-prune-surfacing.md.
 *
 * @module scripts/lib/fleet/prune-summary
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';

export const PRUNE_CACHE_FILE = 'prune.json';
export const PRUNE_CACHE_SCHEMA_VERSION = 2;
/** `fleet status`'s budget for planning the prune; past it, branches are counted as not judged. */
export const PRUNE_STATUS_BUDGET_MS = 30_000;

const count = z.number().int().nonnegative();
const RecordSchema = z.object({
  schemaVersion: z.literal(PRUNE_CACHE_SCHEMA_VERSION),
  at: z.string().refine((s) => Number.isFinite(Date.parse(s)), { message: 'at must be a parseable time' }),
  complete: z.boolean(),
  reason: z.string().optional(),
  removable: count, fresh: count, kept: count, unjudged: count, orphans: count,
  // Detached worktrees and stale registrations (docs/plans/fleet-hygiene.md §1.2): judged apart from the branch half, which needs the PR list and
  // so can be incomplete while this is complete. `worktrees` is the registered count (null = the list was unreadable).
  detached: z.object({ removable: count, fresh: count, kept: count, stale: count, staleKept: count, unjudged: count }).strict(),
  worktrees: count.nullable(),
  review: z.object({ postMerge: count, postMergeOnBase: count, noPr: count, noPrOnBase: count, unjudged: count }).strict(),
}).strict()
  .refine((r) => r.complete === (r.reason === undefined), { message: 'reason is present exactly when complete is false' })
  .refine((r) => r.detached.fresh <= r.detached.removable && r.fresh <= r.removable && r.review.postMergeOnBase <= r.review.postMerge && r.review.noPrOnBase <= r.review.noPr,
    { message: 'a subset count exceeds its total' });

/**
 * The summary record of a `planPrune` result. `at` is when the facts were observed, so the record's age is honest.
 * @param {ReturnType<import('./prune.mjs').planPrune>} plan
 * @param {string} at ISO time
 */
export function summarisePrune(plan, at) {
  const r = plan.review ?? { postMerge: [], noPr: [], unjudged: 0 };
  const complete = plan.complete === true;
  const d = plan.detached ?? { candidates: [], excluded: [], stale: [], unjudged: 0 };
  return {
    schemaVersion: PRUNE_CACHE_SCHEMA_VERSION, at, complete,
    ...(complete ? {} : { reason: plan.notJudged?.[0] ?? 'the prune plan was not judged' }),
    removable: plan.candidates.length, fresh: plan.candidates.filter((c) => c.fresh).length, kept: plan.excluded.length,
    unjudged: plan.unjudged ?? 0, orphans: plan.orphans?.dirs?.length ?? 0,
    detached: { removable: d.candidates.length, fresh: d.candidates.filter((c) => c.fresh).length, kept: d.excluded.length, stale: d.stale.length, staleKept: d.excluded.filter((e) => e.gone).length, unjudged: d.unjudged },
    worktrees: plan.registered ?? null,
    review: {
      postMerge: r.postMerge.length, postMergeOnBase: r.postMerge.filter((i) => i.allOnBase).length,
      noPr: r.noPr.length, noPrOnBase: r.noPr.filter((i) => i.allOnBase).length, unjudged: r.unjudged ?? 0,
    },
  };
}

/** The record of a count that is NOT a measurement: every count zero, `complete:false`, and why. */
export function unmeasuredRecord(reason, at) {
  return {
    schemaVersion: PRUNE_CACHE_SCHEMA_VERSION, at, complete: false, reason,
    removable: 0, fresh: 0, kept: 0, unjudged: 0, orphans: 0,
    detached: { removable: 0, fresh: 0, kept: 0, stale: 0, staleKept: 0, unjudged: 0 }, worktrees: null,
    review: { postMerge: 0, postMergeOnBase: 0, noPr: 0, noPrOnBase: 0, unjudged: 0 },
  };
}

const notJudgedOf = (rec) => rec.unjudged + rec.review.unjudged + rec.detached.unjudged;

/** Is there nothing to say? Only for a COMPLETE record with every count zero and nothing left unjudged. */
export const pruneIsEmpty = (rec) => rec.complete && !rec.removable && !rec.review.postMerge && !rec.review.noPr && !rec.orphans && !rec.detached.removable && !rec.detached.stale && !notJudgedOf(rec);

/**
 * The counts of a complete record, as words: lower bounds (`≥`) when the budget cut the plan short. Shared by the
 * status line and `next`, so the two never disagree.
 */
export function pruneCountText(rec) {
  const partial = notJudgedOf(rec) > 0;
  const n = (v) => `${partial ? '≥' : ''}${v}`;
  const parts = [`${n(rec.removable)} removable with nothing lost${rec.fresh ? ` (${rec.fresh} fresh)` : ''}`];
  const rv = rec.review;
  const rev = [
    rv.postMerge || partial ? `${n(rv.postMerge)} post-merge (${n(rv.postMergeOnBase)} content on base)` : null,
    rv.noPr || partial ? `${n(rv.noPr)} no-PR (${n(rv.noPrOnBase)} content on base)` : null,
  ].filter(Boolean);
  if (rev.length) parts.push(`review: ${rev.join(', ')}`);
  if (rec.detached.removable || rec.detached.stale || partial) {
    parts.push(`${n(rec.detached.removable)} detached worktree${rec.detached.removable === 1 && !partial ? '' : 's'} removable${rec.detached.stale ? `, ${n(rec.detached.stale)} stale registration${rec.detached.stale === 1 && !partial ? '' : 's'} (listed only)` : ''}`);
  }
  if (rec.orphans) parts.push(`${rec.orphans} orphan director${rec.orphans === 1 ? 'y' : 'ies'}`);
  return `${parts.join(' · ')}${partial ? ` (${notJudgedOf(rec)} not judged within the status budget)` : ''}`;
}

/** The one `fleet status` line. */
export function pruneStatusLine(rec, cmd = 'fleet', alert = null) {
  // The threshold is read from what WAS measured (detached judging and the registered count need no PR list), so it is
  // evaluated before the unmeasured and empty returns, never after them.
  const crossed = pruneAlertCrossed(rec, alert);
  const tail = crossed.crossed ? ` · threshold crossed (${crossed.why.join('; ')})` : '';
  if (!rec.complete) return `prune: unmeasured (${rec.reason}) — \`${cmd} prune\` says what it could not judge${tail}`;
  if (pruneIsEmpty(rec)) return `prune: nothing removable, nothing to review${tail}`;
  return `prune: ${pruneCountText(rec)} — \`${cmd} prune\` (read-only) lists them${tail}`;
}

/**
 * Has the cached count crossed the repo's `.fleet.json` `pruneAlert`? Pure over the record. The `removable` side is what a person could act
 * on: detached worktrees + stale registrations + branch candidates (counted only from a COMPLETE branch half). Anything unjudged makes the
 * sum a LOWER BOUND: it may cross, and one that does not is "not shown crossed", never "below". The `worktrees` side is a direct count,
 * independent of either half. `alert === null` (off) or an unmeasured record never crosses.
 * @returns {{crossed: boolean, lowerBound: boolean, why: string[], applyRemovable: number, stale: number}}
 */
export function pruneAlertCrossed(rec, alert) {
  const none = { crossed: false, lowerBound: false, why: [], applyRemovable: 0, stale: 0, staleKept: 0 };
  if (!alert || !rec) return none;
  const applyRemovable = rec.detached.removable + (rec.complete ? rec.removable : 0);
  const total = applyRemovable + rec.detached.stale;
  const lowerBound = !rec.complete || notJudgedOf(rec) > 0;
  const why = [];
  if (alert.removable && total >= alert.removable) why.push(`${lowerBound ? '≥' : ''}${total} removable (limit ${alert.removable}): ${applyRemovable} branch/worktree removal${applyRemovable === 1 ? '' : 's'}, ${rec.detached.stale} stale registration${rec.detached.stale === 1 ? '' : 's'}`);
  if (alert.worktrees && rec.worktrees !== null && rec.worktrees >= alert.worktrees) why.push(`${rec.worktrees} registered worktrees (limit ${alert.worktrees})`);
  return { crossed: why.length > 0, lowerBound, why, applyRemovable, stale: rec.detached.stale, staleKept: rec.detached.staleKept };
}

/** The ASK `fleet next` prints when the threshold is crossed: what to show the user, and only the action that can address what crossed. */
export function pruneAlertLine(rec, alert, cmd = 'fleet') {
  const c = pruneAlertCrossed(rec, alert);
  if (!c.crossed) return null;
  const asks = [];
  if (c.applyRemovable > 0) asks.push(`whether to run \`${cmd} prune --apply\``);
  if (c.stale > 0 && c.staleKept === 0) asks.push(`whether to run \`git worktree prune\` by hand (repository-wide: it removes every prunable entry git lists; \`${cmd} prune\` names them)`);
  if (c.staleKept > 0) asks.push(`which of the ${c.staleKept} kept stale registration(s) to rescue first (\`${cmd} prune\` names them; the repository-wide \`git worktree prune\` is withheld while they exist)`);
  if (!asks.length) asks.push(`which worktrees to retire (\`${cmd} prune\` lists what is kept and why)`);
  return `ASK for the coordinator's next pass, not an action for this session: prune threshold crossed — ${c.why.join('; ')} — show the user \`${cmd} prune\` (read-only) and ask ${asks.join(' and ')}; removal is the user's decision`;
}

/** Write the cache. Never throws: a failure is returned for a `warning:` line. */
export function writePruneCache(dir, record) {
  try {
    if (!dir) return { ok: false, reason: 'the git common dir could not be resolved' };
    RecordSchema.parse(record);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path.join(dir, PRUNE_CACHE_FILE), `${JSON.stringify(record, null, 2)}\n`);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** Read the cache: `{state:'missing'|'unreadable'|'ok', record?, reason?}`. Never throws. */
export function readPruneCache(dir) {
  if (!dir) return { state: 'unreadable', reason: 'the git common dir could not be resolved' };
  let text;
  try { text = fs.readFileSync(path.join(dir, PRUNE_CACHE_FILE), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', reason: e.code ?? e.message };
  }
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? { state: 'ok', record: parsed.data } : { state: 'unreadable', reason: 'schema mismatch' };
  } catch (e) { return { state: 'unreadable', reason: e.message }; }
}

/** Replace the cache with an unmeasured record (its counts are known to be wrong). Never throws; returns the write. */
export function invalidatePruneCache(dir, reason, at) {
  return writePruneCache(dir, unmeasuredRecord(reason, at));
}
