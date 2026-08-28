/**
 * @fileoverview Map-reduce scheduling for the audit pipeline — per-unit
 * dispatch, cache-seed warm-up ordering, and concurrency-bounded fan-out.
 *
 * Extracted from `legacy-production-audit.mjs` (docs/plans/legacy-production-audit-decomposition.md
 * Phase 2) — a pure relocation, verbatim bodies, no behaviour change.
 *
 * `PassFindingsSchema` moved here from the orchestrator (it is
 * `runOneMapUnit`'s own per-unit output contract); the orchestrator spine
 * still uses it directly for its own non-map-reduce single-shot pass calls
 * and imports it back from here — allowed by this plan's dependency
 * direction (spine → this module), never the reverse.
 *
 * @module scripts/lib/audit/map-reduce-scheduler
 */

import fs from 'node:fs';
import { z } from 'zod';
import { ProducerFindingSchema, ReduceStatus, reduceStatusFromErrorCategory, buildExecutionMeta } from '../schemas.mjs';
import { safeInt, normalizePath, readFilesAsContext } from '../file-io.mjs';
import { buildAuditUnits, measureContextChars, REDUCE_SYSTEM_PROMPT } from '../code-analysis.mjs';
import { callGPT, safeCallGPT } from './llm-helpers.mjs';
import {
  buildReducePayload, MAX_REDUCE_JSON_CHARS, MAP_FAILURE_THRESHOLD, computePassLimits, addUsage,
  LlmError, normalizeFindingsForOutput as _normalizeFindingsForOutput,
} from '../robustness.mjs';
import { semanticId } from '../findings.mjs';
import { openaiConfig, auditRuntimeConfig } from '../config.mjs';

// ── Code-audit-orchestration-specific thresholds (moved from openai-audit.mjs
// alongside shouldMapReduce/shouldMapReduceHighReasoning below — only this
// file's orchestration loop reads them) ─────────────────────────────────────
const MAP_REDUCE_THRESHOLD = openaiConfig.mapReduceThreshold;
const MAP_REDUCE_TOKEN_THRESHOLD = openaiConfig.mapReduceTokenThreshold;
const HIGH_REASONING_MAP_REDUCE_THRESHOLD = openaiConfig.highReasoningMapReduceThreshold;
const HIGH_REASONING_MAP_REDUCE_TOKEN_THRESHOLD = openaiConfig.highReasoningMapReduceTokenThreshold;

// Same tiny semanticId-wrapped normalizer as pass-result-cache.mjs's own —
// duplicated rather than cross-imported: neither new module is on the
// other's allow-list in this plan's dependency direction, and it's three
// lines wrapping two pre-existing shared primitives (robustness.mjs,
// findings.mjs), not new logic.
// @duplicate-justification: target=scripts/lib/audit/pass-result-cache.mjs:normalizeFindingsForOutput reason=deliberate — see the comment above; neither new module may import the other under this plan's dependency direction, and this is 3 lines wrapping 2 pre-existing shared primitives
function normalizeFindingsForOutput(findings) {
  return _normalizeFindingsForOutput(findings, semanticId);
}

export const PassFindingsSchema = z.object({
  pass_name: z.string().max(30),
  findings: z.array(ProducerFindingSchema).max(15).describe('Top 15 findings, sorted by severity (HIGH first). Prefer fewer deep findings over many shallow ones.'),
  quick_fix_warnings: z.array(z.string().max(300)).max(5),
  summary: z.string().max(500).describe('Brief summary of this pass')
});

/** Check if a file set should use map-reduce (by count OR total size). */
export function shouldMapReduce(files) {
  if (files.length > MAP_REDUCE_THRESHOLD) return true;
  const totalChars = measureContextChars(files, 10000);
  return totalChars > MAP_REDUCE_TOKEN_THRESHOLD;
}

/**
 * Like shouldMapReduce() but uses lower thresholds for reasoning:high passes
 * (backend, frontend). These time out as single calls at ~36% on Windows —
 * splitting into smaller map-reduce units keeps each unit under 140s.
 */
export function shouldMapReduceHighReasoning(files) {
  if (files.length > HIGH_REASONING_MAP_REDUCE_THRESHOLD) return true;
  const totalChars = measureContextChars(files, 10000);
  return totalChars > HIGH_REASONING_MAP_REDUCE_TOKEN_THRESHOLD;
}

// Run-scoped flag: true once ANY pass in this run effectively used the cache
// seed (decideSeed → seedUsed). Read at cache-telemetry aggregation to record
// run-level `cache_seed_enabled`. Safe in the CLI-per-invocation model (one run
// per process; reset at runMultiPassCodeAudit start for any in-process re-run).
let _runSeedUsed = false;

// Companions to `_runSeedUsed`, and the reason the seed A/B has a control arm.
// `_runSeedEligible` is true once ANY pass COULD have seeded, whether or not it
// did; `_runSeedSkipReason` records why the first non-seeding pass declined.
// Together they separate "seeding was withheld" (eligible + env-disabled — the
// control) from "seeding was impossible here" (single unit / prefix too small),
// which `cache_seed_enabled=false` alone conflates into one useless cohort.
let _runSeedEligible = false;
let _runSeedSkipReason = null;

/**
 * Reset the run-scoped cache-seed telemetry flags. Called by the orchestration
 * spine at the start of each run (CLI = one run/process, but the flags are
 * module state so an in-process re-run needs an explicit reset).
 */
export function resetSeedTelemetry() {
  _runSeedUsed = false;
  _runSeedEligible = false;
  _runSeedSkipReason = null;
}

/**
 * Read the run-scoped cache-seed telemetry flags. Called by run-telemetry.mjs
 * (Phase 4d) at cache-telemetry aggregation to record `cache_seed_enabled`.
 */
export function getSeedTelemetry() {
  return { seedUsed: _runSeedUsed, seedEligible: _runSeedEligible, seedSkipReason: _runSeedSkipReason };
}

// Cache-seed eligibility policy (plan §7c). Returns the seed decision
// envelope { seedEligible, seedUsed, seedSkipReason, seedUnitIdx, seedUnitTokens }
// so the audit-pass telemetry can record which mode ran.
export function decideSeed(units, passName, buildPromptForUnit) {
  // Default-ON since 2026-07-14 (PR-6 flip; docs/plans/openai-prefix-cache.md §8).
  // Opt out per-run with AUDIT_CACHE_SEED=0. The cache-hitrate-check routine
  // validates the flip empirically from the seed-ON cohort in audit_runs.
  const envFlag = process.env.AUDIT_CACHE_SEED !== '0';
  const minPrefix = safeInt(process.env.AUDIT_CACHE_STABLE_PREFIX_MIN, 1024);
  const decision = { seedEligible: false, seedUsed: false, seedSkipReason: null, seedUnitIdx: null, seedUnitTokens: null };

  // ELIGIBILITY IS EVALUATED BEFORE THE ENV FLAG — deliberately, and it is the
  // whole reason the seed cohorts are comparable (2026-08-08).
  //
  // This function used to return immediately on `!envFlag`, so a run with
  // AUDIT_CACHE_SEED=0 was never assessed for eligibility. Every opted-out run
  // therefore looked identical to a run that could never have seeded anyway
  // (single-unit, or too small a stable prefix). The seed-OFF cohort was thus a
  // mix of two populations, and since `units.length <= 1` correlates with small
  // audits, seed-OFF was systematically smaller than seed-ON. Comparing their
  // hit rates measured audit size, not seeding — see docs/plans/openai-prefix-cache.md.
  //
  // Evaluating eligibility first costs one extra `buildPromptForUnit` probe on
  // opted-out runs. That probe builds a prompt from an empty `_context`, so it
  // reads no files and makes no API call — cheap enough to pay for a control group.
  if (units.length <= 1) {
    decision.seedSkipReason = 'units.length<=1';
    return decision;
  }
  // Pick the smallest unit by code length (proxy for tokens) — its only job
  // is to warm the cache; smaller seed = lower latency cost.
  let seedIdx = 0;
  let seedLen = Infinity;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const len = u.chunk
      ? (u.chunk.imports?.length ?? 0) + u.chunk.items.reduce((s, it) => s + (it.source?.length ?? 0), 0)
      : u.files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
    if (len < seedLen) { seedLen = len; seedIdx = i; }
  }
  // Sanity-estimate the stable prefix by building one unit's prompt with the
  // smallest payload — if msg #1 is below threshold, seeding is pointless.
  try {
    const probe = buildPromptForUnit({ ...units[seedIdx], _context: '' }, seedIdx, units.length, 'probe');
    const prefixChars = (probe.system?.length ?? 0) + (probe.messages?.[0]?.content?.length ?? 0);
    const prefixTokens = Math.ceil(prefixChars / 4);
    if (prefixTokens < minPrefix) {
      decision.seedSkipReason = 'prefix-too-small';
      decision.seedEligible = false;
      decision.seedUnitIdx = seedIdx;
      decision.seedUnitTokens = prefixTokens;
      return decision;
    }
    decision.seedEligible = true;
    decision.seedUnitIdx = seedIdx;
    decision.seedUnitTokens = prefixTokens;
    // The env flag gates USE, never eligibility. An eligible-but-opted-out run
    // is the control arm: same shape as a seeded run, seeding withheld.
    if (!envFlag) {
      decision.seedSkipReason = 'env-disabled';
      return decision;
    }
    decision.seedUsed = true;
    return decision;
  } catch (err) {
    decision.seedSkipReason = `probe-failed:${err.message?.slice(0, 60)}`;
    return decision;
  }
}

// Re-throw config-category LlmErrors from a Promise.allSettled rejection
// so programmer wiring bugs surface immediately rather than being swallowed
// (Gemini-R1/MED fix to plan §6).
export function throwIfConfigError(settled) {
  if (settled && settled.status === 'rejected'
      && settled.reason instanceof LlmError
      && settled.reason.llmCategory === 'config') {
    throw settled.reason;
  }
}

// Run one map-reduce unit. Extracted from runMapReducePass body so the
// cache-seed path (sequential seed → parallel fanout) can re-use the same
// per-unit logic without duplicating retry/context wiring.
export async function runOneMapUnit(openai, unit, i, totalUnits, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot) {
  if (acquireSlot) await acquireSlot();
  try {
    const context = unit.chunk
      ? `// ${unit.files[0]} (chunk)\n${unit.chunk.imports}\n\n${unit.chunk.items.map(it => it.source).join('\n\n')}`
      : readFilesAsContext(unit.files, { maxPerFile: 10000, maxTotal: 80000 });

    const limits = computePassLimits(context.length, 'high');
    const unitHasChangedFiles = !changedFileSet || unit.files.some(f => changedFileSet.has(normalizePath(f)));
    const maxRetries = unitHasChangedFiles ? undefined : 0;

    const unitLabel = `Audit Unit ${i + 1}/${totalUnits} (${unit.files.length} files)`;
    const { system, messages } = buildPromptForUnit({ ...unit, _context: context }, i, totalUnits, unitLabel);

    return await callGPT(openai, {
      system,
      messages,
      schema: PassFindingsSchema,
      schemaName: `map_${passName}_${i}`,
      reasoning: 'high',
      ...limits,
      passName: `map-${passName}-${i}`,
      maxRetries,
    });
  } finally {
    if (releaseSlot) releaseSlot();
  }
}

export async function runMapReducePass(openai, files, passName, buildPromptForUnit, maxFilesPerUnit = Infinity, { changedFileSet = null } = {}) {
  const units = buildAuditUnits(files, 30000, maxFilesPerUnit);

  // MAP phase: parallel calls with concurrency limit. Phase 7
  // (audit-orchestrator-hardening): now reads the bounds-validated
  // `auditRuntimeConfig.mapReduceConcurrency` (config.mjs) instead of a
  // bare inline `safeInt(process.env.MAP_REDUCE_CONCURRENCY, 5)` — closes
  // the "one holdout env var outside config.mjs" inconsistency and clamps
  // to [1, 20] (below 1 would deadlock the slot-acquire loop below).
  const CONCURRENCY_LIMIT = auditRuntimeConfig.mapReduceConcurrency;
  let active = 0;
  const queue = [];
  const acquireSlot = () => active < CONCURRENCY_LIMIT ? (active++, Promise.resolve()) : new Promise(r => queue.push(r));
  const releaseSlot = () => queue.length > 0 ? queue.shift()() : active--;

  process.stderr.write(`  [${passName}] MAP: ${units.length} units, concurrency=${CONCURRENCY_LIMIT}\n`);
  const mapStart = Date.now();

  // Cache-seed (PR-5, default-ON since PR-6 flip): opt out via AUDIT_CACHE_SEED=0. When enabled AND
  // units.length > 1 AND stable-prefix is large enough, run the smallest
  // unit sequentially FIRST to warm OpenAI's prefix cache, then fan out
  // the rest in parallel. Result ordering is reconstructed by original
  // unit index — seed selection is purely a warm-up optimisation.
  // Per Gemini-R1/MED: re-throw config errors from any settled result
  // so programmer bugs surface immediately instead of being swallowed by
  // Promise.allSettled.
  const seedDecision = decideSeed(units, passName, buildPromptForUnit);
  let results;
  if (seedDecision.seedEligible) _runSeedEligible = true;
  // First reason wins: passes are homogeneous enough that the first decline
  // characterises the run, and a last-wins rule would let a late trivial pass
  // (units.length<=1) mask an earlier, more informative 'env-disabled'.
  if (!seedDecision.seedUsed && seedDecision.seedSkipReason && _runSeedSkipReason === null) {
    _runSeedSkipReason = seedDecision.seedSkipReason;
  }
  if (seedDecision.seedUsed) {
    _runSeedUsed = true; // run-level effective-seed flag for cache_seed_enabled telemetry
    const seedIdx = seedDecision.seedUnitIdx;
    process.stderr.write(`  [${passName}] cache-seed: warming with unit ${seedIdx} (~${seedDecision.seedUnitTokens} tok), then fanning out\n`);
    const runOneAtIdx = (i) => runOneMapUnit(openai, units[i], i, units.length, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot);
    const [seedSettled] = await Promise.allSettled([runOneAtIdx(seedIdx)]);
    throwIfConfigError(seedSettled);
    const fanoutIdxs = units.map((_, i) => i).filter(i => i !== seedIdx);
    const fanoutSettled = await Promise.allSettled(fanoutIdxs.map(runOneAtIdx));
    for (const s of fanoutSettled) throwIfConfigError(s);
    results = new Array(units.length);
    results[seedIdx] = seedSettled;
    fanoutIdxs.forEach((origIdx, j) => { results[origIdx] = fanoutSettled[j]; });
  } else {
    results = await Promise.allSettled(
      units.map((unit, i) => runOneMapUnit(openai, unit, i, units.length, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot))
    );
    // Fail-fast on config errors (Gemini-R1/MED)
    for (const s of results) throwIfConfigError(s);
  }

  // Collect findings + aggregate usage (including failed units)
  const allFindings = [];
  const mapUsage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 };
  // The model that actually served this pass, for `audit_pass_stats.source_model`.
  // Taken from the units themselves rather than re-read from `wireModel()` at
  // return time: today those agree (MODEL is set once by `main()` before any
  // pass runs), but that is a whole-process invariant, and telemetry that is
  // correct only while it holds would go quietly wrong the day a pass picks its
  // own model — reporting a model that never ran, with no way to tell. First
  // unit wins; they are all dispatched identically.
  let dispatchedModel = null;
  let effectiveFailures = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      const val = results[i].value;
      dispatchedModel ??= val?.model ?? null;
      if (val?.usage) {
        mapUsage.input_tokens += val.usage.input_tokens ?? 0;
        mapUsage.output_tokens += val.usage.output_tokens ?? 0;
        mapUsage.reasoning_tokens += val.usage.reasoning_tokens ?? 0;
        mapUsage.cached_tokens += val.usage.cached_tokens ?? 0;
      }
      if (!val?.result || !Array.isArray(val.result.findings)) {
        effectiveFailures++;
      } else {
        for (const f of val.result.findings) {
          f._mapUnit = i;
          allFindings.push(f);
        }
      }
    } else {
      effectiveFailures++;
      if (results[i].reason?._accumulatedUsage) {
        mapUsage.input_tokens += results[i].reason._accumulatedUsage.input_tokens ?? 0;
        mapUsage.output_tokens += results[i].reason._accumulatedUsage.output_tokens ?? 0;
        mapUsage.reasoning_tokens += results[i].reason._accumulatedUsage.reasoning_tokens ?? 0;
        mapUsage.cached_tokens += results[i].reason._accumulatedUsage.cached_tokens ?? 0;
      }
      process.stderr.write(`  [map-${passName}-${i}] FAILED: ${results[i].reason?.message || 'unknown'}\n`);
    }
  }

  const mapCompletionRate = units.length > 0 ? (units.length - effectiveFailures) / units.length : 1;
  process.stderr.write(`  [${passName}] MAP done: ${allFindings.length} findings from ${units.length - effectiveFailures}/${units.length} units (${((Date.now() - mapStart) / 1000).toFixed(1)}s, completion: ${(mapCompletionRate * 100).toFixed(0)}%)\n`);

  // Phase 4 (audit-orchestrator-hardening, audit-plan fix H4): explicit
  // typed failure state, computed ONCE from the SAME two already-computed
  // local variables above (no new tracking needed) and attached to every
  // return path below (the caller reads it to fold into `failedPasses`).
  // `units.length === 0` is the trivial zero-unit case, folded into 'clean'
  // alongside the genuine "nothing failed" case.
  const mapUnitStatus = (units.length === 0 || effectiveFailures === 0)
    ? 'clean'
    : (effectiveFailures === units.length && units.length > 0)
      ? 'total_failure'
      : 'partial';
  const unitsAttempted = units.length;
  const unitsFailed = effectiveFailures;

  if (allFindings.length === 0) {
    return {
      result: { pass_name: passName, findings: [], quick_fix_warnings: [], summary: `Map-reduce: ${units.length} units, 0 findings. ${effectiveFailures} units failed.` },
      usage: mapUsage,
      latencyMs: Date.now() - mapStart,
      mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
    };
  }

  // MAP failure threshold — skip REDUCE when majority failed
  const failureRate = effectiveFailures / units.length;
  if (failureRate > MAP_FAILURE_THRESHOLD && allFindings.length > 0) {
    process.stderr.write(`  [${passName}] ${effectiveFailures}/${units.length} MAP units failed (${(failureRate * 100).toFixed(0)}%) — skipping REDUCE, returning normalized raw findings\n`);
    const normalized = normalizeFindingsForOutput(allFindings);
    return {
      result: { pass_name: passName, findings: normalized, quick_fix_warnings: [],
        summary: `Map-reduce: ${effectiveFailures}/${units.length} units failed. Returning ${normalized.length} raw findings (REDUCE skipped).`,
        // REDUCE was deliberately not attempted — that is `skipped`, not a
        // failure and emphatically not `ok`. This path returned no
        // `_executionMeta` at all until 2026-08-13, leaving a run whose
        // synthesis never ran indistinguishable downstream from a clean one.
        _executionMeta: buildExecutionMeta({ reduceStatus: ReduceStatus.SKIPPED, reduceSkipped: true }) },
      usage: mapUsage,
      latencyMs: Date.now() - mapStart,
      _mapFailureRate: failureRate,
      _reduceSkipped: true,
      mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
    };
  }

  // REDUCE phase: single synthesis call
  process.stderr.write(`  [${passName}] REDUCE: synthesizing ${allFindings.length} findings\n`);

  // Safe JSON truncation — always produces valid JSON
  const payload = buildReducePayload(allFindings);
  if (payload.degraded) {
    process.stderr.write(`  [${passName}] REDUCE payload could not fit budget — skipping REDUCE\n`);
    return {
      result: { pass_name: passName, findings: normalizeFindingsForOutput(allFindings), quick_fix_warnings: [],
        summary: `REDUCE skipped: findings exceeded budget after normalization.`,
        // The findings could not be made to fit the REDUCE payload budget —
        // `budget_exceeded` is the literal cause, and this is the site that
        // makes that enum value reachable at all.
        _executionMeta: buildExecutionMeta({ reduceStatus: ReduceStatus.BUDGET_EXCEEDED, reduceSkipped: true }) },
      usage: mapUsage, latencyMs: Date.now() - mapStart, _reduceSkipped: true,
      mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
    };
  }
  const { json: findingsJson, includedCount, totalCount } = payload;
  if (includedCount < totalCount) {
    process.stderr.write(`  [${passName}] REDUCE input truncated: ${includedCount}/${totalCount} findings (budget: ${MAX_REDUCE_JSON_CHARS} chars)\n`);
  }

  // Reduce uses low reasoning — it's dedup/ranking, not deep analysis. Higher timeout for large finding sets.
  const reduceLimits = computePassLimits(findingsJson.length + 2000, 'low', openaiConfig.reduceMinTokens);
  reduceLimits.timeoutMs = Math.max(reduceLimits.timeoutMs, 240000); // Min 4 min for reduce (frontend/backend sets can be large)
  const reduceResult = await safeCallGPT(openai, {
    systemPrompt: REDUCE_SYSTEM_PROMPT,
    userPrompt: `## Findings from ${units.length} audit units (${effectiveFailures} failed):\n\n${findingsJson}\n\n## Tasks:\n1. Deduplicate\n2. Elevate systemic patterns (3+ occurrences)\n3. Flag cross-file issues\n4. Rank by severity`,
    schema: PassFindingsSchema,
    schemaName: `reduce_${passName}`,
    reasoning: 'low',
    ...reduceLimits,
    passName: `reduce-${passName}`
  }, { pass_name: passName, findings: allFindings, quick_fix_warnings: [], summary: 'Reduce phase failed — returning raw map findings' });

  // Status-gated fallback: if safeCallGPT returned the empty-result sentinel (failed=true),
  // classify the failure and preserve raw MAP findings rather than silently discarding them.
  // Was `reduceResult.failed ? MODEL_ERROR : OK` — a status inferred from one
  // boolean, so `parse_error`/`timeout`/`budget_exceeded` were declared and
  // unreachable. Now derived from the category `safeCallGPT` carries.
  //
  // The `reduceResult._reduceStatus ??` override this used to lead with is GONE
  // (2026-08-13). The plan named `_reduceStatus` as the channel, but nothing has
  // ever written it, so the fallback WAS the implementation and the override was
  // a branch no input could take — the same declared-not-real defect this line
  // exists to fix, one level down. A seam with no writer is not extensibility.
  const reduceStatus = reduceResult.failed
    ? reduceStatusFromErrorCategory(reduceResult.errorCategory)
    : ReduceStatus.OK;
  if (reduceStatus !== ReduceStatus.OK && allFindings.length > 0) {
    process.stderr.write(`  [${passName}] REDUCE failed (${reduceStatus}) — preserving ${allFindings.length} raw MAP findings\n`);
    const totalLatency = Date.now() - mapStart;
    return {
      result: {
        pass_name: passName,
        findings: normalizeFindingsForOutput(allFindings),
        quick_fix_warnings: [],
        summary: `REDUCE failed (${reduceStatus}) — ${allFindings.length} raw findings preserved`,
        _executionMeta: buildExecutionMeta({ reduceStatus, reduceSkipped: true }),
      },
      // A FAILED reduce still burns tokens, so its usage is folded in exactly
      // as the success path does. Dropping it here was the same fabricated-zero
      // class as the duplication/adjacency waves (a7db0baf), surviving on the
      // one branch that fix did not touch — found by auditing the census rather
      // than the instance.
      usage: { ...addUsage(mapUsage, reduceResult?.usage ?? {}), latency_ms: totalLatency },
      latencyMs: totalLatency,
      mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
    };
  }

  const totalLatency = Date.now() - mapStart;
  return {
    result: reduceResult.result,
    // Sum MAP + REDUCE token usage — the success path previously hard-coded
    // zeros, dropping the entire pass's spend (the failed-REDUCE path above
    // already preserves `mapUsage`). Harmless while usage was only a telemetry
    // curiosity; load-bearing now that `_usage.costUsd` is priced from the
    // aggregate `totalUsage` (2026-07-22) — zero here silently under-counts
    // legacyCostUsd on every multi-file (map-reduce) pass. costFromUsage prices
    // input/output tokens, so those must be complete.
    usage: {
      input_tokens: mapUsage.input_tokens + (reduceResult.usage?.input_tokens ?? 0),
      output_tokens: mapUsage.output_tokens + (reduceResult.usage?.output_tokens ?? 0),
      reasoning_tokens: mapUsage.reasoning_tokens + (reduceResult.usage?.reasoning_tokens ?? 0),
      // cd77d84e/d96b1e86: sum MAP + REDUCE cached_tokens, matching the other
      // three fields above — previously only REDUCE's figure was reported,
      // silently dropping MAP's cached-token count from the aggregate.
      cached_tokens: mapUsage.cached_tokens + (reduceResult.usage?.cached_tokens ?? 0),
      latency_ms: totalLatency,
    },
    latencyMs: totalLatency,
    _mapCompletionRate: mapCompletionRate,
    mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
  };
}
