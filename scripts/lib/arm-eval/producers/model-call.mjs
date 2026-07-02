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
  const provider = providerFor(resolved);

  if (provider === 'oss') {                            // OSS via OpenRouter
    const { createOpenAIClient } = await import('../../openai-client.mjs');
    const { auditShadowConfig } = await import('../../config.mjs');
    const client = await createOpenAIClient({ oss: { baseURL: auditShadowConfig.openrouterBaseUrl, apiKey: auditShadowConfig.openrouterApiKey } });
    const resp = await client.chat.completions.create({ model: resolved, messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }], max_tokens: maxTokens });
    return { text: resp?.choices?.[0]?.message?.content ?? '', usage: { input_tokens: resp.usage?.prompt_tokens ?? 0, output_tokens: resp.usage?.completion_tokens ?? 0, latency_ms: Date.now() - start } };
  }
  if (provider === 'gemini') {                         // Gemini via @google/genai
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const resp = await ai.models.generateContent({ model: resolved, contents: `${system}\n\n${userPrompt}`, config: { maxOutputTokens: maxTokens } });
    return { text: resp?.text ?? '', usage: { input_tokens: resp.usageMetadata?.promptTokenCount ?? 0, output_tokens: resp.usageMetadata?.candidatesTokenCount ?? 0, latency_ms: Date.now() - start } };
  }
  const { createOpenAIClient } = await import('../../openai-client.mjs');   // GPT via Responses
  const client = await createOpenAIClient({ purpose: 'gpt' });
  const resp = await client.responses.create({ model: resolved, input: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }], max_output_tokens: maxTokens });
  const text = resp?.output_text ?? (resp?.output || []).map((o) => (o?.content || []).map((c) => c.text || '').join('')).join('');
  return { text, usage: { input_tokens: resp.usage?.input_tokens ?? 0, output_tokens: resp.usage?.output_tokens ?? 0, latency_ms: Date.now() - start } };
}
