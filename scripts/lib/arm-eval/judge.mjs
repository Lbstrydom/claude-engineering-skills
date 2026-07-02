/**
 * @fileoverview Blinded, order-randomized, double-pass rubric judge (D2 / §2 / §10.3).
 *
 * Plan: docs/plans/arm-eval-framework.md §2 ("the properly part"). Claude judges
 * a SESSION's arm outputs on a fixed rubric under the controls that make LLM-as-
 * judge defensible:
 *   - BLINDED: arm identity is hidden — outputs are presented as opaque labels
 *     (`output-1..N`) in a seeded, recorded order; the label→arm map is returned
 *     for POST-HOC unblinding but never sent to the model.
 *   - ORDER-RANDOMIZED: a seeded Fisher–Yates shuffle sets the presentation order
 *     (recorded via the seed → replayable) to kill position bias.
 *   - DOUBLE-PASS: the judge scores the set TWICE so the decision module can
 *     measure self-consistency (intra-judge variance vs between-arm spread).
 *   - INTENT dims honest: `architectural_coherence` + `repo_intent_fidelity` are
 *     scored ONLY when the D8 context pack is present; otherwise they are omitted
 *     from the ask and marked `unscored` (never fabricated).
 *
 * PURE orchestration — the model call is injected (`deps.callJudge`); the default
 * routes through the Anthropic client. Self-preference is guaranteed upstream
 * (experiments.mjs bars Claude arms), so Claude never judges its own output.
 *
 * @module scripts/lib/arm-eval/judge
 */

import { z } from 'zod';
import { rubricFor, RUBRIC_INTENT_DIMS } from './experiments.mjs';

// ── Deterministic seeded RNG (local — no cross-cluster import) ────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const out = arr.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The dimensions actually scored this session (intent dims dropped when no pack). */
export function scorableDimensions(experimentType, intentScorable) {
  const all = rubricFor(experimentType);
  if (intentScorable) return all;
  return all.filter((d) => !RUBRIC_INTENT_DIMS.includes(d));
}

/** Zod schema for ONE judge pass: a 1–5 integer per (label × scorable dimension).
 * Requires the labels to be an EXACT PERMUTATION of the expected set (audit R1
 * fbad4aa6): a length-N array of allowed labels alone would accept a duplicate +
 * omission (output-1 twice, output-2 missing) → a silently mis-scored arm. */
export function judgePassSchema(labels, dims) {
  const dimObj = {};
  for (const d of dims) dimObj[d] = z.number().int().min(1).max(5);
  const rowShape = { label: z.enum(labels), dims: z.object(dimObj) };
  return z.object({ scores: z.array(z.object(rowShape)).length(labels.length) })
    .superRefine((v, ctx) => {
      const seen = v.scores.map((r) => r.label);
      const uniq = new Set(seen);
      if (uniq.size !== labels.length || labels.some((l) => !uniq.has(l))) {
        ctx.addIssue({ code: 'custom', path: ['scores'], message: `scores must cover each label exactly once (got [${seen.join(', ')}])` });
      }
    });
}

/** Build the blinded judge prompt (arm identity never appears). */
export function buildJudgePrompt({ experimentType, blindOutputs, dims, contextPack }) {
  const rubricLines = dims.map((d) => `- ${d}`).join('\n');
  const outBlocks = blindOutputs.map((o) => `### ${o.label}\n${o.text}`).join('\n\n');
  return [
    `You are an impartial expert judge scoring ${blindOutputs.length} anonymized ${experimentType} outputs.`,
    `Score EACH output on EVERY rubric dimension, integer 1–5 (5 = best). Judge only quality; ignore length/style/formatting as signals of identity. Do NOT guess which model produced which output.`,
    contextPack ? `## Repository intent (score architectural_coherence + repo_intent_fidelity against THIS)\n${contextPack}` : '',
    `## Rubric dimensions\n${rubricLines}`,
    `## Outputs to score\n${outBlocks}`,
    `Return JSON: { "scores": [ { "label": "<output-N>", "dims": { ${dims.map((d) => `"${d}": <1-5>`).join(', ')} } }, … ] } — one entry per output.`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Judge one session's arm outputs (blinded, order-randomized, double-pass).
 *
 * @param {{
 *   experimentType: string,
 *   outputs: Array<{arm:string, outputHash:string, text:string}>,
 *   contextPack?: string|null,
 *   intentScorable?: boolean,
 *   seed?: number,
 *   deps?: { callJudge?: Function },
 * }} input
 * @returns {Promise<{ presentationOrder:string[], labelToArm:Record<string,string>,
 *   dims:string[], intentDims:'scored'|'unscored', passes:Array<Record<string,Record<string,number>>>,
 *   conformant:boolean, error:string|null }>}
 */
export async function judgeSession({ experimentType, outputs, contextPack = null, intentScorable = null, seed = 1, deps = {} }) {
  if (!Array.isArray(outputs) || outputs.length < 2) {
    throw new Error('judgeSession: need ≥2 arm outputs to rank');
  }
  const d = { callJudge: callJudgeDefault, ...deps };
  const scorable = intentScorable == null ? Boolean(contextPack) : intentScorable;
  const dims = scorableDimensions(experimentType, scorable);

  // Blind + order-randomize: seeded shuffle → opaque labels; keep the map internal.
  const shuffled = seededShuffle(outputs, seed);
  const blindOutputs = shuffled.map((o, i) => ({ label: `output-${i + 1}`, text: o.text }));
  const labelToArm = {};
  shuffled.forEach((o, i) => { labelToArm[`output-${i + 1}`] = o.arm; });
  const labels = blindOutputs.map((o) => o.label);
  const presentationOrder = labels.slice();
  const schema = judgePassSchema(labels, dims);
  const prompt = buildJudgePrompt({ experimentType, blindOutputs, dims, contextPack: scorable ? contextPack : null });

  const passes = [];
  for (let pass = 1; pass <= 2; pass++) {
    const res = await d.callJudge({ prompt, schema, labels, dims, pass });
    if (!res || !res.conformant || !res.result) {
      return { presentationOrder, labelToArm, dims, intentDims: scorable ? 'scored' : 'unscored', passes, conformant: false, error: res?.error || `judge pass ${pass} non-conformant` };
    }
    // Fold into label→dims→score.
    const byLabel = {};
    for (const row of res.result.scores) byLabel[row.label] = row.dims;
    passes.push(byLabel);
  }
  return { presentationOrder, labelToArm, dims, intentDims: scorable ? 'scored' : 'unscored', passes, conformant: true, error: null };
}

/** Extract the first BALANCED top-level JSON object from a model response
 * (Gemini gate fix): a greedy `/\{[\s\S]*\}/` over-captures when prose with
 * braces trails the JSON. Scans for the first `{` and its matching `}` (string-
 * and escape-aware). Returns the substring or null. */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null; // unbalanced
}

/** Production judge: Claude via the Anthropic client, JSON-validated with the schema. */
async function callJudgeDefault({ prompt, schema }) {
  const start = Date.now();
  try {
    // Egress gate (audit R1 7c8737ee/f38a8cee — §10.4): the prompt carries the
    // arm outputs + repo-intent pack; scan the outbound payload BEFORE the wire
    // call so a secret that slipped past redaction aborts loudly, never egresses.
    const { assertEgressSafe } = await import('../sensitive-egress-gate.mjs');
    assertEgressSafe(prompt, { label: 'arm-eval:judge' });
    const { createAnthropicClient } = await import('../anthropic-client.mjs');
    const { resolveModel } = await import('../model-resolver.mjs');
    const client = await createAnthropicClient();
    const resp = await client.messages.create({
      model: resolveModel('latest-opus', { silent: true }),
      max_tokens: 4000,
      system: 'You are an impartial, calibrated judge. Return ONLY the requested JSON object — no prose.',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (resp?.content || []).map((b) => b.text || '').join('');
    const jsonStr = extractJsonObject(text);
    if (!jsonStr) return { conformant: false, result: null, error: 'judge returned no JSON', latencyMs: Date.now() - start };
    const parsed = JSON.parse(jsonStr);
    const v = schema.safeParse(parsed);
    if (!v.success) return { conformant: false, result: null, error: `judge JSON invalid: ${v.error.issues.slice(0, 2).map((i) => i.message).join('; ')}`, latencyMs: Date.now() - start };
    return { conformant: true, result: v.data, error: null, latencyMs: Date.now() - start };
  } catch (err) {
    // An egress-gate refusal MUST surface loudly — never degrade a secret-carrying
    // payload into a benign "non-conformant" result (mirrors the shadow's rule).
    if (err && typeof err.message === 'string' && err.message.includes('[egress-gate]')) throw err;
    return { conformant: false, result: null, error: err.message, latencyMs: Date.now() - start };
  }
}
