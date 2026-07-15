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
 * **Persistence — local + cloud, cloud optional** (revised 2026-07-13): a
 * local, gitignored JSONL log (`.audit/tiered-shadow-log.jsonl`, mirroring
 * `quickfix-scan.mjs` → `.audit/quickfix-hits.jsonl`) remains the always-
 * available fallback, PLUS a best-effort write to `tiered_shadow_
 * observations` (`store/tiered-shadow.mjs`) via the existing single-tenant
 * Supabase project every repo already shares. The original "local-only,
 * no new schema" design was reconsidered once a REAL requirement surfaced:
 * the shadow-validation window spans 3 repos on one operator's machine, and
 * "how many total shadow runs have we accumulated across all of them" has
 * no answer from 3 independent local files without manually summing. The
 * cloud write reuses this repo's already-provisioned DB (no new
 * infrastructure, just one more table + one insert call) and matches the
 * project's own stated convention that cross-skill data flows through the
 * shared store — this is closing a gap in that convention, not violating
 * the design-rightsizing gate the original reasoning invoked.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Close-out (shadow validation).
 *
 * @module scripts/lib/audit/tiered-shadow-compare
 */

import fs from 'node:fs';
import path from 'node:path';
import { semanticId } from '../findings.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { appendTieredShadowObservation } from '../store/tiered-shadow.mjs';

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
    ledgerFile: null,
    noLedger: true,
    // Defense-in-depth for any future tiered-pipeline addition that DOES
    // read these flags (it doesn't today) — cheap to set now, expensive to
    // discover missing later.
    noDebtLedger: true,
    readOnlyDebt: true,
    // Blocks ALL learning-store writes (audit_runs, audit_findings, pass
    // stats, decisions, …) in runLegacyProductionAudit's cloud-recording
    // block — reached when the tiered pipeline falls back to it internally
    // on a required-generator failure, running CONCURRENTLY with the real,
    // gating legacy audit for the same commit. `ctx.runId` is kept
    // UNCHANGED (not mangled) — it's still used as a local telemetry label
    // (tiered-pipeline.mjs's `_sid`), just never reaches a DB write here.
    // Previously mangled to `${runId}-shadow` to dodge colliding with the
    // real run's row, which isn't a valid uuid and made every attempt fail
    // loudly (`invalid input syntax for type uuid`) instead of writing
    // nothing — this flag is the actual fix, not a differently-shaped id.
    noCloudRecording: true,
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
    // Load-bearing for diagnosability (2026-07-14 incident): without this,
    // a 100%-fallback window is invisible in stored telemetry — only
    // `tieredRunStatus:'fallback_legacy'` is recorded, never WHY, so
    // confirming it requires a live repro instead of a DB query.
    tieredFallbackReason: tieredResult.fallbackReason ?? null,
    // docs/plans/oss-call-reliability-hardening.md round-3 H1/H2: typed
    // Stage-1 telemetry (classified-failure categories + admission-guard
    // skip count), not prose-only — mirrors the tieredFallbackReason
    // pattern above (copy straight from the AuditRunResult into the
    // persisted comparison record).
    tieredStage1BudgetExhausted: tieredResult._stage1BudgetExhausted ?? null,
    tieredStage1FailureCategories: tieredResult._stage1FailureCategories ?? null,
    // Diagnosability (2026-07-15): a `complete` shadow run with 0 findings
    // was previously indistinguishable in stored telemetry from "both
    // generators genuinely found nothing" vs "candidates existed but were
    // dropped somewhere in Stage 0/1/2" — both fields already existed on
    // the full tieredResult (overall_reasoning's structured source), just
    // never copied into the persisted record. Same copy-straight-through
    // convention as tieredFallbackReason/tieredStage1* above.
    tieredGeneratorOutcomes: tieredResult.generatorOutcomes ?? null,
    tieredStageBreakdown: tieredResult._stageBreakdown ?? null,
  };
}

/**
 * Best-effort: run the tiered pipeline as a shadow against `ctx`, returning
 * a discriminated outcome. NEVER throws — a shadow failure (provider error,
 * timeout, bug in not-yet-production-flipped code) must never surface to
 * the caller, since this pipeline hasn't earned production trust yet.
 *
 * **Worst-case budget reconciliation** (docs/plans/oss-call-reliability-hardening.md
 * Execution Model — deliberate, not accidental): the default `timeoutMs` below
 * (20 min) is the outer ceiling every inner stage's budget is reasoned against.
 * `oss-call-policy.json`'s `stage1TriageBudget.totalMs` (10 min) reserves the
 * ENTIRE sequential Stage-1 admission-guard loop's ceiling, leaving ~10 min for
 * discovery (`stage1_triage`/`discovery_generation` policies, worst case
 * ~241s for discovery alone) + Stage 2's Gemini adjudication + overhead. The
 * Stage-1 admission guard (`stage1-triage.mjs`) BOUNDS how much new work Stage 1
 * can *start* within its reservation — it does NOT cancel work already in
 * flight: `Promise.race` below does not cancel its losing promise, so an inner
 * OpenRouter call can keep running (and spending) after this outer race has
 * already recorded a timeout. That is a known, independent, pre-existing
 * limitation (deferred, not solved by the admission guard) — fixing it would
 * require threading an `AbortSignal`/cancellation context through the entire
 * inner pipeline, a materially larger change than this budget reconciliation.
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
    await recordObservation({
      ctx, logPath,
      legacyOk: false, shadowOk: shadowOutcome.ok, shadowLatencyMs: shadowOutcome.latencyMs,
      shadowError: shadowOutcome.ok ? null : shadowOutcome.error, comparison: null,
    });
    return;
  }
  await recordObservation({
    ctx, logPath,
    legacyOk: true, shadowOk: shadowOutcome.ok, shadowLatencyMs: shadowOutcome.latencyMs,
    shadowError: shadowOutcome.ok ? null : shadowOutcome.error,
    comparison: shadowOutcome.ok ? compareAuditRunResults(legacyResult, shadowOutcome.result) : null,
  });
}

/**
 * Writes one observation to BOTH sinks — local JSONL (always) and Supabase
 * (best-effort, cloud-optional). The cloud write's `repoId` comes from
 * `resolveRepoIdentity()` (synchronous, local git reads only, no network) —
 * NOT threaded through `ctx`, since it's a repo-wide fact, not a per-run
 * input. A cloud-write failure is logged, never thrown — this function's
 * whole contract (matching its callers') is "always resolves".
 * @param {{ctx: object, logPath: string, legacyOk: boolean, shadowOk: boolean, shadowLatencyMs: number, shadowError: string|null, comparison: object|null}} args
 */
async function recordObservation({ ctx, logPath, legacyOk, shadowOk, shadowLatencyMs, shadowError, comparison }) {
  appendShadowLog({
    timestamp: new Date().toISOString(), runId: ctx.runId || null,
    legacyOk, shadowOk, shadowLatencyMs, shadowError, comparison,
  }, logPath);
  try {
    const { repoUuid } = resolveRepoIdentity();
    const result = await appendTieredShadowObservation({
      repoId: repoUuid, runId: ctx.runId ?? null,
      legacyOk, shadowOk, shadowError, shadowLatencyMs, comparison,
    });
    if (!result.ok) {
      process.stderr.write(`  [tiered-shadow] WARNING: cloud persistence failed (local log unaffected): ${result.error}\n`);
    }
  } catch (err) {
    process.stderr.write(`  [tiered-shadow] WARNING: cloud persistence failed (local log unaffected): ${err.message}\n`);
  }
}
