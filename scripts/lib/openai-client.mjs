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
import { azureConfig, auditShadowConfig } from './config.mjs';
import { azureMaxRetries } from './azure-throttle.mjs';

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

  // ── OSS provider path (model-A/B/C harness) ──────────────────────────────
  // Explicit `{baseURL, apiKey, headers?}` override for an OpenAI-compatible
  // OSS router (OpenRouter). INDEPENDENT of the Azure/public branches below —
  // it is entered ONLY when `options.oss` is passed, so with no OSS arm the
  // public/Azure construction is byte-identical to today (the opt-in invariant,
  // regression-tested). The caller (audit-shadow) sources baseURL/apiKey from
  // `auditShadowConfig`; the OSS payload's egress safety is enforced UPSTREAM
  // (redact-once) + at the adapter's pre-send guard, exactly like the GPT path.
  if (options.oss) {
    const { baseURL, apiKey, headers } = options.oss;
    if (!baseURL) throw new Error('[openai-client] oss path requires options.oss.baseURL');
    if (!apiKey) throw new Error('[openai-client] oss path requires options.oss.apiKey (e.g. OPENROUTER_API_KEY)');
    const normBase = trimTrailingSlash(baseURL);
    // Consolidated Gemini gate fix G3: the cache key previously omitted
    // `headers`, so two calls with the same baseURL+apiKey but DIFFERENT
    // routing/identity headers (e.g. OpenRouter's `HTTP-Referer`/`X-Title`)
    // would incorrectly share a cached client and silently reuse the FIRST
    // call's headers for every subsequent call. Headers are hashed via the
    // same `keyDigest` helper used for the API key (stable key-order via
    // sorted JSON.stringify — object key order isn't guaranteed otherwise).
    const headerDigest = headers ? keyDigest(JSON.stringify(headers, Object.keys(headers).sort())) : 'no-headers';
    const cacheKey = `oss:${normBase}:${keyDigest(apiKey)}:${headerDigest}`;
    if (!options.fresh && _clientCache.has(cacheKey)) return _clientCache.get(cacheKey);
    const client = new OpenAI({ baseURL: normBase, apiKey, defaultHeaders: headers || undefined });
    _clientCache.set(cacheKey, client);
    return client;
  }

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
      // The SDK retries 429/503 honouring the `Retry-After` / `x-ratelimit-reset-*`
      // headers with exponential backoff — the primary 429 absorber on Azure's
      // small default quotas.
      maxRetries: azureMaxRetries(),
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

/**
 * Create an OpenRouter client — the named entry point for the OSS route.
 *
 * OpenRouter is an OpenAI-shaped endpoint, so this deliberately does NOT build
 * a second client: it resolves the credentials and delegates to the `oss` path
 * of {@link createOpenAIClient}, which owns the cache key (including the header
 * digest) and the construction. Architectural-memory consultation banded
 * `createOpenAIClient` as `precedent/above-floor-standout` for exactly this
 * intent — a sibling client would have fragmented OSS routing across two
 * modules and duplicated the header-digest cache fix.
 *
 * What it removes: every call site used to re-thread
 * `{oss: {baseURL: auditShadowConfig.openrouterBaseUrl, apiKey: auditShadowConfig.openrouterApiKey}}`
 * by hand, so each one independently re-read config and independently decided
 * what to do when the key was absent (most did nothing, and surfaced the
 * SDK's own opaque 401 instead).
 *
 * Request-side OpenRouter pinning (`provider:{require_parameters,sort}`,
 * `reasoning:{effort}`) is NOT here — that is per-request and already owned by
 * `oss-structured-output.mjs` / `tiered-provider-calls.mjs`. This seam is
 * construction only.
 *
 * @param {object} [options]
 * @param {object} [options.config] - inject an auditShadowConfig snapshot (tests;
 *   the module-level config is frozen at import, so env set afterwards is unseen)
 * @param {Record<string,string>} [options.headers] - routing/identity headers
 *   (e.g. OpenRouter's `HTTP-Referer` / `X-Title`); part of the cache key
 * @param {boolean} [options.fresh] - bypass cache (tests)
 * @returns {Promise<import('openai').OpenAI>}
 * @throws {Error} when no OpenRouter key is configured — actionable, and named,
 *   rather than deferring to a 401 from the wire
 */
export async function createOpenRouterClient(options = {}) {
  const cfg = options.config || auditShadowConfig;
  const baseURL = cfg.openrouterBaseUrl;
  const apiKey = cfg.openrouterApiKey;
  if (!apiKey) {
    throw new Error(
      '[openai-client] OpenRouter route requires OPENROUTER_API_KEY. ' +
      'Set it in .env (OPENROUTER_BASE_URL is optional; defaults to https://openrouter.ai/api/v1).',
    );
  }
  return createOpenAIClient({
    oss: { baseURL, apiKey, headers: options.headers },
    fresh: options.fresh,
  });
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
