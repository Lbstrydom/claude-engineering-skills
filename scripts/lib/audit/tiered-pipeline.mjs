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
 * **Stage 2 adapters (wired 2026-07-13, Close-out shadow-validation flip)**:
 * `ctx.providers.geminiReviewCall` + `.geminiCleanRegionCall` carry Phase
 * 12's REAL subprocess adapters (`createGeminiReviewSubprocessAdapters`,
 * constructed once in `buildAuditRunContext` when `pipelineEnabled` OR
 * `shadowEnabled`). TWO handles because `runFinalAdjudication`'s adapters
 * have different signatures — `reviewCall(envelope)` vs
 * `cleanRegionCall(file)` — the earlier single-handle design threaded one
 * function into both roles, which could never have worked. The fail-fast
 * below still throws a clear configuration error if either handle is
 * missing — never a silently-fabricated verdict.
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
 * **File layout (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md,
 * god-module decomposition)**: this file is now a shrunk orchestrator —
 * stage routing only, plus the final `AuditRunResultSchema` assembly. The
 * concerns it used to carry inline now live in dedicated siblings:
 * `discovery-prompts.mjs` (prompt/schema construction), `tiered-provider-
 * calls.mjs` (provider invocation — the discovery generator factories, the
 * Stage 1 triager adapters, and the Stage-2 usage-metering wrapper),
 * `tiered-model-selection.mjs` (Stage-1 triager model selection policy),
 * `discovery-fallback.mjs` (`TieredUnavailableError` + required-generator-
 * failure/never-ran-a-generator result shapes), `discovery-diff-scope.mjs`
 * (diff-path scope + sensitive-path filtering), `stage0-relevance-context.mjs`
 * (evidence/file-read caching + adapters), `stage0-debt-routing.mjs`
 * (pre-existing-independent → debt-ledger routing), and `cost-budget.mjs`
 * (`buildUsageBlock`, colocated with the `computeCostReport` it wraps).
 *
 * @module scripts/lib/audit/tiered-pipeline
 */

import { readFilesAsContext } from '../file-io.mjs';
import { redactSecrets } from '../sensitive-egress-gate.mjs';
import { formatSkipLog } from '../sensitive-paths.mjs';
import { prepareCandidates } from './diff-path-map.mjs';
import { boundMalformedDetails } from './malformed-details.mjs';
import { processFindings, computeAuditVerdict } from './findings-pipeline.mjs';
import { mergeIntoEnvelopes, flattenEnvelopeToFinding } from './candidate-envelope.mjs';
import { runStage0EvidenceTriage, resolveScopeBucketForFinding } from './evidence-triage.mjs';
import { runStage1CheapTriage } from './stage1-triage.mjs';
import { runFinalAdjudication, selectFinalAdjudicationWorkItems } from './final-adjudication.mjs';
import { runDiscoveryPortfolio } from './discovery-portfolio.mjs';
import { resolveGptTrigger } from './gpt-sentinel-trigger.mjs';
import { buildUsageBlock } from './cost-budget.mjs';
import { tryBuildUsageEvent } from './usage-event.mjs';
import { tieredAuditConfig, openaiConfig } from '../config.mjs';
import { getOssOperationPolicy, getStage1TriageBudget, calculateWorstCaseAttemptDuration } from '../oss-call-policy.mjs';
import { buildDiscoveryContract } from './discovery-prompts.mjs';
import { createGlmDiscoveryCall, createSonnetDiscoveryCall, wrapWithUsageMetering } from './tiered-provider-calls.mjs';
import { selectStage1TriagerCall } from './tiered-model-selection.mjs';
import { failRequiredGenerator, skippedNoGeneratorResult } from './discovery-fallback.mjs';
import { resolveEligibleDiffPathMap } from './discovery-diff-scope.mjs';
import { buildStage0RelevanceContext, makeHeadContentAdapter, makeImpactAdapter, makeBlameAdapter } from './stage0-relevance-context.mjs';
import { routePreExistingIndependent } from './stage0-debt-routing.mjs';

/**
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @returns {Promise<import('../schemas.mjs').AuditRunResult>}
 */
export async function runTieredAuditPipeline(ctx) {
  const stageStart = { discovery: Date.now() };
  const { providers = {} } = ctx;

  // ── Per-run usage/cost capture (2026-07-22 item 2b) ─────────────────────
  // Every stage's provider call already RETURNS token usage; it was just
  // dropped. Each call closure below records into this array via `recordUsage`,
  // and the result assembly prices it (`buildUsageBlock`). Purely in-memory —
  // `tryBuildUsageEvent`/`computeCostReport` are pure, no store writes — so this
  // is shadow-safe by construction (a shadow run must not touch persistent
  // stores; see buildShadowCtx in tiered-shadow-compare.mjs). Fail-open:
  // `tryBuildUsageEvent` returns null on any malformed input, so a usage-shape
  // surprise can never abort the audit.
  const usageEvents = [];
  let usageEventsDropped = 0;
  const recordUsage = (raw) => {
    const ev = tryBuildUsageEvent(raw, new Date().toISOString());
    if (ev) { usageEvents.push(ev); return; }
    // Fail-open, but NOT silent: a dropped event means a malformed/unknown
    // usage shape reached capture. Count it (surfaced on `_usage` as
    // `droppedUsageEventCount` so the cost under-count is visible, not just
    // absent) AND log it, so a SYSTEMATIC capture failure — which would make
    // costUsd read as if less was spent — is diagnosable rather than invisible.
    usageEventsDropped += 1;
    process.stderr.write(`  [tiered-pipeline] usage capture dropped an event (provider=${raw?.provider ?? '?'}, model=${raw?.resolvedModel ?? '?'})\n`);
  };

  // audit-code fix H12/M10 (Cluster E round 1): the original draft let the
  // tiered pipeline run to completion with the Stage 2 adapters absent —
  // candidates would then silently degrade to `unresolved`/
  // `cleanRegionFailures` deep inside `runFinalAdjudication`, one call at a
  // time, rather than the run failing fast with one clear cause. This must
  // be a loud configuration error, not hundreds of quietly-unresolved
  // candidates. BOTH handles are required (2026-07-13 shadow-wiring fix:
  // reviewCall(envelope) and cleanRegionCall(file) have different
  // signatures — one function cannot serve both roles).
  if (typeof providers.geminiReviewCall !== 'function' || typeof providers.geminiCleanRegionCall !== 'function') {
    throw new Error(
      'runTieredAuditPipeline: ctx.providers.geminiReviewCall and ' +
      '.geminiCleanRegionCall must both be functions — the tiered pipeline\'s ' +
      'Stage 2 mandatory Gemini adjudication gate cannot run without them. ' +
      'buildAuditRunContext wires both automatically when ' +
      'AUDIT_TIERED_PIPELINE_ENABLED or AUDIT_TIERED_SHADOW_ENABLED is true; ' +
      'tests supply them explicitly.'
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
  // require a content-verifiable `quote`, per the producer finding contract)
  // without ever seeing the code. Reusing `readFilesAsContext` (the SAME
  // sensitive-egress-gated helper every other pass in
  // `legacy-production-audit.mjs` already uses) rather than inventing a
  // second context-assembly path.
  const discoveryCode = readFilesAsContext(ctx.changedFiles || [], { maxPerFile: 8000, maxTotal: 100000 });

  // The discovery payload's OTHER half. `discoveryCode` above is redacted by
  // `readFilesAsContext`'s `redact: true` default — `planContent` had NO
  // redaction path at all, and it is interpolated raw into BOTH generator
  // prompts. That asymmetry was the single largest cause of tiered-shadow
  // failure: 15 of 41 fallbacks (36%) were `[egress-gate] refusing to send
  // oss:discovery-glm payload ... secret pattern(s) detected: pem-private-key,
  // dsn-password` — the fail-closed gate at the OSS adapter boundary correctly
  // refusing an unredacted payload.
  //
  // Root-caused 2026-07-16 by scanning every committed doc with the gate's own
  // scanner: 7 plans trip it, and the exact pattern pair the gate reported
  // matches `docs/plans/discovery-portfolio-secret-redaction.md` — the plan
  // FOR the secret-redaction feature, which necessarily quotes the secret shapes
  // it exists to redact. A plan is prose (its secret-shaped content is
  // illustrative, never a live credential), so redacting it costs the generator
  // nothing real; leaving it raw cost us a third of the experiment.
  //
  // Same `redactSecrets` the file path already uses, so the two halves of one
  // payload can no longer disagree — and it is fail-closed (a redactor throw
  // yields '[REDACTED:redaction-failed]', never the raw text). The egress gate
  // stays exactly as-is: this fixes the redact-once upstream failure the gate's
  // own error message names, rather than weakening the gate.
  const discoveryPlan = redactSecrets(ctx.planContent ?? '');

  // ── The diff-path map — built BEFORE any generator call (§7j) ────────────
  // The contract `EvidenceAnchorSchema.diffPathId` has described since day one
  // ("from the diff-path map") and which never existed, so models invented an
  // id and Stage 0 destroyed their findings as `fabricated` (4/4 measured;
  // stage0Verified > 0 in 1 of 62 completed shadow runs).
  //
  // SOURCE — `ctx.diffText`, not `discoveryCode`. The plan's §Security says
  // "built from the already-redacted `discoveryCode`/`ctx.diffText`", conflating
  // two different things: `discoveryCode` is `readFilesAsContext` output (fenced
  // FILE CONTENTS — it has no `diff --git` headers at all, so the map cannot be
  // built from it), while the map's whole job is to enumerate the diff's
  // file-PAIRS and their fileStatus. `ctx.diffText` is also what Stage 0 verifies
  // anchors against, so deriving ids from anything else would let the two halves
  // disagree — the exact failure the redact-once note above documents. The
  // load-bearing half of that constraint holds: this is ctx state, NEVER re-read
  // from git.
  const { map: diffPathMap, skipped: mapSkipped } = resolveEligibleDiffPathMap(ctx.diffText);
  if (mapSkipped.length > 0) {
    for (const line of formatSkipLog(mapSkipped, { logger: 'diff-path-map' })) process.stderr.write(`  ${line}\n`);
  }

  if (diffPathMap.kind === 'invalid'
    && (diffPathMap.reason === 'discovery_map_exceeds_budget' || diffPathMap.reason === 'undecodable_diff_header')) {
    // §8a: bounded by a NAMED FAILURE, not by truncation (which would make real
    // changed files unauditable while reporting success) and not by partitioning
    // (deferred — no current requirement, and it changes recall). Reuses §1.5's
    // existing required-generator-failure semantics verbatim.
    // `undecodable_diff_header` (docs/plans/refactor-evidence-integrity.md
    // §4.2) joins this branch for the SAME reason: without it, the new reason
    // would fall to the generic `kind !== 'ready'` branch below —
    // `skippedNoGeneratorResult`'s "nothing to audit" shape — which is false:
    // there IS a changed file, it just can't be cited. Legacy CAN audit it.
    return await failRequiredGenerator(
      ctx,
      `required generator failed: discovery-map ${diffPathMap.reason} — ${diffPathMap.detail}`,
      [...(ctx.generatorOutcomes || [])],
    );
  }
  if (diffPathMap.kind !== 'ready') {
    // `z.enum([])` is not constructible, so this MUST resolve before any schema
    // is built — and skipping the generators entirely is the point, not a
    // side-effect: there is no id set for them to cite.
    return skippedNoGeneratorResult(ctx, diffPathMap, stageStart.discovery);
  }

  // ONE source for both the prompt table and the schema enum (D7), so they
  // cannot drift — built once, handed to both discovery generator factories.
  const contract = buildDiscoveryContract(diffPathMap);

  const glmModel = tieredAuditConfig.discoveryModel;
  const glmCall = createGlmDiscoveryCall({ providers, model: glmModel, contract, discoveryPlan, discoveryCode, recordUsage });
  const sonnetCall = createSonnetDiscoveryCall({ providers, ctx, contract, discoveryPlan, discoveryCode, recordUsage });

  const discoveryAdapters = { glmCall, sonnetCall, gptCall: null };
  const { findings: rawFindings, requiredGeneratorFailed } = await runDiscoveryPortfolio(ctx, discoveryAdapters, triggerDecision);
  const discoveryLatencyMs = Date.now() - stageStart.discovery;

  if (requiredGeneratorFailed) {
    // audit-plan fix M2 (round 3): capture BEFORE delegating — the legacy
    // path's own generatorOutcomes:[] would otherwise silently overwrite the
    // discovery attempt that JUST happened.
    const discoveryGeneratorOutcomes = [...(ctx.generatorOutcomes || [])];
    const failedNames = discoveryGeneratorOutcomes.filter((o) => o.role === 'required' && o.status === 'failed').map((o) => `${o.model}: ${o.category ? `[${o.category}] ` : ''}${o.errorMessage ?? 'unknown error'}`);
    const reason = `required generator failed: ${failedNames.join('; ') || 'unknown'}`;
    return await failRequiredGenerator(ctx, reason, discoveryGeneratorOutcomes);
  }

  // ── prepareCandidates — the untrusted producer boundary (D6, §7g) ────────
  // THE seam between an untrusted provider response and Stage 0, and it runs
  // BEFORE Stage 0 for both generators. It safeParses the producer DTO before
  // touching any field, then hydrates `oldFile`/`newFile`/`fileStatus` from our
  // own map — so the path-shaped causes that made Stage 0 destroy 4/4 real
  // findings are unreachable from a hydrated anchor, by construction rather
  // than by taxonomy (D2).
  //
  // Per-finding and non-throwing: one malformed candidate degrades ITSELF,
  // never the batch. Only `kind:'ready'` continues.
  const prepared = prepareCandidates(rawFindings, diffPathMap, {
    producerSchema: contract.producerFindingSchema,
    headSha: ctx.commitSha || 'WORKTREE',
  });
  const readyFindings = prepared.filter((p) => p.kind === 'ready').map((p) => p.finding);
  // THREE buckets, because there are three owners (§7a). Never blend
  // `contradicted` into `malformed`: a side claim the diff DISPROVES is the
  // model's error, and billing it to our contract is this plan's own
  // misattribution running backwards.
  const malformedRaw = prepared.filter((p) => p.kind === 'malformed');
  const contradictedRaw = prepared.filter((p) => p.kind === 'contradicted');
  if (malformedRaw.length > 0) {
    // Same loud convention as the Stage 0 tripwire below (§7c) — a candidate our
    // own contract couldn't parse is OUR bug, and it used to vanish into
    // `stage0Rejected` where it read as the model hallucinating.
    const byReason = malformedRaw.reduce((acc, m) => {
      acc[m.reasonCode] = (acc[m.reasonCode] || 0) + 1;
      return acc;
    }, {});
    // Aggregate the FIELD-level detail too, not just the reasonCode. Every DTO
    // rejection shares one code (`producer_dto_invalid`), so the code alone says
    // "our contract broke" without saying WHERE — which forces a live repro to
    // diagnose, the exact cost §7c's loud rule exists to remove. Found
    // 2026-07-18 by the acceptance probe: 5/7 candidates rejected, and the code
    // alone could not distinguish a length-cap overflow from a genuine shape bug.
    const byDetail = malformedRaw.reduce((acc, m) => {
      const key = m.reasonDetail || '(no detail)';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    process.stderr.write(
      `  [discovery] CONTRACT BUG — ${malformedRaw.length}/${rawFindings.length} RAW candidate(s) rejected at the producer boundary, not by evidence. `
      + `These are not model fabrications. Reasons: ${JSON.stringify(byReason)} Detail: ${JSON.stringify(byDetail)}\n`,
    );
  }
  if (contradictedRaw.length > 0) {
    // NOT a contract bug — the diff refuted a checkable model claim. Reported
    // at a lower volume precisely because it is working as designed.
    process.stderr.write(
      `  [discovery] ${contradictedRaw.length}/${rawFindings.length} RAW candidate(s) CONTRADICTED by the diff (model evidence failure, not our bug).\n`,
    );
  }

  // ── processFindings (pure, unchanged) → mergeIntoEnvelopes (pure, unchanged) ──
  const taggedFindings = readyFindings.map((f) => ({ ...f, _sourceModel: f._sourceModel || 'unknown' }));
  const { survivors } = processFindings(taggedFindings, {
    ledger: null, // Stage 0-2's own envelope/ledger sequence IS the re-raise-suppression mechanism for this branch
    planContent: ctx.planContent,
    changedFiles: ctx.changedFiles,
  });
  const envelopes = survivors.length > 0 ? mergeIntoEnvelopes(survivors) : [];

  // ── Stage 0 — deterministic triage ─────────────────────────────────────
  const stage0Start = Date.now();
  const stage0RelevanceContext = await buildStage0RelevanceContext(ctx, envelopes);
  const { verified: stage0Verified, preExistingIndependent, rejected: stage0Rejected, malformed: stage0Malformed } = runStage0EvidenceTriage(
    envelopes, { diffText: ctx.diffText },
    {
      blameAdapter: makeBlameAdapter(stage0RelevanceContext, ctx.auditBaseCommit),
      impactAdapter: makeImpactAdapter(stage0RelevanceContext),
      headContentAdapter: makeHeadContentAdapter(stage0RelevanceContext),
    },
  );
  // LOUD on any malformed candidate (evidence-anchor-path-contract §7c): a
  // candidate our own contract couldn't parse is OUR bug, and it previously
  // vanished into `stage0Rejected` where it read as the model hallucinating.
  // stderr only — the shadow is observation-only and must never gate a build
  // (openai-audit.mjs:427), so this never touches the exit code.
  if (stage0Malformed.length > 0) {
    const byReason = stage0Malformed.reduce((acc, env) => {
      const d = env.stageDecisions[env.stageDecisions.length - 1];
      const key = d?.reasonDetail ?? d?.reasonCode ?? 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    process.stderr.write(
      `  [stage0] CONTRACT BUG — ${stage0Malformed.length}/${envelopes.length} candidate(s) rejected as MALFORMED by our own schema, not by evidence. `
      + `These are not model fabrications. Reasons: ${JSON.stringify(byReason)}\n`,
    );
  }

  const { eligible: restoredFromDebtRouting, debtRoutedFiles, debtRoutingIncomplete } = await routePreExistingIndependent(preExistingIndependent, ctx);
  const stage0EligibleForStage1 = [...stage0Verified, ...restoredFromDebtRouting];
  // Stage 0 routing manifest (decision #8) — built from every envelope that
  // survived Gate A, whether or not it was later successfully debt-routed (a
  // debt-routing FAILURE restores the candidate to the eligible pool with
  // its scopeBucket UNCHANGED — decision #9's "not a routed one" framing —
  // so its manifest entry must still resolve correctly downstream).
  const stage0RoutingManifest = new Map();
  for (const env of [...stage0Verified, ...preExistingIndependent]) {
    stage0RoutingManifest.set(env.fingerprint, env.scopeBucket ?? 'change_related');
  }
  const stage0LatencyMs = Date.now() - stage0Start;

  // ── Stage 1 — cheap-model triage ───────────────────────────────────────
  const stage1Start = Date.now();
  const triagerCall = selectStage1TriagerCall({ tieredAuditConfig, providers, recordUsage, openaiConfig });
  // Resolve BOTH the Stage-1 admission budget AND the per-candidate
  // worst-case duration HERE (docs/plans/oss-call-reliability-hardening.md
  // round-3 M1 + Gemini-round-1 G2): this orchestrator is the only component
  // that knows both that it's running under runShadowTieredPipeline's
  // 20-minute race AND that its triager uses the OSS/stage1_triage policy
  // specifically — runStage1CheapTriage stays a fully decoupled, reusable
  // component that never imports OSS-policy internals itself.
  const stage1AdmissionBudgetMs = getStage1TriageBudget();
  const stage1CandidateWorstCaseMs = calculateWorstCaseAttemptDuration(getOssOperationPolicy('stage1_triage'));
  const triageResult = await runStage1CheapTriage(stage0EligibleForStage1, { triagerCall }, {
    ledgerPath: ctx.ledgerFile,
    round: ctx.round,
    // audit-orchestrator-hardening Phase 8: required by buildStageOneTriageInput
    // (no default/no cwd-fallback inside that function itself — the INC-001
    // symlink-bypass class). This orchestrator-level `process.cwd()` mirrors
    // the SAME pattern `runArchitecturePass` already uses in the legacy path.
    repoRoot: process.cwd(),
    admissionBudgetMs: stage1AdmissionBudgetMs,
    candidateWorstCaseMs: stage1CandidateWorstCaseMs,
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
  // Both validated as functions by the fail-fast at the top of this run —
  // distinct handles because the two adapter signatures differ
  // (reviewCall(envelope) vs cleanRegionCall(file)). Wrapped to meter the
  // subprocess cost: the adapters now surface `_usage`/`_model` (from the
  // gemini-review `--out` JSON), capture it here, pass the verdict through
  // unchanged (runFinalAdjudication reads only `.verdict`).
  const reviewCall = wrapWithUsageMetering(providers.geminiReviewCall, recordUsage);
  const cleanRegionCall = wrapWithUsageMetering(providers.geminiCleanRegionCall, recordUsage);
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
  // Provenance + scope-bucket resolution (decision #8, round-3 H6's
  // deferred "exact call site" — resolved HERE, the single place envelopes
  // become findings, against the Stage 0 routing manifest built above).
  // Every envelope-derived finding carries its own fingerprint as its sole
  // origin — Stage 1/2 never merge multiple Stage-0 candidates into one
  // envelope in this pipeline (mergeIntoEnvelopes already performed the
  // one-and-only candidate-identity merge, upstream of Stage 0); a Stage-2
  // clean-region `missed_candidate` finding has no Stage 0 origin at all
  // and falls through to the resolver's safe `change_related` default.
  const findings = [
    ...unionEnvelopes.map((env) => ({
      ...flattenEnvelopeToFinding(env),
      _originCandidateIds: [env.fingerprint],
      scopeBucket: resolveScopeBucketForFinding([env.fingerprint], stage0RoutingManifest),
    })),
    ...missedCandidateFindings.map((f) => ({
      ...flattenEnvelopeToFinding(f),
      _originCandidateIds: [],
      scopeBucket: resolveScopeBucketForFinding([], stage0RoutingManifest),
    })),
  ];

  // ── Verdict (shared computeAuditVerdict — same function the legacy path uses) ──
  const incomplete = stage2Result.unresolved.length > 0 || stage2Result.cleanRegionFailures.length > 0;
  const verdict = computeAuditVerdict(findings, { incomplete });

  // ── overall_reasoning — deterministic accounting summary, no LLM call ──
  const generatorSummary = (ctx.generatorOutcomes || [])
    // durationMs is what makes a timeout diagnosable at a glance ("did it
    // exhaust the budget, or die early?") — omitted when absent rather than
    // rendered as 0, which would read as an instant call.
    .map((o) => `${o.model} (${o.role}): ${o.status}${o.findingCount != null ? ` — ${o.findingCount} findings` : ''}${o.durationMs != null ? ` [${(o.durationMs / 1000).toFixed(1)}s]` : ''}`)
    .join('\n');
  const overall_reasoning = [
    `**Discovery portfolio**:\n${generatorSummary || 'n/a'}`,
    `**Producer boundary**: ${rawFindings.length} raw findings, ${malformedRaw.length} malformed — OUR contract bug, not the model (raw units; never summed with Stage 0's envelope-unit tripwire below)`,
    `**Stage 0**: ${stage0Verified.length} verified, ${preExistingIndependent.length} pre_existing_independent (${debtRoutedFiles.length} files debt-routed, ${debtRoutingIncomplete.length} restored to eligible pool), ${stage0Rejected.length} rejected — model evidence failure, ${stage0Malformed.length} malformed — OUR contract bug, not the model (both local telemetry only)`,
    `**Stage 1**: ${triageResult.mechanicalDismissed.length} mechanical_dismissed, ${triageResult.escalated.length} escalated, ${triageResult.confirmedSurvivor.length} confirmed_survivor (direct to human queue), ${triageResult.budgetExhausted.length} budget_exhausted (not reviewed this round)`,
    `**Stage 2**: ${stage2Result.verified.length} verified, ${stage2Result.reversed.length} reversed, ${stage2Result.confirmedDismissal.length} confirmed_dismissal, ${stage2Result.missedCandidates.length} missed_candidate, ${stage2Result.unresolved.length} pending_adjudication`,
  ].join('\n\n');

  // ── _suppression — the tiered pipeline's OWN accounting, not suppressReRaises ──
  const _suppression = {
    stage1MechanicalDismissed: triageResult.mechanicalDismissed.length,
    stage2ConfirmedDismissal: stage2Result.confirmedDismissal.length,
  };

  // ── _usage/_cacheMetrics — real per-stage cost from captured usage events ──
  // `usageEvents` was accumulated across discovery + Stage 1 + Stage 2 via the
  // `recordUsage` sink below (2026-07-22 item 2b: this used to be a hardcoded
  // `[]`, so `costUsd` was a meaningless confirmed $0). `buildUsageBlock`
  // reports the real priced sum, or honest `null` if nothing could be priced.
  const costReport = buildUsageBlock(usageEvents, findings, usageEventsDropped);

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
    // Decision #9 — the set of files whose successfully-debt-routed
    // pre_existing_independent candidates originated from (decision #10
    // needs this to avoid double-penalizing the tiered pipeline in shadow
    // comparisons), and the structured per-fingerprint reasons for any
    // candidate that FAILED debt-routing and was restored to the eligible
    // pool instead (never a bare boolean — round-2 plan-audit H5).
    debtRoutedFiles,
    debtRoutingIncomplete,
    // Structured mirror of `overall_reasoning` above (2026-07-15): that
    // string is the ONLY place these per-stage counts existed, and
    // compareAuditRunResults persists neither it nor generatorOutcomes into
    // the shadow-log/DB record — a `complete` shadow run with 0 findings is
    // otherwise undiagnosable after the fact (can't tell "both generators
    // found nothing" from "candidates existed but Stage 0/1/2 dropped them
    // all" without a live repro). Every count is set unconditionally
    // (0 when nothing happened at that stage), same convention as
    // _stage1BudgetExhausted below.
    _stageBreakdown: {
      discoveryRawFindings: rawFindings.length,
      // The PRIMARY malformed counter (§7a): raw findings `prepareCandidates`
      // rejected at the producer boundary, before envelopes exist.
      //
      // NEVER sum this with `stage0MalformedTripwire` below — they are DIFFERENT
      // UNITS and a blended figure is forbidden (§7a, Gemini G2). This counts RAW
      // findings; the tripwire counts ENVELOPES, and `mergeIntoEnvelopes` dedups
      // raw findings by fingerprint, so the two cannot be added. A number that
      // reads meaningful and cannot be reconciled is exactly the kind this plan
      // exists to remove.
      //
      // Raw-level invariant: discoveryMalformedRaw + discoveryContradictedRaw +
      // (raw findings contributing to envelopes) === discoveryRawFindings.
      discoveryMalformedRaw: malformedRaw.length,
      // WS-E2 leg (b). The COUNT above says how many; it cannot say which SHAPE,
      // so until now a malformed window could only be diagnosed from a live
      // repro — which is precisely what the 2026-07-14 incident cost. The
      // consumer (`tiered-shadow-compare.mjs`) has always READ this key; nothing
      // ever wrote it, so the field the Phase-14 window reads was permanently
      // null and `?? null` made "never written" indistinguishable from "absent
      // this run".
      //
      // Three states, and keeping them distinct IS the fix:
      //   null → nothing wrote it (pre-field row, or a run that never got here)
      //   []   → this run WAS measured and had no malformed anchors
      //   [..] → measured, and these are the bounded reasons
      // So this writes `[]` rather than omitting on the zero case. The
      // never-ran fallback path deliberately does NOT set the key at all (see
      // the early-return `_stageBreakdown`), because there a zero would claim a
      // measurement that never happened.
      discoveryMalformedReasons: boundMalformedDetails(malformedRaw, rawFindings),
      // A model claim the diff DISPROVES — the model's error, NOT our contract
      // bug. Reported separately for the same reason `malformed` was split out
      // of `rejected` in the first place: blending the two owners is what let a
      // 100%-schema-rejection run read as 100% model hallucination. Folding
      // this into `discoveryMalformedRaw` would invert that same mistake.
      discoveryContradictedRaw: contradictedRaw.length,
      // stage0Verified reports the ACTUAL Stage-1-eligible pool size (Gate-A
      // 'change_related'/'unverifiable' survivors PLUS any pre_existing_
      // independent candidate restored after a debt-routing failure) — the
      // number that matters for shadow-comparison purposes (Cluster C reads
      // this as `tieredStage0Verified`), not just the raw Gate-A bucket.
      stage0Verified: stage0EligibleForStage1.length,
      stage0Rejected: stage0Rejected.length,
      // Split out of stage0Rejected (evidence-anchor-path-contract §7a):
      // envelope-unit count of candidates OUR OWN contract could not parse.
      // Distinct from stage0Rejected (model evidence failures) because the two
      // have different owners — blending them is what let a 100%-schema-
      // rejection run read as 100% model hallucination for weeks.
      // NOTE the unit: this is the Stage-0 TRIPWIRE (envelopes). The primary
      // pre-envelope hydration counter (`discoveryMalformedRaw`, raw units)
      // arrives with Cluster B; the two are never summed (§7a).
      stage0MalformedTripwire: stage0Malformed.length,
      stage0PreExistingIndependent: preExistingIndependent.length,
      stage0DebtRouted: debtRoutedFiles.length,
      stage0DebtRoutingIncomplete: debtRoutingIncomplete.length,
      stage1MechanicalDismissed: triageResult.mechanicalDismissed.length,
      stage1Escalated: triageResult.escalated.length,
      stage1ConfirmedSurvivor: triageResult.confirmedSurvivor.length,
      stage1BudgetExhausted: triageResult.budgetExhausted.length,
      stage2Verified: stage2Result.verified.length,
      stage2Reversed: stage2Result.reversed.length,
      stage2ConfirmedDismissal: stage2Result.confirmedDismissal.length,
      stage2MissedCandidate: stage2Result.missedCandidates.length,
      stage2Unresolved: stage2Result.unresolved.length,
    },
    pendingAdjudicationItems: stage2Result.unresolved.map((e) => e.candidateId).filter(Boolean),
    // Typed Stage-1 telemetry (docs/plans/oss-call-reliability-hardening.md
    // round-3 H1/H2), directly mirroring the existing _stage2BudgetExhausted
    // shape — set unconditionally (0/[] when nothing was skipped/classified,
    // never omitted) so a consumer never has to distinguish "absent" from
    // "zero". compareAuditRunResults (tiered-shadow-compare.mjs) copies both
    // into the persisted shadow-log record.
    _stage1BudgetExhausted: {
      count: triageResult.skippedBudgetExhaustedCount,
      itemIds: triageResult.budgetExhausted.map((e) => e.candidateId).filter(Boolean),
    },
    _stage1FailureCategories: triageResult.failureCategories,
  };
}
