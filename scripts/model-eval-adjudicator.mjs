#!/usr/bin/env node
/**
 * @fileoverview Thin CLI for the adjudicator-role path of the model swap-in
 * evaluation harness. Tier C (always available): runs the candidate as a
 * structured T/F extractor over `getAdjudicatorGroundTruth()`'s labeled
 * rows, scored via `deterministic-scorer.mjs::scoreBinaryClassification`.
 *
 * Promotion tier is two-stage, matching the DECISION_TABLE's own
 * `{mode:'oracle', tier:'promotion', role:'adjudicator'}` `eligible_for_shadow`
 * nextAction (verdict.mjs, Phase 1) — but corrected to `mode:'comparative'`
 * throughout (verified directly: `adjudicator-thresholds.json`'s promotion
 * tier declares ONLY a `comparative` thresholds sub-key, never `oracle`):
 *   1. No active live-shadow run: runs a Tier-C comparative ground-truth
 *      check (candidate vs the current primary reviewer, same mechanism
 *      finalize-shadow-eval.mjs uses post-collection). A floors-met-but-
 *      inconclusive result STARTS live-shadow collection
 *      (createEvalRun status:'pending_shadow') rather than deciding from
 *      historical ground truth alone; gemini-review.mjs's own discovery
 *      (getActiveEvalRunId, unconditional) picks it up on the next ordinary
 *      /audit-code invocation. A clear result finalizes immediately.
 *   2. An active live-shadow run: calls finalizeShadowEval to check
 *      progress / finalize once minLiveShadowRuns terminal-labeled
 *      observations have accumulated.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 4.
 *
 * @module scripts/model-eval-adjudicator
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { refreshModelCatalog } from './lib/model-resolver.mjs';
import { resolveCandidateRoute, buildComparisonEvidenceFromRoutes } from './lib/model-eval/route-catalog.mjs';
import { computeVerdict } from './lib/model-eval/verdict.mjs';
import { getAdjudicatorGroundTruth } from './lib/store/model-ab.mjs';
import { finalizeShadowEval } from './lib/model-eval/finalize-shadow-eval.mjs';
import { parseThresholdConfig } from './lib/model-eval/config/schema.mjs';
import { createEvalRun, updateEvalRunTerminal, getActiveEvalRunId, EvalRunAlreadyActiveError } from './lib/store/model-eval.mjs';
import { resolveRepoIdentity } from './lib/repo-identity.mjs';
import { writeOutput } from './lib/file-io.mjs';
import { argOption } from './lib/cli-io.mjs';
import { RunPreflightError, parseJsonArg } from './lib/model-eval/cli-shared.mjs';
// D7a layering fix — moved to a lib module so EXECUTORS.adjudicator (D7c, a
// lib module itself) can import the SAME function without importing this
// entry point.
import { scoreAgainstGroundTruth } from './lib/model-eval/adjudicator-executor.mjs';
// D7c — CLI parity with model-eval-auditor.mjs: the role-generic manifest
// driver dispatches on manifest.role, so an adjudicator manifest belongs on
// THIS entry point, not the auditor one, even though both call the same
// lib function.
import { runManifestDriver } from './lib/model-eval/manifest-driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_THRESHOLDS_PATH = path.join(__dirname, 'lib', 'model-eval', 'config', 'adjudicator-thresholds.json');
// The default production final reviewer (gemini-review.mjs's own documented
// default: "Gemini whenever GEMINI_API_KEY is present"). A caller who runs a
// non-default primary (FINAL_REVIEW_PROVIDER=azure-claude, etc.) can
// override via --baseline; this CLI has no way to introspect the OPERATOR's
// live selectProvider() precedence without invoking gemini-review.mjs itself.
const DEFAULT_BASELINE_CANDIDATE_SPEC = { kind: 'sentinel', value: 'latest-pro' };

async function main() {
  // Literal `--selfcheck-relocation` string — see model-eval-auditor.mjs's
  // own comment for why this must not be routed through a flag-name helper.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const candidateRaw = argOption('candidate');
  const manifestPath = argOption('manifest');
  const tier = argOption('tier');
  const baselineRaw = argOption('baseline');
  const thresholdsPath = argOption('thresholds', DEFAULT_THRESHOLDS_PATH);
  const outFile = argOption('out');
  const extraRepoRoots = (argOption('repo-roots', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const repoRoots = [process.cwd(), ...extraRepoRoots];

  // Same mutual-exclusivity contract as model-eval-auditor.mjs (R3/H1):
  // --manifest is a DRIVER, not an alternative input.
  if (candidateRaw && manifestPath) {
    console.error('[model-eval-adjudicator] --candidate and --manifest are mutually exclusive — --manifest already supplies --candidate once per scored arm');
    process.exit(2);
  }
  if (!candidateRaw && !manifestPath) {
    console.error('Usage: model-eval-adjudicator.mjs --candidate <CandidateSpec-json> --tier screen|promotion [--baseline <CandidateSpec-json>] [--out <file>]\n   or: model-eval-adjudicator.mjs --manifest <path> --tier screen|promotion');
    process.exit(1);
  }
  if (tier !== 'screen' && tier !== 'promotion') { console.error(`--tier must be "screen" or "promotion", got "${tier}"`); process.exit(1); }

  // Round-15 empirical-verify fix (found via model-eval-auditor.mjs's twin
  // bug) — without this, a sentinel candidateSpec always resolved from the
  // stale STATIC_POOL, silently testing an old model release.
  try { await refreshModelCatalog(); } catch { /* silent — falls back to static */ }

  try {
    if (manifestPath) {
      await runManifestDriver({ manifestPath, tier, corpusFlagPath: null, thresholdsPath, outFile, repoRoots });
      return;
    }
    const candidateSpec = parseJsonArg(candidateRaw, '--candidate');
    const candidateRoute = resolveCandidateRoute({ role: 'adjudicator', candidateSpec });

    const rawThresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));
    const thresholdsResult = parseThresholdConfig(rawThresholds);
    if (!thresholdsResult.ok) throw new RunPreflightError('invalid_threshold_config', `threshold config invalid: ${thresholdsResult.error}`);
    const thresholds = thresholdsResult.config;
    if (thresholds.role !== 'adjudicator') throw new RunPreflightError('invalid_threshold_config', `threshold config role must be "adjudicator", got "${thresholds.role}"`);

    const repoIdentity = resolveRepoIdentity();
    const repoId = repoIdentity.repoUuid;
    const baselineSpec = baselineRaw ? parseJsonArg(baselineRaw, '--baseline') : DEFAULT_BASELINE_CANDIDATE_SPEC;
    const baselineRoute = resolveCandidateRoute({ role: 'adjudicator', candidateSpec: baselineSpec });

    let result;
    if (tier === 'promotion') {
      const active = await getActiveEvalRunId({ repoId, role: 'adjudicator' });
      if (active) {
        const promoted = await finalizeShadowEval({
          repoId, runId: active.runId, minLiveShadowRuns: thresholds.promotion.minSampleSize,
          candidateRoute, baselineRoute, thresholds: thresholds.promotion.thresholds,
        });
        result = promoted.finalized
          ? { verdict: promoted.verdict, nextAction: promoted.nextAction, metrics: promoted.metrics, evidence: { mode: 'live-shadow', ...promoted.progress } }
          : { verdict: 'inconclusive', nextAction: 'none', metrics: null, evidence: { mode: 'live-shadow-collecting', ...promoted.progress } };
        const summaryLine = promoted.finalized
          ? `[model-eval-adjudicator] tier=promotion FINALIZED verdict=${promoted.verdict} nextAction=${promoted.nextAction}`
          : `[model-eval-adjudicator] tier=promotion collecting: ${promoted.progress.terminal}/${promoted.progress.minLiveShadowRuns} terminal-labeled observations`;
        writeOutput({ runId: active.runId, tier, ...result }, outFile, summaryLine);
        return;
      }
    }

    // Tier-C ground-truth check — screen tier always, promotion tier when
    // no live-shadow run is active yet (the eligibility pre-check).
    const tierConfig = thresholds[tier];
    const { rows } = await getAdjudicatorGroundTruth({ repoId, limit: Math.max(tierConfig.minSampleSize * 5, 200) });
    if (rows.length < tierConfig.minSampleSize) {
      throw new RunPreflightError('insufficient_ground_truth', `only ${rows.length} labeled ground-truth rows available; ${tier} tier needs minSampleSize=${tierConfig.minSampleSize}`);
    }
    const sampled = rows.slice(0, tierConfig.minSampleSize);

    const runBundle = {
      repoId, role: 'adjudicator', tier,
      candidateRef: { candidateSpec: candidateRoute.candidateSpec, resolvedModel: candidateRoute.resolvedModel, deploymentId: candidateRoute.deploymentId },
      status: 'running',
    };
    const created = await createEvalRun(runBundle);
    const runId = created.runId || `local-${Date.now()}`;

    if (tier === 'screen') {
      // `scoreAgainstGroundTruth` now also returns `usage` (D7c) — VerdictInputSchema's
      // MetricsSchema is z.record(string, number|null), so a `usage` object embedded
      // in `candidateMetrics` would fail that schema outright. Destructure it out.
      const { usage: candidateUsage, ...candidateMetrics } = await scoreAgainstGroundTruth({ route: candidateRoute, rows: sampled });
      const routeEvidence = { judgeTier: candidateRoute.judgeTier, lineageStatus: candidateRoute.lineageStatus, independenceEligible: candidateRoute.independenceEligible, lineageSource: candidateRoute.lineageSource };
      const v = computeVerdict({
        mode: 'oracle', role: 'adjudicator', tier: 'screen', routeEvidence,
        candidateMetrics, sampleSize: sampled.length, minSampleSize: tierConfig.minSampleSize,
        corpusVersion: 'ground-truth', thresholds: tierConfig.thresholds,
      });
      result = {
        verdict: v.verdict, nextAction: v.nextAction, metrics: candidateMetrics,
        cost: { candidateUsd: candidateUsage.costUsd, candidateTokens: { input: candidateUsage.inputTokens, output: candidateUsage.outputTokens } },
        evidence: { mode: 'ground-truth', sampleSize: sampled.length, reasons: v.reasons },
      };
    } else {
      const [
        { usage: candidateUsage, ...candidateMetrics },
        { usage: baselineUsage, ...baselineMetrics },
      ] = await Promise.all([
        scoreAgainstGroundTruth({ route: candidateRoute, rows: sampled }),
        scoreAgainstGroundTruth({ route: baselineRoute, rows: sampled }),
      ]);
      const comparisonEvidence = buildComparisonEvidenceFromRoutes({ candidateRoute, baselineRoute, judgeRoute: null });
      const v = computeVerdict({
        mode: 'comparative', role: 'adjudicator', tier: 'promotion', comparisonEvidence,
        candidateMetrics, baselineMetrics, sampleSize: sampled.length, minSampleSize: tierConfig.minSampleSize,
        costDelta: null, thresholds: tierConfig.thresholds,
      });

      const groundTruthCost = {
        candidateUsd: candidateUsage.costUsd, baselineUsd: baselineUsage.costUsd,
        candidateTokens: { input: candidateUsage.inputTokens, output: candidateUsage.outputTokens },
        baselineTokens: { input: baselineUsage.inputTokens, output: baselineUsage.outputTokens },
      };
      if (v.verdict === 'inconclusive' && v.nextAction === 'eligible_for_shadow') {
        // Start live-shadow collection instead of finalizing from historical
        // ground truth alone — transition to pending_shadow; gemini-review.mjs
        // picks this up automatically on the next ordinary /audit-code run.
        if (created.runId) {
          await updateEvalRunTerminal({ repoId, runId: created.runId, expectedStatus: 'running', terminalBundle: { status: 'completed', verdict: null, nextAction: null, metrics: null, cost: null, evidence: { mode: 'ground-truth-inconclusive' } } });
          const shadowRun = await createEvalRun({ ...runBundle, status: 'pending_shadow' });
          result = { verdict: 'inconclusive', nextAction: 'eligible_for_shadow', metrics: candidateMetrics, cost: groundTruthCost, evidence: { mode: 'ground-truth', started: 'live-shadow-collection', pendingShadowRunId: shadowRun.runId } };
        } else {
          result = { verdict: 'inconclusive', nextAction: 'eligible_for_shadow', metrics: candidateMetrics, cost: groundTruthCost, evidence: { mode: 'ground-truth', started: null } };
        }
        writeOutput({ runId, tier, ...result }, outFile, `[model-eval-adjudicator] tier=promotion ground-truth inconclusive — starting live-shadow collection (need ${tierConfig.minSampleSize} terminal observations)`);
        return;
      }
      result = { verdict: v.verdict, nextAction: v.nextAction, metrics: candidateMetrics, cost: groundTruthCost, evidence: { mode: 'ground-truth', baselineMetrics, sampleSize: sampled.length, reasons: v.reasons } };
    }

    if (created.runId) {
      await updateEvalRunTerminal({
        repoId, runId: created.runId, expectedStatus: 'running',
        terminalBundle: { status: 'completed', verdict: result.verdict, nextAction: result.nextAction, metrics: result.metrics, cost: result.cost ?? null, evidence: result.evidence },
      });
    }
    const summaryLine = `[model-eval-adjudicator] tier=${tier} verdict=${result.verdict} nextAction=${result.nextAction} runId=${runId}`;
    writeOutput({ runId, tier, ...result }, outFile, summaryLine);
  } catch (err) {
    if (err instanceof EvalRunAlreadyActiveError) {
      console.error(`[model-eval-adjudicator] ${err.message}`);
      process.exit(3);
    }
    if (err instanceof RunPreflightError) {
      console.error(`[model-eval-adjudicator] preflight failed (${err.reason}): ${err.message}`);
      process.exit(2);
    }
    console.error(`[model-eval-adjudicator] fatal: ${err.stack || err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
