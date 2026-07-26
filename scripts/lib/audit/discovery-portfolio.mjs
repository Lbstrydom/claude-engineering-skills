/**
 * @fileoverview Discovery portfolio — orchestrates the tiered-recall audit
 * pipeline's generator fan-out: GLM + one Sonnet cold pass as the default
 * `required` generators, plus a conditional GPT-5.5 `optional`/`exploratory`
 * generator gated by `gpt-sentinel-trigger.mjs`. Phase 6 of the tiered-recall
 * audit pipeline.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 6.
 *
 * **L3 (code-audit r1, corrects the stale 2026-07-10 Scoped-Cluster-D note
 * this replaced)**: this module IS wired — `tiered-pipeline.mjs` imports and
 * calls `runDiscoveryPortfolio` directly, and `tiered-pipeline.mjs` is itself
 * reachable from `openai-audit.mjs`'s chooser (see stage1-triage.mjs's own
 * header, and AGENTS.md's Tiered-Recall Audit Pipeline section). "Wired"
 * means reachable from the chooser, not "on by default" —
 * `tieredAuditConfig.pipelineEnabled` (env `AUDIT_TIERED_PIPELINE_ENABLED`)
 * still defaults off in production, per the per-call `allowTiered` gate
 * (AGENTS.md's "Execution eligibility is per-call, not env-global").
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
 * @property {number} [durationMs] - wall-clock for this generator's call,
 *   recorded on success AND failure. Absent on `skipped` (nothing ran) and on
 *   rows written before 2026-07-18 — treat as unknown, never as 0.
 * @property {string} [errorMessage]
 * @property {number|null} [errorStatus] - err.status when the underlying error carried
 *   an HTTP-like status (audit fix M3 round 2) — was previously pushed but
 *   undocumented here (M14, code-audit r1).
 * @property {string|null} [category] - classifyLlmError category (timeout/network/
 *   http-4xx/permanent), when the underlying error was classified. Threaded from
 *   err.category (docs/plans/oss-call-reliability-hardening.md).
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
  // Wall-clock per generator. Recorded on BOTH paths (2026-07-18) because
  // `oss-call-policy.json`'s own calibrationNote says to recalibrate "if either
  // operation still times out routinely" — and it does: GLM discovery was the
  // dominant tiered-shadow failure, every timeout row sitting at ~240.8s, i.e.
  // the 120s `discovery_generation` budget exhausted TWICE (attempt + 1 retry).
  // But GLM also succeeds on other runs, and nothing recorded how long a
  // SUCCESSFUL call takes — so there was no distribution to calibrate the
  // budget against, only the failures. Recording the duration on success is
  // what makes the next change to that timeout evidence-based instead of a
  // guess; the failure duration confirms whether a budget was actually
  // exhausted or the call died early for another reason.
  const startedAt = Date.now();
  try {
    const findings = await generator.call();
    // audit fix H5, round 2: a non-array return (object, null, undefined) was
    // previously recorded as `status: 'succeeded'` with `findingCount:
    // undefined` — a malformed adapter response must be treated the SAME as
    // a thrown error (a required-generator failure), not silently accepted.
    if (!Array.isArray(findings)) {
      throw new Error(`generator.call() returned a non-array value (${typeof findings}) — expected Array<object>`);
    }
    generatorOutcomes.push({
      model: generator.model, role: generator.role, status: 'succeeded',
      findingCount: findings.length, durationMs: Date.now() - startedAt,
    });
    return findings;
  } catch (err) {
    // audit fix M3, round 2: surface err.status alongside the message (AGENTS.md
    // Model Resolution: "surface err.status + the real provider error.message —
    // don't collapse to a generic string") so a caller can distinguish load/quota/
    // auth/timeout failures from a genuine malformed-response bug.
    generatorOutcomes.push({
      model: generator.model, role: generator.role, status: 'failed', findingCount: 0,
      durationMs: Date.now() - startedAt,
      errorMessage: err?.message || String(err),
      errorStatus: err?.status ?? null,
      category: err?.category ?? null,
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
      generatorOutcomes.push({ model: optionalGptModel, role: 'optional', status: 'skipped', findingCount: 0, reason: 'not-triggered' });
    }
  } else {
    // 33593f74/7ceef72a: previously nothing was pushed at all when no GPT
    // adapter was supplied — indistinguishable from GPT having succeeded
    // with zero findings. Mirrors the trigger-not-fired branch above,
    // distinguished only by `reason`.
    generatorOutcomes.push({ model: optionalGptModel, role: 'optional', status: 'skipped', findingCount: 0, reason: 'no-adapter' });
  }

  const findings = [...requiredResults.flat(), ...optionalFindings];
  return { findings, requiredGeneratorFailed };
}
