/**
 * @fileoverview Headless plan producer for the plan-authoring experiment (§10.2).
 *
 * Plan: docs/plans/arm-eval-framework.md §10.2. Given a task + an arm, generates
 * a plan with the arm's author model from the SHARED plan seed (so only the model
 * varies). Egress-gated; conformance = a well-formed plan carrying the
 * machine-readable intent block. PURE orchestration — the model call is injected
 * (`deps.callModel`); the default routes OSS→OpenRouter / GPT→Responses.
 *
 * @module scripts/lib/arm-eval/producers/plan
 */

import { PLAN_SYSTEM, PLAN_SEED_VERSION, buildPlanGenPrompt, parsePlanIntent } from '../plan-seed.mjs';
import { hashText } from './_shared.mjs';

/**
 * Produce one arm's plan for a task.
 * @param {{ task:string, arm:object, contextPack?:string|null, deps?:{callModel?:Function} }} input
 * @returns {Promise<{ output:string|null, outputHash:string|null, conformant:boolean,
 *   resolvedModel:string, usage:object|null, error:string|null, seedVersion:string }>}
 */
export async function producePlan({ task, arm, contextPack = null, deps = {} }) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('producePlan: task must be a non-empty string');
  if (!arm || !Array.isArray(arm.models) || arm.models.length < 1) throw new Error('producePlan: arm.models required');
  const d = { callModel: callModelDefault, ...deps };
  const model = arm.models[0];                       // plan authors are single-model
  const system = PLAN_SYSTEM;
  const userPrompt = buildPlanGenPrompt(task, contextPack);

  // Egress gate BEFORE the wire call (the prompt carries the task + repo context).
  const { assertEgressSafe } = await import('../../sensitive-egress-gate.mjs');
  assertEgressSafe([system, userPrompt], { label: `arm-eval:plan:${arm.id}` });

  let call;
  try {
    call = await d.callModel({ model, system, userPrompt });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('[egress-gate]')) throw err;
    return { output: null, outputHash: null, conformant: false, resolvedModel: model, usage: null, error: err.message, seedVersion: PLAN_SEED_VERSION };
  }
  const text = call?.text ?? '';
  // Conformance: a non-trivial plan that carries the machine-readable intent
  // block (§10.10). A malformed/empty output is `conformant:false` — the decision
  // module gates a flaky arm on its conformance RATE (no survivorship bias).
  const intent = parsePlanIntent(text);
  const conformant = Boolean(text.trim()) && text.length > 200 && intent.parseable;
  return {
    output: conformant ? text : text || null,
    outputHash: text ? hashText(text) : null,
    conformant,
    // The CONCRETE id the transport resolved + sent (e.g. `gpt-5.5`, not the
    // `latest-gpt` sentinel) — the archive's reproducibility field. Falls back
    // to the arm's declared id only if the transport didn't report.
    resolvedModel: call?.resolved || model,
    usage: call?.usage ?? null,
    error: conformant ? null : (text ? 'plan missing machine-readable intent block / too short' : 'empty output'),
    seedVersion: PLAN_SEED_VERSION,
  };
}

/** Production model dispatch (free-text completion) — shared with brainstorm. */
async function callModelDefault(args) {
  const { callModelFreeText } = await import('./model-call.mjs');
  return callModelFreeText(args);
}
