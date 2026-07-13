/**
 * @fileoverview Persistence for the tiered-recall audit pipeline's Close-out
 * shadow validation — `tiered_shadow_observations`. Single-tenant DB (per
 * this repo's postgres-parity model: the DSN password is the only secret,
 * no cross-tenant concern), so `getTieredShadowObservations` accepts an
 * explicit `repoIds` list rather than an ambient "all repos" scan — the
 * caller (the report CLI) resolves which local checkouts to aggregate,
 * this module never guesses.
 *
 * Cloud-optional throughout: every function checks `isCloudEnabled()` and
 * returns a `{cloud:false}` shape when off. The local
 * `.audit/tiered-shadow-log.jsonl` (tiered-shadow-compare.mjs) remains the
 * always-available fallback — this is additive persistence, not a
 * replacement.
 *
 * Plan: docs/completed/tiered-recall-audit-pipeline.md (Close-out).
 *
 * @module scripts/lib/store/tiered-shadow
 */

import { z } from 'zod';
import { insertReturning, many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

const AppendObservationSchema = z.object({
  repoId: z.string().min(1),
  runId: z.string().nullable().optional(),
  legacyOk: z.boolean(),
  shadowOk: z.boolean(),
  shadowError: z.string().nullable().optional(),
  shadowLatencyMs: z.number().int().nonnegative().nullable().optional(),
  comparison: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * Best-effort append — NEVER throws to the caller. The shadow mechanism is
 * observation-only by design (see tiered-shadow-compare.mjs's header); a
 * persistence failure must not compound into a louder failure than the
 * thing it's merely recording.
 *
 * @param {{repoId: string, runId?: string|null, legacyOk: boolean, shadowOk: boolean, shadowError?: string|null, shadowLatencyMs?: number|null, comparison?: object|null}} rawArgs
 * @returns {Promise<{ok: boolean, cloud: boolean, id?: string, error?: string}>}
 */
export async function appendTieredShadowObservation(rawArgs) {
  let args;
  try {
    args = AppendObservationSchema.parse(rawArgs);
  } catch (err) {
    return { ok: false, cloud: false, error: `invalid args: ${err.message}` };
  }
  if (!await isCloudEnabled()) return { ok: true, cloud: false };
  try {
    const row = await insertReturning('tiered_shadow_observations', {
      repo_id: args.repoId,
      run_id: args.runId ?? null,
      legacy_ok: args.legacyOk,
      shadow_ok: args.shadowOk,
      shadow_error: args.shadowError ?? null,
      shadow_latency_ms: args.shadowLatencyMs ?? null,
      comparison: args.comparison ?? null,
    }, { returning: ['id'] });
    return { ok: true, cloud: true, id: row.id };
  } catch (err) {
    return { ok: false, cloud: true, error: err.message };
  }
}

const GetObservationsArgsSchema = z.object({
  repoIds: z.array(z.string().min(1)).min(1),
  sinceDays: z.number().int().positive().max(365).default(90),
  limit: z.number().int().positive().max(5000).default(2000),
});

/**
 * Read path mirrors the append path's failure contract: cloud-disabled,
 * cloud-unavailable (a real DB/network error), and cloud-successful are
 * three distinct outcomes, none of which throws to the caller — the
 * report CLI needs to tell "no runs yet" apart from "couldn't check" so
 * it can fall back to the local log instead of reporting a false zero.
 *
 * `truncated: true` signals the LIMIT was hit. The query orders by
 * `created_at DESC` (newest first) so a truncated result keeps the MOST
 * RECENT observations and drops the oldest — the correct direction for a
 * production-readiness decision gate, which needs current pipeline
 * behavior, not stale data from the start of the window (Gemini final-
 * review fix, 2026-07-13 — the query originally ordered ASC, which kept
 * the OLDEST rows on truncation). Re-reversed to ascending before return
 * so callers (summarize(), which is order-independent, and any future
 * chronological consumer) see the conventional oldest-to-newest shape.
 *
 * @param {{repoIds: string[], sinceDays?: number, limit?: number}} rawArgs
 * @returns {Promise<{ok: boolean, cloud: boolean, rows: object[], truncated?: boolean, error?: string}>}
 */
export async function getTieredShadowObservations(rawArgs) {
  const args = GetObservationsArgsSchema.parse(rawArgs);
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const rows = await many(
      `SELECT repo_id, run_id, legacy_ok, shadow_ok, shadow_error, shadow_latency_ms, comparison, created_at
         FROM tiered_shadow_observations
        WHERE repo_id = ANY($1) AND created_at >= now() - ($2 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT $3`,
      [args.repoIds, String(args.sinceDays), args.limit],
    );
    return { ok: true, cloud: true, rows: rows.reverse(), truncated: rows.length === args.limit };
  } catch (err) {
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}
