/**
 * @fileoverview Blinded, cross-vendor rubric judge for the decision-eval.
 *
 * Plan: docs/plans/fable-vs-opus-decision-eval.md §2.2 "Judge", "Judge failure
 * taxonomy", §C4.
 *
 * - CROSS-VENDOR: a GPT model grades Claude arms, so neither arm is graded by
 *   its own vendor. The resolved model id is recorded per call.
 * - BLINDED: the judge sees the question, the rubric and ONE output — no arm
 *   label, model self-names scrubbed, thinking blocks never present.
 * - MECHANICAL QUOTE CHECK: every positive claim (key point hit, trap fallen
 *   into, decision correct) must quote the output; a quote that is not a
 *   normalised substring marks THAT item `unverified` — excluded from its
 *   denominator and counted, never flipped to a hit or a miss.
 * - FAILURE TAXONOMY (the arm-eval judge bug, fixed for this sibling too): a
 *   transport failure is `unmeasured:judge-transport`, a parse/coverage failure
 *   after one plain retry is `unmeasured:judge-malformed`. Neither is a score.
 *
 * @module scripts/lib/model-eval/decision/judge
 */

import { z } from 'zod';
import { sha256Canonical } from './corpus.mjs';
import { classifyLlmError } from '../../robustness.mjs';

export const JUDGE_SYSTEM = [
  'You are a strict, impartial grader of engineering decisions.',
  'You are given a question that was put to an engineer, a grading rubric written by someone who knows the correct outcome, and ONE response to grade.',
  'For every key point, decide whether the response makes that point (substance, not wording). For every trap, decide whether the response falls into it (asserts it or acts on it as its conclusion; merely mentioning it in order to reject it is NOT falling into it).',
  'Decide whether the response reaches the correct decision stated in the rubric.',
  'Every "hit": true, "fell": true and decision "value": true MUST carry "quote": a short passage copied VERBATIM from the response (8–300 characters) that shows it. Use "" when the value is false.',
  'Do not reward length, confidence or formatting. Do not guess who wrote the response.',
].join(' ');

export const DEFAULT_JUDGE_MAX_OUTPUT_TOKENS = 6000;
export const DEFAULT_JUDGE_REASONING = 'medium';
const MODEL_NAME_RE = /\b(claude|fable|opus|sonnet|haiku|mythos|anthropic)\b/gi;
const MIN_QUOTE_CHARS = 8;

/** Replace model / vendor self-names so the judge cannot unblind an arm. */
export function scrubModelNames(text) {
  return String(text ?? '').replace(MODEL_NAME_RE, '[model]');
}

/** Hash of the judge prompt TEMPLATE, for the manifest. */
export function judgePromptHash() {
  return sha256Canonical(`${JUDGE_SYSTEM}\n---\n${buildJudgeInput({
    c: { question: '{{q}}', rubric: { decision: '{{d}}', keyPoints: [{ id: 'kp1', text: '{{kp}}', weight: 1 }], traps: [{ id: 'trap1', text: '{{t}}' }] } },
    outputText: '{{output}}',
  })}`);
}

/** The judge's user turn. Pure; the output is scrubbed here, once. */
export function buildJudgeInput({ c, outputText }) {
  const kps = c.rubric.keyPoints.map((k) => `- ${k.id}: ${k.text}`).join('\n');
  const traps = c.rubric.traps.map((t) => `- ${t.id}: ${t.text}`).join('\n');
  return [
    `## Question put to the engineer\n${c.question}`,
    `## Correct decision (rubric)\n${c.rubric.decision}`,
    `## Key points\n${kps}`,
    `## Traps\n${traps}`,
    `## Response to grade\n<<<RESPONSE\n${scrubModelNames(outputText)}\nRESPONSE>>>`,
    'Grade every key point and every trap exactly once, by id.',
  ].join('\n\n');
}

/** Structured-output schema for one case (ids constrained to the rubric's). */
export function makeGradeSchema(c) {
  const kpIds = c.rubric.keyPoints.map((k) => k.id);
  const trapIds = c.rubric.traps.map((t) => t.id);
  return z.object({
    keyPoints: z.array(z.object({ id: z.enum(kpIds), hit: z.boolean(), quote: z.string() })),
    traps: z.array(z.object({ id: z.enum(trapIds), fell: z.boolean(), quote: z.string() })),
    decisionCorrect: z.object({ value: z.boolean(), quote: z.string() }),
    rationale: z.string(),
  });
}

/** Exact cover: each rubric id graded exactly once. Returns an error string or null. */
export function coverageError(c, g) {
  const check = (got, want, label) => {
    const ids = got.map((x) => x.id);
    if (ids.length !== want.length || new Set(ids).size !== ids.length || want.some((w) => !ids.includes(w))) {
      return `${label} must grade each of [${want.join(', ')}] exactly once (got [${ids.join(', ')}])`;
    }
    return null;
  };
  return check(g.keyPoints, c.rubric.keyPoints.map((k) => k.id), 'keyPoints')
    || check(g.traps, c.rubric.traps.map((t) => t.id), 'traps');
}

/** Normalise for quote matching: case, markdown emphasis/code marks, quotes, whitespace. */
export function normalizeForQuote(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `quote` is evidence drawn from `outputText`. */
export function quoteIsVerbatim(quote, outputText) {
  const q = normalizeForQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return normalizeForQuote(scrubModelNames(outputText)).includes(normalizeForQuote(scrubModelNames(quote)));
}

/**
 * Attach `verified` to every positive claim. A negative needs no quote and is
 * verified by construction (absence cannot be quoted — the double pass and the
 * human spot sample cover a judge that wrongly says "no").
 */
export function verifyQuotes(grade, outputText) {
  const v = (positive, quote) => (!positive ? true : quoteIsVerbatim(quote, outputText));
  return {
    keyPoints: grade.keyPoints.map((k) => ({ ...k, verified: v(k.hit, k.quote) })),
    traps: grade.traps.map((t) => ({ ...t, verified: v(t.fell, t.quote) })),
    decisionCorrect: { ...grade.decisionCorrect, verified: v(grade.decisionCorrect.value, grade.decisionCorrect.quote) },
    rationale: grade.rationale,
  };
}

/**
 * Grade one output once (one judge pass). Retries ONCE with the same prompt on
 * transport or malformed output; never feeds an error back into the prompt.
 *
 * @param {{ client: object, model: string, c: object, outputText: string,
 *   reasoningEffort?: string|null, maxOutputTokens?: number,
 *   zodTextFormat: Function, assertEgressSafe: Function, now?: Function,
 *   hooks?: { before?: Function, after?: Function } }} args
 * @returns {Promise<{status:'scored'|'unmeasured', reason:string|null, grade:object|null,
 *   attempts: Array<{usageRaw:object|null, latencyMs:number, error:string|null, rawText:string|null, served:boolean}>}>}
 */
export async function gradeOnce({ client, model, c, outputText, reasoningEffort = DEFAULT_JUDGE_REASONING, maxOutputTokens = DEFAULT_JUDGE_MAX_OUTPUT_TOKENS, zodTextFormat, assertEgressSafe, now = () => Date.now(), hooks = {} }) {
  const input = buildJudgeInput({ c, outputText });
  // Egress gate BEFORE the wire: a refusal propagates (it is a stop, not a grade).
  assertEgressSafe(`${JUDGE_SYSTEM}\n${input}`, { label: 'decision-eval:judge' });
  const schema = makeGradeSchema(c);
  const params = {
    model, instructions: JUDGE_SYSTEM, input,
    text: { format: zodTextFormat(schema, 'grade') },
    max_output_tokens: maxOutputTokens,
  };
  if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
  const attempts = [];
  let lastReason = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Metering hooks: `before` may throw BudgetStop (propagates); `after` settles
    // measured usage, or charges the worst case when none came back.
    // Bound = the WHOLE serialized request (instructions + input + the json-schema
    // format block + reasoning), not only the two strings (audit R1 H16).
    if (hooks.before) await hooks.before({ attempt, inputTokensMax: Buffer.byteLength(JSON.stringify(params), 'utf8'), maxOutputTokens });
    const start = now();
    let resp;
    try {
      resp = await client.responses.parse(params);
    } catch (err) {
      // The SDK's own parse/finish-reason errors mean the judge ANSWERED badly
      // (truncated, filtered, unparseable): malformed, not transport.
      const answeredBadly = /FinishReason|Parse|SyntaxError/i.test(err?.name || '') || err instanceof SyntaxError;
      const { retryable, category } = answeredBadly ? { retryable: true, category: 'malformed' } : classifyLlmError(err || {});
      attempts.push({ usageRaw: null, latencyMs: now() - start, error: `${answeredBadly ? 'judge output unparseable' : 'judge transport failure'} (${category}): ${err?.status ? `HTTP ${err.status}: ` : ''}${err?.message ?? String(err)}`, rawText: null, served: answeredBadly, errorCategory: category });
      if (hooks.after) await hooks.after({ usageRaw: null, responseModel: null, served: answeredBadly });
      lastReason = answeredBadly ? 'judge-malformed' : 'judge-transport';
      // A non-429 4xx (auth, bad request, unknown model) repeats on retry:
      // unmeasured at once (AGENTS.md: never retry a 4xx other than 429).
      if (!retryable) break;
      continue;
    }
    const rawText = typeof resp?.output_text === 'string' ? resp.output_text : null;
    const rec = { usageRaw: resp?.usage ?? null, latencyMs: now() - start, error: null, rawText, served: true, responseModel: resp?.model ?? null };
    if (hooks.after) await hooks.after({ usageRaw: rec.usageRaw, responseModel: rec.responseModel, served: true });
    const parsed = resp?.output_parsed;
    const v = parsed ? schema.safeParse(parsed) : null;
    const covErr = v?.success ? coverageError(c, v.data) : null;
    if (!v || !v.success || covErr) {
      rec.error = !parsed ? 'judge returned no parsed output' : (covErr || `judge output invalid: ${v.error.issues.slice(0, 2).map((i) => i.message).join('; ')}`);
      attempts.push(rec);
      lastReason = 'judge-malformed';
      continue;
    }
    attempts.push(rec);
    return { status: 'scored', reason: null, grade: verifyQuotes(v.data, outputText), attempts };
  }
  return { status: 'unmeasured', reason: lastReason, grade: null, attempts };
}
