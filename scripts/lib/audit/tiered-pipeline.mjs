/**
 * @fileoverview `runTieredAuditPipeline` — the first assembly of the tiered
 * Stage 0→1→2 sequence into ONE callable function matching
 * `runLegacyProductionAudit`'s `AuditRunResult` output contract, so
 * `openai-audit.mjs`'s chooser can treat both branches uniformly. Tiered-
 * recall audit pipeline Phase 11 (completes Cluster D's deferred assembly
 * scope — Cluster D built `discovery-portfolio.mjs`, `stage1-triage.mjs`,
 * and `final-adjudication.mjs` as independently-tested modules, but never
 * wired them into one pipeline; this file does that for the first time).
 *
 * Sequence (per the plan's §1.5 state machine + this phase's own sequencing
 * fix — discovery MUST run before Stage 0, since Stage 0 verifies candidates
 * that don't exist until a generator emits them):
 *
 *   discovery portfolio → (required-generator-failure? → fall back to
 *   runLegacyProductionAudit) → processFindings (pure, unchanged) →
 *   mergeIntoEnvelopes (pure, unchanged) → Stage 0 (evidence-triage.mjs) →
 *   Stage 1 (stage1-triage.mjs, ledger-wired) → selectFinalAdjudicationWorkItems
 *   routing → Stage 2 (final-adjudication.mjs) → findings union
 *   (verified/reversed/stage1_confirmed_survivor/missed_candidates/
 *   pendingAdjudication) → flattenEnvelopeToFinding → full
 *   AuditRunResultSchema population.
 *
 * Gated behind `tieredAuditConfig.pipelineEnabled` (default `false`) — this
 * module is inert (never imported into a live code path with real effect)
 * until an operator explicitly opts in.
 *
 * **Known-incomplete piece (documented, not silently glossed over)**: Stage
 * 2's Gemini adjudicator/clean-challenge calls depend on Phase 12's
 * `gemini-review.mjs --role adjudicator-only` subprocess adapter, which is
 * explicitly OUT OF SCOPE for this phase (Cluster F). `ctx.providers
 * .geminiReviewCall` is `null` until Phase 12 ships; the default `reviewCall`/
 * `cleanRegionCall` adapters below throw a clear, descriptive error when
 * actually invoked with no `geminiReviewCall` wired — `runFinalAdjudication`'s
 * existing catch-and-escalate logic (already implemented, tested in Cluster
 * D) routes that to `unresolved`/`cleanRegionFailures`, never a fabricated
 * verdict.
 *
 * **Stage 1 triager model resolution** (wired 2026-07-13, once Cluster C's
 * validation manifest existed and passed): `resolveStage1TriagerModel`
 * (`stage1-triager-resolver.mjs`) picks the manifest's validated
 * `candidateModel` (GLM) when `tieredAuditConfig.stage1Model` (an explicit
 * `AUDIT_STAGE1_MODEL` operator pin) is unset — falling back to GPT-5.5 via
 * the existing `callGPT` primitive whenever the manifest is missing,
 * malformed, or `passed:false`. Always a loud, named fallback reason
 * (stderr), never a silent default.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 11.
 *
 * @module scripts/lib/audit/tiered-pipeline
 */

import { z } from 'zod';
import { ProducerFindingSchema } from '../schemas.mjs';
import { readFilesAsContext } from '../file-io.mjs';
import { processFindings, computeAuditVerdict } from './findings-pipeline.mjs';
import { mergeIntoEnvelopes, flattenEnvelopeToFinding } from './candidate-envelope.mjs';
import { runStage0EvidenceTriage } from './evidence-triage.mjs';
import { runStage1CheapTriage } from './stage1-triage.mjs';
import { runFinalAdjudication, selectFinalAdjudicationWorkItems } from './final-adjudication.mjs';
import { runDiscoveryPortfolio } from './discovery-portfolio.mjs';
import { resolveGptTrigger } from './gpt-sentinel-trigger.mjs';
import { computeCostReport } from './cost-budget.mjs';
import { callGPT } from './llm-helpers.mjs';
import { tieredAuditConfig } from '../config.mjs';
import { resolveModel } from '../model-resolver.mjs';
import { resolveStage1TriagerModel } from './stage1-triager-resolver.mjs';

const Stage1TriagerResponseSchema = z.object({
  dismissalAttempted: z.boolean(),
  disproof: z.string().max(500).nullable(),
});

/** Shared prompt construction for the Stage 1 triager — used by BOTH the
 * GPT-5.5 default adapter and the validated-manifest (GLM) adapter, so a
 * model swap changes only which primitive answers the same question, never
 * the question itself.
 *
 * audit-orchestrator-hardening Phase 8: receives the minimized, redacted
 * `StageOneTriageInputSchema` DTO `runStage1CheapTriage` builds — never the
 * raw envelope. `dto.anchorQuote`/`dto.causalChain` are already evidence-
 * normalized + redacted by `buildStageOneTriageInput`.
 * @param {import('../schemas.mjs').StageOneTriageInput} dto
 * @returns {{system: string, userPrompt: string}}
 */
function buildStage1TriagerPrompt(dto) {
  let evidenceBlock = 'Evidence: none available (evidenceStatus=missing) — cannot be dismissed without a concrete disproof; escalate rather than guess.';
  if (dto.evidenceStatus === 'commission' && dto.anchorQuote) {
    evidenceBlock = `Evidence (commission, content-verified by Stage 0):\nCited text:\n${dto.anchorQuote}`;
  } else if (dto.evidenceStatus === 'omission') {
    evidenceBlock = `Evidence (omission):\nCausal chain: ${dto.causalChain ?? '(unavailable)'}\n${dto.anchorQuote ? `Trigger text:\n${dto.anchorQuote}` : ''}`;
  }
  return {
    system: 'You are a cheap Stage-1 triager for a code-audit candidate finding. Decide whether you can DETERMINISTICALLY disprove the finding using ONLY the evidence provided below (e.g. the cited quote does not match the claimed defect, the causal chain trigger does not actually create the claimed obligation). If the evidence is absent or insufficient to check the claim, do NOT attempt a dismissal — a plausible-sounding but ungrounded dismissal is worse than no dismissal.',
    userPrompt: `Finding: ${dto.category ?? ''} — ${dto.detail ?? ''}\nSection: ${dto.section ?? ''}\nSeverity: ${dto.severity ?? ''}\n\n${evidenceBlock}`,
  };
}

/**
 * Default (production) Stage 1 triager adapter — GPT-5.5 via the existing
 * `callGPT` primitive, the plan's own documented safe default for when
 * Cluster C's `cheap-triager-validation.json` manifest doesn't exist, is
 * malformed, or failed. Any parse/API failure THROWS (never fabricates a
 * dismissal) — `runStage1CheapTriage` treats a throw as `stage1_escalated`,
 * per §1.5.
 *
 * @param {import('../schemas.mjs').StageOneTriageInput} dto
 * @param {{openai: object}} providers
 * @returns {Promise<{dismissalAttempted: boolean, disproof: string|null}>}
 */
async function defaultTriagerCall(dto, providers) {
  if (!providers?.openai) throw new Error('defaultTriagerCall: providers.openai is required');
  const { system, userPrompt } = buildStage1TriagerPrompt(dto);
  const { result } = await callGPT(providers.openai, {
    system,
    messages: [{ role: 'user', content: userPrompt }],
    schema: Stage1TriagerResponseSchema,
    schemaName: 'stage1_triager_response',
    reasoning: 'low',
    passName: 'stage1-triager',
    maxRetries: 0,
  });
  return result;
}

/**
 * Validated-manifest Stage 1 triager adapter — the model
 * `resolveStage1TriagerModel` selected (typically GLM, per Cluster C's
 * passed validation), via `providers.ossCall` (the same guarded primitive
 * the discovery portfolio's `glmCall` already uses). Same contract as
 * `defaultTriagerCall`: any failure THROWS, never fabricates a dismissal.
 *
 * @param {import('../schemas.mjs').StageOneTriageInput} dto
 * @param {{ossCall: Function}} providers
 * @param {string} model
 * @returns {Promise<{dismissalAttempted: boolean, disproof: string|null}>}
 */
async function validatedTriagerCall(dto, providers, model) {
  if (!providers?.ossCall) throw new Error('validatedTriagerCall: providers.ossCall is required');
  const { system, userPrompt } = buildStage1TriagerPrompt(dto);
  const { result } = await providers.ossCall({
    model, system, userPrompt,
    schema: Stage1TriagerResponseSchema,
    schemaName: 'stage1_triager_response',
    passName: 'stage1-triager',
  });
  return result;
}

/** Throws a clear, descriptive "not yet wired" error — Phase 12 dependency. */
function unwiredGeminiCall() {
  throw new Error(
    'tiered-pipeline: Stage 2 Gemini adjudication requires ctx.providers.geminiReviewCall, ' +
    'which is not yet wired (Phase 12 — the gemini-review.mjs subprocess adapter — is out of ' +
    'scope for this phase). This candidate escalates to unresolved/pending, never a fabricated verdict.'
  );
}

/**
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @returns {Promise<import('../schemas.mjs').AuditRunResult>}
 */
export async function runTieredAuditPipeline(ctx) {
  const stageStart = { discovery: Date.now() };
  const { providers = {} } = ctx;

  // audit-code fix H12/M10 (Cluster E round 1): the original draft let the
  // tiered pipeline run to completion with `providers.geminiReviewCall`
  // absent — Stage 2 candidates would then silently degrade to `unresolved`/
  // `cleanRegionFailures` deep inside `runFinalAdjudication`, one call at a
  // time, rather than the run failing fast with one clear cause. Mandatory-
  // gate-bypass risk is real ONLY once an operator flips
  // `tieredAuditConfig.pipelineEnabled` to `true` before Phase 12 ships the
  // production `geminiReviewCall` adapter — but when they do, this must be a
  // loud configuration error, not hundreds of quietly-unresolved candidates.
  if (typeof providers.geminiReviewCall !== 'function') {
    throw new Error(
      'runTieredAuditPipeline: tieredAuditConfig.pipelineEnabled is true but ' +
      'ctx.providers.geminiReviewCall is not wired — the tiered pipeline\'s ' +
      'Stage 2 mandatory Gemini adjudication gate cannot run. Fix: either set ' +
      'AUDIT_TIERED_PIPELINE_ENABLED=false until Phase 12\'s production ' +
      'geminiReviewCall adapter ships, or supply providers.geminiReviewCall ' +
      'explicitly (e.g. in tests).'
    );
  }

  // ── Discovery portfolio ────────────────────────────────────────────────
  // No GPT sentinel/exploration adapter is wired in this phase (`gptCall:
  // null` below) — the deterministic/exploration/sentinel trigger decision
  // is still computed (for telemetry/logging parity with the plan's design)
  // but `runDiscoveryPortfolio` only actually calls `adapters.gptCall` when
  // it's a function, so a `null` adapter safely no-ops regardless of the
  // trigger's answer.
  const triggerDecision = resolveGptTrigger(
    { diffSize: (ctx.changedFiles || []).length, changedFiles: ctx.changedFiles || [], diffText: ctx.diffText || '', portfolioDisagreement: false },
    { seed: 42 },
    ctx.bandit || null,
    tieredAuditConfig,
  );

  // audit-code fix H4/H18/M13 (Cluster E round 1): the original draft built
  // both generator prompts from `planContent` + a comma-separated filename
  // list ONLY — no file content, no diff hunks. A "code-audit finding
  // generator" cannot produce evidence-backed anchors (commission claims
  // require a content-verifiable `quote`, per ProducerFindingSchema) without
  // ever seeing the code. Reusing `readFilesAsContext` (the SAME sensitive-
  // egress-gated helper every other pass in `legacy-production-audit.mjs`
  // already uses) rather than inventing a second context-assembly path.
  const discoveryCode = readFilesAsContext(ctx.changedFiles || [], { maxPerFile: 8000, maxTotal: 100000 });

  const glmModel = tieredAuditConfig.discoveryModel;
  const glmCall = providers.ossCall
    ? async () => {
        const { result } = await providers.ossCall({
          model: glmModel,
          system: 'You are a code-audit finding generator. Produce candidate findings with a content-verifiable evidence anchor where possible.',
          userPrompt: `## Plan\n${ctx.planContent ?? ''}\n\n## Changed Files (code)\n${discoveryCode}`,
          schema: z.object({ findings: z.array(ProducerFindingSchema).max(15) }),
          schemaName: 'discovery_glm_pass',
          passName: 'discovery-glm',
        });
        // audit-code fix H2 (Cluster E round 3): `result?.findings ?? []`
        // silently converted a missing/malformed provider result into an
        // empty SUCCESSFUL finding list — a required generator's real
        // failure (ossCall returned no result, or a shape the schema
        // validator let through as `undefined`) would then be indistinguishable
        // from "the model genuinely found nothing," masking the failure from
        // §1.5's required-generator-failure fallback. A required generator
        // must fail LOUD, not fail quiet-and-clean.
        if (!result || !Array.isArray(result.findings)) {
          throw new Error('glmCall: providers.ossCall did not return a result.findings array');
        }
        return result.findings;
      }
    : async () => { throw new Error('discovery portfolio: providers.ossCall unavailable'); };

  // audit-code fix H7/M13 (Cluster E round 1): a raw `JSON.parse(text)` on
  // free-form prose has no schema enforcement — a response that "looks like"
  // JSON but omits a required field would parse successfully yet produce a
  // malformed finding downstream. Anthropic's tool-use forces the model to
  // emit an argument object matching the given JSON schema (validated
  // provider-side before it reaches this adapter at all), the same
  // discipline `zodTextFormat` gives the GPT/GLM call sites — no free-form
  // JSON.parse gap remains, and a malformed/refused tool call still throws
  // (never fabricates findings), correctly counting as a required-generator
  // failure per §1.5's failure semantics.
  const sonnetFindingsTool = {
    name: 'report_findings',
    description: 'Report candidate code-audit findings found in the provided code.',
    input_schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          maxItems: 15,
          items: z.toJSONSchema(ProducerFindingSchema),
        },
      },
      required: ['findings'],
    },
  };
  const sonnetCall = providers.anthropicClient
    ? async () => {
        const resp = await providers.anthropicClient.messages.create({
          model: resolveModel('latest-sonnet'),
          max_tokens: 4000,
          system: 'You are a code-audit finding generator (cold pass, no prior context). Produce candidate findings by calling report_findings.',
          messages: [{ role: 'user', content: `## Plan\n${ctx.planContent ?? ''}\n\n## Changed Files (code)\n${discoveryCode}` }],
          tools: [sonnetFindingsTool],
          tool_choice: { type: 'tool', name: 'report_findings' },
        });
        const toolUse = resp?.content?.find(block => block.type === 'tool_use' && block.name === 'report_findings');
        if (!toolUse || !Array.isArray(toolUse.input?.findings)) {
          throw new Error('sonnetCall: response did not contain a report_findings tool call with a findings array');
        }
        return toolUse.input.findings;
      }
    : async () => { throw new Error('discovery portfolio: providers.anthropicClient unavailable'); };

  const discoveryAdapters = { glmCall, sonnetCall, gptCall: null };
  const { findings: rawFindings, requiredGeneratorFailed } = await runDiscoveryPortfolio(ctx, discoveryAdapters, triggerDecision);
  const discoveryLatencyMs = Date.now() - stageStart.discovery;

  if (requiredGeneratorFailed) {
    // audit-plan fix M2 (round 3): capture BEFORE delegating — the legacy
    // path's own generatorOutcomes:[] would otherwise silently overwrite the
    // discovery attempt that JUST happened.
    const discoveryGeneratorOutcomes = [...(ctx.generatorOutcomes || [])];
    const { runLegacyProductionAudit } = await import('./legacy-production-audit.mjs');
    const legacyResult = await runLegacyProductionAudit(ctx);
    const failedNames = discoveryGeneratorOutcomes.filter((o) => o.role === 'required' && o.status === 'failed').map((o) => `${o.model}: ${o.errorMessage ?? 'unknown error'}`);
    return {
      ...legacyResult,
      generatorOutcomes: discoveryGeneratorOutcomes,
      runStatus: 'fallback_legacy',
      fallbackReason: `required generator failed: ${failedNames.join('; ') || 'unknown'}`,
    };
  }

  // ── processFindings (pure, unchanged) → mergeIntoEnvelopes (pure, unchanged) ──
  const taggedFindings = rawFindings.map((f) => ({ ...f, _sourceModel: f._sourceModel || 'unknown' }));
  const { survivors } = processFindings(taggedFindings, {
    ledger: null, // Stage 0-2's own envelope/ledger sequence IS the re-raise-suppression mechanism for this branch
    planContent: ctx.planContent,
    changedFiles: ctx.changedFiles,
  });
  const envelopes = survivors.length > 0 ? mergeIntoEnvelopes(survivors) : [];

  // ── Stage 0 — deterministic triage ─────────────────────────────────────
  const stage0Start = Date.now();
  const { verified: stage0Verified } = runStage0EvidenceTriage(envelopes, { diffText: ctx.diffText }, {
    blameAdapter: () => null, // 'unknown' by default — never silently 'pre_existing_independent' (see §1.5 failure semantics)
    impactAdapter: () => null,
  });
  const stage0LatencyMs = Date.now() - stage0Start;

  // ── Stage 1 — cheap-model triage ───────────────────────────────────────
  const stage1Start = Date.now();
  const stage1Resolution = resolveStage1TriagerModel({ configuredModel: tieredAuditConfig.stage1Model });
  let triagerCall;
  if (stage1Resolution.model && providers.ossCall) {
    process.stderr.write(`  [tiered-pipeline] Stage 1 triager: ${stage1Resolution.model} (${stage1Resolution.source}${stage1Resolution.datasetHash ? `, datasetHash=${stage1Resolution.datasetHash.slice(0, 12)}…` : ''})\n`);
    triagerCall = (envelope) => validatedTriagerCall(envelope, providers, stage1Resolution.model);
  } else {
    // A resolved model with no ossCall to reach it (e.g. OPENROUTER_API_KEY
    // unset) is its own distinct, named fallback reason — never conflated
    // with "no manifest/override at all".
    const reason = stage1Resolution.model && !providers.ossCall ? 'oss_provider_unavailable' : (stage1Resolution.reason || 'no_override_or_manifest');
    process.stderr.write(`  [tiered-pipeline] WARNING: Stage 1 triager falling back to GPT-5.5 (${reason})\n`);
    triagerCall = (envelope) => defaultTriagerCall(envelope, providers);
  }
  const triageResult = await runStage1CheapTriage(stage0Verified, { triagerCall }, {
    ledgerPath: ctx.ledgerFile,
    round: ctx.round,
    // audit-orchestrator-hardening Phase 8: required by buildStageOneTriageInput
    // (no default/no cwd-fallback inside that function itself — the INC-001
    // symlink-bypass class). This orchestrator-level `process.cwd()` mirrors
    // the SAME pattern `runArchitecturePass` already uses in the legacy path.
    repoRoot: process.cwd(),
  });
  const stage1LatencyMs = Date.now() - stage1Start;

  // ── Stage 1 → Stage 2 / human_queue routing (the SINGLE classification point) ──
  const cleanRegionFiles = (ctx.changedFiles || []).filter(
    (f) => !envelopes.some((e) => (e.canonicalFinding?.affectedFiles || []).includes(f) || e.canonicalFinding?._primaryFile === f),
  );
  const budget = { seed: 42, tailSampleRate: 0.1, cleanRegionRate: 0.1, totalChangedFilesCount: (ctx.changedFiles || []).length };
  const workItems = selectFinalAdjudicationWorkItems(triageResult, cleanRegionFiles, budget);

  // ── Stage 2 — Gemini adjudicator + bounded clean-challenge ─────────────
  // Feed selectFinalAdjudicationWorkItems' EXACT (budget-capped) selection
  // back into runFinalAdjudication via a rate=1 pass-through: pin
  // mechanicalDismissed/cleanRegionFiles to what was already selected and
  // set the rates to include 100% of THAT (already-bounded) set, so
  // runFinalAdjudication's own internal (uncapped) selection logic
  // reproduces exactly what the budget decided, rather than re-deriving a
  // different sample.
  const stage2Start = Date.now();
  const reviewCall = providers.geminiReviewCall ?? unwiredGeminiCall;
  const cleanRegionCall = providers.geminiReviewCall ?? unwiredGeminiCall;
  const stage2Result = await runFinalAdjudication(
    { escalated: triageResult.escalated, mechanicalDismissed: workItems.tailSample, confirmedSurvivor: [] },
    workItems.cleanRegionSample,
    { reviewCall, cleanRegionCall },
    { seed: budget.seed, tailSampleRate: 1, cleanRegionRate: 1, totalChangedFilesCount: workItems.cleanRegionSample.length },
  );
  const stage2LatencyMs = Date.now() - stage2Start;

  // ── Findings union — verified/reversed/stage1_confirmed_survivor/missed_candidates
  // (Gemini gate fix G1, round 3-4: pendingAdjudication accumulator included
  // for forward-compat with Phase 12's budget-exhaustion path — always empty
  // in this phase, since no timeout-enforcement mechanism exists yet) ──────
  const missedCandidateFindings = stage2Result.missedCandidates.map((mc) => mc.finding).filter(Boolean);
  const unionEnvelopes = [
    ...stage2Result.verified,
    ...stage2Result.reversed,
    ...workItems.humanQueueDirect,
  ];
  const findings = [
    ...unionEnvelopes.map(flattenEnvelopeToFinding),
    ...missedCandidateFindings.map(flattenEnvelopeToFinding),
  ];

  // ── Verdict (shared computeAuditVerdict — same function the legacy path uses) ──
  const incomplete = stage2Result.unresolved.length > 0 || stage2Result.cleanRegionFailures.length > 0;
  const verdict = computeAuditVerdict(findings, { incomplete });

  // ── overall_reasoning — deterministic accounting summary, no LLM call ──
  const generatorSummary = (ctx.generatorOutcomes || [])
    .map((o) => `${o.model} (${o.role}): ${o.status}${o.findingCount != null ? ` — ${o.findingCount} findings` : ''}`)
    .join('\n');
  const overall_reasoning = [
    `**Discovery portfolio**:\n${generatorSummary || 'n/a'}`,
    `**Stage 0**: ${stage0Verified.length} verified / ${envelopes.length - stage0Verified.length} rejected (local telemetry only)`,
    `**Stage 1**: ${triageResult.mechanicalDismissed.length} mechanical_dismissed, ${triageResult.escalated.length} escalated, ${triageResult.confirmedSurvivor.length} confirmed_survivor (direct to human queue)`,
    `**Stage 2**: ${stage2Result.verified.length} verified, ${stage2Result.reversed.length} reversed, ${stage2Result.confirmedDismissal.length} confirmed_dismissal, ${stage2Result.missedCandidates.length} missed_candidate, ${stage2Result.unresolved.length} pending_adjudication`,
  ].join('\n\n');

  // ── _suppression — the tiered pipeline's OWN accounting, not suppressReRaises ──
  const _suppression = {
    stage1MechanicalDismissed: triageResult.mechanicalDismissed.length,
    stage2ConfirmedDismissal: stage2Result.confirmedDismissal.length,
  };

  // ── _usage/_cacheMetrics — reuse Cluster-B-built cost-budget.mjs (existing, pure) ──
  const costReport = computeCostReport({ usageEvents: [], reviewEffortEvents: [], acceptedFindings: findings });

  const _pass_timings = {
    discovery: `${(discoveryLatencyMs / 1000).toFixed(1)}s`,
    stage0: `${(stage0LatencyMs / 1000).toFixed(1)}s`,
    stage1: `${(stage1LatencyMs / 1000).toFixed(1)}s`,
    stage2: `${(stage2LatencyMs / 1000).toFixed(1)}s`,
    total: `${((Date.now() - stageStart.discovery) / 1000).toFixed(1)}s`,
  };

  return {
    verdict,
    // No tiered-pipeline equivalent to the legacy structure/wiring/dead-code
    // passes (a bug-finding fan-out, not the legacy path's dedicated GPT
    // passes those fields are sourced from) — explicitly zeroed/empty, never
    // silently defaulted (the CLI presentation layer prints a one-line
    // disclaimer whenever runStatus !== 'fallback_legacy' on this branch).
    files_planned: 0,
    files_found: 0,
    files_missing: 0,
    code_files: ctx.changedFiles || [],
    findings,
    wiring_issues: [],
    quick_fix_warnings: findings.filter((f) => f.is_quick_fix).map((f) => f.detail).filter(Boolean),
    dead_code: [],
    overall_reasoning,
    _pass_timings,
    _usage: costReport,
    _cacheMetrics: { totalInputTokens: 0, totalCachedTokens: 0, hitRate: 0, estimatedSavingsPct: 0, seedUsed: false, perPass: {} },
    _toolCapability: { toolsAvailable: [], toolsFailed: [], strictLint: false, disabled: true, timestamp: Date.now() },
    _sid: ctx.runId || `tiered-${Date.now()}`,
    generatorOutcomes: ctx.generatorOutcomes || [],
    runStatus: 'complete',
    _suppression,
    pendingAdjudicationItems: stage2Result.unresolved.map((e) => e.candidateId).filter(Boolean),
  };
}
