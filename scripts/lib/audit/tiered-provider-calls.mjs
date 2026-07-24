/**
 * @fileoverview All provider invocation for the tiered pipeline: the Stage 1
 * triager adapters (default GPT / validated-manifest OSS) and the discovery
 * generator factories (GLM / Sonnet). Prompt and schema construction lives in
 * `./discovery-prompts.mjs`; this file only calls providers with an
 * already-built contract.
 *
 * Extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/lib/audit/tiered-provider-calls
 */

import { z } from 'zod';
import { clampToJsonSchemaLimits } from '../schemas.mjs';
import { buildStage1TriagerPrompt } from './discovery-prompts.mjs';
import { callGPT } from './llm-helpers.mjs';
import { resolveModel } from '../model-resolver.mjs';

const Stage1TriagerResponseSchema = z.object({
  dismissalAttempted: z.boolean(),
  disproof: z.string().max(500).nullable(),
});

/**
 * Default (production) Stage 1 triager adapter — GPT-5.5 via the existing
 * `callGPT` primitive, the plan's own documented safe default for when
 * Cluster C's `cheap-triager-validation.json` manifest doesn't exist, is
 * malformed, or failed. Any parse/API failure THROWS (never fabricates a
 * dismissal) — `runStage1CheapTriage` treats a throw as `stage1_escalated`,
 * per §1.5.
 *
 * @param {import('../schemas.mjs').StageOneTriageInput} dto
 * @param {{openai: object}} providers
 * @returns {Promise<{result: {dismissalAttempted: boolean, disproof: string|null}, usage: object}>}
 */
export async function defaultTriagerCall(dto, providers) {
  if (!providers?.openai) throw new Error('defaultTriagerCall: providers.openai is required');
  const { system, userPrompt } = buildStage1TriagerPrompt(dto);
  const { result, usage } = await callGPT(providers.openai, {
    system,
    messages: [{ role: 'user', content: userPrompt }],
    schema: Stage1TriagerResponseSchema,
    schemaName: 'stage1_triager_response',
    reasoning: 'low',
    passName: 'stage1-triager',
    maxRetries: 0,
  });
  // Return usage alongside the verdict so the caller can meter cost. The bare
  // verdict is still the load-bearing return; usage is advisory telemetry.
  return { result, usage };
}

/**
 * Validated-manifest Stage 1 triager adapter — the model
 * `resolveStage1TriagerModel` selected (typically GLM, per Cluster C's
 * passed validation), via `providers.ossCall` (the same guarded primitive
 * the discovery portfolio's `glmCall` already uses). Same contract as
 * `defaultTriagerCall`: any failure THROWS, never fabricates a dismissal.
 *
 * @param {import('../schemas.mjs').StageOneTriageInput} dto
 * @param {{ossCall: Function}} providers
 * @param {string} model
 * @returns {Promise<{result: {dismissalAttempted: boolean, disproof: string|null}, usage: object}>}
 */
export async function validatedTriagerCall(dto, providers, model) {
  if (!providers?.ossCall) throw new Error('validatedTriagerCall: providers.ossCall is required');
  const { system, userPrompt } = buildStage1TriagerPrompt(dto);
  const { result, category, error, usage } = await providers.ossCall({
    model, system, userPrompt,
    // Same stall-class guard as the discovery generator (the 2026-07-14
    // OpenRouter stall incident that motivated oss-call-policy was THIS
    // stage-1 path) — route only to hosts that honour our structured-output
    // request.
    providerPreferences: { require_parameters: true },
    schema: Stage1TriagerResponseSchema,
    schemaName: 'stage1_triager_response',
    passName: 'stage1-triager',
    operation: 'stage1_triage',
  });
  // docs/plans/oss-call-reliability-hardening.md round-1 H2: ossStructuredCall
  // normally RETURNS a {result: null, failed: true, ...} shape on
  // retry-exhaustion rather than throwing, so a failed call was silently
  // returning null instead of throwing. `err.category` carries classification
  // through the throw boundary so it can reach the schema-validated Stage-1
  // decision record.
  if (!result) {
    const err = new Error(`validatedTriagerCall: ossCall failed${error ? ` (${error})` : ''}`);
    err.category = category ?? null;
    throw err;
  }
  return { result, usage };
}

/**
 * Build the GLM discovery-generator call — a factory over explicit
 * dependencies (no closure over orchestrator scope). Returns a no-arg async
 * function matching the discovery portfolio's `glmCall` contract.
 *
 * @param {{providers: object, model: string, contract: ReturnType<import('./discovery-prompts.mjs').buildDiscoveryContract>, discoveryPlan: string, discoveryCode: string, recordUsage: Function}} deps
 * @returns {() => Promise<Array<object>>}
 */
export function createGlmDiscoveryCall({ providers, model, contract, discoveryPlan, discoveryCode, recordUsage }) {
  if (!providers?.ossCall) {
    return async () => { throw new Error('discovery portfolio: providers.ossCall unavailable'); };
  }
  return async () => {
    const { result, category, error, usage } = await providers.ossCall({
      model,
      responseSchema: contract.glmResponseValidationSchema,
      // require_parameters (experiment-4 gate-1 screen, 2026-07-17, n=60
      // through this exact seam): OpenRouter's GLM fleet contains hosts that
      // ACCEPT our response_format json_schema request but don't honour it —
      // routing only to hosts that support every requested parameter took
      // stalls from 10/30 to 0/30.
      providerPreferences: { require_parameters: true },
      // Root-cause half of the same fix: the model must not have to guess
      // what an anchor IS — `diffPathId` is enum-narrowed to the table's
      // real ids, and the paths are ours to derive.
      system: [
        'You are a code-audit finding generator. Produce candidate findings, each with a content-verifiable evidence anchor.',
        '',
        contract.anchorContract,
      ].join('\n'),
      userPrompt: `## Plan\n${discoveryPlan}\n\n## Changed Files (code)\n${discoveryCode}`,
      schema: contract.glmLenientSchema,
      schemaName: 'discovery_glm_pass',
      passName: 'discovery-glm',
      operation: 'discovery_generation',
    });
    // Meter even a zero-finding response — it still spent tokens. OSS usage
    // carries OpenRouter's own `provider_cost_usd` (exact), preferred over
    // token-estimated pricing when present.
    recordUsage({
      provider: 'oss', modelSentinel: model, resolvedModel: model,
      usage, wallClockMs: usage?.latency_ms,
      ...(typeof usage?.provider_cost_usd === 'number' ? { selfReportedCostUsd: usage.provider_cost_usd } : {}),
    });
    // A required generator must fail LOUD, not fail quiet-and-clean:
    // `result?.findings ?? []` would silently convert a missing/malformed
    // provider result into an empty SUCCESSFUL finding list.
    if (!result || !Array.isArray(result.findings)) {
      const err = new Error(`glmCall: providers.ossCall did not return a result.findings array${error ? ` (${error})` : ''}`);
      err.category = category ?? null;
      throw err;
    }
    return result.findings;
  };
}

/**
 * Build the Sonnet discovery-generator call — a factory over explicit
 * dependencies. Returns a no-arg async function matching the discovery
 * portfolio's `sonnetCall` contract.
 *
 * @param {{providers: object, ctx: object, contract: ReturnType<import('./discovery-prompts.mjs').buildDiscoveryContract>, discoveryPlan: string, discoveryCode: string, recordUsage: Function}} deps
 * @returns {() => Promise<Array<object>>}
 */
export function createSonnetDiscoveryCall({ providers, ctx, contract, discoveryPlan, discoveryCode, recordUsage }) {
  if (!providers?.anthropicClient) {
    // No client. Name WHY, from the readiness record the context carries —
    // `anthropicClient === null` alone conflates a keyless run with a broken
    // one.
    return async () => {
      const r = ctx.providers?.anthropicReadiness;
      const detail = r?.state
        ? `${r.state}${r.message ? `: ${r.message}` : ''}`
        : 'unavailable (no readiness record)';
      throw new Error(`discovery portfolio: providers.anthropicClient ${detail}`);
    };
  }
  return async () => {
    const resp = await providers.anthropicClient.messages.create({
      model: resolveModel('latest-sonnet'),
      // With maxItems:15 and per-finding text caps, a full 15-item response
      // needs ~9000+ output tokens; 16000 covers the worst case with headroom
      // (2026-07-14 — a lower budget truncated `toolUse` before the JSON
      // closed).
      max_tokens: 16000,
      // The SAME anchor contract + diff-path table the GLM generator gets —
      // one string, so the two generators cannot drift into citing different
      // id sets.
      system: [
        'You are a code-audit finding generator (cold pass, no prior context). Produce candidate findings by calling report_findings.',
        '',
        contract.anchorContract,
      ].join('\n'),
      messages: [{ role: 'user', content: `## Plan\n${discoveryPlan}\n\n## Changed Files (code)\n${discoveryCode}` }],
      tools: [contract.sonnetFindingsTool],
      tool_choice: { type: 'tool', name: 'report_findings' },
    });
    // Anthropic SDK usage is `{input_tokens, output_tokens, ...}` — the shape
    // costFromUsage already reads. Priced via the family table.
    recordUsage({
      provider: 'anthropic', modelSentinel: 'latest-sonnet', resolvedModel: resolveModel('latest-sonnet'),
      usage: resp?.usage,
    });
    const toolUse = resp?.content?.find((block) => block.type === 'tool_use' && block.name === 'report_findings');
    if (!toolUse || !Array.isArray(toolUse.input?.findings)) {
      // Diagnosability (2026-07-14): stop_reason: 'max_tokens' is the
      // truncation signature — surface it so a future recurrence is
      // diagnosable from the thrown/logged message alone.
      throw new Error(`sonnetCall: response did not contain a report_findings tool call with a findings array (stop_reason: ${resp?.stop_reason ?? 'unknown'})`);
    }
    // The SAME lenient clamping the GLM path has — Anthropic tool-use
    // validates SHAPE provider-side but does not enforce maxLength, exactly
    // as OpenRouter doesn't. Losing the tail of a verbose `detail` is
    // strictly better than destroying the finding; `quote` is capped well
    // above any real anchor via `contract.unclampedQuoteSchema`.
    return clampToJsonSchemaLimits({ findings: toolUse.input.findings }, contract.unclampedQuoteSchema).findings;
  };
}

/**
 * Wrap a Stage-2 adjudication call (`providers.geminiReviewCall` /
 * `.geminiCleanRegionCall`) to meter its cost from the `--out` JSON's `_usage`/
 * `_model` fields, forwarding the rest of the result unchanged.
 *
 * Renamed from `meterGeminiCall` (its two call sites can each resolve to
 * Gemini, Opus, or Azure-Claude depending on `gemini-review.mjs`'s own
 * provider precedence — the old name already named the wrong invariant).
 *
 * NOT a general provider-agnostic wrapper: `fn` must resolve to a value
 * carrying the Stage-2 adjudication result shape `{ _usage?: {input_tokens,
 * output_tokens, thinking_tokens?}, _model?: string, ...rest }` — the
 * `gemini-review.mjs --out` JSON shape, regardless of which underlying model
 * produced it. It reads exactly those two optional fields and forwards
 * `...rest` unchanged; it does not interpret or require anything else. GLM/
 * Sonnet discovery calls have a different raw response shape and are metered
 * via `recordUsage` calls built inline in their own factories above, not
 * through this wrapper.
 *
 * @param {(arg: any) => Promise<object>} fn
 * @param {Function} recordUsage
 * @returns {(arg: any) => Promise<object>}
 */
export function wrapWithUsageMetering(fn, recordUsage) {
  return async (arg) => {
    const r = await fn(arg);
    const u = r?._usage;
    if (u) {
      const model = r._model ?? 'latest-pro';
      // Provider is DERIVED from the model id, not hardcoded 'gemini': Stage 2
      // is Gemini by default but falls back to Opus / Azure-Claude when
      // GEMINI_API_KEY is absent. It's advisory only — cost comes from
      // `resolvedModel` pricing, so the label never changes costUsd — but
      // keep it honest. Gemini bills thinking (thought) tokens at the OUTPUT
      // rate and reports them SEPARATELY from output_tokens, so fold them in
      // or the estimate silently under-counts a reasoning adjudicator
      // (Claude paths set thinking_tokens:0, so this is a no-op there).
      recordUsage({
        provider: /gemini/i.test(model) ? 'gemini' : 'anthropic',
        modelSentinel: model, resolvedModel: model,
        usage: { input_tokens: u.input_tokens, output_tokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) },
      });
    }
    return r;
  };
}
