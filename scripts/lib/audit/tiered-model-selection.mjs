/**
 * @fileoverview Stage 1 triager model resolution/selection policy — decides
 * whether to use the validated-manifest (typically GLM) triager or fall back
 * to the default GPT triager, and returns the ready-to-call closure.
 *
 * The one real inter-module edge in this decomposition: this file calls
 * `./tiered-provider-calls.mjs` (policy calls mechanism).
 *
 * Extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/lib/audit/tiered-model-selection
 */

import { resolveStage1TriagerModel } from './stage1-triager-resolver.mjs';
import { defaultTriagerCall, validatedTriagerCall } from './tiered-provider-calls.mjs';

/**
 * Resolve which Stage 1 triager to use this run (validated-manifest OSS model
 * vs. default GPT fallback), log the reason exactly as the orchestrator
 * always has, and return a ready-to-call `triagerCall(envelope)` closure that
 * also records usage into the run's cost ledger.
 *
 * @param {{tieredAuditConfig: object, providers: object, recordUsage: Function, openaiConfig: object}} deps
 * @returns {(envelope: object) => Promise<object>}
 */
export function selectStage1TriagerCall({ tieredAuditConfig, providers, recordUsage, openaiConfig }) {
  const stage1Resolution = resolveStage1TriagerModel({ configuredModel: tieredAuditConfig.stage1Model });

  if (stage1Resolution.model && providers.ossCall) {
    process.stderr.write(`  [tiered-pipeline] Stage 1 triager: ${stage1Resolution.model} (${stage1Resolution.source}${stage1Resolution.datasetHash ? `, datasetHash=${stage1Resolution.datasetHash.slice(0, 12)}…` : ''})\n`);
    return async (envelope) => {
      const { result, usage } = await validatedTriagerCall(envelope, providers, stage1Resolution.model);
      recordUsage({
        provider: 'oss', modelSentinel: stage1Resolution.model, resolvedModel: stage1Resolution.model,
        usage, wallClockMs: usage?.latency_ms,
        ...(typeof usage?.provider_cost_usd === 'number' ? { selfReportedCostUsd: usage.provider_cost_usd } : {}),
      });
      return result;
    };
  }

  // A resolved model with no ossCall to reach it (e.g. OPENROUTER_API_KEY
  // unset) is its own distinct, named fallback reason — never conflated with
  // "no manifest/override at all".
  const reason = stage1Resolution.model && !providers.ossCall ? 'oss_provider_unavailable' : (stage1Resolution.reason || 'no_override_or_manifest');
  // audit-code fix L1: the fallback log used to hardcode "GPT-5.5", but the
  // ACTUAL model attributed by defaultTriagerCall/recordUsage below is
  // whatever openaiConfig.model resolves to — a stale hardcoded label could
  // silently drift from the real fallback model.
  process.stderr.write(`  [tiered-pipeline] WARNING: Stage 1 triager falling back to ${openaiConfig.model} (${reason})\n`);
  return async (envelope) => {
    const { result, usage } = await defaultTriagerCall(envelope, providers);
    // The default triager uses callGPT's audit GPT model; attribute cost to
    // it (family-keyed pricing makes a minor concrete-id difference moot).
    recordUsage({ provider: 'openai', modelSentinel: openaiConfig.model, resolvedModel: openaiConfig.model, usage });
    return result;
  };
}
