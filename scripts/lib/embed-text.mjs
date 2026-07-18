/**
 * @fileoverview Provider-aware single-text embedding router.
 *
 * Plan: docs/plans/azure-work-profile.md §1.5 / §7 #2. Routes embeddings to
 * Azure OpenAI (`text-embedding-3-small`, `dimensions: dim`) when the Azure
 * work profile is active, else to the existing Gemini `embedContent` path.
 *
 * **Return contract** — the project-standard `{result, usage, latencyMs}`
 * (AGENTS.md code style), `result` being the length-`dim` vector. Matches what
 * `generateIntentEmbedding` already returns, so call sites swap shape-for-shape.
 *
 * **Vector-space safety (Gemini-R2-H1)** — embeddings are only comparable
 * within ONE provider's space. `providerTag()` exposes this run's provider
 * identity so callers can compare against the index's stored provenance and
 * refuse cross-provider queries (a query routed to Azure against a
 * Gemini-built index returns garbage similarity even at equal dim).
 *
 * Egress: text is redacted at the boundary (defense-in-depth, parity with
 * `generateIntentEmbedding`). This matches the EXISTING embedding egress posture
 * — callers that embed file-derived content (e.g. `refresh-incidents`) run the
 * sensitive-path / secret-classifier gate UPSTREAM before calling in; this
 * boundary redaction is the same second layer the prior inline call had, not a
 * downgrade. No retry in v1 — matches the current Gemini path (the corporate
 * kit's `retryWithBackoff` is not present in this repo).
 *
 * @module scripts/lib/embed-text
 */

import { azureConfig, symbolIndexConfig } from './config.mjs';
// secret-patterns.redactSecrets returns { text, redacted } (the gentle redactor
// the embedding call sites already use) — NOT sanitizer.mjs, whose redactSecrets
// returns a bare string and would blanket-mangle legitimate code.
import { redactSecrets } from './secret-patterns.mjs';
import { getGeminiClient } from './llm-wrappers.mjs';
import { createOpenAIClient } from './openai-client.mjs';
import { azureThrottle } from './azure-throttle.mjs';

/**
 * Default Gemini embedding model — single source of truth is
 * `symbolIndexConfig.embedModel` (config.mjs); never re-pin it here.
 */
const DEFAULT_GEMINI_EMBED_MODEL = symbolIndexConfig.embedModel;

/**
 * The provider identity for the active embedding route. Callers store/compare
 * this against the index's recorded provenance to prevent cross-provider mixing.
 * @param {{model?:string, azure?:typeof azureConfig}} [opts]
 * @returns {string} e.g. `azure-openai:text-embedding-3-small` | `gemini:gemini-embedding-001`
 */
export function providerTag(opts = {}) {
  const cfg = opts.azure || azureConfig;
  if (cfg.active) return `azure-openai:${cfg.embedDeployment}`;
  return `gemini:${opts.model || DEFAULT_GEMINI_EMBED_MODEL}`;
}

/**
 * The endpoint-qualified vector-space identity for the ACTIVE Azure resource.
 *
 * A bare deployment name is NOT a unique vector space: the same alias (e.g.
 * `text-embedding-3-large`) on a different `AZURE_OPENAI_ENDPOINT` can map to a
 * different underlying model / dimension. Qualifying with the endpoint origin
 * makes the identity actually identify the space, so the refresh promotion
 * check and the query guard can detect a resource switch that keeps the alias.
 * The origin is normalized (lower-cased, path/query stripped) so trailing-slash
 * or case noise doesn't spuriously invalidate an index.
 *
 * @param {typeof azureConfig} azure - an active Azure config snapshot
 * @returns {string} e.g. `https://contoso-ai-dev.openai.azure.com::text-embedding-3-large`
 */
export function azureProvenanceId(azure) {
  return `${new URL(azure.openaiEndpoint).origin.toLowerCase()}::${azure.embedDeployment}`;
}

/**
 * Resolve the ONE embedding profile every consumer must share — the fix for the
 * three-way divergence (embed.mjs, refresh.mjs, and providerTag each resolved
 * "which model built this index" independently and disagreed under Azure).
 *
 * Returns three distinct fields because they are NOT interchangeable:
 *   - `requestModel`  — what to send to the provider API (bare Azure deployment,
 *                        or the concrete Gemini model id).
 *   - `provenanceId`  — what to PERSIST as the index's vector-space identity and
 *                        COMPARE on the read side. Endpoint-qualified for Azure.
 *   - `kind`          — provider family, for display/log tags only.
 *
 * Off-Azure the caller MUST pass the concrete model it will actually embed with;
 * re-defaulting here would let refresh publish a default id while the vectors
 * were made by a non-default model (the H3 mismatch). Falling back is a bug.
 *
 * @param {{azure?: typeof azureConfig, concreteModel?: string}} [opts]
 * @returns {{kind: 'azure-openai'|'gemini', requestModel: string, provenanceId: string}}
 */
export function resolveEmbedProfile({ azure = azureConfig, concreteModel } = {}) {
  if (azure.active) {
    return {
      kind: 'azure-openai',
      requestModel: azure.embedDeployment,
      provenanceId: azureProvenanceId(azure),
    };
  }
  if (!concreteModel) {
    throw new Error(
      'resolveEmbedProfile: concreteModel is required off-Azure — the caller must pass the ' +
      'concrete embedding model it will use (re-defaulting here would let a stale id be published).',
    );
  }
  return { kind: 'gemini', requestModel: concreteModel, provenanceId: concreteModel };
}

/**
 * Is ANY embedding provider configured? Distinguishes provider-ABSENT (a
 * deterministic config state — callers should degrade gracefully, the same
 * way they already do for cloud-disabled) from provider-ERROR (a real call
 * failure — callers should surface it loudly). The neighbourhood-consultation
 * CLIs use this so a cloud-enabled-but-no-Gemini fresh install gets an
 * empty-records hint instead of a non-zero exit (2026-07-14 installer audit).
 * @returns {Promise<boolean>}
 */
export async function isEmbedProviderAvailable() {
  if (azureConfig.active) return true;
  return !!(await getGeminiClient());
}

/**
 * Embed one string into a length-`dim` vector via the active provider.
 *
 * @param {string} text
 * @param {object} opts
 * @param {number} opts.dim - required output dimensionality (must match the index)
 * @param {string} [opts.model] - Gemini model id (public path only; Azure uses its deployment)
 * @param {typeof azureConfig} [opts.azure] - inject config snapshot (tests)
 * @param {object} [opts.client] - inject a provider client (tests)
 * @returns {Promise<{result:number[], usage:object, latencyMs:number, provider:string}>}
 */
export async function embedText(text, opts = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('embedText: text must be a non-empty string');
  }
  const dim = opts.dim;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`embedText: opts.dim must be a positive integer (got ${dim})`);
  }
  const cfg = opts.azure || azureConfig;
  const safeText = redactSecrets(text).text;
  const provider = providerTag(opts);
  const start = Date.now();

  if (cfg.active) {
    const client = opts.client || await createOpenAIClient({ purpose: 'embed', azure: cfg });
    let resp;
    try {
      resp = await azureThrottle(() => client.embeddings.create({
        model: cfg.embedDeployment,
        input: safeText,
        dimensions: dim,
      }));
    } catch (e) {
      // Runtime stays STRICT — never auto-switch deployments here (that would be
      // the unconfirmed provenance switch the design forbids). But an unknown/
      // missing-deployment error is exactly what `azure:doctor` diagnoses + fixes,
      // so name it (plan Phase 6 wiring) instead of surfacing a bare 400.
      const s = e?.status ?? e?.response?.status;
      const m = String(e?.code ?? e?.error?.code ?? e?.message ?? '');
      if (s === 400 || s === 404 || /unknown[_ ]?model|deploymentnotfound|does not exist/i.test(m)) {
        const err = new Error(
          `embedText: Azure embedding deployment "${cfg.embedDeployment}" was rejected ` +
          `(${s ?? 'error'}: ${m.slice(0, 120)}). Run \`npm run azure:doctor -- --fix\` to find ` +
          `and lock in the deployment your resource actually has.`,
        );
        err.code = 'EMBED_FAILED';
        err.cause = e;
        throw err;
      }
      throw e;
    }
    const vec = resp?.data?.[0]?.embedding;
    validateVector(vec, dim, cfg.embedDeployment);
    return {
      result: vec,
      // Normalize Azure's snake_case usage to the documented {totalTokens}
      // contract so both providers return the same shape.
      usage: { totalTokens: resp?.usage?.total_tokens ?? 0 },
      latencyMs: Date.now() - start,
      provider,
    };
  }

  // Public path — Gemini (today's behaviour).
  const client = opts.client || await getGeminiClient();
  if (!client) {
    const err = new Error('embedText: GEMINI_API_KEY not set and Azure profile inactive');
    err.code = 'EMBED_FAILED';
    throw err;
  }
  const model = opts.model || DEFAULT_GEMINI_EMBED_MODEL;
  const res = await client.models.embedContent({
    model,
    contents: safeText,
    config: { outputDimensionality: dim },
  });
  const vec = res?.embeddings?.[0]?.values;
  validateVector(vec, dim, model);
  return {
    result: vec,
    usage: { totalTokens: res?.usageMetadata?.totalTokenCount ?? 0 },
    latencyMs: Date.now() - start,
    provider,
  };
}

/** Throw on empty / wrong-dimension vectors (ports the kit's dim guard). */
function validateVector(vec, dim, model) {
  if (!Array.isArray(vec) || vec.length === 0) {
    const err = new Error(`embedText: empty embedding from ${model}`);
    err.code = 'EMBED_FAILED';
    throw err;
  }
  if (vec.length !== dim) {
    const err = new Error(
      `embedText: dim mismatch — got ${vec.length}, expected ${dim} (model=${model})`,
    );
    err.code = 'EMBEDDING_MISMATCH';
    throw err;
  }
  // A malformed provider response can return non-numeric entries; reject them
  // before they poison a stored vector / similarity math.
  if (!vec.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const err = new Error(`embedText: non-finite element in embedding from ${model}`);
    err.code = 'EMBED_FAILED';
    throw err;
  }
}

export const _internals = { validateVector, DEFAULT_GEMINI_EMBED_MODEL, resolveEmbedProfile, azureProvenanceId };
