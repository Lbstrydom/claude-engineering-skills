/**
 * @fileoverview `EXECUTORS` — the role-dispatch registry `manifest-driver.mjs`
 * loops over (D7c, plan: comparison-tooling-consolidation.md, Cluster D).
 *
 * Two-phase per role (Gemini gate, G1): `prepareContext` runs ONCE per
 * manifest run (fetches whatever a role needs before the per-arm loop, e.g.
 * the adjudicator's fixed ground-truth page); `executeArm` runs once per
 * scored arm and returns an `ExecutorAttempt`.
 *
 * **`ExecutorAttempt`, corrected against real code (this file supersedes the
 * plan's literal `RoleResult`/`ExecutorAttempt` text in two ways, both
 * verified against actual call sites before writing this module):**
 *
 * 1. **`RoleResult.auditor` is `{role:'auditor', metrics:{recall,
 *    falsePositiveRate, f1}}`, never `{findings: NormalizedFinding[]}`.**
 *    The plan's D7c section wrote `findings: NormalizedFinding[]` for the
 *    auditor branch — grep found zero other references to
 *    `NormalizedFinding` anywhere in the plan, and the actual auditor
 *    mechanism (`runScreenTier`/`runPromotionTier` in
 *    `scripts/model-eval-auditor.mjs`) returns `{verdict, nextAction,
 *    metrics: {recall, falsePositiveRate, f1}, evidence, cost}` — the EXACT
 *    same metrics shape `scoreAgainstGroundTruth` (adjudicator) returns.
 *    Both roles are graded through the same `computeVerdict` contract, so
 *    both branches carry the same metrics shape; the plan's claim was never
 *    grounded in the code it described.
 * 2. **`usage` is nullable on the `'ok'` branch, not unconditional.** The
 *    adjudicator's `scoreAgainstGroundTruth` (D7a/D7c) DOES bubble up real
 *    per-arm usage. The auditor's mechanism — a spawned child process running
 *    the single-`--candidate` CLI path — does NOT: screen tier never
 *    instruments token usage at all, and promotion tier's `cost.byRow` is an
 *    aggregate across BOTH candidate+baseline generation/judge calls, not
 *    cleanly attributable to "this one arm's usage" without deeper parsing
 *    this cluster's scope does not require. `usage: null` on the auditor
 *    executor's `'ok'` branch means "not tracked by this mechanism today" —
 *    distinct from `{inputTokens:0,…}`, which would be a false zero
 *    (AGENTS.md's "a hardcoded 0 in telemetry reads as a measurement" rule,
 *    applied here rather than violated).
 *
 * @module scripts/lib/model-eval/executors
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getAdjudicatorGroundTruth } from '../store/model-ab.mjs';
import { scoreAgainstGroundTruth } from './adjudicator-executor.mjs';
import { resolveCandidateRoute } from './route-catalog.mjs';
import { createEvalRun, updateEvalRunTerminal } from '../store/model-eval.mjs';
import { parseThresholdConfig } from './config/schema.mjs';
import { computeVerdict } from './verdict.mjs';

/** The auditor role's default corpus — moved here (from
 *  `scripts/model-eval-auditor.mjs`) so this lib module and that entry
 *  point's thin CLI shim share ONE definition rather than two copies that
 *  could drift (D2a's own rule, applied to a constant instead of a
 *  function). */
export const DEFAULT_CORPUS_PATH = path.join('docs', 'experiments', 'audit-effectiveness', 'known-defects.json');

// ── auditor ──────────────────────────────────────────────────────────────
//
// Wraps the EXISTING per-arm spawn (D7a — does not rewrite it): each arm is
// still a real child-process invocation of `scripts/model-eval-auditor.mjs`
// with a genuine `--candidate`, satisfying REQ-safety-f0ef6d7d exactly as it
// did before this lift. No `prepareContext` is needed beyond bundling the
// driver's own CLI args + resolved subject paths into one object `executeArm`
// can read — the existing per-arm spawn needs no OTHER run-level setup.

async function auditorPrepareContext(manifest, _repoIdentity, driverArgs) {
  const { resolvedPaths, tier, corpusFlagPath, thresholdsPath, repoRoots } = driverArgs;
  // Precedence: an explicit --corpus on THIS invocation is the operator's own
  // instruction and wins over everything; the manifest's declared subject
  // comes next; the CLI's hardcoded default is the last resort. Unchanged
  // from the pre-lift logic in model-eval-auditor.mjs's runManifestDriver.
  const corpusPath = corpusFlagPath ?? resolvedPaths.corpusPath?.abs ?? DEFAULT_CORPUS_PATH;
  return { tier, thresholdsPath, corpusPath, repoRoots };
}

// `_controls` (AuditorControlsSchema's reasoningEffort/promptTemplateId/
// outputSchemaId/maxOutputTokens/toolPolicy/passes/scope/rounds) is
// intentionally unused (round-5 gate H3/H12) — verified by grep against
// structured-extractor.mjs/provider-adapter.mjs/model-eval-auditor.mjs: NONE
// of these fields are consumed by ANY execution path in this repo today, for
// either the manifest-driven or the pre-existing single-`--candidate` CLI
// invocation. This is a PRE-EXISTING gap in AuditorControlsSchema itself
// (predecessor plan role-agnostic-comparison-core.md), not introduced by this
// cluster — the schema validates these fields as if they govern execution,
// but no code path applies them, with or without a manifest. Wiring them
// through would mean extending extractStructured/provider-adapter.mjs to
// accept a per-call reasoningEffort/promptTemplate override, which is a real,
// separate feature outside D7's stated scope (n-arm PARITY with the existing
// single-candidate mechanism, not new capability inside it). Named here so a
// manifest author does not reasonably assume declaring these fields changes
// anything — because today, it doesn't, for any invocation shape.
async function auditorExecuteArm(arm, _controls, context, driverAttempt) {
  const { comparisonId, armId, attempt, supersedePrior } = driverAttempt;
  const armOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-arm-'));
  const armOutFile = path.join(armOutDir, 'result.json');
  // A bare model name/sentinel is the only thing an arm declares — the
  // general mapping onto CandidateSpecSchema's discriminated union.
  const candidateSpec = { kind: 'sentinel', value: arm.model };
  const args = [
    'scripts/model-eval-auditor.mjs', '--candidate', JSON.stringify(candidateSpec), '--tier', context.tier,
    '--thresholds', context.thresholdsPath, '--corpus', context.corpusPath, '--out', armOutFile,
  ];
  if (context.repoRoots.length > 1) args.push('--repo-roots', context.repoRoots.slice(1).join(','));
  if (comparisonId) args.push('--comparison-id', comparisonId, '--arm-id', armId, '--attempt', String(attempt));
  if (supersedePrior) args.push('--supersede-prior');

  // node itself, not a shim — no CVE-2024-27980 exposure, the same reasoning
  // every other spawn site in this repo already documents.
  const spawned = spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let armResult = null;
  try { armResult = JSON.parse(fs.readFileSync(armOutFile, 'utf8')); } catch { /* the arm may have failed before writing --out */ }

  if (spawned.status !== 0) {
    return { outcome: 'terminal', reason: `exit ${spawned.status}${spawned.stderr ? `: ${String(spawned.stderr).slice(-400)}` : ''}` };
  }
  // A zero exit code alone is not "ok" (round-4 gate H8) — the child could
  // exit 0 without writing --out, or write malformed JSON, or write a JSON
  // object with no `verdict` (the one field every real result carries,
  // success or evidence-based inconclusive alike). Any of those would
  // otherwise return `outcome:'ok'` with every result field null — a false
  // success indistinguishable from a real one, the exact "control the write
  // side, not just the read" failure class this repo's own history keeps
  // re-finding.
  if (armResult == null || typeof armResult !== 'object' || armResult.verdict === undefined) {
    return { outcome: 'terminal', reason: `exit 0 but --out at ${armOutFile} was missing, unparseable, or had no verdict field` };
  }
  return {
    outcome: 'ok',
    result: { role: 'auditor', metrics: armResult.metrics ?? null, verdict: armResult.verdict, nextAction: armResult.nextAction ?? null, evidence: armResult.evidence ?? null },
    usage: null, // see module docstring — not tracked by the spawn mechanism today
    provenance: { model: arm.model, route: 'openai-compatible', promptTemplateId: null, capturedAt: new Date().toISOString() },
  };
}

// ── adjudicator ──────────────────────────────────────────────────────────
//
// `prepareContext` fetches the fixed ground-truth page ONCE and reuses it for
// every arm (D7c's "fetched once per manifest run" rule, satisfied literally).
// `executeArm` calls the SAME `scoreAgainstGroundTruth` the single-`--candidate`
// CLI path uses, from its lib home (D7a's layering fix) — reusing the existing
// extractStructured/scoreBinaryClassification pipeline verbatim, once per
// declared arm rather than once for a single `--candidate`.

async function adjudicatorPrepareContext(manifest, repoIdentity, driverArgs) {
  // Cross-checked against the CLI's own --tier (round-5 gate H13/M10) — two
  // authorities existed for one value (the manifest's REQUIRED
  // controls.tier, and the CLI's REQUIRED --tier, which main() always passes
  // through to runManifestDriver regardless of role), and nothing reconciled
  // them: an operator running `--manifest foo.json --tier promotion` against
  // a manifest declaring `controls.tier: 'screen'` would have the CLI value
  // silently ignored (this function never received it). Refused, never
  // silently picking one — the same "never silently pick one, name both"
  // posture the rest of this repo takes for exactly this kind of ambiguity.
  if (driverArgs?.tier && driverArgs.tier !== manifest.controls.tier) {
    throw new Error(`[executors] adjudicator: --tier "${driverArgs.tier}" disagrees with manifest.controls.tier "${manifest.controls.tier}" — `
      + 'the manifest\'s own declared tier is part of its signed configuration (configDigest); the CLI --tier for a --manifest run must match it exactly.');
  }
  // Refused at LOAD (round-4 gate H11), not silently downgraded to screen
  // behaviour. `AdjudicatorControlsSchema.tier` mirrors AuditorControlsSchema's
  // shape (z.enum(['screen', 'promotion'])), but this executor only implements
  // ONE tier's mechanism: oracle-mode ground-truth scoring via
  // `scoreAgainstGroundTruth`, once per arm, against the fixed corpus page.
  // `model-eval-adjudicator.mjs`'s OWN 1-vs-1 CLI path DOES implement a
  // separate promotion-tier flow (comparative floors vs. `--baseline`,
  // live-shadow collection) — but wiring the SAME comparative logic into the
  // n-arm manifest driver (N candidates, each independently vs. a shared
  // baseline, each producing its own comparative verdict) is real, unbuilt
  // scope, not a one-line plumb-through. Declaring it supported and silently
  // running it as screen-tier oracle scoring would be worse than refusing:
  // an operator reading `tier:'promotion'` in their own manifest would
  // reasonably expect comparative floors, not get them, and never be told.
  if (manifest.controls.tier === 'promotion') {
    throw new Error('[executors] adjudicator: manifest.controls.tier "promotion" is not yet supported by the n-arm manifest driver — '
      + 'only "screen" (oracle-mode ground-truth scoring) is implemented. Comparative promotion-tier scoring exists today only via '
      + 'the 1-vs-1 model-eval-adjudicator.mjs --candidate/--baseline CLI path. This is a named v1 boundary, not a silent gap.');
  }
  // Undeclared `groundTruthLimit` is passed through as `undefined`, not
  // re-defaulted here — `getAdjudicatorGroundTruth` already owns ONE default
  // (`GROUND_TRUTH_LIMIT_DEFAULT`, private to store/model-ab.mjs); a second
  // copy of that constant in this module previously leaked through
  // `scripts/learning-store.mjs`'s `export * from './lib/store/model-ab.mjs'`
  // barrel and broke its curated public-surface pin — the fix is one default,
  // not a re-exported one.
  const declaredLimit = manifest.controls.groundTruthLimit;
  const { rows } = await getAdjudicatorGroundTruth({ repoId: repoIdentity.repoUuid, ...(declaredLimit ? { limit: declaredLimit } : {}) });
  // An empty corpus is a REFUSAL (plan: "not a degenerate-but-valid outcome,
  // it is a setup error"), not a 0-observation `unknown` under D6's rule — a
  // comparison with nothing to score fails the same way an unresolvable repo
  // identity does, before any arm runs.
  if (rows.length === 0) {
    throw new Error(`[executors] adjudicator: getAdjudicatorGroundTruth returned 0 rows (limit=${declaredLimit ?? '(store default)'}) — nothing to score. This is a setup error, not a valid empty comparison.`);
  }

  // Thresholds (round-4 gate H11's other half): `updateEvalRunTerminal`'s own
  // schema REQUIRES a non-null verdict on `status:'completed'`, so a real
  // per-arm verdict has to be computed, not just metrics. Precedence:
  // `manifest.controls.thresholdsPath` (declared) wins over the CLI's OWN
  // ALREADY-RESOLVED default — `driverArgs.thresholdsPath`, which
  // model-eval-adjudicator.mjs's main() computed via
  // `argOption('thresholds', DEFAULT_THRESHOLDS_PATH)` before ever calling
  // runManifestDriver. Round-5 gate M10: this module previously computed a
  // SECOND, independent default here (duplicating that CLI constant) — fixed
  // by reusing the value the CLI already resolved, the same fix pattern as
  // GROUND_TRUTH_LIMIT_DEFAULT above (one default, never re-derived).
  const thresholdsPath = manifest.controls.thresholdsPath ?? driverArgs?.thresholdsPath;
  const rawThresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));
  const thresholdsResult = parseThresholdConfig(rawThresholds);
  if (!thresholdsResult.ok) {
    throw new Error(`[executors] adjudicator: threshold config at "${thresholdsPath}" invalid: ${thresholdsResult.error}`);
  }
  if (thresholdsResult.config.role !== 'adjudicator') {
    throw new Error(`[executors] adjudicator: threshold config role must be "adjudicator", got "${thresholdsResult.config.role}"`);
  }
  return {
    rows, groundTruthLimit: declaredLimit ?? null, repoId: repoIdentity.repoUuid,
    screenThresholds: thresholdsResult.config.screen,
  };
}

async function adjudicatorExecuteArm(arm, controls, context, driverAttempt) {
  // `arm.model` reaches a route through the EXISTING resolver — the same
  // function `model-eval-adjudicator.mjs` already calls for its single
  // `--candidate` (D7c point 3). Resolved BEFORE creating any run row,
  // mirroring model-eval-adjudicator.mjs's own single-candidate ordering: a
  // request that fails before we know what model to call should never mint a
  // "running" row.
  let route;
  try {
    route = resolveCandidateRoute({ role: 'adjudicator', candidateSpec: { kind: 'sentinel', value: arm.model } });
  } catch (err) {
    return { outcome: 'terminal', reason: `route resolution failed: ${err.message}` };
  }

  // Persist to model_eval_runs (round-4 gate H13) — without this, an
  // adjudicator manifest's arm results existed ONLY in the driver's ephemeral
  // `--out` JSON. The auditor role gets this for free (its executor spawns
  // model-eval-auditor.mjs's own single-candidate CLI, which already calls
  // createEvalRun/updateEvalRunTerminal when handed --comparison-id/--arm-id/
  // --attempt); the adjudicator executor runs IN-PROCESS, so it must call the
  // SAME store functions itself, or D5a's resume mechanism
  // (maxComparisonArmAttempt reads model_eval_runs) can never see a prior
  // adjudicator attempt and would re-run every arm on every resume.
  const { comparisonId, armId, attempt, supersedePrior } = driverAttempt ?? {};
  const created = await createEvalRun({
    repoId: context.repoId, role: 'adjudicator', tier: controls.tier,
    candidateRef: { candidateSpec: route.candidateSpec, resolvedModel: route.resolvedModel, deploymentId: route.deploymentId },
    status: 'running',
    ...(comparisonId ? { comparisonId, armId, attempt, supersedePrior } : {}),
  });

  try {
    const { usage, ...metrics } = await scoreAgainstGroundTruth({ route, rows: context.rows });
    // A real per-arm verdict — updateEvalRunTerminal's own schema requires
    // one for status:'completed' (refineVerdictPair), not a style choice.
    // Mirrors model-eval-adjudicator.mjs's own screen-tier computeVerdict
    // call exactly (mode:'oracle', tier:'screen'), scored against every
    // fetched row rather than a slice down to minSampleSize — prepareContext
    // already fetched one fixed, declared page for the whole cohort, so
    // there is no "extra" data to discard here the way the 1-vs-1 CLI path's
    // own general-purpose fetch (`limit: minSampleSize*5`) has to slice down.
    const routeEvidence = { judgeTier: route.judgeTier, lineageStatus: route.lineageStatus, independenceEligible: route.independenceEligible, lineageSource: route.lineageSource };
    const v = computeVerdict({
      mode: 'oracle', role: 'adjudicator', tier: 'screen', routeEvidence,
      candidateMetrics: metrics, sampleSize: context.rows.length, minSampleSize: context.screenThresholds.minSampleSize,
      corpusVersion: 'ground-truth', thresholds: context.screenThresholds.thresholds,
    });
    if (created.runId) {
      await updateEvalRunTerminal({
        repoId: context.repoId, runId: created.runId, expectedStatus: 'running',
        terminalBundle: {
          status: 'completed', verdict: v.verdict, nextAction: v.nextAction, metrics,
          cost: usage.costUsd != null ? { totalUsd: usage.costUsd } : null,
          evidence: { mode: 'ground-truth', sampleSize: context.rows.length, groundTruthLimit: context.groundTruthLimit, reasons: v.reasons },
        },
      });
    }
    return {
      outcome: 'ok',
      result: {
        role: 'adjudicator', metrics, verdict: v.verdict, nextAction: v.nextAction,
        evidence: { mode: 'ground-truth', sampleSize: context.rows.length, reasons: v.reasons },
      },
      usage,
      provenance: { model: arm.model, route: route.transport, promptTemplateId: controls.promptTemplateId, capturedAt: new Date().toISOString() },
    };
  } catch (err) {
    if (created.runId) {
      await updateEvalRunTerminal({
        repoId: context.repoId, runId: created.runId, expectedStatus: 'running',
        terminalBundle: { status: 'failed_provider', verdict: null, nextAction: null, metrics: null, cost: null, evidence: { mode: 'ground-truth', error: err.message } },
      });
    }
    return { outcome: 'terminal', reason: err.message };
  }
}

// ── final_review_shadow ──────────────────────────────────────────────────
//
// A DELIBERATE no-op, not an absence — and REFUSED AT LOAD (INC-001's
// lesson: before any provider call AND before any store write), not
// per-arm. The plan's decision, stated precisely: "this plan closes the
// auditor↔adjudicator gap; it does NOT make final_review_shadow driveable by
// the manifest — the passive campaign collector remains its ONLY execution
// path, unconditionally." `controls.mjs` still lists it as SUPPORTED (it
// parses via `comparison/manifest.mjs`, unchanged — that path predates this
// cluster), so an entry is needed here for `SUPPORTED_ROLES` <-> `EXECUTORS`
// coverage to be checkable at all. The entry deliberately has NO
// `executeArm` (not a stub that always returns `'terminal'`, tried first and
// reverted — a per-arm-loop refusal still mints a `model_eval_comparisons`
// row and wastes N loop iterations before reporting anything, exactly the
// late-and-expensive failure this repo's "refuse at load" doctrine exists to
// convert into an early, free one). `manifest-driver.mjs` checks
// `executor?.executeArm` BEFORE resolving repo identity or persisting
// anything — an entry present with no `executeArm` refuses there, upfront,
// with the same preflight exit code as no entry at all. If synchronous
// final-review execution is ever wanted, it needs its own real executor and
// corpus definition — named explicitly here as a gap, not discovered as one
// later.

/**
 * role → `{prepareContext?, executeArm?}`. `Object.create(null)`, matching
 * `CONTROLS_BY_ROLE`'s own null-prototype convention (controls.mjs) — a
 * dispatch table over role names must not answer for `toString`.
 */
export const EXECUTORS = Object.freeze(Object.assign(Object.create(null), {
  auditor: Object.freeze({ prepareContext: auditorPrepareContext, executeArm: auditorExecuteArm }),
  adjudicator: Object.freeze({ prepareContext: adjudicatorPrepareContext, executeArm: adjudicatorExecuteArm }),
  final_review_shadow: Object.freeze({}),
}));
