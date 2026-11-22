/**
 * @fileoverview The DEFAULT model providers for the step-back reviewer, built
 * lazily so importing the contract never constructs a client. A provider is
 * `({system, user, model}) => Promise<{text, usage: {input_tokens, output_tokens}}>`.
 * Both take model SENTINELS (`latest-gpt`, `latest-pro`), never concrete ids.
 *
 * `same` = the auditor's own family via the existing OpenAI client seam;
 * `different` = Google's latest pro via the shared Gemini client;
 * `higher` = `latest-opus` via the Anthropic seam, PINNED to `{backend:'sdk'}` because it
 * carries a `system` prompt (the cli backend serves model/max_tokens/messages only) and
 * gated on `isClaudeAvailableFor('sdk')` (via `claudeAvailability`): unavailable means
 * the provider reports `unmeasuredReason` and is never called, never a cli fallback.
 * None is ever constructed in tests — they take an injectable client for that.
 *
 * Every call result carries `truncated` (the reply hit the output cap): an INSTRUMENT
 * failure, never an invalid model answer.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-provider
 */
import { resolveModel } from '../model-resolver.mjs';
import { normalizeGeminiUsage, isCount } from '../gemini-usage.mjs';
import { claudeAvailability, createAnthropicClient } from '../anthropic-client.mjs';

export const STEP_BACK_ARM_MODELS = Object.freeze({ same: 'latest-gpt', different: 'latest-pro', higher: 'latest-opus' });
export const STEP_BACK_MAX_OUTPUT_TOKENS = 4000;
/** Gemini thinking is fixed, not left to the model: it bills as output and shares maxOutputTokens, so an unset budget ate the answer (v1 defect). */
export const STEP_BACK_GEMINI_THINKING_BUDGET = 3000;
/** maxOutputTokens for Gemini covers the thinking budget PLUS the answer, so it is also the real output ceiling. */
export const STEP_BACK_GEMINI_MAX_OUTPUT_TOKENS = STEP_BACK_GEMINI_THINKING_BUDGET + STEP_BACK_MAX_OUTPUT_TOKENS;

/** Usage with BOTH counts present and numeric, else `usageMissing: true` (the call is then charged its upper bound, never $0). */
function usageOf(inTok, outTok) {
  const ok = isCount(inTok) && isCount(outTok);
  return { input_tokens: isCount(inTok) ? inTok : 0, output_tokens: isCount(outTok) ? outTok : 0, usageMissing: !ok };
}

/**
 * @param {'same'|'different'|'higher'} arm
 * @param {{client?: object, resolve?: Function, createClient?: Function, sdkAvailability?: () => {available: boolean, error: string|null}}} [seams]
 * @returns {{model: string, sentinel: string, call: Function, outputCeilingTokens: number, unmeasuredReason?: string}}
 */
export function createStepBackProvider(arm = 'same', { client = null, resolve = resolveModel, createClient = createAnthropicClient, sdkAvailability = () => claudeAvailability('sdk') } = {}) {
  const sentinel = STEP_BACK_ARM_MODELS[arm];
  if (!sentinel) throw new Error(`createStepBackProvider: unknown arm "${arm}" (same|different|higher)`);
  const model = resolve(sentinel);
  if (arm === 'same') {
    return {
      model, sentinel, outputCeilingTokens: STEP_BACK_MAX_OUTPUT_TOKENS,
      call: async ({ system, user }) => {
        const c = client || await (await import('../openai-client.mjs')).createOpenAIClient({ purpose: 'gpt' });
        const r = await c.responses.create({ model, instructions: system, input: user, max_output_tokens: STEP_BACK_MAX_OUTPUT_TOKENS });
        const truncated = r.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens';
        // Any other non-success response is an INSTRUMENT failure, never parsed as a model decision.
        let failure = null;
        if (r.status === 'incomplete' && !truncated) failure = `OpenAI incomplete: ${r.incomplete_details?.reason ?? 'unknown reason'}`;
        else if (r.status && r.status !== 'completed' && r.status !== 'incomplete') failure = `OpenAI status ${r.status}${r.error?.message ? `: ${r.error.message}` : ''}`;
        return { text: r.output_text ?? '', truncated, failure, usage: usageOf(r.usage?.input_tokens, r.usage?.output_tokens) };
      },
    };
  }
  if (arm === 'higher') {
    // A call with `system` must pin sdk; unavailable => unmeasured with the reason, NEVER a cli fallback.
    const avail = sdkAvailability();
    const base = { model, sentinel, outputCeilingTokens: STEP_BACK_MAX_OUTPUT_TOKENS };
    if (!avail.available) {
      const reason = `sdk backend unavailable${avail.error ? ` (${avail.error})` : ' (no ANTHROPIC_API_KEY or Claude route)'}`;
      return { ...base, unmeasuredReason: reason, call: async () => { throw new Error(`higher arm: ${reason}`); } };
    }
    return {
      ...base,
      call: async ({ system, user }) => {
        const c = client || await createClient({ backend: 'sdk' });
        const r = await c.messages.create({ model, max_tokens: STEP_BACK_MAX_OUTPUT_TOKENS, system, messages: [{ role: 'user', content: user }] });
        const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        const truncated = r.stop_reason === 'max_tokens';
        const failure = truncated || r.stop_reason === 'end_turn' ? null : `Anthropic stop_reason ${r.stop_reason ?? 'absent'} (not end_turn)`;
        return { text, truncated, failure, usage: usageOf(r.usage?.input_tokens, r.usage?.output_tokens) };
      },
    };
  }
  return {
    model, sentinel, outputCeilingTokens: STEP_BACK_GEMINI_MAX_OUTPUT_TOKENS,
    call: async ({ system, user }) => {
      const ai = client || await (await import('../llm-wrappers.mjs')).getGeminiClient();
      if (!ai) throw new Error('no Gemini route (GEMINI_API_KEY unset)');
      const r = await ai.models.generateContent({ model, contents: user, config: {
        systemInstruction: system, maxOutputTokens: STEP_BACK_GEMINI_MAX_OUTPUT_TOKENS, responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: STEP_BACK_GEMINI_THINKING_BUDGET, includeThoughts: false },
      } });
      const u = normalizeGeminiUsage(r.usageMetadata);
      const fin = r.candidates?.[0]?.finishReason;
      const truncated = fin === 'MAX_TOKENS';
      let failure = null;
      if (r.promptFeedback?.blockReason) failure = `Gemini blocked the prompt: ${r.promptFeedback.blockReason}`;
      else if (!r.candidates?.length) failure = 'Gemini returned an empty candidate list';
      else if (fin !== undefined && fin !== 'STOP' && fin !== 'MAX_TOKENS') failure = `Gemini finishReason ${fin}`;
      return { text: r.text ?? '', truncated, failure, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, usageMissing: u.usageMissing } };
    },
  };
}
