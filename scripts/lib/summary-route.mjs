/**
 * @fileoverview Which model writes the arch-index symbol summaries — the ONE
 * answer, shared by the summariser (`symbol-index/summarise.mjs`) and by any
 * consumer preflight that needs to ask "will the summariser actually run?".
 *
 * Three routes:
 *   - `anthropic`    — public profile (no Azure). Claude via `createAnthropicClient()`
 *                      (sdk / cli / bedrock — whatever the ambient backend is).
 *   - `azure-gpt`    — Azure work profile, DEFAULT. The GPT deployment the
 *                      profile already requires (`AZURE_OPENAI_GPT_DEPLOYMENT`),
 *                      over the same `AZURE_OPENAI_API_KEY`.
 *   - `azure-claude` — Azure work profile with `AZURE_SUMMARY_BACKEND=claude`:
 *                      Claude on Foundry (`AZURE_FOUNDRY_SUMMARY_DEPLOYMENT`).
 *
 * WHY GPT IS THE AZURE DEFAULT (measured 2026-11-27, a consumer's 50 real
 * symbols through the tenant's GPT deployment with this module's prompt): 50/50
 * summaries in 16 s. The Foundry-Claude route needs a SEPARATE Foundry key
 * (`AZURE_AI_API_KEY`); without one it falls back to the Azure OpenAI key and
 * every batch 401s — 0 of 4920 symbols summarised, every week, on a consumer
 * whose profile was otherwise complete. The GPT route needs nothing the Azure
 * profile does not already require (`buildAzureConfig` refuses `active`
 * without a key and a GPT deployment), so on Azure it is available by
 * construction. Claude stays one switch away for a tenant that has the key.
 *
 * The public profile is unchanged.
 */
import { azureConfig as defaultAzureConfig } from './config.mjs';
import { isClaudeAvailable } from './anthropic-client.mjs';
import { redactSecrets } from './sanitizer.mjs';

export const SUMMARY_BACKENDS = Object.freeze(['gpt', 'claude']);

/**
 * @param {object} [options]
 * @param {object} [options.azure] azureConfig snapshot (tests inject one)
 * @param {Record<string,string|undefined>} [options.env]
 * @returns {{kind: 'anthropic'|'azure-gpt'|'azure-claude', model: string|null}}
 */
export function resolveSummaryRoute(options = {}) {
  const azure = options.azure || defaultAzureConfig;
  const env = options.env || process.env;
  if (!azure.active) return { kind: 'anthropic', model: null };
  const raw = (env.AZURE_SUMMARY_BACKEND || '').trim().toLowerCase();
  const backend = raw || 'gpt';
  if (!SUMMARY_BACKENDS.includes(backend)) {
    // A typo must not silently pick a route: fail loud, naming the valid values.
    throw new Error(
      `[summary-route] Invalid AZURE_SUMMARY_BACKEND="${env.AZURE_SUMMARY_BACKEND}". `
      + `Valid: ${SUMMARY_BACKENDS.join(', ')} (default gpt).`,
    );
  }
  if (backend === 'claude') return { kind: 'azure-claude', model: azure.summaryDeployment };
  return { kind: 'azure-gpt', model: azure.gptDeployment };
}

/**
 * Will the summariser run? The single availability oracle for it — a question
 * about the ROUTE, never about a public env var (AGENTS.md, Anthropic Backend
 * Routing / Azure Work Profile).
 *
 * @param {object} [options] same as resolveSummaryRoute, plus
 * @param {() => boolean} [options.claudeAvailable] injected for tests
 * @returns {{available: boolean, route: string|null, reason: string|null}}
 */
export function summariserAvailability(options = {}) {
  let route;
  try {
    route = resolveSummaryRoute(options);
  } catch (err) {
    // `configError` is distinct from "no provider": a typo is the operator's
    // mistake and must stop the run (callers call resolveSummaryRoute() up
    // front, which throws), never degrade to a corpus of null summaries.
    return { available: false, route: null, reason: String(err?.message || err), configError: true };
  }
  const azure = options.azure || defaultAzureConfig;
  if (route.kind === 'azure-gpt') {
    if (route.model) return { available: true, route: route.kind, reason: null };
    return { available: false, route: route.kind, reason: 'Azure profile active but no GPT deployment resolved' };
  }
  if (route.kind === 'azure-claude') {
    if (azure.claudeRoute && route.model) return { available: true, route: route.kind, reason: null };
    return { available: false, route: route.kind, reason: 'AZURE_SUMMARY_BACKEND=claude but no Foundry Claude route/deployment is configured' };
  }
  const claude = options.claudeAvailable || isClaudeAvailable;
  if (claude()) return { available: true, route: route.kind, reason: null };
  return {
    available: false,
    route: route.kind,
    reason: 'no Claude provider (set ANTHROPIC_API_KEY, CLAUDE_BACKEND=cli, or the Azure work profile)',
  };
}

/**
 * Map a provider's stop signal onto the one the completeness verdict reads.
 * GPT says `finish_reason: 'length'` where Claude says `stop_reason: 'max_tokens'`;
 * both mean the answer was cut at the ceiling.
 * @param {string|null|undefined} reason
 * @returns {string|undefined}
 */
export function normaliseStopReason(reason) {
  if (reason === 'length') return 'max_tokens';
  return reason ?? undefined;
}

/**
 * The Azure GPT summary call, normalised to `{text, stopReason}`. Lives here,
 * not in the summariser, so the file that constructs an Anthropic client never
 * also issues an OpenAI-shaped request (the Anthropic pin census reads the two
 * as one unpinned Claude call).
 *
 * Reasoning models spend part of `max_completion_tokens` on thinking, so the
 * budget is floored at GPT_MIN_COMPLETION_TOKENS: the summariser re-asks a cut
 * batch in halves down to ONE symbol, and a per-symbol budget (256) alone
 * could leave a single-symbol re-ask cut forever on a model that thinks first.
 * A cut is DETECTED (`length` → `max_tokens`).
 *
 * A `content_filter` stop THROWS (code FILTERED): its partial text can look
 * like a valid summary, so it is a provider failure, never an answer.
 *
 * @param {{model: string|null}} route
 * @param {string} prompt
 * @param {number} maxTokens
 * @param {object} [client] injected OpenAI-compatible client (tests)
 * @returns {Promise<{text: string, stopReason: string|undefined,
 *   usage: {inputTokens: number, outputTokens: number}|null}>}
 *   `usage: null` when the provider reported none — never a fabricated zero.
 */
export const GPT_MIN_COMPLETION_TOKENS = 2048;

export async function callAzureGptSummary(route, prompt, maxTokens, client, { signal } = {}) {
  const c = client || await (await import('./openai-client.mjs')).createOpenAIClient({ purpose: 'gpt' });
  const res = await c.chat.completions.create({
    model: route.model,
    max_completion_tokens: Math.max(GPT_MIN_COMPLETION_TOKENS, Number(maxTokens) || 0),
    // EGRESS: the WHOLE prompt passes the same shape-based redactor the
    // Anthropic client applies to every message by default — symbol names and
    // file paths are interpolated into it, not only the (already redacted)
    // bodies, and this transport has no redaction layer of its own.
    messages: [{ role: 'user', content: redactSecrets(String(prompt)) }],
  }, signal ? { signal } : undefined);
  const choice = res.choices?.[0];
  if (choice?.finish_reason === 'content_filter') {
    const e = new Error('Azure GPT stopped on its content filter — the partial text is not a summary');
    e.code = 'FILTERED';
    throw e;
  }
  const u = res.usage;
  const usage = u && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens)
    ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
    : null;
  return { text: choice?.message?.content || '', stopReason: normaliseStopReason(choice?.finish_reason), usage };
}
