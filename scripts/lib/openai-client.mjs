/**
 * @fileoverview Pluggable OpenAI-shaped client factory (public OpenAI ∥ Azure).
 *
 * Plan: docs/plans/azure-work-profile.md §2 / §7 #1. Sibling of
 * `anthropic-client.mjs` — one env-driven seam so call sites swap
 * `new OpenAI({ apiKey })` → `await createOpenAIClient({ purpose })` with no
 * other change.
 *
 * Routing (gated on `azureConfig.active`, i.e. AZURE_OPENAI_ENDPOINT present):
 *
 *   - **Azure active** → the Azure OpenAI **v1 surface**: plain `OpenAI` SDK
 *     with `baseURL = ${endpoint}/openai/v1`, `api-key` header, `api-version`
 *     query. This is the kit-proven construction
 *     (docs/plans/security/files/scripts/lib/security/azure-embed.mjs).
 *       · purpose `gpt` / `embed` → `AZURE_OPENAI_ENDPOINT`
 *       · purpose `foundry-claude` → `AZURE_AI_ENDPOINT` (+ `foundryApiPath`,
 *         which may be `/models` rather than `/openai/v1` on Foundry
 *         Serverless — Gemini-R3-M, manual-verification-required).
 *
 *   - **Azure inactive** → `new OpenAI({ apiKey: OPENAI_API_KEY })`, **byte-
 *     identical** to today (the opt-in invariant; see tests).
 *
 * **No egress-redaction wrapper (deliberate — Gemini-R2-H2)**: unlike
 * `anthropic-client.mjs`, the GPT/embed payload's egress safety is enforced
 * UPSTREAM (`audit-scope.mjs` + `sensitive-egress-gate.mjs` filter sensitive
 * files before the payload is built; the secret-classifier gates security
 * writes). Wrapping the client would break the byte-identical guarantee and
 * risk corrupting legitimate code payloads. The factory returns the SDK client
 * directly.
 *
 * Module-global single-client cache keyed by effective resolved values — two
 * unparameterised calls share an entry (matches the "reuse the client created
 * in main()" rule). **Never logs the key.**
 *
 * @module scripts/lib/openai-client
 */

import { createHash } from 'node:crypto';
import { azureConfig } from './config.mjs';

const VALID_PURPOSES = new Set(['gpt', 'foundry-claude', 'embed']);

/** @type {Map<string, object>} */
const _clientCache = new Map();

/** Strip trailing slashes so endpoint + path concatenation is clean. */
function trimTrailingSlash(s) {
  return String(s).replace(/\/+$/, '');
}

/** Ensure a URL path starts with exactly one leading slash (`models` → `/models`). */
function normalizeApiPath(p) {
  const s = String(p || '').trim();
  if (s === '') return '/openai/v1';
  return s.startsWith('/') ? s.replace(/\/+$/, '') : `/${s.replace(/\/+$/, '')}`;
}

/** Short, non-reversible token for cache keys — never store raw key material in the Map. */
function keyDigest(k) {
  return createHash('sha256').update(String(k)).digest('hex').slice(0, 16);
}

/**
 * Resolve the Azure base URL for a purpose. `gpt`/`embed` use the AOAI
 * endpoint; `foundry-claude` uses the Foundry inference endpoint + path.
 * @returns {string}
 */
function azureBaseUrl(purpose, cfg) {
  if (purpose === 'foundry-claude') {
    if (!cfg.aiEndpoint) {
      throw new Error(
        '[openai-client] purpose "foundry-claude" requires AZURE_AI_ENDPOINT to be set.',
      );
    }
    return `${trimTrailingSlash(cfg.aiEndpoint)}${normalizeApiPath(cfg.foundryApiPath)}`;
  }
  return `${trimTrailingSlash(cfg.openaiEndpoint)}/openai/v1`;
}

/**
 * Create or retrieve a cached OpenAI-shaped client.
 *
 * @param {object} [options]
 * @param {'gpt'|'foundry-claude'|'embed'} [options.purpose] - routing intent (default 'gpt')
 * @param {object} [options.azure] - inject an azureConfig snapshot (tests)
 * @param {string} [options.apiKey] - override OPENAI_API_KEY (public path, tests)
 * @param {boolean} [options.fresh] - bypass cache (tests)
 * @returns {Promise<import('openai').OpenAI>}
 */
export async function createOpenAIClient(options = {}) {
  const purpose = options.purpose || 'gpt';
  if (!VALID_PURPOSES.has(purpose)) {
    throw new Error(
      `[openai-client] Invalid purpose "${purpose}". Valid: ${[...VALID_PURPOSES].join(', ')}.`,
    );
  }
  const cfg = options.azure || azureConfig;
  const { default: OpenAI } = await import('openai');

  // Cache key from EFFECTIVE values (never the key material in plaintext beyond
  // the in-process map — and we never log it).
  let cacheKey;
  let build;
  if (cfg.active) {
    const baseURL = azureBaseUrl(purpose, cfg);
    // Digest the key — never store raw secret material as a Map key.
    cacheKey = `azure:${baseURL}:${cfg.apiVersion}:${keyDigest(cfg.apiKey)}`;
    build = () => new OpenAI({
      baseURL,
      apiKey: cfg.apiKey,
      defaultHeaders: { 'api-key': cfg.apiKey },
      defaultQuery: { 'api-version': cfg.apiVersion },
    });
  } else {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    // Byte-identical to today's `new OpenAI({ apiKey })`.
    cacheKey = `public:${keyDigest(apiKey)}`;
    build = () => new OpenAI({ apiKey });
  }

  if (!options.fresh && _clientCache.has(cacheKey)) {
    return _clientCache.get(cacheKey);
  }
  const client = build();
  _clientCache.set(cacheKey, client);
  return client;
}

/** Reset the module-global client cache. Tests only. */
export function _resetClientCache() {
  _clientCache.clear();
}

// Exports for tests — mirrors the file-io.mjs / anthropic-client.mjs pattern.
export const _internals = {
  azureBaseUrl,
  trimTrailingSlash,
  VALID_PURPOSES,
};
