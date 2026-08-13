/**
 * @fileoverview Pluggable Anthropic client factory.
 *
 * Backends (selected via env `CLAUDE_BACKEND`):
 *
 *   `sdk`  (default) — raw `@anthropic-ai/sdk`.
 *                       Bills your Anthropic API key on a per-token basis.
 *
 *   `cli`            — spawns `claude -p ... --output-format json`.
 *                       Bills the Max subscription today; from 2026-06-15
 *                       this draws from the Max 20x Agent SDK $200/mo
 *                       credit per the announcement
 *                       (https://support.anthropic.com — search "Agent SDK credit").
 *                       Default flag stays `sdk` until that date; flip when
 *                       the credit redemption flow opens.
 *
 * Both backends expose the same `.messages.create({model, max_tokens, system, messages})`
 * shape returning `{content: [{type:'text', text}], usage: {input_tokens, output_tokens}, ...}`.
 * Call sites swap `new Anthropic({apiKey})` → `await createAnthropicClient()`
 * with no other changes.
 *
 * **Contract scope** — the `cli` adapter targets one-shot, single-user-message,
 * text-only generation (the only call pattern we use). It throws on
 * multi-turn messages or non-text content blocks rather than silently
 * lossy-flattening them. `max_tokens` has no `claude -p` flag equivalent;
 * passing it on the cli backend emits a one-time stderr warning so the
 * mismatch is surfaced rather than silently dropped.
 *
 * Module-global single-client cache: subsequent calls within the same process
 * reuse the same adapter (matches the AGENTS.md "reuse the client created in
 * main()" rule). Cache key is built from the *effective* values (post-env
 * resolution), not the raw `options` object, so two `createAnthropicClient()`
 * calls without overrides hit the same cache entry as expected.
 *
 * Redaction (deny-by-default): every outgoing `system` and text content
 * block is passed through `redactSecrets()` from `./sanitizer.mjs` before
 * leaving the process (cli backend) or being handed to the SDK (sdk
 * backend). Callers no longer need to pre-redact — the factory enforces
 * it. To override, pass `redactor: <fn>` (custom) or `redactor: null`
 * (explicit opt-out; not recommended).
 *
 * @module scripts/lib/anthropic-client
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Short, non-reversible token for cache keys — never store raw key material. */
function keyDigest(k) {
  return k ? createHash('sha256').update(String(k)).digest('hex').slice(0, 16) : '';
}

// ── CLI envelope schema ─────────────────────────────────────────────────────
// Validates the JSON shape emitted by `claude -p --output-format json`.
// `result` is required; everything else is optional/lenient because the
// envelope evolves between Claude Code versions.
const ClaudeCliEnvelope = z.object({
  result: z.string(),
  is_error: z.boolean().optional(),
  model: z.string().optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).passthrough().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
}).passthrough();

const ClaudeCliErrorEnvelope = z.object({
  is_error: z.literal(true),
  result: z.string().optional(),
}).passthrough();

const VALID_BACKENDS = new Set(['sdk', 'cli', 'bedrock']);

/**
 * AWS Bedrock serves Claude through its own SDK and its own credential chain.
 *
 * `@anthropic-ai/bedrock-sdk` is deliberately NOT a dependency of this repo: it
 * pulls the AWS SDK credential-provider stack, and this bundle syncs into
 * consumer repos that will never use Bedrock. It is imported dynamically and a
 * missing package produces an install hint rather than a module-resolution
 * stack trace.
 *
 * Model ids differ on Bedrock (`anthropic.claude-…-v1:0`, or an `eu.`/`us.`
 * inference-profile prefix) and are NOT mapped here — a silent rewrite of a
 * caller's model id is how you bill the wrong model and never notice. Callers
 * targeting Bedrock pass a Bedrock model id.
 */
const BEDROCK_SDK_PACKAGE = '@anthropic-ai/bedrock-sdk';

// Default subprocess timeout for cli backend. Overridable via
// CLAUDE_CLI_TIMEOUT_MS env var. Picked to comfortably exceed Haiku/Sonnet
// p99 first-token latency while still failing fast on a hung child.
const DEFAULT_CLI_TIMEOUT_MS = 120_000;
// 100ms floor is generous: legitimate CLI calls take seconds. Anything
// lower is almost certainly a `.env` typo (`CLAUDE_CLI_TIMEOUT_MS=120`
// when they meant 120000).
const MIN_CLI_TIMEOUT_MS = 100;
const MAX_CLI_TIMEOUT_MS = 3_600_000; // 1 hour — anything beyond is a config bug

/**
 * Resolve and validate the effective subprocess timeout. Rejects nonsensical
 * values (zero, negative, Infinity, NaN, > 1h) — these usually indicate a
 * `.env` typo and would either hang forever or fail every call.
 */
function resolveTimeoutMs(optionsTimeout) {
  const raw = optionsTimeout !== undefined
    ? optionsTimeout
    : (process.env.CLAUDE_CLI_TIMEOUT_MS ? Number(process.env.CLAUDE_CLI_TIMEOUT_MS) : DEFAULT_CLI_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < MIN_CLI_TIMEOUT_MS || raw > MAX_CLI_TIMEOUT_MS) {
    throw new Error(
      `[anthropic-client] CLAUDE_CLI_TIMEOUT_MS / options.timeoutMs must be a finite number ` +
      `in [${MIN_CLI_TIMEOUT_MS}, ${MAX_CLI_TIMEOUT_MS}] ms (got ${raw}).`,
    );
  }
  return raw;
}

/** @type {Map<string, object>} */
const _clientCache = new Map();

/** Once-per-session tracking for warnings. */
let _warnedMaxTokensCli = false;

/**
 * Resolve the backend from env. **Throws** on invalid values — the backend
 * choice affects billing, so a typo like `CLAUDE_BACKEND=cil` must surface
 * at config-load time rather than silently routing to a paid path. Unset
 * the variable to use the default `sdk`.
 * @returns {'sdk'|'cli'|'bedrock'}
 * @throws {Error} when CLAUDE_BACKEND is set to an unrecognised value
 */
export function resolveBackend() {
  const raw = (process.env.CLAUDE_BACKEND || 'sdk').toLowerCase();
  if (!VALID_BACKENDS.has(raw)) {
    // Hard-fail on invalid values. The backend choice affects billing (API
    // meter vs Agent SDK credit), so a typo like `CLAUDE_BACKEND=cil` must
    // not silently route to a paid path — fail at config load instead.
    throw new Error(
      `[anthropic-client] Invalid CLAUDE_BACKEND="${raw}". ` +
      `Valid values: ${[...VALID_BACKENDS].join(', ')}. ` +
      `Unset the variable to use the default "sdk".`,
    );
  }
  return /** @type {'sdk'|'cli'|'bedrock'} */ (raw);
}

/**
 * The AWS region Bedrock calls target, or '' when none is resolvable.
 *
 * Region is the one part of the AWS chain that cannot be discovered for us:
 * credentials come from env vars, a shared profile, SSO or the instance
 * metadata service, but `AnthropicBedrock` still needs to know WHERE. Checking
 * it here turns "no region" into a named config error instead of a failure
 * from inside the AWS SDK.
 */
function resolveAwsRegion() {
  return (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '').trim();
}

/**
 * Is a Claude client usable right now without throwing at construction?
 *
 * The cli backend authenticates via the `claude` CLI (subscription / Agent SDK
 * credit) and needs NO `ANTHROPIC_API_KEY`; the sdk backend requires the key
 * (createAnthropicClient throws without it). Call sites that previously gated
 * on `process.env.ANTHROPIC_API_KEY` to decide whether to attempt a Claude call
 * MUST use this instead — otherwise the cli backend is silently skipped even
 * though it's fully available.
 *
 * Surfaces an invalid `CLAUDE_BACKEND` (resolveBackend throws) on purpose: a
 * billing-affecting typo should fail loud, consistent with createAnthropicClient.
 *
 * @returns {boolean}
 */
export function isClaudeAvailable() {
  const backend = resolveBackend();
  if (backend === 'cli') return true;
  // Bedrock authenticates through the AWS credential chain, so ANTHROPIC_API_KEY
  // is irrelevant to it — gating on that key would skip a fully-available
  // backend, the same defect this function exists to prevent for `cli`. Region
  // is the only part the chain cannot supply for us, so it is the availability
  // signal; credentials themselves surface at call time via the AWS SDK.
  if (backend === 'bedrock') return Boolean(resolveAwsRegion());
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * The SDK's own default endpoint. A baseURL that normalises to this value is
 * semantically ABSENT — it expresses no custom-endpoint intent, because it
 * names exactly the service every backend targets when no baseURL is set.
 *
 * Why this matters (found 2026-07-18, root-caused from 15 test failures):
 * **agent harnesses inject this value ambiently.** Claude Code desktop sets
 * `ANTHROPIC_BASE_URL=https://api.anthropic.com` in every shell it spawns —
 * it is in no dotfile, no settings.json, and cannot be unset "at the source"
 * because the source is the harness itself, outside this repo's control (and
 * dotenv never overrides an existing var, so `.env` can't fix it either).
 * Treating that injected default as a *custom-endpoint intent* had three
 * distinct bad consequences, all downstream of `effectiveBaseURL`:
 *   1. explicit `backend:'cli'` + injected default → the contradiction throw
 *      (every cli-adapter test failed inside the harness, passed outside it);
 *   2. ambient `CLAUDE_BACKEND=cli` + injected default → silent coercion to
 *      the sdk backend, billing the API key instead of the Agent SDK credit;
 *   3. a truthy baseURL flips the Azure-key precedence, so an ambient
 *      `AZURE_OPENAI_API_KEY` would have been sent to PUBLIC api.anthropic.com.
 * Normalising at the single resolution point fixes all three consumers at
 * once. A GENUINELY custom URL (corporate gateway, LiteLLM, Foundry) keeps
 * today's exact semantics — including the loud cli contradiction, which is
 * correct: silently ignoring a real gateway URL would misroute a corporate
 * payload to the public endpoint.
 */
const CANONICAL_ANTHROPIC_URL = 'https://api.anthropic.com';

/** '' when `url` is empty OR the canonical default (case-insensitive, trailing
 *  slashes ignored); the trimmed original otherwise. */
function normalizeBaseUrl(url) {
  const trimmed = String(url || '').trim();
  const comparable = trimmed.replace(/\/+$/, '').toLowerCase();
  return comparable === CANONICAL_ANTHROPIC_URL ? '' : trimmed;
}

/** Once-per-session tracking so the baseURL→sdk coercion warns but doesn't spam. */
let _warnedBaseUrlForcedSdk = false;

/**
 * Reconcile the resolved backend with an explicit `baseURL`.
 *
 * The cli adapter spawns `claude -p`, which talks to Anthropic's own service and
 * takes NO baseURL — it cannot honour one. Silently ignoring the caller's
 * baseURL under an ambient `CLAUDE_BACKEND=cli` is a **misroute**, not a
 * degradation: an Azure/Foundry call would go to PUBLIC api.anthropic.com,
 * sending a corporate payload to the wrong provider and reporting the wrong
 * endpoint's limits/billing as Azure's.
 *
 * Precedence mirrors the effectiveApiKey rule below (an explicit baseURL means
 * "target THIS endpoint", and that intent beats ambient env):
 *   - baseURL + ambient cli   → coerce to sdk, warn once (intent wins)
 *   - baseURL + explicit cli  → throw (the caller contradicted itself)
 *   - no baseURL              → unchanged
 *
 * @param {'sdk'|'cli'} backend - the resolved backend
 * @param {string} baseURL - the effective baseURL ('' when absent)
 * @param {boolean} backendWasExplicit - true when the caller passed options.backend
 * @returns {'sdk'|'cli'}
 */
function reconcileBackendWithBaseUrl(backend, baseURL, backendWasExplicit) {
  // Bedrock targets an AWS endpoint derived from the region; an Anthropic
  // baseURL cannot be honoured. Unlike `cli` this NEVER coerces to sdk, not
  // even for an ambient backend: cli-vs-sdk moves billing between Anthropic
  // meters, but bedrock-vs-sdk moves it between an AWS account and an Anthropic
  // key. Silently picking one is worse than refusing. (The harness-injected
  // canonical URL has already normalised to '' before this point, so only a
  // genuinely custom endpoint reaches here.)
  if (backend === 'bedrock' && baseURL) {
    throw new Error(
      `[anthropic-client] backend:'bedrock' cannot honour baseURL="${baseURL}" — Bedrock ` +
      `targets an AWS endpoint derived from AWS_REGION. Unset ANTHROPIC_BASE_URL to use ` +
      `Bedrock, or choose backend:'sdk' to target that endpoint directly.`,
    );
  }
  if (backend !== 'cli' || !baseURL) return backend;
  if (backendWasExplicit) {
    throw new Error(
      `[anthropic-client] backend:'cli' cannot honour baseURL="${baseURL}" — the cli ` +
      `adapter spawns \`claude -p\` against Anthropic's own service and takes no baseURL. ` +
      `Use backend:'sdk' to target a custom endpoint, or drop the baseURL.`,
    );
  }
  if (!_warnedBaseUrlForcedSdk) {
    _warnedBaseUrlForcedSdk = true;
    process.stderr.write(
      `  [anthropic-client] baseURL set (${baseURL}) → using the sdk backend despite ` +
      `CLAUDE_BACKEND=cli. The cli backend cannot target a custom endpoint; honouring ` +
      `it would silently route this call to public api.anthropic.com.\n`,
    );
  }
  return 'sdk';
}

/**
 * Create or retrieve a cached Anthropic-shaped client.
 *
 * **Egress redaction** — by default, the SHAPE-based `redactSecrets` from
 * [scripts/lib/secret-patterns.mjs](secret-patterns.mjs) is applied to
 * `system` strings and every text content block before they leave the
 * process (real secret shapes only — provider keys, JWTs, PEM, DSN
 * passwords; it does NOT blanket-redact long identifiers the way
 * sanitizer.mjs does, which corrupted identifier-dense prompts). Pass
 * `redactor: null` to opt out, or a custom function `(s: string) => string`.
 * The default redactor is identity-cached (same Function reference per
 * factory load) so the client cache works correctly.
 *
 * **Cache key** — built from effective resolved env values + redactor
 * identity. Distinct custom redactor functions DO NOT share a cache
 * entry; passing `redactor` always bypasses the cache and returns a
 * fresh client. Callers that need a long-lived client with a custom
 * redactor should manage its lifetime themselves.
 *
 * @param {object} [options]
 * @param {'sdk'|'cli'} [options.backend] - Override env-resolved backend (test injection)
 * @param {string} [options.apiKey] - Override `ANTHROPIC_API_KEY` (sdk backend only)
 * @param {object} [options.azureRoute] - A resolved Azure Claude route
 *   (`azureConfig.claudeRoute`): `{baseUrl, apiKey, authMode, credentialVar}`.
 *   Supplying it is the ONLY correct way to reach an Azure-hosted Claude — it
 *   pins the endpoint, the credential and the auth header together, so the
 *   APIM subscription key can never be sent to the direct Foundry host (or
 *   vice versa). Overrides `options.baseURL`.
 * @param {string} [options.claudeBin] - Override `CLAUDE_BIN` (cli backend only)
 * @param {number} [options.timeoutMs] - Per-call default subprocess timeout (cli backend)
 * @param {((text: string) => string)|null} [options.redactor] - Egress redactor.
 *   Defaults to `redactSecrets`. `null` disables redaction (NOT recommended).
 * @param {boolean} [options.fresh] - Bypass cache (for tests)
 * @param {Function} [options.fetch] - Inject a transport so a test can capture the
 *   exact URL and headers the INSTALLED SDK emits. The SDK binds its transport at
 *   construction, so patching `globalThis.fetch` after the fact observes nothing.
 *   A client built with an injected transport is never cached (either direction),
 *   so it can never be handed to a production call site. sdk backend only.
 * @returns {Promise<{messages: {create: (params: object, requestOptions?: object) => Promise<object>}}>}
 */
export async function createAnthropicClient(options = {}) {
  // Resolve effective env values BEFORE building the cache key so that two
  // unparameterised calls share a cache entry.
  // baseURL override (Azure AI Foundry `anthropic` shape). Absent → public
  // api.anthropic.com (today's behaviour, unchanged). When a baseURL is set
  // AND an Azure key is present, the Foundry endpoint authenticates via the
  // `api-key` header (the SDK's default `x-api-key` is insufficient there).
  // Normalised: the canonical default (harness-injected by e.g. Claude Code
  // desktop) reads as ABSENT — see CANONICAL_ANTHROPIC_URL above for the three
  // downstream consumers this protects (cli guard, backend coercion, Azure-key
  // precedence).
  // A resolved Azure Claude route (config.mjs `azureConfig.claudeRoute`) is the
  // AUTHORITATIVE source for baseURL + credential + auth header when passed:
  // the three belong to one service and are never separately overridable. Absent,
  // we fall back to the legacy `options.baseURL` + env-sniff below, which is what
  // every pre-2026-08-13 caller relied on.
  const azureRoute = options.azureRoute || null;
  const effectiveBaseURL = normalizeBaseUrl(
    azureRoute?.baseUrl || options.baseURL || process.env.ANTHROPIC_BASE_URL || '',
  );
  // A baseURL is unhonourable by the cli backend — reconcile before the cache
  // key is built, so a coerced call can never share an entry with a cli client.
  const backend = reconcileBackendWithBaseUrl(
    options.backend || resolveBackend(),
    effectiveBaseURL,
    options.backend != null,
  );
  const azureKey = azureRoute
    ? (azureRoute.apiKey || '')
    : (effectiveBaseURL ? (process.env.AZURE_OPENAI_API_KEY || '') : '');
  // When targeting an Azure/Foundry endpoint, the Azure key MUST win over a
  // stray public ANTHROPIC_API_KEY — otherwise we'd send the public key to the
  // corporate endpoint. An explicit options.apiKey still overrides everything.
  const effectiveApiKey = options.apiKey || (effectiveBaseURL ? azureKey : '') || process.env.ANTHROPIC_API_KEY || '';
  // `bearer` reproduces the legacy behaviour exactly, so a caller that passes no
  // route (or a foundry route) emits a byte-identical request to today's.
  const azureAuthMode = azureRoute?.authMode || 'bearer';
  const effectiveClaudeBin = options.claudeBin || process.env.CLAUDE_BIN || 'claude';
  const effectiveTimeoutMs = resolveTimeoutMs(options.timeoutMs);

  // Default redactor is the shared `redactSecrets` (lazy-imported so test
  // injection can override without pulling in sanitizer.mjs).
  // `redactor: null` → no redaction (explicit opt-out).
  // `redactor: undefined` → default redactor.
  const effectiveRedactor = options.redactor === null
    ? null
    : (options.redactor || await getDefaultRedactor());

  // Cache key — only `null` (no redaction) and the shared default redactor
  // are cacheable. Custom redactor functions bypass the cache entirely
  // because two distinct functions could collapse to one cache entry under
  // a string key, returning the wrong redactor to the second caller.
  const defaultRedactor = await getDefaultRedactor();
  // `options.fetch` (test transport) is never cacheable in EITHER direction: it
  // must not be served a cached real client, and must not be stored as one.
  const cacheable = !options.fetch
    && (effectiveRedactor === null || effectiveRedactor === defaultRedactor);
  // Region is appended ONLY on the bedrock branch, so sdk/cli keys stay
  // byte-identical to today. Without it, two calls differing only by region
  // would share a client and silently target the first one's region.
  // `authMode` is appended ONLY when it is not the legacy `bearer`, so every
  // pre-existing key stays byte-identical. Without it two routes differing only
  // by auth header would share one client and silently authenticate the second
  // the first one's way.
  const cacheKey = `${backend}:${keyDigest(effectiveApiKey)}:${effectiveBaseURL}:${effectiveClaudeBin}:${effectiveTimeoutMs}:${effectiveRedactor === null ? 'n' : 'd'}`
    + (backend === 'bedrock' ? `:${resolveAwsRegion()}` : '')
    + (azureAuthMode === 'bearer' ? '' : `:auth=${azureAuthMode}`);
  if (!options.fresh && cacheable && _clientCache.has(cacheKey)) {
    return _clientCache.get(cacheKey);
  }

  let client;
  if (backend === 'cli') {
    client = createCliAdapter({
      claudeBin: effectiveClaudeBin,
      timeoutMs: effectiveTimeoutMs,
      redactor: effectiveRedactor,
    });
  } else if (backend === 'bedrock') {
    const awsRegion = resolveAwsRegion();
    if (!awsRegion) {
      throw new Error(
        "[anthropic-client] backend:'bedrock' requires AWS_REGION (or AWS_DEFAULT_REGION). " +
        'Credentials come from the standard AWS chain (env, shared profile, SSO, instance ' +
        'metadata), but the region cannot be inferred.',
      );
    }
    let AnthropicBedrock;
    try {
      ({ AnthropicBedrock } = await import(BEDROCK_SDK_PACKAGE));
    } catch {
      throw new Error(
        `[anthropic-client] backend:'bedrock' requires the ${BEDROCK_SDK_PACKAGE} package, ` +
        `which is not installed. Install it in the repo that uses this backend: ` +
        `\`npm install ${BEDROCK_SDK_PACKAGE}\`. It is intentionally not a dependency of the ` +
        `skills bundle, which syncs into consumer repos that do not use Bedrock.`,
      );
    }
    // Same redaction wrapper as the sdk path — Bedrock takes the identical
    // Messages-API shape, so payloads must pass through the same egress guard.
    client = wrapSdkClient(new AnthropicBedrock({ awsRegion }), effectiveRedactor);
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    if (!effectiveApiKey) {
      throw new Error('[anthropic-client] ANTHROPIC_API_KEY required for sdk backend');
    }
    let anthropicOpts;
    if (effectiveBaseURL && azureKey) {
      // Both Azure Claude transports serve the NATIVE Anthropic API at
      // `${baseURL}/v1/messages`; they differ ONLY in which header carries the
      // credential. maxRetries: the SDK honours Retry-After on 429 (Azure's
      // small quotas).
      const { azureMaxRetries } = await import('./azure-throttle.mjs');
      anthropicOpts = { baseURL: effectiveBaseURL, maxRetries: azureMaxRetries() };
      if (azureAuthMode === 'api-key') {
        // APIM subscription key. The SDK has no `api-key` option, so it is set
        // as a default header. `apiKey` must ALSO be supplied — the SDK refuses
        // to construct without one of apiKey/authToken ("Could not resolve
        // authentication method"), and the resulting `x-api-key` is ignored by
        // APIM. Bearer is rejected here with "Access denied due to missing
        // subscription key" (measured 2026-08-13 against a live APIM front-end).
        anthropicOpts.apiKey = azureKey;
        anthropicOpts.defaultHeaders = { 'api-key': azureKey };
      } else {
        // Direct AI Foundry inference endpoint: `Authorization: Bearer <key>`.
        // `authToken` is the SDK option that emits it (NOT x-api-key/api-key).
        anthropicOpts.authToken = azureKey;
      }
    } else if (effectiveBaseURL) {
      anthropicOpts = { apiKey: effectiveApiKey, baseURL: effectiveBaseURL };
    } else {
      anthropicOpts = { apiKey: effectiveApiKey };
    }
    // Test-only transport injection; undefined in production. The SDK binds its
    // transport at CONSTRUCTION, so a test cannot observe the emitted request by
    // patching `globalThis.fetch` afterwards — it has to be handed in here.
    if (options.fetch) anthropicOpts.fetch = options.fetch;
    const rawClient = new Anthropic(anthropicOpts);
    client = wrapSdkClient(rawClient, effectiveRedactor);
  }

  // A client carrying an injected transport is a test artefact: never written to
  // the shared cache, so it can never be handed to a real call site. Mirrors
  // `openai-client.mjs`'s identical seam.
  if (options.fetch) return client;
  if (cacheable) _clientCache.set(cacheKey, client);
  return client;
}

/** @type {((s: string) => string)|null} */
let _defaultRedactor = null;
async function getDefaultRedactor() {
  if (_defaultRedactor === null) {
    // SHAPE-based redactor (secret-patterns.mjs), NOT sanitizer.mjs. The old
    // default blanket-redacted ANY 20+ char [A-Za-z0-9_-] token, which
    // corrupted legitimate long identifiers in identifier-dense prompts —
    // symbol names (arch-index summaries, neighbourhood queries), file paths
    // and finding hashes (gemini-review's Opus/Azure final-review fallback),
    // CSS tokens (visual explain), and the arm-eval judge's rubric dim names
    // (a HARD schema failure, found on the first live calibration run —
    // commit 19a9ded). The shape registry catches real secret shapes
    // (provider keys, JWTs, PEM, DSN passwords, keyword-anchored tokens)
    // without the blanket-length false positives. Upstream hard gates
    // (sensitive-path filtering, assertEgressSafe) remain the primary
    // defense; this layer is defense-in-depth on the outbound payload.
    const { redactSecrets } = await import('./secret-patterns.mjs');
    _defaultRedactor = (s) => (typeof s === 'string' ? redactSecrets(s).text : s);
  }
  return _defaultRedactor;
}

/**
 * Wrap a raw SDK client so (a) every outbound `system` and text content block is
 * run through `redactor` before reaching the network (skipped when `redactor` is
 * null — explicit opt-out) and (b) the repo-wide `{ timeoutMs }` requestOptions
 * convention (used by every other caller — brainstorm-round, openai-audit,
 * visual-audit, this file's own cli adapter) is honoured under the SDK backend too.
 *
 * The raw Anthropic SDK's per-call option is named `timeout` (ms), NOT `timeoutMs`
 * — passing `{ timeoutMs }` straight through is silently IGNORED by the SDK, which
 * then falls back to `Anthropic.DEFAULT_TIMEOUT` (600000ms / 10 min). A caller
 * asking for a 300000ms (5 min) cap would unknowingly get double that. ALWAYS wrap
 * (even with redactor:null) so this translation happens on every SDK-backend call,
 * not just the redacted ones.
 */
function wrapSdkClient(rawClient, redactor) {
  return {
    // Diagnostic passthroughs — the resolved endpoint/auth stay inspectable
    // (Azure-profile checks and tests read them) even though the raw client
    // is otherwise hidden behind the wrapper.
    get baseURL() { return rawClient.baseURL; },
    get authToken() { return rawClient.authToken; },
    messages: {
      // NOT `async` — deliberately. The SDK returns an `APIPromise`, a thenable
      // carrying `.withResponse()` / `.asResponse()` for callers that need the
      // HTTP response (azure-limits reads the `x-ratelimit-*` headers off it).
      // An `async` wrapper awaits that thenable and re-wraps the resolved value
      // in a plain Promise, stripping those methods — `.withResponse()` then
      // throws `is not a function`. Returning the APIPromise unchanged keeps
      // both the await path and the response path working.
      create(params, requestOptions) {
        const body = redactor ? applyRedactor(params, redactor) : params;
        let opts = requestOptions;
        if (opts && opts.timeoutMs != null) {
          const { timeoutMs, ...rest } = opts;
          opts = { ...rest, timeout: timeoutMs };
        }
        return rawClient.messages.create(body, opts);
      },
    },
  };
}

/**
 * Return a shallow-cloned params object with redacted `system` and text
 * content blocks. Non-text content blocks pass through untouched (the
 * cli adapter rejects them, but the sdk path may forward images).
 *
 * Handles both `system: "string"` and `system: [{type:'text', text:'...'}]`
 * (the structured form used for prompt caching).
 */
function applyRedactor(params, redactor) {
  if (typeof redactor !== 'function') return params;
  const out = { ...params };
  if (typeof out.system === 'string') {
    out.system = redactor(out.system);
  } else if (Array.isArray(out.system)) {
    out.system = out.system.map(b =>
      b && b.type === 'text' && typeof b.text === 'string'
        ? { ...b, text: redactor(b.text) }
        : b,
    );
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map(m => {
      if (typeof m.content === 'string') return { ...m, content: redactor(m.content) };
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map(b =>
            b && b.type === 'text' && typeof b.text === 'string'
              ? { ...b, text: redactor(b.text) }
              : b,
          ),
        };
      }
      return m;
    });
  }
  return out;
}

/**
 * Reset the module-global client cache AND once-per-session warning flags.
 * Tests only.
 */
export function _resetClientCache() {
  _clientCache.clear();
  _warnedMaxTokensCli = false;
}

/**
 * Build a `claude -p` adapter that mimics the raw-SDK `.messages.create()` shape.
 *
 * Scope: targets one-shot single-user-message text-only generation. Throws
 * on multi-turn / non-text content rather than silently flattening. Pass
 * `redactor` to enforce egress redaction on `system` and text content.
 *
 * @param {{claudeBin?: string, timeoutMs?: number, redactor?: (s: string) => string}} opts
 * @returns {{messages: {create: (params: object, requestOptions?: object) => Promise<object>}}}
 */
function createCliAdapter(opts = {}) {
  const claudeBin = opts.claudeBin || process.env.CLAUDE_BIN || 'claude';
  const defaultTimeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const redactor = typeof opts.redactor === 'function' ? opts.redactor : null;

  return {
    messages: {
      /**
       * @param {{
       *   model?: string,
       *   max_tokens?: number,
       *   system?: string,
       *   messages: Array<{role: string, content: string|Array}>
       * }} params
       * @param {{signal?: AbortSignal, timeoutMs?: number}} [requestOptions]
       *   `signal` kills the child via SIGTERM; `timeoutMs` overrides the
       *   factory default for this single call.
       */
      async create(params, requestOptions = {}) {
        const { model, max_tokens, system, messages } = params;

        assertOneShotTextMessages(messages);

        if (max_tokens !== undefined && !_warnedMaxTokensCli) {
          _warnedMaxTokensCli = true;
          process.stderr.write(
            `  [anthropic-client] WARNING: max_tokens is not enforceable on the cli backend ` +
            `(claude -p has no equivalent flag). The model's own output limit applies.\n`,
          );
        }

        const effectiveSystem = redactor && typeof system === 'string'
          ? redactor(system) : system;
        const prompt = redactor
          ? redactor(buildPromptFromMessages(messages))
          : buildPromptFromMessages(messages);

        // Prompt goes via stdin — avoids shell-escaping the user content
        // when `shell: true` is required (Windows .cmd / .bat resolution).
        //
        // `--tools ''` disables ALL tools. This backend's contract is a SINGLE-
        // SHOT TEXT completion (assertOneShotTextMessages), so tool access
        // contradicts it: given a large/complex prompt an agentic `claude -p`
        // may choose `tool_use`, burn its `--max-turns` on the tool call, and
        // exit `error_max_turns` WITHOUT ever emitting the answer. Every current
        // caller (final review, summaries, prompt refinement, audits) wants a
        // completion, not an agent — disabling tools makes the one-shot contract
        // hold and is strictly safer for all of them.
        //
        // `--max-turns 6` (not 1): with tools OFF there is no agentic loop to
        // bound, but a large-prompt completion empirically still needs >1
        // internal turn — `--max-turns 1` made big audit prompts exit
        // `error_max_turns` (num_turns 2) with no answer. 6 is comfortable
        // headroom; the model still returns in a single visible turn, so this
        // costs nothing extra in the normal case while fixing the false failure.
        const args = ['-p', '--output-format', 'json', '--max-turns', '6', '--tools', ''];
        if (effectiveSystem) args.push('--system-prompt', effectiveSystem);
        if (model) args.push('--model', model);

        const callTimeoutMs = Number.isFinite(requestOptions.timeoutMs)
          ? requestOptions.timeoutMs
          : defaultTimeoutMs;

        const { stdout } = await runClaudeCli(
          claudeBin, args, requestOptions.signal, prompt, callTimeoutMs,
        );
        return normaliseCliOutput(stdout, model);
      },
    },
  };
}

/**
 * Reject inputs the cli adapter cannot faithfully represent: multi-turn
 * histories, assistant-role messages, image/tool_use/tool_result blocks.
 * Better to fail loudly than silently strip semantically meaningful data.
 *
 * @param {Array<{role: string, content: string|Array}>} messages
 */
function assertOneShotTextMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('[anthropic-client] cli backend requires a non-empty messages array');
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role && m.role !== 'user') {
      throw new Error(
        `[anthropic-client] cli backend supports user-role messages only ` +
        `(got role="${m.role}" at index ${i}). Use the sdk backend for multi-turn ` +
        `or assistant-priming flows.`,
      );
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || block.type !== 'text') {
          throw new Error(
            `[anthropic-client] cli backend supports text content blocks only ` +
            `(got type="${block?.type}" at message ${i}). Use the sdk backend ` +
            `for images, tool_use, or tool_result blocks.`,
          );
        }
      }
    } else if (typeof m.content !== 'string') {
      throw new Error(
        `[anthropic-client] cli backend: message ${i} content must be string or array`,
      );
    }
  }
}

/**
 * Flatten the messages array into a single user-prompt string. We only ever
 * pass single-turn one-shot prompts through this adapter, so this is safe.
 * @param {Array<{role: string, content: string|Array}>} messages
 * @returns {string}
 */
function buildPromptFromMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('[anthropic-client] messages must be an array');
  }
  return messages
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(b => b && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
          .join('\n');
      }
      return '';
    })
    .filter(s => s.length > 0)
    .join('\n\n');
}

/**
 * Spawn `claude -p ...` and collect stdout. Rejects on non-zero exit, process
 * error, AbortSignal abort, or `timeoutMs` elapsed. The timeout is a hard
 * upper bound — when it fires, the child is killed with SIGTERM (followed
 * by SIGKILL if it doesn't exit within 2s).
 *
 * On Windows, `shell: true` is required to resolve `.cmd`/`.bat` wrappers
 * (`claude.cmd` is the standard install). Args are still passed as an array;
 * the prompt content is sent via stdin to avoid shell-escaping arbitrary
 * user text. The remaining args (`--model`, `--system-prompt` values) are
 * controlled by application code, not external input.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {AbortSignal|undefined} signal - Aborting kills the child with SIGTERM.
 * @param {string} stdinPayload - Prompt content piped to the child's stdin.
 * @param {number} timeoutMs - Hard subprocess timeout in milliseconds.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runClaudeCli(bin, args, signal, stdinPayload = '', timeoutMs = DEFAULT_CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`[anthropic-client] aborted before spawn`));
      return;
    }

    let proc;
    try {
      if (process.platform === 'win32') {
        // shell:true is required to resolve claude.cmd (the standard install
        // on Windows). Node does not auto-quote args under shell:true, so we
        // must quote any arg containing whitespace or cmd special chars to
        // preserve `--system-prompt "be brief"` as a single argv entry.
        const quotedBin = quoteWinArg(bin);
        const quotedArgs = args.map(quoteWinArg);
        proc = spawn(quotedBin, quotedArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
          windowsVerbatimArguments: true,
        });
      } else {
        proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } catch (err) {
      reject(new Error(`[anthropic-client] failed to spawn '${bin}': ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    let killTimer = null;

    const cleanup = () => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (timeoutHandle) { clearTimeout(timeoutHandle); }
      signal?.removeEventListener('abort', onAbort);
    };

    // killProcessTree: on Windows + shell:true, `proc.kill()` terminates only
    // the cmd.exe shell, leaving the spawned `claude` (or test fake) running
    // orphaned. Use taskkill /T to kill the whole process tree. On POSIX,
    // node's signal-based kill is sufficient.
    const killProcessTree = (signal) => {
      if (!proc.pid) return;
      if (process.platform === 'win32') {
        try {
          spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch { /* best-effort */ }
      } else {
        try { proc.kill(signal); } catch { /* best-effort */ }
      }
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree('SIGTERM');
      // Force-kill if the child doesn't exit cleanly (POSIX only — taskkill /F
      // is already a hard kill on Windows).
      if (process.platform !== 'win32') {
        killTimer = setTimeout(() => killProcessTree('SIGKILL'), 2000);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timeoutHandle = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree('SIGTERM');
          if (process.platform !== 'win32') {
            killTimer = setTimeout(() => killProcessTree('SIGKILL'), 2000);
          }
        }, timeoutMs)
      : null;

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      cleanup();
      reject(new Error(`[anthropic-client] spawn error for '${bin}': ${err.message}`));
    });
    proc.on('close', code => {
      cleanup();
      if (timedOut) {
        reject(new Error(
          `[anthropic-client] '${bin}' timed out after ${timeoutMs}ms`,
        ));
        return;
      }
      if (aborted) {
        reject(new Error(`[anthropic-client] aborted`));
        return;
      }
      if (code !== 0) {
        reject(new Error(
          `[anthropic-client] '${bin}' exited ${code}: ${(stderr || stdout).slice(0, 500)}`,
        ));
        return;
      }
      resolve({ stdout, stderr });
    });

    // Swallow stdin EPIPE if the child exits without consuming stdin.
    proc.stdin.on('error', () => {});

    // Write the prompt to stdin and close it so the child exits.
    if (stdinPayload) proc.stdin.write(stdinPayload);
    proc.stdin.end();
  });
}

/**
 * Parse the JSON envelope produced by `claude -p --output-format json` and
 * reshape it into the raw-SDK response shape.
 *
 * Expected input fields (per Claude Code docs, stable as of v1.x):
 *   - `result`: final assistant text
 *   - `usage.input_tokens`, `usage.output_tokens`: token counts
 *   - `total_cost_usd`, `duration_ms`, `num_turns`: surfaced via _meta
 *
 * @param {string} stdout
 * @param {string|undefined} requestedModel
 * @returns {{
 *   content: [{type: 'text', text: string}],
 *   usage: {input_tokens: number, output_tokens: number},
 *   model: string|undefined,
 *   stop_reason: string,
 *   _meta: object
 * }}
 */
/**
 * Parse + validate `claude -p --output-format json` stdout. Throws on malformed
 * JSON, non-object root, schema mismatch, or `is_error: true` envelopes.
 *
 * The returned `_meta` field is the **cli backend's extension** of the SDK
 * response shape — it surfaces metrics (cost, duration, turn count) the raw
 * SDK doesn't include. It is documented and stable; the `sdk` backend
 * does not populate it.
 *
 * @param {string} stdout
 * @param {string|undefined} requestedModel
 * @returns {{
 *   content: [{type: 'text', text: string}],
 *   usage: {input_tokens: number, output_tokens: number},
 *   model: string|undefined,
 *   stop_reason: string,
 *   _meta: {cost_usd?: number, duration_ms?: number, num_turns?: number}
 * }}
 */
function normaliseCliOutput(stdout, requestedModel) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `[anthropic-client] failed to parse claude -p JSON output: ${err.message}. ` +
      `First 300 chars of stdout: ${stdout.slice(0, 300)}`,
    );
  }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(
      `[anthropic-client] claude -p output is not a JSON object: ${stdout.slice(0, 200)}`,
    );
  }

  // Error envelope: surface as throw so callers don't have to inspect a
  // success shape and then check is_error.
  if (json.is_error === true) {
    const errParse = ClaudeCliErrorEnvelope.safeParse(json);
    const detail = errParse.success ? (errParse.data.result || '(no detail)') : '(malformed error envelope)';
    throw new Error(`[anthropic-client] claude -p reported error: ${detail}`);
  }

  const parsed = ClaudeCliEnvelope.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `[anthropic-client] claude -p output failed schema validation: ` +
      `${parsed.error.message}. First 200 chars: ${stdout.slice(0, 200)}`,
    );
  }
  const data = parsed.data;

  return {
    content: [{ type: 'text', text: data.result }],
    usage: {
      input_tokens: Number(data.usage?.input_tokens) || 0,
      output_tokens: Number(data.usage?.output_tokens) || 0,
    },
    model: requestedModel || data.model,
    stop_reason: 'end_turn',
    _meta: {
      cost_usd: data.total_cost_usd,
      duration_ms: data.duration_ms,
      num_turns: data.num_turns,
    },
  };
}

/**
 * Quote an argument safely for Windows cmd.exe + CommandLineToArgvW round-trip.
 *
 * **Why `""` instead of `\"`**: cmd.exe parses quotes naively — it does NOT
 * treat `\"` as an escape. A value like `foo " & whoami` quoted as
 * `"foo \" & whoami"` would close the quoted span at the un-escaped `"`,
 * leaving `& whoami` to be evaluated by the shell (command injection).
 * The doubled-quote form `""` is interpreted as a literal `"` by BOTH
 * cmd.exe AND CommandLineToArgvW (the latter accepts it as an officially
 * documented alternate to `\"`).
 *
 * With `""` as the quote-escape, backslashes are always literal inside
 * the quoted span — no special handling needed.
 *
 * We additionally pass `windowsVerbatimArguments: true` to `spawn` so
 * Node forwards the args byte-for-byte without re-quoting.
 *
 * Reference: Microsoft "Naming Files, Paths, and Namespaces" + "Parsing
 * C++ command-line arguments" docs; Raymond Chen "Everyone quotes command
 * line arguments the wrong way" (devblogs.microsoft.com).
 *
 * @param {string} arg
 * @returns {string}
 */
function quoteWinArg(arg) {
  const s = String(arg);
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^()%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

// ── Exports for tests ───────────────────────────────────────────────────────

export const _internals = {
  buildPromptFromMessages,
  normaliseCliOutput,
  createCliAdapter,
  normalizeBaseUrl,
  quoteWinArg,
  getDefaultRedactor,
  wrapSdkClient,
};
