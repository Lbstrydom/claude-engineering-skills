/**
 * @fileoverview The DEFAULT model providers for the step-back reviewer, built
 * lazily so importing the contract never constructs a client. A provider is
 * `({system, user, model}) => Promise<{text, usage: {input_tokens, output_tokens}}>`.
 * Both take model SENTINELS (`latest-gpt`, `latest-pro`), never concrete ids.
 *
 * `same` = the auditor's own family via the existing OpenAI client seam;
 * `different` = Google's latest pro via the shared Gemini client. Neither is
 * ever constructed in tests — they take an injectable client for that.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-provider
 */
import { resolveModel } from '../model-resolver.mjs';

export const STEP_BACK_ARM_MODELS = Object.freeze({ same: 'latest-gpt', different: 'latest-pro' });
export const STEP_BACK_MAX_OUTPUT_TOKENS = 4000;

/**
 * @param {'same'|'different'} arm
 * @param {{client?: object, resolve?: Function}} [seams]
 * @returns {{model: string, sentinel: string, call: Function}}
 */
export function createStepBackProvider(arm = 'same', { client = null, resolve = resolveModel } = {}) {
  const sentinel = STEP_BACK_ARM_MODELS[arm];
  if (!sentinel) throw new Error(`createStepBackProvider: unknown arm "${arm}" (same|different)`);
  const model = resolve(sentinel);
  if (arm === 'same') {
    return {
      model, sentinel, outputCeilingTokens: STEP_BACK_MAX_OUTPUT_TOKENS,
      call: async ({ system, user }) => {
        const c = client || await (await import('../openai-client.mjs')).createOpenAIClient({ purpose: 'gpt' });
        const r = await c.responses.create({ model, instructions: system, input: user, max_output_tokens: STEP_BACK_MAX_OUTPUT_TOKENS });
        return { text: r.output_text ?? '', usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0, usageMissing: !r.usage } };
      },
    };
  }
  return {
    // Gemini thinking tokens are billed as output and are not bounded by maxOutputTokens: budget a 4x ceiling.
    model, sentinel, outputCeilingTokens: STEP_BACK_MAX_OUTPUT_TOKENS * 4,
    call: async ({ system, user }) => {
      const ai = client || await (await import('../llm-wrappers.mjs')).getGeminiClient();
      if (!ai) throw new Error('no Gemini route (GEMINI_API_KEY unset)');
      const { normalizeGeminiUsage } = await import('../gemini-usage.mjs');
      const r = await ai.models.generateContent({ model, contents: user, config: { systemInstruction: system, maxOutputTokens: STEP_BACK_MAX_OUTPUT_TOKENS, responseMimeType: 'application/json' } });
      const u = normalizeGeminiUsage(r.usageMetadata);
      return { text: r.text ?? '', usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, usageMissing: u.usageMissing } };
    },
  };
}
