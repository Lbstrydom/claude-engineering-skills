/**
 * @fileoverview Discovery portfolio — orchestrates the tiered-recall audit
 * pipeline's generator fan-out: GLM + one Sonnet cold pass as the default
 * `required` generators, plus a conditional GPT-5.5 `optional`/`exploratory`
 * generator gated by `gpt-sentinel-trigger.mjs`. Phase 6 of the tiered-recall
 * audit pipeline.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 6.
 *
 * **Scoped-Cluster-D note** (2026-07-10): this module is new, tested, and
 * NOT wired into `openai-audit.mjs`'s production chooser in this pass — see
 * `gpt-sentinel-trigger.mjs`'s module header for the same note and
 * `.audit/cycle-cluster-state.json` for the full rationale.
 *
 * **Run-level generator status tracking** (round-2 finding #2, Gemini gate
 * round-1 finding #G3): each generator's outcome is recorded on
 * `ctx.generatorOutcomes` INDEPENDENT of whether it produced any findings —
 * a generator that fails and produces zero findings must not be
 * indistinguishable from a generator that succeeded and legitimately found
 * nothing.
 *
 * **Egress safety**: every provider call in this module goes through the
 * existing guarded client factories (`createAnthropicClient` /
 * `ossStructuredCall` via a client built by `createOpenAIClient`) — no call
 * site here talks to a provider SDK directly.
 *
 * @module scripts/lib/audit/discovery-portfolio
 */

import { resolveModel } from '../model-resolver.mjs';

/**
 * @typedef {object} GeneratorOutcome
 * @property {string} model
 * @property {'required'|'optional'|'exploratory'} role
 * @property {'succeeded'|'failed'|'skipped'} status
 * @property {number} findingCount
 * @property {string} [errorMessage]
 */

/**
 * Run one generator via its injected adapter, recording its outcome on
 * `generatorOutcomes` regardless of success/failure/finding-count. Never
 * throws — a generator failure is captured as a `failed` outcome, not
 * propagated, so one generator's failure doesn't abort the whole portfolio
 * fan-out (required-generator failure is handled by the CALLER via
 * `ctx.generatorOutcomes`, per §1.5's failure semantics — this function only
 * records, it does not decide fallback policy).
 *
 * @param {{model: string, role: 'required'|'optional'|'exploratory', call: () => Promise<Array<object>>}} generator
 * @param {GeneratorOutcome[]} generatorOutcomes - mutated in place (append-only)
 * @returns {Promise<Array<object>>} findings produced (empty array on failure/skip)
 */
async function runOneGenerator(generator, generatorOutcomes) {
  try {
    const findings = await generator.call();
    // audit fix H5, round 2: a non-array return (object, null, undefined) was
    // previously recorded as `status: 'succeeded'` with `findingCount:
    // undefined` — a malformed adapter response must be treated the SAME as
    // a thrown error (a required-generator failure), not silently accepted.
    if (!Array.isArray(findings)) {
      throw new Error(`generator.call() returned a non-array value (${typeof findings}) — expected Array<object>`);
    }
    generatorOutcomes.push({ model: generator.model, role: generator.role, status: 'succeeded', findingCount: findings.length });
    return findings;
  } catch (err) {
    // audit fix M3, round 2: surface err.status alongside the message (AGENTS.md
    // Model Resolution: "surface err.status + the real provider error.message —
    // don't collapse to a generic string") so a caller can distinguish load/quota/
    // auth/timeout failures from a genuine malformed-response bug.
    generatorOutcomes.push({
      model: generator.model, role: generator.role, status: 'failed', findingCount: 0,
      errorMessage: err?.message || String(err),
      errorStatus: err?.status ?? null,
    });
    return [];
  }
}

/**
 * Orchestrate the discovery portfolio for one commit/round.
 *
 * @param {object} ctx
 * @param {GeneratorOutcome[]} ctx.generatorOutcomes - append-only; this function pushes to it
 * @param {{diffSize: number, changedFiles: string[], diffText: string}} ctx.diffContext
 * @param {object} adapters - injectable generator implementations (production wraps
 *   `ossStructuredCall`/`createAnthropicClient`/`createOpenAIClient`; tests inject stubs —
 *   mirrors the adapter-injection pattern established in `evidence-triage.mjs`)
 * @param {() => Promise<Array<object>>} adapters.glmCall - required
 * @param {() => Promise<Array<object>>} adapters.sonnetCall - required
 * @param {(() => Promise<Array<object>>)|null} [adapters.gptCall] - optional/exploratory;
 *   only invoked if `triggerDecision.fire` is true
 * @param {{fire: boolean, firedBy: string|null, reasonCodes: string[]}} triggerDecision -
 *   from `gpt-sentinel-trigger.mjs::resolveGptTrigger` — the CALLER decides whether GPT
 *   fires (this module doesn't re-derive the trigger; separation of concerns)
 * @returns {Promise<{findings: Array<object>, requiredGeneratorFailed: boolean}>}
 */
export async function runDiscoveryPortfolio(ctx, adapters, triggerDecision) {
  const generatorOutcomes = ctx.generatorOutcomes || (ctx.generatorOutcomes = []);
  // audit fix M4: scope `requiredGeneratorFailed` to outcomes THIS call pushes,
  // not the whole (possibly cross-round, append-only) `generatorOutcomes`
  // array — otherwise a prior round's failure, still sitting in a reused
  // `ctx`, would silently mark every later round `requiredGeneratorFailed`
  // regardless of whether this round's generators actually succeeded.
  const thisCallStart = generatorOutcomes.length;

  const requiredGenerators = [
    { model: 'glm', role: 'required', call: adapters.glmCall },
    { model: 'sonnet', role: 'required', call: adapters.sonnetCall },
  ];

  const requiredResults = await Promise.all(
    requiredGenerators.map((g) => runOneGenerator(g, generatorOutcomes))
  );
  const requiredGeneratorFailed = generatorOutcomes
    .slice(thisCallStart)
    .filter((o) => o.role === 'required')
    .some((o) => o.status === 'failed');

  // audit fix M4, round 2: resolved via the sentinel, not a hardcoded concrete
  // ID (AGENTS.md "Do NOT pin concrete model IDs in new code — use a sentinel").
  const optionalGptModel = resolveModel('latest-gpt');
  let optionalFindings = [];
  if (adapters.gptCall) {
    if (triggerDecision?.fire) {
      const role = triggerDecision.firedBy === 'exploration' ? 'exploratory' : 'optional';
      optionalFindings = await runOneGenerator({ model: optionalGptModel, role, call: adapters.gptCall }, generatorOutcomes);
    } else {
      generatorOutcomes.push({ model: optionalGptModel, role: 'optional', status: 'skipped', findingCount: 0 });
    }
  }

  const findings = [...requiredResults.flat(), ...optionalFindings];
  return { findings, requiredGeneratorFailed };
}
