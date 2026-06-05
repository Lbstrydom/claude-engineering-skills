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
    const resp = await client.embeddings.create({
      model: cfg.embedDeployment,
      input: safeText,
      dimensions: dim,
    });
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

export const _internals = { validateVector, DEFAULT_GEMINI_EMBED_MODEL };
