/**
 * @fileoverview The gate-review and from-scratch Gemini adapters extracted from scripts/solo-control-audit.mjs (an
 * over-1000-line file that may not grow). Prompt shape, schemas and egress checks are unchanged.
 * @module scripts/lib/solo-control/gate-reviews
 */
import { buildToolUseRequest } from '../anthropic-tool-choice.mjs';
import { PASS_PROMPTS } from '../prompt-seeds.mjs';
import { ShadowPassSchema } from '../audit-shadow.mjs';
import { assertEgressSafe } from '../sensitive-egress-gate.mjs';
import { zodToOpenAiJsonSchema } from '../oss-structured-output.mjs';
import { normalizeGeminiUsage } from '../gemini-usage.mjs';
import { geminiFindingsOrMiss } from './hardening-guards.mjs';
import { REASONING_TIERS, clampToSchema } from './cold-pass-support.mjs';

/**
 * The ONE gate-review prompt builder — every gate candidate (Flash, Pro,
 * Sonnet-<effort>, ...) sends BYTE-IDENTICAL text for the same (collected,
 * diff), so the ablation compares gate MODELS, not prompt wording. Factored
 * out for the same reason as buildColdPassPrompt: a structural guarantee via
 * one shared function, not a maintained coincidence between two copies.
 */
export function buildGateReviewPrompt(collected, diff) {
  const priorList = collected.slice(0, 40).map((f) => `- [${f.severity}] ${f.category}: ${(f.detail || '').slice(0, 160)}`).join('\n');
  return [
    'You are the final-gate reviewer. Below are findings already raised by a prior audit.',
    'Emit ONLY NET-NEW findings the prior audit MISSED (do not restate). Return per the schema.',
    `## Prior findings\n${priorList || '(none)'}`,
    `## Subject under audit\n${diff}`,
  ].join('\n\n');
}

/** Gemini net-new review over the collected GPT findings (mirrors callGeminiDefault). */
export async function runGeminiReview(geminiModel, collected, diff) {
  if (!process.env.GEMINI_API_KEY) return { findings: [], skipped: 'no-key' };
  const { GoogleGenAI } = await import('@google/genai');
  const { zodToGeminiSchema } = await import('../schemas.mjs');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const prompt = buildGateReviewPrompt(collected, diff);
  assertEgressSafe(prompt, { label: 'apparatus:gemini' });
  const resp = await ai.models.generateContent({
    model: geminiModel, contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: zodToGeminiSchema(ShadowPassSchema) },
  });
  return { ...geminiFindingsOrMiss(resp.text, ShadowPassSchema), usage: geminiUsageOrNull(resp) };
}

/** Gemini's `usageMetadata` → the ledger's `{input_tokens, output_tokens}`,
 * or null when the provider reported nothing usable — never a fabricated 0,
 * which costFromUsage would price as FREE (the "always-null column reads as
 * free" defect). Reuses the shared normaliser so thoughts vs candidates are
 * billed the way Google bills them. */
export function geminiUsageOrNull(resp) {
  const g = normalizeGeminiUsage(resp?.usageMetadata);
  return g.usageMissing ? null : { input_tokens: g.input_tokens, output_tokens: g.output_tokens };
}

/**
 * Claude's gate-ablation counterpart to runGeminiReview — a third candidate
 * (Flash vs Pro vs Sonnet-<effort>) in the gate ablation, paired against the
 * SAME immutable pre-gate artifact and never ranked in decide() (plan §3
 * "Gate ablation (not a candidate)"). Mirrors runGeminiReview's prompt text
 * VERBATIM (same "emit only net-new" framing, same priorList/diff shape) so
 * the ablation compares GATE MODELS, not prompt wording — but uses Claude's
 * OWN structured-output mechanism (tool-use, forced where the model allows), matching how
 * runGeminiReview/runGptPass each use their model's best mechanism rather
 * than a shared lowest-common-denominator one. This is deliberately NOT the
 * buildColdPassPrompt fairness rule (that isolates the MODEL for the cold-
 * arm comparison); the gate ablation asks "which model, at its best, makes
 * a better gate", so each gate gets its native structured-output path.
 *
 * @param {import('@anthropic-ai/sdk').default} client - createAnthropicClient({backend:'sdk'})
 * @param {string} model - resolved Claude model id (e.g. claude-sonnet-5)
 * @param {Array} collected - the GPT 5-pass deduped union
 * @param {string} diff - the WHOLE diff under audit (the gate reads every chunk the passes ran on)
 * @param {{reasoningEffort?: keyof typeof REASONING_TIERS.anthropic}} [opts] - an
 *   Anthropic `output_config.effort` tier; `high` is the API default. max_tokens
 *   follows the tier (REASONING_TIERS) because thinking shares that budget.
 */
export async function runClaudeGateReview(client, model, collected, diff, { reasoningEffort = 'high' } = {}) {
  const prompt = buildGateReviewPrompt(collected, diff);
  assertEgressSafe(prompt, { label: 'apparatus:claude-gate' });
  // Opus 5.5 400s on forced tool_choice: auto + a SYSTEM instruction there keeps the user prompt byte-identical.
  const toolUse = buildToolUseRequest(model, { name: 'emit_findings', description: 'Return the net-new findings.', input_schema: zodToOpenAiJsonSchema(ShadowPassSchema) });
  const params = {
    model, max_tokens: REASONING_TIERS.anthropic[reasoningEffort] ?? 8000,
    messages: [{ role: 'user', content: prompt }], tools: toolUse.tools, tool_choice: toolUse.tool_choice,
    ...(toolUse.instruction ? { system: toolUse.instruction } : {}),
  };
  if (reasoningEffort) params.output_config = { effort: reasoningEffort };

  // A gate that did not review is provider-error (commit reads partial), never a clean `{findings: []}`.
  let resp;
  try { resp = await client.messages.create(params, { timeoutMs: 300000 }); }
  catch (err) { return { findings: [], usage: null, state: 'provider-error', error: String(err?.message || err).slice(0, 160) }; }
  const usage = resp.usage || null;
  if (resp.stop_reason === 'refusal') return { findings: [], usage, state: 'provider-error', error: 'refusal (stop_reason: refusal)' };
  const call = Array.isArray(resp.content) ? resp.content.find((c) => c.type === 'tool_use') : null;
  if (!call) return { findings: [], usage, state: 'provider-error', error: `no emit_findings tool call (stop_reason: ${resp.stop_reason ?? 'unknown'})` };
  const check = ShadowPassSchema.safeParse(clampToSchema(call.input ?? null));
  return check.success ? { findings: check.data.findings, usage, state: 'ok' } : { findings: [], usage, state: 'conformance-miss' };
}

/**
 * GPT's gate-ablation counterpart (fourth candidate: Flash / Pro / Sonnet-xhigh /
 * Sol-high) — same shared prompt, GPT's own structured-output mechanism
 * (Responses API + zodTextFormat, exactly what runGptPass uses for the 5-pass).
 * The whole prompt goes as ONE user input item so the text the model sees is
 * byte-identical to what the Gemini and Claude gates see.
 * @param {import('openai').OpenAI} client - the same `purpose:'gpt'` client the 5-pass uses
 */
export async function runGptGateReview(client, zodTextFormat, model, collected, diff, { reasoningEffort = 'high' } = {}) {
  const prompt = buildGateReviewPrompt(collected, diff);
  assertEgressSafe(prompt, { label: 'apparatus:gpt-gate' });
  const params = {
    model,
    input: [{ role: 'user', content: prompt }],
    text: { format: zodTextFormat(ShadowPassSchema, 'shadow_pass') },
    max_output_tokens: REASONING_TIERS.openai[reasoningEffort] ?? 8000,
  };
  if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
  const resp = await client.responses.parse(params);
  return { findings: resp.output_parsed?.findings || [], usage: resp.usage || null, ...(resp.output_parsed ? {} : { state: 'conformance-miss' }) };
}

/** Gemini as a FROM-SCRATCH generator — same open-ended "audit this diff" task
 * and prompt shape as runGptPass/runOssPass (PASS_PROMPTS system + the diff,
 * no prior findings to react to). Everywhere else in this experiment Gemini
 * only ever did the easier "find what's missing from this list" job
 * (runGeminiReview above) — this is the missing apples-to-apples comparison:
 * is Gemini actually a better cold auditor than GPT, or does it only look
 * clean because it always got the constrained review task? */
export async function runGeminiPass(geminiModel, passName, diff) {
  if (!process.env.GEMINI_API_KEY) return { findings: [], skipped: 'no-key' };
  const { GoogleGenAI } = await import('@google/genai');
  const { zodToGeminiSchema } = await import('../schemas.mjs');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const system = PASS_PROMPTS[passName] || `Audit the code for ${passName} issues.`;
  const userPrompt = [
    `## Task\nAudit the code below for the "${passName}" concern. Return findings per the schema.`,
    `## Code (redacted)\n${diff}`,
  ].join('\n\n');
  const prompt = `${system}\n\n${userPrompt}`;
  assertEgressSafe(prompt, { label: `gemini-solo:${passName}` });
  const resp = await ai.models.generateContent({
    model: geminiModel, contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: zodToGeminiSchema(ShadowPassSchema) },
  });
  return { ...geminiFindingsOrMiss(resp.text, ShadowPassSchema), usage: geminiUsageOrNull(resp) };
}
