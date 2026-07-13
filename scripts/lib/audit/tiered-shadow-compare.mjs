/**
 * @fileoverview Tiered-recall pipeline Close-out — prospective shadow
 * validation. Runs `runTieredAuditPipeline` alongside the real, gating
 * `runLegacyProductionAudit` for the SAME commit — observation-only, never
 * gating, never blocking the real result — and logs a structured comparison
 * so an operator can review the accumulated evidence before Phase 14's
 * production-flip decision.
 *
 * **Deliberately NOT built as a 4th arm on the existing model-A/B/C shadow
 * infra** (`audit-shadow.mjs`/`arm-eval/toggle.mjs`), even though the plan's
 * Close-out text suggested reusing it. Traced directly (2026-07-13): that
 * infra's execution engine substitutes a model into the existing PER-PASS
 * GPT-5-pass loop (Thompson sampling, spend-cap reserve/reconcile,
 * Supabase-persisted arm stats) — machinery built for an ONGOING
 * multi-armed-bandit exploration among per-pass model compositions.
 * `runTieredAuditPipeline` is a fundamentally different shape: a
 * self-contained function returning ONE complete `AuditRunResult`
 * (discovery → Stage 0 → Stage 1 → Stage 2), not a per-pass substitution.
 * Forcing it into the bandit shape would mean either inventing new code
 * paths in an already-complex, heavily-audited module for a capability
 * (continuous arm exploration) this ONE-TIME comparison doesn't need, or
 * leaving most of that machinery unused once Phase 14 resolves — future
 * dead code either way. This module is deliberately small, decoupled from
 * `audit-shadow.mjs` entirely, and easy to remove once the shadow-
 * validation window (the plan's own "10-15 real commits") closes.
 *
 * **Concurrency**: neither `runLegacyProductionAudit` nor
 * `runTieredAuditPipeline` mutate `process.cwd()` (verified directly —
 * both only READ it); the chdir hazard that forces the model-eval harness's
 * candidate/baseline generation to serialize is specific to THAT harness's
 * cross-repo corpus-replay wrapper, not to a same-repo production run. The
 * two pipelines are therefore run concurrently here (`Promise.all`-shaped
 * in the caller), cutting shadow-window wall-clock roughly in half versus
 * sequential — real, measured performance, not a hypothetical optimization.
 *
 * **Persistence**: a local, gitignored JSONL log
 * (`.audit/tiered-shadow-log.jsonl`), mirroring the existing
 * `quickfix-scan.mjs` → `.audit/quickfix-hits.jsonl` pattern — Category A
 * per AGENTS.md's generated-artifact policy (non-deterministic runtime
 * output, not a pure function of committed source). No new Supabase schema:
 * this is a bounded, temporary, one-time decision-support artifact (once
 * Phase 14 resolves, its ongoing value drops to ~zero) — provisioning
 * standing cloud infrastructure for it would be the over-engineering cliff
 * this repo's own design-rightsizing gate warns against.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Close-out (shadow validation).
 *
 * @module scripts/lib/audit/tiered-shadow-compare
 */

import fs from 'node:fs';
import path from 'node:path';
import { semanticId } from '../findings.mjs';

export const SHADOW_LOG_PATH = path.join('.audit', 'tiered-shadow-log.jsonl');

/**
 * Build a shadow-safe copy of an `AuditRunContext` — same read-only inputs
 * (diff, files, plan, project context) as the real run, but with every
 * stateful WRITE path disabled so the shadow run cannot mutate anything the
 * real (gating) audit or a future round depends on.
 *
 * `ledgerFile: null` is load-bearing, not a formality: `stage1-triage.mjs`'s
 * own contract is "no ledgerPath means don't write" (verified directly —
 * it is NOT gated by `noLedger`/`noDebtLedger`, which the tiered pipeline
 * doesn't currently read at all) — so a scratch/placeholder path would
 * still write real ledger entries; `null` is the only value that
 * guarantees zero writes.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @returns {import('../schemas.mjs').AuditRunContext}
 */
export function buildShadowCtx(ctx) {
  return {
    ...ctx,
    runId: `${ctx.runId || 'run'}-shadow`,
    ledgerFile: null,
    noLedger: true,
    // Defense-in-depth for any future tiered-pipeline addition that DOES
    // read these flags (it doesn't today) — cheap to set now, expensive to
    // discover missing later.
    noDebtLedger: true,
    readOnlyDebt: true,
  };
}

/**
 * Parse this repo's `_pass_timings.total` convention (`"3.2s"`) into a
 * number of seconds. Returns `null` for anything unparseable — a shape
 * mismatch must never masquerade as `0s`.
 * @param {string|undefined} totalStr
 * @returns {number|null}
 */
function parseTotalSeconds(totalStr) {
  if (typeof totalStr !== 'string') return null;
  const m = totalStr.match(/^([\d.]+)s$/);
  return m ? Number.parseFloat(m[1]) : null;
}

/**
 * Structured, pure comparison between a real (legacy) and shadow (tiered)
 * `AuditRunResult` for the SAME commit. Finding overlap is computed via
 * `semanticId` — this repo's existing content-hash convention for cross-
 * model/cross-round finding identity (findings.mjs), reused rather than a
 * second bespoke fingerprint.
 *
 * @param {import('../schemas.mjs').AuditRunResult} legacyResult
 * @param {import('../schemas.mjs').AuditRunResult} tieredResult
 * @returns {object}
 */
export function compareAuditRunResults(legacyResult, tieredResult) {
  const legacyIds = new Set((legacyResult.findings || []).map(semanticId));
  const tieredIds = new Set((tieredResult.findings || []).map(semanticId));
  const overlapCount = [...legacyIds].filter((id) => tieredIds.has(id)).length;

  return {
    legacyFindingCount: (legacyResult.findings || []).length,
    tieredFindingCount: (tieredResult.findings || []).length,
    overlapCount,
    onlyLegacyCount: legacyIds.size - overlapCount,
    onlyTieredCount: tieredIds.size - overlapCount,
    legacyCostUsd: legacyResult._usage?.costUsd ?? null,
    tieredCostUsd: tieredResult._usage?.costUsd ?? null,
    legacyLatencySec: parseTotalSeconds(legacyResult._pass_timings?.total),
    tieredLatencySec: parseTotalSeconds(tieredResult._pass_timings?.total),
    legacyRunStatus: legacyResult.runStatus ?? null,
    tieredRunStatus: tieredResult.runStatus ?? null,
  };
}

/**
 * Best-effort: run the tiered pipeline as a shadow against `ctx`, returning
 * a discriminated outcome. NEVER throws — a shadow failure (provider error,
 * timeout, bug in not-yet-production-flipped code) must never surface to
 * the caller, since this pipeline hasn't earned production trust yet.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @param {{runTieredAuditPipeline: Function, timeoutMs?: number}} deps - injectable for tests
 * @returns {Promise<{ok: true, result: object, latencyMs: number} | {ok: false, error: string, latencyMs: number}>}
 */
export async function runShadowTieredPipeline(ctx, { runTieredAuditPipeline, timeoutMs = 20 * 60 * 1000 }) {
  const shadowCtx = buildShadowCtx(ctx);
  const start = Date.now();
  // Bug found by the test suite itself (2026-07-13): an uncleared timer from
  // the losing side of Promise.race keeps the event loop alive — with the
  // default 20-minute timeout, every CALLER of this function (tests AND the
  // real CLI) would hang for up to 20 minutes past the real result. Both
  // race outcomes MUST clear the timer.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`shadow timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([runTieredAuditPipeline(shadowCtx), timeout]);
    return { ok: true, result, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Append one shadow-comparison record. Fire-and-forget-safe: any write
 * failure is logged to stderr, never thrown (mirrors `quickfix-scan.mjs`'s
 * existing `.audit/*.jsonl` telemetry pattern — same directory, same
 * append-only shape, same fail-open posture for a non-critical log).
 * @param {object} record
 * @param {string} [logPath]
 */
export function appendShadowLog(record, logPath = SHADOW_LOG_PATH) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write(`  [tiered-shadow] WARNING: failed to write shadow log: ${err.message}\n`);
  }
}

/**
 * Orchestrates one shadow-validation observation for a real audit run.
 * Call concurrently with the real `runLegacyProductionAudit(ctx)` (the
 * caller starts both, awaits legacy first for the real result, then awaits
 * this) — never sequences shadow-after-legacy, which would double real
 * wall-clock for no reason (see module header on the chdir-safety check
 * that makes concurrency safe here).
 *
 * @param {{ctx: object, legacyResultPromise: Promise<object>, runTieredAuditPipeline: Function, logPath?: string}} args
 * @returns {Promise<void>} always resolves, never rejects
 */
export async function runTieredShadowComparison({ ctx, legacyResultPromise, runTieredAuditPipeline, logPath = SHADOW_LOG_PATH }) {
  const shadowOutcome = await runShadowTieredPipeline(ctx, { runTieredAuditPipeline });
  let legacyResult;
  try {
    legacyResult = await legacyResultPromise;
  } catch {
    // The real run itself failed — nothing to compare against. Still worth
    // recording that the shadow ran (or didn't), but there's no comparison.
    appendShadowLog({
      timestamp: new Date().toISOString(), runId: ctx.runId || null,
      legacyOk: false, shadowOk: shadowOutcome.ok, shadowLatencyMs: shadowOutcome.latencyMs,
      shadowError: shadowOutcome.ok ? null : shadowOutcome.error, comparison: null,
    }, logPath);
    return;
  }
  appendShadowLog({
    timestamp: new Date().toISOString(), runId: ctx.runId || null,
    legacyOk: true, shadowOk: shadowOutcome.ok, shadowLatencyMs: shadowOutcome.latencyMs,
    shadowError: shadowOutcome.ok ? null : shadowOutcome.error,
    comparison: shadowOutcome.ok ? compareAuditRunResults(legacyResult, shadowOutcome.result) : null,
  }, logPath);
}
