/**
 * @fileoverview The final-review provider catalog — one immutable descriptor
 * per provider (identity, label, transport, model resolution, readiness,
 * client construction), provider selection/persistence, and the live-catalog
 * model refresh.
 *
 * Pure relocation out of `scripts/gemini-review.mjs`
 * (`docs/plans/gemini-review-decomposition.md` Phase 2). `gemini-review.mjs`
 * imports these back and keeps re-exporting `selectProvider` /
 * `applyProviderSetting` / `SETTING_PROVIDERS` at the top level (test-import
 * contract — see the plan's widened General rule) and `PROVIDERS` /
 * `resolveCompatCreds` / `resolveOpenRouterCreds` via its existing
 * `_internals` object, both unchanged in shape.
 *
 * `MODEL`/`CLAUDE_OPUS_MODEL`/`XAI_MODEL` are live-refreshed provider-
 * resolution state (Symbol/Dependency Matrix in the plan) — `gemini-review.mjs`
 * reads them as ordinary named imports, which ES modules bind live: a
 * reassignment here (via `refreshProviderModels()`, called from `main()`) is
 * visible to every importer without any extra plumbing.
 *
 * @module scripts/lib/final-review/providers
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { createOpenAIClient } from '../openai-client.mjs';
import { createAnthropicClient } from '../anthropic-client.mjs';
import { atomicWriteFileSync } from '../file-io.mjs';
import { applyEnvSetting } from '../env-setting.mjs';
import { finalReviewModelSpec } from '../final-review-config.mjs';
import { geminiConfig, claudeConfig, azureConfig, finalReviewConfig, auditShadowConfig } from '../config.mjs';
import {
  refreshModelCatalog, resolveModel, resolveXaiCreds, resolveAlibabaCreds, resolveDeepseekCreds,
} from '../model-resolver.mjs';

// `let` not `const` — reassigned by refreshProviderModels() after it pulls
// the live provider catalog, so we always use the newest available model
// instead of whatever STATIC_POOL knew about at last commit.
export let MODEL = geminiConfig.model;
export let CLAUDE_OPUS_MODEL = claudeConfig.finalReviewModel;
// `const`, unlike the two above — there is no live-catalog fetcher for xAI
// (deliberate, see XAI_POOL's docstring in model-resolver.mjs: the endpoint
// mixes chat and non-chat models with no uniform version grammar, so a
// maintainer-curated single-entry pool is the right-sized choice), so nothing
// refreshes this after the initial resolution. `resolveModel('latest-grok')`
// still honours XAI_MODEL env override and reads XAI_POOL's head.
export const XAI_MODEL = resolveModel('latest-grok');

// ── Provider descriptor catalog (single source of truth) ────────────────────
//
// One immutable descriptor per provider is THE source of truth for identity,
// label, transport, model resolution, readiness, and client construction —
// selectProvider / buildClient / formatReviewResult / dispatch all derive from
// it, so adding a provider is one entry (+ only a new transport adapter if the
// wire shape is genuinely new). `resolveModel`/`transportKind` are functions so
// they read live module state (MODEL/CLAUDE_OPUS_MODEL are reassigned in main()
// after the catalog refresh; the azure transport depends on the resolved shape).
export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    transportKind: () => 'gemini',
    resolveModel: () => MODEL,
    assertReady: (env = process.env) => {
      if (!env.GEMINI_API_KEY) { console.error('Error: provider "gemini" requires GEMINI_API_KEY'); process.exit(1); }
    },
    buildClient: async () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
  },
  'claude-opus': {
    id: 'claude-opus',
    label: 'Claude Opus',
    transportKind: () => 'anthropic',
    resolveModel: () => CLAUDE_OPUS_MODEL,
    assertReady: (env = process.env) => {
      if (!env.ANTHROPIC_API_KEY) { console.error('Error: provider "anthropic" requires ANTHROPIC_API_KEY'); process.exit(1); }
    },
    buildClient: async () => {
      process.stderr.write(`  [final-review] GEMINI_API_KEY missing; using Claude Opus fallback (${CLAUDE_OPUS_MODEL}).\n`);
      // `backend:'sdk'` PINNED, exactly as buildShadowClient does — the PRIMARY
      // path was left on the ambient CLAUDE_BACKEND and is broken twice over
      // under `cli`: that transport silently drops tools/tool_choice (so the
      // provider-side schema enforcement this reviewer depends on vanishes,
      // AGENTS.md "Anthropic Backend Routing"), and it passes the prompt as a
      // process argument, which a ~50K-token review exceeds — observed
      // 2026-08-03 as `'claude' exited 1: The command line is too long`.
      //
      // This is the reviewer the loop falls back to when GEMINI_API_KEY is
      // absent, so on any machine running CLAUDE_BACKEND=cli the final gate had
      // no working fallback at all. The shadow path was pinned on 2026-07-26;
      // the primary was missed because it is only reached without a Gemini key.
      //
      // `azureRoute: null` — this provider IS "public Opus", a different id from
      // `azure-claude` below. An omitted route would adopt the tenant's Azure
      // Claude on an Azure machine, so `--provider claude-opus` would silently
      // stop meaning what it says.
      return createAnthropicClient({ backend: 'sdk', azureRoute: null });
    },
  },
  'azure-claude': {
    id: 'azure-claude',
    label: 'Azure Foundry Claude',
    transportKind: () => (azureConfig.claudeApiShape === 'anthropic' ? 'anthropic' : 'openai'),
    resolveModel: () => azureConfig.claudeDeployment,
    assertReady: () => assertAzureClaudeReady(),
    buildClient: async () => {
      const route = azureConfig.claudeRoute;
      process.stderr.write(
        `  [final-review] Azure work profile — Claude via ${route.mode} route ` +
        `(${azureConfig.claudeApiShape} shape, ${azureConfig.claudeDeployment}, ` +
        `auth ${route.authMode} from ${route.credentialVar}).\n`);
      if (azureConfig.claudeApiShape === 'anthropic') {
        return createAnthropicClient({ azureRoute: route });
      }
      return createOpenAIClient({ purpose: 'foundry-claude' });
    },
  },
  // Generic OpenAI-compatible gateway (Together / Fireworks / Groq / vLLM /
  // Ollama / LM Studio / any OpenAI-shaped endpoint). Model id is passed to the
  // gateway verbatim (NO resolveModel sentinel rewrite — D6).
  'openai-compatible': {
    id: 'openai-compatible',
    // Ask for the schema rather than describing it in prose (experiment-4).
    structuredOutput: true,
    label: 'OpenAI-compatible',
    transportKind: () => 'openai',
    resolveModel: () => finalReviewConfig.model,
    assertReady: () => {
      const c = resolveCompatCreds();
      const missing = [];
      if (!c.baseUrl) missing.push('FINAL_REVIEW_BASE_URL');
      if (!c.apiKey) missing.push('FINAL_REVIEW_API_KEY');
      if (!c.model) missing.push('FINAL_REVIEW_MODEL');
      if (missing.length) {
        console.error(`Error: provider "openai-compatible" requires ${missing.join(' + ')}.`);
        process.exit(1);
      }
    },
    buildClient: async () => {
      const c = resolveCompatCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
  },
  // OpenRouter convenience preset — the openai-compatible transport with the
  // baseURL prefilled and a fallback to the (globally scoped) OPENROUTER_API_KEY
  // that OTHER skills already use. That fallback is why this route is
  // EXPLICIT-SELECTION-ONLY (never auto-detect) — see G1 in selectProvider.
  openrouter: {
    id: 'openrouter',
    structuredOutput: true,
    label: 'OpenRouter',
    transportKind: () => 'openai',
    resolveModel: () => finalReviewConfig.model,
    assertReady: () => {
      const c = resolveOpenRouterCreds();
      const missing = [];
      if (!c.apiKey) missing.push('FINAL_REVIEW_API_KEY (or OPENROUTER_API_KEY)');
      if (!c.model) missing.push('FINAL_REVIEW_MODEL');
      if (missing.length) {
        console.error(`Error: provider "openrouter" requires ${missing.join(' + ')}.`);
        process.exit(1);
      }
    },
    buildClient: async () => {
      const c = resolveOpenRouterCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
    // OpenRouter serves one model id from MANY backends with incompatible
    // limits, and picks per request. Measured 2026-07-28 while smoke-testing
    // kimi-k3/glm-5.2 as final reviewers:
    //   - `moonshotai/kimi-k3` is offered by Nebius at 8K context and by others
    //     at 1M. A 54K-token review routed to Nebius cannot succeed.
    //   - `z-ai/glm-5.2` is offered by AkashML at 96,890 — under a 106K review.
    //   - Same request, no pinning: Moonshot AI 15.5s vs Fireworks 5.0s. 3x.
    // So identical runs failed or passed at random, which reads as "the model
    // is flaky" when it is really the router.
    //
    // `require_parameters` drops backends that don't support what we send;
    // `sort: throughput` avoids the slow tail. Both are OpenRouter-only body
    // fields and are ignored by other OpenAI-compatible gateways.
    //
    // `reasoning.effort` is the load-bearing one for REASONING models.
    // Reasoning tokens are billed and counted against `max_tokens`, so kimi-k3
    // spent 597 of a 600-token budget thinking and emitted almost no answer.
    // At MAX_OUTPUT_TOKENS (32000) on a ~39 tok/s backend that is ~830s of
    // pure reasoning before the first byte of JSON — every timeout we saw.
    // The final reviewer wants a verdict, not a visible chain of thought.
    //
    // But `low` was tuned against a 600-token triager, and silently became the
    // setting under which `moonshotai/kimi-k2-thinking` was measured as a shadow
    // final reviewer: 3 runs, 0 findings. Re-run at `high` on an identical
    // transcript, it produced 3. A "thinking" model reviewed with thinking
    // turned down is evidence about the flag, not the model — so the depth is
    // now the shared `reasoningEffort` dial every provider reads.
    requestExtras: () => ({
      provider: { require_parameters: true, sort: 'throughput' },
      reasoning: { effort: finalReviewConfig.reasoningEffort },
    }),
  },
  // Native xAI — final-review shadow arm (plan KD-4). OpenAI-compatible chat
  // completions at api.x.ai; verified live 2026-08-14 (200 on /v1/models,
  // response_format:json_schema returns valid structured JSON, top-level
  // reasoning_effort accepted and moves reasoning_tokens in usage).
  xai: {
    id: 'xai',
    structuredOutput: true,
    label: 'xAI Grok',
    transportKind: () => 'openai',
    resolveModel: () => XAI_MODEL,
    assertReady: (env = process.env) => {
      if (!env.XAI_API_KEY) { console.error('Error: provider "xai" requires XAI_API_KEY'); process.exit(1); }
    },
    buildClient: async () => {
      const c = resolveXaiCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
    // DELIBERATELY not the OpenRouter descriptor's requestExtras (KD-4). The
    // `provider`/`require_parameters`/`sort` fields are OpenRouter gateway-only
    // — xAI is a single direct endpoint, not a router selecting among upstream
    // backends, so those fields have no meaning here and a strict API could
    // reject them as unknown. `reasoning.effort` is also OpenRouter's NESTED
    // shape; xAI takes a FLAT top-level `reasoning_effort` string (verified
    // live) — nesting it as OpenRouter does would silently be ignored, which is
    // exactly the "accepted but inert" failure class the plan's pre-flight
    // (Phase 5) exists to catch, so getting the shape right here matters.
    requestExtras: () => ({ reasoning_effort: finalReviewConfig.reasoningEffort }),
  },
  // Native Alibaba Cloud Model Studio — replaces the OpenRouter route for the
  // qwen/deepseek bake-off arms (2026-08-17), after repeated 300s timeouts on
  // OpenRouter's routing for `qwen/qwen3.8-max` traced to the ROUTER, not the
  // model (same failure class the openrouter descriptor's own comment above
  // documents for kimi/glm). This is a per-account WORKSPACE gateway serving
  // several model families verbatim (Qwen, DeepSeek, GLM, Kimi) — closer in
  // shape to `openai-compatible` than to `xai`'s single fixed model, so there
  // is no `resolveModel` sentinel default; the concrete id always comes from
  // the caller (arm declaration or FINAL_REVIEW_SHADOW_MODEL).
  alibaba: {
    id: 'alibaba',
    structuredOutput: true,
    label: 'Alibaba Cloud (Model Studio)',
    transportKind: () => 'openai',
    resolveModel: () => finalReviewConfig.model,
    assertReady: (env = process.env) => {
      const missing = [];
      if (!env.ALIBABA_CLOUD_API_KEY) missing.push('ALIBABA_CLOUD_API_KEY');
      if (!env.ALIBABA_CLOUD_BASE_URL) missing.push('ALIBABA_CLOUD_BASE_URL');
      if (missing.length) { console.error(`Error: provider "alibaba" requires ${missing.join(' + ')}`); process.exit(1); }
    },
    buildClient: async () => {
      const c = resolveAlibabaCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
    // Same non-router reasoning as xai above: one direct workspace endpoint,
    // not OpenRouter's many-backends-per-id router, so none of OpenRouter's
    // `provider`/`require_parameters`/`sort` fields apply.
    //
    // `enable_thinking: true` is EXPLICIT, and both halves of that matter
    // (2026-08-17, after 4 of 7 qwen collection attempts stalled to their
    // timeout ceiling — including once past a doubled 600s):
    //
    //  - **Explicit at all**, because Alibaba's OpenAI-compatible endpoint
    //    documents `enable_thinking` as a required top-level field for
    //    non-streaming calls to thinking-capable models, and every stalled
    //    call had left it unset. Live-measured at the failing size class
    //    (260K chars): unset → the observed stalls; explicitly `true` →
    //    7.2s with 163 reasoning tokens.
    //  - **`true`, never `false`**, because this is a MODEL COMPARISON arm.
    //    The campaign's `controls.reasoningEffort: 'high'` binds every arm
    //    and is hashed into the cohort's lock digest, so an arm quietly
    //    running with reasoning OFF would (a) measure the dial instead of
    //    the model — the campaign's own measured lesson, where one arm found
    //    0 findings at `low` and 3 at `high` on an identical transcript —
    //    and (b) make that digest attest a control the run did not honour.
    //    Faster and cheaper is NOT the goal here; comparability is.
    requestExtras: () => ({ enable_thinking: true }),
  },
  // Native DeepSeek — REPLACES the Alibaba-workspace route for this model
  // (2026-08-17): deepseek-v4-pro-0813 timed out at 300s twice via Alibaba at
  // real review size while qwen, on the identical request, succeeded both
  // times — a model-specific throughput issue on that workspace, not a
  // shared route problem. Direct to the source instead, mirroring xai: a
  // single known endpoint with a real default, not a multi-family gateway
  // like alibaba/openrouter. DeepSeek's OWN model ids carry no dated-snapshot
  // suffix (confirmed live against its /models endpoint: `deepseek-v4-pro`,
  // `deepseek-v4-flash` — the `-0813` pin was Alibaba's own workspace
  // convention, not DeepSeek's).
  deepseek: {
    id: 'deepseek',
    structuredOutput: true,
    label: 'DeepSeek (direct)',
    transportKind: () => 'openai',
    // No single sensible default (DEEPSEEK_POOL has two real choices —
    // v4-pro vs v4-flash), so — like alibaba, unlike xai's one true
    // default — this reads the ambient config rather than a sentinel.
    resolveModel: () => finalReviewConfig.model,
    assertReady: (env = process.env) => {
      if (!env.DEEPSEEK_API_KEY) { console.error('Error: provider "deepseek" requires DEEPSEEK_API_KEY'); process.exit(1); }
    },
    buildClient: async () => {
      const c = resolveDeepseekCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
    // No routing-gateway extras (same reasoning as xai/alibaba above). Unlike
    // alibaba, deepseek's own API is confirmed (live, 2026-08-17) to REJECT
    // response_format:json_schema outright ("This response_format type is
    // unavailable now", HTTP 400) — but that 400 message contains the literal
    // substring `response_format`, so the EXISTING `isResponseFormatUnsupported`
    // degrade-to-prompt-only path (openai transport, above) already catches it
    // with no new code; json_object mode and prompt-only both confirmed 200
    // live. No reasoning-effort field: unverified whether one exists here,
    // so none is claimed.
    requestExtras: () => ({}),
  },
};

/** Review-scoped OpenAI-compatible creds (all explicit; validated in assertReady). */
export function resolveCompatCreds() {
  return { baseUrl: finalReviewConfig.baseUrl, apiKey: finalReviewConfig.apiKey, model: finalReviewConfig.model };
}

/**
 * OpenRouter preset creds — baseURL prefilled; apiKey falls back to the shared
 * OPENROUTER_API_KEY ONLY after an explicit `openrouter` selection (G1). The
 * fallback never runs during auto-detect because selectProvider never
 * auto-selects this route.
 */
export function resolveOpenRouterCreds() {
  return {
    baseUrl: finalReviewConfig.baseUrl || auditShadowConfig.openrouterBaseUrl,
    apiKey: finalReviewConfig.apiKey || auditShadowConfig.openrouterApiKey,
    model: finalReviewConfig.model,
  };
}

// `resolveXaiCreds` (base URL + credential) lives in model-resolver.mjs —
// NOT routed through resolveOpenRouterCreds/resolveCompatCreds, on purpose
// (plan: final-review-scoped-second-reviewer.md KD-4). Those two exist to let
// an operator point at an ARBITRARY gateway/base URL via env; xAI is a
// specific, known, closed-catalog provider with one real endpoint, so a
// fixed constant is the same choice this file already makes for `gemini` and
// `claude-opus` above — an endpoint and the credential it is addressed with
// are one unit (AGENTS.md). Shared with grok-effort-preflight.mjs (M4's fix)
// so the base URL and env var name have exactly one definition, not two that
// can silently drift apart.

/**
 * Resolve the final-review provider.
 *
 * Precedence (top wins):
 *   1. Explicit choice — the CLI `--provider` flag OR the persistent
 *      `FINAL_REVIEW_PROVIDER` per-repo setting (both arrive via `choice`).
 *   2. Auto-detect default stack — `GEMINI_API_KEY` present → Gemini.
 *   3. Active Azure profile → azure-claude.
 *   4. `ANTHROPIC_API_KEY` → public Claude Opus.
 *
 * The per-repo default is "GPT auditor + Gemini reviewer": Gemini is preferred
 * whenever its key is present, and a *configured* Azure profile no longer
 * silently hijacks the reviewer (a stray AZURE_OPENAI_ENDPOINT in the
 * environment used to reroute a private-repo review to Foundry Opus). To make
 * a repo use Azure permanently, set `FINAL_REVIEW_PROVIDER=azure-claude`
 * (`node scripts/gemini-review.mjs set-provider azure-claude`).
 *
 * @param {string|null} choice - explicit provider (flag or setting), or null
 * @param {{env?:object, azureActive?:boolean}} [deps] - injected for tests
 */
export function selectProvider(choice, { env = process.env, azureActive = azureConfig.active } = {}) {
  // ── 1. Explicit choice (flag or FINAL_REVIEW_PROVIDER setting) — always wins.
  if (choice === 'anthropic' || choice === 'claude-opus') {
    if (!env.ANTHROPIC_API_KEY) {
      console.error('Error: provider "anthropic" requires ANTHROPIC_API_KEY');
      process.exit(1);
    }
    return 'claude-opus';
  }
  if (choice === 'gemini') {
    if (!env.GEMINI_API_KEY) {
      console.error('Error: provider "gemini" requires GEMINI_API_KEY');
      process.exit(1);
    }
    return 'gemini';
  }
  if (choice === 'azure-claude') {
    assertAzureClaudeReady();
    return 'azure-claude';
  }
  // Provider-agnostic routes (generic OpenAI-compatible + OpenRouter preset) are
  // EXPLICIT-SELECTION-ONLY — reachable via --provider / FINAL_REVIEW_PROVIDER,
  // never auto-detect (G1: a globally scoped OPENROUTER_API_KEY must not silently
  // route proprietary code egress to a third-party gateway).
  if (choice === 'openai-compatible' || choice === 'openrouter') {
    PROVIDERS[choice].assertReady(env);
    return choice;
  }
  if (choice) {
    console.error(`Error: Unknown provider "${choice}". Use "gemini", "anthropic", "azure-claude", "openai-compatible", or "openrouter".`);
    process.exit(1);
  }
  // ── 2-4. Auto-detect. Gemini first (default reviewer); Azure only when no
  // Gemini key AND the profile is active; public Opus last. NO fallback to a
  // compatible/OpenRouter route (G1) — those require explicit selection.
  if (env.GEMINI_API_KEY) return 'gemini';
  if (azureActive) {
    assertAzureClaudeReady();
    return 'azure-claude';
  }
  if (env.ANTHROPIC_API_KEY) return 'claude-opus';
  console.error('Error: Final review requires GEMINI_API_KEY, ANTHROPIC_API_KEY, or an active Azure profile.');
  console.error('Set GEMINI_API_KEY (Gemini), ANTHROPIC_API_KEY (Claude Opus), or run');
  console.error('`node scripts/gemini-review.mjs set-provider azure-claude` for the Azure work profile.');
  process.exit(1);
  return null;
}

/** The persistent per-repo final-review setting (FINAL_REVIEW_PROVIDER), or null. */
export function resolveProviderSetting() {
  const v = (process.env.FINAL_REVIEW_PROVIDER || '').trim();
  return v || null;
}

export const SETTING_PROVIDERS = new Set(['gemini', 'azure-claude', 'anthropic', 'openai-compatible', 'openrouter', 'default']);
const SETTING_COMMENT = '# Final-review provider — persistent per-repo setting (managed by `set-provider`).';

/**
 * Pure: compute new `.env` contents after applying a final-review provider
 * setting. `default` removes the managed line (+ its comment) and reverts to
 * auto-detection. Returns `{ text, changed }`; `text` is the original when
 * nothing changed. Throws on an invalid provider. Exported for tests (no IO).
 * @param {string} existingText
 * @param {string} provider
 * @returns {{text: string, changed: boolean}}
 */
export function applyProviderSetting(existingText, provider) {
  if (!SETTING_PROVIDERS.has(provider)) throw new Error(`invalid provider "${provider}"`);
  // Delegates to the shared pure writer (Cluster B / Phase 3). `reformat: true`
  // preserves this function's historical blank-run normalisation so its output is
  // byte-identical to before the extraction; `default` maps to a null value (remove).
  return applyEnvSetting(existingText, 'FINAL_REVIEW_PROVIDER',
    provider === 'default' ? null : provider,
    { comment: SETTING_COMMENT, reformat: true });
}

/**
 * Persist (or clear) the per-repo final-review provider in the repo-root `.env`.
 * This is the user-triggered "permanent setting".
 * @param {string} provider
 */
export function runSetProvider(provider) {
  if (!provider || !SETTING_PROVIDERS.has(provider)) {
    console.error('Usage: node scripts/gemini-review.mjs set-provider <gemini|azure-claude|anthropic|openai-compatible|openrouter|default>');
    console.error('  gemini            — final review via Gemini (the default when GEMINI_API_KEY is present)');
    console.error('  azure-claude      — Opus on Azure Foundry (the work-repo setting)');
    console.error('  anthropic         — public Claude Opus');
    console.error('  openai-compatible — any OpenAI-shaped gateway (needs FINAL_REVIEW_BASE_URL/_API_KEY/_MODEL)');
    console.error('  openrouter        — OpenRouter preset (needs FINAL_REVIEW_MODEL + FINAL_REVIEW_API_KEY or OPENROUTER_API_KEY)');
    console.error('  default           — clear the setting; revert to auto-detection');
    process.exit(1);
  }
  const envPath = resolve(process.cwd(), '.env');
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const { text, changed } = applyProviderSetting(existing, provider);
  if (!changed) {
    console.log('FINAL_REVIEW_PROVIDER is not set — already on auto-detection (Gemini → Azure-if-active → Opus).');
    return;
  }
  atomicWriteFileSync(envPath, text);
  console.log(provider === 'default'
    ? `✓ Cleared FINAL_REVIEW_PROVIDER in ${envPath} — reverted to auto-detection.`
    : `✓ Set FINAL_REVIEW_PROVIDER=${provider} in ${envPath}. This repo now uses "${provider}" for the final review.`);
}

/**
 * Fail-fast (Cluster-A audit H3): the azure-claude final reviewer needs a
 * resolvable route + deployment regardless of which transport shape is used.
 *
 * The endpoint requirement is ROUTE-SPECIFIC. It used to demand
 * `AZURE_AI_ENDPOINT` unconditionally, which is the wrong variable for a tenant
 * that serves Claude through APIM — the route resolver owns that decision now
 * (it throws for `foundry` without an AI endpoint), so this only has to confirm
 * a route resolved at all and that we have something to address.
 */
function assertAzureClaudeReady() {
  const route = azureConfig.claudeRoute;
  const missing = [];
  if (!route) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!route?.apiKey) missing.push(route?.credentialVar || 'AZURE_OPENAI_API_KEY');
  if (!azureConfig.claudeDeployment) missing.push('AZURE_FOUNDRY_CLAUDE_DEPLOYMENT');
  if (missing.length > 0) {
    console.error(
      `Error: Azure final reviewer (${route?.mode || 'unresolved'} route) requires ` +
      `${missing.join(' + ')}. Set ${missing.length > 1 ? 'them' : 'it'} or unset ` +
      `AZURE_OPENAI_ENDPOINT to use Gemini/Claude.`,
    );
    process.exit(1);
  }
}

export async function buildClient(provider) {
  const descriptor = PROVIDERS[provider];
  if (!descriptor) throw new Error(`[final-review] unknown provider "${provider}"`);
  return descriptor.buildClient();
}

/**
 * Refresh the live model catalog and re-resolve the Gemini reviewer model +
 * the Claude Opus fallback against it, reassigning `MODEL`/`CLAUDE_OPUS_MODEL`
 * in place. "Always use the latest" path — operators no longer have to update
 * STATIC_POOL manually when a provider ships a new model. Renamed from
 * `refreshCatalogAndWarn` on relocation (Phase 2) — same behaviour.
 */
export async function refreshProviderModels() {
  if (process.env.MODEL_CATALOG_REFRESH === 'skip') return;
  try { await refreshModelCatalog(); } catch { /* silent */ }
  // Re-resolve BOTH the Gemini reviewer model + the Claude Opus fallback
  // against the freshly-populated live catalog, then reassign. "Always
  // use the latest" path — operators no longer have to update STATIC_POOL
  // manually when a provider ships a new model.
  try {
    // The SAME spec config.mjs resolved at startup, not a second copy of the
    // default -- see finalReviewModelSpec. This line read `|| 'latest-pro'`
    // until 2026-09-07 and silently reverted the flash switch here.
    const liveGemini = resolveModel(finalReviewModelSpec(), { silent: true });
    if (liveGemini !== MODEL) {
      process.stderr.write(`  [model-resolver] upgraded Gemini reviewer ${MODEL} → ${liveGemini}\n`);
      MODEL = liveGemini;
    }
  } catch { /* ignore */ }
  try {
    const liveOpus = resolveModel(process.env.CLAUDE_FINAL_REVIEW_MODEL || 'latest-opus', { silent: true });
    if (liveOpus !== CLAUDE_OPUS_MODEL) {
      process.stderr.write(`  [model-resolver] upgraded Claude Opus fallback ${CLAUDE_OPUS_MODEL} → ${liveOpus}\n`);
      CLAUDE_OPUS_MODEL = liveOpus;
    }
  } catch { /* ignore */ }
}
