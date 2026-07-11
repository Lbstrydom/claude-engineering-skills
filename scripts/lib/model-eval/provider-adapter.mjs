/**
 * @fileoverview Normalization layer between a resolved route and an actual
 * provider call, for genuinely single-call structured tasks — adjudicator
 * Tier-C T/F extraction, auditor Tier-C defect-localization extraction, and
 * blind-judge grading calls. NOT used for auditor Tier A/B generation (see
 * arm-generation.mjs, Phase 3 — a single structured call cannot match the
 * production baseline's 5-pass ensemble).
 *
 * Azure routing (implementation H6 fix, CRITICAL): an `azure-deployment`
 * candidate's traffic must reach the SPECIFIC deployment named by
 * `route.deploymentId`, via the Azure-hosted endpoint — never the public
 * provider API, and never the repo's own PRODUCTION deployment (which is a
 * different deployment than the model-eval candidate being evaluated). Both
 * `createOpenAIClient`'s `options.azure` snapshot-injection seam and
 * `createAnthropicClient`'s explicit `baseURL` are used to target the
 * candidate's own deployment, never the ambient production one.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/provider-adapter
 */

import { z } from 'zod';
import { createOpenAIClient } from '../openai-client.mjs';
import { createAnthropicClient } from '../anthropic-client.mjs';
import { azureConfig, auditShadowConfig } from '../config.mjs';
import { assertEgressSafe } from '../sensitive-egress-gate.mjs';
import { findSensitivePathMentions, EgressGateError } from './egress-path-scan.mjs';
import { zodToGeminiSchema } from '../schemas.mjs';

export class MalformedProviderOutputError extends Error {
  constructor(message) { super(message); this.name = 'MalformedProviderOutputError'; }
}

// Round-5 L1 fix — one named output budget for structured extraction across
// transports (the Anthropic SDK requires an explicit max_tokens; OpenAI's
// responses API and Gemini default internally). Extraction outputs are small
// structured objects; 8K tokens is generous headroom, not a tuning knob.
const STRUCTURED_OUTPUT_MAX_TOKENS = 8000;

/**
 * @param {{route: object, messages: Array<{role:string, content:string}>,
 *   schema: import('zod').ZodType, signal?: AbortSignal}} args
 * @returns {Promise<{data: object, raw: object, usage: object}>}
 */
export async function invokeStructured({ route, messages, schema, signal }) {
  // Implementation H7 fix — final defense-in-depth egress check at the
  // actual provider-call boundary. structured-extractor.mjs already gates
  // upstream via prepareModelEvalPayloadForEgress, but provider-adapter.mjs
  // is a standalone module a FUTURE caller (e.g. Cluster B's blind-judge.mjs)
  // could call directly — this boundary must not trust that every caller
  // remembered to gate upstream.
  // Round-12 audit H6 fix — assertEgressSafe only scans for secret-SHAPED
  // CONTENT; it never classified sensitive PATHS the way
  // prepareModelEvalPayloadForEgress does upstream. A caller reaching this
  // function directly (bypassing that upstream gate) got only half the
  // protection. Apply the same path-token scan here too — the true final
  // boundary, not just "part of the pipeline."
  for (const m of messages) {
    assertEgressSafe(m.content, { label: `model-eval-provider:${route.provider}` });
    const sensitivePaths = findSensitivePathMentions(m.content);
    if (sensitivePaths.length > 0) {
      // Round-14 audit M11 fix — EgressGateError (not a plain Error) so this
      // failure is classified consistently with structured-extractor.mjs's
      // upstream egress-gate failures.
      throw new EgressGateError(`invokeStructured: refusing to send message containing sensitive path mention(s): ${sensitivePaths.join(', ')}`);
    }
  }

  const transport = route.transport;
  if (transport === 'openai-compatible') {
    return invokeOpenAICompatible({ route, messages, schema, signal });
  }
  if (transport === 'native-anthropic') {
    return invokeNativeAnthropic({ route, messages, schema, signal });
  }
  if (transport === 'native-gemini') {
    return invokeNativeGemini({ route, messages, schema, signal });
  }
  throw new Error(`invokeStructured: unsupported transport "${transport}"`);
}

async function invokeOpenAICompatible({ route, messages, schema, signal }) {
  const { zodTextFormat } = await import('openai/helpers/zod');
  let client, model;
  if (route.provider === 'azure') {
    if (!azureConfig.active) throw new Error('invokeStructured: route.provider is "azure" but the Azure work profile is not active (AZURE_OPENAI_ENDPOINT unset)');
    // Target THIS candidate's deployment, never the ambient production
    // AZURE_OPENAI_GPT_DEPLOYMENT — options.azure fully overrides the
    // snapshot createOpenAIClient reads.
    client = await createOpenAIClient({ purpose: 'gpt', azure: { ...azureConfig, gptDeployment: route.deploymentId } });
    model = route.deploymentId;
  } else if (route.provider === 'oss') {
    client = await createOpenAIClient({ oss: resolveOssClientConfig() });
    model = route.resolvedModel;
  } else {
    // Round-7 audit H3 fix (CRITICAL) — createOpenAIClient falls back to the
    // AMBIENT azureConfig singleton whenever options.azure is omitted
    // (`const cfg = options.azure || azureConfig`). route.provider==='openai'
    // means resolveCandidateRoute already decided this candidate is a PUBLIC
    // route; when this harness runs from the Azure work-profile repo (the
    // plan's own "must run identically in both repos" requirement), the
    // ambient Azure profile being active would otherwise silently redirect
    // this "public baseline" candidate's traffic to the repo's OWN
    // production Azure GPT deployment — the exact class of bug the round-1
    // H6 CRITICAL fix closed for azure-deployment routes, reopened here for
    // the plain-openai branch. Explicitly force the public path so
    // route.provider is the sole authority, never ambient env state.
    client = await createOpenAIClient({ purpose: 'gpt', azure: { active: false } });
    model = route.resolvedModel;
  }
  // Implementation M8/M12 fix — `signal` is SDK request OPTIONS, not a body
  // field; the OpenAI SDK's second .parse() argument is where it belongs.
  const resp = await client.responses.parse({
    model,
    input: messages,
    text: { format: zodTextFormat(schema, 'result') },
  }, { signal });
  // Implementation H5 fix — an incomplete/refused response or an absent
  // parsed payload must not masquerade as success; other transports already
  // validate (schema.parse() throws on malformed JSON), this path must too.
  if (resp.status === 'incomplete' || !resp.output_parsed) {
    throw new MalformedProviderOutputError(`invokeOpenAICompatible: no parsed output (status=${resp.status || 'unknown'}, refusal=${resp.output?.[0]?.content?.[0]?.type === 'refusal'})`);
  }
  return { data: schema.parse(resp.output_parsed), raw: resp, usage: resp.usage || null };
}

async function invokeNativeAnthropic({ route, messages, schema, signal }) {
  let client, model;
  if (route.provider === 'azure') {
    if (!azureConfig.active || !azureConfig.claudeBaseUrl) {
      throw new Error('invokeStructured: route.provider is "azure" but Azure Anthropic (Foundry) routing is not configured (AZURE_AI_ENDPOINT unset)');
    }
    // Explicit baseURL — createAnthropicClient() with NO args always targets
    // the PUBLIC api.anthropic.com; it does not auto-detect azureConfig.
    client = await createAnthropicClient({ baseURL: azureConfig.claudeBaseUrl });
    model = route.deploymentId;
  } else {
    client = await createAnthropicClient();
    model = route.resolvedModel;
  }
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const system = [
    messages.find((m) => m.role === 'system')?.content,
    `Respond with ONLY a single JSON object matching this schema, no prose: ${jsonSchema}`,
  ].filter(Boolean).join('\n\n');
  const userMessages = messages.filter((m) => m.role !== 'system');
  // Implementation M8/M12 fix — signal is Anthropic SDK request OPTIONS
  // (second argument), not a body field.
  const resp = await client.messages.create({
    model, max_tokens: STRUCTURED_OUTPUT_MAX_TOKENS, system, messages: userMessages,
  }, { signal });
  const text = resp.content?.[0]?.text || '';
  const data = schema.parse(JSON.parse(text));
  return { data, raw: resp, usage: resp.usage || null };
}

async function invokeNativeGemini({ route, messages, schema, signal }) {
  if (route.provider === 'azure') {
    // No Azure-hosted Gemini transport exists in this codebase today —
    // fail closed rather than silently falling through to the public API
    // with Azure-intended candidate traffic.
    throw new Error('invokeStructured: no Azure-hosted Gemini transport exists — a google-lineage azure-deployment profile is unsupported');
  }
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const system = messages.find((m) => m.role === 'system')?.content;
  const userText = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
  // Implementation M8/M12 fix — `signal` is not a top-level generateContent
  // param (unlike `responses.parse`/`messages.create`'s SDKs); cancellation
  // support for the Gemini transport is deferred rather than guessed at.
  void signal;
  const resp = await client.models.generateContent({
    model: route.resolvedModel,
    contents: userText,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      // Implementation H7 fix — this repo's existing zodToGeminiSchema is
      // the single source of truth for Zod-to-Gemini conversion (Gemini has
      // provider-specific JSON Schema restrictions a raw z.toJSONSchema()
      // doesn't account for); never a second, ad-hoc conversion path.
      responseSchema: zodToGeminiSchema(schema),
    },
  });
  const data = schema.parse(JSON.parse(resp.text));
  // Round-12 audit H5/M1 fix — Gemini's SDK reports usage as
  // resp.usageMetadata.{promptTokenCount,candidatesTokenCount} (camelCase,
  // GenAI-specific field names), which buildUsageEvent()/costFromUsage()
  // never recognized (they read input_tokens/output_tokens etc., the
  // OpenAI/Anthropic convention) — every Gemini call has been silently
  // tagged usageStatus:'missing' since that field was introduced. Normalize
  // to the canonical snake_case shape HERE, at the provider boundary, so
  // the generic cost layer stays provider-agnostic rather than needing to
  // learn every SDK's field-naming quirks.
  const usage = resp.usageMetadata
    ? { input_tokens: resp.usageMetadata.promptTokenCount, output_tokens: resp.usageMetadata.candidatesTokenCount }
    : null;
  return { data, raw: resp, usage };
}

// Round-8b audit M6/M7 fix — config.mjs::auditShadowConfig is ALREADY the
// centralized, validated home for OpenRouter credentials (used by the
// model-A/B/C shadow harness); this function used to re-read
// OSS_BASE_URL/OPENROUTER_BASE_URL/OPENROUTER_API_KEY from process.env
// directly, a second unvalidated config path for the same two values.
// `OSS_BASE_URL` was checked nowhere else in the repo (dead override), so
// dropping it is not a behavior loss — auditShadowConfig.openrouterBaseUrl
// already carries a sensible default (https://openrouter.ai/api/v1).
function resolveOssClientConfig() {
  const { openrouterBaseUrl: baseURL, openrouterApiKey: apiKey } = auditShadowConfig;
  if (!baseURL || !apiKey) {
    throw new Error('provider-adapter: OSS route requires OPENROUTER_BASE_URL + OPENROUTER_API_KEY (config.mjs::auditShadowConfig)');
  }
  return { baseURL, apiKey };
}
