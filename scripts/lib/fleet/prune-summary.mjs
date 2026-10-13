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
export const PRUNE_CACHE_SCHEMA_VERSION = 1;
/** `fleet status`'s budget for planning the prune; past it, branches are counted as not judged. */
export const PRUNE_STATUS_BUDGET_MS = 30_000;

const count = z.number().int().nonnegative();
const RecordSchema = z.object({
  schemaVersion: z.literal(PRUNE_CACHE_SCHEMA_VERSION),
  at: z.string().refine((s) => Number.isFinite(Date.parse(s)), { message: 'at must be a parseable time' }),
  complete: z.boolean(),
  reason: z.string().optional(),
  removable: count, fresh: count, kept: count, unjudged: count, orphans: count,
  review: z.object({ postMerge: count, postMergeOnBase: count, noPr: count, noPrOnBase: count, unjudged: count }).strict(),
}).strict()
  .refine((r) => r.complete === (r.reason === undefined), { message: 'reason is present exactly when complete is false' })
  .refine((r) => r.fresh <= r.removable && r.review.postMergeOnBase <= r.review.postMerge && r.review.noPrOnBase <= r.review.noPr,
    { message: 'a subset count exceeds its total' });

/**
 * The summary record of a `planPrune` result. `at` is when the facts were observed, so the record's age is honest.
 * @param {ReturnType<import('./prune.mjs').planPrune>} plan
 * @param {string} at ISO time
 */
export function summarisePrune(plan, at) {
  const r = plan.review ?? { postMerge: [], noPr: [], unjudged: 0 };
  const complete = plan.complete === true;
  return {
    schemaVersion: PRUNE_CACHE_SCHEMA_VERSION, at, complete,
    ...(complete ? {} : { reason: plan.notJudged?.[0] ?? 'the prune plan was not judged' }),
    removable: plan.candidates.length, fresh: plan.candidates.filter((c) => c.fresh).length, kept: plan.excluded.length,
    unjudged: plan.unjudged ?? 0, orphans: plan.orphans?.dirs?.length ?? 0,
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
    review: { postMerge: 0, postMergeOnBase: 0, noPr: 0, noPrOnBase: 0, unjudged: 0 },
  };
}

const notJudgedOf = (rec) => rec.unjudged + rec.review.unjudged;

/** Is there nothing to say? Only for a COMPLETE record with every count zero and nothing left unjudged. */
export const pruneIsEmpty = (rec) => rec.complete && !rec.removable && !rec.review.postMerge && !rec.review.noPr && !rec.orphans && !notJudgedOf(rec);

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
  if (rec.orphans) parts.push(`${rec.orphans} orphan director${rec.orphans === 1 ? 'y' : 'ies'}`);
  return `${parts.join(' · ')}${partial ? ` (${notJudgedOf(rec)} not judged within the status budget)` : ''}`;
}

/** The one `fleet status` line. */
export function pruneStatusLine(rec, cmd = 'fleet') {
  if (!rec.complete) return `prune: unmeasured (${rec.reason}) — \`${cmd} prune\` says what it could not judge`;
  if (pruneIsEmpty(rec)) return 'prune: nothing removable, nothing to review';
  return `prune: ${pruneCountText(rec)} — \`${cmd} prune\` (read-only) lists them`;
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
