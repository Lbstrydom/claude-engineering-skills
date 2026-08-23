/**
 * @fileoverview `runLegacyProductionAudit` — the extracted, unchanged current
 * production code-audit path (GPT 5-pass orchestration + R2+ suppression +
 * ledger write + verdict computation), plus `buildAuditRunContext`, the
 * builder that maps `openai-audit.mjs`'s `main()` parsed CLI args into an
 * `AuditRunContext`.
 *
 * Tiered-recall audit pipeline Phase 11 — a PURE RELOCATION of
 * `runMultiPassCodeAudit`'s original ~1600-line body out of
 * `scripts/openai-audit.mjs` (no behavior change beyond taking one `ctx`
 * param instead of ~19 loose params, and setting `generatorOutcomes`/
 * `runStatus` on the return — see the docblock on `runLegacyProductionAudit`
 * below). This file is also where the plan's other code-audit-orchestration-
 * specific helpers physically relocate to (confirmed single-mode via a
 * direct symbol-use inventory before this phase started, not assumed from
 * plan prose — audit-plan fix H3, round 4): `printCostPreflight` was
 * EXCLUDED from that inventory result (deviation from the plan's literal
 * text — see the comment at its former call site in `openai-audit.mjs`) —
 * direct-code inspection showed it is called from `main()` itself for ALL
 * THREE modes (code/plan/rebuttal), never from inside the orchestration
 * loop, so it stays in `openai-audit.mjs` rather than being relocated here.
 *
 * The five mode-agnostic GPT-calling primitives (`_callGPTOnce`, `callGPT`,
 * `safeCallGPT`, `getPassPrompt`, `buildCachePrompt`) are NOT here — they
 * live in the neutral `./llm-helpers.mjs` (Gemini gate fix G2, round 3):
 * this file imports `runLegacyProductionAudit`'s entry point FROM
 * `openai-audit.mjs`'s perspective, so if those primitives lived here
 * instead, `openai-audit.mjs`'s multi-mode `main()` (plan/rebuttal calls
 * them directly, confirmed via `grep` — audit-plan fix H3) would need to
 * import them back FROM this file, a genuine two-file A-imports-B/B-imports-A
 * cycle. `llm-helpers.mjs` is the third, neutral module both files import
 * FROM, eliminating the cycle structurally.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 11.
 *
 * @module scripts/lib/audit/legacy-production-audit
 */

// dotenv loaded by lib/config.mjs (worktree-safe discovery)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { FindingSchema, ProducerFindingSchema, WiringIssueSchema, LedgerEntrySchema, BatchLedgerEntrySchema, ReduceStatus, reduceStatusFromErrorCategory, buildExecutionMeta, DuplicationBouncerResponseSchema, AdjacencyBouncerResponseSchema, ArchIntentPassSchema } from '../schemas.mjs';
import { gitDiffWithWorkingTree } from '../vcs.mjs';
import { runDuplicationAnalysis } from './duplication-detector.mjs';
import { classifyProviderReadiness } from './provider-readiness.mjs';
import { runAdjacencyAnalysis } from './adjacency-detector.mjs';
import { runAdjacencyBouncer, buildAdjacencyFailedFinding } from './adjacency-report.mjs';
import { composeAdjacencyResult } from './adjacency-compose.mjs';
import {
  isDuplicationReportClean, formatCandidatesForPrompt, mapBouncerDecisionsToFindings,
  deriveFindingsFromDuplicationReport, buildDetectorFailedFinding, finalizeDeterministicFindings,
} from './duplication-report.mjs';
import {
  safeInt, readFileOrDie, readFilesAsContext, readFilesAsAnnotatedContext,
  writeOutput, normalizePath, parseDiffFile, extractPlanPaths, mergeScopeFiles, classifyFiles,
  isAuditInfraFile, auditSubjectFileGuard, atomicWriteFileSync
} from '../file-io.mjs';
import {
  generateTopicId, populateFindingMetadata, jaccardSimilarity,
  suppressReRaises, buildRulingsBlock, R2_ROUND_MODIFIER, buildR2SystemPrompt,
  computeImpactSet, batchWriteLedger, classifyLedgerEntry,
  computeFixLifecycleUpdates, applyLifecycleUpdates
} from '../ledger.mjs';
import {
  estimateTokens, chunkLargeFile, extractExportsOnly, buildAuditUnits,
  buildDependencyGraph, REDUCE_SYSTEM_PROMPT, measureContextChars
} from '../code-analysis.mjs';
import { semanticId, formatFindings, appendOutcome, loadOutcomes, FalsePositiveTracker } from '../findings.mjs';
import { estimateStablePrefixTokens } from './prompt-builder.mjs';
import { runArchIntentAnalysis, isArchIntentReportClean, deriveArchState } from '../arch-intent/adapter-contract.mjs';
import { loadArchIntentConfig } from '../arch-intent/load-config.mjs';
import { parseIntentDoc } from '../arch-intent/intent-doc-parser.mjs';
import { ArchIntentConfigError } from '../arch-intent/errors.mjs';
import { detectRepoStack } from '../repo-stack.mjs';
import { listRepoFiles } from '../repo-inventory.mjs';
import { verifyExistenceFindings, effectiveSeverity, countsTowardVerdict, isRefuted } from './finding-verification.mjs';
import { getRepoContext } from '../repo-context.mjs';
import { evaluateConvergence, evaluateConvergenceWithDetectors, resolveDetectorResultForRound } from './convergence.mjs';
import { checkDetectors } from './detector.mjs';
import { getRequirementsContext } from '../requirements/context.mjs';
import { detectOrphansIntroduced } from './orphan-introduced.mjs';
import { resolveDiffScope } from './diff-scope-resolver.mjs';
import { processFindings, computeAuditVerdict, normalizeArchCategory } from './findings-pipeline.mjs';
import { emitOrphanRunMetrics } from './orphan-metrics.mjs';
import {
  detectEventWiringAsymmetry, resolveEventWiringScopeRefs, buildEventWiringDiffScope, loadEventWiringConfig,
} from './event-wiring-corpus.mjs';
import { PlanFpTracker } from '../plan-fp-tracker.mjs';
import {
  generateRepoProfile, initAuditBrief, readProjectContext, readProjectContextForPass,
  extractPlanForPass, buildHistoryContext, loadSessionCache, saveSessionCache
} from '../context.mjs';
import { buildLanguageContext } from '../language-profiles.mjs';
import { executeTools, normalizeToolResults, formatLintSummary } from '../linter.mjs';
import {
  selectEventSource, loadDebtLedger, appendEvents, reconcileLocalToCloud, mergeLedgers as mergeLedgersForSuppression
} from '../debt-memory.mjs';
import { initLearningStore, isCloudEnabled, resolveRepoForStore, upsertPlan, recordRunStart, recordRunComplete, recordFindings, recordPassStats, recordSuppressionEvents, syncBanditArms, syncFalsePositivePatterns, loadFalsePositivePatterns, backfillLearningOutcome, insertLearningDecision, markFindingsRemediation, reconcileRemediationProjection } from '../../learning-store.mjs';
// Durable audit-store writes (docs/plans/audit-store-write-durability.md).
// `audit-store-writers.mjs` is imported for its REGISTRATIONS — importing it is
// the registry's bootstrap, and `durableWrite` throws for an unregistered id, so
// dropping this import would fail loudly rather than silently.
import { durableWrite, drainSpill, spillSummary } from '../durable-write.mjs';
import '../audit-store-writers.mjs';
import { buildCloudFpPolicy, runSuppressionPasses } from '../suppression-policy.mjs';
import { finalizePriorRoundOutcomes } from '../finalize-outcomes.mjs';
import { recordDecision as _learningRecordDecision, flush as _learningFlush, installLifecycleHooks as _learningInstallHooks, buildDecisionKey as _learningBuildKey, reconcileOutbox as _learningReconcileOutbox } from '../learning/decision-logger.mjs';
import { deriveSignals as _deriveTierSignals, buildAuthorTierObservation as _buildAuthorTierObservation } from '../learning/author-tier-observation.mjs';
import { loadDomainRules as _loadDomainRules, computeTargetDomains as _computeTargetDomains } from '../symbol-index/domain-tagger.mjs';
import { PromptBandit, computeReward, buildContext } from '../../bandit.mjs';
import { openaiConfig, PASS_NAMES, modelPricing, azureConfig, tieredAuditConfig, auditRuntimeConfig, adjacencyConfig } from '../config.mjs';
import { supportsReasoningEffort, refreshModelCatalog, resolveModel, pricingKey } from '../model-resolver.mjs';
import { costFromUsage } from '../model-pricing.mjs';
import { createOpenRouterClient } from '../openai-client.mjs';
import { createAnthropicClient } from '../anthropic-client.mjs';
import { ossStructuredCall } from '../oss-structured-output.mjs';
import { createGeminiReviewSubprocessAdapters } from './final-adjudication.mjs';
import { MODEL, getPassPrompt, buildCachePrompt, callGPT, safeCallGPT, wireModel } from './llm-helpers.mjs';
import {
  LlmError, classifyLlmError, buildReducePayload, normalizeFindingsForOutput as _normalizeFindingsForOutput,
  resolveLedgerPath, MAX_REDUCE_JSON_CHARS, MAP_FAILURE_THRESHOLD, RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS, RETRY_429_MAX_DELAY_MS, SEV_ORDER,
  tryRepairJson, computePassLimits, AUDIT_DIR, SESSION_MANIFEST_PREFIX, SESSION_LEDGER_FILE
} from '../robustness.mjs';
import {
  PASS_BACKEND_RUBRIC, PASS_FRONTEND_RUBRIC, PASS_SUSTAINABILITY_RUBRIC, buildClassificationRubric,
} from '../prompt-seeds.mjs';
import { getActiveRevisionId } from '../prompt-registry.mjs';
import { incrementRunCounter } from '../llm-auditor.mjs';

// ── Code Audit Pass Schemas (moved from openai-audit.mjs — tiered-recall
// pipeline Phase 11: used exclusively by this file's orchestration loop) ──

const PassFindingsSchema = z.object({
  pass_name: z.string().max(30),
  findings: z.array(ProducerFindingSchema).max(15).describe('Top 15 findings, sorted by severity (HIGH first). Prefer fewer deep findings over many shallow ones.'),
  quick_fix_warnings: z.array(z.string().max(300)).max(5),
  summary: z.string().max(500).describe('Brief summary of this pass')
});

const StructurePassSchema = z.object({
  pass_name: z.literal('structure'),
  files_planned: z.number().int(),
  files_found: z.number().int(),
  files_missing: z.number().int(),
  missing_files: z.array(z.string().max(120)).max(30),
  export_mismatches: z.array(z.object({
    file: z.string().max(120),
    expected: z.string().max(200),
    actual: z.string().max(200)
  })).max(20),
  findings: z.array(ProducerFindingSchema).max(15),
  summary: z.string().max(500)
});

const WiringPassSchema = z.object({
  pass_name: z.literal('wiring'),
  wiring_issues: z.array(WiringIssueSchema).max(20),
  findings: z.array(ProducerFindingSchema).max(10),
  summary: z.string().max(500)
});

const SustainabilityPassSchema = z.object({
  pass_name: z.literal('sustainability'),
  findings: z.array(ProducerFindingSchema).max(15),
  dead_code: z.array(z.string().max(200)).max(20),
  quick_fix_warnings: z.array(z.string().max(300)).max(10),
  summary: z.string().max(500)
});

const QuickfixPassSchema = z.object({
  pass_name: z.literal('quickfix'),
  findings: z.array(ProducerFindingSchema).max(15),
  summary: z.string().max(500)
});

// ── Code-audit-orchestration-specific thresholds (moved from openai-audit.mjs
// alongside shouldMapReduce/shouldMapReduceHighReasoning below — only this
// file's orchestration loop reads them) ─────────────────────────────────────
const BACKEND_SPLIT_THRESHOLD = openaiConfig.backendSplitThreshold;
const MAP_REDUCE_THRESHOLD = openaiConfig.mapReduceThreshold;
const MAP_REDUCE_TOKEN_THRESHOLD = openaiConfig.mapReduceTokenThreshold;
const HIGH_REASONING_MAP_REDUCE_THRESHOLD = openaiConfig.highReasoningMapReduceThreshold;
const HIGH_REASONING_MAP_REDUCE_TOKEN_THRESHOLD = openaiConfig.highReasoningMapReduceTokenThreshold;

/** Check if a file set should use map-reduce (by count OR total size). */
function shouldMapReduce(files) {
  if (files.length > MAP_REDUCE_THRESHOLD) return true;
  const totalChars = measureContextChars(files, 10000);
  return totalChars > MAP_REDUCE_TOKEN_THRESHOLD;
}

/**
 * Like shouldMapReduce() but uses lower thresholds for reasoning:high passes
 * (backend, frontend). These time out as single calls at ~36% on Windows —
 * splitting into smaller map-reduce units keeps each unit under 140s.
 */
function shouldMapReduceHighReasoning(files) {
  if (files.length > HIGH_REASONING_MAP_REDUCE_THRESHOLD) return true;
  const totalChars = measureContextChars(files, 10000);
  return totalChars > HIGH_REASONING_MAP_REDUCE_TOKEN_THRESHOLD;
}

// Resolve prompts at module load (uses registry if available, seeds otherwise)
const PASS_STRUCTURE_SYSTEM = getPassPrompt('structure');
const PASS_WIRING_SYSTEM = getPassPrompt('wiring');
const PASS_BACKEND_SYSTEM = getPassPrompt('backend');
const PASS_FRONTEND_SYSTEM = getPassPrompt('frontend');
const PASS_SUSTAINABILITY_SYSTEM = getPassPrompt('sustainability');
// Architecture-intent system prompt — the LLM-bouncer rubric.  See
// docs/plans/architecture-intent-framework.md §9.  Static (never
// varies across rounds) so safe to be in `system` prompt for cache-stability.
const PASS_ARCH_INTENT_SYSTEM = `You are auditing PR diffs against the repo's declared architectural intent. The mechanical analyser has already flagged candidate violations — your job is to classify SEVERITY and filter false positives.

You receive:
1. The repo's architecture-intent.md (the hand-curated C4 + rationale).
2. A list of mechanical violations: { fromFile, toFile, fromDomain, toDomain, ruleViolated }.
3. Unmapped files (in repo, not in any domain rule).
4. Dead intent (domains declared but with no files).

Output: findings list. Use:
- HIGH: cross-cutting violation, breaks a critical invariant (e.g., audit-orchestration → learning-store when not allowed creates a circular dep between core subsystems).
- MEDIUM: boundary erosion in a non-critical edge, OR a recurring pattern that suggests the boundary is wrong (consider proposing an allowedDeps update INSTEAD of a fix).
- LOW: isolated, easily-fixed cases (one file in the wrong domain; one stray import).

When recommending a fix, prefer "move the file to the right domain" or "extract the cross-cutting concern into a shared module" over "add the dep to allowedDeps". Adding to allowedDeps is admitting the intent doc was wrong — sometimes that's right, but say so explicitly.

DO NOT raise findings for:
- Same-domain edges (always allowed by definition).
- Edges to \`vendor\` (external deps — different policy layer).
- Unmapped files in test/ or docs/ (heuristic — only flag src/ + scripts/).

DO raise findings for:
- deadIntent (domain declared but no files) — possible stale intent.
- unmappedFiles in src/ or scripts/ — gap in domain-map.

GROUNDING — READ THIS. Every edge finding you emit MUST correspond to a file in
the mechanical violations or unmapped list above. The mechanical analyser has
ALREADY resolved every domain and checked every import against allowedDeps; an
edge it did NOT flag is ALLOWED, and you must not re-raise it. Do NOT reason
from the intent diagram to "notice" a questionable-looking edge and flag it —
the diagram is context for SEVERITY, not an invitation to re-derive the graph.
Set each finding's \`section\` to the exact flagged file it concerns. A finding
whose file is not in the lists above will be dropped as ungrounded.

Severity floor: any mechanical violation defaults to MEDIUM unless you can justify HIGH or LOW with concrete reasoning.`;
// ── Intermediate Result Cache ────────────────────────────────────────────────
// Write each wave's results to disk as they complete. If the merge step crashes
// (TDZ, disk error, OOM), findings survive on disk and can be recovered.
// The cache dir is derived from the --out path or uses os.tmpdir().


let _cacheDir = null;

/**
 * The one definition of "is this file inside `--files` scope".
 *
 * The bidirectional-substring predicate was written out at SIX call sites
 * (backend, frontend, routes, services, sustainability, quickfix). Six copies
 * of a scope rule are six things to keep in step, and a scope predicate that
 * disagrees with itself across passes silently audits different file sets per
 * pass — which no test would catch, because each pass looks locally correct.
 *
 * Semantics are preserved EXACTLY, deliberately: matching is bidirectional
 * (`f.includes(ff) || ff.includes(f)`) so a caller may pass either a full path
 * or a fragment. Tightening it to equality or a suffix match here would silently
 * narrow every pass's scope, which is a behaviour change wearing a refactor's
 * clothes.
 *
 * @param {string[]|null} fileFilter
 * @returns {(files: string[]) => string[]} identity when no filter is set
 */
function scopeToFileFilter(fileFilter) {
  if (!fileFilter) return (files) => files;
  return (files) => files.filter((f) => fileFilter.some((ff) => f.includes(ff) || ff.includes(f)));
}

function initResultCache(outFile) {
  const base = outFile
    ? path.dirname(path.resolve(outFile))
    : os.tmpdir();
  _cacheDir = path.join(base, `.audit-cache-${process.pid}`);
  try {
    // 9e965821: explicit mode (masked by the process umask on POSIX; a no-op
    // on Windows, which doesn't meaningfully honor POSIX mode bits) rather
    // than the filesystem's default dir mode for a cache holding audit
    // pass results.
    fs.mkdirSync(_cacheDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // Fail-open (a cache is an optimisation, never a precondition) but NOT
    // silent — `cleanupCache` below already had this treatment and this,
    // its sibling, was missed. Without the line, recovery-cache disablement is
    // invisible: every subsequent `cachePassResult` becomes a no-op and a
    // crashed run has nothing to resume from, with no signal that the cache was
    // never there.
    process.stderr.write(`  [cache] disabled — cannot create ${_cacheDir}: ${err.code || err.message}\n`);
    _cacheDir = null;
  }
}

function cachePassResult(passName, result) {
  if (!_cacheDir) return;
  try {
    const filePath = path.join(_cacheDir, `${passName}.json`);
    // Phase 1 (audit-orchestrator-hardening): atomicWriteFileSync (existing,
    // file-io.mjs) instead of a plain fs.writeFileSync — a crash mid-write
    // now leaves the cache artifact either fully-old or fully-new, never torn.
    atomicWriteFileSync(filePath, JSON.stringify(result));
  } catch (err) {
    process.stderr.write(`  [cache] Failed to cache ${passName}: ${err.message}\n`);
  }
}

function cacheWaveResults(passNames, results) {
  for (let i = 0; i < passNames.length; i++) {
    if (results[i]) cachePassResult(passNames[i], results[i]);
  }
  // Reported what it INTENDED, not what happened: with the cache disabled this
  // printed "N pass results cached to null" — a success line over zero writes.
  if (!_cacheDir) {
    process.stderr.write(`  [cache] ${passNames.length} pass result(s) NOT cached — cache disabled\n`);
    return;
  }
  process.stderr.write(`  [cache] ${passNames.length} pass results cached to ${_cacheDir}\n`);
}

function cleanupCache() {
  if (!_cacheDir) return;
  try {
    fs.rmSync(_cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (err) {
    // Cache cleanup failing must never fail the audit run (fail-open) — but
    // silent used to mean INVISIBLE: audit-result cache artifacts (which can
    // carry sensitive diff/finding content) could be left behind with no
    // operator signal at all.
    process.stderr.write(`  [cache] cleanup failed for ${_cacheDir}: ${err.code || err.message}\n`);
  }
}

// buildReducePayload and normalizeFindingsForOutput imported from lib/robustness.mjs
// Wrap normalizeFindingsForOutput to inject semanticId
function normalizeFindingsForOutput(findings) {
  return _normalizeFindingsForOutput(findings, semanticId);
}

// ── Ledger Preflight ─────────────────────────────────────────────────────────

/**
 * Validate the R2+ ledger before running suppression.
 * Returns { valid, suppressionUnavailable?, entryCount?, validEntries?, invalidEntryCount?,
 *           pendingEntryCount? }.
 * A missing or corrupt ledger sets suppressionUnavailable=true so the caller
 * can propagate the flag into _executionMeta without crashing.
 *
 * Phase 2 (audit-orchestrator-hardening, audit-plan fix H5): the
 * top-level-unreadable/malformed-JSON/missing-entries-array failure modes
 * are UNCHANGED — only a STRUCTURALLY-present-but-per-entry-malformed
 * ledger gains new handling. Each entry is passed through
 * `LedgerEntrySchema.safeParse`; a `.success` entry survives into
 * `validEntries` UNCHANGED (the raw entry, not the Zod-transformed result —
 * this preserves any extra bookkeeping fields (`_hash`, `findingId`, …)
 * downstream consumers may read); a failing entry is logged (its index +
 * first Zod issue) and skipped — never thrown.
 *
 * A failing entry is then split into two OUTCOMES, because they mean opposite
 * things to an operator:
 *
 *   - **pending** — a well-formed PRE-adjudication entry (passes
 *     `BatchLedgerEntrySchema`, `adjudicationOutcome === 'pending'`). Every
 *     round auto-writes one of these per finding via `batchWriteLedger`, and
 *     any finding the operator did not triage stays that way. It cannot
 *     satisfy `LedgerEntrySchema` — it has no `ruling`/`originalSeverity`/
 *     `resolvedRound` yet, by design — and `suppressReRaises` would ignore it
 *     regardless (it resolves only `dismissed`/`fixed`/`verified`). So it is
 *     EXPECTED, not damage.
 *   - **invalid** — anything else: genuinely malformed, worth investigating.
 *
 * Collapsing the two is what made this misleading: a normal run with nothing
 * yet adjudicated logged `0 valid, N invalid`, which reads as a corrupt
 * ledger and was reported from a consumer 2026-08-08 as "R2+ suppression
 * never engages". Suppression was fine; the ledger held nothing to suppress
 * WITH, and the line could not say so. Both still stay out of `validEntries`
 * — only the diagnosis changes, never the suppression input.
 */
function validateLedgerForR2(ledgerPath, round) {
  if (round < 2) return { valid: true };
  if (!ledgerPath) {
    process.stderr.write('  [ledger] WARNING: R2 started with no ledger — running without suppression\n');
    return { valid: false, suppressionUnavailable: true };
  }
  if (!fs.existsSync(ledgerPath)) {
    process.stderr.write(`  [ledger] WARNING: Ledger not found at ${ledgerPath} — running without suppression\n`);
    return { valid: false, suppressionUnavailable: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    if (!raw.entries || !Array.isArray(raw.entries)) throw new Error('missing entries array');
    const validEntries = [];
    let invalidEntryCount = 0;
    let pendingEntryCount = 0;
    for (let i = 0; i < raw.entries.length; i++) {
      // ONE oracle, shared with `batchWriteLedger`'s prune (ledger.mjs
      // `classifyLedgerEntry`). This loop used to inline its own two-schema
      // predicate and therefore never recognised stage1-mechanical
      // dismissals — real entries, written by `writeStage1MechanicalLedgerEntry`
      // and consumed by `suppressReRaises`' source-aware filter — counting them
      // as corruption AND withholding them from suppression. A prune built on
      // that narrower spelling would have deleted them outright.
      const verdict = classifyLedgerEntry(raw.entries[i]);
      if (verdict.kind === 'adjudicated') {
        validEntries.push(raw.entries[i]);
        continue;
      }
      // `incomplete` — a valid batch-shape entry that is not a complete ruling.
      // Mostly pre-adjudication residue, but also an entry adjudicated without
      // the full ruling fields; either way `suppressReRaises` cannot use it, and
      // neither is corruption. Counted apart from `invalid` so a normal ledger
      // does not light up the degradation signal.
      if (verdict.kind === 'incomplete') {
        pendingEntryCount++;
        continue;
      }
      invalidEntryCount++;
      process.stderr.write(`  [ledger] WARNING: entry ${i} failed schema validation (${verdict.reason}) — skipped\n`);
    }
    const parts = [`${validEntries.length} adjudicated`];
    if (pendingEntryCount > 0) parts.push(`${pendingEntryCount} awaiting adjudication`);
    if (invalidEntryCount > 0) parts.push(`${invalidEntryCount} invalid`);
    process.stderr.write(`  [ledger] R2 ledger valid — ${raw.entries.length} prior entries (${parts.join(', ')})\n`);
    if (validEntries.length === 0 && pendingEntryCount > 0) {
      // Say the actionable thing rather than leave the operator to infer it
      // from a count of zero: suppression has nothing to suppress WITH until
      // rulings are written, and the absence of rulings is the fixable part.
      process.stderr.write(
        '  [ledger] NOTE: no entry carries a ruling yet, so R2+ suppression has nothing to match against. '
        + 'Write rulings with `write-ledger-entries` (audit-code Step 3.5) before the next round.\n',
      );
    }
    return { valid: true, entryCount: raw.entries.length, validEntries, invalidEntryCount, pendingEntryCount };
  } catch (err) {
    process.stderr.write(`  [ledger] WARNING: Ledger corrupted (${err.message}) — running without suppression\n`);
    return { valid: false, suppressionUnavailable: true };
  }
}

/**
 * Collect per-pass REDUCE degradation off a built passRegistry.
 *
 * Only degraded passes carry an `_executionMeta` (a clean REDUCE emits none) and
 * only map-reduce passes have one at all, so the result contains exactly the
 * passes worth an operator's attention. Returns `undefined` — not `{}` — when
 * nothing degraded, keeping the omit-vs-zero convention the rest of the block
 * follows: absence means "no map-reduce pass degraded", never "measured zero".
 *
 * Pure and separately exported because the alternative is asserting it through
 * a full audit run; the run-level wiring is proved separately.
 *
 * @param {Array<{name: string, _result?: object}>} passRegistry
 * @returns {Record<string, string>|undefined}
 */
function collectReducePassStatuses(passRegistry) {
  const statuses = {};
  for (const entry of passRegistry ?? []) {
    const status = entry?._result?.result?._executionMeta?.reduceStatus;
    if (status) statuses[entry.name] = status;
  }
  return Object.keys(statuses).length > 0 ? statuses : undefined;
}

/**
 * Compact, store-shaped provenance for one round's suppression —
 * `audit_runs.suppression_stats`.
 *
 * **The denominator is the point.** `_suppression` records how many findings
 * were kept, suppressed and reopened; it has never recorded how many RULINGS
 * they were matched against, and `recordSuppressionEvents` writes one row per
 * match (zero rows when there were none). So a round that matched against an
 * all-pending ledger — nothing to suppress WITH — was byte-identical downstream
 * to one that matched against a full ruling set and found nothing to suppress.
 * That is the state behind the 2026-08-08 "R2+ suppression never engages"
 * report, and `validateLedgerForR2`'s stderr NOTE was the only thing that said
 * so. Same unread-channel defect as `ledgerInvalidEntryCount`, one field over.
 *
 * Two honesty rules the shape encodes:
 * - **R1 returns `null`.** Suppression does not run before round 2, and an
 *   absent block must stay distinguishable from a measured `suppressed: 0`.
 * - **An unavailable ledger reports `{unavailable: true}`, never zeroed
 *   counts.** `adjudicated: 0` would claim a measurement of a ledger that was
 *   never read.
 *
 * Counts only — the finding arrays belong in `suppression_events` rows, not in
 * a column on the run.
 *
 * @param {{round?: number,
 *          ledger?: {unavailable?: boolean, entryCount?: number, adjudicated?: number,
 *                    pending?: number, invalid?: number} | null,
 *          suppression?: {keptCount?: number, suppressedCount?: number,
 *                         reopenedCount?: number, fpSuppressedCount?: number} | null}} args
 * @returns {object|null} jsonb-ready block, or null when suppression did not run
 */
export function buildSuppressionStats({ round, ledger, suppression } = {}) {
  if (!(round >= 2)) return null;
  const stats = { round };
  if (ledger?.unavailable) {
    stats.ledger = { unavailable: true };
  } else if (ledger) {
    stats.ledger = {
      entryCount: ledger.entryCount ?? 0,
      adjudicated: ledger.adjudicated ?? 0,
      pending: ledger.pending ?? 0,
      invalid: ledger.invalid ?? 0,
    };
  }
  // Read each counter individually rather than spreading `suppression`: that
  // object also carries the full `suppressed`/`reopened` finding arrays, and a
  // spread would put entire finding bodies in a column on every R2+ run.
  if (suppression) {
    if (suppression.suppressedCount != null) stats.suppressed = suppression.suppressedCount;
    if (suppression.keptCount != null) stats.kept = suppression.keptCount;
    if (suppression.reopenedCount != null) stats.reopened = suppression.reopenedCount;
    // Spelled out rather than the natural short form: that bare token is pinned
    // as a REMOVED LOCAL by tests/suppression-call-site.test.mjs, whose
    // whole-file scan cannot tell a property name from the dangling reference
    // that once crashed every cloud-enabled R2+ run. Renaming the key is the
    // cheap side of that trade; weakening the guard is not. (The token must not
    // appear here even in prose — a whole-file scan reads comments too.)
    if (suppression.fpSuppressedCount != null) stats.falsePositiveSuppressed = suppression.fpSuppressedCount;
  }
  return stats;
}

// ── Map-Reduce Pass ──────────────────────────────────────────────────────────

/**
 * Run a single pass using map-reduce when file count exceeds MAP_REDUCE_THRESHOLD.
 * MAP: parallel GPT calls per audit unit (chunked file groups).
 * REDUCE: single synthesis call to deduplicate, elevate patterns, rank findings.
 *
 * The prompt for each unit is built by the caller-provided `buildPromptForUnit`
 * callback — this keeps the prompt-shape logic colocated with the per-pass
 * config in the call sites, while runMapReducePass owns the parallelism /
 * retry / aggregation logic.
 *
 * @param {OpenAI} openai - OpenAI client
 * @param {string[]} files - Files to audit in this pass
 * @param {string} passName - Name of the pass (for logging)
 * @param {(unit, i, total) => { system, messages }} buildPromptForUnit -
 *   Callback that returns structured prompt opts for a given unit.
 *   Typically uses `buildCachePrompt({ ..., unitLabel: ..., code: ... })`.
 * @param {number} [maxFilesPerUnit=Infinity]
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.changedFileSet] - per-file changed set for retry-skip
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
// Re-throw config-category LlmErrors from a Promise.allSettled rejection
// so programmer wiring bugs surface immediately rather than being swallowed
// (Gemini-R1/MED fix to plan §6).
function throwIfConfigError(settled) {
  if (settled && settled.status === 'rejected'
      && settled.reason instanceof LlmError
      && settled.reason.llmCategory === 'config') {
    throw settled.reason;
  }
}

// Run-scoped flag: true once ANY pass in this run effectively used the cache
// seed (decideSeed → seedUsed). Read at cache-telemetry aggregation to record
// run-level `cache_seed_enabled`. Safe in the CLI-per-invocation model (one run
// per process; reset at runMultiPassCodeAudit start for any in-process re-run).
let _runSeedUsed = false;

// Companions to `_runSeedUsed`, and the reason the seed A/B has a control arm.
// `_runSeedEligible` is true once ANY pass COULD have seeded, whether or not it
// did; `_runSeedSkipReason` records why the first non-seeding pass declined.
// Together they separate "seeding was withheld" (eligible + env-disabled — the
// control) from "seeding was impossible here" (single unit / prefix too small),
// which `cache_seed_enabled=false` alone conflates into one useless cohort.
let _runSeedEligible = false;
let _runSeedSkipReason = null;

// Cache-seed eligibility policy (plan §7c). Returns the seed decision
// envelope { seedEligible, seedUsed, seedSkipReason, seedUnitIdx, seedUnitTokens }
// so the audit-pass telemetry can record which mode ran.
function decideSeed(units, passName, buildPromptForUnit) {
  // Default-ON since 2026-07-14 (PR-6 flip; docs/plans/openai-prefix-cache.md §8).
  // Opt out per-run with AUDIT_CACHE_SEED=0. The cache-hitrate-check routine
  // validates the flip empirically from the seed-ON cohort in audit_runs.
  const envFlag = process.env.AUDIT_CACHE_SEED !== '0';
  const minPrefix = safeInt(process.env.AUDIT_CACHE_STABLE_PREFIX_MIN, 1024);
  const decision = { seedEligible: false, seedUsed: false, seedSkipReason: null, seedUnitIdx: null, seedUnitTokens: null };

  // ELIGIBILITY IS EVALUATED BEFORE THE ENV FLAG — deliberately, and it is the
  // whole reason the seed cohorts are comparable (2026-08-08).
  //
  // This function used to return immediately on `!envFlag`, so a run with
  // AUDIT_CACHE_SEED=0 was never assessed for eligibility. Every opted-out run
  // therefore looked identical to a run that could never have seeded anyway
  // (single-unit, or too small a stable prefix). The seed-OFF cohort was thus a
  // mix of two populations, and since `units.length <= 1` correlates with small
  // audits, seed-OFF was systematically smaller than seed-ON. Comparing their
  // hit rates measured audit size, not seeding — see docs/plans/openai-prefix-cache.md.
  //
  // Evaluating eligibility first costs one extra `buildPromptForUnit` probe on
  // opted-out runs. That probe builds a prompt from an empty `_context`, so it
  // reads no files and makes no API call — cheap enough to pay for a control group.
  if (units.length <= 1) {
    decision.seedSkipReason = 'units.length<=1';
    return decision;
  }
  // Pick the smallest unit by code length (proxy for tokens) — its only job
  // is to warm the cache; smaller seed = lower latency cost.
  let seedIdx = 0;
  let seedLen = Infinity;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const len = u.chunk
      ? (u.chunk.imports?.length ?? 0) + u.chunk.items.reduce((s, it) => s + (it.source?.length ?? 0), 0)
      : u.files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
    if (len < seedLen) { seedLen = len; seedIdx = i; }
  }
  // Sanity-estimate the stable prefix by building one unit's prompt with the
  // smallest payload — if msg #1 is below threshold, seeding is pointless.
  try {
    const probe = buildPromptForUnit({ ...units[seedIdx], _context: '' }, seedIdx, units.length, 'probe');
    const prefixChars = (probe.system?.length ?? 0) + (probe.messages?.[0]?.content?.length ?? 0);
    const prefixTokens = Math.ceil(prefixChars / 4);
    if (prefixTokens < minPrefix) {
      decision.seedSkipReason = 'prefix-too-small';
      decision.seedEligible = false;
      decision.seedUnitIdx = seedIdx;
      decision.seedUnitTokens = prefixTokens;
      return decision;
    }
    decision.seedEligible = true;
    decision.seedUnitIdx = seedIdx;
    decision.seedUnitTokens = prefixTokens;
    // The env flag gates USE, never eligibility. An eligible-but-opted-out run
    // is the control arm: same shape as a seeded run, seeding withheld.
    if (!envFlag) {
      decision.seedSkipReason = 'env-disabled';
      return decision;
    }
    decision.seedUsed = true;
    return decision;
  } catch (err) {
    decision.seedSkipReason = `probe-failed:${err.message?.slice(0, 60)}`;
    return decision;
  }
}

// Run one map-reduce unit. Extracted from runMapReducePass body so the
// cache-seed path (sequential seed → parallel fanout) can re-use the same
// per-unit logic without duplicating retry/context wiring.
async function runOneMapUnit(openai, unit, i, totalUnits, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot) {
  if (acquireSlot) await acquireSlot();
  try {
    const context = unit.chunk
      ? `// ${unit.files[0]} (chunk)\n${unit.chunk.imports}\n\n${unit.chunk.items.map(it => it.source).join('\n\n')}`
      : readFilesAsContext(unit.files, { maxPerFile: 10000, maxTotal: 80000 });

    const limits = computePassLimits(context.length, 'high');
    const unitHasChangedFiles = !changedFileSet || unit.files.some(f => changedFileSet.has(normalizePath(f)));
    const maxRetries = unitHasChangedFiles ? undefined : 0;

    const unitLabel = `Audit Unit ${i + 1}/${totalUnits} (${unit.files.length} files)`;
    const { system, messages } = buildPromptForUnit({ ...unit, _context: context }, i, totalUnits, unitLabel);

    return await callGPT(openai, {
      system,
      messages,
      schema: PassFindingsSchema,
      schemaName: `map_${passName}_${i}`,
      reasoning: 'high',
      ...limits,
      passName: `map-${passName}-${i}`,
      maxRetries,
    });
  } finally {
    if (releaseSlot) releaseSlot();
  }
}

async function runMapReducePass(openai, files, passName, buildPromptForUnit, maxFilesPerUnit = Infinity, { changedFileSet = null } = {}) {
  const units = buildAuditUnits(files, 30000, maxFilesPerUnit);

  // MAP phase: parallel calls with concurrency limit. Phase 7
  // (audit-orchestrator-hardening): now reads the bounds-validated
  // `auditRuntimeConfig.mapReduceConcurrency` (config.mjs) instead of a
  // bare inline `safeInt(process.env.MAP_REDUCE_CONCURRENCY, 5)` — closes
  // the "one holdout env var outside config.mjs" inconsistency and clamps
  // to [1, 20] (below 1 would deadlock the slot-acquire loop below).
  const CONCURRENCY_LIMIT = auditRuntimeConfig.mapReduceConcurrency;
  let active = 0;
  const queue = [];
  const acquireSlot = () => active < CONCURRENCY_LIMIT ? (active++, Promise.resolve()) : new Promise(r => queue.push(r));
  const releaseSlot = () => queue.length > 0 ? queue.shift()() : active--;

  process.stderr.write(`  [${passName}] MAP: ${units.length} units, concurrency=${CONCURRENCY_LIMIT}\n`);
  const mapStart = Date.now();

  // Cache-seed (PR-5, default-ON since PR-6 flip): opt out via AUDIT_CACHE_SEED=0. When enabled AND
  // units.length > 1 AND stable-prefix is large enough, run the smallest
  // unit sequentially FIRST to warm OpenAI's prefix cache, then fan out
  // the rest in parallel. Result ordering is reconstructed by original
  // unit index — seed selection is purely a warm-up optimisation.
  // Per Gemini-R1/MED: re-throw config errors from any settled result
  // so programmer bugs surface immediately instead of being swallowed by
  // Promise.allSettled.
  const seedDecision = decideSeed(units, passName, buildPromptForUnit);
  let results;
  if (seedDecision.seedEligible) _runSeedEligible = true;
  // First reason wins: passes are homogeneous enough that the first decline
  // characterises the run, and a last-wins rule would let a late trivial pass
  // (units.length<=1) mask an earlier, more informative 'env-disabled'.
  if (!seedDecision.seedUsed && seedDecision.seedSkipReason && _runSeedSkipReason === null) {
    _runSeedSkipReason = seedDecision.seedSkipReason;
  }
  if (seedDecision.seedUsed) {
    _runSeedUsed = true; // run-level effective-seed flag for cache_seed_enabled telemetry
    const seedIdx = seedDecision.seedUnitIdx;
    process.stderr.write(`  [${passName}] cache-seed: warming with unit ${seedIdx} (~${seedDecision.seedUnitTokens} tok), then fanning out\n`);
    const runOneAtIdx = (i) => runOneMapUnit(openai, units[i], i, units.length, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot);
    const [seedSettled] = await Promise.allSettled([runOneAtIdx(seedIdx)]);
    throwIfConfigError(seedSettled);
    const fanoutIdxs = units.map((_, i) => i).filter(i => i !== seedIdx);
    const fanoutSettled = await Promise.allSettled(fanoutIdxs.map(runOneAtIdx));
    for (const s of fanoutSettled) throwIfConfigError(s);
    results = new Array(units.length);
    results[seedIdx] = seedSettled;
    fanoutIdxs.forEach((origIdx, j) => { results[origIdx] = fanoutSettled[j]; });
  } else {
    results = await Promise.allSettled(
      units.map((unit, i) => runOneMapUnit(openai, unit, i, units.length, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot))
    );
    // Fail-fast on config errors (Gemini-R1/MED)
    for (const s of results) throwIfConfigError(s);
  }

  // Collect findings + aggregate usage (including failed units)
  const allFindings = [];
  const mapUsage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 };
  // The model that actually served this pass, for `audit_pass_stats.source_model`.
  // Taken from the units themselves rather than re-read from `wireModel()` at
  // return time: today those agree (MODEL is set once by `main()` before any
  // pass runs), but that is a whole-process invariant, and telemetry that is
  // correct only while it holds would go quietly wrong the day a pass picks its
  // own model — reporting a model that never ran, with no way to tell. First
  // unit wins; they are all dispatched identically.
  let dispatchedModel = null;
  let effectiveFailures = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      const val = results[i].value;
      dispatchedModel ??= val?.model ?? null;
      if (val?.usage) {
        mapUsage.input_tokens += val.usage.input_tokens ?? 0;
        mapUsage.output_tokens += val.usage.output_tokens ?? 0;
        mapUsage.reasoning_tokens += val.usage.reasoning_tokens ?? 0;
        mapUsage.cached_tokens += val.usage.cached_tokens ?? 0;
      }
      if (!val?.result || !Array.isArray(val.result.findings)) {
        effectiveFailures++;
      } else {
        for (const f of val.result.findings) {
          f._mapUnit = i;
          allFindings.push(f);
        }
      }
    } else {
      effectiveFailures++;
      if (results[i].reason?._accumulatedUsage) {
        mapUsage.input_tokens += results[i].reason._accumulatedUsage.input_tokens ?? 0;
        mapUsage.output_tokens += results[i].reason._accumulatedUsage.output_tokens ?? 0;
        mapUsage.reasoning_tokens += results[i].reason._accumulatedUsage.reasoning_tokens ?? 0;
        mapUsage.cached_tokens += results[i].reason._accumulatedUsage.cached_tokens ?? 0;
      }
      process.stderr.write(`  [map-${passName}-${i}] FAILED: ${results[i].reason?.message || 'unknown'}\n`);
    }
  }

  const mapCompletionRate = units.length > 0 ? (units.length - effectiveFailures) / units.length : 1;
  process.stderr.write(`  [${passName}] MAP done: ${allFindings.length} findings from ${units.length - effectiveFailures}/${units.length} units (${((Date.now() - mapStart) / 1000).toFixed(1)}s, completion: ${(mapCompletionRate * 100).toFixed(0)}%)\n`);

  // Phase 4 (audit-orchestrator-hardening, audit-plan fix H4): explicit
  // typed failure state, computed ONCE from the SAME two already-computed
  // local variables above (no new tracking needed) and attached to every
  // return path below (the caller reads it to fold into `failedPasses`).
  // `units.length === 0` is the trivial zero-unit case, folded into 'clean'
  // alongside the genuine "nothing failed" case.
  const mapUnitStatus = (units.length === 0 || effectiveFailures === 0)
    ? 'clean'
    : (effectiveFailures === units.length && units.length > 0)
      ? 'total_failure'
      : 'partial';
  const unitsAttempted = units.length;
  const unitsFailed = effectiveFailures;

  if (allFindings.length === 0) {
    return {
      result: { pass_name: passName, findings: [], quick_fix_warnings: [], summary: `Map-reduce: ${units.length} units, 0 findings. ${effectiveFailures} units failed.` },
      usage: mapUsage,
      latencyMs: Date.now() - mapStart,
      mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
    };
  }

  // MAP failure threshold — skip REDUCE when majority failed
  const failureRate = effectiveFailures / units.length;
  if (failureRate > MAP_FAILURE_THRESHOLD && allFindings.length > 0) {
    process.stderr.write(`  [${passName}] ${effectiveFailures}/${units.length} MAP units failed (${(failureRate * 100).toFixed(0)}%) — skipping REDUCE, returning normalized raw findings\n`);
    const normalized = normalizeFindingsForOutput(allFindings);
    return {
      result: { pass_name: passName, findings: normalized, quick_fix_warnings: [],
        summary: `Map-reduce: ${effectiveFailures}/${units.length} units failed. Returning ${normalized.length} raw findings (REDUCE skipped).`,
        // REDUCE was deliberately not attempted — that is `skipped`, not a
        // failure and emphatically not `ok`. This path returned no
        // `_executionMeta` at all until 2026-08-13, leaving a run whose
        // synthesis never ran indistinguishable downstream from a clean one.
        _executionMeta: buildExecutionMeta({ reduceStatus: ReduceStatus.SKIPPED, reduceSkipped: true }) },
      usage: mapUsage,
      latencyMs: Date.now() - mapStart,
      _mapFailureRate: failureRate,
      _reduceSkipped: true,
      mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
    };
  }

  // REDUCE phase: single synthesis call
  process.stderr.write(`  [${passName}] REDUCE: synthesizing ${allFindings.length} findings\n`);

  // Safe JSON truncation — always produces valid JSON
  const payload = buildReducePayload(allFindings);
  if (payload.degraded) {
    process.stderr.write(`  [${passName}] REDUCE payload could not fit budget — skipping REDUCE\n`);
    return {
      result: { pass_name: passName, findings: normalizeFindingsForOutput(allFindings), quick_fix_warnings: [],
        summary: `REDUCE skipped: findings exceeded budget after normalization.`,
        // The findings could not be made to fit the REDUCE payload budget —
        // `budget_exceeded` is the literal cause, and this is the site that
        // makes that enum value reachable at all.
        _executionMeta: buildExecutionMeta({ reduceStatus: ReduceStatus.BUDGET_EXCEEDED, reduceSkipped: true }) },
      usage: mapUsage, latencyMs: Date.now() - mapStart, _reduceSkipped: true,
      mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
    };
  }
  const { json: findingsJson, includedCount, totalCount } = payload;
  if (includedCount < totalCount) {
    process.stderr.write(`  [${passName}] REDUCE input truncated: ${includedCount}/${totalCount} findings (budget: ${MAX_REDUCE_JSON_CHARS} chars)\n`);
  }

  // Reduce uses low reasoning — it's dedup/ranking, not deep analysis. Higher timeout for large finding sets.
  const reduceLimits = computePassLimits(findingsJson.length + 2000, 'low', openaiConfig.reduceMinTokens);
  reduceLimits.timeoutMs = Math.max(reduceLimits.timeoutMs, 240000); // Min 4 min for reduce (frontend/backend sets can be large)
  const reduceResult = await safeCallGPT(openai, {
    systemPrompt: REDUCE_SYSTEM_PROMPT,
    userPrompt: `## Findings from ${units.length} audit units (${effectiveFailures} failed):\n\n${findingsJson}\n\n## Tasks:\n1. Deduplicate\n2. Elevate systemic patterns (3+ occurrences)\n3. Flag cross-file issues\n4. Rank by severity`,
    schema: PassFindingsSchema,
    schemaName: `reduce_${passName}`,
    reasoning: 'low',
    ...reduceLimits,
    passName: `reduce-${passName}`
  }, { pass_name: passName, findings: allFindings, quick_fix_warnings: [], summary: 'Reduce phase failed — returning raw map findings' });

  // Status-gated fallback: if safeCallGPT returned the empty-result sentinel (failed=true),
  // classify the failure and preserve raw MAP findings rather than silently discarding them.
  // Was `reduceResult.failed ? MODEL_ERROR : OK` — a status inferred from one
  // boolean, so `parse_error`/`timeout`/`budget_exceeded` were declared and
  // unreachable. Now derived from the category `safeCallGPT` carries.
  //
  // The `reduceResult._reduceStatus ??` override this used to lead with is GONE
  // (2026-08-13). The plan named `_reduceStatus` as the channel, but nothing has
  // ever written it, so the fallback WAS the implementation and the override was
  // a branch no input could take — the same declared-not-real defect this line
  // exists to fix, one level down. A seam with no writer is not extensibility.
  const reduceStatus = reduceResult.failed
    ? reduceStatusFromErrorCategory(reduceResult.errorCategory)
    : ReduceStatus.OK;
  if (reduceStatus !== ReduceStatus.OK && allFindings.length > 0) {
    process.stderr.write(`  [${passName}] REDUCE failed (${reduceStatus}) — preserving ${allFindings.length} raw MAP findings\n`);
    const totalLatency = Date.now() - mapStart;
    return {
      result: {
        pass_name: passName,
        findings: normalizeFindingsForOutput(allFindings),
        quick_fix_warnings: [],
        summary: `REDUCE failed (${reduceStatus}) — ${allFindings.length} raw findings preserved`,
        _executionMeta: buildExecutionMeta({ reduceStatus, reduceSkipped: true }),
      },
      // A FAILED reduce still burns tokens, so its usage is folded in exactly
      // as the success path does. Dropping it here was the same fabricated-zero
      // class as the duplication/adjacency waves (a7db0baf), surviving on the
      // one branch that fix did not touch — found by auditing the census rather
      // than the instance.
      usage: { ...addUsage(mapUsage, reduceResult?.usage ?? {}), latency_ms: totalLatency },
      latencyMs: totalLatency,
      mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
    };
  }

  const totalLatency = Date.now() - mapStart;
  return {
    result: reduceResult.result,
    // Sum MAP + REDUCE token usage — the success path previously hard-coded
    // zeros, dropping the entire pass's spend (the failed-REDUCE path above
    // already preserves `mapUsage`). Harmless while usage was only a telemetry
    // curiosity; load-bearing now that `_usage.costUsd` is priced from the
    // aggregate `totalUsage` (2026-07-22) — zero here silently under-counts
    // legacyCostUsd on every multi-file (map-reduce) pass. costFromUsage prices
    // input/output tokens, so those must be complete.
    usage: {
      input_tokens: mapUsage.input_tokens + (reduceResult.usage?.input_tokens ?? 0),
      output_tokens: mapUsage.output_tokens + (reduceResult.usage?.output_tokens ?? 0),
      reasoning_tokens: mapUsage.reasoning_tokens + (reduceResult.usage?.reasoning_tokens ?? 0),
      // cd77d84e/d96b1e86: sum MAP + REDUCE cached_tokens, matching the other
      // three fields above — previously only REDUCE's figure was reported,
      // silently dropping MAP's cached-token count from the aggregate.
      cached_tokens: mapUsage.cached_tokens + (reduceResult.usage?.cached_tokens ?? 0),
      latency_ms: totalLatency,
    },
    latencyMs: totalLatency,
    _mapCompletionRate: mapCompletionRate,
    mapUnitStatus, unitsAttempted, unitsFailed, model: dispatchedModel,
  };
}

// ── Multi-Pass Code Audit ──────────────────────────────────────────────────────

/**
 * Run multi-pass parallel code audit.
 * Large backend file sets are split into route+service sub-passes.
 * Each pass uses safeCallGPT for graceful degradation on timeout/error.
 */
/**
 * Architecture-intent audit pass (Wave 1.5).
 *
 * Runs the two-phase analysis (inventory + per-stack edge analysis), then
 * either short-circuits on clean OR sends violations to the LLM bouncer.
 * Falls back to deterministic severity rubric if the LLM call fails.
 *
 * @returns {Promise<{ state: string, result: object }>}
 */
async function runArchitecturePass({ openai, repoRoot, focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus }) {
  const emptyResult = {
    result: { pass_name: 'architecture', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };

  const intentPath = path.join(repoRoot, 'docs/architecture-intent.md');
  const domainMapPath = path.join(repoRoot, '.audit-loop/domain-map.json');

  if (!fs.existsSync(intentPath)) {
    return { state: 'SKIPPED_NO_INTENT', result: emptyResult, archReport: null };
  }
  if (!fs.existsSync(domainMapPath)) {
    return { state: 'SKIPPED_MISSING_DOMAIN_MAP', result: emptyResult, archReport: null };
  }

  let domainMap;
  try {
    domainMap = loadArchIntentConfig(repoRoot);
  } catch (err) {
    if (err instanceof ArchIntentConfigError) {
      // audit-orchestrator-hardening H8 (hardening-implementation audit
      // round 1): Phase 5 routed deriveFindingsFromReport's 4 violation
      // loops through full FindingSchema.parse(...), but this EARLY-RETURN
      // branch constructs its finding inline, bypassing deriveFindingsFromReport
      // entirely — the same "hand-built deterministic finding" class Phase 5
      // exists to fix, just a second call site it didn't cover. Adds the
      // required `id`/`risk` fields and routes through FindingSchema.parse
      // for full consistency with Phase 5's canonical path.
      return {
        state: 'ERROR_INVALID_CONFIG',
        result: {
          result: {
            pass_name: 'architecture',
            findings: [FindingSchema.parse({
              id: 'A0',
              severity: 'HIGH',
              category: '[Architecture] Invalid domain-map.json',
              detail: err.message,
              risk: 'Architecture checks cannot run at all until this config is fixed — cross-domain boundary violations elsewhere in the repo go undetected in the meantime.',
              recommendation: 'Fix the config file at .audit-loop/domain-map.json. See docs/plans/architecture-intent-framework.md §2 decision 5.',
              section: '.audit-loop/domain-map.json',
              affectedFiles: ['.audit-loop/domain-map.json'],
              affectedPrinciples: ['#5 SSoT'],
              is_quick_fix: false,
              is_mechanical: false,
              is_reopened: false,   // mechanical wave — never reopens a prior ruling
              principle: '#5 SSoT',
            })],
            summary: 'Architecture pass aborted — config invalid',
          },
          usage: emptyResult.usage,
          latencyMs: 0,
        },
        archReport: null,
      };
    }
    throw err;
  }

  if (domainMap.allowedDeps === null) {
    return { state: 'SKIPPED_NO_BASELINE', result: emptyResult, archReport: null };
  }

  const intent = parseIntentDoc(intentPath);
  const { stackKinds } = detectRepoStack(repoRoot);

  if (stackKinds.length === 0) {
    return { state: 'SKIPPED_UNSUPPORTED_STACK', result: emptyResult, archReport: null };
  }

  const report = await runArchIntentAnalysis({ repoPath: repoRoot, stackKinds, domainMap });
  const derivedState = deriveArchState(report);

  // Stderr summary so operators see the mechanical findings even when LLM
  // doesn't fire (clean) or fails (fallback).
  process.stderr.write(`  [architecture] mechanical: ${report.violations.length} violations, ${report.unmappedFiles.length} unmapped, ${report.deadIntent.length} dead, ${report.perStackResults.length} stacks\n`);

  if (isArchIntentReportClean(report)) {
    return {
      state: 'ANALYZED_CLEAN',
      archReport: report,
      result: {
        result: { pass_name: 'architecture', findings: [], summary: 'Architecture intent clean' },
        usage: emptyResult.usage,
        latencyMs: 0,
      },
    };
  }

  // Build prompt + call LLM bouncer for severity classification
  const violationsForPrompt = formatViolationsForPrompt(report, intent);
  const archLimits = computePassLimits(violationsForPrompt.length + 4000, 'medium');
  const llmCall = await safeCallGPT(openai, {
    ...buildCachePrompt({
      rubric: PASS_ARCH_INTENT_SYSTEM,
      focusBlock,
      passName: 'architecture',
      planContent,
      ledgerFile: isR2Plus ? ledgerFile : null,
      impactSet,
      isR2Plus,
      historyBlock,
      codeHeader: '## Intent + Mechanical Violations',
      code: violationsForPrompt,
    }),
    schema: ArchIntentPassSchema,
    schemaName: 'architecture_pass',
    reasoning: 'medium',
    ...archLimits,
    passName: 'architecture',
  }, { pass_name: 'architecture', findings: [], summary: 'LLM call failed; falling back to deterministic rubric' });

  if (llmCall.failed) {
    // Deterministic fallback (decision 11): emit findings from mechanical
    // report using simplified rubric (no HIGH in fallback mode).
    return {
      state: derivedState === 'ANALYZED_PARTIAL' ? 'ANALYZED_PARTIAL' : 'ANALYZED_FALLBACK_DETERMINISTIC',
      archReport: report,
      result: {
        ...llmCall,
        result: {
          pass_name: 'architecture',
          findings: deriveFindingsFromReport(report),
          summary: `LLM bouncer failed (${llmCall.error}); ${report.violations.length} mechanical findings emitted with simplified rubric`,
        },
      },
    };
  }

  // Ground the bouncer's findings to the mechanical report — drop any it
  // hallucinated from the intent diagram about edges the mechanical layer
  // never flagged (2026-07-20). Only touches the LLM success path; the
  // deterministic fallback above is mechanical and already grounded.
  const grounded = groundArchFindingsToReport(llmCall.result?.findings ?? [], report);
  if (grounded.dropped.length > 0) {
    process.stderr.write(`  [architecture] dropped ${grounded.dropped.length} ungrounded bouncer finding(s) (file not in mechanical report)\n`);
  }
  return {
    state: derivedState,
    archReport: report,
    result: { ...llmCall, result: { ...llmCall.result, findings: grounded.kept } },
  };
}

/**
 * Convert a raw orphan-introduced finding to the standard FindingSchema shape
 * so it merges into the normal findings stream consumed by the ledger / Gemini /
 * cost reporting paths.
 *
 * @param {object} raw - finding from detectOrphansIntroduced (after processFindings)
 * @returns {object} FindingSchema-shaped finding
 */
function orphanToStandardFinding(raw, idx) {
  const idSuffix = raw._fingerprint ? raw._fingerprint.slice(0, 4) : String(idx).padStart(2, '0');
  return {
    id: `O${idSuffix}`,
    severity: raw.severity, // 'MEDIUM'
    category: `Orphan Introduced (${raw.subKind})`,
    section: raw.file,
    detail: raw.rationale,
    risk: 'Dead code accumulation — file is no longer reachable from any non-test caller but remains in the repo',
    recommendation: raw.subKind === 'born-orphan'
      ? `Either wire ${raw.file} into the call graph or remove it before merge`
      : `Remove ${raw.file} along with the diff that orphaned it, or accept via <!-- audit:accept-v1: ${raw.file} :: reason -->`,
    is_quick_fix: false,
    is_mechanical: true,
    is_reopened: false,   // mechanical wave — never reopens a prior ruling
    principle: 'Long-Term Sustainability (#20) — dead code is invisible debt',
    classification: {
      sonarType: 'CODE_SMELL',
      effort: 'TRIVIAL',
      sourceKind: 'LINTER',
      sourceName: 'orphan-introduced',
    },
  };
}

/**
 * Convert a raw event-wiring-symmetry finding (dispatch-only symmetry, or an
 * orphaned suppression pragma) to the standard FindingSchema shape.
 * Mirrors `orphanToStandardFinding`'s shape. `enforcement: 'advisory'`
 * carries through unchanged (spread, not reconstructed) — that field, not
 * `classification.sourceKind`, is what D10 gates on; `sourceKind: 'LINTER'`
 * is set here only for display/reporting parity with the orphan wave (both
 * are mechanical, non-LLM detectors in this codebase's loose use of that
 * label), never relied on for the advisory/gating decision itself.
 *
 * @param {object} raw - finding from `resolveSymmetry`/`extractEventSites` (event-wiring.mjs)
 * @param {number} idx
 * @returns {object} FindingSchema-shaped finding
 */
function eventWiringToStandardFinding(raw, idx) {
  const idSuffix = String(idx).padStart(2, '0');
  if (raw.kind === 'event-wiring-orphaned-pragma') {
    return {
      id: `EWP${idSuffix}`,
      severity: raw.severity,
      enforcement: raw.enforcement,
      category: 'Orphaned event-consumer-external pragma',
      section: raw.locus.path,
      detail: `${raw.rationale} (${raw.pragmaText.trim()})`,
      risk: 'Stale suppression annotation — no longer bound to any dispatch site; misleads future readers about why an event is unconsumed',
      recommendation: 'Remove the pragma, or move it above the dispatch site it is meant to suppress',
      is_quick_fix: false,
      is_mechanical: true,
      is_reopened: false,
      principle: 'Single Source of Truth (#10) — a suppression annotation must stay bound to what it suppresses',
      classification: { sonarType: 'CODE_SMELL', effort: 'TRIVIAL', sourceKind: 'LINTER', sourceName: 'event-wiring-symmetry' },
    };
  }
  return {
    id: `EW${idSuffix}`,
    severity: raw.severity, // 'MEDIUM' | 'LOW'
    enforcement: raw.enforcement, // 'advisory' — D10, never gates
    category: `Event Wiring Asymmetry (${raw.triggers.join('+')})`,
    section: raw.locus.path,
    detail: raw.rationale,
    risk: raw.testOnlyConsumer
      ? 'Contract exercised only by tests — no production consumer wires this event, so real users never receive it'
      : 'A dispatched custom event has no listener anywhere in the repo — the intended fan-out never fires for any real user',
    recommendation: `Wire a listener for '${raw.eventName}', or suppress with a `
      + `// @event-consumer-external: <reason> pragma directly above the dispatch if consumed outside this repo`,
    is_quick_fix: false,
    is_mechanical: true,
    is_reopened: false,
    principle: 'Wiring Completeness — a dispatch with no consumer is invisible dead fan-out',
    classification: { sonarType: 'CODE_SMELL', effort: 'TRIVIAL', sourceKind: 'LINTER', sourceName: 'event-wiring-symmetry' },
  };
}

/**
 * A dedup-replacement's `id` must match the WINNING finding's severity — the
 * id's letter prefix (H/M/L) is severity-derived, so keeping a stale id
 * across a severity change corrupts the display: a LOW-severity id ("L5")
 * could label a finding whose actual severity is now HIGH (audit M10,
 * 2026-07-24, round-1 finding on the docs/plans/audit-backlog-triage-hardening.md
 * item-4 fix). Same severity → keep the existing id (stable within-run
 * label, unchanged behaviour). Different severity → mint a fresh id from
 * that severity's own counter, exactly like a brand-new finding would get.
 * @param {string} existingId
 * @param {string} existingSeverity
 * @param {string} newSeverity
 * @param {{HIGH:number, MEDIUM:number, LOW:number}} findingCounter - mutated in place
 * @returns {string}
 */
function dedupReplacementId(existingId, existingSeverity, newSeverity, findingCounter) {
  if (existingSeverity === newSeverity) return existingId;
  findingCounter[newSeverity]++;
  const letter = newSeverity === 'HIGH' ? 'H' : newSeverity === 'MEDIUM' ? 'M' : 'L';
  return `${letter}${findingCounter[newSeverity]}`;
}

/**
 * Guards the shadow-execution catch handler's OWN recovery import. The
 * shadow path is opt-in/observation-only and must never abort a successful
 * primary audit (see `classifyShadowFailure` in `lib/audit-shadow.mjs`) —
 * but the catch handler's own `await import('../audit-shadow.mjs')` had no
 * guard of its own, so a failure recovering from a failure (e.g. the module
 * fails to load) could still propagate past the "no shadow failure aborts
 * the primary audit" boundary (audit 6d718216, 2026-07-17).
 * @param {Error} err - the original shadow-path error being classified
 * @param {() => Promise<object>} [importShadowModule] - test seam; defaults
 *   to the real dynamic import. Production call sites never pass this.
 * @returns {Promise<{log: string, marker: object|null}>}
 */
async function classifyShadowFailureSafe(err, importShadowModule = () => import('../audit-shadow.mjs')) {
  try {
    const { classifyShadowFailure } = await importShadowModule();
    return classifyShadowFailure(err);
  } catch (recoveryErr) {
    return {
      log: `shadow failure classification unavailable (${recoveryErr.message}); original: ${err.message}`,
      marker: null,
    };
  }
}

/**
 * The choke point for the 5 write sites this file's `if (learningWritesAllowed)`
 * / `if (X && learningWritesAllowed)` convention used to gate ad hoc (bandit
 * flush + sync, FP-pattern sync, the outcomes.jsonl append loop, and the two
 * orphan-metrics emits) — nothing stopped a future write from skipping the
 * check entirely (audit fb7cec72, 2026-07-17). `grep "writeLearningState("`
 * enumerates those 5 in one shot instead of requiring a full-file read.
 *
 * **NOT exhaustive over every persistence-capable call in this file** — a
 * later audit (H1-H4, 2026-07-24) correctly found OTHER cloud-write/telemetry
 * sites this wrapper does not cover: debt-memory writes, ledger writes, and
 * session writes. See docs/plans/audit-backlog-triage-hardening.md item 1's
 * "Explicitly NOT in scope" framing (item 5's God-orchestrator decomposition
 * covers the eventual real fix). Full lint-level enforcement of even the 5
 * sites this wrapper DOES cover (forbidding a raw store call outside it) is
 * also out of scope here.
 *
 * **THIS PARAGRAPH HAS NOW BEEN WRONG TWICE — 2026-08-13.** It first claimed
 * those sites "silently discard failures (`.catch(() => {})`)" long after they
 * had been fixed to check and log; the file contains zero such swallows. Then,
 * corrected, it still listed `recordDiffComplexity` and
 * `backfillLearningOutcome` as uncovered — and within the hour both were routed
 * through `durableWrite`, along with `recordConvergenceState`.
 *
 * That is the reason it is worth writing down rather than just editing: the
 * FIRST stale version was cited by
 * `docs/plans/god-module-and-layering-debt.md` as the authority for a whole
 * cluster of work, and that cluster had to be re-cut on contact with the code.
 * A docstring enumerating call sites decays every time somebody moves one, and
 * a decayed one is not a cosmetic defect — it is a false premise other plans
 * build on. **Prefer `grep durableWrite(` / `grep writeLearningState(` over
 * trusting this list.**
 *
 * The distinction the list existed to draw is still the right one, and now has
 * a mechanical answer instead of prose: a logged failure is not a REPRESENTED
 * one. A write reaches `writeOutcomes` only through `durableWrite`, and
 * `tests/audit-store-durability-call-site.test.mjs` checks BOTH directions —
 * store exports registered-or-exempted, and orchestrator imports likewise.
 * `reconcileRemediationProjection` and `markFindingsRemediation` stay outside
 * the seam deliberately (the on-disk ledger is their durable copy) and instead
 * return enough for their caller to report a failure or a shortfall.
 *
 * @param {boolean} allowed
 * @param {() => any} fn
 */
function writeLearningState(allowed, fn) {
  if (!allowed) return;
  return fn();
}

/**
 * Fold `durableWrite` results into the run's write-outcome tally.
 *
 * Kept as a named helper rather than an inline reduce because the SHAPE is the
 * contract: `{written, spilled, lost}` reaches `audit_runs.write_outcomes`, and
 * `lost > 0` is what makes a run `incomplete`. `byWriter` is carried too — a
 * bare total says a write was lost, not WHICH, and the operator's next question
 * is always which.
 *
 * `skipped` is counted but is NOT a failure: it means the store declined the
 * write (cloud off), which is a supported mode. Only `lost` makes a run
 * incomplete — conflating the two would mark every local-only run as broken.
 *
 * @param {{written:number, spilled:number, lost:number, skipped:number, byWriter:Record<string,object>}} tally
 * @param {Array<{outcome:string, writerId:string, error?:string}>} results
 */
const WRITE_OUTCOMES = new Set(['written', 'spilled', 'lost', 'skipped']);

function tallyWriteOutcomes(tally, results) {
  for (const r of results) {
    if (!r || typeof r.outcome !== 'string') continue;
    // An unrecognised outcome is counted as `lost`, never dropped. Silently
    // ignoring it would let a future outcome name read as a clean run — the
    // false-zero shape this whole mechanism exists to remove.
    const bucket = WRITE_OUTCOMES.has(r.outcome) ? r.outcome : 'lost';
    tally[bucket]++;
    const w = tally.byWriter[r.writerId] ?? (tally.byWriter[r.writerId] = { written: 0, spilled: 0, lost: 0, skipped: 0 });
    w[bucket]++;
    if (bucket !== 'written' && r.error && !w.lastError) w.lastError = String(r.error).slice(0, 300);
  }
  return tally;
}

/**
 * Wave 1.5b — Orphan-Introduced check. Runs after the architecture pass; reuses
 * the HEAD import graph from `archReport._meta['js-ts']`. Pure deterministic
 * algorithm (no LLM call); emits MEDIUM findings for files orphaned by the diff.
 *
 * Plan: docs/plans/dead-code-phase-1-orphan-introduced.md
 *
 * @param {object} args
 * @param {object|null} args.archReport - from runArchitecturePass; null → SKIPPED_NO_GRAPH
 * @param {string} args.repoRoot
 * @param {string|null} args.baseRef - explicit base sha/ref (e.g. from --base flag)
 * @param {string|null} args.headRef
 * @param {string} args.runId
 * @param {string|null} args.planContent
 * @param {object|null} args.ledger - parsed adjudication ledger (R2+ only)
 * @returns {Promise<{state: string, result: object}>}
 */
async function runOrphanIntroducedPass({ archReport, repoRoot, baseRef, headRef, runId, planContent, ledger, learningWritesAllowed = true }) {
  const emptyResult = {
    result: { pass_name: 'orphan-introduced', findings: [], summary: '' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };

  if (!archReport) {
    // No graph available — arch pass skipped or errored before producing one.
    return { state: 'SKIPPED_NO_GRAPH', result: { ...emptyResult, result: { ...emptyResult.result, summary: 'no arch graph' } } };
  }

  // Extract HEAD graph from arch report's js-ts adapter _meta.
  const jsMeta = archReport._meta?.['js-ts'];
  if (!jsMeta || !jsMeta.allFiles || jsMeta.allFiles.length === 0) {
    return { state: 'SKIPPED_NO_GRAPH', result: { ...emptyResult, result: { ...emptyResult.result, summary: 'no js-ts graph' } } };
  }
  const head = {
    callersByTarget: jsMeta.callersByTarget || {},
    targetsByCaller: jsMeta.targetsByCaller || {},
    allFiles: jsMeta.allFiles || [],
  };

  // Resolve diff scope (orchestration owns git I/O + AST pre-edges).
  const startedAt = Date.now();
  let scope;
  try {
    scope = await resolveDiffScope({ repoPath: repoRoot, baseRef, headRef });
  } catch (err) {
    process.stderr.write(`  [orphan-introduced] resolver error: ${err.message}\n`);
    return { state: 'ERROR', result: { ...emptyResult, result: { ...emptyResult.result, summary: `resolver: ${err.message}` } } };
  }

  // Short-circuit states from the resolver.
  if (scope.state === 'SKIPPED_NO_BASELINE' || scope.state === 'SKIPPED_PATCH_ONLY_MODE') {
    // Gated (audit R1-H1): the metrics file is durable local learning
    // telemetry (.audit/orphan-metrics.jsonl) shared with the real run — an
    // observation-only shadow appending to it double-counts the same commit.
    await writeLearningState(learningWritesAllowed, () => emitOrphanRunMetrics({
      runId, passState: scope.state, rawFindings: [], survivors: [], suppressed: [], _meta: {}, repoPath: repoRoot,
    }));
    return { state: scope.state, result: emptyResult };
  }

  // Inherit ANALYZED_PARTIAL from upstream arch state (Gemini-R2/M2 fix).
  const archDerived = deriveArchState(archReport);
  if (archDerived === 'ANALYZED_PARTIAL') scope.state = 'ANALYZED_PARTIAL';

  // Run pure detector.
  const detector = detectOrphansIntroduced({ scope, head });

  // Post-processing pipeline (fingerprint + ledger-suppress + accept-v1).
  const { survivors, suppressed } = processFindings(detector.rawFindings, {
    ledger,
    planContent,
  });

  // Emit telemetry (per-pass orchestration responsibility — Gemini-R4/H1).
  // Gated on learningWritesAllowed (audit R1-H1) — see the short-circuit
  // emit above for why an observation-only run must not append here.
  await writeLearningState(learningWritesAllowed, () => emitOrphanRunMetrics({
    runId,
    passState: detector.state,
    rawFindings: detector.rawFindings,
    survivors,
    suppressed,
    _meta: detector._meta,
    repoPath: repoRoot,
  }));

  const findings = survivors.map((f, i) => orphanToStandardFinding(f, i));
  const summary = findings.length === 0
    ? `No orphans introduced. Suspects: ${detector._meta.suspectsCount}, removed-edge targets: ${detector._meta.removedEdgeTargetCount}, total removed edges: ${detector._meta.totalRemovedEdges}, entry-points: ${detector._meta.entryPointsCount}.`
    : `${findings.length} orphan-introduced finding(s) surfaced (${detector.rawFindings.length} raw, ${suppressed.length} suppressed).`;

  const latencyMs = Date.now() - startedAt;
  return {
    state: detector.state,
    result: {
      result: { pass_name: 'orphan-introduced', findings, summary },
      usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: latencyMs },
      latencyMs,
    },
  };
}

/**
 * Pick the git range the orphan-introduced wave (Wave 1.5b) analyses.
 *
 * **Why a named function for four lines.** The call site hard-coded
 * `{ baseRef: 'HEAD~1', headRef: 'HEAD' }` immediately beneath a comment
 * describing working-tree mode as though it were reachable. It was not, so on a
 * dirty tree — the normal `/audit-code` case — this wave analysed the previous
 * COMMIT while every other wave scoped to `auditBaseCommit..worktree`. Four
 * findings between 2026-07-22 and 2026-08-12. A literal cannot carry the
 * reasoning below, and this policy is one decision, not two constants.
 *
 * **`headRef` must stay `'HEAD'` on a clean tree — this is not symmetry.**
 * `resolveDiffScope`'s working-tree branch builds changed files from
 * `git diff --name-status HEAD` ∪ untracked, against literal `HEAD`, **ignoring
 * `baseRef`** (diff-scope-resolver.mjs). On a clean tree that set is EMPTY, so
 * "audit my last commit" (`/cycle`: base `HEAD~1`, clean tree) would analyse
 * nothing and report a healthy zero. Always-`null` is therefore a regression
 * that reads as a pass; `tests/orphan-scope-refs.test.mjs` pins that direction
 * explicitly.
 *
 * The two arms agree on the range because `auditBaseCommit` is already
 * dirty-aware upstream (openai-audit.mjs: dirty → base at `HEAD`, clean →
 * `HEAD~1`). Using it rather than a literal also stops this wave being the one
 * consumer that silently ignored `--base` — AGENTS.md, "one range, one
 * resolver": a consumer must not re-infer a base from working-tree state.
 *
 * @param {{auditBaseCommit: string|null|undefined, workingTreeDirty: boolean}} a
 * @returns {{baseRef: string, headRef: string|null}}
 */
function resolveOrphanScopeRefs({ auditBaseCommit, workingTreeDirty }) {
  return {
    // `?? 'HEAD~1'` keeps library/test callers (ctx defaults it to null) on the
    // exact prior behaviour rather than silently re-pointing them at the tree.
    baseRef: auditBaseCommit ?? 'HEAD~1',
    headRef: workingTreeDirty ? null : 'HEAD',
  };
}

/**
 * Wave 1.5c — event-wiring-symmetry check (docs/plans/event-wiring-symmetry.md).
 * Runs after the orphan-introduced wave, same deterministic-mechanical-pass
 * shape (no LLM cost). Unlike orphan, this wave is deliberately COMMITTED-
 * RANGE-ONLY — it never runs in dirty-working-tree mode, because D12's
 * lifecycle/ancestry tracking (`git merge-base --is-ancestor`) needs a real,
 * resolvable commit ref; "is the dirty working tree an ancestor of X" has no
 * answer. `resolveEventWiringScopeRefs` therefore ignores `workingTreeDirty`
 * entirely (unlike `resolveOrphanScopeRefs`).
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string|null} args.auditBaseCommit
 * @param {string} args.runId
 * @param {object|null} args.ledger
 * @param {string|null} args.planContent
 * @param {boolean} [args.learningWritesAllowed]
 * @returns {Promise<{state: string, result: object}>}
 */
async function runEventWiringSymmetryPass({ repoRoot, auditBaseCommit, runId, ledger, planContent, learningWritesAllowed = true }) {
  const emptyResult = {
    result: { pass_name: 'event-wiring-symmetry', findings: [], summary: '' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };
  const startedAt = Date.now();

  let wrappers;
  let totalByteBudgetMb;
  try {
    ({ wrappers, totalByteBudgetMb } = loadEventWiringConfig(repoRoot));
  } catch (err) {
    // Present-but-invalid config is a hard failure per the CLI's own
    // contract (§7) — the production wave degrades to SKIPPED rather than
    // scanning with built-ins-only, which would silently under-scan a repo
    // whose listeners are entirely behind a custom wrapper.
    process.stderr.write(`  [event-wiring] invalid config, skipping wave: ${err.message}\n`);
    return { state: 'ERROR', result: { ...emptyResult, result: { ...emptyResult.result, summary: `invalid config: ${err.message}` } } };
  }

  const { baseRef, headRef } = resolveEventWiringScopeRefs({ auditBaseCommit });
  let diffScope;
  try {
    diffScope = buildEventWiringDiffScope({ repoPath: repoRoot, baseRef, headRef });
  } catch (err) {
    process.stderr.write(`  [event-wiring] diff-scope build error: ${err.message}\n`);
    return { state: 'ERROR', result: { ...emptyResult, result: { ...emptyResult.result, summary: `diff-scope: ${err.message}` } } };
  }

  const ledgerPath = path.join(repoRoot, '.audit', 'event-wiring-ledger.json');
  let detectorOut;
  try {
    detectorOut = await detectEventWiringAsymmetry({
      diffScope, repoPath: repoRoot, wrappers, totalByteBudgetMb, ledgerPath,
      metricsSinkPath: '.audit/event-wiring-metrics.jsonl', runId, learningWritesAllowed,
    });
  } catch (err) {
    // Cluster-B audit-code R1/H3 fix: this call does non-trivial git I/O
    // (batched blob reads, lock acquisition for D12 reconciliation) and was
    // previously unguarded — an exception here would propagate past this
    // mechanical wave's own caller and crash the WHOLE audit run, the exact
    // failure mode orphan-introduced's own resolver call is already guarded
    // against (see the try/catch around `buildEventWiringDiffScope` above).
    // A mechanical detector degrading to ERROR must never take the run down.
    process.stderr.write(`  [event-wiring] detector error: ${err.message}\n`);
    return { state: 'ERROR', result: { ...emptyResult, result: { ...emptyResult.result, summary: `detector: ${err.message}` } } };
  }

  if (detectorOut.partial) {
    // D11's partial-corpus safety: no new finding, no record close — the
    // metrics write already happened inside detectEventWiringAsymmetry
    // itself (its own step 2.5), gated there on the same
    // `learningWritesAllowed` this function was passed (an earlier draft
    // left this write unconditional, unlike orphan's short-circuit emit —
    // fixed so an observation-only shadow run can't double-count a commit).
    return { state: 'ANALYZED_PARTIAL', result: { ...emptyResult, result: { ...emptyResult.result, summary: `partial scan — ${detectorOut.counters.skippedFiles} file(s) skipped` } } };
  }

  // Post-processing pipeline (fingerprint + ledger-suppress) — same shared
  // path orphan-introduced uses, so R2+ dismiss/fix suppression applies
  // uniformly across mechanical waves. Operates on the RAW event-wiring
  // findings (kind/eventName/locus intact) — `findingFingerprint` already
  // knows the `event-wiring-symmetry`/`event-wiring-orphaned-pragma` kinds.
  const { survivors, suppressed } = processFindings(detectorOut.findings, { ledger, planContent });

  const findings = survivors.map((f, i) => eventWiringToStandardFinding(f, i));
  const state = findings.length > 0 ? 'ANALYZED_WITH_FINDINGS' : 'ANALYZED_CLEAN';
  const summary = findings.length === 0
    ? `No event-wiring asymmetries. ${detectorOut.counters.testDispatchSites ?? 0} test-only dispatch site(s), ${detectorOut.counters.dynamicListenSites ?? 0} dynamic listen site(s).`
    : `${findings.length} event-wiring-symmetry finding(s) surfaced (${detectorOut.findings.length} raw, ${suppressed.length} suppressed).`;

  const latencyMs = Date.now() - startedAt;
  return {
    state,
    result: {
      result: { pass_name: 'event-wiring-symmetry', findings, summary },
      usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: latencyMs },
      latencyMs,
    },
  };
}

/**
 * Add one `safeCallGPT` usage envelope into an accumulator, treating a null
 * accumulator as "nothing measured yet".
 *
 * Deliberately NOT a shared export: `runMapReducePass` already sums usage
 * inline over its MAP units, and collapsing the two would couple a hot
 * map-reduce loop to a helper for a once-per-pass callback. Grepped for an
 * existing summer first (`addUsage`/`sumUsage`/`mergeUsage`) — none existed.
 *
 * @param {object|null} acc
 * @param {{input_tokens?:number, cached_tokens?:number, output_tokens?:number, reasoning_tokens?:number, latency_ms?:number}} next
 */
function addUsage(acc, next) {
  const base = acc ?? { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 };
  return {
    input_tokens: base.input_tokens + (next.input_tokens ?? 0),
    cached_tokens: base.cached_tokens + (next.cached_tokens ?? 0),
    output_tokens: base.output_tokens + (next.output_tokens ?? 0),
    reasoning_tokens: base.reasoning_tokens + (next.reasoning_tokens ?? 0),
    latency_ms: base.latency_ms + (next.latency_ms ?? 0),
  };
}

/**
 * Duplication audit pass (Wave 5) — mechanical detector → LLM bouncer →
 * deterministic fallback, mirroring `runArchitecturePass`'s two-stage shape.
 *
 * **Extracted from `runLegacyProductionAudit`'s body (2026-08-13).** The wave
 * had mirrored that shape since it landed, but not the `{result, usage,
 * latencyMs}` return contract this repo's passes follow: inline, the result
 * literal sat ~40 lines below its own `safeCallGPT` call and hard-coded
 * `usage: { input_tokens: 0, ... }`. `runLegacyProductionAudit` reduces
 * `allResults[].usage` into `totalUsage`, so the bouncer's tokens never
 * reached `_usage.costUsd` (under-reported spend) or `cacheMetrics.hitRate`
 * (whose denominator feeds the weekly `cache-hitrate-check`) — a fabricated
 * zero reading as a measurement. The waves already extracted into functions
 * (`runArchitecturePass`, `runOrphanIntroducedPass`) never had the bug,
 * because a function boundary is what carries the contract.
 *
 * Guarded by tests/audit-wave-usage-accounting.test.mjs, which asserts the
 * observable consequence (`result._usage`) and carries both a vacuous-pass
 * guard and a no-call negative control.
 *
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function runDuplicationPass({
  openai, ctx, passPrompt, changedFiles, auditBaseCommit,
  focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus,
}) {
  const dupStart = Date.now();
  // The bouncer's measured usage, or null when no model call was made. Null →
  // a zeroed envelope below, which is an honest "nothing was spent" rather
  // than the constant this extraction removes.
  // Counted independently of the token values, so "the bouncer was not invoked"
  // stays distinguishable from "it ran and reported nothing" — the shadow
  // reviewer's finding that no persisted signal separated those two.
  let bouncerCalls = 0;
  let bouncerUsage = null;
  let dupFindings = [];
  let dupSummary = '';
  try {
    let report = { state: 'unavailable', reason: 'no auditBaseCommit resolved for this audit run', deterministicFindings: [], semanticCandidates: [] };
    // Test-only injection point (round-1 code-audit M25/M26 fix): when set,
    // bypasses Git resolution entirely and calls the override directly —
    // a hermetic test harness can exercise the findings -> bouncer ->
    // convergence path with a synthetic report, with no live Git/DB/
    // embedding access and no need to also fake a real auditBaseCommit.
    // Production callers never set this; it defaults to undefined.
    if (ctx.__runDuplicationAnalysis) {
      report = await ctx.__runDuplicationAnalysis({ repoRoot: process.cwd(), changedFiles: changedFiles || [], auditBaseCommit });
    } else if (auditBaseCommit) {
      const diff = gitDiffWithWorkingTree(process.cwd(), auditBaseCommit);
      if (diff.ok) {
        const scopeSet = new Set((changedFiles || []).map(normalizePath));
        const inScope = (p) => scopeSet.size === 0 || scopeSet.has(normalizePath(p));
        const richChangedFiles = [
          ...diff.files.added.filter(inScope).map((p) => ({ status: 'added', currentPath: p })),
          ...diff.files.modified.filter(inScope).map((p) => ({ status: 'modified', currentPath: p })),
          ...diff.files.untracked.filter(inScope).map((p) => ({ status: 'added', currentPath: p })),
          ...diff.files.renamed.filter((r) => inScope(r.to)).map((r) => ({ status: 'renamed', currentPath: r.to, previousPath: r.from })),
        ];
        report = await runDuplicationAnalysis({ repoRoot: process.cwd(), changedFiles: richChangedFiles, auditBaseCommit });
      } else {
        report = { state: 'unavailable', reason: `git diff failed: ${diff.error.message}`, deterministicFindings: [], semanticCandidates: [] };
      }
    }

    if (report.state === 'clean') {
      dupSummary = 'Duplication: clean — no candidates over threshold.';
    } else if (report.state === 'unavailable') {
      process.stderr.write(`  Duplication: SKIPPED (unavailable — ${report.reason})\n`);
      dupSummary = `Duplication: SKIPPED (unavailable — ${report.reason})`;
    } else if (report.state === 'failed') {
      process.stderr.write(`  Duplication: FAILED — ${report.reason}\n`);
      dupFindings = [buildDetectorFailedFinding(report.reason)];
      dupSummary = 'Duplication: detector failed — see finding.';
    } else {
      // 'findings' — deterministicFindings always land unconditionally;
      // semanticCandidates go through the bouncer (round-2 M3: never let a
      // bouncer outcome affect the deterministic channel).
      const deterministic = finalizeDeterministicFindings(report.deterministicFindings);
      let semanticFindings = [];
      if (report.semanticCandidates.length > 0) {
        const { prompt, includedIds } = formatCandidatesForPrompt(report.semanticCandidates, { repoRoot: process.cwd() });
        const included = report.semanticCandidates.filter((c) => includedIds.includes(c.id));
        if (included.length === 0) {
          semanticFindings = []; // every candidate refused by the egress scan — nothing to send
        } else {
          const dupLimits = computePassLimits(prompt.length, 'low');
          const bouncerResult = await safeCallGPT(openai, {
            ...passPrompt({
              rubric: getPassPrompt('duplication'),
              focusBlock,
              passName: 'duplication',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: `## Candidates (${included.length})`,
              code: prompt,
            }),
            schema: DuplicationBouncerResponseSchema,
            schemaName: 'duplication_bouncer',
            reasoning: 'low',
            ...dupLimits,
            passName: 'duplication',
          }, null);
          // Captured whether or not the call succeeded: a failed bouncer still
          // burns tokens, and dropping them would re-open this defect on the
          // degraded path only — the harder half to notice.
          bouncerCalls += 1;
          bouncerUsage = bouncerResult?.usage ?? null;
          const decisions = bouncerResult?.result?.decisions;
          const mapped = decisions ? mapBouncerDecisionsToFindings(decisions, included, includedIds) : { ok: false, reason: 'bouncer call failed or returned no decisions' };
          if (mapped.ok) {
            semanticFindings = mapped.findings;
          } else {
            process.stderr.write(`  Duplication bouncer failed (${mapped.reason}) — using deterministic fallback for ${included.length} candidate(s)\n`);
            semanticFindings = deriveFindingsFromDuplicationReport(included);
          }
        }
      }
      dupFindings = [...deterministic, ...semanticFindings];
      dupSummary = `Duplication: ${dupFindings.length} finding(s) (${deterministic.length} deterministic, ${semanticFindings.length} semantic).`;
    }
  } catch (err) {
    // Still fail-open — a wave must never abort the audit — but the error is no
    // longer flattened to a message. A TypeError from a bad injected seam and a
    // detector I/O failure produced identical output, so a programming bug in
    // this pass was indistinguishable from the environment being unavailable,
    // and read as an ordinary "detector failed" finding. `err.name` + the stack
    // are what tell those apart; the finding text keeps the message so the
    // report is unchanged.
    process.stderr.write(`  Duplication: unexpected ${err?.name || 'Error'} — ${err?.message}\n${err?.stack ? `${err.stack}\n` : ''}`);
    dupFindings = [buildDetectorFailedFinding(`${err?.name || 'Error'}: ${err?.message}`)];
    dupSummary = `Duplication: unexpected ${err?.name || 'Error'} — see finding.`;
  }
  return {
    result: { pass_name: 'duplication', findings: dupFindings, summary: dupSummary },
    callCount: bouncerCalls,
    usage: bouncerUsage ?? { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: Date.now() - dupStart,
  };
}

/**
 * Containment-adjacency audit pass (Wave 6) — deterministic detector enumerates,
 * LLM bouncer only judges what it is handed.
 *
 * Extracted alongside `runDuplicationPass` (2026-08-13) and for the same
 * reason: see that function's docblock for why the inline form could not carry
 * the `{result, usage, latencyMs}` contract. This wave's bouncer usage arrives
 * through a `callLlm` CALLBACK rather than a direct return, so it is captured
 * into the enclosing scope — `runAdjacencyBouncer` invokes that callback at
 * most once (adjacency-report.mjs), but the capture accumulates rather than
 * overwrites so a future second call cannot silently drop the first's tokens.
 *
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function runAdjacencyPass({
  openai, ctx, passPrompt, auditBaseCommit,
  focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus,
}) {
  const adjStart = Date.now();
  // Counted independently of the token values, so "the bouncer was not invoked"
  // stays distinguishable from "it ran and reported nothing" — the shadow
  // reviewer's finding that no persisted signal separated those two.
  let bouncerCalls = 0;
  let bouncerUsage = null;
  let adjFindings = [];
  let adjSummary = '';
  try {
    // No diff contract → NOT-APPLICABLE, not a failure. The wave is
    // diff-triggered by construction (§D1), so on a `--scope full` or
    // base-less run there is nothing it could ever have been asked. Skipping
    // the detector entirely is what keeps that honest: running it would
    // record "no safe auditBaseCommit" as INPUT_BOUND incompleteness, which
    // emits a control finding — turning honest absence into a reported
    // coverage failure, the exact conflation R1-H3 split apart.
    // The test seam wins over Git resolution (mirroring Wave 5's), so a
    // hermetic test can exercise this whole path without faking a commit.
    const analysis = ctx.__runAdjacencyAnalysis
      ? await ctx.__runAdjacencyAnalysis({ repoRoot: process.cwd(), auditBaseCommit, bounds: adjacencyConfig })
      : !auditBaseCommit
        ? { coverage: { containersEnumerated: 0, statementsJudged: 0 }, candidates: [], incompleteness: [], threw: null }
        : await runAdjacencyAnalysis({ repoRoot: process.cwd(), auditBaseCommit, bounds: adjacencyConfig });

    // The bouncer runs only when there is something to judge. Zero eligible
    // candidates short-circuits without a model call.
    let bouncer = null;
    const eligible = (analysis.candidates ?? []).filter((c) => c.payload?.safe);
    if (eligible.length > 0) {
      bouncer = await runAdjacencyBouncer(analysis.candidates, {
        bounds: adjacencyConfig,
        rubric: getPassPrompt('adjacency'),
        callLlm: async ({ prompt, rubric }) => {
          const adjLimits = computePassLimits(prompt.length, 'low');
          const res = await safeCallGPT(openai, {
            ...passPrompt({
              rubric,
              focusBlock,
              passName: 'adjacency',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: `## Adjacency candidates (${eligible.length})`,
              code: prompt,
            }),
            schema: AdjacencyBouncerResponseSchema,
            schemaName: 'adjacency_bouncer',
            reasoning: 'low',
            ...adjLimits,
            passName: 'adjacency',
          }, null);
          bouncerCalls += 1;
          if (res?.usage) bouncerUsage = addUsage(bouncerUsage, res.usage);
          return res?.result ?? null;
        },
      });
    }

    // ONE composition point — the sole buildAdjacencyState call site.
    const composed = composeAdjacencyResult({
      analysis,
      bouncer,
      selected: true,
      diffContractAvailable: Boolean(auditBaseCommit) || Boolean(ctx.__runAdjacencyAnalysis),
    });
    adjFindings = composed.findings;
    const { state, coverage } = composed.result;
    adjSummary = `Adjacency: ${state} — ${coverage.containersEnumerated} container(s), `
      + `${coverage.statementsJudged} statement(s) judged, ${composed.result.candidates.length} candidate(s).`;
    process.stderr.write(`  ${adjSummary}\n`);
  } catch (err) {
    // Same reasoning as runDuplicationPass's catch above: fail-open, but name
    // the error CLASS so a programming bug is not reported as a detector
    // failure.
    process.stderr.write(`  Adjacency: unexpected ${err?.name || 'Error'} — ${err?.message}\n${err?.stack ? `${err.stack}\n` : ''}`);
    adjFindings = [buildAdjacencyFailedFinding(`${err?.name || 'Error'}: ${err?.message}`)];
    adjSummary = `Adjacency: unexpected ${err?.name || 'Error'} — see finding.`;
  }
  return {
    result: { pass_name: 'adjacency', findings: adjFindings, summary: adjSummary },
    callCount: bouncerCalls,
    usage: bouncerUsage ?? { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: Date.now() - adjStart,
  };
}

/**
 * Ground the LLM bouncer's findings to what the MECHANICAL analyser actually
 * flagged — "the bouncer only judges what it's handed."
 *
 * Why (2026-07-20): the bouncer is handed the full architecture-intent mermaid
 * diagram plus the mechanical violations, and the LLM reasons from the DIAGRAM
 * to "notice" edges that look questionable — re-raising imports the mechanical
 * layer already checked against allowedDeps and CLEARED. Reproduced: a run
 * whose only mechanical violation was `stores → plan` emitted 16 findings
 * claiming `brainstorm → requirements` violates a boundary. That edge is
 * EXPLICITLY in allowedDeps["brainstorm"] — the mechanical detector correctly
 * never flagged it; the bouncer invented it from the diagram. These recur on
 * every audit (the arch pass scans the whole repo, not the diff) and were the
 * dominant driver of the memory-health cluster-density trigger.
 *
 * The bouncer's schema carries no structured edge, but every finding carries a
 * `section` (its file). A legitimate bouncer finding classifies a mechanical
 * violation, so its file is one the mechanical layer flagged. A finding whose
 * file is NOT in {violation fromFile/toFile} ∪ {unmapped files} is ungrounded
 * and dropped. A finding with no file-like section is KEPT (conservative — a
 * domain-level dead-intent finding legitimately names no file, and we do not
 * drop what we cannot disprove).
 *
 * Pure. @returns {{kept: object[], dropped: object[]}}
 */
export function groundArchFindingsToReport(findings, report) {
  if (!Array.isArray(findings) || findings.length === 0) return { kept: findings ?? [], dropped: [] };
  const flagged = new Set();
  for (const v of report?.violations ?? []) {
    if (v.fromFile) flagged.add(normalizePath(v.fromFile));
    if (v.toFile) flagged.add(normalizePath(v.toFile));
  }
  for (const u of report?.unmappedFiles ?? []) {
    if (typeof u === 'string') flagged.add(normalizePath(u));
  }
  // A section is "file-like" if it carries a path separator or a file
  // extension. `section` may be `path` or `path:symbol`/`path:line` — take the
  // part before the first colon (after any Windows drive letter).
  const fileOf = (f) => {
    const raw = f?._primaryFile || f?.section;
    if (typeof raw !== 'string' || !raw) return null;
    // Skip a leading Windows drive letter (e.g. "C:") before splitting off a
    // trailing ":symbol"/":line" suffix, so the drive letter's own colon
    // isn't mistaken for that suffix separator (39a73f09 — the prior
    // sentinel-based approach also embedded literal NUL bytes in the source).
    const driveMatch = raw.match(/^[A-Za-z]:/);
    const rest = driveMatch ? raw.slice(driveMatch[0].length) : raw;
    const stripped = (driveMatch ? driveMatch[0] : '') + rest.split(':')[0];
    return /[\\/]|\.[A-Za-z0-9]+$/.test(stripped) ? normalizePath(stripped) : null;
  };
  const kept = [], dropped = [];
  for (const f of findings) {
    const file = fileOf(f);
    if (file === null || flagged.has(file)) kept.push(f);
    else dropped.push(f);
  }
  return { kept, dropped };
}

/**
 * Format a mechanical report into the prompt body for the LLM bouncer.
 * Aggregates by (fromDomain, toDomain, ruleViolated) when >20 violations
 * to stay within token budget (decision 16).
 */
function formatViolationsForPrompt(report, intent) {
  const lines = [];
  if (intent.mermaid) {
    lines.push('## Intended boundaries (from architecture-intent.md)');
    lines.push('```mermaid');
    lines.push(intent.mermaid);
    lines.push('```');
    lines.push('');
  }
  lines.push(`## Mechanical Violations (${report.violations.length} total)`);
  if (report.violations.length > 20) {
    // Aggregate by (fromDomain, toDomain, ruleViolated)
    const clusters = new Map();
    for (const v of report.violations) {
      const key = `${v.fromDomain} → ${v.toDomain} (${v.ruleViolated})`;
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(v);
    }
    for (const [key, vs] of clusters) {
      lines.push(`- **${key}**: ${vs.length} edges`);
      for (const v of vs.slice(0, 3)) {
        lines.push(`  - ${v.fromFile} → ${v.toFile}`);
      }
      if (vs.length > 3) lines.push(`  - ... and ${vs.length - 3} more`);
    }
  } else {
    for (const v of report.violations) {
      lines.push(`- ${v.fromDomain} → ${v.toDomain}: ${v.fromFile} → ${v.toFile}`);
    }
  }
  if (report.unmappedFiles.length > 0) {
    lines.push('');
    lines.push(`## Unmapped Files (${report.unmappedFiles.length})`);
    for (const f of report.unmappedFiles.slice(0, 30)) lines.push(`- ${f}`);
    if (report.unmappedFiles.length > 30) lines.push(`- ... and ${report.unmappedFiles.length - 30} more`);
  }
  if (report.deadIntent.length > 0) {
    lines.push('');
    lines.push(`## Dead Intent (${report.deadIntent.length})`);
    for (const d of report.deadIntent) lines.push(`- ${d}`);
  }
  if (report.perStackResults.some(r => r.status === 'error')) {
    lines.push('');
    lines.push('## Per-stack Analyzer Failures');
    for (const r of report.perStackResults.filter(r => r.status === 'error')) {
      lines.push(`- ${r.stackKind}: ${r.error?.message}`);
    }
  }
  return lines.join('\n');
}

/**
 * Deterministic fallback rubric (decision 11). Used when the LLM bouncer
 * fails — emits findings from the mechanical report alone. No HIGH severity
 * (cross-cutting detection requires LLM judgement).
 *
 * Phase 5 (audit-orchestrator-hardening, audit-plan fix H3): `FindingBase`
 * (schemas.mjs) requires `id`/`severity`/`category`/`section`/`detail`/
 * `risk`/`recommendation`/`is_quick_fix`/`is_mechanical`/`principle` — ALL
 * non-optional. This function previously omitted `id` and `risk` on every
 * branch (every other field was already present). Both are added here and
 * every emitted finding is routed through `FindingSchema.parse(...)` —
 * `id` is a new `A`-prefixed monotonic sequence (mirrors the `T`-prefixed
 * tool-finding convention: `H`/`M`/`L` = model-assigned, `T` = tool,
 * `A` = architecture-deterministic); `risk` is one deterministic sentence
 * per violation TYPE (the four loops below are four structurally distinct
 * violation classes, not four instances of one class).
 */
function deriveFindingsFromReport(report) {
  const findings = [];
  let archIdCounter = 0;
  const nextId = () => `A${++archIdCounter}`;
  for (const v of report.violations) {
    findings.push(FindingSchema.parse({
      id: nextId(),
      severity: 'MEDIUM',
      category: '[Architecture] Forbidden cross-domain edge',
      detail: `${v.fromFile} (${v.fromDomain}) imports ${v.toFile} (${v.toDomain}); not in allowedDeps[${v.fromDomain}].`,
      risk: "Violates the plan's stated domain boundary — changes in one domain can now silently break the other.",
      recommendation: `Either move one of the files to align with allowed deps OR explicitly update allowedDeps in .audit-loop/domain-map.json with rationale in architecture-intent.md.`,
      section: v.fromFile,
      affectedFiles: [v.fromFile, v.toFile],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: false,
      is_mechanical: true,
      is_reopened: false,   // mechanical wave — never reopens a prior ruling
      principle: '#5 SSoT',
    }));
  }
  for (const f of report.unmappedFiles) {
    if (!f.startsWith('src/') && !f.startsWith('scripts/')) continue; // heuristic
    findings.push(FindingSchema.parse({
      id: nextId(),
      severity: 'LOW',
      category: '[Architecture] File missing domain rule',
      detail: `${f} is not matched by any rule in .audit-loop/domain-map.json.`,
      risk: "This file's dependencies are unevaluated by the architecture gate until a rule exists for it.",
      recommendation: 'Add a rule for this path so its dependencies can be evaluated.',
      section: f,
      affectedFiles: [f],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: true,
      is_mechanical: true,
      is_reopened: false,   // mechanical wave — never reopens a prior ruling
      principle: '#5 SSoT',
    }));
  }
  for (const d of report.deadIntent) {
    findings.push(FindingSchema.parse({
      id: nextId(),
      severity: 'LOW',
      category: '[Architecture] Dead declared domain',
      detail: `Domain "${d}" is declared in domain-map.json but no files match.`,
      risk: 'A stale domain entry misleads future domain-boundary decisions.',
      recommendation: 'Either remove the unused domain from the spec, or add files that will live in it.',
      section: '.audit-loop/domain-map.json',
      affectedFiles: ['.audit-loop/domain-map.json'],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: true,
      is_mechanical: true,
      is_reopened: false,   // mechanical wave — never reopens a prior ruling
      principle: '#5 SSoT',
    }));
  }
  for (const r of report.perStackResults.filter(r => r.status === 'error')) {
    findings.push(FindingSchema.parse({
      id: nextId(),
      severity: 'MEDIUM',
      category: `[Architecture] Stack analyzer failure (${r.stackKind})`,
      detail: r.error?.message ?? 'unknown error',
      risk: 'The architecture check silently produced no signal for this stack — a real violation could be passing undetected.',
      recommendation: `Check that the ${r.stackKind} adapter dependencies are installed and the repo is in a parsable state.`,
      section: r.stackKind,
      affectedFiles: [],
      affectedPrinciples: ['#15 Error Handling'],
      is_quick_fix: false,
      is_mechanical: true,
      is_reopened: false,   // mechanical wave — never reopens a prior ruling
      principle: '#15 Error Handling',
    }));
  }
  return findings;
}

// finalizePriorRoundOutcomes moved to the shared lib/finalize-outcomes.mjs
// (2026-07-13) so the PLAN branch in openai-audit.mjs runs the identical
// deterministic outcome capture — imported above.
/**
 * The extracted production pass-orchestration loop (Waves 1-4, merge/dedup,
 * R2+ suppression, ledger write, verdict computation) — a pure relocation of
 * `runMultiPassCodeAudit`'s original body (tiered-recall pipeline Phase 11),
 * with no behavior change beyond: (a) taking one `ctx: AuditRunContext` param
 * instead of ~19 loose params (destructured back into the SAME local names
 * below, so the rest of this function's ~1600 lines are untouched), (b) the
 * Phase 10 `return mergedResult` (already present pre-extraction), and
 * (c) setting `generatorOutcomes: []` / `runStatus: 'complete'` on the return
 * (this branch has no discovery-portfolio generators to report).
 *
 * CLI-presentation concerns (`jsonMode`, the final `--out` write / pretty
 * print) are NOT part of `ctx` — they stay in `openai-audit.mjs`'s `main()`,
 * operating on this function's return value. `outFile` IS part of `ctx`
 * (deviation from the plan's literal field list — see the module docblock
 * in `../schemas.mjs` `AuditRunContextSchema` for why): it is genuinely used
 * internally for artifact-path resolution (the pass-result recovery cache's
 * directory, and R2+'s prior-round-outcome finalisation via the
 * `<sid>-r<N>-result.json` naming convention) — a location HINT for
 * orchestration bookkeeping, distinct from "write the final result to disk",
 * which is the wrapper's job.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @returns {Promise<import('../schemas.mjs').AuditRunResult>}
 */
export async function runLegacyProductionAudit(ctx) {
  // `let`, not `const` (plan deviation, noted): the observation-mode view swap
  // below reassigns `bandit`, and a const destructure would throw. The local
  // binding is the function's complete use surface for it (verified: addArm,
  // flush, syncBanditArms — no helper receives `bandit`, no ctx.bandit re-read).
  let {
    planContent, projectContext, historyContext = '',
    passFilter = null, fileFilter = null, round = 1, ledgerFile = null, diffFile = null,
    changedFiles = [], auditBaseCommit = null, repoProfile = null, bandit = null, fpTracker = null, noLedger = false,
    noTools = false, strictLint = false, noDebtLedger = false, readOnlyDebt = false,
    debtLedgerPath = undefined, debtEventsPath = undefined, escalateRecurring = null,
    sessionCacheHit = null, scopeMode = null, planFile = null, runId = null, allowInfraScope = false,
    outFile = null, providers = {}, noCloudRecording = false,
    // Present in ctx since buildAuditRunContext, but never destructured until
    // 2026-08-13 — which is why the orphan wave could not tell a dirty tree
    // from a clean one and hard-coded its range. See resolveOrphanScopeRefs.
    workingTreeDirty = false,
  } = ctx;
  const { openai } = providers;

  // May THIS run write learning state (cloud or local)? One policy, one place.
  // noCloudRecording marks an observation-only run (tiered shadow /
  // verify-anchor-contract): it must be able to READ bandit/fpTracker so its
  // suppression behaviour stays faithful to the real audit, but must never
  // persist — the real, concurrent gating audit is the only writer. This
  // boolean closes the CLOUD channel at the tail's sync sites; the view swap
  // below closes the LOCAL channel (addArm._save / flush on a shared
  // instance). Both are needed: the tail's arms sync reads the map directly,
  // regardless of which store the bandit carries.
  const learningWritesAllowed = !noCloudRecording;
  // Swap BEFORE any use — the local's complete in-function use surface is
  // the arm registration, the tail flush, and the tail arms sync.
  if (!learningWritesAllowed && bandit) bandit = bandit.nonPersistingView();
  const totalStart = Date.now();
  _runSeedUsed = false; // reset run-scoped cache-seed flag (CLI = one run/process)
  _runSeedEligible = false;
  _runSeedSkipReason = null;

  // Initialize pass result cache — survives merge crashes
  initResultCache(outFile);

  // Deterministic outcome capture: finalize the prior round's outcomes before
  // running round N's audit (best-effort, never blocks). See the helper above.
  // 062e1be1: gated on learningWritesAllowed — this call previously ran
  // unconditionally, writing learning-outcome state even during a shadow/
  // observation-only (noCloudRecording) run. finalizePriorRoundOutcomes
  // already catches and logs its own internal failures (never throws), so
  // no result-checking is needed here beyond the policy gate.
  await writeLearningState(learningWritesAllowed, () => finalizePriorRoundOutcomes({ outFile, round, ledgerFile }));

  // Count diff lines for metadata (lines starting with + or - but not +++ / ---)
  let diffLinesChanged = null;
  let diffFilesChanged = null;
  if (diffFile) {
    try {
      const diffContent = fs.readFileSync(diffFile, 'utf-8');
      const lines = diffContent.split('\n');
      diffLinesChanged = lines.filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---')).length;
      diffFilesChanged = (diffContent.match(/^diff --git/mg) || []).length || changedFiles.length;
    } catch (err) {
      // --diff was EXPLICITLY passed but is unreadable. Don't warn-and-proceed (Gemini
      // gate): silently degrading a targeted R2+ audit to no-annotation — or, for the
      // `base..HEAD` range-misuse, auditing the wrong scope — is the quasi-silent
      // failure A1 exists to kill. The user signalled intent by passing --diff; fail
      // fast so they fix the invocation (a unified-diff FILE, not a git range).
      const looksLikeRange = /\.\.|^[0-9a-f]{7,40}$/i.test(String(diffFile));
      throw new Error(
        `--diff "${diffFile}" is not a readable file (${err.code || err.message}). ` +
        (looksLikeRange
          ? `It looks like a git RANGE — --diff expects a unified-diff FILE: \`git diff base..HEAD > d.patch\` then \`--diff d.patch --changed <files>\`.`
          : `Pass a readable unified-diff file, or omit --diff.`)
      );
    }
  }
  if (diffFilesChanged == null && changedFiles.length > 0) diffFilesChanged = changedFiles.length;

  // Track which passes trigger map-reduce
  const mapReducePasses = [];
  const EMPTY_FINDINGS = { pass_name: 'empty', findings: [], quick_fix_warnings: [], summary: 'Pass skipped or failed.' };
  const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 0, files_found: 0, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'Pass skipped.' };

  // 1. Gather and classify files
  // `planFound` is what the PLAN references (and is what `missing`/`allPaths`
  // continue to describe — plan-accounting must keep meaning the plan).
  // `found` is what this audit will actually READ: the plan's files UNION any
  // scope-supplied file the plan never mentioned. Before this union, `--files`
  // and `--scope diff` were filters only, so a changed file absent from the
  // plan was intersected away and read by no pass — see mergeScopeFiles.
  const { found: planFound, missing, allPaths } = extractPlanPaths(planContent, { allowInfraFiles: allowInfraScope });
  const { files: found, addedFromScope, rejected: scopeRejected } = mergeScopeFiles(
    planFound, fileFilter, { allowInfraFiles: allowInfraScope },
  );
  if (addedFromScope.length > 0) {
    process.stderr.write(
      `  [scope] +${addedFromScope.length} changed file(s) not referenced by the plan, now in scope: `
      + `${addedFromScope.slice(0, 5).join(', ')}${addedFromScope.length > 5 ? ` (+${addedFromScope.length - 5} more)` : ''}\n`,
    );
  }
  if (scopeRejected.length > 0) {
    // Never silent: a scope file dropped by the admission guards (infra,
    // non-source extension, absent on disk) is information, not noise.
    process.stderr.write(
      `  [scope] ${scopeRejected.length} scope file(s) not admitted (infra/extension/not-on-disk): `
      + `${scopeRejected.slice(0, 5).join(', ')}${scopeRejected.length > 5 ? ` (+${scopeRejected.length - 5} more)` : ''}\n`,
    );
  }
  // Build LanguageContext from RAW found files BEFORE category-based classification.
  // classifyFiles() has JS-centric patterns (lacks Python test/frontend detection),
  // so Python files may end up in "backend" bucket silently — but langContext
  // must see them all for dependency resolution + package-root detection.
  const langContext = buildLanguageContext(found);
  if (langContext.pythonPackageRoots.length > 1) {
    process.stderr.write(`  [lang] Python package roots: ${langContext.pythonPackageRoots.join(', ')}\n`);
  }
  const { backend, frontend, shared } = classifyFiles(found);

  // Record audit start in cloud store (fire-and-forget). noCloudRecording
  // (set by the tiered-shadow-compare harness when this function runs as
  // the tiered pipeline's internal required-generator-failure fallback,
  // concurrently with the REAL, gating legacy audit for the same commit) —
  // this branch is invisible/observation-only by design and must never
  // write audit_runs/audit_findings/etc.; it previously tried to avoid
  // colliding with the real run's row via a `<runId>-shadow` id, which
  // isn't a valid uuid and just failed loudly on every reuse-probe/insert.
  let cloudRunId = null;
  let cloudRepoId = null;
  // Durable-write tally for this run (plan decision 3). Declared here so it
  // exists on EVERY exit path, including the ones that never reach the cloud
  // block — an absent tally and an all-zero tally must not be the same thing.
  const writeOutcomes = { written: 0, spilled: 0, lost: 0, skipped: 0, byWriter: {} };
  if (!noCloudRecording && (await isCloudEnabled()) && repoProfile) {
    // Cluster A (§2.1): resolve the STABLE audit_repos.id via repo_uuid identity
    // (not the volatile content fingerprint that fragmented B1). The returned
    // repoRowId is what every child table's repo_id FK stores.
    const repoRef = await resolveRepoForStore({ profile: repoProfile }).catch(() => null);
    cloudRepoId = repoRef?.repoRowId ?? null;
    if (cloudRepoId) {
      // Best-effort commit + branch capture — anchors the audit run to a code state.
      let commitSha = null;
      let branch = null;
      try {
        const { execFileSync } = await import('node:child_process');
        commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch { /* not a git repo, or git not on PATH */ }

      // If we have a plan file path, register it so audit_runs.plan_id links back.
      let planId = null;
      if (planFile) {
        // Discriminated result since 2026-08-12 (durability plan decision 6).
        // The `.catch(() => null)` this replaces collapsed a store failure into
        // the same null a plan-less run produces, so the audit recorded
        // `plan_id: null` — indistinguishable from a deliberate ad-hoc audit.
        const planRes = await upsertPlan(cloudRepoId, {
          path: planFile,
          skill: 'plan',
          status: 'in_progress',
          commitSha,
        }).catch((err) => ({ ok: false, reason: 'write-failed', message: err?.message ?? String(err) }));
        if (planRes.ok) {
          planId = planRes.planId;
        } else if (planRes.reason === 'write-failed') {
          // Degrade to a local-only run AND count it, so the audit reports the
          // lost linkage instead of proceeding as if no plan existed. Not a
          // registered durable writer — there is no envelope and nothing to
          // replay — so it is tallied under its own id, which is why `byWriter`
          // exists rather than a bare total.
          process.stderr.write(`  [learning] plan linkage lost: ${planRes.message}\n`);
          tallyWriteOutcomes(writeOutcomes, [{ outcome: 'lost', writerId: 'audit.planLink', error: planRes.message }]);
        } else {
          // cloud-off / invalid-input: today's silence, one line of why.
          process.stderr.write(`  [learning] no plan linkage (${planRes.reason}): ${planRes.message}\n`);
        }
      }

      // R2-H2: no `.catch(() => null)`. `recordRunStart` never throws — every
      // failure path logs `[learning] recordRunStart failed: …` and returns
      // null itself — so the catch was DEAD CODE that advertised a swallow
      // which was not happening, and would have masked a genuine future throw.
      // Same removal, same reasoning, as the `recordDiffComplexity` call below.
      cloudRunId = await recordRunStart(cloudRepoId, planFile || 'ad-hoc', 'code', {
        scopeMode, commitSha, branch, planId, runId,
      });

      // Phase 1 — adaptive-learning-v1 telemetry.  Compute diff_complexity
      // (file count, LOC, scope mode) and record pass_selection decision
      // pre-wave with outcome=null; the outcome is backfilled at audit-end.
      // Plan: docs/plans/adaptive-learning-phase-1-foundation.md §2 data flow
      if (cloudRunId) {
        const diffComplexity = {
          fileCount: Array.isArray(changedFiles) ? changedFiles.length : null,
          diffLines: diffLinesChanged,
          diffFiles: diffFilesChanged,
          scopeMode: scopeMode || null,
        };
        // 656f6586: gated on learningWritesAllowed (previously unconditional
        // — a shadow/observation-only run would still record diff-complexity
        // telemetry). The function returns { ok, error? } — never throws —
        // so `.catch()` was dead code masking nothing; check the result and
        // log a failure instead of silently discarding it.
        // Permission WRAPS durability — the composition already used at the
        // bandit/fp-pattern sites. `writeLearningState` answers "may this run
        // persist?" and reports nothing; `durableWrite` answers "did it land?".
        // Logging the failure (what this did before) is not the same as
        // REPRESENTING it: a logged failure leaves `writeOutcomes` untouched and
        // the run still reports complete.
        await writeLearningState(learningWritesAllowed, async () => {
          tallyWriteOutcomes(writeOutcomes, [await durableWrite('audit.diffComplexity', {
            runId: cloudRunId, complexity: diffComplexity, run_id: cloudRunId,
          })]);
        });

        // Record pass_selection decision (telemetry-only in v1; choice always
        // 'all' until Phase 3 promotes pass-selector to live).
        try {
          _learningRecordDecision({
            decisionType: 'pass_selection',
            repoId: cloudRepoId,
            auditRunId: cloudRunId,
            round: round || 1,
            sequence: 0,
            context: {
              scopeMode: scopeMode || null,
              fileCount: diffComplexity.fileCount,
              diffLines: diffComplexity.diffLines,
            },
            choice: { chose: 'all' },
            outcome: null,
          });
          _learningInstallHooks({ insertLearningDecision, backfillLearningOutcome, isCloudEnabled });
        } catch { /* validation failure — best-effort telemetry */ }
      }
    }
  }

  // ── Drain the write-spill queue (plan Phase 3) ────────────────────────────
  // At run START, not at the end: the store has just been shown to be reachable
  // (the run row above was written through it), and anything spilled by a
  // previous run should land before this run starts adding to the queue.
  //
  // Gated on `cloudRunId` because a drain replays into the store — with cloud
  // off `drainSpill` refuses anyway (`state: 'unavailable'`), and this avoids
  // taking the lock to be told so. Never fails the audit: a drain is
  // housekeeping, and the artifacts stay on disk for the next attempt.
  //
  // `unavailable` is REPORTED, not swallowed. It is not `drained: 0` — that is
  // the vacuous-pass distinction the shared core exists to preserve, and a
  // silent one here would hide exactly the backlog this feature accumulates.
  if (cloudRunId && !noCloudRecording) {
    try {
      // No `repoRoot`: it defaults to `process.cwd()`, which is what every other
      // root-taking call in this orchestrator passes explicitly (`runArchitecturePass`,
      // the duplication and adjacency analyses). Passing the default back in would
      // just be a second spelling of the same resolution.
      const drained = await drainSpill({ isCloudEnabled });
      if (drained.state === 'drained') {
        process.stderr.write(`  [durable-write] drained ${drained.drained} spilled write(s) (${drained.rejected} quarantined, ${drained.failed} retained)\n`);
      } else if (drained.state === 'unavailable') {
        process.stderr.write(`  [durable-write] spill drain unavailable: ${drained.reason}\n`);
      }
    } catch (err) {
      process.stderr.write(`  [durable-write] spill drain error: ${err?.message || err}\n`);
    }
  }

  // ── Cloud FP-pattern policy (Layer 3 input) ──────────────────────────────
  // Read the cross-repo/cross-machine FP patterns once per run and resolve them
  // into a cloud-only policy. cloudRepoId == null (cloud off, or the repo never
  // resolved) → policy stays null → the Layer-3 pass below is a no-op and the
  // run is byte-identical to a pre-cloud-FP audit.
  //
  // The lifecycle state is logged explicitly because "no patterns yet" and "the
  // read blew up" must be distinguishable: with rows only accumulating from
  // 2026-07-17 this layer is legitimately inert for a while, and a silent inert
  // layer is indistinguishable from a broken one.
  let cloudFpPolicy = null;
  if (!cloudRepoId) {
    // cloudRepoId is null for TWO different reasons and they must not read the
    // same: cloud genuinely off (expected, silent) vs cloud on but the repo
    // never resolved (a real failure that would otherwise make this layer
    // silently absent — the exact inert-vs-broken conflation this feature's
    // lifecycle logging exists to prevent).
    if (!noCloudRecording && repoProfile && await isCloudEnabled()) {
      process.stderr.write(`  [cloud-fp] repo unresolved — falling back to local-only\n`);
    }
  } else {
    try {
      const envelope = await loadFalsePositivePatterns(cloudRepoId);
      const built = buildCloudFpPolicy(envelope);
      cloudFpPolicy = built.policy;
      if (built.lifecycleState === 'loaded-active') {
        process.stderr.write(
          `  [cloud-fp] policy active: ${built.counts.repo} repo + ${built.counts.global} global patterns\n`
        );
      } else if (built.lifecycleState === 'loaded-zero') {
        process.stderr.write(`  [cloud-fp] no patterns yet (repo=0 global=0) — layer inert\n`);
      } else if (built.lifecycleState === 'degraded-global-dropped') {
        process.stderr.write(`  [cloud-fp] global scope unusable (${built.reason}) — repo patterns only\n`);
      } else {
        process.stderr.write(`  [cloud-fp] load failed (${built.reason}) — falling back to local-only\n`);
      }
    } catch (err) {
      // The loader is internally fail-open; this catches a synchronous throw and
      // gives it its OWN named state rather than laundering it into "no data".
      // err.name only — err.message can carry a DSN fragment.
      process.stderr.write(`  [cloud-fp] load failed (${err.name}) — falling back to local-only\n`);
      cloudFpPolicy = null;
    }
  }

  // ── Phase D: Debt Memory ─────────────────────────────────────────────────
  // Load persistent debt ledger so normal audits don't resurface known debt.
  // Runs every round (not just R2+) — debt is persistent across audit runs.
  const debtContext = selectEventSource({
    noDebtLedger,
    // R2-H3: `readOnly` now carries the observation-only capability too, not
    // just the `--read-only-debt` flag. `cloudEnabled` below already blocked
    // the CLOUD debt writes for such a run, but `selectEventSource` degrades to
    // a LOCAL source with `canWrite: !readOnly` — so a shadow run still wrote
    // local debt events and escalations, against a mode documented as "the
    // concurrent real audit is the only writer".
    //
    // Production behaviour is UNCHANGED: both callers that set
    // `noCloudRecording` (tiered-shadow-compare, verify-anchor-contract) also
    // set `noDebtLedger` + `readOnlyDebt` already, and a test pins that the
    // five flags travel together. That is exactly why this is worth closing —
    // the guarantee rested on callers remembering, which is the "convention,
    // not a capability boundary" shape `writeLearningState` exists to replace.
    readOnly: readOnlyDebt || !learningWritesAllowed,
    repoId: cloudRepoId,
    // cloudRepoId is only set inside the `await isCloudEnabled()` block above,
    // so a non-null value proves cloud is on and the repo resolved.
    // 9d9d478a: also require learningWritesAllowed — previously a shadow/
    // observation-only run still wrote debt events to the SHARED cloud
    // store; selectEventSource degrades gracefully to the local event log
    // when cloudEnabled is false (matching the pattern the other 5 already-
    // migrated write sites use — a downgrade, not a hard block), so this is
    // additive, not a new failure mode.
    cloudEnabled: cloudRepoId != null && learningWritesAllowed,
  });
  // Opportunistic local→cloud reconciliation when we're online (fix R3-H3)
  if (debtContext.source === 'cloud') {
    await reconcileLocalToCloud(debtContext, { eventsPath: debtEventsPath }).catch(e => {
      process.stderr.write(`  [debt] reconcile skipped: ${e.message}\n`);
    });
  }
  const debtLedger = await loadDebtLedger(debtContext, {
    ledgerPath: debtLedgerPath,
    eventsPath: debtEventsPath,
  });
  if (debtLedger.entries.length > 0) {
    const alreadyEscalated = debtLedger.entries.filter(e => e.escalated).length;
    process.stderr.write(`  [debt] ${debtLedger.entries.length} debt entries loaded (${alreadyEscalated} escalated)\n`);
  }
  // Audit session ID for event-log attribution. `Date.now()` alone is not
  // collision-safe (0342d9cc): two audits started in the same process, or on
  // the same machine in the same millisecond, would share one debt-event
  // session id and one round-1 manifest filename. `process.pid` distinguishes
  // concurrent processes; the random suffix distinguishes concurrent calls
  // within one process (this session id is a log-attribution key, not a
  // security token, so Math.random() is sufficient entropy here).
  const debtRunId = `audit-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  // Phase D.3 escalation gate: flip escalated=true on entries with
  // distinctRunCount >= threshold so they bypass suppression this round.
  // Emits one 'escalated' event per entry newly escalated.
  const newlyEscalated = [];
  if (escalateRecurring && Number.isFinite(escalateRecurring) && escalateRecurring > 0 && debtContext.canWrite) {
    const nowIso = new Date().toISOString();
    for (const entry of debtLedger.entries) {
      const runs = entry.distinctRunCount ?? entry.occurrences ?? 0;
      if (runs >= escalateRecurring && !entry.escalated) {
        entry.escalated = true;           // in-memory flag bypasses suppression
        entry.escalatedAt = nowIso;
        newlyEscalated.push({
          ts: nowIso,
          runId: debtRunId,
          topicId: entry.topicId,
          event: 'escalated',
        });
      }
    }
    if (newlyEscalated.length > 0) {
      const r = await appendEvents(debtContext, newlyEscalated, { eventsPath: debtEventsPath });
      if (r.written === newlyEscalated.length) {
        process.stderr.write(`  [debt] escalated ${r.written} recurring entries (distinctRunCount >= ${escalateRecurring}) to ${r.source}\n`);
      } else {
        process.stderr.write(`  [debt] escalation write incomplete: ${r.written}/${newlyEscalated.length} event(s) written to ${r.source} (distinctRunCount >= ${escalateRecurring})\n`);
      }
    }
  }

  // Split backend into routes vs services for manageable chunk sizes
  const backendRoutes = backend.filter(f => f.includes('/routes/'));
  const backendServices = backend.filter(f => !f.includes('/routes/'));
  const splitBackend = backend.length > BACKEND_SPLIT_THRESHOLD;

  // ── R2+ initialization ──────────────────────────────────────────────────────
  const isR2Plus = round >= 2;
  let ledger = null, diffMap = null, impactSet = [];
  let suppressionUnavailable = false;
  // Entries validateLedgerForR2 drops as malformed. Travels into _executionMeta
  // alongside suppressionUnavailable (see the merged-result assembly below):
  // the stderr line it used to be reported on exclusively is not a channel the
  // convergence verdict, the result JSON, or an operator reading either can see.
  let ledgerInvalidEntryCount = 0;
  // Ruling-set provenance for `audit_runs.suppression_stats` — see
  // `buildSuppressionStats`. Stays null on R1, where suppression never runs.
  let ledgerStats = null;

  if (isR2Plus) {
    process.stderr.write(`\n═══ R${round} MODE ═══\n`);

    // Preflight: validate ledger before relying on it for suppression.
    // Phase 2 (audit-orchestrator-hardening): validateLedgerForR2 now also
    // per-entry schema-validates the ledger and returns `validEntries` —
    // the ONLY consumer of the ledger file's contents from here on. We no
    // longer separately re-read + re-parse the file (the pre-Phase-2
    // behavior called validateLedgerForR2 for its boolean/logging side
    // effect only, then re-read the SAME file independently for actual use
    // — silently accepting a structurally-present-but-per-entry-malformed
    // `entries` array as "valid," never a suppression-logic merge).
    const ledgerValidation = validateLedgerForR2(ledgerFile, round);
    if (!ledgerValidation.valid) suppressionUnavailable = true;
    ledgerInvalidEntryCount = ledgerValidation.invalidEntryCount ?? 0;
    ledgerStats = ledgerValidation.valid
      ? {
        entryCount: ledgerValidation.entryCount ?? 0,
        // The denominator: how many RULINGS suppression had to match against.
        adjudicated: ledgerValidation.validEntries?.length ?? 0,
        pending: ledgerValidation.pendingEntryCount ?? 0,
        invalid: ledgerInvalidEntryCount,
      }
      : { unavailable: true };

    if (ledgerValidation.valid && ledgerFile) {
      // Re-wrap as {version:1, entries: validEntries} (Gemini gate fix G2,
      // round 2 of that gate) — applyLedgerSuppression/suppressReRaises's
      // existing contract is `if (!ledger || !Array.isArray(ledger.entries))
      // return {kept: findings, dropped: []}`; it expects an OBJECT with an
      // `.entries` array property, not a bare array. Passing `validEntries`
      // directly would make `ledger.entries` `undefined` on every call,
      // silently disabling suppression entirely — the exact opposite of
      // this phase's purpose.
      ledger = { version: 1, entries: ledgerValidation.validEntries };
    } else if (ledgerFile) {
      // Ledger file present but validation failed (missing/corrupt/malformed
      // top-level shape) — validateLedgerForR2 already logged the specific
      // reason; degrade to no suppression.
      ledger = { version: 1, entries: [] };
    } else {
      process.stderr.write(`  [ledger] No --ledger provided; R2+ suppression disabled\n`);
      ledger = { version: 1, entries: [] };
    }

    // Parse diff
    if (diffFile) {
      diffMap = parseDiffFile(diffFile);
    }

    // Compute impact set
    impactSet = computeImpactSet(changedFiles, found);
    process.stderr.write(`  [R2+] Impact: ${impactSet.length} files (${changedFiles.length} changed + ${impactSet.length - changedFiles.length} dependents)\n`);
  }

  // Phase 6: Register prompt variants as bandit arms using revision IDs
  // Build context for contextual bandit selection
  const banditContext = repoProfile ? buildContext(repoProfile) : null;
  if (bandit) {
    for (const pass of PASS_NAMES) {
      const revId = getActiveRevisionId(pass) || 'default';
      bandit.addArm(pass, revId, null, { promptRevisionId: revId });
    }
  }

  process.stderr.write(`\nMulti-pass code audit: ${found.length} files in scope (${planFound.length} from the plan + ${addedFromScope.length} changed-not-planned), ${missing.length} missing, ${allPaths.size} referenced\n`);
  process.stderr.write(`  Backend: ${backend.length} files (${backendRoutes.length} routes, ${backendServices.length} services) + ${shared.length} shared\n`);
  process.stderr.write(`  Frontend: ${frontend.length} files + ${shared.length} shared\n`);
  if (splitBackend) process.stderr.write(`  Backend split: YES (>${BACKEND_SPLIT_THRESHOLD} files → separate route + service passes)\n`);

  // History context for round 2+ (prevents re-raising resolved findings)
  const historyBlock = historyContext ? `\n${historyContext}\n` : '';

  // Heading names both sources: conflating "the plan referenced this" with
  // "this changed and is in scope" is what let a changed file look reviewed.
  let fileListContext = `## Files In Scope (${planFound.length} referenced by the plan, ${missing.length} missing`
    + (addedFromScope.length ? `, ${addedFromScope.length} changed but not plan-referenced` : '') + `)\n\n`
    + (missing.length ? `**Missing:** ${missing.join(', ')}\n\n` : '')
    + `**Found:** ${found.join(', ')}\n`
    + (addedFromScope.length
      ? `\n**Changed but NOT referenced by the plan** (in scope because they changed; the plan may need updating): ${addedFromScope.join(', ')}\n`
      : '');

  // Adaptive repo-context block (Phase 3 — adaptive-context-blast-radius):
  // give the auditor the file inventory + import adjacency so it cannot
  // hallucinate "missing module" for unchanged-but-imported files. Lives
  // in the cacheable stable prefix. T1 for diff scope, T3 for full.
  try {
    const tier = scopeMode === 'full' ? 'T3' : 'T1';
    const rc = getRepoContext({
      tier, scope: scopeMode || 'diff',
      targetPaths: changedFiles || [], baseDir: process.cwd(),
    });
    if (rc.block) {
      fileListContext += `\n\n## Repository Context (tier ${rc.resolvedTier})\n${rc.block}\n`;
      process.stderr.write(`  [repo-context] tier ${rc.requestedTier}→${rc.resolvedTier} (~${rc.tokensEst} tok)${rc.degraded ? ` [degraded: ${rc.fallbackReason}]` : ''}\n`);
      // Without this line the operator has no signal that the model is being
      // handed a partial file list — which is precisely how the silent
      // truncation went unnoticed for 1214 commits.
      if (rc.truncated) {
        const dropped = (rc.coverage?.sections || [])
          .filter((x) => x.state !== 'full')
          .map((x) => `${x.id}=${x.state}(${x.shown}/${x.total})`).join(' ');
        process.stderr.write(`  [repo-context] TRUNCATED ${dropped || '(unitemised)'}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`  [repo-context] skipped (non-blocking) — ${err.message}\n`);
  }

  // Requirements rubric (Plan-Phase B — requirements-layer): surface the
  // de-facto-requirements ledger as an audit rubric so a pass can flag a
  // diff that violates a repo invariant. Static across rounds → lives in
  // the cacheable msg #1. Non-blocking: ledger absent / unreadable → ''.
  let requirementsRubric = '';
  try {
    const reqTargets = (changedFiles && changedFiles.length) ? changedFiles : found;
    const rq = getRequirementsContext({ targetPaths: reqTargets, baseDir: process.cwd() });
    if (rq.block) {
      requirementsRubric = rq.block;
      process.stderr.write(`  [requirements] rubric: ${rq.inScopeCount} in-scope / ${rq.indexCount} indexed (~${rq.tokensEst} tok)${rq.stale ? ' [stale]' : ''}${rq.uncoveredTargets.length ? ` [${rq.uncoveredTargets.length} uncovered]` : ''}\n`);
    }
  } catch (err) {
    process.stderr.write(`  [requirements] skipped (non-blocking) — ${err.message}\n`);
  }
  // Wrapper: thread the run-static requirements rubric into every pass
  // prompt without repeating it at each call site.
  const passPrompt = (opts) => buildCachePrompt({ ...opts, requirementsRubric });

  // When --files is specified, scope quality passes to those files + their shared deps
  // This enables delta-only auditing on Round 2+
  const inScope = scopeToFileFilter(fileFilter);
  const scopedBackend = inScope(backend);
  const scopedFrontend = inScope(frontend);
  const scopedBackendRoutes = inScope(backendRoutes);
  const scopedBackendServices = inScope(backendServices);

  if (fileFilter) {
    process.stderr.write(`  File scope: ${fileFilter.length} files → ${scopedBackend.length} BE + ${scopedFrontend.length} FE in scope\n`);
  }

  // Helper: should a pass run? Checks --passes filter + repo profile relevance
  const shouldRunPass = (name) => {
    if (passFilter && !passFilter.includes(name)) return false;
    if (repoProfile?.passRelevance && repoProfile.passRelevance[name] === false) {
      process.stderr.write(`  ${name} SKIPPED (repo profile: not relevant)\n`);
      return false;
    }
    return true;
  };

  // Inject priority focus areas from repo profile into system prompts
  const priorityBlock = repoProfile?.focusAreas?.length > 0
    ? `\n\nPRIORITY CHECKS for this codebase:\n${repoProfile.focusAreas.map(f => `- ${f}`).join('\n')}\n`
    : '';

  // Phase B: classification rubric appended to every pass prompt.
  // sourceName pulled from config so model changes don't require prompt edits.
  const classificationBlock = buildClassificationRubric({ sourceKind: 'MODEL', sourceName: MODEL });

  // ── Phase 0 (Phase C): Tool Pre-Pass ────────────────────────────────────────
  // Runs language-appropriate linters/type-checkers. Advisory-by-default:
  // tool findings are included in output but don't affect verdict math unless --strict-lint.
  // Opt-out via --no-tools for untrusted repos.
  let toolFindings = [];
  let lintContext = '';
  const toolCapability = {
    toolsAvailable: [],
    toolsFailed: [],
    strictLint,
    disabled: noTools,
    timestamp: Date.now(),
  };
  if (!noTools) {
    process.stderr.write('\n── Phase 0: Tool Pre-Pass ──\n');
    const toolStart = Date.now();
    const toolResults = executeTools(found);
    toolFindings = normalizeToolResults(toolResults);
    toolCapability.toolsAvailable = toolResults.filter(r => r.status === 'ok').map(r => r.toolId);
    toolCapability.toolsFailed = toolResults.filter(r => r.status !== 'ok').map(r => ({ id: r.toolId, status: r.status }));
    lintContext = formatLintSummary(toolFindings);
    const t = ((Date.now() - toolStart) / 1000).toFixed(1);
    process.stderr.write(`  [phase0] ${toolFindings.length} tool findings across ${toolCapability.toolsAvailable.length} tool(s) in ${t}s (strict-lint=${strictLint})\n`);
  } else {
    process.stderr.write('\n── Phase 0: Tool Pre-Pass SKIPPED (--no-tools) ──\n');
  }

  const focusBlock = priorityBlock + classificationBlock + (lintContext ? '\n\n' + lintContext : '');

  // Read shared files ONCE — reuse across passes that need them
  const sharedContext = shared.length > 0 ? readFilesAsContext(shared, { maxPerFile: 6000, maxTotal: 20000 }) : '';

  // Estimate base context size (targeted context per pass, not full CLAUDE.md)
  const baseContextChars = 2000 + fileListContext.length + historyBlock.length; // ~2000 for targeted CLAUDE.md

  // 2. Wave 1: Structure + Wiring (mechanical, reasoning: low)
  // Skippable on Round 2+ via --passes (structure rarely changes after R1)
  const wave1Promises = [];

  // Captured once (Phase 3, audit-orchestrator-hardening) so the pass-result
  // registry can derive status:'skipped' without re-invoking shouldRunPass
  // (which has a stderr side effect on the repo-profile-skip branch).
  const runStructure = shouldRunPass('structure');
  if (runStructure) {
    const structureContextChars = baseContextChars + measureContextChars(found, 2000);
    const structureLimits = computePassLimits(structureContextChars, 'low');
    process.stderr.write(`\n── Wave 1: Structure + Wiring (parallel, reasoning: low) ──\n`);
    const structureFiles = readFilesAsContext(found, { maxPerFile: 2000, maxTotal: 30000 });
    wave1Promises.push(
      safeCallGPT(openai, {
        ...passPrompt({
          rubric: PASS_STRUCTURE_SYSTEM,
          focusBlock,
          passName: 'structure',
          planContent,
          ledgerFile: isR2Plus ? ledgerFile : null,
          impactSet,
          isR2Plus,
          historyBlock,
          fileListContext,
          codeHeader: '## File Signatures',
          code: structureFiles,
        }),
        schema: StructurePassSchema,
        schemaName: 'structure_pass',
        reasoning: 'low',
        ...structureLimits,
        passName: 'structure'
      }, EMPTY_STRUCTURE)
    );
  } else {
    process.stderr.write(`\n── Wave 1: Structure SKIPPED (--passes) ──\n`);
    wave1Promises.push(Promise.resolve({ result: EMPTY_STRUCTURE, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  const runWiring = shouldRunPass('wiring');
  if (runWiring) {
    const wiringFiles = found.filter(f => f.includes('/api/') || f.includes('/routes/'));
    const wiringContextChars = baseContextChars + measureContextChars(wiringFiles, 8000) + sharedContext.length;
    const wiringLimits = computePassLimits(wiringContextChars, 'low');
    const wiringCode = `${readFilesAsContext(wiringFiles, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`;
    wave1Promises.push(
      safeCallGPT(openai, {
        ...passPrompt({
          rubric: PASS_WIRING_SYSTEM,
          focusBlock,
          passName: 'wiring',
          planContent,
          ledgerFile: isR2Plus ? ledgerFile : null,
          impactSet,
          isR2Plus,
          historyBlock,
          fileListContext,
          codeHeader: '## API & Route Files',
          code: wiringCode,
        }),
        schema: WiringPassSchema,
        schemaName: 'wiring_pass',
        reasoning: 'low',
        ...wiringLimits,
        passName: 'wiring'
      }, EMPTY_WIRING)
    );
  } else {
    process.stderr.write(`  Wiring SKIPPED (--passes)\n`);
    wave1Promises.push(Promise.resolve({ result: EMPTY_WIRING, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  const [structureResult, wiringResult] = await Promise.all(wave1Promises);
  cacheWaveResults(['structure', 'wiring'], [structureResult, wiringResult]);

  // ── Wave 1.5: Architecture Intent (NEW, PR-A 2026-05-11) ─────────────────
  // Opt-in: only runs when docs/architecture-intent.md AND
  // .audit-loop/domain-map.json both exist.
  let archResult = {
    result: { pass_name: 'architecture', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };
  let archState = 'SKIPPED_NO_INTENT';
  let archReportForOrphan = null;
  if (shouldRunPass('architecture')) {
    const archOut = await runArchitecturePass({
      openai, repoRoot: process.cwd(), focusBlock, planContent, historyBlock,
      ledgerFile, impactSet, isR2Plus,
    });
    archState = archOut.state;
    archResult = archOut.result;
    archReportForOrphan = archOut.archReport;
  } else {
    archState = 'SKIPPED_PASS_FILTER';
  }
  process.stderr.write(`  [architecture] ${archState}\n`);
  archResult._state = archState;
  cachePassResult('architecture', archResult);

  // ── Wave 1.5b: Orphan-Introduced check (dead-code phase 1, 2026-05-12) ────
  // Deterministic mechanical pass — no LLM cost. Reuses the HEAD import graph
  // from the architecture pass (shared dep-cruiser invocation).
  // Plan: docs/plans/dead-code-phase-1-orphan-introduced.md
  let orphanResult = {
    result: { pass_name: 'orphan-introduced', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };
  let orphanState = 'SKIPPED_NO_GRAPH';
  if (shouldRunPass('orphan-introduced')) {
    // audit-orchestrator-hardening H1 (hardening-implementation audit round
    // 2): this used to do its OWN independent raw JSON.parse of ledgerFile,
    // completely bypassing Phase 2's `validateLedgerForR2` schema
    // validation — a malformed entry that Phase 2 would reject/skip could
    // still reach orphan analysis through this parallel path. Reuse the
    // SAME validated `ledger` (declared above, reassigned to
    // `{version:1, entries: validEntries}` in R2+ mode) rather than
    // re-reading the file — one validated ledger object, one consumer path.
    const ledgerForOrphan = isR2Plus ? ledger : null;
    // Scope this wave to the SAME range the rest of the audit uses: a clean tree
    // means "audit my last commit" (base..HEAD); a dirty tree means "audit my
    // uncommitted work", which routes through the resolver's working-tree mode
    // (Gemini-R3/H3 — tracked diff vs HEAD + untracked files). This used to be
    // two hard-coded literals below a comment describing the mode it never
    // selected. resolveOrphanScopeRefs owns the decision and says why the clean
    // arm must NOT be `null`.
    const orphanScope = resolveOrphanScopeRefs({ auditBaseCommit, workingTreeDirty });
    const orphanOut = await runOrphanIntroducedPass({
      archReport: archReportForOrphan,
      repoRoot: process.cwd(),
      baseRef: orphanScope.baseRef,
      headRef: orphanScope.headRef,
      runId: debtRunId,
      planContent,
      ledger: ledgerForOrphan,
      learningWritesAllowed,
    });
    orphanState = orphanOut.state;
    orphanResult = orphanOut.result;
  } else {
    orphanState = 'SKIPPED_PASS_FILTER';
  }
  process.stderr.write(`  [orphan-introduced] ${orphanState} — ${orphanResult.result.findings.length} findings\n`);
  orphanResult._state = orphanState;
  cachePassResult('orphan-introduced', orphanResult);

  // ── Wave 1.5c: event-wiring-symmetry check (docs/plans/event-wiring-symmetry.md) ──
  // Deterministic mechanical pass — no LLM cost. Committed-range-only (see
  // runEventWiringSymmetryPass's docstring for why it does not follow
  // orphan's dirty-tree branch).
  let eventWiringResult = {
    result: { pass_name: 'event-wiring-symmetry', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };
  let eventWiringState = 'SKIPPED_PASS_FILTER';
  if (shouldRunPass('event-wiring-symmetry')) {
    const ledgerForEventWiring = isR2Plus ? ledger : null;
    const eventWiringOut = await runEventWiringSymmetryPass({
      repoRoot: process.cwd(),
      auditBaseCommit,
      runId: debtRunId,
      ledger: ledgerForEventWiring,
      planContent,
      learningWritesAllowed,
    });
    eventWiringState = eventWiringOut.state;
    eventWiringResult = eventWiringOut.result;
  }
  process.stderr.write(`  [event-wiring-symmetry] ${eventWiringState} — ${eventWiringResult.result.findings.length} findings\n`);
  eventWiringResult._state = eventWiringState;
  cachePassResult('event-wiring-symmetry', eventWiringResult);

  // 3. Wave 2: Backend + Frontend quality (deep, reasoning: high)
  process.stderr.write('\n── Wave 2: Quality passes (parallel, reasoning: high) ──\n');

  const wave2Promises = [];
  const backendPassNames = [];

  // Use scoped file lists when --files is specified (delta-only auditing)
  const beCtx = readProjectContextForPass('backend');
  const bePlan = extractPlanForPass(planContent, 'backend');
  const effectiveRoutes = fileFilter ? scopedBackendRoutes : backendRoutes;
  const effectiveServices = fileFilter ? scopedBackendServices : backendServices;
  const effectiveBackend = fileFilter ? scopedBackend : backend;
  const effectiveFrontend = fileFilter ? scopedFrontend : frontend;

  // The audited subject-file set — hoisted to function scope so BOTH the A1
  // guard below AND the model-A/B generation shadow (far below) can read it. It
  // was previously block-scoped inside the guard, so the shadow's
  // `buildRedactedAuditContext([...subjectFiles])` referenced an undefined
  // binding (a ReferenceError that only surfaced once the shadow was enabled —
  // caught by the first live calibration run, model-ab-harness-v2).
  const subjectFiles = new Set([
    ...effectiveBackend, ...effectiveFrontend,
    ...(splitBackend ? [...effectiveRoutes, ...effectiveServices] : []),
  ]);

  // ── A1 guard: "audit your success paths" applied to the auditor ITSELF ──
  // Refuse to emit a verdict when 0 implementation files would reach the prompt
  // (hollow-but-confident result). Pure predicate lives in audit-scope.mjs.
  {
    // (1) File-set check — scope resolved to no subject files.
    const guardMsg = auditSubjectFileGuard({
      scopeMode, subjectFileCount: subjectFiles.size, hasFileFilter: Boolean(fileFilter),
      foundCount: found.length, referencedCount: allPaths.size,
    });
    if (guardMsg) throw new Error(guardMsg);
    // (2) Content check (audit R1 HIGH) — files can RESOLVE yet assemble to EMPTY
    // context (all unreadable / sensitive-filtered / oversized), which the count
    // check can't see. Probe the actual assembled code block (cheap head-only read);
    // an empty block = the same hollow-verdict hazard, so refuse it too.
    if (scopeMode !== 'full' && subjectFiles.size > 0) {
      const probe = readFilesAsContext([...subjectFiles], { maxPerFile: 200, maxTotal: 4000 });
      if (!probe || !probe.trim()) {
        throw new Error(`audit aborted — ${subjectFiles.size} file(s) resolved but assembled to EMPTY implementation context (unreadable / sensitive-filtered / oversized); refusing to emit a verdict over an empty prompt.`);
      }
    }
  }

  if (shouldRunPass('backend')) {
    if (splitBackend) {
      if (effectiveRoutes.length > 0) {
        backendPassNames.push('be-routes');
        if (shouldMapReduceHighReasoning(effectiveRoutes)) {
          mapReducePasses.push('be-routes');
          process.stderr.write(`  [be-routes] ${effectiveRoutes.length} files — using map-reduce\n`);
          wave2Promises.push(
            runMapReducePass(openai, effectiveRoutes, 'be-routes', (unit, i, total, unitLabel) => passPrompt({
              rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
              focusBlock,
              passName: 'be-routes',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: '## Code',
              code: unit._context,
              unitLabel,
            }), openaiConfig.backendMaxFilesPerUnit)
          );
        } else {
          const limits = computePassLimits(baseContextChars + measureContextChars(effectiveRoutes, 8000) + sharedContext.length, 'high');
          process.stderr.write(`  be-routes: ${effectiveRoutes.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
          const beRoutesCode = `${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveRoutes, diffMap, { maxPerFile: 8000, maxTotal: 60000 }) : readFilesAsContext(effectiveRoutes, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`;
          wave2Promises.push(
            safeCallGPT(openai, {
              ...passPrompt({
                rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
                focusBlock,
                passName: 'be-routes',
                planContent,
                ledgerFile: isR2Plus ? ledgerFile : null,
                impactSet,
                isR2Plus,
                historyBlock,
                codeHeader: '## Backend ROUTES',
                code: beRoutesCode,
              }),
              schema: PassFindingsSchema,
              schemaName: 'backend_routes_pass',
              reasoning: 'high',
              ...limits,
              passName: 'be-routes'
            }, EMPTY_FINDINGS)
          );
        }
      }
      if (effectiveServices.length > 0) {
        backendPassNames.push('be-services');
        if (shouldMapReduceHighReasoning(effectiveServices)) {
          mapReducePasses.push('be-services');
          process.stderr.write(`  [be-services] ${effectiveServices.length} files — using map-reduce\n`);
          wave2Promises.push(
            runMapReducePass(openai, effectiveServices, 'be-services', (unit, i, total, unitLabel) => passPrompt({
              rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
              focusBlock,
              passName: 'be-services',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: '## Code',
              code: unit._context,
              unitLabel,
            }), openaiConfig.backendMaxFilesPerUnit)
          );
        } else {
          const limits = computePassLimits(baseContextChars + measureContextChars(effectiveServices, 8000), 'high');
          process.stderr.write(`  be-services: ${effectiveServices.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
          const beServicesCode = isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveServices, diffMap, { maxPerFile: 8000, maxTotal: 80000 }) : readFilesAsContext(effectiveServices, { maxPerFile: 8000, maxTotal: 80000 });
          wave2Promises.push(
            safeCallGPT(openai, {
              ...passPrompt({
                rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
                focusBlock,
                passName: 'be-services',
                planContent,
                ledgerFile: isR2Plus ? ledgerFile : null,
                impactSet,
                isR2Plus,
                historyBlock,
                codeHeader: '## Backend SERVICES',
                code: beServicesCode,
              }),
              schema: PassFindingsSchema,
              schemaName: 'backend_services_pass',
              reasoning: 'high',
              ...limits,
              passName: 'be-services'
            }, EMPTY_FINDINGS)
          );
        }
      }
    } else if (effectiveBackend.length > 0) {
      backendPassNames.push('backend');
      if (shouldMapReduceHighReasoning(effectiveBackend)) {
        mapReducePasses.push('backend');
        process.stderr.write(`  [backend] ${effectiveBackend.length} files — using map-reduce\n`);
        wave2Promises.push(
          runMapReducePass(openai, effectiveBackend, 'backend', (unit, i, total, unitLabel) => passPrompt({
            rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
            focusBlock,
            passName: 'backend',
            planContent,
            ledgerFile: isR2Plus ? ledgerFile : null,
            impactSet,
            isR2Plus,
            historyBlock,
            codeHeader: '## Code',
            code: unit._context,
            unitLabel,
          }), openaiConfig.backendMaxFilesPerUnit)
        );
      } else {
        const limits = computePassLimits(baseContextChars + measureContextChars(effectiveBackend, 8000) + sharedContext.length, 'high');
        process.stderr.write(`  backend: ${effectiveBackend.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
        const backendCode = `${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveBackend, diffMap, { maxPerFile: 8000, maxTotal: 80000 }) : readFilesAsContext(effectiveBackend, { maxPerFile: 8000, maxTotal: 80000 })}\n\n## Shared Files\n${sharedContext}`;
        wave2Promises.push(
          safeCallGPT(openai, {
            ...passPrompt({
              rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
              focusBlock,
              passName: 'backend',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: '## Backend Implementation Files',
              code: backendCode,
            }),
            schema: PassFindingsSchema,
            schemaName: 'backend_pass',
            reasoning: 'high',
            ...limits,
            passName: 'backend'
          }, EMPTY_FINDINGS)
        );
      }
    }
  } else {
    process.stderr.write(`  backend SKIPPED (--passes)\n`);
  }

  const runFrontend = shouldRunPass('frontend');
  // M6 (code-audit r1): dispatch and passRegistry used to check different
  // predicates (this flag vs bare runFrontend) — a pass can be "on" via
  // --passes but have zero frontend files, in which case no model call
  // happens and the registry must not report it as having ran.
  const frontendWillRun = runFrontend && effectiveFrontend.length > 0;
  if (frontendWillRun) {
    if (shouldMapReduceHighReasoning(effectiveFrontend)) {
      mapReducePasses.push('frontend');
      process.stderr.write(`  [frontend] ${effectiveFrontend.length} files — using map-reduce\n`);
      wave2Promises.push(
        runMapReducePass(openai, effectiveFrontend, 'frontend', (unit, i, total, unitLabel) => passPrompt({
          rubric: isR2Plus ? PASS_FRONTEND_RUBRIC : PASS_FRONTEND_SYSTEM,
          focusBlock,
          passName: 'frontend',
          planContent,
          ledgerFile: isR2Plus ? ledgerFile : null,
          impactSet,
          isR2Plus,
          historyBlock,
          codeHeader: '## Code',
          code: unit._context,
          unitLabel,
        }), openaiConfig.frontendMaxFilesPerUnit)
      );
    } else {
      const limits = computePassLimits(baseContextChars + measureContextChars(effectiveFrontend, 10000) + sharedContext.length, 'high');
      process.stderr.write(`  frontend: ${effectiveFrontend.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
      const frontendCode = `${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveFrontend, diffMap, { maxPerFile: 10000, maxTotal: 80000 }) : readFilesAsContext(effectiveFrontend, { maxPerFile: 10000, maxTotal: 80000 })}\n\n## Shared Files\n${sharedContext}`;
      wave2Promises.push(
        safeCallGPT(openai, {
          ...passPrompt({
            rubric: isR2Plus ? PASS_FRONTEND_RUBRIC : PASS_FRONTEND_SYSTEM,
            focusBlock,
            passName: 'frontend',
            planContent,
            ledgerFile: isR2Plus ? ledgerFile : null,
            impactSet,
            isR2Plus,
            historyBlock,
            codeHeader: '## Frontend Implementation Files',
            code: frontendCode,
          }),
          schema: PassFindingsSchema,
          schemaName: 'frontend_pass',
          reasoning: 'high',
          ...limits,
          passName: 'frontend'
        }, EMPTY_FINDINGS)
      );
    }
  } else if (!runFrontend) {
    process.stderr.write(`  frontend SKIPPED (--passes)\n`);
  }

  if (wave2Promises.length === 0) {
    wave2Promises.push(Promise.resolve({ result: EMPTY_FINDINGS, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  const wave2Results = await Promise.all(wave2Promises);
  const backendResults = wave2Results.slice(0, backendPassNames.length);
  const frontendResult = wave2Results[backendPassNames.length] ?? { result: EMPTY_FINDINGS, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  cacheWaveResults([...backendPassNames, 'frontend'], wave2Results);

  // 4. Wave 3: Sustainability (reasoning: medium)
  let sustainResult;
  const runSustainability = shouldRunPass('sustainability');
  if (runSustainability) {
    const sustainFiles = inScope(found);

    process.stderr.write(`\n── Wave 3: Sustainability (reasoning: medium) ──\n`);

    if (shouldMapReduce(sustainFiles)) {
      mapReducePasses.push('sustainability');
      process.stderr.write(`  [sustainability] ${sustainFiles.length} files — using map-reduce\n`);
      // Fix #3: Pass changedFileSet so unchanged map units skip retries
      const changedFileSet = changedFiles.length > 0 ? new Set(changedFiles.map(normalizePath)) : null;
      sustainResult = await runMapReducePass(openai, sustainFiles, 'sustainability', (unit, i, total, unitLabel) => passPrompt({
        rubric: isR2Plus ? PASS_SUSTAINABILITY_RUBRIC : PASS_SUSTAINABILITY_SYSTEM,
        focusBlock,
        passName: 'sustainability',
        planContent,
        ledgerFile: isR2Plus ? ledgerFile : null,
        impactSet,
        isR2Plus,
        historyBlock,
        codeHeader: '## Code',
        code: unit._context,
        unitLabel,
      }), Infinity, { changedFileSet });
    } else {
      const sustainContextChars = baseContextChars + measureContextChars(sustainFiles, 4000);
      const sustainLimits = computePassLimits(sustainContextChars, 'medium');
      process.stderr.write(`  ${sustainFiles.length} files → ${sustainLimits.maxTokens} tok / ${(sustainLimits.timeoutMs/1000).toFixed(0)}s\n`);

      const sustainCode = isR2Plus && diffMap ? readFilesAsAnnotatedContext(sustainFiles, diffMap, { maxPerFile: 4000, maxTotal: 60000 }) : readFilesAsContext(sustainFiles, { maxPerFile: 4000, maxTotal: 60000 });
      sustainResult = await safeCallGPT(openai, {
        ...passPrompt({
          rubric: isR2Plus ? PASS_SUSTAINABILITY_RUBRIC : PASS_SUSTAINABILITY_SYSTEM,
          focusBlock,
          passName: 'sustainability',
          planContent,
          ledgerFile: isR2Plus ? ledgerFile : null,
          impactSet,
          isR2Plus,
          historyBlock,
          codeHeader: '## All Implementation Files',
          code: sustainCode,
        }),
        schema: SustainabilityPassSchema,
        schemaName: 'sustainability_pass',
        reasoning: 'medium',
        ...sustainLimits,
        passName: 'sustainability'
      }, EMPTY_SUSTAIN);
    }
  } else {
    process.stderr.write(`\n── Sustainability SKIPPED (--passes) ──\n`);
    sustainResult = { result: EMPTY_SUSTAIN, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }

  cachePassResult('sustainability', sustainResult);

  // 4.5 Wave 4: Quickfix design-shortcut detector (reasoning: low — pattern match, not deep semantic)
  // Plan: docs/plans/brainstorm-quickfix-v1.md §B2.
  let quickfixResult;
  const EMPTY_QUICKFIX = { pass_name: 'quickfix', findings: [], summary: 'Pass skipped.' };
  const runQuickfix = shouldRunPass('quickfix');
  if (runQuickfix) {
    const qfFiles = inScope(found);
    process.stderr.write(`\n── Wave 4: Quickfix design-shortcuts (reasoning: low) ──\n`);
    const PASS_QUICKFIX_SYSTEM_LOCAL = getPassPrompt('quickfix');
    const qfRubric = PASS_QUICKFIX_SYSTEM_LOCAL;  // pass full prompt for low-reasoning consistency
    const qfContextChars = baseContextChars + measureContextChars(qfFiles, 4000);
    const qfLimits = computePassLimits(qfContextChars, 'low');
    process.stderr.write(`  ${qfFiles.length} files → ${qfLimits.maxTokens} tok / ${(qfLimits.timeoutMs/1000).toFixed(0)}s\n`);
    const qfCode = isR2Plus && diffMap ? readFilesAsAnnotatedContext(qfFiles, diffMap, { maxPerFile: 4000, maxTotal: 60000 }) : readFilesAsContext(qfFiles, { maxPerFile: 4000, maxTotal: 60000 });
    quickfixResult = await safeCallGPT(openai, {
      ...passPrompt({
        rubric: qfRubric,
        focusBlock,
        passName: 'quickfix',
        planContent,
        ledgerFile: isR2Plus ? ledgerFile : null,
        impactSet,
        isR2Plus,
        historyBlock,
        codeHeader: '## All Implementation Files',
        code: qfCode,
      }),
      schema: QuickfixPassSchema,
      schemaName: 'quickfix_pass',
      reasoning: 'low',
      ...qfLimits,
      passName: 'quickfix'
    }, EMPTY_QUICKFIX);
    // Force is_quick_fix:true on every finding from this pass (defence — prompt asks but model may forget)
    if (quickfixResult?.result?.findings) {
      quickfixResult.result.findings = quickfixResult.result.findings.map(f => ({ ...f, is_quick_fix: true }));
    }
  } else {
    process.stderr.write(`\n── Quickfix SKIPPED (--passes) ──\n`);
    quickfixResult = { result: EMPTY_QUICKFIX, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }
  cachePassResult('quickfix', quickfixResult);

  // 4.6 Wave 5: Duplication detector (mechanical detection + low-reasoning LLM bouncer)
  // Plan: docs/plans/audit-code-duplication-wave.md. Extracted to runDuplicationPass
  // (2026-08-13) so the pass carries the {result, usage, latencyMs} contract its
  // bouncer call was silently dropping — see that function's docblock.
  const EMPTY_DUPLICATION = { pass_name: 'duplication', findings: [], summary: 'Pass skipped.' };
  let duplicationResult;
  // Bound once, not re-derived at the registry below: `ran` there reads this
  // exact decision, and a second `shouldRunPass` call is a second source of
  // truth for it.
  const runDuplication = shouldRunPass('duplication');
  if (runDuplication) {
    process.stderr.write(`\n── Wave 5: Duplication detector ──\n`);
    duplicationResult = await runDuplicationPass({
      openai, ctx, passPrompt, changedFiles, auditBaseCommit,
      focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus,
    });
  } else {
    process.stderr.write(`\n── Duplication SKIPPED (--passes) ──\n`);
    duplicationResult = { result: EMPTY_DUPLICATION, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }
  cachePassResult('duplication', duplicationResult);

  // ── Wave 6: Containment adjacency ──────────────────────────────────────
  // Plan: docs/plans/adjacency-check-containment.md. Mechanical (no LLM in the
  // enumeration), mirroring Wave 5's two-stage shape: a deterministic detector
  // finds what exists, an LLM bouncer only judges what it is handed.
  //
  // Trigger is the FIX DIFF, not a finding — `section` is free prose (measured:
  // a line number in 6 of 1764 stored findings) and the enrichment regex
  // discards line numbers even when present, so a finding cannot carry an
  // anchor. A diff hunk always can, and a diff-driven trigger additionally
  // cannot self-trigger, so this wave can never churn on its own output.
  //
  // Extracted to runAdjacencyPass (2026-08-13) for the usage-contract reason
  // recorded on runDuplicationPass.
  const EMPTY_ADJACENCY = { pass_name: 'adjacency', findings: [], summary: 'Pass skipped.' };
  let adjacencyResult;
  const runAdjacency = shouldRunPass('adjacency');
  if (runAdjacency) {
    adjacencyResult = await runAdjacencyPass({
      openai, ctx, passPrompt, auditBaseCommit,
      focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus,
    });
  } else {
    process.stderr.write(`\n── Adjacency SKIPPED (--passes) ──\n`);
    adjacencyResult = { result: EMPTY_ADJACENCY, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }
  cachePassResult('adjacency', adjacencyResult);

  // 5. Merge all pass results with semantic dedup
  const totalLatency = Date.now() - totalStart;

  // ── Phase 3 (audit-orchestrator-hardening) — pass-result registry ───────
  // One entry per pass, replacing what were previously 5+ independently
  // hand-maintained lists below (allResults / the addFindings call
  // sequence / cacheMetrics.perPass+passNameOrder / passTimings /
  // summaryLines / the cloud recordPassStats loop) — they had already
  // drifted: archResult and quickfixResult's findings never reached
  // mergedResult.findings because TWO of those lists silently omitted
  // them. `contributesTo` is a single-valued enum ('findings') — every
  // registered pass contributes ordinary findings; there is no separate
  // "summary-only" pass class today, so this isn't a placeholder for a
  // variant this orchestrator doesn't have.
  //
  // Phase 4 fold-in: a map-reduce pass's `mapUnitStatus` (set on `result`
  // by runMapReducePass) folds into a 'failed' registry status here —
  // 'total_failure' unconditionally, 'partial' only when the pass's own
  // surviving findings are empty. `result.result.findings.length` is a
  // safe proxy for runMapReducePass's LOCAL `allFindings.length` here: the
  // ONLY branch where that local variable can be 0 is runMapReducePass's
  // own early-return (`allFindings.length === 0`), which sets
  // `result.result.findings = []` identically — every OTHER return path is
  // only reachable once that local variable is already known to be > 0, so
  // the two can never disagree at the point this check fires.
  function mapReduceFailureReason(result) {
    if (!result || result.mapUnitStatus === undefined) return null; // not a map-reduce pass
    if (result.mapUnitStatus === 'total_failure') {
      return `map-reduce total_failure (${result.unitsFailed}/${result.unitsAttempted} units failed)`;
    }
    if (result.mapUnitStatus === 'partial' && (result.result?.findings?.length ?? 0) === 0) {
      return `map-reduce partial with zero surviving findings (${result.unitsFailed}/${result.unitsAttempted} units failed)`;
    }
    return null;
  }

  // 6ae952bf: the reasoning level actually used per pass is set at each
  // pass's own safeCallGPT invocation (scattered across this function, since
  // several backend sub-passes branch on shouldMapReduceHighReasoning) — not
  // threaded back onto that pass's result object. Reproducing that here
  // exactly would mean touching ~10 call sites in this already-oversized
  // function, out of proportion for a MEDIUM debt item (see Theme 2's
  // interim-containment note: no new orchestration complexity added here).
  // This resolves the narrower, real complaint instead: recordPassStats used
  // to keep its OWN independent copy of this name->reasoning guess, so the
  // two could silently drift apart. There is now exactly one definition.
  // `reasoningLevelForPass` is GONE (2026-08-12). It mapped a pass NAME to a
  // level and returned 'high' for everything it did not special-case — while
  // the structure and wiring passes both dispatch `reasoning: 'low'`, and the
  // mechanical passes (duplication, adjacency, orphan-introduced) dispatch no
  // LLM call at all. So `audit_pass_stats.reasoning_effort` recorded a guess,
  // and the durability work then made that guess durable, which is what forced
  // the issue: a fabricated value that survives is worse than one that scrolls
  // away. Substituting a *better* guess would have repeated the defect one
  // table row over.
  //
  // The effort now comes back from the call that sent it (`reasoningEffort` on
  // the callGPT result), so there is exactly one source and it cannot drift
  // from the request. A pass with no LLM call, or one whose result never
  // arrived, reports `null` — an honest absence, and distinguishable from a
  // measured level, which 'high' never was.

  const passRegistry = [
    { name: 'structure', ran: runStructure, result: structureResult, displayPrefix: 'Structure' },
    { name: 'wiring', ran: runWiring, result: wiringResult, displayPrefix: 'Wiring' },
    ...backendPassNames.map((name, i) => ({ name, ran: true, result: backendResults[i], displayPrefix: name })),
    { name: 'frontend', ran: frontendWillRun, result: frontendResult, displayPrefix: 'Frontend' },
    { name: 'sustainability', ran: runSustainability, result: sustainResult, displayPrefix: 'Sustainability' },
    { name: 'quickfix', ran: runQuickfix, result: quickfixResult, displayPrefix: 'Quickfix' },
    { name: 'duplication', ran: runDuplication, result: duplicationResult, displayPrefix: 'Duplication' },
    { name: 'adjacency', ran: runAdjacency, result: adjacencyResult, displayPrefix: 'Adjacency' },
    // M1 (code-audit r2): archState/orphanState have MULTIPLE skip reasons
    // (SKIPPED_PASS_FILTER, SKIPPED_NO_INTENT, SKIPPED_NO_GRAPH, ...) — a
    // `!== 'SKIPPED_PASS_FILTER'` check reported `ran: true` for every OTHER
    // skip reason too, the exact frontendWillRun-vs-runFrontend mismatch
    // (M6, round 1) recurring for the pass immediately below it.
    { name: 'architecture', ran: !archState.startsWith('SKIPPED_'), result: archResult, displayPrefix: 'Architecture' },
    { name: 'orphan-introduced', ran: !orphanState.startsWith('SKIPPED_'), result: orphanResult, displayPrefix: 'Orphan' },
    { name: 'event-wiring-symmetry', ran: !eventWiringState.startsWith('SKIPPED_'), result: eventWiringResult, displayPrefix: 'EventWiring' },
  ].map(({ name, ran, result, displayPrefix }) => {
    const mrReason = mapReduceFailureReason(result);
    const status = !ran ? 'skipped' : (result?.failed || mrReason) ? 'failed' : 'succeeded';
    return {
      name,
      status,
      findings: result?.result?.findings ?? [],
      contributesTo: 'findings',
      usage: result?.usage ?? { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
      latencyMs: result?.latencyMs ?? 0,
      summary: result?.result?.summary ?? '',
      failureReason: status === 'failed' ? (result?.error ?? mrReason ?? null) : null,
      // Internal bookkeeping fields (not part of the plan's documented
      // registry-entry shape) — kept underscore-prefixed, matching this
      // file's `_hash`/`_pass`/`_mapUnit` convention for internal-only data.
      _displayPrefix: displayPrefix,
      _result: result,
      // Measured, not guessed — `null` when this pass made no LLM call (the
      // mechanical detectors) or produced no result. `?? null` rather than a
      // default, because a default here is exactly the fabrication removed.
      _reasoning: result?.reasoningEffort ?? null,
      // The model that served this pass, for `audit_pass_stats.source_model`.
      // Same measured-not-guessed contract as `_reasoning`: `null` means no LLM
      // call was dispatched (the mechanical detectors — duplication, adjacency,
      // orphan-introduced, event-wiring-symmetry — and any pass that never ran),
      // which is an honest absence rather than an attribution to a model that
      // did no work.
      //
      // `result.model` covers every shape, map-reduce included: that path now
      // carries the id its own units reported (`dispatchedModel`), so this is a
      // measurement in all cases rather than config re-read after the fact.
      //
      // The remaining fallback is narrow and named: a map-reduce pass whose
      // units ALL rejected has no unit result to read, yet the calls were still
      // dispatched and still billed. `mapUnitStatus` is the SAME discriminator
      // `mapReduceFailureReason` above uses to recognise that shape, and
      // `wireModel()` is what those calls were sent to. Attributing a total
      // failure's spend to the model that failed beats attributing it to none.
      _model: result?.model
        ?? (result?.mapUnitStatus !== undefined ? wireModel() : null),
    };
  });

  const allResults = passRegistry.map(p => p._result).filter(Boolean);
  const failedPasses = passRegistry.filter(p => p.status === 'failed').map(p => p.failureReason);

  process.stderr.write(`\n── Merge (${allResults.length} passes, ${failedPasses.length} failed) ──\n`);
  if (failedPasses.length > 0) {
    process.stderr.write(`  Failed passes: ${failedPasses.join('; ')}\n`);
  }

  // Cross-pass dedup: if two passes flag the same issue (>80% word overlap on
  // section+detail), keep the higher-severity one
  function tokenize(s) {
    return (s ?? '').toLowerCase().replaceAll(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  }
  function wordOverlap(a, b) {
    const ta = new Set(tokenize(a));
    const tb = new Set(tokenize(b));
    const intersection = [...ta].filter(t => tb.has(t)).length;
    const union = new Set([...ta, ...tb]).size;
    return union === 0 ? 0 : intersection / union;
  }

  const allFindings = [];
  const seenHashes = new Set();
  const findingCounter = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  let dedupCount = 0;
  const sevOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  function addFindings(findings, prefix) {
    // Sort by severity (HIGH first) before adding
    const sorted = [...(findings ?? [])].sort((a, b) => (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2));
    for (const rawF of sorted) {
      // Reserve the `[Architecture]` namespace for the mechanical arch pass:
      // a general LLM pass cannot see `allowedDeps`, so any arch-boundary
      // category it invents is demoted to `Coupling concern` BEFORE the
      // identity hash is computed — otherwise 15 invented labels for one
      // concept each fingerprint differently and never dedup (2026-07-20).
      const f = normalizeArchCategory(rawF);
      const hash = semanticId(f);

      // Exact dedup by content hash
      // audit-orchestrator-hardening H5 (Cluster: hardening-implementation
      // audit round 1): the comment above has always said "keep the
      // higher-severity version," but the code only ever SKIPPED a later
      // duplicate — it never compared severity or replaced an
      // already-inserted lower-severity duplicate. Since `addFindings` is
      // called once per pass in registry order (not globally sorted by
      // severity across passes), an earlier pass's LOW-severity finding
      // would permanently block a later pass's HIGH-severity duplicate of
      // the same issue. Fixed: on a duplicate match (exact hash OR fuzzy),
      // if the NEW finding outranks the EXISTING one, replace it in place
      // instead of skipping.
      const existingExactIdx = seenHashes.has(hash)
        ? allFindings.findIndex(e => e._hash === hash) : -1;
      if (existingExactIdx !== -1) {
        dedupCount++;
        if ((sevOrder[f.severity] ?? 2) < (sevOrder[allFindings[existingExactIdx].severity] ?? 2)) {
          allFindings[existingExactIdx] = {
            ...f,
            id: dedupReplacementId(allFindings[existingExactIdx].id, allFindings[existingExactIdx].severity, f.severity, findingCounter),
            _hash: hash, _pass: prefix,
            category: `[${prefix}] ${f.category}`,
          };
        }
        continue;
      }

      // Fuzzy dedup: check if a substantially similar finding already exists
      const sig = `${f.section} ${f.detail}`;
      const dupeIdx = allFindings.findIndex(existing => {
        const existSig = `${existing.section} ${existing.detail}`;
        return wordOverlap(sig, existSig) > 0.8;
      });
      if (dupeIdx !== -1) {
        dedupCount++;
        if ((sevOrder[f.severity] ?? 2) < (sevOrder[allFindings[dupeIdx].severity] ?? 2)) {
          // `id` is preserved when severity is unchanged (stable within-run
          // label); it's regenerated via dedupReplacementId when severity
          // changes, since the letter prefix is severity-derived (audit
          // M10, 2026-07-24 — a kept-stale id could label a HIGH finding
          // "L5"). `_hash` must come from the NEW finding (matching the
          // exact-dedup branch above, audit bc31c61a/880195e4, 2026-07-17)
          // — the old line kept the REPLACED finding's _hash even though
          // content/severity came from the new one, corrupting downstream
          // dedup identity.
          allFindings[dupeIdx] = {
            ...f,
            id: dedupReplacementId(allFindings[dupeIdx].id, allFindings[dupeIdx].severity, f.severity, findingCounter),
            _hash: hash, _pass: prefix,
            category: `[${prefix}] ${f.category}`,
          };
        }
        continue;
      }

      seenHashes.add(hash);
      findingCounter[f.severity]++;
      const num = findingCounter[f.severity];
      const letter = f.severity === 'HIGH' ? 'H' : f.severity === 'MEDIUM' ? 'M' : 'L';
      allFindings.push({
        ...f,
        id: `${letter}${num}`,
        _hash: hash,
        _pass: prefix,
        category: `[${prefix}] ${f.category}`
      });
    }
  }

  // Phase 3 (audit-orchestrator-hardening): iterate the pass registry
  // instead of a hand-listed call sequence — this is the fix that makes
  // quickfix and architecture findings (previously silently omitted here)
  // actually reach mergedResult.findings. Every registered pass's findings
  // flow through the SAME dedup + suppression path (orphan-introduced,
  // architecture, and quickfix are mechanical/low-cost passes, no
  // different in kind from the LLM quality passes here).
  for (const entry of passRegistry) {
    addFindings(entry.findings, entry._displayPrefix);
  }

  if (dedupCount > 0) {
    process.stderr.write(`  Deduped ${dedupCount} cross-pass duplicate(s)\n`);
  }

  // Phase C: append tool findings (already carry classification from linter.mjs).
  // Tool findings use file:rule:message identity via semanticId() dispatch, so they
  // coexist with model findings without content-hash collisions.
  // Phase 6 (audit-orchestrator-hardening): ONE run-wide monotonic counter
  // for T-prefixed tool-finding IDs — previously severity-scoped
  // (`findingCounter[tf.severity]`, the SAME counter H/M/L findings use),
  // so a HIGH and a MEDIUM tool finding in the same run could both be `T1`.
  let toolIdCounter = 0;
  if (toolFindings.length > 0) {
    let toolHigh = 0, toolMed = 0, toolLow = 0;
    for (const tf of toolFindings) {
      const hash = semanticId(tf);
      if (seenHashes.has(hash)) { dedupCount++; continue; }
      seenHashes.add(hash);
      toolIdCounter++;
      if (tf.severity === 'HIGH') toolHigh++;
      else if (tf.severity === 'MEDIUM') toolMed++;
      else toolLow++;
      allFindings.push({
        ...tf,
        id: `T${toolIdCounter}`, // T prefix = tool
        _hash: hash,
        _pass: 'tool',
      });
    }
    process.stderr.write(`  Added ${toolFindings.length} tool findings (H:${toolHigh} M:${toolMed} L:${toolLow})\n`);
  }

  // 5.4b Linter overlap tracking (Phase 0G) — compares tool vs GPT findings
  // Match by file + line proximity (G3 fix: both must have line numbers).
  const toolFindingsInResult = allFindings.filter(f => f._pass === 'tool');
  const gptFindingsInResult = allFindings.filter(f => f._pass !== 'tool');
  let linterOverlapCount = 0, linterOnlyCount = 0, gptOnlyCount = 0;

  if (toolFindingsInResult.length > 0) {
    const matchedGpt = new Set();
    for (const tf of toolFindingsInResult) {
      const [tFile, tLineStr] = (tf.section || '').split(':');
      const tLine = Number.parseInt(tLineStr, 10);
      let matched = false;
      for (const gf of gptFindingsInResult) {
        const gFile = gf._primaryFile || (gf.section || '').split(':')[0];
        if (normalizePath(tFile || '') !== normalizePath(gFile || '')) continue;
        const gLine = Number.parseInt((gf.section || '').split(':')[1], 10);
        if (isNaN(gLine) || isNaN(tLine)) continue; // G3 fix: both need line numbers
        if (Math.abs(gLine - tLine) <= 5) {
          matched = true;
          matchedGpt.add(gf._hash);
          break;
        }
      }
      if (matched) linterOverlapCount++;
      else linterOnlyCount++;
    }
    gptOnlyCount = gptFindingsInResult.filter(f => !matchedGpt.has(f._hash)).length;
    process.stderr.write(`  [linter-overlap] Tool: ${toolFindingsInResult.length} | GPT: ${gptFindingsInResult.length} | Overlap: ${linterOverlapCount} | Linter-only: ${linterOnlyCount} | GPT-only: ${gptOnlyCount}\n`);
  }

  // Stored in temp var because mergedResult is defined later (TDZ).
  var _linterOverlapData = { linterOverlapCount, linterOnlyCount, gptOnlyCount };

  // 5.5 Post-output suppression
  // Phase D: merge session ledger (R2+) with persistent debt ledger so debt
  // gets suppressed in every round, not just R2+. Suppression runs when
  // either ledger has entries.
  const sessionLedgerForSuppression = ledger || { version: 1, entries: [] };
  const debtLedgerForSuppression = debtLedger && debtLedger.entries.length > 0
    ? { version: 1, entries: debtLedger.entries }
    : { version: 1, entries: [] };
  const mergedLedger = mergeLedgersForSuppression(sessionLedgerForSuppression, debtLedgerForSuppression);

  // Findings the ledger reopened this round. Declared OUTSIDE the branch so the
  // cloud-FP pass below can exempt them whether or not the branch ran; empty
  // when it didn't, which is correct (nothing was reopened).
  let reopenedSet = new Set();

  // Enrich findings with structured metadata — HOISTED out of the ledger branch.
  // This is pure enrichment derived from `section` with ZERO ledger dependency,
  // and it is the ONLY producer of `_primaryFile`/`affectedFiles` (the LLM
  // contract, FindingBase, carries neither; addFindings sets `_hash` but not
  // these). Nested in the branch it was skipped whenever the merged ledger was
  // empty, and two consumers OUTSIDE the branch read the gap: `.audit/outcomes.jsonl`
  // (the local bandit reward signal) and cloud `audit_findings.primary_file`.
  // Both do `f._primaryFile || f.section`, so they silently recorded the RAW
  // SECTION STRING where a normalized path belongs, and `affectedFiles: []` —
  // no error, no crash, just wrong-shaped data that looks fine.
  //
  // Slot is constrained on both sides: AFTER addFindings (which builds
  // allFindings and sets `_hash`) and BEFORE suppressReRaises (which reads
  // `_primaryFile`/`affectedFiles` for its impact-set narrowing).
  for (const f of allFindings) {
    populateFindingMetadata(f, f._pass);
  }

  if (mergedLedger.entries.length > 0) {
    let { kept, suppressed, reopened, reopenTelemetry } = suppressReRaises(allFindings, mergedLedger, { changedFiles, impactSet });

    process.stderr.write(`\n═══════════════════════════════════════\n`);
    process.stderr.write(`  R${round} POST-PROCESSING\n`);
    process.stderr.write(`  Kept: ${kept.length} | Suppressed: ${suppressed.length} | Reopened: ${reopened.length}\n`);
    // Observation-only (2026-08-14). `undeclaredOnDismissal` is the shape the
    // cluster-A field case had: a dismissal mechanically reopened by a
    // file-touch that the model itself never claimed invalidated the ruling.
    // Printed so the signal accumulates in ordinary round logs rather than
    // needing a bespoke experiment — it is the input to the deferred
    // reopen-policy decision, and it is NOT a gate.
    if (reopenTelemetry && (reopenTelemetry.total > 0 || reopenTelemetry.relitigationSuppressed > 0)) {
      process.stderr.write(
        `  Reopens: ${reopenTelemetry.declared}/${reopenTelemetry.total} model-declared`
        + ` | ${reopenTelemetry.undeclaredOnDismissal} undeclared on a dismissal\n`,
      );
      // Layer 3's own false-negative exposure. Printed separately because it is
      // the number that would show the policy over-suppressing: each one is a
      // dismissal whose file changed and which we declined to re-litigate.
      if (reopenTelemetry.relitigationSuppressed > 0) {
        process.stderr.write(
          `  Re-litigation declined: ${reopenTelemetry.relitigationSuppressed}`
          + ` (dismissed + scope changed + no declared reopen)\n`,
        );
        // NAME them, don't just count them. A count tells the operator the
        // policy fired; only the identity tells them whether it fired on the
        // WRONG finding — and this is the one branch where a real staleness the
        // model failed to declare disappears from the round's report. Bounded
        // like the suppressed sample above; the full set is in `_suppression`
        // and in suppression_events.
        for (const s of suppressed.filter(x => x.relitigationDeclined).slice(0, 5)) {
          process.stderr.write(
            `    [declined] ${String(s.matchedTopic).slice(0, 8)} `
            + `${s.finding?._primaryFile ?? s.finding?.section ?? '(unknown file)'} `
            + `score=${Number(s.matchScore).toFixed(2)}\n`,
          );
        }
      }
    }
    if (suppressed.length > 0) {
      for (const s of suppressed.slice(0, 5)) {
        process.stderr.write(`    [suppressed] ${s.matchedTopic.slice(0,8)} score=${s.matchScore.toFixed(2)}\n`);
      }
    }
    process.stderr.write(`═══════════════════════════════════════\n\n`);

    // The local FP-tracker loop LIVED HERE and has moved out — it is now
    // `runLocalFpPass`, called unconditionally below alongside the cloud pass.
    // Nested here it was skipped entirely whenever the merged ledger was empty
    // (no session ledger AND no debt entries), so the historically-noisy
    // patterns the tracker had learned were simply not applied — the identical
    // defect the cloud pass was lifted out to avoid.

    // Replace findings with kept + reopened only
    reopenedSet = new Set(reopened);
    allFindings.length = 0;
    allFindings.push(...kept, ...reopened);

    // Fix-lifecycle transitions (docs/plans/remediation-state-fix-lifecycle.md).
    // A prior accepted entry whose scope changed and is no longer raised → fixed;
    // a fixed entry re-raised on a changed scope → regressed. This is what finally
    // populates `audit_findings.remediation_state` so the `unlocked_fixes` view /
    // /ship missing-spec gate stop reading vacuously empty. Fail-open — a failure
    // here never blocks the round.
    try {
      // ORDER IS LOAD-BEARING (Gemini final-gate H). Self-heal FIRST, using the
      // round-start `mergedLedger` (which reflects PRIOR rounds' committed
      // terminal states, before this round's transitions). Running it AFTER the
      // transitions would re-project from this same pre-transition snapshot and
      // REVERT a just-applied regression/fix in the DB. This matches the plan's
      // B2: "before computing new transitions, reconcile."
      // READ the sweep's result (audit 2026-08-13). This was `await …` with the
      // return value discarded, and the function used to answer `{reconciled:0}`
      // for BOTH "already consistent" and "the sweep threw" — so a self-heal
      // that never ran was indistinguishable from one with nothing to heal.
      // It now reports `ok`, and a failure is said out loud: the ledger on disk
      // stays the durable copy, so this is recoverable on the next round, but
      // "recoverable" is only true if somebody knows it happened.
      if (cloudRepoId) {
        const sweep = await reconcileRemediationProjection(cloudRepoId, mergedLedger);
        if (!sweep.ok) {
          process.stderr.write(`  [lifecycle] self-heal sweep FAILED (${sweep.reason}) — store may still diverge from the ledger; next round retries\n`);
        } else if (sweep.reconciled > 0) {
          process.stderr.write(`  [lifecycle] self-heal reconciled ${sweep.reconciled}/${sweep.attempted} divergent projection(s)\n`);
        }
      }
      // Then compute + apply + project THIS round's fresh transitions.
      const { updates } = computeFixLifecycleUpdates(mergedLedger, allFindings, changedFiles, round);
      if (updates.length > 0) {
        const { committed } = applyLifecycleUpdates(ledgerFile, updates);
        if (committed.length > 0) {
          const nFixed = committed.filter(u => u.action === 'mark-fixed').length;
          const nReg = committed.filter(u => u.action === 'mark-regressed').length;
          process.stderr.write(`  [lifecycle] ${committed.length} transition(s): ${nFixed} fixed, ${nReg} regressed\n`);
          // Compare INTENDED against PROJECTED (audit 2026-08-13). The return
          // value was discarded, and this writer is fail-open per row — it
          // catches, logs and continues — so committing 5 ledger transitions
          // while projecting only 2 left the on-disk ledger and the store
          // silently disagreeing. A shortfall is not fatal (the ledger is the
          // durable copy and the sweep above heals it next round), but it must
          // be COUNTED rather than inferred from stderr noise.
          if (cloudRepoId) {
            const proj = await markFindingsRemediation(cloudRepoId, committed);
            if (proj.updated < proj.attempted) {
              process.stderr.write(`  [lifecycle] projected ${proj.updated}/${proj.attempted} transition(s) — ${proj.attempted - proj.updated} did NOT reach the store; the ledger is ahead until the next self-heal\n`);
            }
          }
        }
      }
    } catch (err) {
      process.stderr.write(`  [lifecycle] skipped: ${err.message}\n`);
    }

    // Populate _suppression — full arrays for recordSuppressionEvents() + summary counts
    // Stored in temp var because mergedResult is defined later (TDZ)
    var _suppressionData = {
      suppressed,   // Array of { finding, matchedTopic, matchScore, reason } objects
      reopened,     // Array of finding objects with _matchedTopic, _matchScore
      keptCount: kept.length,
      suppressedCount: suppressed.length,
      reopenedCount: reopened.length,
      // Observation-only; lands in the result JSON's `_suppression` so the
      // declared-vs-mechanical reopen signal is retained per round rather than
      // only printed to stderr. Not read by any gate.
      reopenTelemetry,
      fpSuppressedCount: 0,   // set by runSuppressionPasses — the local pass moved out
    };

    // Phase D: emit debt events for matches against debt-ledger entries.
    // One 'surfaced' event per topicId per run (fix M1) — dedup via Set.
    const debtEvents = [];
    const surfacedTopics = new Map();  // topicId → matchCount
    for (const s of suppressed) {
      if (s.matchedSource !== 'debt') continue;
      surfacedTopics.set(s.matchedTopic, (surfacedTopics.get(s.matchedTopic) || 0) + 1);
    }
    const nowIso = new Date().toISOString();
    for (const [topicId, matchCount] of surfacedTopics) {
      debtEvents.push({ ts: nowIso, runId: debtRunId, topicId, event: 'surfaced', matchCount });
    }
    // Reopens: one 'reopened' event per topicId (not counted toward occurrences)
    const reopenedDebtTopics = new Set();
    for (const r of reopened) {
      const match = mergedLedger.entries.find(e => e.topicId === r._matchedTopic);
      if (match?.source === 'debt') reopenedDebtTopics.add(r._matchedTopic);
    }
    for (const topicId of reopenedDebtTopics) {
      debtEvents.push({ ts: nowIso, runId: debtRunId, topicId, event: 'reopened' });
    }
    if (debtEvents.length > 0 && debtContext.canWrite) {
      const r = await appendEvents(debtContext, debtEvents, { eventsPath: debtEventsPath });
      process.stderr.write(`  [debt] emitted ${r.written} event(s) to ${r.source} (${surfacedTopics.size} surfaced, ${reopenedDebtTopics.size} reopened)\n`);
    } else if (debtEvents.length > 0) {
      process.stderr.write(`  [debt] ${debtEvents.length} event(s) suppressed (read-only mode)\n`);
    }
    // Phase D.3 debt status card
    if (debtLedger.entries.length > 0) {
      const escalatedCount = debtLedger.entries.filter(e => e.escalated).length;
      const recurring3 = debtLedger.entries.filter(e => (e.distinctRunCount ?? 0) >= 3).length;
      // oldestEntryDays inline
      const now = Date.now();
      let oldestMs = now;
      for (const e of debtLedger.entries) {
        const t = Date.parse(e.deferredAt);
        if (Number.isFinite(t) && t < oldestMs) oldestMs = t;
      }
      const oldestDays = Math.floor(Math.max(0, now - oldestMs) / (24 * 60 * 60 * 1000));
      process.stderr.write(`\n═══════════════════════════════════════\n`);
      process.stderr.write(`  DEBT LEDGER: ${debtLedger.entries.length} entries | Suppressed this run: ${surfacedTopics.size}\n`);
      process.stderr.write(`  Recurring (≥3 runs): ${recurring3} | Escalated: ${escalatedCount}${newlyEscalated.length > 0 ? ` (+${newlyEscalated.length} this run)` : ''}\n`);
      if (debtLedger.entries.length >= 10) {
        // Top file only surfaces for larger ledgers (noise suppression per fix L3)
        const byFile = new Map();
        for (const e of debtLedger.entries) {
          const f = (e.affectedFiles || [])[0];
          if (f) byFile.set(f, (byFile.get(f) || 0) + 1);
        }
        const topFile = [...byFile.entries()].sort((a, b) => b[1] - a[1])[0];
        if (topFile) {
          process.stderr.write(`  Oldest: ${oldestDays}d | Top file: ${topFile[0]} (${topFile[1]} entries)\n`);
        } else {
          process.stderr.write(`  Oldest: ${oldestDays}d\n`);
        }
      } else {
        process.stderr.write(`  Oldest: ${oldestDays}d\n`);
      }
      process.stderr.write(`═══════════════════════════════════════\n\n`);
    }

    // Build suppression context envelope for downstream Gemini review (Phase D.4)
    // so the final-gate doesn't resurface what we already filtered.
    const debtSuppressionContext = [];
    for (const [topicId] of surfacedTopics) {
      const entry = debtLedger.entries.find(e => e.topicId === topicId);
      if (entry) {
        debtSuppressionContext.push({
          topicId,
          category: entry.category,
          section: entry.section,
          affectedFiles: entry.affectedFiles,
          deferredReason: entry.deferredReason,
        });
      }
    }

    // Stored in temp var because mergedResult is defined later (TDZ)
    var _debtMemoryData = {
      eventSource: debtContext.source,
      debtSuppressed: surfacedTopics.size,
      debtReopened: reopenedDebtTopics.size,
      debtEntriesLoaded: debtLedger.entries.length,
      newlyEscalated: newlyEscalated.length,
      // Phase D.4: transcript envelope for Gemini (capped to 50 topics to bound context)
      suppressionContext: debtSuppressionContext.slice(0, 50),
    };
  }

  // ── Post-output suppression passes (local FP tracker, then cloud FP policy) ──
  // Position is LOAD-BEARING and must stay here:
  //   * AFTER the ledger branch above — nesting either pass inside makes it
  //     conditional on unrelated local ledger state. A run with an empty merged
  //     ledger is exactly the case each pass exists to serve (a pattern the
  //     tracker learned; a pattern another machine learned), and nesting is what
  //     silently disabled the local one for years.
  //   * BEFORE the auto-write ledger block below, which reads allFindings.
  // ONE unconditional call: runSuppressionPasses is a no-op with a null tracker
  // AND a null policy, and always returns a NEW array — so there is no branch
  // here to get wrong, and the clear-then-push can never empty its own source.
  // All decision logic (ordering, counters, the union, the no-ledger synthesis)
  // lives in the seam, not here.
  const passes = runSuppressionPasses(allFindings, {
    fpTracker,
    cloudPolicy: cloudFpPolicy,
    exempt: reopenedSet,
    suppressionData: typeof _suppressionData !== 'undefined' ? _suppressionData : null,
    cloudEnabled: cloudRepoId != null,
    log: (line) => process.stderr.write(line),
  });
  allFindings.length = 0;
  allFindings.push(...passes.findings);
  // Legal here because `_suppressionData` is `var` (function-scoped); reading
  // it inside the ledger branch instead would hit the TDZ on `passes`.
  _suppressionData = passes.suppressionData ?? undefined;

  // ── Deterministic finding-verification gate (code mode only) ──────────
  // Resolves "missing file/module/symbol" findings against the real repo.
  // A finding the gate PROVES false (entity exists) is `refuted` and no
  // longer counts toward the verdict; everything else keeps its severity.
  // Plan: docs/plans/adaptive-context-blast-radius.md — Phase 1.
  //
  // Runs BEFORE the ledger auto-write below (moved 2026-08-20): the ledger
  // write persists `adjudicationOutcome` at insert time, so the gate's
  // verdict must already be known when that write happens. It used to run
  // AFTER the write — every finding, refuted or not, was persisted as
  // `pending`, and nothing ever went back to correct a refuted entry, so a
  // finding the gate had just proved false stayed `pending` in the ledger
  // forever with no record it was ever disproven.
  try {
    const inv = listRepoFiles({ baseDir: process.cwd() });
    const verified = verifyExistenceFindings(allFindings, { repoFiles: inv.files, inventoryComplete: inv.complete });
    allFindings.length = 0;
    allFindings.push(...verified);
    // Name the IDs. A bare count told the reader that SOME finding in the
    // list was disproven without saying which, and `findings[]` still carries
    // the model's original severity — so a refuted HIGH was indistinguishable
    // from a real one at the point of triage (measured 2026-08-13: a refuted
    // H1 was fixed as a HIGH in a consumer repo).
    const refuted = verified.filter(isRefuted);
    if (refuted.length > 0) {
      process.stderr.write(
        `  [verify-gate] ${refuted.length} existence finding(s) REFUTED — the cited entity exists. `
        + `Excluded from the verdict; do NOT act on them: ${refuted.map(f => `${f.id} (${f.severity}→${effectiveSeverity(f)})`).join(', ')}\n`);
    }
  } catch (err) {
    process.stderr.write(`  [verify-gate] skipped (non-blocking) — ${err.message}\n`);
  }

  // Auto-write ledger (default-on when ledgerFile resolved)
  if (ledgerFile && !noLedger) {
    try {
      const enriched = allFindings.map(f => {
        const copy = { ...f };
        populateFindingMetadata(copy, copy._pass);
        return copy;
      });

      const ledgerEntries = enriched.map(f => {
        // The gate above already ran, so a refuted finding is known at
        // insert time — persist it as `dismissed`, not `pending`, and carry
        // the disproof reason. (Only affects a NEW topicId this round:
        // `upsertEntry`'s update path deliberately preserves whatever
        // `adjudicationOutcome` an already-resident entry has, the same
        // protection that stops a re-raise from clobbering a real human
        // ruling — a finding refuted on a LATER round than it was first
        // inserted is outside this fix's scope.)
        const refuted = isRefuted(f);
        return {
          topicId: generateTopicId(f),
          findingId: f.id,
          severity: f.severity,
          category: f.category,
          section: f.section,
          detailSnapshot: f.detail?.slice(0, 300),
          detail: f.detail?.slice(0, 300),
          pass: f._pass,
          _hash: f._hash,
          semanticHash: f._hash,
          affectedFiles: f.affectedFiles || [f._primaryFile || ''],
          affectedPrinciples: f.principle ? [f.principle] : [],
          adjudicationOutcome: refuted ? 'dismissed' : 'pending',
          remediationState: 'pending',
          ...(refuted ? { rulingRationale: f.verification?.verificationReason } : {}),
          round
        };
      });

      const { inserted, updated, total, rejected } = batchWriteLedger(ledgerFile, ledgerEntries);
      process.stderr.write(`  [ledger] Written to ${ledgerFile}: ${inserted} new, ${updated} updated, ${total} total\n`);
      if (rejected?.length > 0) {
        process.stderr.write(`  [ledger] ${rejected.length} entries REJECTED:\n`);
        for (const { entry, reason } of rejected.slice(0, 5)) {
          process.stderr.write(`    - ${entry.topicId || '(no topicId)'}: ${reason}\n`);
        }
        var _ledgerRejectedCount = rejected.length;
      }
    } catch (err) {
      process.stderr.write(`  [ledger] WRITE FAILED: ${err.message}\n`);
      var _ledgerWriteError = err.message;
    }
  }

  // Phase C: verdict counts exclude tool findings by default (advisory mode).
  // With --strict-lint, tool findings count in the verdict.
  const isToolFinding = (f) => {
    const k = f.classification?.sourceKind;
    return k === 'LINTER' || k === 'TYPE_CHECKER';
  };
  // Effective severity respects the verification gate: a refuted finding
  // has countsTowardVerdict=false; confirmed / requires_verification keep
  // the model's original severity (audit G2). Both predicates now come from
  // `finding-verification.mjs` — they were inline lambdas here, the second
  // spelling of a rule the consumer SKILL.md never learned at all.
  const effSeverity = effectiveSeverity;
  const countFor = (strictLint ? allFindings : allFindings.filter(f => !isToolFinding(f)))
    .filter(countsTowardVerdict);
  const high = countFor.filter(f => effSeverity(f) === 'HIGH').length;
  const medium = countFor.filter(f => effSeverity(f) === 'MEDIUM').length;
  const low = countFor.filter(f => effSeverity(f) === 'LOW').length;

  // Phase 11 (tiered-recall pipeline): shared verdict function — pre-normalise
  // severity to the verification-gate-effective value (`effSeverity`) since
  // `computeAuditVerdict` itself only reads `.severity` verbatim.
  let verdict = computeAuditVerdict(
    countFor.map(f => ({ ...f, severity: effSeverity(f) })),
    { incomplete: failedPasses.length > 0 },
  );

  // Fix #2: Partial MAP verdict downgrade. When any pass completed <66% of MAP
  // units, the verdict is unreliable — downgrade to INCOMPLETE regardless of findings.
  const minMapCompletion = Math.min(...allResults.map(r => r._mapCompletionRate ?? 1));
  if (minMapCompletion < 0.66 && verdict !== 'INCOMPLETE') {
    process.stderr.write(`  [verdict] Downgrading to INCOMPLETE — MAP completion ${(minMapCompletion * 100).toFixed(0)}% (need ≥66%)\n`);
    verdict = 'INCOMPLETE';
  }

  const totalUsage = {
    input_tokens: allResults.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0),
    cached_tokens: allResults.reduce((s, r) => s + (r.usage?.cached_tokens ?? 0), 0),
    output_tokens: allResults.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0),
    reasoning_tokens: allResults.reduce((s, r) => s + (r.usage?.reasoning_tokens ?? 0), 0),
    latency_ms: totalLatency
  };
  // Price the aggregate token total so `_usage.costUsd` is a real dollar
  // figure (2026-07-22 defect: legacy never priced its tokens, so the tiered-
  // shadow comparison recorded `legacyCostUsd: null` on every run). All legacy
  // passes use the one resolved audit model, so a single price over the
  // aggregate is correct. For an unpriced model (e.g. an Azure deployment id
  // not in the pricing table) `costFromUsage` returns an OBJECT whose
  // `totalUsd` is `null` — an honest "unknown", never a fabricated 0. It never
  // returns a bare `null`, so this dereference is safe; the wording used to say
  // "returns null", which reads as a null-deref waiting to happen and was
  // raised as exactly that by an audit pass on 2026-07-28 (finding accepted,
  // then unactionable, because the code was already correct). Verified by
  // execution 2026-08-11: costFromUsage(usage, '<unpriced>').totalUsd === null.
  // Cache discounts are ignored (a slight over-estimate, the conservative
  // direction for a cost comparison).
  totalUsage.costUsd = costFromUsage(totalUsage, openaiConfig.model).totalUsd;

  // ── Cache telemetry (PR-4) ───────────────────────────────────────────
  // Aggregate prompt-prefix-cache hit metrics across all audit-pass calls.
  // hitRate guard: 0/0 → 0 (per Gemini R2 review of plan).
  // Per-pass entries keyed by passName; map-reduce sub-units use their
  // map-<passName>-<i> keys (kept distinct for diagnostic per-unit visibility,
  // per plan §2 telemetry contract).
  const cacheMetrics = {
    totalInputTokens: totalUsage.input_tokens,
    totalCachedTokens: totalUsage.cached_tokens,
    hitRate: totalUsage.input_tokens > 0
      ? totalUsage.cached_tokens / totalUsage.input_tokens : 0,
    estimatedSavingsPct: 0,
    // Effective cache-seed state for this run (plan R1-M4): true iff ≥1 pass
    // actually warmed the prefix cache (decideSeed→seedUsed), NOT just the env
    // flag. Powers the seed-ON cohort in `cache-hitrate-check`.
    seedUsed: _runSeedUsed,
    seedEligible: _runSeedEligible,
    seedSkipReason: _runSeedSkipReason,
    perPass: {},
  };
  cacheMetrics.estimatedSavingsPct = cacheMetrics.hitRate * 0.5; // OpenAI ~50% discount
  // Phase 3 (audit-orchestrator-hardening): perPass entries keyed by NAME
  // via the pass registry — replaces the prior parallel-array index-zip
  // against `passNameOrder` (a THIRD independently-fragile mechanism that
  // silently excluded architecture/orphan-introduced entirely).
  for (const entry of passRegistry) {
    const r = entry._result;
    const perPassEntry = { totalInputTokens: 0, totalCachedTokens: 0, hitRate: 0, callCount: 0, retryCount: 0 };
    perPassEntry.totalInputTokens = r?.usage?.input_tokens ?? 0;
    perPassEntry.totalCachedTokens = r?.usage?.cached_tokens ?? 0;
    // Was 1 for EVERY registry entry, including passes that never dispatched —
    // so the only per-pass call counter in the pipeline could not distinguish
    // "made one call" from "made none", and was useless as a denominator
    // (final-review shadow, MEDIUM). Precedence, most specific first:
    //   • a pass that reports its own count (the mechanical waves, whose
    //     bouncer fires only when the detector yields eligible candidates)
    //   • a map-reduce pass: one call per MAP unit, plus REDUCE unless skipped
    //   • otherwise: 1 if it ran, 0 if it did not
    // Retries are NOT folded in here — `retryCount` carries them separately, and
    // adding them would double-count against `totalInputTokens`.
    perPassEntry.callCount = Number.isInteger(r?.callCount) ? r.callCount
      : Number.isInteger(r?.unitsAttempted) ? r.unitsAttempted + (r?._reduceSkipped ? 0 : 1)
      : entry.ran ? 1 : 0;
    perPassEntry.retryCount = r?._retried ? (r._attempts ?? 2) - 1 : 0;
    perPassEntry.hitRate = perPassEntry.totalInputTokens > 0
      ? perPassEntry.totalCachedTokens / perPassEntry.totalInputTokens : 0;
    cacheMetrics.perPass[entry.name] = perPassEntry;
  }
  process.stderr.write(`  [cache] input=${cacheMetrics.totalInputTokens} cached=${cacheMetrics.totalCachedTokens} hitRate=${(cacheMetrics.hitRate * 100).toFixed(1)}% (~${(cacheMetrics.estimatedSavingsPct * 100).toFixed(1)}% savings)\n`);

  // Build per-pass timing map — Phase 3: registry-derived.
  const passTimings = {};
  for (const entry of passRegistry) {
    passTimings[entry.name] = `${(entry.latencyMs / 1000).toFixed(1)}s`;
  }
  passTimings.total = `${(totalLatency / 1000).toFixed(1)}s`;

  // Build overall reasoning from pass summaries — Phase 3: registry-derived
  // (previously excluded quickfix/architecture/orphan-introduced entirely,
  // the same drift addFindings/allResults had).
  const summaryLines = passRegistry.map(entry => `**${entry._displayPrefix}**: ${entry.summary || 'N/A'}`);
  if (failedPasses.length > 0) {
    summaryLines.push(`\n**WARNING**: ${failedPasses.length} pass(es) failed — findings may be incomplete.`);
  }

  const mergedResult = {
    verdict,
    files_planned: structureResult.result.files_planned ?? allPaths.size,
    files_found: structureResult.result.files_found ?? found.length,
    files_missing: structureResult.result.files_missing ?? missing.length,
    code_files: found,
    findings: allFindings,
    wiring_issues: wiringResult.result.wiring_issues ?? [],
    quick_fix_warnings: [
      ...backendResults.flatMap(r => r.result.quick_fix_warnings ?? []),
      ...(frontendResult.result.quick_fix_warnings ?? []),
      ...(sustainResult.result.quick_fix_warnings ?? [])
    ],
    dead_code: sustainResult.result.dead_code ?? [],
    overall_reasoning: summaryLines.join('\n'),
    _pass_timings: passTimings,
    _failed_passes: failedPasses.length > 0 ? failedPasses : undefined,
    _usage: totalUsage,
    _cacheMetrics: cacheMetrics,
    // Typed shape: ExecutionMetaSchema (schemas.mjs), VALIDATED by the builder
    // rather than merely resembling it. `undefined` inputs are dropped and an
    // all-empty block collapses to `undefined`, so a clean round still carries
    // no key at all — absence keeps meaning "nothing degraded", and a hard 0
    // can never read as a measurement nobody took.
    _executionMeta: buildExecutionMeta({
      suppressionUnavailable: suppressionUnavailable || undefined,
      ledgerInvalidEntryCount: ledgerInvalidEntryCount > 0 ? ledgerInvalidEntryCount : undefined,
      // Per-pass REDUCE degradation, which until 2026-08-13 was emitted on the
      // pass result and then dropped here — this block was built from
      // suppression state alone, so a degraded REDUCE reached the run only as
      // prose inside `overall_reasoning`.
      reducePassStatuses: collectReducePassStatuses(passRegistry),
    }),
  };

  // Attach data accumulated before mergedResult was defined (var hoisting avoids TDZ)
  if (typeof _suppressionData !== 'undefined') {
    mergedResult._suppression = _suppressionData;
  }
  if (typeof _debtMemoryData !== 'undefined') {
    mergedResult._debtMemory = _debtMemoryData;
  }
  if (typeof _ledgerRejectedCount !== 'undefined') {
    mergedResult._ledgerRejectedCount = _ledgerRejectedCount;
  }
  if (typeof _ledgerWriteError !== 'undefined') {
    mergedResult._ledgerWriteError = _ledgerWriteError;
  }
  if (typeof _linterOverlapData !== 'undefined') {
    mergedResult._linterOverlap = _linterOverlapData;
  }

  // Phase 3-4: Record initial findings for learning (pre-triage — accepted is null).
  // Actual triage outcomes are written by outcome-sync.mjs AFTER deliberation.
  // Gated (audit R2-H1): outcomes.jsonl is the LOCAL bandit reward stream — an
  // observation-only shadow appending its findings here trains the real
  // bandit on data from a run that must be invisible. Same class as the tail
  // syncs, one write site over.
  writeLearningState(learningWritesAllowed, () => { for (const f of allFindings) {
    const revId = getActiveRevisionId(f._pass) || 'default';
    appendOutcome('.audit/outcomes.jsonl', {
      findingId: f.id,
      severity: f.severity,
      category: f.category,
      section: f.section,
      primaryFile: f._primaryFile || f.section,
      affectedFiles: f.affectedFiles || [],
      pass: f._pass,
      accepted: null, // Pre-triage: outcome-sync writes actual result after deliberation
      round,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: f._hash,
    });
  } });

  // Phase 3: Cloud store — record findings + pass stats.
  //
  // NO LONGER FIRE-AND-FORGET (durability plan, decision 1c/3). These four
  // writes were `.catch(log)` with no await, no spill and no counter: a dropped
  // `recordFindings` produced a run row that looks healthy and under-reports —
  // a believable false zero. Each now goes through `durableWrite`, which writes
  // a write-ahead envelope BEFORE attempting the store, so a process that dies
  // mid-write still leaves the payload on disk.
  //
  // CONCURRENCY IS PRESERVED BY CONSTRUCTION. Every `durableWrite` below is
  // dispatched before the single `await` at the end of the block, so the store
  // round-trips still overlap exactly as the un-awaited calls did. What is new
  // is one join point — unavoidable if the outcome is to be reported at all,
  // and bounded by the slowest of writes that were already in flight. That is an
  // argument from the code's shape, NOT a measurement: §7 of the plan asks for a
  // before/after figure and none has been taken, so no latency claim is made.
  if (cloudRunId) {
    const writePromises = [];
    writePromises.push(durableWrite('audit.findings', {
      runId: cloudRunId, findings: allFindings, passName: 'merged', round,
    }));

    // Record per-pass stats
    // Phase 3 (audit-orchestrator-hardening): registry-derived — previously
    // a 4th hand-listed pass array that also excluded architecture/
    // orphan-introduced.
    for (const entry of passRegistry) {
      // Model + cost attribution (2026-08-23). `source_model`, `cost_usd` and
      // `usage_unmeterable` exist on `audit_pass_stats` and `recordPassStats`
      // has always written them — but the ONLY caller that ever supplied them
      // was the model-A/B shadow, so every production row carried NULL and the
      // per-pass log was model-blind for its whole history.
      //
      // `costFromUsage` (analytics), deliberately NOT its sibling
      // `costForBudget` (spend-cap): the latter never returns null and falls
      // back to a conservative OVER-estimate so a € ceiling can't be
      // overshot — correct there, a fabricated measurement here. This one is
      // null-honest, so an unpriced model or unmeterable usage lands as NULL
      // rather than as a $0 indistinguishable from a genuinely free call.
      //
      // Both fields stay `undefined` when no model was dispatched (mechanical
      // detectors, skipped passes): `recordPassStats` omits an undefined column
      // entirely, so the row reads NULL — "no call was made", never "a call was
      // made and cost nothing".
      const cost = entry._model ? costFromUsage(entry.usage, entry._model) : null;
      writePromises.push(durableWrite('audit.passStats', {
        runId: cloudRunId,
        passName: entry.name,
        round,
        stats: {
          raised: entry.findings.length,
          accepted: 0, // Updated after deliberation
          dismissed: 0,
          compromised: 0,
          inputTokens: entry.usage?.input_tokens,
          outputTokens: entry.usage?.output_tokens,
          latencyMs: entry.latencyMs,
          sourceModel: entry._model ?? undefined,
          costUsd: cost ? cost.totalUsd : undefined,
          usageUnmeterable: cost ? cost.unmeterable : undefined,
          // The effort the pass ACTUALLY dispatched with, carried back from the
          // call itself (`_reasoning` above). 6ae952bf removed a second copy of
          // a name→level guess here; 2026-08-12 removed the guess entirely,
          // because both copies had been wrong for structure and wiring. Null
          // for a pass that made no LLM call — an absence, not a level.
          reasoning: entry._reasoning,
        },
      }));
    }

    // Record suppression events if R2+ — OR whenever a suppression PASS fired.
    // The isR2Plus gate encodes "ledger suppression is an R2+ concept", true for
    // the ledger path but NOT for the local/cloud passes: both are unconditional
    // and can suppress on round 1, where the bare gate would silently drop their
    // provenance. A suppression on R1 is no less accountable than one on R2.
    if ((isR2Plus || passes.suppressedCount > 0) && mergedResult._suppression) {
      writePromises.push(durableWrite('audit.suppressionEvents', {
        runId: cloudRunId, suppressionResult: mergedResult._suppression,
      }));
    }

    // The single join point. `durableWrite` never rejects for a store failure —
    // the store is optional by design and an audit that produced findings must
    // not fail because it could not record them — so this cannot throw here and
    // a rejection would be a programmer error (an unregistered writer id), which
    // SHOULD surface.
    tallyWriteOutcomes(writeOutcomes, await Promise.all(writePromises));
  }

  // ── Model-A/B/C generation shadow (observation-only; awaited, NEVER gates) ──
  // Dynamic imports so the shadow (+ its OSS deps) load ONLY when arms are
  // configured — with AUDIT_MODEL_SHADOW unset this block is inert and the audit
  // is byte-identical to today (the opt-in invariant). The redacted context is
  // built ONCE here (decision 11) and handed to the shadow — arms never see raw
  // paths. Best-effort: a shadow failure never touches A's verdict/ship path,
  // EXCEPT an egress-gate refusal, which must surface loudly.
  try {
    // Toggle-aware: explicit AUDIT_MODEL_SHADOW env wins; else the per-repo
    // arm-eval-toggle file activates B,C; else inert (byte-identical path).
    const { resolveShadowArmsWithToggle } = await import('../arm-eval/toggle.mjs');
    const armSet = resolveShadowArmsWithToggle(process.env);
    if (armSet.enabled) {
      const { runGenerationShadow, classifyShadowFailure } = await import('../audit-shadow.mjs');
      const { buildRedactedAuditContext } = await import('../audit-scope.mjs');
      const redacted = buildRedactedAuditContext([...subjectFiles]);
      const shadowSummary = await runGenerationShadow({
        redactedContext: redacted.context,
        arms: armSet.arms,
        baseline: mergedResult,
        runId: cloudRunId,
        planContent,
        round,
      });
      mergedResult._modelAbShadow = shadowSummary;
      process.stderr.write(
        `  [shadow] model-A/B generation shadow: ${shadowSummary.state}`
        + (shadowSummary.findingCount != null ? ` (${shadowSummary.findingCount} findings, ${shadowSummary.shadowOnly} shadow-only, stages: ${(shadowSummary.stages || []).join('+')})` : '')
        + '\n',
      );
    }
  } catch (err) {
    // The shadow is opt-in/observation-only — NO failure here, including an
    // egress-gate refusal, may propagate past this point. Doing so would abort
    // the primary audit before its --out write, discarding an already-
    // successful result over an unrelated side experiment (see
    // classifyShadowFailure doc in lib/audit-shadow.mjs). The recovery
    // import itself is guarded too — see classifyShadowFailureSafe.
    const { log, marker } = await classifyShadowFailureSafe(err);
    process.stderr.write(`  [shadow] ${log}\n`);
    if (marker) mergedResult._modelAbShadow = marker;
  }

  // Attach cloud run ID to result for orchestrator reference. The /audit-code
  // skill reads `_cloudRunId` from the audit --out JSON and forwards it to
  // gemini-review.mjs as `--run-id`, which keys the final-review (+ shadow A/B)
  // per-finding cloud persistence to this run. Absent when cloud is off →
  // gemini-review runs local-only (docs/plans/final-review-shadow-reviewer.md).
  if (cloudRunId) mergedResult._cloudRunId = cloudRunId;

  // Phase C: surface tool-pre-pass capability state
  mergedResult._toolCapability = toolCapability;

  // Phase 5: Flush bandit state + sync learning systems to cloud.
  // BOTH sites are gated on learningWritesAllowed — these were the two cloud
  // writes NOT transitively covered by the `if (cloudRunId)` key (audit H1,
  // 2026-07-18): syncBanditArms takes no repoId, so an observation-only
  // shadow run was mutating the shared bandit_arms table whenever cloud was
  // on, contaminating the very data the tiered-recall window measures. The
  // local flush() is gated too: an observation run persisting the shared
  // bandit file is the same contamination class, one channel over.
  if (bandit) {
    // `writeLearningState` returns whatever `fn` returns, so the promise is
    // awaited here rather than dropped — this is the fourth of the plan's
    // fire-and-forget sites and the await is the point of migrating it.
    // Awaited only when `learningWritesAllowed`; the gate returns undefined
    // otherwise, which `await` handles.
    await writeLearningState(learningWritesAllowed, async () => {
      bandit.flush();
      tallyWriteOutcomes(writeOutcomes, [await durableWrite('learning.banditArms', { arms: bandit.arms })]);
    });
  }
  if (fpTracker) {
    // cloudRepoId is the audit_repos row UUID (null → GLOBAL sentinel inside
    // the sync). Dirty subset only — syncing the whole map rewrote thousands
    // of unchanged rows per run (2026-07-17 Disk IO incident). The
    // isSyncableRepoId refusal inside the sync stays as defence-in-depth for
    // a DIFFERENT failure (unresolved repo identity on a real run) — before
    // this gate, that coincidence was the only thing keeping shadow runs
    // from writing FP patterns.
    // Awaited and counted since 2026-08-12 (Cluster B audit H4/M12). This was
    // the fifth fire-and-forget write in this block — un-awaited, so the pool's
    // `allowExitOnIdle` could kill it once the last awaited query went idle.
    await writeLearningState(learningWritesAllowed, async () => {
      tallyWriteOutcomes(writeOutcomes, [await durableWrite('learning.fpPatterns', {
        repoId: cloudRepoId, patterns: fpTracker.dirtyPatterns(),
      })]);
    });
  }

  // Phase 3 — adaptive-learning convergence_predict telemetry.  Emit ONE
  // decision per round capturing this round's findings + delta vs prior
  // round.  outcome=null at emit time; backfilled at run-end below with
  // {converged_at, hit_max, hit_rigor_pressure} once the next round (or
  // stop signal) is known.  Best-effort; never throws into audit pipeline.
  if (cloudRunId) {
    try {
      // Cluster-B audit-code R2/M7 fix: D10 (docs/plans/event-wiring-symmetry.md)
      // excludes `enforcement: 'advisory'` findings from the real verdict's
      // high/medium counts (findings-pipeline.mjs's computeAuditVerdict) — this
      // telemetry computed its own count from raw allFindings with no such
      // exclusion, so an advisory HIGH/MEDIUM inflated convergence_predict's
      // signal even though it never affects the actual gate. Same filter here.
      const gatingFindings = allFindings.filter(f => f?.enforcement !== 'advisory');
      const highCount   = gatingFindings.filter(f => f.severity === 'HIGH').length;
      const mediumCount = gatingFindings.filter(f => f.severity === 'MEDIUM').length;
      const dismissed   = allFindings.filter(f => f.adjudicationOutcome === 'dismissed').length;
      _learningRecordDecision({
        decisionType: 'convergence_predict',
        repoId: cloudRepoId,
        auditRunId: cloudRunId,
        round: round || 1,
        sequence: 0,
        context: {
          round: round || 1,
          highCount,
          mediumCount,
          dismissed,
          totalFindings: allFindings.length,
          // deltaPattern is filled by the reconciler comparing to prior rounds.
        },
        choice: { chose: 'continue' }, // telemetry-only in v1: never stop
        outcome: null,
      });
    } catch { /* validation failure — best-effort telemetry */ }
  }

  // model-tier-observation (docs/plans/model-tier-observation.md) — author_tier
  // telemetry.  Observation-ONLY: records aggregates-only scope signals × the
  // heuristic suggested tier × the (optional) declared author tier + ladder
  // partition key × this round's converged outcome.  NOTHING reads these to
  // route.  Per-round audit-bound key (mirrors convergence_predict above);
  // run-level rounds-to-converge derives at read.  Skip when nothing was
  // authored (no changed files).  Best-effort — never blocks the audit.
  if (cloudRunId && Array.isArray(changedFiles) && changedFiles.length > 0) {
    try {
      let domains = [];
      try {
        // resolved domain tags (aggregates-only); absent/invalid map → no signal
        domains = _computeTargetDomains(changedFiles, _loadDomainRules(process.cwd())).domains || [];
      } catch { /* domain-map absent or invalid — proceed without domain signal */ }
      const signals = _deriveTierSignals({ changedFiles, domains, diffLines: diffLinesChanged ?? 0 });
      // Cluster-B audit-code R2/M7 fix: same D10 exclusion as the
      // convergence_predict block above — this comment's own claim ("the
      // SAME quality threshold /audit-code gates on") was false without it,
      // since computeAuditVerdict (the real gate) already excludes advisory
      // findings and this telemetry didn't.
      const gatingFindings = allFindings.filter(f => f?.enforcement !== 'advisory');
      const highCount   = gatingFindings.filter(f => f.severity === 'HIGH').length;
      const mediumCount = gatingFindings.filter(f => f.severity === 'MEDIUM').length;
      const quickFix    = allFindings.filter(f => f.is_quick_fix).length;
      // converged = the same quality threshold /audit-code gates on, this round
      // (scripts/lib/audit/convergence.mjs — plan §F2.5, the single canonical
      // definition; SKILL.md prose and gate-contract.json params are pinned
      // copies asserted against this, never independent sources)
      const converged   = evaluateConvergence({ high: highCount, medium: mediumCount, quickFix });
      _learningRecordDecision(_buildAuthorTierObservation({
        runId: cloudRunId,
        round: round || 1,
        signals,
        converged,
        authorTierHint: process.env.AUDIT_AUTHOR_TIER_HINT || null,
        repoId: cloudRepoId,
      }));
    } catch { /* validation/record failure — best-effort telemetry */ }
  }

  // ── Commit-provenance gate evidence (2026-07-18) ────────────────────────
  // Two writes that make `AI-Gate: passed` REACHABLE. Both were missing, and
  // the pair is the point: `ship-commit.mjs` requires (a) a fresh local marker
  // proving an audit ran after HEAD, AND (b) the store's convergence verdict
  // for that same runId proving it passed. Neither existed — `resolveEvidence`
  // read a marker nothing wrote, and `recordConvergenceState` had zero callers,
  // leaving `round_converged_after` NULL on all 39 live rows. So every commit
  // shipped `not-run`, understating changes that had cleared a full multi-round
  // GPT audit plus a consolidated Gemini gate.
  //
  // Fixing only the marker (the obvious half) would have produced a WORSE
  // state than before: `resolveEvidence` would report `fresh`, forbidding
  // `not-run`, while `evaluateGateVerification` still refused `passed` for want
  // of a verdict — leaving `waived` as the only legal value on a genuinely
  // converged audit. The two writers ship together or not at all.
  if (cloudRunId && !noCloudRecording) {
    // (a) The local marker — proves an audit RAN after HEAD. Never proves it
    //     passed; that is deliberately the store's job, because a local file
    //     is not evidence anyone should be able to hand-author.
    //     The audited-target identity (E1 hop 3) is carried from ctx, captured
    //     BEFORE input collection — never re-derived here, which would hash the
    //     tree as it looks now rather than as the audit read it.
    const { writeGateEvidence } = await import('./gate-evidence.mjs');
    // `auditedBranch` is forwarded by PRESENCE, never `?? null`: null MEANS
    // "detached at capture", so coalescing an unset property into null would
    // record every attached audit as detached and make /ship's guard B refuse
    // every ship. If the capture block never ran, that is a wiring bug — say so
    // and write nothing, rather than fabricating a plausible-looking marker.
    if (!Object.hasOwn(ctx, 'auditedBranch')) {
      process.stderr.write('  [gate-evidence] ctx.auditedBranch was never captured (wiring bug) — writing no marker; commit will read as not-run\n');
    } else {
      // a4bf14de: the writer itself never throws (every internal failure —
      // buildGateEvidence's throw, the file write itself — is caught inside
      // writeGateEvidence and degraded to a `{written:false, reason}` return),
      // but that return used to be discarded here. Its failure was therefore
      // visible only as an isolated stderr line, with no coordinated record
      // alongside the cloud convergence write immediately below — which DOES
      // tally into `writeOutcomes`/`mergedResult`. Capturing it here doesn't
      // fold it into `runStatus` (a local marker miss is a different kind of
      // gap than undurable audit data — /ship's guard already degrades a
      // missing marker to `not-run` on its own), just makes the failure
      // queryable instead of stderr-only, same as `_ledgerWriteError` below.
      const gateEvidenceResult = writeGateEvidence({
        repoRoot: process.cwd(),
        runId: cloudRunId,
        mode: 'code',
        sid: debtRunId ?? null,   // the session's stable `audit-<ts>` id (declared above)
        round: round || 1,
        auditedSha: ctx.auditedSha ?? null,
        auditedTree: ctx.auditedTree ?? null,
        auditedBranch: ctx.auditedBranch,
      });
      if (!gateEvidenceResult.written) {
        mergedResult._gateEvidenceUnwritten = gateEvidenceResult.reason;
      }
    }

    // (b) The store verdict — the ONLY thing that can license `passed`.
    //     `converged` uses the same canonical threshold /audit-code gates on
    //     (convergence.mjs), recomputed here rather than reused from the
    //     telemetry block above, which is scoped to runs with changed files
    //     and would silently skip this write on a plan-scoped audit.
    //     `round_converged_after` stays NULL when the round did not converge —
    //     that is the honest value, and it is what makes `passed` refuse.
    try {
      // bf45c2f7: reuse the SAME effSeverity/countFor-derived counts the
      // verdict above used, rather than recomputing from raw allFindings/
      // f.severity — the two previously could disagree whenever a finding
      // was excluded from the verdict (refuted by the verification gate, or
      // a tool finding under advisory mode), silently letting this gate
      // license `passed`/`converged` on a stricter or looser count than the
      // verdict actually reported.
      // The DETECTOR gate, not the count threshold alone (docs/plans/
      // gate-honesty-adjudicated-defects.md D1). `evaluateConvergenceWithDetectors`
      // and `checkDetectors` existed, were hardened against a silent pass, and had
      // NO production caller — so `skills/audit-code/SKILL.md` §5.0b's "blocks
      // convergence" was enforced only by a human remembering to run it, while THIS
      // value is what licenses `AI-Gate: passed`.
      //
      // The mapping lives in `resolveDetectorResultForRound` (convergence.mjs) so
      // "ledger present" can never be mistaken for "detectors absent": an R2+ round
      // whose ledger is missing or corrupt yields `undefined` here, which the oracle
      // reads as `detector-not-run` — NOT converged. That is the point of the fix.
      const detectorVerdict = evaluateConvergenceWithDetectors(
        {
          high,
          medium,
          quickFix: allFindings.filter((f) => f.is_quick_fix).length,
        },
        // `suppressionUnavailable` (function-scoped, :1644) is the signal, NOT
        // `ledgerValidation` — that one is `const` inside `if (isR2Plus)` and is
        // not in scope here. Same fact, correct binding.
        resolveDetectorResultForRound({
          // Normalised HERE, not in the resolver: the orchestrator knows an absent
          // round means the first one (the same `round || 1` this file uses
          // throughout), while the resolver must treat an unknown round as unknown
          // detectors. Both halves fail closed on their own terms.
          round: round || 1,
          suppressionUnavailable,
          ledger,
          cwd: process.cwd(),
          checkDetectorsFn: checkDetectors,
        }),
      );
      const convergedNow = detectorVerdict.converged;
      if (!convergedNow && detectorVerdict.reason !== 'finding-thresholds') {
        // Say WHY, or a round that passed the counts and failed the detector gate
        // is indistinguishable from one that simply had findings left.
        process.stderr.write(`  [gate-evidence] not converged: ${detectorVerdict.reason}\n`);
      }
      // The SUBJECT is recorded whether or not the run converged (E1 hop 2):
      // "what was audited" is a fact of the run, independent of its verdict, and
      // binding it here is what lets the store contradict a forged local marker.
      // `round_converged_after` stays NULL on a non-converged round — the honest
      // value, and the one that makes `passed` refuse.
      // Through the seam (audit 2026-08-13). This is the write that makes a
      // FORGED `.audit/last-audit-run.json` detectable, so its failure being
      // logged-but-uncounted meant the cross-check could go missing for a run
      // with nothing recording that it had. Same table, same key and the same
      // idempotent UPDATE as `audit.runComplete`, which was already durable.
      tallyWriteOutcomes(writeOutcomes, [await durableWrite('audit.convergenceState', {
        runId: cloudRunId,
        run_id: cloudRunId,
        state: {
          audited_sha: ctx.auditedSha ?? null,
          audited_tree: ctx.auditedTree ?? null,
          ...(convergedNow ? { round_converged_after: round || 1 } : {}),
        },
      })]);
    } catch (e) {
      process.stderr.write(`  [gate-evidence] convergence record failed: ${e.message}\n`);
    }
  }

  // Phase 5b: Finalise cloud run record with counts + run metadata
  //
  // MUST be awaited (2026-07-18). This was fire-and-forget, and the pool runs
  // with `allowExitOnIdle: true` (db/client.mjs) — so once the audit's last
  // awaited query completed and the connections went idle, Node exited and
  // killed this UPDATE in flight. Result: every `mode='code'` run in the store
  // was left at its `recordRunStart` INSERT values (`rounds: 0`,
  // `total_findings: 0`, `total_duration_ms: NULL`) while its findings — which
  // ARE written on an awaited path — landed normally. 25/25 live code runs were
  // in that state; plan mode was unaffected precisely because
  // `plan-audit-cloud.mjs` awaits its call. The `.catch()` stays: this is still
  // best-effort telemetry that must never fail an audit. Awaiting only
  // guarantees it gets the chance to finish.
  //
  // NOW A DURABLE WRITE (plan decision 3). A lost completion write does not
  // leave a neutral row, it leaves a WRONG one — the run stays at its
  // `recordRunStart` values, so a finished run reads as one still executing.
  // That is a second false zero inside the mechanism added to report the first,
  // which is why this write is not exempt from the contract it records. It is
  // keyed on `run_id` and therefore spill-eligible: a lost completion leaves an
  // artifact the next run's drain applies.
  if (cloudRunId) {
    // The tally this payload carries covers the four content writes above. It
    // cannot include this write's OWN outcome — a payload cannot contain the
    // result of writing itself — so a spilled/lost `audit.runComplete` shows up
    // in the returned `writeOutcomes` and in the spill queue, not in the column.
    const completionStats = {
      rounds: round,
      totalFindings: allFindings.length,
      accepted: allFindings.filter(f => f.adjudicationOutcome === 'accepted').length,
      dismissed: allFindings.filter(f => f.adjudicationOutcome === 'dismissed').length,
      fixed: allFindings.filter(f => f.remediationState === 'fixed').length,
      // Genuinely null here: this runs BEFORE Step 7, so no verdict exists yet.
      // `gemini-review.mjs` fills it in afterwards via `recordFinalReviewFindings`
      // — which it only started actually doing on 2026-07-18. This comment used
      // to assert that as fact while no such write existed anywhere.
      geminiVerdict: null,
      // The cost this run actually incurred. `recordRunComplete` has always
      // mapped `stats.costEstimate` → `audit_runs.total_cost_estimate`, and
      // `totalUsage.costUsd` has been a real priced figure since 2026-07-22 —
      // but this payload never carried it, so the column was NULL on every run
      // ever recorded. Measured 2026-08-10: 128 runs over 7 days, 0 costed,
      // while seven cache-telemetry fields below were populated throughout.
      //
      // A column that is always null does not read as "broken"; it reads as
      // free. That is the same anti-green class as a hardcoded 0, and it is
      // why per-run spend could not be answered from the store at all.
      //
      // `?? null` is deliberate: `totalUsage.costUsd` is null for an unpriced
      // model (an Azure deployment id absent from the pricing table — see the
      // costFromUsage note above; the function itself always returns an object),
      // and an honest unknown must stay distinguishable from a measured zero.
      costEstimate: totalUsage.costUsd ?? null,
      durationMs: totalLatency,
      diffLinesChanged,
      diffFilesChanged,
      sessionCacheHit,
      mapReducePasses: mapReducePasses.length > 0 ? mapReducePasses : null,
      // Cache telemetry (migration 20260511120000_audit_runs_cache_metrics)
      cacheInputTokens: cacheMetrics?.totalInputTokens ?? null,
      cacheCachedTokens: cacheMetrics?.totalCachedTokens ?? null,
      cacheHitRate: cacheMetrics?.hitRate ?? null,
      cacheEstimatedSavingsPct: cacheMetrics?.estimatedSavingsPct ?? null,
      cacheSeedEnabled: cacheMetrics?.seedUsed ?? null,
      // Migration 20260808190000 — the control-arm keys. `cacheSeedEnabled`
      // alone cannot distinguish a withheld seed from an impossible one.
      cacheSeedEligible: cacheMetrics?.seedEligible ?? null,
      cacheSeedSkipReason: cacheMetrics?.seedSkipReason ?? null,
      // Decision 3: the outcomes reach the ROW, not just stderr.
      writeOutcomes,
      // A run that could not durably record a write did not complete, whatever
      // its verdict says. Computed here rather than read from `mergedResult`
      // because this write happens BEFORE the tail sets `runStatus` — and the
      // two must agree, which is asserted in the durability test suite.
      // 68583a69: a failed local ledger write is the same failure shape one
      // layer down (see the tail's fuller comment) — folded in here too, or
      // this earlier write and the tail's would disagree on exactly the runs
      // this override exists to catch.
      runStatus: typeof _ledgerWriteError !== 'undefined'
        ? 'incomplete'
        : (writeOutcomes.lost > 0 || writeOutcomes.spilled > 0 ? 'incomplete' : 'complete'),
      // `suppression_stats` has existed since migration 20260417120000 and was
      // written by nothing for four months — 741 rows, 0 populated (measured
      // 2026-08-13). It carries the ruling-set denominator, without which a
      // round that had nothing to suppress WITH is indistinguishable from one
      // that found nothing to suppress. Null on R1: absent ≠ zero.
      suppressionStats: buildSuppressionStats({
        round,
        ledger: ledgerStats,
        suppression: mergedResult._suppression,
      }),
    };
    tallyWriteOutcomes(writeOutcomes, [
      await durableWrite('audit.runComplete', { runId: cloudRunId, stats: completionStats }),
    ]);
    // What the row now holds. Compared at the end of this block so a later
    // durable write cannot leave the persisted tally silently behind the
    // returned one — see `reconcileCompletionRow` below.
    const completionTallySnapshot = JSON.stringify(writeOutcomes);

    // Phase 1 — adaptive-learning-v1.  Backfill the pass_selection decision
    // outcome with kept/dismissed counts and flush all queued telemetry to
    // the cloud (or outbox on failure).  Best-effort.
    try {
      const decisionKey = _learningBuildKey({
        decisionType: 'pass_selection',
        auditRunId: cloudRunId,
        round: round || 1,
        sequence: 0,
      });
      // 4235a115: gated on learningWritesAllowed (previously unconditional).
      // Through the seam. Losing an outcome LABEL silently is not hypothetical
      // here — audit effectiveness went unmeasurable for a stretch precisely
      // because labels stopped arriving and nothing counted their absence.
      // Idempotent UPDATE keyed on `decision_key`, so a replay re-applies the
      // same label rather than appending a second one.
      //
      // This tally lands AFTER `audit.runComplete` was written, so the persisted
      // column would miss it (audit 2026-08-13 H2) — a row reading `complete`
      // over a run that lost a write, which is the exact false zero the
      // durability plan exists to close, reintroduced by routing this write
      // through the seam. `reconcileCompletionRow` below closes it.
      await writeLearningState(learningWritesAllowed, async () => {
        tallyWriteOutcomes(writeOutcomes, [await durableWrite('learning.outcome', {
          decisionKey,
          decision_key: decisionKey,
          outcome: {
            totalFindings: allFindings.length,
            highKept: allFindings.filter(f => f.severity === 'HIGH' && f.adjudicationOutcome !== 'dismissed').length,
            mediumKept: allFindings.filter(f => f.severity === 'MEDIUM' && f.adjudicationOutcome !== 'dismissed').length,
            dismissed: allFindings.filter(f => f.adjudicationOutcome === 'dismissed').length,
            durationMs: totalLatency,
          },
        })]);
      });
      const flushSummary = await _learningFlush({
        store: { insertLearningDecision, backfillLearningOutcome, isCloudEnabled },
      });
      if (flushSummary && (flushSummary.dropped > 0 || flushSummary.outboxed > 0 || flushSummary.lostInCI > 0)) {
        process.stderr.write(
          `  [learning] flush: ${flushSummary.flushed} ok, ${flushSummary.outboxed} outbox, ${flushSummary.dropped} dropped, ${flushSummary.lostInCI} CI-lost\n`
        );
      }
    } catch { /* best-effort telemetry */ }

    // ── reconcileCompletionRow (audit 2026-08-13 H2) ─────────────────────────
    //
    // `audit.runComplete` serialises `writeOutcomes` at ITS call time, but two
    // durable writes land after it (`learning.outcome` above, and anything a
    // future edit adds to this tail). Their outcomes reach the RETURNED result
    // — which the caller and `/audit-code` read — while the persisted
    // `audit_runs.write_outcomes` / `run_status` keep the earlier snapshot. A
    // row reading `complete` over a run that lost a write is the false zero
    // this whole seam exists to prevent, so the two must not be allowed to
    // disagree.
    //
    // Re-writing rather than REORDERING is deliberate: `audit.runComplete` is an
    // idempotent UPDATE keyed on `run_id`, so a second write is safe and cheap,
    // whereas moving the completion write past the telemetry tail would reorder
    // a sequence this change does not own, in a 2,700-line function. Skipped
    // entirely when nothing changed, so the healthy path costs one comparison.
    const finalTally = JSON.stringify(writeOutcomes);
    if (cloudRunId && finalTally !== completionTallySnapshot) {
      tallyWriteOutcomes(writeOutcomes, [
        await durableWrite('audit.runComplete', {
          runId: cloudRunId,
          run_id: cloudRunId,
          stats: {
            ...completionStats,
            writeOutcomes,
            // 68583a69: same ledger-failure override as the other two sites.
            runStatus: typeof _ledgerWriteError !== 'undefined'
              ? 'incomplete'
              : (writeOutcomes.lost > 0 || writeOutcomes.spilled > 0 ? 'incomplete' : 'complete'),
          },
        }),
      ]);
    }
  }

  // P0-B: Session manifest + meta (written by openai-audit.mjs, not audit-loop.mjs)
  // debtRunId is the stable SID for this session (audit-<timestamp>).
  const sid = debtRunId;
  mergedResult._sid = sid;
  // Run-unification (WS1 §1.3b): the run_id this audit used (minted or reused
  // via --run-id) is already persisted on the result as `_cloudRunId` below, so
  // both the orchestrated path (passes --run-id explicitly) and the manual
  // Step 3.5b path (reads `result._cloudRunId`) resolve it without any sidecar
  // file. No implicit file-coupling needed.

  // Increment runsSinceDebtReview in the stable session ledger — gated on
  // learningWritesAllowed (the same "one policy, one place" as every other
  // persist site above): a noCloudRecording (observation-only) run must never
  // touch this file, or a shadow run's presence inflates the real audit's
  // debt-review cadence.
  writeLearningState(learningWritesAllowed, () => {
    try {
      fs.mkdirSync(path.resolve(AUDIT_DIR), { recursive: true });
      const sessionLedgerPath = path.resolve(AUDIT_DIR, SESSION_LEDGER_FILE);
      // The old code read `runsSinceDebtReview` here, BEFORE any lock, then
      // passed `currentRuns + 1` to batchWriteLedger — so two concurrent
      // audit processes could both read the same stale count and one
      // increment would be lost on write. `metaUpdater` runs inside
      // batchWriteLedger's own lock, against the freshly-read value, so the
      // increment is atomic regardless of how many processes race here.
      batchWriteLedger(sessionLedgerPath, [], {
        metaUpdater: (existingMeta) => ({ runsSinceDebtReview: (existingMeta.runsSinceDebtReview ?? 0) + 1 }),
        targetMetaPath: sessionLedgerPath,
      });
    } catch (err) {
      process.stderr.write(`  [session] meta update failed (non-blocking): ${err.message}\n`);
    }
  });

  // Write SID-scoped session manifest so R2 can resolve the ledger path.
  // Same gate: a noCloudRecording run must not persist a manifest another
  // real run's R2 could pick up.
  if (round === 1 && ledgerFile) {
    writeLearningState(learningWritesAllowed, () => {
      try {
        const manifestPath = path.resolve(AUDIT_DIR, `${SESSION_MANIFEST_PREFIX}${sid}.json`);
        const manifest = {
          sid,
          ledgerPath: ledgerFile,
          startedAt: new Date().toISOString(),
          round: 1,
        };
        // Phase 1 (audit-orchestrator-hardening): atomicWriteFileSync — a
        // crash mid-write must never leave R2 reading a torn/partial manifest.
        atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        process.stderr.write(`  [session] manifest written: ${manifestPath}\n`);
      } catch (err) {
        process.stderr.write(`  [session] manifest write failed (non-blocking): ${err.message}\n`);
      }
    });
  }

  // Persist cache metrics to a stable append-only log (.audit/cache-metrics.jsonl)
  // so future analysis (`npm run cache:check`) can correlate hit rates over
  // time without depending on Temp-dir result files (which Windows cleans).
  // Every round emits one line — analysis filters by round >= 2 since cold-start
  // R1 always reports 0%.
  try {
    const cacheMetrics = mergedResult._cacheMetrics;
    if (cacheMetrics) {
      const logPath = path.resolve(AUDIT_DIR, 'cache-metrics.jsonl');
      const entry = {
        sid,
        round,
        startedAt: new Date().toISOString(),
        mode: 'code',                     // runMultiPassCodeAudit is code-mode only
        plan: planFile ? path.basename(planFile) : null,
        seedUsed: cacheMetrics.seedUsed,  // effective cache-seed state (cohort key for cache:check)
        totalInputTokens: cacheMetrics.totalInputTokens,
        totalCachedTokens: cacheMetrics.totalCachedTokens,
        hitRate: cacheMetrics.hitRate,
        estimatedSavingsPct: cacheMetrics.estimatedSavingsPct,
        perPassCount: Object.keys(cacheMetrics.perPass).length,
      };
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
    }
  } catch (err) {
    process.stderr.write(`  [cache] log append failed (non-blocking): ${err.message}\n`);
  }

  // 6. Output — MOVED to the CLI wrapper (openai-audit.mjs main()), which
  // now owns --out write / jsonMode stdout / pretty-print (tiered-recall
  // pipeline Phase 11: "CLI-only concerns... move to the wrapper, operating
  // on the returned AuditRunResult regardless of which branch produced it").
  // See openai-audit.mjs's `printAuditResult()`.

  // Phase 7 readiness nudge (every 10 runs)
  try {
    const outcomes = loadOutcomes('.audit/outcomes.jsonl');
    const runCount = new Set(outcomes.map(o => Math.floor(o.timestamp / 300000))).size;
    if (runCount > 0 && runCount % 10 === 0 && runCount < 50) {
      process.stderr.write(`\n  [phase-7] ${runCount}/50 audit runs completed — ${50 - runCount} more for predictive strategy\n`);
    } else if (runCount >= 50) {
      process.stderr.write(`\n  [phase-7] ✓ ${runCount} runs — Phase 7 (predictive strategy) is ready to implement!\n`);
    }
  } catch { /* ignore */ }

  // Clean up pass result cache on successful completion.
  // On crash, the cache survives in the --out dir for manual recovery.
  cleanupCache();

  // Phase 11: this branch never ran a discovery-portfolio generator, and
  // completed (no required-generator-failure fallback exists here — THIS
  // function IS the fallback target). AuditRunResultSchema requires both
  // fields on every return, per both orchestrators.
  mergedResult.generatorOutcomes = [];

  // Durability plan decision 3 — the outcome contract.
  //
  // `runStatus` is no longer unconditionally 'complete'. A run that produced
  // findings it could NOT durably record is `incomplete`, and saying so is the
  // whole point: the failure this plan exists for is a run that looks healthy
  // and under-reports. `lost` (not `spilled`) is the trigger — a spilled write
  // is queued and a later drain will apply it, whereas a lost one is only
  // evidence in `lost/` and will never reach the store on its own.
  // SPILLED counts too (Cluster B audit M16). The first version triggered on
  // `lost` alone, on the reasoning that a spilled write is recoverable — true,
  // and beside the point: at the moment this row is written the data is NOT in
  // the store, so `complete` is a claim about a state that does not yet exist.
  // A consumer querying that run's findings gets fewer rows than the audit
  // produced while `run_status` says nothing is missing — the believable false
  // zero, one layer up. `write_outcomes` carries which of the two it was, so
  // "will be retried" and "never" stay distinguishable.
  //
  // 68583a69: a failed LOCAL ledger write (`batchWriteLedger`, caught above
  // and stashed as `_ledgerWriteError`) is the same failure shape one layer
  // down — data this run produced that did not durably land — and was
  // previously invisible here: `mergedResult._ledgerWriteError` carried the
  // message, but `runStatus` only ever looked at `writeOutcomes` (the CLOUD
  // durableWrite tally), so a ledger write failure still reported `complete`.
  // Folding it in means an R2+ round that silently lost its suppression state
  // is no longer indistinguishable, from the outside, from one that recorded
  // everything.
  mergedResult.writeOutcomes = writeOutcomes;
  // The ledger-failure override wraps the pinned durability expression rather
  // than editing it in place, on purpose: that inline ternary is pinned
  // byte-identical across every `runStatus`-deriving site by the durability
  // test suite (tests/audit-store-durability-call-site.test.mjs), and a new
  // spelling at only one site is exactly the drift-between-sites class that
  // test exists to catch. Applied at all three sites this expression appears.
  mergedResult.runStatus = typeof _ledgerWriteError !== 'undefined'
    ? 'incomplete'
    : (writeOutcomes.lost > 0 || writeOutcomes.spilled > 0 ? 'incomplete' : 'complete');

  // Say it where a human will see it. A count that only ever reaches a column
  // is better than stderr, but the operator running the audit is the one who
  // can act now, and `spillSummary` is what tells them whether the backlog is
  // growing. Printed only when there is something to say.
  if (writeOutcomes.lost > 0 || writeOutcomes.spilled > 0) {
    const summary = spillSummary();
    const age = summary.oldestAgeMs == null ? 'n/a' : `${Math.round(summary.oldestAgeMs / 60000)}m`;
    process.stderr.write(
      `  [durable-write] ${writeOutcomes.written} written, ${writeOutcomes.spilled} spilled, ${writeOutcomes.lost} lost `
      + `— queue: ${summary.state === 'ok' ? `${summary.spilled} pending (oldest ${age}), ${summary.lost} unreplayable` : summary.reason}\n`,
    );
  }

  return mergedResult;
}

// ── Context builder (tiered-recall pipeline Phase 11, audit-plan fix M1) ──

/**
 * Maps `openai-audit.mjs`'s `main()` already-parsed CLI args into an
 * `AuditRunContext` — the orchestration-relevant subset of
 * `runMultiPassCodeAudit`'s former ~19 loose params (excludes CLI-
 * presentation-only concerns: `jsonMode` stays in the wrapper; the final
 * `--out` write happens in the wrapper too, though `outFile` itself IS
 * carried on `ctx` — see `AuditRunContextSchema`'s docblock for why).
 *
 * Constructs the four `providers` handles ONCE via the existing guarded
 * factories, per the plan's explicit instruction — so no stage module
 * constructs a provider SDK client itself:
 *   - `openai`          — passed through (already constructed by `main()`)
 *   - `anthropicClient`  — `createAnthropicClient()` (used by
 *     `discovery-portfolio.mjs`'s Sonnet cold-pass generator)
 *   - `ossCall`          — a bound `(opts) => ossStructuredCall(client, opts)`
 *     over a `createOpenAIClient({oss:{...}})` client pointed at OpenRouter
 *     (mirrors the existing `audit-shadow.mjs::callModelDefault` pattern)
 *   - `geminiReviewCall` + `geminiCleanRegionCall` — Phase 12's REAL
 *     subprocess adapters (`createGeminiReviewSubprocessAdapters`), wired
 *     2026-07-13 as part of the Close-out shadow-validation flip. TWO
 *     handles, not one: `runFinalAdjudication`'s adapters have different
 *     signatures (`reviewCall(envelope)` vs `cleanRegionCall(file)`), so
 *     the earlier single-handle design could never have served both.
 *     Construction is cheap and spawn-lazy (no subprocess until Stage 2
 *     actually calls one); the adapters resolve `gemini-review.mjs` as a
 *     module-relative sibling, correct in both the source and consumer
 *     (`scripts/.claude-skills/`) layouts.
 *
 * @param {object} cliArgs - the same options object `main()` already builds
 *   for its (pre-Phase-11) `runMultiPassCodeAudit(...)` call.
 * @returns {Promise<import('../schemas.mjs').AuditRunContext>}
 */
export async function buildAuditRunContext(cliArgs) {
  const {
    openai, planContent, projectContext = '', historyContext = '',
    passFilter = null, fileFilter = null, round = 1, ledgerFile = null, diffFile = null,
    changedFiles = [], auditBaseCommit = null, repoProfile = null, bandit = null, fpTracker = null, noLedger = false,
    noTools = false, strictLint = false, noDebtLedger = false, readOnlyDebt = false,
    debtLedgerPath = undefined, debtEventsPath = undefined, escalateRecurring = null,
    sessionCacheHit = null, scopeMode = null, planFile = null, runId = null, allowInfraScope = false,
    outFile = null, model = null, allowTiered = false, __runDuplicationAnalysis = null, __runAdjacencyAnalysis = null,
    // docs/plans/stage0-evidence-relevance-split.md decision #5: the tiered
    // pipeline's Stage 0 blame/impact adapters need the current HEAD sha
    // (import-graph freshness validation) and dirty-tree status (both
    // adapters degrade to their safe 'unknown' default on a dirty tree —
    // a graph/blame check built against a committed HEAD can't see
    // uncommitted changes). Resolved once by openai-audit.mjs's `main()`
    // (the one CLI entrypoint) using the SAME git primitives its own
    // --scope=diff dirty-check already uses, and threaded through
    // unchanged — no new resolution logic here. `runLegacyProductionAudit`
    // never reads either field, so this is purely additive.
    commitSha = null, workingTreeDirty = false,
  } = cliArgs;

  // Only construct the tiered-pipeline-only provider handles when the
  // tiered pipeline can actually RUN — as the gating path (`pipelineEnabled`)
  // OR as the Close-out shadow (`shadowEnabled`, 2026-07-13: the original
  // `pipelineEnabled`-only gate meant a shadow-validation run got
  // `anthropicClient: null, ossCall: null` and failed its discovery portfolio
  // on the first call, deterministically — the entire shadow window would
  // have produced zero comparison data). `runLegacyProductionAudit` never
  // reads these handles, so the default (both flags off) run still pays no
  // construction cost — "every phase remains additive/env-var-gated" holds.
  //
  // AND the call site must assert `allowTiered` (same day, the shadow-flip
  // incident fix): the env flags alone are NOT sufficient — they load from
  // the shared ~/.audit-loop.env in every Node process in every repo,
  // INCLUDING test runs whose harnesses stub only the `openai` argument and
  // cannot stub these independently-constructed handles. With the shadow
  // flag flipped on, fully-mocked unit tests started executing the real
  // tiered pipeline (real GLM/Sonnet calls, real gemini-review subprocess
  // spawns) — the full suite went 54s → 6.5min, observed live. Execution
  // eligibility is a per-CALL property that only the production CLI
  // entrypoint asserts (`main()` passes `allowTiered: true`); programmatic
  // callers (tests, model-eval generation arms) default false and stay
  // hermetic regardless of env.
  let anthropicClient = null;
  // Why the client was (or wasn't) constructed — see the catch below. Absent
  // construction attempt (tiered off) stays `not-attempted`, distinct from a
  // failure: "we never tried" must never render as "it broke".
  let anthropicReadiness = { state: 'not-attempted', message: 'tiered pipeline/shadow disabled' };
  let ossCall = null;
  let geminiReviewCall = null;
  let geminiCleanRegionCall = null;
  if ((tieredAuditConfig.pipelineEnabled || tieredAuditConfig.shadowEnabled) && allowTiered) {
    try {
      // Forced `backend: 'sdk'` — NOT the ambient CLAUDE_BACKEND-resolved
      // default. This handle is used SOLELY for discovery-portfolio.mjs's
      // Sonnet generator, which requires `tool_choice:{type:'tool',…}` to
      // get structured findings back. The `cli` backend's messages.create()
      // silently drops `tools`/`tool_choice` (by design, for its original
      // single-shot-text callers — see anthropic-client.mjs) and returns
      // plain text instead, which the generator's `tool_use` check then
      // fails — a REQUIRED generator failure, so every round fell back to
      // legacy. Root-caused 2026-07-14: with CLAUDE_BACKEND=cli active
      // locally since 2026-06-29, 20/20 Close-out shadow observations across
      // two repos were silent no-op fallbacks, not real comparisons. This
      // handle needs the real Messages API tool-calling surface regardless
      // of what the rest of the process is configured to use.
      anthropicClient = await createAnthropicClient({ backend: 'sdk' });
      anthropicReadiness = { state: 'available' };
    } catch (err) {
      // Construction stays NON-BLOCKING — the legacy audit does not need this
      // client, and hard-failing here would break every keyless legacy run.
      // But `null` alone conflates four different causes: credentials missing,
      // malformed configuration, transport/SDK init failure, and a future
      // regression in construction. The tiered shadow then reported all of
      // them as one generic "providers.anthropicClient unavailable", which is
      // how 51 records from a single keyless session read as intermittent
      // flakiness for two days. Classify instead — a diagnostic that lies is
      // worse than none (see tiered-shadow-summary.mjs's own note).
      anthropicReadiness = classifyProviderReadiness(err);
      process.stderr.write(
        `  [ctx] anthropicClient unavailable [${anthropicReadiness.state}] ` +
        `(non-blocking — only the tiered pipeline's Sonnet generator needs it): ${anthropicReadiness.message}\n`
      );
    }
    try {
      const ossClient = await createOpenRouterClient();
      ossCall = (opts) => ossStructuredCall(ossClient, opts);
    } catch (err) {
      process.stderr.write(`  [ctx] ossCall unavailable (non-blocking — only the tiered pipeline's discovery portfolio needs it): ${err.message}\n`);
    }
    try {
      // Spawn-lazy: construction writes/spawns nothing — the subprocess only
      // runs when Stage 2 actually invokes an adapter.
      const adapters = createGeminiReviewSubprocessAdapters({ repoRoot: process.cwd() });
      geminiReviewCall = adapters.reviewCall;
      geminiCleanRegionCall = adapters.cleanRegionCall;
    } catch (err) {
      process.stderr.write(`  [ctx] gemini adjudication adapters unavailable (non-blocking — the tiered pipeline fails fast with a clear cause if Stage 2 is reached): ${err.message}\n`);
    }
  }

  // Load-bearing for the tiered pipeline's Stage 0 evidence-triage
  // (evidence-triage.mjs `verifyAnchor`: `if (!diffText) return
  // 'unverifiable'`) — found 2026-07-15 after the first real shadow
  // observations landed: `diffText` was read in 3 places across
  // discovery-portfolio.mjs/tiered-pipeline.mjs/evidence-triage.mjs but
  // never ASSIGNED anywhere in the whole codebase, so every single
  // commission-type finding's anchor was unconditionally unverifiable —
  // Stage 0 rejected 100% of candidates on every one of the first 4 real
  // `complete` shadow runs (10-18 raw candidates, 0 verified, every time;
  // not model-recall noise — deterministic). `runLegacyProductionAudit`
  // never needed this (it re-reads `diffFile` itself, independently, for
  // its own line/file-count metadata just above) — this is purely
  // additive for tiered/shadow consumers, changes nothing for the legacy
  // path. Best-effort, NEVER throws: a genuinely broken `--diff` is
  // already validated loudly, with a detailed error, by the legacy path's
  // own read a few hundred lines above — duplicating that failure mode
  // here (which runs for EVERY audit, tiered or not, before either path
  // has started) would turn a currently-recoverable-by-legacy state into
  // a hard crash for runs that never even reach the tiered pipeline.
  let diffText = null;
  if (diffFile) {
    try {
      diffText = fs.readFileSync(diffFile, 'utf-8');
    } catch (err) {
      // Still fail-open — the comment above says why throwing HERE would crash
      // runs that never reach the tiered pipeline — but no longer silent. The
      // "legacy path surfaces it loudly" claim is true TODAY only because the
      // legacy read runs for every audit; when the tiered pipeline runs instead
      // (`AUDIT_TIERED_PIPELINE_ENABLED`), nothing else reads this file and
      // `diffText: null` reaches adjacency-detector / evidence-triage as an
      // ABSENT diff rather than an unreadable one. One line makes those two
      // states distinguishable in the log without changing control flow.
      process.stderr.write(`  [ctx] --diff "${diffFile}" unreadable (${err.code || err.message}) — diffText degraded to null\n`);
    }
  }

  return {
    planContent, projectContext, historyContext,
    passFilter, fileFilter, round, ledgerFile, diffFile, diffText, changedFiles, auditBaseCommit, __runDuplicationAnalysis, __runAdjacencyAnalysis, repoProfile, bandit, fpTracker,
    noLedger, noTools, strictLint, noDebtLedger, readOnlyDebt, debtLedgerPath, debtEventsPath,
    escalateRecurring, scopeMode, planFile, runId, allowInfraScope,
    outFile, model, sessionCacheHit, allowTiered, commitSha, workingTreeDirty,
    generatorOutcomes: [],
    // `anthropicReadiness` travels WITH the client so a downstream consumer can
    // tell a routine keyless skip from a real construction defect, instead of
    // inferring one meaning from `anthropicClient === null` (WS-B2).
    providers: { openai, anthropicClient, anthropicReadiness, ossCall, geminiReviewCall, geminiCleanRegionCall },
  };
}

// Test-export gate — mirrors openai-audit.mjs's `__testExports` /
// `AUDIT_EXPORTS_FOR_TESTS` pattern (audit-orchestrator-hardening plan).
// Exposes internals this file doesn't otherwise export, for Tier-1
// deterministic unit tests. Production runs never set the env var, so this
// export is `undefined` and the test scaffolding is dead code at runtime.
export const __testExports = process.env.AUDIT_EXPORTS_FOR_TESTS === '1'
  ? {
      validateLedgerForR2, deriveFindingsFromReport, runMapReducePass, collectReducePassStatuses,
      initResultCache, cachePassResult,
      writeLearningState, cleanupCache, classifyShadowFailureSafe, runOrphanIntroducedPass, dedupReplacementId,
      // Pure, and the ONE place the orphan wave's range policy lives — the
      // clean-tree arm is a regression guard, not a symmetry (see its docblock).
      resolveOrphanScopeRefs,
      // Now the single definition of --files scope for all six quality passes,
      // so its semantics are worth pinning directly rather than inferring from
      // six call sites.
      scopeToFileFilter,
      // buildSuppressionStats: pure, and every honesty rule in the
      // suppression_stats shape (R1 → null, unavailable ≠ zeroed, counts not
      // arrays) is invisible from the store side. Tier-1 unit.
      buildSuppressionStats,
      // decideSeed: its eligibility-before-env-flag ordering is what gives the
      // cache-seed A/B a control arm, and that ordering is invisible from the
      // outside — an opted-out run looks the same either way until you read
      // `seedEligible`. Pure and deterministic, so it is a Tier-1 unit.
      decideSeed,
    }
  : undefined;
