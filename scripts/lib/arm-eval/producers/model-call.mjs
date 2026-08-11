import { normalizeGeminiUsage } from '../../gemini-usage.mjs';
/**
 * @fileoverview Shared free-text model dispatch for arm-eval producers.
 *
 * One source for the OSS→OpenRouter / GPT→Responses completion path so the plan
 * and brainstorm producers don't duplicate it (audit DRY). Free-text (not
 * structured) — a plan/brainstorm is prose. Returns `{ text, usage }`.
 *
 * @module scripts/lib/arm-eval/producers/model-call
 */

/** Classify a resolved model id to its provider transport. Load-bearing (audit
 * Gemini gate): a `/`-less id is NOT necessarily GPT — `latest-pro` resolves to
 * `gemini-*` (no slash), which must route to Google, not the OpenAI client. */
export function providerFor(resolved) {
  if (resolved.includes('/')) return 'oss';          // vendor/model → OpenRouter
  if (/^gemini[-.]/i.test(resolved)) return 'gemini'; // gemini-*/gemini-pro-latest → Google
  return 'gpt';                                        // gpt-*/o* → OpenAI Responses
}

/** @param {{model:string, system:string, userPrompt:string, maxTokens?:number}} args */
export async function callModelFreeText({ model, system, userPrompt, maxTokens = 16000 }) {
  const start = Date.now();
  const { resolveModel } = await import('../../model-resolver.mjs');
  const resolved = resolveModel(model, { silent: true });
  // Every branch records `reasoning_tokens`. Cost is unaffected — reasoning is
  // already inside output/completion tokens — but the SPLIT is what tells you
  // whether an arm spent its budget thinking instead of answering. arm-eval
  // exists to compare models, which is exactly the setting where a model that
  // reasons its budget away looks like a model with nothing to say. Learned the
  // hard way on the final-review bake-off, where a shadow reviewer read as
  // unproductive until the split was measured (67% reasoning).
  const provider = providerFor(resolved);

  if (provider === 'oss') {                            // OSS via OpenRouter
    const { createOpenRouterClient } = await import('../../openai-client.mjs');
    const client = await createOpenRouterClient();
    const resp = await client.chat.completions.create({ model: resolved, messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }], max_tokens: maxTokens });
    // usageMissing on EVERY branch, not only Gemini (audit M3). The `?? 0`
    // defaults turn absent telemetry into a measured zero; leaving two sibling
    // branches doing that while the third is honest is worse than uniform
    // silence, because a consumer cannot tell which zeros it may trust.
    const ossMissing = !resp.usage
      || typeof resp.usage.prompt_tokens !== 'number'
      || typeof resp.usage.completion_tokens !== 'number';
    return { text: resp?.choices?.[0]?.message?.content ?? '', resolved, usage: { input_tokens: resp.usage?.prompt_tokens ?? 0, output_tokens: resp.usage?.completion_tokens ?? 0, reasoning_tokens: resp.usage?.completion_tokens_details?.reasoning_tokens ?? 0, usageMissing: ossMissing, latency_ms: Date.now() - start } };
  }
  if (provider === 'gemini') {                         // Gemini via @google/genai
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const resp = await ai.models.generateContent({ model: resolved, contents: `${system}\n\n${userPrompt}`, config: { maxOutputTokens: maxTokens } });
    // `reasoning_tokens` is THIS module's established field name (every branch
    // records it — see the note above), so the oracle's `thinking_tokens` is
    // mapped onto it rather than renamed here. `output_tokens` now carries
    // BILLED output: candidates + thoughts, which Google bills together.
    const g = normalizeGeminiUsage(resp.usageMetadata);
    return { text: resp?.text ?? '', resolved, usage: { input_tokens: g.input_tokens, output_tokens: g.output_tokens, reasoning_tokens: g.thinking_tokens, usageMissing: g.usageMissing, latency_ms: Date.now() - start } };
  }
  const { createOpenAIClient } = await import('../../openai-client.mjs');   // GPT via Responses
  const client = await createOpenAIClient({ purpose: 'gpt' });
  const resp = await client.responses.create({ model: resolved, input: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }], max_output_tokens: maxTokens });
  const text = resp?.output_text ?? (resp?.output || []).map((o) => (o?.content || []).map((c) => c.text || '').join('')).join('');
  const gptMissing = !resp.usage
    || typeof resp.usage.input_tokens !== 'number'
    || typeof resp.usage.output_tokens !== 'number';
  return { text, resolved, usage: { input_tokens: resp.usage?.input_tokens ?? 0, output_tokens: resp.usage?.output_tokens ?? 0, reasoning_tokens: resp.usage?.output_tokens_details?.reasoning_tokens ?? 0, usageMissing: gptMissing, latency_ms: Date.now() - start } };
}
