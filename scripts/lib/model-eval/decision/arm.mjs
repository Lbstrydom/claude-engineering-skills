/**
 * @fileoverview One arm call for the decision-eval: build the held-equal
 * request, call through an injected sdk-backend client, capture usage /
 * latency / served model / raw content, and classify the outcome.
 *
 * Plan: docs/plans/fable-vs-opus-decision-eval.md §2.2 "Arms", §C5.
 *
 * Held equal across arms: system prompt, user message, `max_tokens`,
 * `output_config.effort`. Deliberately ABSENT: `thinking` (adaptive and always
 * on for both; any explicit config other than adaptive 400s), `temperature`
 * (400 on both), `fallbacks` (a server-side fallback would let a DIFFERENT
 * model answer under this arm's name), `cache_control` (reps must be
 * independent draws).
 *
 * @module scripts/lib/model-eval/decision/arm
 */

import { sha256Canonical } from './corpus.mjs';

export const ARM_SYSTEM_PROMPT = [
  'You are the coordinating engineer for a set of related software repositories.',
  'You are given excerpts of code, documents, logs and claims as they stood when a decision had to be made, and the question that had to be answered.',
  'Reason from the evidence provided. Say what the evidence does and does not establish, and what you would check or do next.',
  'End your answer with a section headed exactly "## Decision" that states your conclusion and the evidence it rests on.',
].join(' ');

export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_EFFORT = 'high';

/** The user turn: context then question. Pure. */
export function buildArmUserMessage(c) {
  return `# Context\n\n${c.context}\n\n# Question\n\n${c.question}\n`;
}

/** Hash of the arm prompt TEMPLATE (system + user scaffold), for the manifest. */
export function armPromptHash() {
  return sha256Canonical(`${ARM_SYSTEM_PROMPT}\n---\n${buildArmUserMessage({ context: '{{context}}', question: '{{question}}' })}`);
}

/** The exact request body. Pure. */
export function buildArmRequest({ model, c, effort = DEFAULT_EFFORT, maxTokens = DEFAULT_MAX_TOKENS }) {
  return {
    model,
    max_tokens: maxTokens,
    system: ARM_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildArmUserMessage(c) }],
    output_config: { effort },
  };
}

/** Strict input-token upper bound of the request (UTF-8 bytes; see meter.inputTokenUpperBound). */
export function requestInputBytes(req) {
  return Buffer.byteLength(req.system, 'utf8') + req.messages.reduce((n, m) => n + Buffer.byteLength(String(m.content), 'utf8'), 0);
}

/**
 * Find a thinking-token count in a usage object without assuming its field
 * name: the API reports one only on some responses. Returns
 * `{thinkingTokens:null, thinkingField:null}` when none is reported — never 0.
 */
export function findThinkingTokens(usage) {
  const walk = (obj, prefix) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (/thinking|reasoning/i.test(k) && Number.isFinite(v)) return { thinkingTokens: v, thinkingField: p };
      if (v && typeof v === 'object') { const r = walk(v, p); if (r) return r; }
    }
    return null;
  };
  return walk(usage, '') || { thinkingTokens: null, thinkingField: null };
}

/** Normalised usage record. Absent fields stay null (never coerced to 0). */
export function extractUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  const t = findThinkingTokens(usage);
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    thinkingTokens: t.thinkingTokens,
    thinkingField: t.thinkingField,
    thinkingReported: t.thinkingTokens != null,
  };
}

/** True when the served id is the requested one (exact, or that id plus a date
 * snapshot suffix `-YYYYMMDD`). A bare prefix match would accept a different
 * version: `claude-opus-5` would match `claude-opus-5-5` (audit R1 M6). */
export function servedModelMatches(requested, served) {
  return typeof served === 'string' && (served === requested || (served.startsWith(`${requested}-`) && /^\d{8}$/.test(served.slice(requested.length + 1))));
}

/**
 * Make one arm call. Never throws for a provider failure — returns a typed
 * outcome the runner records. Throws only for programming errors.
 *
 * @returns {Promise<{ status: 'ok'|'refusal'|'max_tokens'|'truncated-no-text'|'incomplete'|'arm-error'|'model-mismatch',
 *   request: object, responseModel: string|null, stopReason: string|null,
 *   stopDetails: object|null, text: string, thinkingBlocks: number,
 *   usageRaw: object|null, usage: object|null, latencyMs: number, error: string|null }>}
 */
export async function runArmCall({ client, model, c, effort, maxTokens, now = () => Date.now() }) {
  const request = buildArmRequest({ model, c, effort, maxTokens });
  const start = now();
  let resp;
  try {
    resp = await client.messages.create(request);
  } catch (err) {
    return {
      status: 'arm-error', request, responseModel: null, stopReason: null, stopDetails: null,
      text: '', thinkingBlocks: 0, usageRaw: null, usage: null, latencyMs: now() - start,
      error: `${err?.status ? `HTTP ${err.status}: ` : ''}${err?.message ?? String(err)}`,
    };
  }
  const latencyMs = now() - start;
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  const thinkingBlocks = blocks.filter((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking').length;
  const responseModel = typeof resp?.model === 'string' ? resp.model : null;
  const stopReason = resp?.stop_reason ?? null;
  let status = 'ok';
  if (!servedModelMatches(model, responseModel)) status = 'model-mismatch';
  else if (stopReason === 'refusal') status = 'refusal';
  // A budget spent entirely on thinking leaves NO text block: a truncation
  // defect, not an empty answer — never graded as q=0 (coordinator instrument
  // note, 2026-11-15; cf. #360's 64-token labeller). Excluded and counted.
  else if (stopReason === 'max_tokens' && !text.trim()) status = 'truncated-no-text';
  else if (stopReason === 'max_tokens') status = 'max_tokens';
  // Anything but a normal end of turn (context-window exhaustion, pause_turn, a
  // missing stop_reason, …) is not an `ok` answer: graded as-is like max_tokens,
  // but flagged under its own status so it is never counted as a clean call
  // (audit R1 H8).
  else if (stopReason !== 'end_turn') status = 'incomplete';
  return {
    status, request, responseModel, stopReason, stopDetails: resp?.stop_details ?? null,
    text, thinkingBlocks, usageRaw: resp?.usage ?? null, usage: extractUsage(resp?.usage),
    latencyMs, error: null,
  };
}
