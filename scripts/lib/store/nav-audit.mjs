/**
 * @fileoverview Persistence for nav-audit v2 run history — WS2 of
 * docs/plans/persona-nav-feedback-recovery.md. The deferred
 * `record-nav-audit-run` command has been a no-op stub, so drift aging
 * (the >14-day governance smell) has had no cloud data source at all —
 * this module is what closes that gap.
 *
 * Single-tenant DB (bare `repo_id`, no FK — mirrors
 * `tiered_shadow_observations`). Cloud-optional throughout.
 *
 * @module scripts/lib/store/nav-audit
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { upsert, many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { runWindowCountQuery } from './window-count-query.mjs';

/**
 * Stable content identity for a run's audited output — sorted so key
 * ORDER never affects the hash (two runs finding the same drift in a
 * different extraction order must still dedupe as the SAME content).
 * Code-audit H2/H6/M3 fix: `(repo_id, head_sha, scope)` alone doesn't
 * identify what a diff-scope run actually audited (the uncommitted
 * working tree); this hash makes two runs with genuinely different
 * `drift_keys` persist as distinct rows instead of colliding.
 */
export function driftKeysContentHash(driftKeys) {
  const sorted = [...driftKeys].sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

const RecordRunArgsSchema = z.object({
  repoId: z.string().min(1),
  headSha: z.string().min(1),
  scope: z.string().min(1),
  driftKeys: z.array(z.string()),
  findingCounts: z.record(z.string(), z.unknown()).nullable().optional(),
  verifySummary: z.record(z.string(), z.unknown()).nullable().optional(),
  toolVersion: z.union([z.string(), z.number()]).nullable().optional(),
});

/**
 * Best-effort, OBSERVABLE upsert — never throws, but never silently
 * swallows a real write failure either (the standing silent-DB-write
 * class this repo's own audit checklist flags as HIGH). Conflict target
 * is `(repo_id, head_sha, scope, content_hash)` with `DO NOTHING` — an
 * EXACT rerun (same repo/sha/scope AND the same audited `drift_keys`)
 * dedupes and preserves the FIRST row's `created_at` (the timestamp drift
 * aging depends on). A diff-scope rerun at the same `head_sha` that finds
 * DIFFERENT `drift_keys` (the uncommitted tree changed between runs) now
 * gets a different `content_hash` and persists as its own row — closes
 * the data-loss gap code-audit rounds 2-3 (H2/H6/M3) correctly identified
 * in the original `(repo_id, head_sha, scope)`-only identity, which
 * couldn't distinguish two diff-scope runs auditing different content at
 * the same commit.
 *
 * @param {{repoId: string, headSha: string, scope: string, driftKeys: string[],
 *   findingCounts?: object|null, verifySummary?: object|null, toolVersion?: string|number|null}} rawArgs
 * @returns {Promise<{status: 'recorded'|'deduplicated'|'unavailable'|'failed', error?: string}>}
 */
export async function recordNavAuditRun(rawArgs) {
  const parsed = RecordRunArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return { status: 'failed', error: `invalid args: ${parsed.error.message}` };
  }
  const args = parsed.data;
  if (!await isCloudEnabled()) return { status: 'unavailable' };
  try {
    // insertReturning → buildInsert is a PLAIN insert (it does not accept
    // onConflict/update at all — a real bug caught by an empirical DB
    // smoke test, not by any unit test, since the hermetic tests here
    // never exercise a live conflict). upsert() → buildUpsert is the
    // conflict-aware path and is required here.
    const rows = await upsert(
      'nav_audit_runs',
      [{
        repo_id: args.repoId,
        head_sha: args.headSha,
        scope: args.scope,
        drift_keys: args.driftKeys,
        content_hash: driftKeysContentHash(args.driftKeys),
        finding_counts: args.findingCounts ?? null,
        verify_summary: args.verifySummary ?? null,
        tool_version: args.toolVersion != null ? String(args.toolVersion) : null,
      }],
      { onConflict: ['repo_id', 'head_sha', 'scope', 'content_hash'], update: 'ignore', returning: ['id'] },
    );
    // `update: 'ignore'` (DO NOTHING) means a conflicting write returns no
    // row — upsert() gives us [] in that case, [row] on a real insert.
    return { status: rows.length > 0 ? 'recorded' : 'deduplicated' };
  } catch (err) {
    process.stderr.write(`  [nav-audit-store] recordNavAuditRun failed: ${err.message}\n`);
    return { status: 'failed', error: err.message };
  }
}

const RunHistoryArgsSchema = z.object({
  repoId: z.string().min(1),
  sinceDays: z.number().int().positive().max(365).default(180),
  // Code-audit M3/M10 fix: `limit` is a hard SAFETY BACKSTOP, not a routine
  // truncation point — the real bound is `sinceDays`. The original default
  // of 200 could silently truncate the window itself (a repo running
  // nav-audit more than ~1x/day would drop `firstSeenFromHistory`'s ability
  // to see a genuinely-old key's true first occurrence, UNDERSTATING its
  // age). 5000 rows over up to 365 days is >13/day before this backstop can
  // bind — comfortably above realistic single-repo cadence.
  limit: z.number().int().positive().max(20000).default(5000),
});

/**
 * Raw run-history rows, bounded by `sinceDays` — deliberately NOT a
 * server-side per-key aggregation. `scripts/lib/nav/drift.mjs` already
 * exports `firstSeenFromHistory(historyRows)`, a pure, already-tested
 * reducer built for exactly this `{driftKeys, capturedAt}` row shape (it
 * predates WS2 — this store function is the cloud reader it was designed
 * for but never had). Reusing it here means one reduction implementation
 * instead of two: this store fetches, `firstSeenFromHistory` reduces.
 *
 * @param {{repoId: string, sinceDays?: number, limit?: number}} rawArgs
 * @returns {Promise<{ok: boolean, rows: Array<{driftKeys: string[], capturedAt: string}>, truncated: boolean, error?: string}>}
 *   `truncated: true` (code-audit M4/M8 fix) means the `limit` safety
 *   backstop bound the result — `firstSeenFromHistory` over these rows may
 *   UNDERSTATE age for a key whose true first occurrence fell outside the
 *   returned window. Never silently claimed complete.
 */
export async function listNavAuditRunHistory(rawArgs) {
  const parsed = RunHistoryArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, rows: [], truncated: false, error: `invalid args: ${parsed.error.message}` };
  const args = parsed.data;
  if (!await isCloudEnabled()) return { ok: true, rows: [], truncated: false };
  try {
    // Fetch one EXTRA row (code-audit L1 fix): `rows.length >= limit` alone
    // can't distinguish "exactly `limit` rows exist" from "more rows were
    // cut off" — both look identical from a plain `LIMIT $3` result. Asking
    // for `limit + 1` and slicing back down makes truncation an OBSERVED
    // fact (a row beyond the returned page existed), not an inference from
    // count alone.
    const rows = await many(
      `SELECT drift_keys, created_at
         FROM nav_audit_runs
        WHERE repo_id = $1
          AND created_at >= now() - ($2 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT $3`,
      [args.repoId, String(args.sinceDays), args.limit + 1],
    );
    const truncated = rows.length > args.limit;
    if (truncated) rows.length = args.limit;
    return {
      ok: true,
      rows: rows.map((r) => ({ driftKeys: r.drift_keys ?? [], capturedAt: r.created_at })),
      truncated,
    };
  } catch (err) {
    process.stderr.write(`  [nav-audit-store] listNavAuditRunHistory failed: ${err.message}\n`);
    return { ok: false, rows: [], truncated: false, error: err.message };
  }
}

/**
 * Window-scoped row counts for the skill-efficacy census
 * (docs/plans/skill-efficacy-census.md Phase 2). `listNavAuditRunHistory`
 * returns a truncated recent-history list; this is a separate aggregate
 * query, purpose-built for the census's current/prior window semantics.
 *
 * @param {string} repoId
 * @param {{currentStart: string, priorStart: string, now: string}} bounds ISO timestamps
 * @returns {Promise<{current: number, prior: number, allTime: number}|null>}
 */
export async function getNavAuditWindowCounts(repoId, { currentStart, priorStart, now }) {
  return runWindowCountQuery({
    repoGuard: repoId, table: 'nav_audit_runs',
    params: [repoId, currentStart, now, priorStart],
    errorLabel: 'getNavAuditWindowCounts',
  });
}
