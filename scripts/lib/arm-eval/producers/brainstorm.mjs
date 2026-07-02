/**
 * @fileoverview Headless brainstorm producer (§10.2 / D4).
 *
 * Plan: docs/plans/arm-eval-framework.md D4. An arm is a two-model COMBINATION
 * (e.g. D=GPT+Gemini, E=GLM+Gemini, F=GLM+GPT). Each model answers the topic,
 * then a FIXED, model-neutral synthesis prompt (run by the arm's OWN first model
 * — never Claude, which is the judge) merges them into the arm's take. Egress-
 * gated; PURE orchestration with an injectable model call.
 *
 * @module scripts/lib/arm-eval/producers/brainstorm
 */

import { createHash } from 'node:crypto';

function hashText(t) { return createHash('sha256').update(t || '').digest('hex').slice(0, 16); }

const BRAINSTORM_SYSTEM = 'You are an expert brainstorming partner. Give a concrete, insightful, actionable take on the topic — diverse angles, honest trade-offs. Do NOT identify your model/provider (the take is judged blind).';
const SYNTH_SYSTEM = 'You are synthesizing two independent takes into ONE sharper combined take: keep the strongest ideas, reconcile disagreements explicitly, drop the weak. Do NOT identify any model/provider.';

/**
 * Produce one arm's synthesized brainstorm take for a topic.
 * @param {{ topic:string, arm:object, deps?:{callModel?:Function} }} input
 */
export async function produceBrainstorm({ topic, arm, deps = {} }) {
  if (typeof topic !== 'string' || !topic.trim()) throw new Error('produceBrainstorm: topic must be a non-empty string');
  if (!arm || !Array.isArray(arm.models) || arm.models.length < 2) throw new Error('produceBrainstorm: a brainstorm arm needs ≥2 models (a combination)');
  const d = { callModel: callModelDefault, ...deps };
  const [m1, m2] = arm.models;

  const { assertEgressSafe } = await import('../../sensitive-egress-gate.mjs');
  assertEgressSafe([BRAINSTORM_SYSTEM, topic], { label: `arm-eval:brainstorm:${arm.id}` });

  let takes;
  try {
    takes = await Promise.all([
      d.callModel({ model: m1, system: BRAINSTORM_SYSTEM, userPrompt: `## Topic\n${topic}` }),
      d.callModel({ model: m2, system: BRAINSTORM_SYSTEM, userPrompt: `## Topic\n${topic}` }),
    ]);
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('[egress-gate]')) throw err;
    return { output: null, outputHash: null, conformant: false, resolvedModels: [m1, m2], usage: null, error: err.message };
  }
  const [t1, t2] = takes.map((t) => t?.text ?? '');
  // BOTH legs must produce a take (Gemini gate fix): a combination arm's value is
  // the two models together — synthesizing from one empty leg is a degraded
  // single-model result masquerading as the combination. Fail-closed if either
  // leg is empty (counts against the arm's conformance rate).
  if (!t1.trim() || !t2.trim()) {
    return { output: null, outputHash: null, conformant: false, resolvedModels: [m1, m2], usage: null, error: `combination leg empty (m1:${t1.trim() ? 'ok' : 'empty'}, m2:${t2.trim() ? 'ok' : 'empty'})` };
  }
  // Synthesis by the arm's OWN first model (never Claude — the judge).
  const synthPrompt = `## Topic\n${topic}\n\n## Take A\n${t1}\n\n## Take B\n${t2}\n\nSynthesize into one combined take.`;
  assertEgressSafe([SYNTH_SYSTEM, synthPrompt], { label: `arm-eval:brainstorm:${arm.id}:synth` });
  let synth;
  try { synth = await d.callModel({ model: m1, system: SYNTH_SYSTEM, userPrompt: synthPrompt }); }
  catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('[egress-gate]')) throw err;
    return { output: null, outputHash: null, conformant: false, resolvedModels: [m1, m2], usage: null, error: `synthesis failed: ${err.message}` };
  }
  const text = synth?.text ?? '';
  const conformant = Boolean(text.trim()) && text.length > 100;
  return {
    output: conformant ? text : (text || null),
    outputHash: text ? hashText(text) : null,
    conformant,
    // CONCRETE ids the transport resolved + sent (reproducibility field) —
    // sentinel fallback only if the transport didn't report.
    resolvedModels: [takes[0]?.resolved || m1, takes[1]?.resolved || m2],
    usage: [takes[0]?.usage, takes[1]?.usage, synth?.usage],
    error: conformant ? null : 'synthesized take empty/too short',
  };
}

/** Default model dispatch — shared free-text path (with brainstorm's token cap). */
async function callModelDefault(args) {
  const { callModelFreeText } = await import('./model-call.mjs');
  return callModelFreeText({ ...args, maxTokens: 8000 });
}
