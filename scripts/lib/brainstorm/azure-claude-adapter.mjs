import { createAnthropicClient } from '../anthropic-client.mjs';
import { azureConfig } from '../config.mjs';
import { BRAINSTORM_SYSTEM_PROMPT } from './prompt.mjs';
import { estimateCostUsd } from './pricing.mjs';
import { isAbortFailure, abortMessage } from './error-classify.mjs';
import { truncatedMessage } from './depth-config.mjs';

/**
 * /brainstorm's Azure second voice — Claude on Azure AI Foundry.
 *
 * **Why this exists.** The Gemini leg is dark on an Azure work profile: there
 * is no Gemini in an Azure tenant, so an Azure-only install had one external
 * voice and the skill's whole premise (compare independent perspectives) was
 * halved. The final reviewer already makes exactly this substitution
 * (`gemini-review.mjs`'s `azure-claude` provider), so the id, the deployment
 * and the route resolution are deliberately the same ones — one name, one
 * meaning, bundle-wide.
 *
 * **On independence — do not overclaim.** When Claude Code is the orchestrator,
 * this voice shares a model family with the agent rendering the output. It is
 * still a genuinely separate view (no conversation history, no anchoring on
 * what the agent already said, its own system prompt), but it is NOT the
 * cross-vendor independence the public profile's OpenAI+Gemini pair gives. The
 * SKILL.md says so where the user reads it.
 *
 * Route safety: the endpoint, credential and auth header are resolved together
 * as `azureConfig.claudeRoute` and passed as one unit — never a bare `baseURL`
 * with an env-sniffed key, which is the 2026-08-13 cross-service-credential
 * incident this seam was built to make unrepresentable.
 */
let _client = null;
function clientOptions() {
  return {
    // The cli backend cannot honour a custom endpoint (it shells out to
    // `claude -p`), so it would silently ignore the Foundry route and bill the
    // user's own subscription instead. Pin the SDK transport, exactly as
    // azure-doctor and azure-limits do on this route.
    backend: 'sdk',
    azureRoute: azureConfig.claudeRoute,
  };
}

async function client() {
  if (!_client) _client = await createAnthropicClient(clientOptions());
  return _client;
}

/** Test seam: drop the memoised client so a route change is observable. */
export function _resetClient() { _client = null; }

/**
 * Call Azure Foundry Claude with the brainstorm system prompt + user topic.
 * Always returns a ProviderResult — never throws to the caller (total output
 * contract: the envelope must stay schema-valid whatever the provider does).
 *
 * @param {object} args
 * @param {string} args.topic      Post-redaction user topic
 * @param {string} args.model      Foundry DEPLOYMENT name (not a public model id)
 * @param {number} args.maxTokens  Cap for output tokens
 * @param {number} [args.timeoutMs]
 * @param {string} [args.systemPrompt]
 * @param {string|null} [args.reasoningEffort] Anthropic `output_config.effort`
 *   (depth-config `CLAUDE_DEPTH_EFFORT`). null ⇒ omitted, i.e. the provider
 *   default — which on Opus 5 is `high` thinking, the cause of the storyline
 *   truncations, so the CLI always passes one.
 * @param {string|null} [args.truncationRemedy] What a truncated result should
 *   tell the user to do; depends on the tier, which this adapter cannot see.
 * @param {object|null} [args._clientOptions] Test-only overrides merged into
 *   `createAnthropicClient` (e.g. a synthetic `azureRoute` + an injected
 *   `fetch`). Present ⇒ the memoised client is bypassed, so an injected
 *   transport can never be handed to a production call. This exists because the
 *   only honest assertion about a route is on the request it EMITS — the SDK
 *   binds its transport at construction, so patching `globalThis.fetch`
 *   afterwards observes nothing and the request escapes to the network.
 * @returns {Promise<object>} ProviderResult
 */
export async function callAzureClaude({ topic, model, maxTokens, timeoutMs = 60000, systemPrompt = BRAINSTORM_SYSTEM_PROMPT, reasoningEffort = null, truncationRemedy = null, _clientOptions = null }) {
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const anthropic = _clientOptions
      ? await createAnthropicClient({ ...clientOptions(), ..._clientOptions })
      : await client();
    const request = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: topic }],
    };
    if (reasoningEffort) request.output_config = { effort: reasoningEffort };
    let response;
    try {
      response = await anthropic.messages.create(request, { signal: controller.signal });
    } catch (err) {
      // A deployment whose model predates effort (Sonnet/Haiku 4.5 reject it)
      // 400s on the field. Retry once without it rather than failing the whole
      // leg on a tuning hint — the same shape as the OpenAI adapter's
      // reasoning_effort fallback. Any other error propagates unchanged.
      if (!request.output_config || !isEffortRejection(err)) throw err;
      const { output_config: _dropped, ...bare } = request;
      response = await anthropic.messages.create(bare, { signal: controller.signal });
    }
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    // Anthropic returns a content-block array; join every text block rather
    // than reading [0], so a response split across blocks is not truncated by
    // the reader itself.
    const text = Array.isArray(response?.content)
      ? (response.content.filter(b => b?.type === 'text').map(b => b.text).join('') || null)
      : null;
    const usage = {
      inputTokens: response?.usage?.input_tokens ?? 0,
      outputTokens: response?.usage?.output_tokens ?? 0,
      // The thinking share WITHIN outputTokens (billed there already). READ,
      // never assumed: null when the route reports no count, never a
      // hardcoded 0 — a zero would claim "no thinking" on exactly the
      // truncated responses where the split is the diagnosis.
      thinkingTokens: readThinkingTokens(response?.usage),
    };
    const estimatedCostUsd = estimateCostUsd({
      modelId: model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    return {
      provider: 'azure-claude',
      ..._classifyCompletion({
        text,
        stopReason: response?.stop_reason ?? null,
        maxTokens,
        thinkingTokens: usage.thinkingTokens,
        truncationRemedy,
      }),
      httpStatus: null,
      usage,
      latencyMs,
      estimatedCostUsd,
    };
  } catch (err) {
    clearTimeout(timer);
    return classifyError({ err, latencyMs: Date.now() - startMs, signal: controller.signal, timeoutMs });
  }
}

/**
 * Map (text, stop_reason) → {state, text, errorMessage}. Same precedence as the
 * OpenAI and Gemini classifiers, against Anthropic's vocabulary: `refusal` is
 * this API's withheld-content signal, and `max_tokens` its length cap.
 *
 * Order is load-bearing: withheld first, then no-text `empty`, then a length
 * stop WITH text is `truncated` — never `success`. A fragment rendered beside a
 * complete answer reads as a finished peer view; the partial text is kept
 * because it is still worth reading, only the label was wrong.
 *
 * @param {{text: string|null, stopReason: string|null, maxTokens?: number|null,
 *          thinkingTokens?: number|null, truncationRemedy?: string|null}} args
 * @returns {{state: string, text: string|null, errorMessage: string|null}}
 */
export function _classifyCompletion({ text, stopReason, maxTokens = null, thinkingTokens = null, truncationRemedy = null }) {
  if (stopReason === 'refusal') {
    return { state: 'blocked', text: null, errorMessage: 'Content declined by the model (stop_reason: refusal)' };
  }
  if (!text || text.trim().length === 0) {
    return { state: 'empty', text: null, errorMessage: `Empty response (stop_reason: ${stopReason ?? 'unknown'})` };
  }
  if (stopReason === 'max_tokens') {
    return {
      state: 'truncated',
      text,
      errorMessage: truncatedMessage({ maxTokens, thinkingTokens, remedy: truncationRemedy }),
    };
  }
  return { state: 'success', text, errorMessage: null };
}

/** `usage.output_tokens_details.thinking_tokens`, or null when absent/unreadable. */
export function readThinkingTokens(usage) {
  const v = usage?.output_tokens_details?.thinking_tokens;
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/** A 400 naming the effort field — the only error the no-effort retry answers. */
function isEffortRejection(err) {
  const status = err?.status ?? err?.response?.status ?? null;
  return status === 400 && /effort|output_config/i.test(String(err?.message ?? ''));
}

function classifyError({ err, latencyMs, signal = null, timeoutMs = null }) {
  const base = {
    provider: 'azure-claude',
    text: null,
    usage: null,
    latencyMs,
    estimatedCostUsd: null,
  };

  // Signal-first: the adapter aborted on its own timeout, so `signal.aborted`
  // is authoritative regardless of how the SDK wrapped the rejection. Sniffing
  // the error shape alone read an OpenAI `APIUserAbortError` as `malformed`.
  if (isAbortFailure({ err, signal })) {
    return { ...base, state: 'timeout', errorMessage: abortMessage(timeoutMs), httpStatus: null };
  }

  const status = err?.status ?? err?.response?.status ?? null;
  if (status) {
    // Azure content filtering rejects at the request boundary rather than via
    // stop_reason, so the `blocked` state has to be recovered from the error.
    // Surfacing it as a generic 400 would tell the user to retry something the
    // filter will refuse identically every time.
    const msg = String(err?.message ?? '');
    if (status === 400 && /content[_ ]?filter|responsible ?ai|jailbreak/i.test(msg)) {
      return { ...base, state: 'blocked', errorMessage: `Blocked by the Azure content filter: ${msg}`, httpStatus: status };
    }
    return { ...base, state: 'http_error', errorMessage: msg || `HTTP ${status}`, httpStatus: status };
  }

  return {
    ...base,
    state: 'malformed',
    errorMessage: err?.message ?? 'Unknown adapter error',
    httpStatus: null,
  };
}
