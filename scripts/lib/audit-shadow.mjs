/**
 * @fileoverview Generation-pass shadow — the model-A/B/C observation-only runner.
 *
 * Plan: docs/plans/model-ab-experiment-harness.md (Cluster B, Phase 3).
 * Generalizes the final-review shadow (runShadowReview) to the GENERATION
 * passes: when `AUDIT_MODEL_SHADOW` names arms, `runMultiPassCodeAudit` runs the
 * baseline (A) as today AND spawns each configured arm's generation
 * observation-only, stamping `stage` + `source_model` + `bucket` on findings and
 * recording per-arm cost/conformance. NOTHING an arm produces gates or ships.
 *
 * Load-bearing invariants (all enforced here):
 *  - **Redact ONCE upstream** (decision 11): the signature takes `redactedContext`
 *    (never raw paths), so an arm cannot structurally bypass the egress gate.
 *  - **Schema preflight** (decision 13): with the shadow ENABLED + cloud on,
 *    missing schema is a HARD refusal — NO spend without persistence. Cloud off →
 *    skip (no persistence → no point spending).
 *  - **Spend cap** (decision 12): reserve-then-reconcile against the € ceiling;
 *    a call is refused when the reservation would breach the cap. No budget set →
 *    refuse (no unbounded burn).
 *  - **Awaited-but-non-gating** (decision 12): the caller awaits persistence; the
 *    shadow NEVER affects A's verdict; a per-arm timeout marks the rest
 *    `unverified` so a hung provider can't stall.
 *  - **Best-effort per arm/stage** (mirrors runShadowReview): one failing stage
 *    logs + is skipped; the baseline audit + ship path are untouched.
 *
 * The MODEL CALL is an injectable dependency (`deps.callModel` / `deps.callGemini`)
 * so tests drive the orchestration deterministically without real APIs.
 *
 * @module scripts/lib/audit-shadow
 */

import { z } from 'zod';
import { ProducerFindingSchema } from './schemas.mjs';
import { PASS_PROMPTS } from './prompt-seeds.mjs';
import { semanticId } from './findings.mjs';
import { resolveModel } from './model-resolver.mjs';
import { costForBudget, toEur } from './model-pricing.mjs';
import { executionPlan } from './audit-arms.mjs';
import { auditShadowConfig } from './config.mjs';
import { assertEgressSafe } from './sensitive-egress-gate.mjs';
import {
  modelAbSchemaReady, ensureArmSet, reserveSpend, reconcileSpend, releaseSpend, releaseOrphanedReservations,
} from './store/model-ab.mjs';
import { recordFindings, recordPassStats } from './store/runs-findings.mjs';

/** The generation passes an arm runs — DERIVED from PASS_PROMPTS (minus quickfix)
 * so the shadow's decomposition can't drift from the baseline pass set (R2 M2). */
export const SHADOW_PASSES = Object.freeze(Object.keys(PASS_PROMPTS).filter((p) => p !== 'quickfix'));

/** Reservation TTL — orphaned reservations older than this are released on
 * startup. Config-driven (audit R3 M4). */
export const RESERVATION_TTL_MS = auditShadowConfig.reservationTtlMs;

/** Per-pass max output tokens. The spend reservation estimates at THIS cap (not
 * a smaller guess) so a reservation can never UNDER-reserve vs the actual call
 * — the € ceiling is only ever over-, never under-charged pre-flight (R1 H8).
 * Config-driven (audit R3 M4). */
const PASS_MAX_TOKENS = auditShadowConfig.passMaxTokens;

/** Conservative input-token safety margin on the reservation estimate — chars/4
 * can under-count tokenization, so over-reserve slightly (audit R3 H1; the
 * reserve-then-reconcile bounded-overshoot is the plan's design, this just
 * tightens the pre-flight bound). */
const INPUT_EST_SAFETY = 1.2;

/** Shadow pass result schema — the OSS conformance check validates against this. */
export const ShadowPassSchema = z.object({
  findings: z.array(ProducerFindingSchema).max(50),
  summary: z.string().max(1000).default(''),
});

/** Build the per-pass user prompt from the ALREADY-redacted context (decision 11). */
function buildPassUserPrompt(passName, planContent, redactedContext) {
  return [
    `## Task\nAudit the code below for the "${passName}" concern. Return findings per the schema.`,
    planContent ? `## Plan\n${planContent}` : '',
    `## Code (redacted)\n${redactedContext}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Race a promise against a timeout; on timeout reject with a tagged error.
 * NOTE (audit R1 M8): this bounds the ORCHESTRATION, not the underlying request
 * — the winning timer doesn't abort the in-flight provider call. Resource-wise
 * that call is separately bounded by its OWN timeout (the OSS adapter's
 * `timeoutMs`, the GPT SDK default), so a hung provider can't leak indefinitely;
 * this outer race just guarantees the shadow returns. Threading an
 * AbortController through `callModel` for hard cancellation is a v2 refinement.
 */
function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[shadow-timeout] ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run one generation stage (a model over the 5 passes), reserving/reconciling
 * spend per pass and collecting findings + per-pass stats. Stops early if the
 * spend cap refuses a reservation (the rest of the stage is skipped, logged).
 */
async function runStage({ stage, provider, model, redactedContext, planContent, runId, budget, deps }) {
  const findings = [];
  const passStats = [];
  for (const passName of SHADOW_PASSES) {
    const system = PASS_PROMPTS[passName] || `Audit the code for ${passName} issues.`;
    const userPrompt = buildPassUserPrompt(passName, planContent, redactedContext);

    // Defence-in-depth egress scan (audit R1 H3/M6): the redact-once upstream
    // producer is the structural guarantee, but scanning the assembled payload
    // here means we don't rely on `redactedContext`'s PROVENANCE — a secret that
    // slipped through aborts BEFORE any provider call, for OSS and GPT alike.
    assertEgressSafe(userPrompt, { label: `shadow:${stage}:${passName}` });

    // Pre-flight spend reservation, estimating output at the CAP (never under —
    // audit R1 H8) and guarding finiteness (audit R1 H1; costForBudget is
    // never-null but be defensive).
    const estTokensIn = Math.ceil(((system.length + userPrompt.length) / 4) * INPUT_EST_SAFETY);
    const est = costForBudget({ input_tokens: estTokensIn, output_tokens: PASS_MAX_TOKENS }, model);
    const estEurRaw = toEur(est.totalUsd);
    // costForBudget is provably finite (sanitized tokens × finite rates + the
    // module-load fallback-dominance invariant), so this branch is unreachable —
    // but if it ever fires, fail CLOSED (reserve the whole cap → refuses further
    // passes), never fail OPEN with a €0 under-charge (audit R4 H1).
    const estEur = Number.isFinite(estEurRaw) ? estEurRaw : budget.capEur;
    const reservation = await deps.reserveSpend({
      runId, armId: null, stage, reservedEur: estEur, estimated: est.estimated,
      capEur: budget.capEur, activeTtlMs: RESERVATION_TTL_MS,
    });
    if (!reservation.ok) {
      process.stderr.write(`  [shadow] spend cap reached (${reservation.spentEur?.toFixed?.(2)}/${budget.capEur} EUR) — skipping ${stage}/${passName}\n`);
      passStats.push({ stage, passName, model, skipped: 'cap-exceeded' });
      break;
    }

    let call;
    try {
      call = await deps.callModel({ provider, model, system, userPrompt, passName, stage });
    } catch (err) {
      // Egress refusals MUST surface loudly — but RELEASE the reservation first
      // (audit R1 M1) so an aborted call doesn't leak budget until TTL expiry.
      // Normalize the caught value (audit R3 M1): `throw null` / a non-Error
      // must not crash the cleanup path.
      const msg = (err && typeof err.message === 'string') ? err.message : String(err);
      if (msg.includes('[egress-gate]')) {
        // The call never happened → RELEASE (free) the reservation, not
        // reconcile-unmeterable (which would KEEP it) — audit R2 H2.
        await deps.releaseSpend({ ledgerId: reservation.ledgerId });
        throw err;
      }
      call = { result: null, conformant: false, failed: true, usage: { usageMissing: true }, error: msg };
    }

    // Reconcile the reservation to actual (keep the reservation if unmeterable).
    const actual = costForBudget(call.usage, model);
    await deps.reconcileSpend({
      ledgerId: reservation.ledgerId,
      actualEur: toEur(actual.totalUsd) ?? 0,
      unmeterable: actual.unmeterable,
    });

    const passFindings = call.result?.findings || [];
    for (const f of passFindings) {
      f._stage = stage;
      f._sourceModel = model;
      f._pass = passName;
      findings.push(f);
    }
    passStats.push({
      stage, passName, model,
      conformant: !!call.conformant, failed: !!call.failed,
      usage: call.usage || null, costUsd: actual.totalUsd, usageUnmeterable: actual.unmeterable,
      raised: passFindings.length,
    });
  }
  return { findings, passStats };
}

/** Stamp bucket (both | shadow-only) on shadow findings vs the baseline's set. */
function bucketAgainstBaseline(shadowFindings, baseline) {
  const baseline_ = Array.isArray(baseline) ? baseline : (baseline?.findings || baseline?.allFindings || []);
  const baseHashes = new Set(baseline_.map((f) => f._hash || semanticId(f)));
  for (const f of shadowFindings) {
    const h = f._hash || semanticId(f);
    f._hash = h;
    f._bucket = baseHashes.has(h) ? 'both' : 'shadow-only';
  }
}

/** Persist per-stage findings + per-pass stats (observation-only; awaited). */
async function persist(runId, findings, passStats, round, deps) {
  const byStage = new Map();
  for (const f of findings) {
    if (!byStage.has(f._stage)) byStage.set(f._stage, []);
    byStage.get(f._stage).push(f);
  }
  for (const [stage, fs] of byStage) {
    await deps.recordFindings(runId, fs, `model-ab-${stage}`, round);
  }
  for (const st of passStats) {
    // 'cap-exceeded' skip = no call happened → nothing to meter (correctly omitted).
    if (st.skipped) continue;
    // A stage-level timeout/failure ('unverified') is a COVERAGE LOSS — record it
    // so the conformance denominator isn't silently undercounted (audit R1 M3,
    // the silent-clean class): a dropped pass must read as a conformance MISS,
    // never vanish.
    if (st.unverified) {
      await deps.recordPassStats(runId, `model-ab-${st.stage}-unverified`, {
        raised: 0, stage: st.stage, sourceModel: null,
        structuredOutputOk: false, usageUnmeterable: true,
      }, round);
      continue;
    }
    await deps.recordPassStats(runId, `model-ab-${st.stage}-${st.passName}`, {
      raised: st.raised || 0,
      inputTokens: st.usage?.input_tokens,
      outputTokens: st.usage?.output_tokens,
      latencyMs: st.usage?.latency_ms,
      sourceModel: st.model,
      stage: st.stage,
      // A failed pass (call threw/degraded) is a conformance MISS regardless of
      // the model's own claim.
      structuredOutputOk: !!st.conformant && !st.failed,
      costUsd: st.costUsd,
      usageUnmeterable: st.usageUnmeterable,
    }, round);
  }
}

/**
 * Run the generation shadow for the configured arms. Observation-only; returns a
 * summary and NEVER throws into the caller's verdict path (best-effort), EXCEPT
 * an egress-gate refusal which is intentionally propagated.
 *
 * @param {{
 *   redactedContext: string,     // decision 11 — already redacted, never raw paths
 *   arms: object[],              // resolveArms(env).arms
 *   baseline?: object,           // baseline (A) result, for bucketing
 *   runId?: string|null,
 *   planContent?: string,
 *   round?: number,
 *   deps?: object,               // injectable model/store seam (tests)
 * }} input
 * @returns {Promise<{state:string, findingCount?:number, stages?:string[], missing?:string[]}>}
 */
export async function runGenerationShadow({ redactedContext, arms, baseline = null, runId = null, planContent = '', round = 1, capEur = auditShadowConfig.budgetEur, deps = {} }) {
  const d = { ...defaultDeps(), ...deps };

  if (!Array.isArray(arms) || arms.length === 0) return { state: 'skipped-no-arms' };
  if (typeof redactedContext !== 'string') {
    throw new Error('runGenerationShadow: redactedContext must be a string (redact-once upstream — decision 11)');
  }

  // Preflight (decision 13): cloud on + schema not ready → HARD refusal (no spend).
  const schema = await d.modelAbSchemaReady();
  if (!schema.cloud) return { state: 'skipped-cloud-off' };
  if (!schema.ready) {
    process.stderr.write(`  [shadow] REFUSING to run — model-A/B schema not ready (missing: ${schema.missing.join(', ')}). Run: node scripts/setup-postgres.mjs --migrate\n`);
    return { state: 'refused-schema-preflight', missing: schema.missing };
  }

  // No budget → refuse (decision 12 — never an unbounded burn).
  if (capEur == null) {
    process.stderr.write('  [shadow] REFUSING to run — AUDIT_MODEL_SHADOW_BUDGET_EUR is unset (no unbounded burn).\n');
    return { state: 'refused-no-budget' };
  }

  await d.ensureArmSet(1);
  const released = await d.releaseOrphanedReservations({ ttlMs: RESERVATION_TTL_MS });
  if (released > 0) process.stderr.write(`  [shadow] released ${released} orphaned reservation(s) from a prior run\n`);

  const plan = executionPlan(arms);
  const budget = { capEur };

  // Resolve the shared generation models from the arm configs (B and C share).
  const ossArm = arms.find((a) => a.generation.provider === 'oss');
  const ossModel = ossArm ? resolveModel(ossArm.generation.modelSentinel) : null;
  const gptModel = resolveModel('latest-gpt');
  const geminiModel = resolveModel('latest-pro');

  const allFindings = [];
  const allStats = [];
  const stagesRun = [];

  // Execute the shared stages (compute-sharing: oss-gen + gpt-round once).
  const stageJobs = [];
  if (plan.wantsOssGen && ossModel) stageJobs.push({ stage: 'oss-gen', provider: 'oss', model: ossModel });
  if (plan.wantsGptRound) stageJobs.push({ stage: 'gpt-round', provider: 'gpt', model: gptModel });

  for (const job of stageJobs) {
    try {
      const res = await withTimeout(
        runStage({ ...job, redactedContext, planContent, runId, budget, deps: d }),
        auditShadowConfig.perArmTimeoutMs, `stage:${job.stage}`,
      );
      allFindings.push(...res.findings);
      allStats.push(...res.passStats);
      stagesRun.push(job.stage);
    } catch (err) {
      if (err && typeof err.message === 'string' && err.message.includes('[egress-gate]')) throw err;
      process.stderr.write(`  [shadow] stage ${job.stage} failed/timed out (unverified): ${err.message}\n`);
      allStats.push({ stage: job.stage, unverified: true, error: err.message });
    }
  }

  // Gemini stage (arm C) — runs over the shadow's collected findings; best-effort.
  // Spend-capped like the other stages (reserve a conservative estimate, then
  // reconcile from the returned usage) so it can't overshoot the € ceiling.
  if (plan.wantsGemini) {
    const estIn = Math.ceil(redactedContext.length / 4) + 2000;
    const gEst = costForBudget({ input_tokens: estIn, output_tokens: PASS_MAX_TOKENS }, geminiModel);
    const gRes = await d.reserveSpend({
      runId, armId: null, stage: 'gemini', reservedEur: toEur(gEst.totalUsd) ?? 0,
      estimated: gEst.estimated, capEur: budget.capEur, activeTtlMs: RESERVATION_TTL_MS,
    });
    if (!gRes.ok) {
      process.stderr.write(`  [shadow] spend cap reached — skipping gemini stage\n`);
      allStats.push({ stage: 'gemini', skipped: 'cap-exceeded' });
    } else {
      try {
        const g = await withTimeout(
          d.callGemini({ collectedFindings: allFindings, redactedContext, planContent, model: geminiModel, runId }),
          auditShadowConfig.perArmTimeoutMs, 'stage:gemini',
        );
        const gUsage = g?.passStats?.[0]?.usage || null;
        const gActual = costForBudget(gUsage, geminiModel);
        await d.reconcileSpend({ ledgerId: gRes.ledgerId, actualEur: toEur(gActual.totalUsd) ?? 0, unmeterable: gActual.unmeterable });
        if (g && Array.isArray(g.findings)) {
          for (const f of g.findings) { f._stage = 'gemini'; f._sourceModel = geminiModel; f._pass = 'gemini'; allFindings.push(f); }
          stagesRun.push('gemini');
        }
        if (g && Array.isArray(g.passStats)) allStats.push(...g.passStats);
      } catch (err) {
        await d.releaseSpend({ ledgerId: gRes.ledgerId });   // call didn't complete → free it (R2 H2)
        process.stderr.write(`  [shadow] gemini stage failed/timed out (unverified): ${err.message}\n`);
        allStats.push({ stage: 'gemini', unverified: true, error: err.message });
      }
    }
  }

  bucketAgainstBaseline(allFindings, baseline);
  await persist(runId, allFindings, allStats, round, d);

  return {
    state: 'ran',
    findingCount: allFindings.length,
    stages: stagesRun,
    shadowOnly: allFindings.filter((f) => f._bucket === 'shadow-only').length,
  };
}

// ── Default (production) deps ────────────────────────────────────────────────

function defaultDeps() {
  return {
    modelAbSchemaReady,
    ensureArmSet,
    reserveSpend,
    reconcileSpend,
    releaseSpend,
    releaseOrphanedReservations,
    recordFindings,
    recordPassStats,
    callModel: callModelDefault,
    callGemini: callGeminiDefault,
  };
}

/** Production model dispatch: OSS via the adapter, GPT via responses.parse. */
async function callModelDefault({ provider, model, system, userPrompt, passName }) {
  if (provider === 'oss') {
    const { createOpenAIClient } = await import('./openai-client.mjs');
    const { ossStructuredCall } = await import('./oss-structured-output.mjs');
    const client = await createOpenAIClient({
      oss: { baseURL: auditShadowConfig.openrouterBaseUrl, apiKey: auditShadowConfig.openrouterApiKey },
    });
    return ossStructuredCall(client, {
      model, system, userPrompt, schema: ShadowPassSchema, schemaName: 'shadow_pass',
      maxTokens: PASS_MAX_TOKENS, passName: `oss-${passName}`,
    });
  }
  // GPT path — Responses API + zodTextFormat (mirrors the baseline GPT calls).
  const { createOpenAIClient } = await import('./openai-client.mjs');
  const { zodTextFormat } = await import('openai/helpers/zod');
  const client = await createOpenAIClient({ purpose: 'gpt' });
  const start = Date.now();
  // Bound the GPT provider call with an AbortController + timeout (audit R3 H2)
  // so a hung request self-terminates — parity with the OSS adapter's timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), auditShadowConfig.callTimeoutMs);
  let resp;
  try {
    resp = await client.responses.parse({
      model,
      input: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
      text: { format: zodTextFormat(ShadowPassSchema, 'shadow_pass') },
      max_output_tokens: PASS_MAX_TOKENS,
    }, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const parsed = resp.output_parsed ?? null;
  return {
    result: parsed,
    conformant: !!parsed,
    failed: !parsed,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
      latency_ms: Date.now() - start,
      usageMissing: !resp.usage,
    },
  };
}

/** Production Gemini stage — additional findings over the shadow's collection. */
async function callGeminiDefault({ collectedFindings, redactedContext, planContent, model }) {
  if (!process.env.GEMINI_API_KEY) {
    return { findings: [], passStats: [{ stage: 'gemini', passName: 'gemini', model, skipped: 'no-key' }] };
  }
  const { GoogleGenAI } = await import('@google/genai');
  const { zodToGeminiSchema } = await import('./schemas.mjs');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const priorList = (collectedFindings || []).slice(0, 40).map((f) => `- [${f.severity}] ${f.category}: ${f.detail?.slice(0, 160)}`).join('\n');
  const prompt = [
    'You are the final-gate reviewer. Below are findings already raised by an OSS+GPT audit.',
    'Emit ONLY NET-NEW findings the prior audit MISSED (do not restate). Return per the schema.',
    planContent ? `## Plan\n${planContent}` : '',
    `## Prior findings\n${priorList || '(none)'}`,
    `## Code (redacted)\n${redactedContext}`,
  ].filter(Boolean).join('\n\n');
  const start = Date.now();
  const resp = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: zodToGeminiSchema(ShadowPassSchema) },
  });
  let parsed = null;
  try { parsed = JSON.parse(resp.text); } catch { /* conformance miss */ }
  const usage = {
    input_tokens: resp.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
    latency_ms: Date.now() - start,
    usageMissing: !resp.usageMetadata,
  };
  return {
    findings: parsed?.findings || [],
    passStats: [{
      stage: 'gemini', passName: 'gemini', model,
      conformant: !!parsed, failed: !parsed, usage,
      costUsd: costForBudget(usage, model).totalUsd, usageUnmeterable: costForBudget(usage, model).unmeterable,
      raised: parsed?.findings?.length || 0,
    }],
  };
}
