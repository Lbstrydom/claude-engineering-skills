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
 * @module scripts/lib/audit/tiered-pipeline
 */

import path from 'node:path';
import { z } from 'zod';
import { makeProducerFindingV3Schema, clampToJsonSchemaLimits } from '../schemas.mjs';
import { readFilesAsContext, safeReadFile } from '../file-io.mjs';
import { redactSecrets } from '../sensitive-egress-gate.mjs';
import { shouldSkipForIndexing, formatSkipLog, normalisePath } from '../sensitive-paths.mjs';
import { buildDiffPathMap, renderDiffPathTable, prepareCandidates } from './diff-path-map.mjs';
import { boundMalformedDetails } from './malformed-details.mjs';
import { processFindings, computeAuditVerdict } from './findings-pipeline.mjs';
import { mergeIntoEnvelopes, flattenEnvelopeToFinding } from './candidate-envelope.mjs';
import { runStage0EvidenceTriage, resolveScopeBucketForFinding } from './evidence-triage.mjs';
import { runStage1CheapTriage } from './stage1-triage.mjs';
import { runFinalAdjudication, selectFinalAdjudicationWorkItems } from './final-adjudication.mjs';
import { runDiscoveryPortfolio } from './discovery-portfolio.mjs';
import { resolveGptTrigger } from './gpt-sentinel-trigger.mjs';
import { computeCostReport } from './cost-budget.mjs';
import { callGPT } from './llm-helpers.mjs';
import { tieredAuditConfig } from '../config.mjs';
import { resolveModel } from '../model-resolver.mjs';
import { resolveStage1TriagerModel } from './stage1-triager-resolver.mjs';
import { getOssOperationPolicy, getStage1TriageBudget, calculateWorstCaseAttemptDuration } from '../oss-call-policy.mjs';
import { contentExistsAtMappedRange, gitShowFileAtRevision } from '../vcs.mjs';
import { writeDebtEntries } from '../debt-ledger.mjs';
import { buildDebtEntry } from '../debt-capture.mjs';
import { getFreshImportersOrNull } from '../store/arch/imports.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';

const Stage1TriagerResponseSchema = z.object({
  dismissalAttempted: z.boolean(),
  disproof: z.string().max(500).nullable(),
});

/**
 * Thrown INSTEAD of falling back to a second legacy audit when a required
 * discovery generator fails on a SHADOW run (`ctx.shadowMode`).
 * Plan: docs/plans/shadow-no-legacy-fallback.md decision #3.
 *
 * Carries `.reason` ONLY — deliberately not `generatorOutcomes` (round-2
 * plan-audit M4): `discovery-portfolio.mjs` mutates `ctx.generatorOutcomes`
 * in place and `runShadowTieredPipeline` already holds the `shadowCtx`, so
 * threading them through the exception would be a second, redundant channel
 * for state the catch already has in hand.
 *
 * It exists for exactly two small, real reasons: the shadow's catch can
 * record the clean formatted `.reason` rather than a raw `err.message`, and
 * tests can assert the class instead of regexing a string.
 */
export class TieredUnavailableError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'TieredUnavailableError';
    this.reason = reason;
  }
}

/**
 * RETIRED (evidence-anchor-path-contract Phase 6): `normalizeModifiedAnchorPaths`.
 *
 * It mirrored `oldFile`↔`newFile` across a `'modified'` anchor because
 * `EvidenceAnchorSchema.superRefine` demanded both and GLM only ever sent one.
 * That was a band-aid on the wrong layer: the real defect was ASKING the model
 * for `oldFile`/`newFile`/`fileStatus` at all. They are facts about the diff,
 * not claims about the finding — Gate A always re-verified them against the
 * real diff anyway, i.e. they were never trusted as model input, so asking for
 * them yielded zero information and existed only as a failure surface (plan D1).
 *
 * They are now DERIVED from our own diff-path map by `prepareCandidates`, so
 * there is nothing left to mirror. `clampToJsonSchemaLimits` (the maxLength/
 * maxItems half of the same lenient-ingestion pipe) is RETAINED — OSS routers
 * still accept our JSON Schema without enforcing string/array limits.
 */

/**
 * Resolve this run's diff-path map, with sensitive paths excluded BEFORE the
 * enum and prompt table exist (plan §Security).
 *
 * WHY THIS FILTER IS NOT OPTIONAL: the enum enumerates file paths as
 * first-class, structured, citable ids inside the tool schema. `redactSecrets`
 * masks secret *values*; it does not exclude sensitive *paths*. Without this,
 * a `.env`/`secrets/db.yaml` entry in the diff would be disclosed to the
 * provider as a schema member — a path-level disclosure the redacted payload
 * alone does not imply. A file excluded here simply has no id, so no anchor
 * can cite it.
 *
 * TWO DELIBERATE DEVIATIONS from the plan's §Security prose, both reported:
 *
 * 1. The plan says "filter before mapping, not after". `buildDiffPathMap`
 *    takes diff TEXT, so filtering "before" would mean re-implementing its
 *    parser to split sections — the exact duplication §7i exists to prevent.
 *    Filtering the parsed entries is equivalent for the property that
 *    matters: the enum and table are constructed EXCLUSIVELY from the
 *    filtered set, never from raw diff headers.
 * 2. The plan mandates `resolveAndClassify`'s symlink-aware canonicalisation,
 *    fail-closed on `resolutionFailed`. That is NOT implementable over a diff:
 *    it realpaths, and a `deleted` file (or a rename's `oldPath`) legitimately
 *    does not exist on disk — every one would fail-closed to `sensitive` and
 *    lose its id, silently making deleted files unauditable. We use the
 *    lexical `shouldSkipForIndexing` seam instead, which is exactly the bar
 *    the OTHER half of this same payload already meets (`readFilesAsContext`
 *    → `isSensitiveFile`), and the map discloses only the path string that
 *    check already covers.
 *
 * @param {string|null|undefined} diffText - the run's unified diff (ctx.diffText)
 * @returns {{map: ReturnType<typeof buildDiffPathMap>, skipped: Array<object>}}
 */
/**
 * Return a deep copy of `jsonSchema` with `maxLength` removed from every
 * property named `fieldName`, at any depth.
 *
 * The one consumer is the discovery generators' lenient clamping: clamping is a
 * length-only repair that saves a verbose-but-genuine finding, but it must not
 * touch a field whose VALUE is semantically checked downstream. `quote` is the
 * only such field — Gate A matches it verbatim — so truncating it converts our
 * own repair into a false "the model's evidence was wrong" verdict.
 *
 * Derived from the schema rather than a hardcoded prose-field allowlist, so a
 * new capped field is clamped automatically and cannot drift.
 *
 * Pure; never mutates the input (the strict schema is shared with the GLM path).
 *
 * @param {object} jsonSchema
 * @param {string} fieldName
 * @returns {object}
 */
function stripMaxLengthFor(jsonSchema, fieldName) {
  if (jsonSchema == null || typeof jsonSchema !== 'object') return jsonSchema;
  if (Array.isArray(jsonSchema)) return jsonSchema.map((s) => stripMaxLengthFor(s, fieldName));
  const out = {};
  for (const [key, value] of Object.entries(jsonSchema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const walked = stripMaxLengthFor(propSchema, fieldName);
        if (propName === fieldName && walked && typeof walked === 'object' && !Array.isArray(walked)) {
          const { maxLength, ...rest } = walked;
          props[propName] = rest;
        } else {
          props[propName] = walked;
        }
      }
      out[key] = props;
    } else if (value && typeof value === 'object') {
      out[key] = stripMaxLengthFor(value, fieldName);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolveEligibleDiffPathMap(diffText) {
  const map = buildDiffPathMap(diffText);
  if (map.kind !== 'ready') return { map, skipped: [] };

  const skipped = [];
  const entries = map.entries.filter((e) => {
    // Fail closed on EITHER side: a rename whose base path is `secrets/x` is
    // just as much a disclosure as one whose head path is.
    for (const p of [e.newPath, e.oldPath]) {
      const r = shouldSkipForIndexing(p, ['sensitive']);
      if (r.skip) {
        skipped.push({ path: normalisePath(p), category: r.category, pattern: r.pattern, action: 'dropped' });
        return false;
      }
    }
    return true;
  });

  // Every eligible file filtered out is a legitimate empty scope, NOT invalid
  // — the diff parsed fine, it just has nothing we may send (§7j).
  if (entries.length === 0) return { map: { kind: 'empty', reason: 'no_eligible_diff_files' }, skipped };
  return { map: { kind: 'ready', entries }, skipped };
}

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
  const { result, category, error } = await providers.ossCall({
    model, system, userPrompt,
    // Same stall-class guard as the discovery generator below (the
    // 2026-07-14 OpenRouter stall incident that motivated oss-call-policy
    // was THIS stage-1 path) — route only to hosts that honour our
    // structured-output request.
    providerPreferences: { require_parameters: true },
    schema: Stage1TriagerResponseSchema,
    schemaName: 'stage1_triager_response',
    passName: 'stage1-triager',
    operation: 'stage1_triage',
  });
  // Fix a latent contract bug (docs/plans/oss-call-reliability-hardening.md
  // round-1 H2): this function's own contract says "any failure THROWS,
  // never fabricates a dismissal", but ossStructuredCall normally RETURNS a
  // {result: null, failed: true, ...} shape on retry-exhaustion rather than
  // throwing — so a failed call was silently returning null instead of
  // throwing. `err.category` carries classification through the throw
  // boundary so it can reach the schema-validated Stage-1 decision record.
  if (!result) {
    const err = new Error(`validatedTriagerCall: ossCall failed${error ? ` (${error})` : ''}`);
    err.category = category ?? null;
    throw err;
  }
  return result;
}

// ── Stage 0 relevance-split wiring (docs/plans/stage0-evidence-relevance-split.md) ──

/**
 * Distinct file paths any envelope's evidence anchors (canonical OR
 * alternative) could resolve to — a superset, since Gate A's fallback may
 * promote an alternative whose anchor points at a different file than the
 * canonical claim.
 */
function collectCandidateAnchorFiles(envelopes) {
  const files = new Set();
  const addAnchor = (anchor) => {
    if (!anchor) return;
    const fp = anchor.side === 'base' ? anchor.oldFile : anchor.newFile;
    if (fp) files.add(fp);
  };
  for (const env of envelopes) {
    addAnchor(env.canonicalFinding?.anchor);
    addAnchor(env.canonicalFinding?.triggerAnchor);
    for (const alt of env.evidenceAlternatives || []) {
      addAnchor(alt?.anchor);
      addAnchor(alt?.triggerAnchor);
    }
  }
  return [...files];
}

/**
 * Build the run-scoped caching layer the real `blameAdapter`/`impactAdapter`/
 * `headContentAdapter` closures need (decision #5, round-3 H3's deferred
 * caching-structure spec). Constructed ONCE per pipeline run, BEFORE
 * `runStage0EvidenceTriage` — `impactAdapter` must be fully SYNCHRONOUS
 * (evidence-triage.mjs's `tagPreExisting` calls it with no `await`, an
 * already-tested Cluster A contract this phase does not reopen), but
 * `getFreshImportersOrNull` is an async DB query — so the import-graph
 * independence check for every distinct candidate file is resolved HERE, up
 * front, into a plain sync-lookup Map; the adapter itself never touches the
 * network. `headContentCache`/`baseContentCache` are likewise precomputed
 * per DISTINCT candidate file (never per Gate-B call) — each file's content
 * is read/fetched at most once per run, regardless of how many candidates
 * cite it (tests/tiered-pipeline-wiring.test.mjs asserts the per-run call
 * count directly).
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @param {Array<import('./candidate-envelope.mjs').AuditCandidateEnvelope>} envelopes
 * @returns {Promise<{headContentCache: Map<string,string|null>, baseContentCache: Map<string,string|null>, impactCache: Map<string,boolean|null>}>}
 */
async function buildStage0RelevanceContext(ctx, envelopes) {
  const candidateFiles = collectCandidateAnchorFiles(envelopes);
  const cwdBoundary = path.resolve('.');

  const headContentCache = new Map();
  for (const filePath of candidateFiles) {
    const result = safeReadFile(filePath, cwdBoundary);
    headContentCache.set(filePath, result ? result.content : null);
  }

  const baseContentCache = new Map();
  if (ctx.auditBaseCommit) {
    for (const filePath of candidateFiles) {
      const result = gitShowFileAtRevision(process.cwd(), ctx.auditBaseCommit, filePath);
      baseContentCache.set(filePath, result.ok ? result.content : null);
    }
  }

  const impactCache = new Map();
  let repoUuid = null;
  try {
    repoUuid = resolveRepoIdentity(process.cwd())?.repoUuid ?? null;
  } catch { /* no resolvable repo identity — every impact lookup degrades to null (unknown) */ }
  for (const filePath of candidateFiles) {
    let result = null;
    try {
      result = await getFreshImportersOrNull({
        repoUuid,
        headSha: ctx.commitSha,
        workingTreeDirty: !!ctx.workingTreeDirty,
        filePath,
        changedFiles: ctx.changedFiles || [],
      });
    } catch { result = null; }
    impactCache.set(filePath, result);
  }

  return { headContentCache, baseContentCache, impactCache };
}

function makeHeadContentAdapter(stage0Ctx) {
  return (filePath) => (stage0Ctx.headContentCache.has(filePath) ? stage0Ctx.headContentCache.get(filePath) : null);
}

function makeImpactAdapter(stage0Ctx) {
  return (filePath) => (stage0Ctx.impactCache.has(filePath) ? stage0Ctx.impactCache.get(filePath) : null);
}

function makeBlameAdapter(stage0Ctx, baseRef) {
  return (filePath, startLine, endLine, quote) => {
    if (!baseRef) return null;
    const baseContent = stage0Ctx.baseContentCache.has(filePath) ? stage0Ctx.baseContentCache.get(filePath) : null;
    if (baseContent === null) return null;
    return contentExistsAtMappedRange(
      process.cwd(), filePath, { startLine, endLine }, quote, baseRef,
      { preloadedContent: baseContent },
    );
  };
}

/**
 * Extract the file a `pre_existing_independent` envelope's canonical claim
 * cites — the discovery generator's output contract (the producer finding
 * `canonicalFinding` is shaped by) carries no `affectedFiles`/`_primaryFile`
 * field at all, so this reuses the SAME anchor-file extraction Gate B itself
 * already performs internally. Still true post-V3: the anchor's paths are now
 * DERIVED by `prepareCandidates` rather than model-supplied, but they land in
 * the same `oldFile`/`newFile` fields this reads.
 */
function extractCanonicalAnchorFile(canonicalFinding) {
  const anchorField = canonicalFinding?.evidenceType === 'omission' ? 'triggerAnchor' : 'anchor';
  const anchor = canonicalFinding?.[anchorField];
  if (!anchor) return null;
  return anchor.side === 'base' ? anchor.oldFile : anchor.newFile;
}

const PRE_EXISTING_DEBT_RATIONALE = 'Pre-existing code, independent of this change — Stage 0 evidence-relevance triage (tiered-recall pipeline decision #9) confirmed the cited lines predate the audited commit and no changed file depends on them.';

/**
 * Transform a `pre_existing_independent` envelope into a PersistedDebtEntry
 * payload via the existing `buildDebtEntry` primitive — `deferredReason:
 * 'out-of-scope'` requires no extra conditional fields, matching this
 * fully-automated (no operator-authored rationale) routing path.
 */
function buildPreExistingDebtEntry(envelope, runId) {
  const cf = envelope.canonicalFinding || {};
  const filePath = extractCanonicalAnchorFile(cf);
  const finding = {
    _topicId: envelope.fingerprint,
    _hash: envelope.fingerprint,
    severity: cf.severity,
    category: cf.category,
    section: cf.section,
    detail: cf.detail,
    affectedFiles: filePath ? [filePath] : [],
    affectedPrinciples: cf.principle ? [cf.principle] : [],
    _pass: 'tiered-stage0',
    classification: cf.classification || null,
  };
  const { entry } = buildDebtEntry(finding, {
    deferredReason: 'out-of-scope',
    deferredRationale: PRE_EXISTING_DEBT_RATIONALE,
    deferredRun: String(runId || 'tiered').slice(0, 40),
  });
  return entry;
}

/**
 * Batch-reconciled debt routing (decision #9): build ALL
 * `preExistingIndependent` candidates into debt entries up front (keyed by
 * `fingerprint`/`topicId`) and submit as ONE `writeDebtEntries` batch. Any
 * fingerprint that either (a) throws during the whole-batch write, or (b)
 * appears in the API's own `rejected[]` array, is restored to the Stage-1-
 * eligible pool — never silently dropped. `noDebtLedger`/`readOnlyDebt`
 * (existing CLI flags governing every other debt-ledger interaction in this
 * codebase) short-circuit to the same restore-with-reason path, never a
 * silent write attempt.
 *
 * @returns {Promise<{eligible: Array<object>, debtRoutedFiles: string[], debtRoutingIncomplete: Array<{fingerprint:string, reason:string}>}>}
 */
async function routePreExistingIndependent(preExistingIndependent, ctx) {
  if (preExistingIndependent.length === 0) {
    return { eligible: [], debtRoutedFiles: [], debtRoutingIncomplete: [] };
  }
  if (ctx.noDebtLedger || ctx.readOnlyDebt) {
    return {
      eligible: preExistingIndependent,
      debtRoutedFiles: [],
      debtRoutingIncomplete: preExistingIndependent.map((env) => ({
        fingerprint: env.fingerprint,
        reason: ctx.noDebtLedger ? 'debt_ledger_disabled' : 'debt_ledger_read_only',
      })),
    };
  }

  const entries = preExistingIndependent.map((env) => buildPreExistingDebtEntry(env, ctx.runId));
  let writeResult;
  try {
    writeResult = await writeDebtEntries(entries, ctx.debtLedgerPath ? { ledgerPath: ctx.debtLedgerPath } : {});
  } catch (err) {
    return {
      eligible: preExistingIndependent,
      debtRoutedFiles: [],
      debtRoutingIncomplete: preExistingIndependent.map((env) => ({
        fingerprint: env.fingerprint,
        reason: `writeDebtEntries threw: ${err.message}`,
      })),
    };
  }

  const rejectedByTopicId = new Map((writeResult.rejected || []).map((r) => [r.entry?.topicId, r.reason]));
  const eligible = [];
  const debtRoutedFiles = [];
  const debtRoutingIncomplete = [];
  for (const env of preExistingIndependent) {
    if (rejectedByTopicId.has(env.fingerprint)) {
      eligible.push(env);
      debtRoutingIncomplete.push({ fingerprint: env.fingerprint, reason: rejectedByTopicId.get(env.fingerprint) || 'rejected by writeDebtEntries' });
    } else {
      const filePath = extractCanonicalAnchorFile(env.canonicalFinding);
      if (filePath) debtRoutedFiles.push(filePath);
    }
  }
  return { eligible, debtRoutedFiles: [...new Set(debtRoutedFiles)], debtRoutingIncomplete };
}

/**
 * §1.5's required-generator-failure semantics, in ONE place because there are
 * now two ways to reach them: a generator that actually failed, and a
 * diff-path map that blew its budget (§8a — over-budget FAILS LOUD and falls
 * back exactly like any other required-generator failure; it is deliberately
 * NOT truncated and NOT partitioned).
 *
 * Lifted verbatim from the single call site it used to have — no new failure
 * machinery, just one caller became two.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @param {string} reason - already prefixed `required generator failed: `
 * @param {Array<object>} discoveryGeneratorOutcomes - captured BEFORE delegating
 * @returns {Promise<import('../schemas.mjs').AuditRunResult>}
 */
async function failRequiredGenerator(ctx, reason, discoveryGeneratorOutcomes) {
  // Falling back is a PRODUCTION obligation, not a universal one
  // (plan: docs/plans/shadow-no-legacy-fallback.md). This function has
  // exactly two callers and they have opposite contracts:
  //   - openai-audit.mjs:440 (pipelineEnabled) — GATING. Its result IS the
  //     audit, so it must return findings. Falling back is CORRECT.
  //   - tiered-shadow-compare.mjs (runShadowTieredPipeline) —
  //     observation-only. It has NO obligation to return findings, and
  //     falling back here ran a SECOND full legacy audit inside the shadow,
  //     then returned legacy's findings labelled as the tiered result — so
  //     compareAuditRunResults compared the real legacy run against a second
  //     legacy run. Measured over 57 live records: 41 of them, each paying
  //     for a whole extra 5-pass GPT audit to yield zero tiered signal.
  //     Their `overlap: 0` was never recall — it was two independent legacy
  //     runs disagreeing with each other (an accidental, unwanted
  //     measurement of GPT's own nondeterminism) polluting the very
  //     denominator the Phase-14 decision reads.
  // "The tiered pipeline could not run" is a complete, cheap, honest shadow
  // result, and `runShadowTieredPipeline`'s existing {ok:false, error} path
  // already persists it via the existing `shadow_error` column — so this
  // needs no new status, no schema change, and no migration.
  if (ctx.shadowMode) throw new TieredUnavailableError(reason);

  // Production only. The dynamic import lives INSIDE this branch so a shadow
  // run never even loads the legacy module — and so the throw above
  // structurally precludes reaching it (which is half the proof that the
  // shadow never invokes legacy; the other half is a static pin in
  // tests/tiered-pipeline-wiring.test.mjs, since an internal dynamic import
  // has no injection seam to spy on and inventing one purely for a test
  // would be the over-engineered cliff — round-1 plan-audit M2).
  const { runLegacyProductionAudit } = await import('./legacy-production-audit.mjs');
  const legacyResult = await runLegacyProductionAudit(ctx);
  return {
    ...legacyResult,
    generatorOutcomes: discoveryGeneratorOutcomes,
    runStatus: 'fallback_legacy',
    fallbackReason: reason,
  };
}

/**
 * The result of a run that never called a generator at all (plan §7j).
 *
 * THE POINT: neither an empty scope nor an invalid diff may EVER report as a
 * clean 0-finding `complete` run — that is the anti-green class this whole
 * plan exists to kill. Both get their own named `runStatus`, so
 * `summarize()`'s `historicalComplete` filter (`=== 'complete'`) excludes them
 * from `comparedRuns` and `tieredRunStatusCounts` gives each its own bucket.
 *
 * CONTRACT GAP RESOLVED (adjudicated 2026-07-17): both values are now members
 * of `AuditRunResultSchema.runStatus`. This was weighed against
 * shadow-no-legacy-fallback's "why NOT a new runStatus enum value" note and
 * found consistent with it — that note's own tests (consumer distinction
 * needed? data migration? alternative channel?) all answer differently here;
 * see the adjudication comment on the enum itself (schemas.mjs) for the full
 * reasoning. An emissions⊆enum scan in tests/tiered-pipeline-wiring.test.mjs
 * now guards the divergence class mechanically.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @param {{kind:string, reason:string, detail?:string}} map
 * @param {number} startedAt
 * @returns {import('../schemas.mjs').AuditRunResult}
 */
function skippedNoGeneratorResult(ctx, map, startedAt) {
  const runStatus = map.kind === 'empty' ? 'skipped_no_eligible_files' : 'failed_invalid_diff_input';
  const reason = `${runStatus}: ${map.reason}${map.detail ? ` — ${map.detail}` : ''}`;
  // `invalid` is OUR bug (a diff we produced and could not parse), so it gets
  // stage0Malformed's loud stderr treatment (§7c); `empty` is a legitimate
  // no-op and stays quiet.
  process.stderr.write(map.kind === 'invalid'
    ? `  [discovery] CONTRACT BUG — ${reason}. Both generators SKIPPED; this run verified nothing and is excluded from comparedRuns.\n`
    : `  [discovery] no eligible diff files — both generators skipped (${map.reason}). Not a clean 0-finding run.\n`);

  const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  return {
    verdict: 'INCOMPLETE',
    files_planned: 0, files_found: 0, files_missing: 0,
    code_files: ctx.changedFiles || [],
    findings: [],
    wiring_issues: [], quick_fix_warnings: [], dead_code: [],
    overall_reasoning: `**Discovery**: SKIPPED — ${reason}. No generator was called, so this run is not a zero-findings result; it is a run that did not happen.`,
    _pass_timings: { discovery: '0.0s', total: elapsed },
    _usage: computeCostReport({ usageEvents: [], reviewEffortEvents: [], acceptedFindings: [] }),
    _cacheMetrics: { totalInputTokens: 0, totalCachedTokens: 0, hitRate: 0, estimatedSavingsPct: 0, seedUsed: false, perPass: {} },
    _toolCapability: { toolsAvailable: [], toolsFailed: [], strictLint: false, disabled: true, timestamp: Date.now() },
    _sid: ctx.runId || `tiered-${Date.now()}`,
    generatorOutcomes: ctx.generatorOutcomes || [],
    runStatus,
    fallbackReason: reason,
    _suppression: { stage1MechanicalDismissed: 0, stage2ConfirmedDismissal: 0 },
    debtRoutedFiles: [], debtRoutingIncomplete: [],
    // Every count 0 because nothing ran — NOT because everything passed. The
    // named runStatus above is what tells those two apart; a consumer must
    // never have to infer it from the zeros.
    _stageBreakdown: {
      discoveryRawFindings: 0, discoveryMalformedRaw: 0,
      stage0Verified: 0, stage0Rejected: 0, stage0MalformedTripwire: 0,
      stage0PreExistingIndependent: 0, stage0DebtRouted: 0, stage0DebtRoutingIncomplete: 0,
      stage1MechanicalDismissed: 0, stage1Escalated: 0, stage1ConfirmedSurvivor: 0, stage1BudgetExhausted: 0,
      stage2Verified: 0, stage2Reversed: 0, stage2ConfirmedDismissal: 0, stage2MissedCandidate: 0, stage2Unresolved: 0,
      diffPathMapStatus: `${map.kind}:${map.reason}`,
    },
    pendingAdjudicationItems: [],
    _stage1BudgetExhausted: { count: 0, itemIds: [] },
    _stage1FailureCategories: {},
  };
}

/**
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @returns {Promise<import('../schemas.mjs').AuditRunResult>}
 */
export async function runTieredAuditPipeline(ctx) {
  const stageStart = { discovery: Date.now() };
  const { providers = {} } = ctx;

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

  if (diffPathMap.kind === 'invalid' && diffPathMap.reason === 'discovery_map_exceeds_budget') {
    // §8a: bounded by a NAMED FAILURE, not by truncation (which would make real
    // changed files unauditable while reporting success) and not by partitioning
    // (deferred — no current requirement, and it changes recall). Reuses §1.5's
    // existing required-generator-failure semantics verbatim.
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

  // ONE source for both the prompt table and the enum (D7), so they cannot drift.
  const diffPathTable = renderDiffPathTable(diffPathMap.entries);
  const producerFindingSchema = makeProducerFindingV3Schema(diffPathMap.entries.map((e) => e.id));
  // The instruction both generators share. `diffPathId` is an ENUM in the schema
  // the provider actually sees — the one row of D1's table a provider CAN
  // enforce — but the enum is a funnel, never a trust boundary (D6):
  // `prepareCandidates` safeParses every response regardless.
  const anchorContract = [
    'ANCHOR CONTRACT — a finding is discarded outright if its anchor breaks these:',
    '- `diffPathId` MUST be an `id` copied EXACTLY from the DIFF-PATH TABLE below. It is the ONLY way to name a file. Never write a path there, and never invent an id.',
    '- Do NOT report paths or file status — we derive those from the id ourselves.',
    '- `quote` MUST be text copied VERBATIM from the code you were given. Never paraphrase, reformat, or reconstruct it — it is verified by exact content match against the real file/diff.',
    '- `side` is "head" for current/added code and "base" for removed code. An `added` file has no base side; a `deleted` file has no head side.',
    '- `startLine`/`endLine` are 1-indexed and must bracket the quote (`startLine <= endLine`).',
    '- commission findings need `anchor`; omission findings need `triggerAnchor` AND `causalChain`.',
    '',
    'DIFF-PATH TABLE — the only files you may cite:',
    diffPathTable,
  ].join('\n');

  const glmModel = tieredAuditConfig.discoveryModel;
  // Lenient ingestion for the discovery generator (2026-07-15): OSS routers
  // accept our JSON Schema but don't enforce maxLength/maxItems, and GLM
  // emitted `principle` fields >150 chars — the strict safeParse inside
  // ossCall then hard-failed the WHOLE response, a required-generator
  // failure, and every round fell back to legacy (the 4th distinct cause of
  // an all-fallback shadow window). Over-limit strings/arrays are clamped
  // BEFORE validation; genuinely semantic violations (enums, missing
  // fields) still fail loud. z.toJSONSchema on the preprocess pipe resolves
  // to the inner schema, so the provider-facing JSON Schema is unchanged.
  // MUST carry evidence fields — Stage 0's Gate A/B relevance split reads
  // `canonicalFinding.evidenceType`/`.anchor`/`.triggerAnchor`
  // (candidate-envelope.mjs:55/135 read them directly off the raw finding, with
  // no independent derivation elsewhere). The V1 `ProducerFindingSchema` had NO
  // evidence fields at all — Zod strips unknown keys on parse, so every finding
  // arrived with `evidenceType: null`, making EVERY candidate Stage-0-'fabricated'.
  //
  // V3 (this phase) is the provider-ENFORCEABLE successor to V2: V2's path rules
  // and its commission/omission rule lived in `superRefine`, which
  // `z.toJSONSchema()` cannot express, so the provider never enforced ANY of them
  // and the whole contract was decorative. V3 carries no refinement at all —
  // enum-narrowed id + discriminatedUnion — which `tests/provider-contract-enforceable.test.mjs`
  // asserts and which a real capability probe confirmed both Anthropic tool-use
  // and OpenRouter/GLM honour (3/3 anchors each, 0 outside the enum).
  const glmStrictSchema = z.object({ findings: z.array(producerFindingSchema).max(15) });
  // Named for the CONTRACT, not one generator: both generators emit the same
  // `{findings: [...]}` producer shape and both need the same lenient clamping
  // (see `sonnetCall`), so a `glm`-prefixed name here would misdescribe it.
  const producerResponseJsonSchema = z.toJSONSchema(glmStrictSchema);

  // `quote` must NEVER be clamped (2026-07-18). Every other capped field is
  // prose with no downstream semantic check, so truncating its tail costs a few
  // words and SAVES the finding. `quote` is different in kind: Gate A verifies
  // it VERBATIM against the real diff section, so a truncated quote silently
  // stops matching and the finding is destroyed as `unsupported` — a "the model
  // made an evidence error" verdict caused entirely by OUR truncation. That is a
  // fresh instance of the exact misattribution this plan exists to eliminate,
  // just one layer down.
  //
  // Stripping the cap here means an over-long quote instead fails `safeParse` at
  // `prepareCandidates` and is counted as `malformed` — OUR contract rejecting
  // it, loudly and correctly attributed. Both outcomes lose the finding; only
  // one of them tells the truth about why.
  const unclampedQuoteSchema = stripMaxLengthFor(producerResponseJsonSchema, 'quote');
  const glmLenientSchema = z.preprocess(
    // Lenient ingestion, now down to its ONE remaining job: OSS routers accept
    // our JSON Schema without enforcing maxLength/maxItems (GLM emitted
    // `principle` >150 chars, hard-failing the whole response). The anchor-path
    // mirror that used to compose here is RETIRED — paths are derived from the
    // map now, so there is nothing left to repair. Genuinely semantic violations
    // (enums, missing fields) still fail loud. z.toJSONSchema on the preprocess
    // pipe resolves to the inner schema, so the provider-facing JSON Schema is
    // unchanged.
    (v) => clampToJsonSchemaLimits(v, producerResponseJsonSchema),
    glmStrictSchema,
  );
  const glmCall = providers.ossCall
    ? async () => {
        const { result, category, error } = await providers.ossCall({
          model: glmModel,
          // require_parameters (experiment-4 gate-1 screen, 2026-07-17,
          // n=60 through this exact seam): OpenRouter's GLM fleet contains
          // hosts that ACCEPT our response_format json_schema request but
          // don't honour it — 11 of 28 endpoints don't declare
          // structured_outputs at all (Z.AI's own first-party route
          // included), and routing to them produced the entire stall class
          // (10/30 unpinned) plus free-text non-JSON replies. With
          // require_parameters:true OpenRouter routes ONLY to hosts that
          // support every requested parameter: stalls went 10/30 -> 0/30,
          // availability 40% -> 57%, p50 latency 2.6s -> 0.9s. The remaining
          // failures are model-emitted schema violations (handled by the
          // clamp), not transport.
          providerPreferences: { require_parameters: true },

          // Root-cause half of the same fix: the previous one-sentence system
          // prompt never told the model what an anchor IS, so it guessed (and
          // consistently guessed a shape our schema rejects). It now cannot
          // guess the part that mattered — `diffPathId` is enum-narrowed to the
          // table's real ids, and the paths are ours to derive.
          system: [
            'You are a code-audit finding generator. Produce candidate findings, each with a content-verifiable evidence anchor.',
            '',
            anchorContract,
          ].join('\n'),
          userPrompt: `## Plan\n${discoveryPlan}\n\n## Changed Files (code)\n${discoveryCode}`,
          schema: glmLenientSchema,
          schemaName: 'discovery_glm_pass',
          passName: 'discovery-glm',
          operation: 'discovery_generation',
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
          // docs/plans/oss-call-reliability-hardening.md round-1 H2: the
          // original generic message discarded whatever category/error the
          // underlying ossCall response carried — the exact gap that made
          // the 2026-07-14 incident undiagnosable from stored telemetry.
          const err = new Error(`glmCall: providers.ossCall did not return a result.findings array${error ? ` (${error})` : ''}`);
          err.category = category ?? null;
          throw err;
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
          items: z.toJSONSchema(producerFindingSchema),
        },
      },
      required: ['findings'],
    },
  };
  const sonnetCall = providers.anthropicClient
    ? async () => {
        const resp = await providers.anthropicClient.messages.create({
          model: resolveModel('latest-sonnet'),
          // 2026-07-14: was 4000 — with maxItems:15 and per-finding text caps
          // (detail<=600, risk<=500, recommendation<=600, plus category/
          // section/principle/classification), a full 15-item response needs
          // ~9000+ output tokens. On real (large) diffs the model filled the
          // budget mid-tool-call and got cut off before the JSON closed, so
          // `toolUse` never existed — every Close-out shadow-validation run
          // fell back to legacy with this exact error, even after the
          // separate CLAUDE_BACKEND=cli/tool_choice fix landed the same day.
          // 16000 covers the worst case (15 findings at their length caps)
          // with headroom.
          max_tokens: 16000,
          // The SAME anchor contract + diff-path table the GLM generator gets —
          // one string, so the two generators cannot drift into citing different
          // id sets. Anthropic tool-use validates the SHAPE provider-side, but
          // shape-validity is not evidence-validity: `quote` must still be
          // VERBATIM or Gate A marks the finding unsupported and it is lost.
          system: [
            'You are a code-audit finding generator (cold pass, no prior context). Produce candidate findings by calling report_findings.',
            '',
            anchorContract,
          ].join('\n'),
          messages: [{ role: 'user', content: `## Plan\n${discoveryPlan}\n\n## Changed Files (code)\n${discoveryCode}` }],
          tools: [sonnetFindingsTool],
          tool_choice: { type: 'tool', name: 'report_findings' },
        });
        const toolUse = resp?.content?.find(block => block.type === 'tool_use' && block.name === 'report_findings');
        if (!toolUse || !Array.isArray(toolUse.input?.findings)) {
          // Diagnosability (2026-07-14): a bare "no tool call" message gave
          // no way to tell truncation apart from a genuine refusal/format
          // miss without a live-probe session. stop_reason: 'max_tokens' is
          // the truncation signature — surface it so a future recurrence is
          // diagnosable from the thrown/logged message alone.
          throw new Error(`sonnetCall: response did not contain a report_findings tool call with a findings array (stop_reason: ${resp?.stop_reason ?? 'unknown'})`);
        }
        // The SAME lenient clamping the GLM path has had since GLM's `principle`
        // overflow — the Sonnet path never got it, and that asymmetry was a live
        // instance of this plan's own bug class (found 2026-07-18 by the §9a
        // acceptance probe, the first time it ran against a fixture with real
        // findings): Sonnet-5 writes `detail` longer than the 600-char cap, so
        // 60-77% of its GENUINE findings were rejected as `producer_dto_invalid`
        // — "our contract couldn't parse it" — and destroyed. Anthropic tool-use
        // validates SHAPE provider-side but does not enforce maxLength, exactly
        // as OpenRouter doesn't.
        //
        // Clamping is length-only and pre-validation: over-limit strings/arrays
        // are truncated, while genuinely semantic violations (enums, missing
        // fields, unknown ids) still fail loud at `prepareCandidates`. Losing the
        // tail of a verbose `detail` is strictly better than destroying the
        // finding — and `quote` is capped well above any real anchor, so Gate A's
        // verbatim content check is unaffected.
        return clampToJsonSchemaLimits({ findings: toolUse.input.findings }, unclampedQuoteSchema).findings;
      }
    // No client. Name WHY, from the readiness record the context carries —
    // `anthropicClient === null` alone conflates a keyless run with a broken
    // one, and reporting both as a bare "unavailable" is how a single keyless
    // session read as two days of intermittent failures (WS-B2).
    : async () => {
      const r = ctx.providers?.anthropicReadiness;
      const detail = r?.state
        ? `${r.state}${r.message ? `: ${r.message}` : ''}`
        : 'unavailable (no readiness record)';
      throw new Error(`discovery portfolio: providers.anthropicClient ${detail}`);
    };

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
    producerSchema: producerFindingSchema,
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
  // (reviewCall(envelope) vs cleanRegionCall(file)).
  const reviewCall = providers.geminiReviewCall;
  const cleanRegionCall = providers.geminiCleanRegionCall;
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

// Test-export gate — mirrors legacy-production-audit.mjs's `__testExports` /
// `AUDIT_EXPORTS_FOR_TESTS` pattern. Exposes the Stage 0 relevance-split
// internals (decision #5/#9 caching + debt-routing) for Tier-1 deterministic
// unit tests, since `getFreshImportersOrNull`'s real DB path is unreachable
// hermetically (cloud disabled in tests) and `buildStage0RelevanceContext`'s
// per-run caching behavior otherwise has no seam to assert against directly.
// Production runs never set the env var, so this export is `undefined` and
// the test scaffolding is dead code at runtime.
export const __testExports = process.env.AUDIT_EXPORTS_FOR_TESTS === '1'
  ? {
      collectCandidateAnchorFiles, buildStage0RelevanceContext,
      makeHeadContentAdapter, makeImpactAdapter, makeBlameAdapter,
      extractCanonicalAnchorFile, buildPreExistingDebtEntry, routePreExistingIndependent,
      resolveEligibleDiffPathMap, stripMaxLengthFor,
    }
  : undefined;
