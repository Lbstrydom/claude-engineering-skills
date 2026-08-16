#!/usr/bin/env node
/**
 * @fileoverview Thin CLI for the auditor-role path of the model swap-in
 * evaluation harness. Screening tier (oracle mode, Tier C, always
 * available, deterministic) grades a candidate's structured
 * defect-localization extraction against a seeded stratified subset of
 * `known-defects.json`. Promotion tier (comparative mode) drives the full
 * production 5-pass generation for candidate + baseline
 * (`arm-generation.mjs::runAuditGenerationArm`) over a larger KD subset,
 * then grades Tier A/B via `blind-judge.mjs` (when `--judge` is supplied
 * and lineage independence holds) or Tier C via the same structured-
 * extraction path screening uses.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 3.
 *
 * @module scripts/model-eval-auditor
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { refreshModelCatalog } from './lib/model-resolver.mjs';
import { mulberry32 } from './lib/rng.mjs';
import {
  resolveCandidateRoute, resolveEvaluationTier, buildComparisonEvidenceFromRoutes,
  _internals as routeCatalogInternals,
} from './lib/model-eval/route-catalog.mjs';
import { extractStructured } from './lib/model-eval/structured-extractor.mjs';
import { scoreDefectLocalization } from './lib/model-eval/deterministic-scorer.mjs';
import { computeVerdict } from './lib/model-eval/verdict.mjs';
import { loadCorpusCase, CorpusCaseUnavailable, CORPUS_LOADER_VERSION } from './lib/model-eval/known-defect-corpus.mjs';
import { EgressGateError } from './lib/model-eval/egress-path-scan.mjs';
import { runAuditGenerationArm } from './lib/model-eval/arm-generation.mjs';
import { runBlindJudgeProtocol } from './lib/model-eval/blind-judge.mjs';
import { assembleCostRows, buildUsageEvent } from './lib/model-eval/cost.mjs';
import { CANONICAL_ARMS, buildCandidateArm } from './lib/audit-arms.mjs';
import { parseThresholdConfig } from './lib/model-eval/config/schema.mjs';
import {
  createEvalRun, updateEvalRunTerminal, EvalRunAlreadyActiveError,
  upsertComparison, maxComparisonArmAttempt,
} from './lib/store/model-eval.mjs';
import { resolveRepoIdentity } from './lib/repo-identity.mjs';
import { writeOutput } from './lib/file-io.mjs';
import { argOption } from './lib/cli-io.mjs';
import { RunPreflightError, parseJsonArg } from './lib/model-eval/cli-shared.mjs';
// D3a — the declarative arm manifest. `isScoredArm`/`ArmSchema` decide WHICH
// arms this driver spawns (control/replicate are collected elsewhere, never
// scored here — auditor manifests don't run a passive collector at all, so a
// control/replicate arm declared on one is inert by construction, but the
// filter stays for a single shared meaning of "scored" across every role).
import { parseComparisonManifest, resolveManifestPaths } from './lib/comparison/manifest.mjs';
import { isScoredArm } from './lib/comparison/arms.mjs';
import { configDigest as manifestConfigDigest, LOCK_SCHEMA_VERSION } from './lib/comparison/lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_PATH = path.join('docs', 'experiments', 'audit-effectiveness', 'known-defects.json');
const DEFAULT_THRESHOLDS_PATH = path.join(__dirname, 'lib', 'model-eval', 'config', 'auditor-thresholds.json');
const BASELINE_ARM = CANONICAL_ARMS.find((a) => a.id === 'A'); // production GPT audit — the real baseline

// ── Deterministic stratified KD selection ──────────────────────────────────
// Round-2 audit M2: the same corpusVersion+role+tier always yields the same
// subset. mulberry32 now lives in scripts/lib/rng.mjs (shared-lib,
// arch-drift-duplication-cleanup plan) — this file already imports heavily
// from scripts/lib/* (model-resolver, model-eval/*, audit-arms), so the
// original "no runtime dependency" rationale for a local copy didn't
// actually hold; deduplicated instead of pragma'd.
function seedFromString(s) {
  return crypto.createHash('sha256').update(s).digest().readUInt32BE(0);
}

/**
 * Stratifies `defects` by severity, then round-robins across severity
 * groups (each group internally seed-shuffled) until `n` are picked —
 * spreads the sample across severities rather than exhausting the largest
 * group first. Exported for direct testing.
 * @param {Array<object>} defects
 * @param {{seed: number, n: number}} args
 */
export function stratifiedSelectKDs(defects, { seed, n }) {
  const rng = mulberry32(seed);
  const bySeverity = new Map();
  for (const d of defects) {
    const key = d.severity || 'UNKNOWN';
    if (!bySeverity.has(key)) bySeverity.set(key, []);
    bySeverity.get(key).push(d);
  }
  // Deterministic group order (sorted keys), each group seed-shuffled.
  const groups = [...bySeverity.keys()].sort().map((k) => {
    const arr = [...bySeverity.get(k)];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  });
  const selected = [];
  let round = 0;
  while (selected.length < n && groups.some((g) => g.length > round)) {
    for (const g of groups) {
      if (selected.length >= n) break;
      if (g[round]) selected.push(g[round]);
    }
    round++;
  }
  return selected;
}

// ── Tier-C scoring (shared by screen-tier's single-arm oracle path AND
// promotion-tier's dual-arm comparative path — the mechanism is identical,
// only the caller decides how many times to run it). ────────────────────

async function scoreArmTierC({ route, cases, role = 'auditor' }) {
  const candidateOutputs = [];
  const expectedRubrics = [];
  for (const { visibleInput, hiddenGroundTruth } of cases) {
    const { data } = await extractStructured({
      role, route, rawContext: { evidenceHunk: visibleInput.diff, filePaths: visibleInput.files },
    });
    candidateOutputs.push({ file: data.defectLocation.file, description: data.defectLocation.description });
    expectedRubrics.push({ files: hiddenGroundTruth.files, expectedFindingRubric: hiddenGroundTruth.expectedFindingRubric });
  }
  const scored = scoreDefectLocalization(candidateOutputs, expectedRubrics);
  return { metrics: { recall: scored.recall, falsePositiveRate: scored.falsePositiveRate, f1: scored.f1 }, raw: scored };
}

// ── Screening tier (oracle mode, Tier C) ────────────────────────────────

async function runScreenTier({ candidateRoute, cases, corpusVersion, selectedKdIds, thresholds }) {
  const { metrics } = await scoreArmTierC({ route: candidateRoute, cases });
  const routeEvidence = routeCatalogInternals.toRouteEvidence(candidateRoute);
  const { verdict, nextAction, reasons } = computeVerdict({
    mode: 'oracle', role: 'auditor', tier: 'screen', routeEvidence,
    candidateMetrics: metrics, sampleSize: cases.length, minSampleSize: thresholds.screen.minSampleSize,
    corpusVersion, thresholds: thresholds.screen.thresholds,
  });
  return {
    verdict, nextAction, metrics,
    evidence: { mode: 'oracle', selectedKdIds, corpusVersion, corpusLoaderVersion: CORPUS_LOADER_VERSION, routeEvidence, reasons },
    cost: null,
  };
}

// ── Promotion tier (comparative mode) ───────────────────────────────────

async function runPromotionTier({
  runId, repoId, candidateRoute, baselineRoute, judgeRoute, cases, corpusVersion, selectedKdIds, thresholds, repoRoots,
}) {
  const { computedJudgeTier } = resolveEvaluationTier({ mode: 'comparative', candidateRoute, baselineRoute, judgeRoute });
  const usageEvents = [];
  let candidateMetrics, baselineMetrics;

  if (computedJudgeTier === 'A' || computedJudgeTier === 'B') {
    // Generate candidate + baseline findings for every KD case, then blind-judge each.
    //
    // Round-1 audit H4/H8 fix — SERIALIZED, never Promise.all: runAuditGenerationArm
    // does process.chdir(auditInput.repoRoot) around its runMultiPassCodeAudit call
    // (necessary — that pipeline's file reads resolve against process.cwd()), and
    // chdir is GLOBAL PROCESS STATE. Running candidate+baseline concurrently would
    // let one call's chdir clobber the other's expected cwd mid-flight — a real race,
    // not a hypothetical one. runMultiPassCodeAudit itself has no repoRoot override
    // parameter (verified directly), so serializing here is the correct, minimal fix
    // rather than a larger, riskier refactor of the frozen production pipeline.
    const candidateArm = buildCandidateArm(candidateRoute, { id: 'CAND' });
    let candidateCaught = 0, baselineCaught = 0;
    let candidateFindingsTotal = 0, candidateFalseCount = 0, baselineFindingsTotal = 0, baselineFalseCount = 0;
    for (const kdCase of cases) {
      const auditInput = { diff: kdCase.visibleInput.diff, files: kdCase.visibleInput.files, repoRoot: kdCase.repoRoot };
      const candGen = await runAuditGenerationArm({ arm: candidateArm, auditInput, route: candidateRoute, runId, role: 'auditor' });
      const baseGen = await runAuditGenerationArm({ arm: BASELINE_ARM, auditInput, route: baselineRoute, runId, role: 'auditor' });
      usageEvents.push(candGen.usageEvent, baseGen.usageEvent);

      const kdId = kdCase.hiddenGroundTruth.kdId;
      // Round-1 audit H5/H9 fix — repoId (not null) so appendJudgeBatch's
      // NOT NULL repo_id column write succeeds; commitSha set to the KD's OWN
      // id (not null) so the resume/dedup key is meaningful PER CASE within
      // this run — commit_sha is a free-form text column (not FK'd to a real
      // git sha), and using null for every case collapses the resume check
      // (`commitSha ? ... : null`) to always-false, silently defeating the
      // resume mechanism blind-judge.mjs documents.
      const judgeResult = await runBlindJudgeProtocol({
        runId, repoId, role: 'auditor', unit: 'findings-vs-diff',
        candidateFindings: candGen.findings, baselineFindings: baseGen.findings,
        // kdId prefixed so the judge's `matches` field (JUDGE_SYSTEM: "a KD-NNN
        // id... ONLY if... the finding actually describes that KD's defect")
        // has a concrete id to reference for THIS case.
        knownDefectsRubric: `${kdId}: ${kdCase.hiddenGroundTruth.expectedFindingRubric}`,
        commitSha: kdId, diff: kdCase.visibleInput.diff,
        candidateRoute, baselineRoute, judgeRoute,
      });
      if (judgeResult.usage) {
        usageEvents.push(buildUsageEvent({
          runId, role: 'auditor', phase: 'judge', armId: null, candidateRef: judgeRoute.deploymentId ?? judgeRoute.resolvedModel,
          resolvedModel: judgeRoute.resolvedModel, pricingModel: judgeRoute.pricingModel, deploymentId: judgeRoute.deploymentId,
          provider: judgeRoute.provider, usage: judgeResult.usage, capturedAt: new Date().toISOString(),
        }));
      }

      // Round-1 audit H6 fix — "recall" must be PER-KNOWN-DEFECT (did the
      // candidate catch THIS case's defect, one boolean per case), not a raw
      // finding-count ratio (candidateTP/candidateTotal was precision-shaped:
      // it measured "of the findings this arm happened to generate, how many
      // were accepted," which inflates when an arm generates FEWER findings —
      // exactly backwards for a recall metric). A case is "caught" iff any
      // finding in that bucket was graded proven/actionable AND matched to
      // THIS kd via the judge's `matches` field.
      const caughtBy = (bucket) => judgeResult.gradings.some((g) => g.bucket === bucket && g.matches === kdId && (g.label === 'proven' || g.label === 'actionable'));
      if (caughtBy('candidate')) candidateCaught++;
      if (caughtBy('baseline')) baselineCaught++;
      for (const g of judgeResult.gradings) {
        const isFalse = g.label === 'false' || g.label === 'plausible';
        if (g.bucket === 'candidate') { candidateFindingsTotal++; if (isFalse) candidateFalseCount++; }
        else if (g.bucket === 'baseline') { baselineFindingsTotal++; if (isFalse) baselineFalseCount++; }
      }
    }
    // recall = fraction of KD cases caught (the correct denominator — known
    // defects, not generated findings). falsePositiveRate = noise rate among
    // this arm's OWN generated findings (mirrors solo-control/scoring.mjs's
    // own established falseRate convention) — computed as a real number, not
    // left null: auditor-thresholds.json's promotion.thresholds.comparative
    // DOES declare maxFalsePositiveRatioVsBaseline, and computeVerdict's
    // requiredMetric() throws on a null value a threshold actually
    // references — f1 stays null since no configured threshold reads it.
    candidateMetrics = {
      recall: cases.length > 0 ? candidateCaught / cases.length : null,
      falsePositiveRate: candidateFindingsTotal > 0 ? candidateFalseCount / candidateFindingsTotal : 0,
      f1: null,
    };
    baselineMetrics = {
      recall: cases.length > 0 ? baselineCaught / cases.length : null,
      falsePositiveRate: baselineFindingsTotal > 0 ? baselineFalseCount / baselineFindingsTotal : 0,
      f1: null,
    };
  } else {
    // Tier C — same structured-extraction mechanism as screening, run twice.
    // Serialized to match the Tier A/B path above (Round-1 H4/H8) — neither
    // scoreArmTierC call chdirs, but keeping both branches' concurrency
    // model consistent avoids re-introducing the same class of bug if a
    // future edit adds a chdir-dependent step to either path.
    const candScore = await scoreArmTierC({ route: candidateRoute, cases });
    const baseScore = await scoreArmTierC({ route: baselineRoute, cases });
    candidateMetrics = candScore.metrics;
    baselineMetrics = baseScore.metrics;
  }

  const costRows = usageEvents.length > 0 ? assembleCostRows(usageEvents) : [];
  const candidateCostRow = costRows.find((r) => r.candidateRef === (candidateRoute.deploymentId ?? candidateRoute.resolvedModel));
  const baselineCostRow = costRows.find((r) => r.candidateRef === (baselineRoute.deploymentId ?? baselineRoute.resolvedModel));
  const costDelta = (candidateCostRow || baselineCostRow) ? {
    candidateCostUsd: candidateCostRow?.totalUsd ?? null,
    baselineCostUsd: baselineCostRow?.totalUsd ?? null,
  } : null;

  const comparisonEvidence = buildComparisonEvidenceFromRoutes({ candidateRoute, baselineRoute, judgeRoute });
  const { verdict, nextAction, reasons } = computeVerdict({
    mode: 'comparative', role: 'auditor', tier: 'promotion', comparisonEvidence,
    candidateMetrics, baselineMetrics, sampleSize: cases.length, minSampleSize: thresholds.promotion.minSampleSize,
    costDelta, thresholds: thresholds.promotion.thresholds,
  });

  return {
    verdict, nextAction, metrics: candidateMetrics,
    evidence: {
      mode: 'comparative', selectedKdIds, corpusVersion, corpusLoaderVersion: CORPUS_LOADER_VERSION,
      computedJudgeTier, baselineMetrics, reasons,
      candidateRef: candidateRoute.deploymentId ?? candidateRoute.resolvedModel,
      baselineRef: baselineRoute.deploymentId ?? baselineRoute.resolvedModel,
      judgeRef: judgeRoute ? (judgeRoute.deploymentId ?? judgeRoute.resolvedModel) : null,
    },
    cost: costDelta ? { totalUsd: (costDelta.candidateCostUsd ?? 0) + (costDelta.baselineCostUsd ?? 0), byRow: costRows } : null,
  };
}

// ── D3a — declarative arm manifest driver ───────────────────────────────────

/**
 * Resolve a declarative arm manifest and invoke the SAME single-candidate
 * execution path once per scored arm, each with a real `--candidate`
 * (REQ-safety-f0ef6d7d). Spawned as a CHILD PROCESS per arm, not called
 * in-process: that keeps the invariant literally true at the process
 * boundary — a script inspecting its own argv sees `--candidate` present on
 * every execution, manifest-driven or not — and means this driver never has
 * to re-implement anything the single-candidate path already does correctly
 * (route resolution, corpus loading, egress gating, terminal-status writes).
 *
 * **Sequential, never parallel.** This harness is "bounded and synchronous by
 * construction" by design (AGENTS.md, 2026-07-26) — running arms concurrently
 * would send concurrent provider calls this repo has never needed to
 * rate-limit for, and would race each arm's own createEvalRun/updateEvalRunTerminal
 * pair for no benefit; each attempt is paid, so there is nothing to gain from
 * haste.
 *
 * **Per-arm failure is terminal for that arm only** — its child process exits
 * non-zero, siblings still run, and the aggregate `--out` records it rather
 * than crashing the driver. A PREFLIGHT failure in the child (bad candidate
 * JSON, corpus too small) writes no store row at all, same as it always has
 * for a plain --candidate invocation; a provider/execution failure DOES
 * reach a terminal status via the child's own updateEvalRunTerminal call.
 * Either way the failure is visible in this function's own printed summary
 * and `--out` JSON, which is the only place a preflight-stage failure is
 * recorded at all.
 *
 * @param {{manifestPath: string, tier: string, corpusFlagPath: string|null,
 *   thresholdsPath: string, outFile: string|null, repoRoots: string[]}} args
 */
async function runManifestDriver({ manifestPath, tier, corpusFlagPath, thresholdsPath, outFile, repoRoots }) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new RunPreflightError('bad_manifest', `--manifest: could not read/parse "${manifestPath}": ${err.message}`);
  }

  let manifest;
  try {
    ({ manifest } = parseComparisonManifest(raw));
  } catch (err) {
    throw new RunPreflightError('bad_manifest', `--manifest: ${err.message}`);
  }
  if (manifest.role !== 'auditor') {
    throw new RunPreflightError('bad_manifest', `--manifest: role must be "auditor" for model-eval-auditor.mjs, got "${manifest.role}"`);
  }

  // Refused at LOAD, before any provider call (INC-001's lesson) — a typo'd
  // or sensitive subject path costs nothing.
  const repoRoot = repoRoots[0] ?? process.cwd();
  let resolvedPaths;
  try {
    resolvedPaths = resolveManifestPaths(manifest, { repoRoot });
  } catch (err) {
    throw new RunPreflightError('manifest_path_refused', `--manifest: ${err.message}`);
  }

  // Precedence: an explicit --corpus on THIS invocation is the operator's own
  // instruction and wins over everything; the manifest's declared subject
  // comes next; the CLI's hardcoded default is the last resort.
  const effectiveCorpusPath = corpusFlagPath ?? resolvedPaths.corpusPath?.abs ?? DEFAULT_CORPUS_PATH;

  const digest = manifestConfigDigest(manifest);
  const repoIdentity = resolveRepoIdentity();
  const ensured = await upsertComparison({
    repoId: repoIdentity.repoUuid, comparisonKey: manifest.id, configDigest: digest,
    lockSchemaVersion: LOCK_SCHEMA_VERSION, role: 'auditor', subjectRef: manifest.subject ?? null,
  });
  if (!ensured.ok) {
    throw new RunPreflightError('comparison_persist_failed', `--manifest: could not persist comparison "${manifest.id}": ${ensured.error}`);
  }
  // null only when cloud is off — every arm still runs; the cohort is simply
  // unlinked, same graceful-degradation posture as the rest of this harness.
  const comparisonId = ensured.id;

  const scoredArms = manifest.arms.filter(isScoredArm);
  const unscoredArms = manifest.arms.filter((a) => !isScoredArm(a));
  // D3a's design text says control/replicate arms are "collected and never
  // scored" — this driver does not yet collect them at all: `model_eval_runs`
  // has no column distinguishing "ran, but excluded from the decision" from
  // "never ran", so executing them today would produce a scored-shaped row
  // with no honest way to mark it unscored. Filtering them out entirely is
  // the smaller, correct-for-now gap (a declared arm the manifest still
  // validates, just never spawned) rather than a silent one — at minimum this
  // says so, out loud, so a manifest author sees their declaration had no
  // effect instead of discovering it by absence.
  if (unscoredArms.length > 0) {
    process.stderr.write(`  [model-eval-auditor] manifest: ${unscoredArms.length} control/replicate arm(s) declared but NOT executed `
      + `(${unscoredArms.map((a) => a.id).join(', ')}) — this driver does not yet collect unscored arms, only score them\n`);
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const results = [];

  for (const arm of scoredArms) {
    // Resume (D5a's reducer, applied to the auditor role): an arm with a live
    // success is never re-run — re-invoking the driver resumes the cohort by
    // running only the arms without one.
    let nextAttempt = 1;
    let supersede = false;
    if (comparisonId) {
      const existing = await maxComparisonArmAttempt({ comparisonId, armId: arm.id });
      if (existing.hasLiveSuccess) {
        process.stderr.write(`  [model-eval-auditor] manifest: arm "${arm.id}" already has a live success — skipping (resume)\n`);
        results.push({ armId: arm.id, skipped: true, ok: true, attempt: existing.attempt });
        continue;
      }
      nextAttempt = existing.attempt + 1;
      supersede = existing.attempt > 0;
    }

    const armOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-arm-'));
    const armOutFile = path.join(armOutDir, 'result.json');
    // A bare model name/sentinel is the only thing an arm declares — the
    // general mapping onto CandidateSpecSchema's discriminated union.
    const candidateSpec = { kind: 'sentinel', value: arm.model };
    const args = [
      scriptPath, '--candidate', JSON.stringify(candidateSpec), '--tier', tier,
      '--thresholds', thresholdsPath, '--corpus', effectiveCorpusPath, '--out', armOutFile,
    ];
    if (repoRoots.length > 1) args.push('--repo-roots', repoRoots.slice(1).join(','));
    if (comparisonId) args.push('--comparison-id', comparisonId, '--arm-id', arm.id, '--attempt', String(nextAttempt));
    if (supersede) args.push('--supersede-prior');

    process.stderr.write(`  [model-eval-auditor] manifest: running arm "${arm.id}" (model ${arm.model})…\n`);
    // node itself, not a shim — no CVE-2024-27980 exposure, the same
    // reasoning every other spawn site in this repo already documents.
    const spawned = spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    let armResult = null;
    try { armResult = JSON.parse(fs.readFileSync(armOutFile, 'utf8')); } catch { /* the arm may have failed before writing --out */ }
    const ok = spawned.status === 0;
    if (!ok) {
      process.stderr.write(`  [model-eval-auditor] manifest: arm "${arm.id}" FAILED (exit ${spawned.status}) — comparison continues with remaining arm(s)\n`);
      if (spawned.stderr) process.stderr.write(`${spawned.stderr}\n`);
    }
    results.push({ armId: arm.id, ok, exitCode: spawned.status, attempt: nextAttempt, result: armResult });
  }

  const failedArms = results.filter((r) => !r.ok && !r.skipped).map((r) => r.armId);
  const summaryLine = `[model-eval-auditor] manifest=${manifest.id} comparisonId=${comparisonId ?? '(cloud off)'} arms=${scoredArms.length} failed=${failedArms.length}`;
  writeOutput({ manifestId: manifest.id, comparisonId, tier, corpusPath: effectiveCorpusPath, arms: results }, outFile, summaryLine);
  if (failedArms.length > 0) {
    process.stderr.write(`  [model-eval-auditor] manifest: arm(s) failed: ${failedArms.join(', ')} — INCONCLUSIVE for those; siblings recorded normally\n`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Literal `--selfcheck-relocation` string handler — the repo's own
  // relocation-guard test greps for this exact substring (tests/relocation-
  // guard.test.mjs), so this must NOT be routed through the hasFlag()
  // helper (which builds the flag name dynamically and would defeat the
  // static string-presence check).
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const candidateRaw = argOption('candidate');
  const manifestPath = argOption('manifest');
  const tier = argOption('tier');
  const judgeRaw = argOption('judge');
  const corpusPath = argOption('corpus', DEFAULT_CORPUS_PATH);
  const thresholdsPath = argOption('thresholds', DEFAULT_THRESHOLDS_PATH);
  const outFile = argOption('out');
  const extraRepoRoots = (argOption('repo-roots', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const repoRoots = [process.cwd(), ...extraRepoRoots];
  // D3a cohort passthrough (R1/H2) — set ONLY on a child process the
  // --manifest driver spawns for one scored arm, never on an operator's own
  // --candidate invocation. Threaded straight into createEvalRun below so a
  // manifest-driven run and a plain single-candidate run persist through the
  // SAME code path — the manifest is a declaration layer above execution,
  // never a second execution mechanism (REQ-safety-f0ef6d7d).
  const comparisonId = argOption('comparison-id');
  const armId = argOption('arm-id');
  const attemptRaw = argOption('attempt');
  const supersedePrior = process.argv.includes('--supersede-prior');

  // R3/H1 — --manifest is a DRIVER, not an alternative input. Exclusive-or
  // with --candidate would violate REQ-safety-f0ef6d7d (this CLI must refuse
  // to execute unless --candidate is supplied with a valid --tier); instead
  // --manifest expands into repeated single-candidate invocations, each with
  // a real --candidate. The two flags together are simply ambiguous about
  // which arm set was intended — refused before any provider call, and
  // before the try/catch below so this check can never be shadowed by that
  // block's error handling.
  if (candidateRaw && manifestPath) {
    console.error('[model-eval-auditor] --candidate and --manifest are mutually exclusive — --manifest already supplies --candidate once per scored arm');
    process.exit(2);
  }
  if (!candidateRaw && !manifestPath) {
    console.error('Usage: model-eval-auditor.mjs --candidate <CandidateSpec-json> --tier screen|promotion [--judge <CandidateSpec-json>] [--out <file>]\n   or: model-eval-auditor.mjs --manifest <path> --tier screen|promotion');
    process.exit(1);
  }
  if (tier !== 'screen' && tier !== 'promotion') { console.error(`--tier must be "screen" or "promotion", got "${tier}"`); process.exit(1); }

  // Round-15 empirical-verify fix — without this, a sentinel candidateSpec
  // (e.g. {kind:'sentinel', value:'latest-gpt'}) always resolved from the
  // stale STATIC_POOL (an empty CATALOG_CACHE in this process), silently
  // testing an old model release regardless of what's actually current.
  // Mirrors openai-audit.mjs / gemini-review.mjs's own startup call.
  try { await refreshModelCatalog(); } catch { /* silent — falls back to static */ }

  // ONE try/catch for both dispatch branches (manifest driver, single
  // candidate) — so a RunPreflightError raised while resolving/persisting the
  // manifest (bad role, refused subject path, comparison-persist failure)
  // reaches the SAME exit-2 handling as a single-candidate preflight failure,
  // rather than escaping uncaught because it was raised from a differently-
  // scoped try block.
  try {
    if (manifestPath) {
      await runManifestDriver({ manifestPath, tier, corpusFlagPath: argOption('corpus'), thresholdsPath, outFile, repoRoots });
      return;
    }
    const candidateSpec = parseJsonArg(candidateRaw, '--candidate');
    const candidateRoute = resolveCandidateRoute({ role: 'auditor', candidateSpec });
    if (candidateRoute.transport !== 'openai-compatible') {
      throw new RunPreflightError('unsupported_transport', `candidate route transport "${candidateRoute.transport}" is unsupported for the auditor role — requires openai-compatible`);
    }

    const rawThresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));
    const thresholdsResult = parseThresholdConfig(rawThresholds);
    if (!thresholdsResult.ok) throw new RunPreflightError('invalid_threshold_config', `threshold config invalid: ${thresholdsResult.error}`);
    const thresholds = thresholdsResult.config;
    if (thresholds.role !== 'auditor') throw new RunPreflightError('invalid_threshold_config', `threshold config role must be "auditor", got "${thresholds.role}"`);

    const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    const corpusVersion = String(corpus.version);
    const minSampleSize = tier === 'screen' ? thresholds.screen.minSampleSize : thresholds.promotion.minSampleSize;
    const seed = seedFromString(`${corpusVersion}:auditor:${tier}`);
    const selectedKds = stratifiedSelectKDs(corpus.defects, { seed, n: minSampleSize });
    if (selectedKds.length < minSampleSize) {
      throw new RunPreflightError('corpus_too_small', `known-defects.json has only ${selectedKds.length} usable entries; ${tier} tier needs minSampleSize=${minSampleSize}`);
    }

    const cases = [];
    const unavailable = [];
    for (const kd of selectedKds) {
      try {
        const { visibleInput, hiddenGroundTruth } = loadCorpusCase({ kdEntry: kd, repoRoots });
        const root = repoRoots.find((r) => fs.existsSync(r) && path.basename(r) === kd.repo);
        cases.push({ visibleInput, hiddenGroundTruth, repoRoot: root });
      } catch (err) {
        if (err instanceof CorpusCaseUnavailable) unavailable.push({ kdId: kd.id, reason: err.reason, message: err.message });
        // An egress-gate refusal (sensitive path mention / secret pattern in
        // the KD's own diff) is a PERMANENT corpus-entry property, not a
        // transient fault — classify it as a preflight unavailability (clean
        // exit 2 naming the entry) instead of letting it escape as a fatal
        // crash (exit 1, stack trace). The gate itself still refused; this
        // only fixes how the refusal is reported. Dead entries should then
        // be removed from known-defects.json so the sampler can't redraw them.
        else if (err instanceof EgressGateError) unavailable.push({ kdId: kd.id, reason: 'egress_blocked', message: err.message });
        else throw err;
      }
    }
    // Never silently shrink the sample below what the seeded selector chose —
    // reproducibility (round-2 audit M2) means the SAME subset every time,
    // not "whatever happened to resolve this run."
    if (unavailable.length > 0) {
      throw new RunPreflightError('corpus_case_unavailable', `${unavailable.length}/${selectedKds.length} selected KD case(s) unavailable: ${unavailable.map((u) => `${u.kdId} (${u.reason})`).join(', ')}`);
    }

    const repoIdentity = resolveRepoIdentity();
    const runBundle = {
      repoId: repoIdentity.repoUuid, role: 'auditor', tier,
      candidateRef: { candidateSpec: candidateRoute.candidateSpec, resolvedModel: candidateRoute.resolvedModel, deploymentId: candidateRoute.deploymentId },
      status: 'running',
      // D3a cohort fields — set ONLY when this process was spawned by the
      // --manifest driver for one scored arm; every field is undefined (and
      // therefore omitted) on a plain --candidate invocation, which is what
      // keeps that path's persisted rows byte-identical to before D3a.
      ...(comparisonId ? {
        comparisonId, armId,
        attempt: attemptRaw != null ? Number(attemptRaw) : 1,
        supersedePrior,
      } : {}),
    };
    const created = await createEvalRun(runBundle);
    const runId = created.runId || `local-${Date.now()}`;

    let result;
    if (tier === 'screen') {
      result = await runScreenTier({ candidateRoute, cases, corpusVersion, selectedKdIds: selectedKds.map((k) => k.id), thresholds });
    } else {
      const baselineRoute = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: BASELINE_ARM.generation.modelSentinel } });
      const judgeRoute = judgeRaw ? resolveCandidateRoute({ role: 'auditor', candidateSpec: parseJsonArg(judgeRaw, '--judge') }) : null;
      result = await runPromotionTier({ runId, repoId: repoIdentity.repoUuid, candidateRoute, baselineRoute, judgeRoute, cases, corpusVersion, selectedKdIds: selectedKds.map((k) => k.id), thresholds, repoRoots });
    }

    if (created.runId) {
      await updateEvalRunTerminal({
        repoId: repoIdentity.repoUuid, runId: created.runId, expectedStatus: 'running',
        terminalBundle: { status: 'completed', verdict: result.verdict, nextAction: result.nextAction, metrics: result.metrics, cost: result.cost, evidence: result.evidence },
      });
    }

    const summaryLine = `[model-eval-auditor] tier=${tier} verdict=${result.verdict} nextAction=${result.nextAction} runId=${runId}`;
    writeOutput({ runId, tier, ...result }, outFile, summaryLine);
  } catch (err) {
    if (err instanceof EvalRunAlreadyActiveError) {
      console.error(`[model-eval-auditor] ${err.message}`);
      process.exit(3);
    }
    if (err instanceof RunPreflightError) {
      console.error(`[model-eval-auditor] preflight failed (${err.reason}): ${err.message}`);
      process.exit(2);
    }
    console.error(`[model-eval-auditor] fatal: ${err.stack || err.message}`);
    process.exit(1);
  }
}

// CLI entry — only fire main() when this module is executed directly, not
// when imported by tests (mirrors openai-audit.mjs's own pattern — pathToFileURL
// for cross-platform robustness, notably Windows drive-letter paths).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
