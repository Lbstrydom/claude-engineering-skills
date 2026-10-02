/**
 * @fileoverview `runManifestDriver` — role-generic declarative arm-manifest
 * execution (D7a, plan: comparison-tooling-consolidation.md, Cluster D).
 *
 * Moved from `scripts/model-eval-auditor.mjs` (round-3 gate H2 — a lib module
 * (`executors.mjs`) importing `EXECUTORS` must not itself be imported FROM an
 * entry point while also importing one, which is what leaving this function in
 * a top-level script would have produced: `executors.mjs` would have to import
 * `model-eval-auditor.mjs` to reach it, inverting this plan's own repeatedly-
 * enforced `entry point → lib, never the reverse` rule). Role-generic now —
 * the 8 `'auditor'` literals this driver used to hardcode are gone; the role
 * comes from the manifest itself, dispatched through `EXECUTORS`.
 *
 * **`prepareContext`'s signature is extended to THREE arguments — a grounded
 * correction, not the plan's literal text.** D7c's design states
 * `prepareContext?: (manifest, repoIdentity) => Promise<Context>`. Implementing
 * it against the auditor role's ACTUAL mechanism (a per-arm CHILD-PROCESS spawn
 * of `model-eval-auditor.mjs` itself, mirroring the single-`--candidate`
 * invocation byte-for-byte) surfaced a real gap: that spawn needs `tier`,
 * `thresholdsPath`, an effective corpus path, and `repoRoots` — all CLI-level
 * arguments to THIS driver invocation, not part of `manifest` or `repoIdentity`.
 * Nothing in the two-arg signature carries them. Rather than force a role-
 * specific channel through the generic driver (or silently drop the two-phase
 * design), `prepareContext` takes a third `driverArgs` bag
 * (`{resolvedPaths, tier, corpusFlagPath, thresholdsPath, outFile, repoRoots}`)
 * — everything the driver itself resolved generically (manifest parse, subject
 * paths) plus the raw CLI args, opaque to the driver, interpreted only by the
 * role's own `prepareContext`. `EXECUTORS.adjudicator.prepareContext` ignores
 * the fields it does not need (its own tier/thresholds live in
 * `manifest.controls`, not the CLI).
 *
 * @module scripts/lib/model-eval/manifest-driver
 */

import fs from 'node:fs';
import { RunPreflightError } from './cli-shared.mjs';
import { parseComparisonManifest, resolveManifestPaths } from '../comparison/manifest.mjs';
import { isScoredArm } from '../comparison/arms.mjs';
import { configDigest as manifestConfigDigest, LOCK_SCHEMA_VERSION } from '../comparison/lock.mjs';
import { upsertComparison, getComparisonArmAttempts } from '../store/model-eval.mjs';
import { decideArmAttempt, DEFAULT_MAX_ATTEMPTS_PER_ARM } from '../comparison/attempts.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { writeOutput } from '../file-io.mjs';
import { EXECUTORS } from './executors.mjs';

/**
 * Resolve a declarative arm manifest and invoke the role's registered
 * `EXECUTORS[role].executeArm` once per scored arm (REQ-safety-f0ef6d7d's
 * "every execution has a real candidate" invariant, generalised: the auditor
 * executor still spawns a child process with a real `--candidate`; the
 * adjudicator executor calls the existing ground-truth scoring path
 * in-process — each role's own mechanism, unchanged by this lift).
 *
 * **Sequential, never parallel** (AGENTS.md, "bounded and synchronous by
 * construction") — running arms concurrently would send concurrent provider
 * calls this repo has never needed to rate-limit for.
 *
 * **Per-arm failure is terminal for that arm only.** A failed arm's outcome is
 * recorded in the aggregate `--out`, not thrown — the cohort's other arms still
 * run (D6's no-silent-zero rule, applied to execution).
 *
 * **Bounded re-spend (D5a + D6).** Before each arm, `decideArmAttempt` reads
 * the arm's recorded attempts and decides: resume (a live success is never
 * re-run), refuse (attempt cap `maxAttemptsPerArm` reached; spend across all
 * attempts at the `budgetUsdPerArm` ceiling; or the history could not be
 * read), or run as attempt N+1 with whatever budget remains. Without this a
 * deterministically failing arm re-spent on every re-invocation.
 *
 * @param {{manifestPath: string, tier: string, corpusFlagPath: string|null,
 *   thresholdsPath: string, outFile: string|null, repoRoots: string[]}} args
 */
export async function runManifestDriver({ manifestPath, tier, corpusFlagPath, thresholdsPath, outFile, repoRoots }) {
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
  // Role-generic dispatch (D7a) — was `manifest.role !== 'auditor'` hardcoded.
  // The refusal is unconditional either way: a manifest for a role this driver
  // has no executor for cannot run, but the check is now against the registry
  // rather than a single literal. `executor?.executeArm` (not just `executor`)
  // — `final_review_shadow` HAS a registry entry (empty, deliberately) so
  // `SUPPORTED_ROLES` <-> `EXECUTORS` coverage is checkable, but it declares
  // no `executeArm`, and that must refuse HERE, before any store write, not
  // per-arm after minting a comparison row.
  const executor = EXECUTORS[manifest.role];
  if (!executor?.executeArm) {
    throw new RunPreflightError('bad_manifest', `--manifest: role "${manifest.role}" has no synchronous executor (registered but not runnable via this driver: ${Object.keys(EXECUTORS).filter((r) => !EXECUTORS[r].executeArm).join(', ') || 'none'}; runnable: ${Object.keys(EXECUTORS).filter((r) => EXECUTORS[r].executeArm).join(', ')})`);
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

  // Role-specific refuse-at-load checks (e.g. a budget on an unpriced route),
  // BEFORE the comparison row is minted: a manifest that cannot run as
  // declared should cost nothing, store writes included.
  executor.preflightManifest?.(manifest);

  const digest = manifestConfigDigest(manifest);
  const repoIdentity = resolveRepoIdentity();
  const ensured = await upsertComparison({
    repoId: repoIdentity.repoUuid, comparisonKey: manifest.id, configDigest: digest,
    lockSchemaVersion: LOCK_SCHEMA_VERSION, role: manifest.role, subjectRef: manifest.subject ?? null,
  });
  if (!ensured.ok) {
    throw new RunPreflightError('comparison_persist_failed', `--manifest: could not persist comparison "${manifest.id}": ${ensured.error}`);
  }
  // null only when cloud is off — every arm still runs; the cohort is simply
  // unlinked, same graceful-degradation posture as the rest of this harness.
  const comparisonId = ensured.id;
  // Analysis-time (D2a): read from the manifest, never part of its digest.
  const maxAttemptsPerArm = manifest.maxAttemptsPerArm ?? DEFAULT_MAX_ATTEMPTS_PER_ARM;
  const budgetUsdPerArm = manifest.budgetUsdPerArm ?? null;
  if (!comparisonId) {
    process.stderr.write(`  [manifest-driver] manifest: cloud store off: no attempt history exists, so maxAttemptsPerArm (${maxAttemptsPerArm}) `
      + 'cannot bound RE-invocations of this manifest; each arm runs once per invocation'
      + `${budgetUsdPerArm != null ? ', and budgetUsdPerArm applies to this invocation only' : ''}\n`);
  }

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
    process.stderr.write(`  [manifest-driver] manifest: ${unscoredArms.length} control/replicate arm(s) declared but NOT executed `
      + `(${unscoredArms.map((a) => a.id).join(', ')}) — this driver does not yet collect unscored arms, only score them\n`);
  }

  // Two-phase execution (D7c, Gemini gate G1): run-level setup ONCE, then
  // per-arm execution. `context` is opaque to this driver — only the role's
  // own `prepareContext`/`executeArm` pair interprets its shape.
  const context = await executor.prepareContext?.(manifest, repoIdentity, {
    resolvedPaths, tier, corpusFlagPath, thresholdsPath, outFile, repoRoots,
  });

  const results = [];
  for (const arm of scoredArms) {
    // D5a's reducer + cap and D6's across-attempt budget, role-generic (the
    // history is keyed on comparisonId+armId, not role). One decision, made
    // before anything is spent.
    const history = comparisonId ? await getComparisonArmAttempts({ comparisonId, armId: arm.id }) : null;
    const decision = decideArmAttempt({ history, maxAttemptsPerArm, budgetUsdPerArm });
    if (decision.action === 'skip') {
      process.stderr.write(`  [manifest-driver] manifest: arm "${arm.id}" not run: ${describeSkip(decision)}\n`);
      results.push({ armId: arm.id, skipped: true, ok: decision.outcome === 'ok', outcome: decision.outcome, reason: decision.reason, attempt: decision.attempts ?? null, decision });
      continue;
    }
    const nextAttempt = decision.attempt;

    process.stderr.write(`  [manifest-driver] manifest: running arm "${arm.id}" (model ${arm.model})…\n`);
    // Per-arm error boundary (round-4 gate H5/H20) — every current executor
    // is written to never throw (auditorExecuteArm/adjudicatorExecuteArm both
    // convert every failure mode into a `terminal` ExecutorAttempt), but the
    // driver's own "a per-arm failure is terminal for that arm only" contract
    // must hold even if a FUTURE executor — or a gap in a current one — throws
    // instead. Without this, one arm's uncaught exception would abort the
    // whole manifest run, silently losing every OTHER arm's already-computed
    // results (never written to --out).
    let attempt;
    try {
      attempt = await executor.executeArm(arm, manifest.controls, context, {
        comparisonId, armId: arm.id, attempt: nextAttempt, supersedePrior: decision.supersedePrior,
        remainingBudgetUsd: decision.remainingBudgetUsd,
      });
    } catch (err) {
      attempt = { outcome: 'terminal', reason: `executeArm threw: ${err.message}` };
    }
    const ok = attempt.outcome === 'ok';
    if (!ok) {
      process.stderr.write(`  [manifest-driver] manifest: arm "${arm.id}" ${attempt.outcome.toUpperCase()} (${attempt.reason}) — comparison continues with remaining arm(s)\n`);
    }
    results.push({ armId: arm.id, ok, attempt: nextAttempt, outcome: attempt.outcome, result: attempt });
  }

  // Every non-ok arm, skipped or run: a permanently-failed, budget-stopped or
  // refused arm is INCONCLUSIVE for this comparison exactly as a failed run is.
  // (A resumed live success is a skip with ok:true and is not counted.)
  const failedArms = results.filter((r) => !r.ok).map((r) => r.armId);
  // controlsDivergence (auditor-controls-execution-wiring.md, round-4 H1 fix)
  // — `configDigest` hashes the manifest's REQUESTED controls (its correct,
  // unchanged meaning); this is the one place that already sees every arm's
  // own per-arm `controlsApplied` (auditor role only — adjudicator/
  // final_review_shadow executors don't compute this evidence), so it's the
  // natural place to surface EFFECTIVE-configuration divergence across a
  // heterogeneous-tier campaign, closing the plan's original defect (a
  // digest implying uniform governance) at the level it actually surfaces.
  const controlsDivergence = computeControlsDivergence(results);
  const summaryLine = `[manifest-driver] manifest=${manifest.id} role=${manifest.role} comparisonId=${comparisonId ?? '(cloud off)'} arms=${scoredArms.length} failed=${failedArms.length}`;
  // `analysis` names the analysis-time values this run applied, so a reader
  // can tell which ceiling produced a skip without re-deriving the default.
  writeOutput({
    manifestId: manifest.id, role: manifest.role, comparisonId, tier,
    analysis: { maxAttemptsPerArm, budgetUsdPerArm },
    arms: results, controlsDivergence,
  }, outFile, summaryLine);
  if (failedArms.length > 0) {
    process.stderr.write(`  [manifest-driver] manifest: arm(s) failed: ${failedArms.join(', ')} — INCONCLUSIVE for those; siblings recorded normally\n`);
  }
}

/**
 * One line naming WHY an arm was not run, and the lever that changes it — a
 * skip without its reason reads the same as a bug.
 * @param {object} d - a `decideArmAttempt` skip decision
 * @returns {string}
 */
function describeSkip(d) {
  switch (d.reason) {
    case 'live-success':
      return `already has a live success (resume; attempt ${d.attempts})`;
    case 'max-attempts-exhausted':
      return `PERMANENTLY-FAILED: ${d.attempts} attempt(s) recorded, maxAttemptsPerArm is ${d.maxAttemptsPerArm} (raise it in the manifest to retry; the cohort is kept)`;
    case 'attempt-history-unreadable':
      return `REFUSED: could not read its attempt history (${d.detail}); not guessing attempt 1, which would re-spend`;
    case 'budget-exhausted':
      return `BUDGET-STOPPED: ${d.spendUsd} USD recorded across ${d.attempts} attempt(s) >= budgetUsdPerArm ${d.budgetUsdPerArm} (raise it to resume; the cohort is kept)`;
    case 'budget-unenforceable-unpriced':
      return `BUDGET-STOPPED: ${d.unpricedAttempts} earlier attempt(s) have no recorded cost, so spend against budgetUsdPerArm ${d.budgetUsdPerArm} cannot be measured (remove the budget to retry without one)`;
    default:
      return `${String(d.outcome).toUpperCase()} (${d.reason})`;
  }
}

/**
 * For each of the eight `deriveControlsApplied`-covered fields, `'uniform'`
 * if every arm that reported the field agrees on its value, `'divergent'`
 * otherwise, `null` if no arm reported it at all (never declared, or a
 * non-auditor role with no `controlsApplied` mechanism). Pure — takes the
 * SAME `results` array `writeOutput` receives, no re-fetching.
 * @param {Array<{result?: {controlsApplied?: object|null}}>} results
 * @returns {Record<string, 'uniform'|'divergent'|null>|null} `null` when
 *   NO arm reported any `controlsApplied` at all (e.g. every arm failed
 *   before producing one, or the role doesn't compute this evidence).
 */
function computeControlsDivergence(results) {
  const fieldValues = new Map();
  for (const r of results) {
    const applied = r.result?.result?.controlsApplied;
    if (!applied || typeof applied !== 'object') continue;
    for (const [field, value] of Object.entries(applied)) {
      if (!fieldValues.has(field)) fieldValues.set(field, new Set());
      fieldValues.get(field).add(value);
    }
  }
  if (fieldValues.size === 0) return null;
  const divergence = {};
  for (const [field, values] of fieldValues) {
    divergence[field] = values.size === 1 ? 'uniform' : 'divergent';
  }
  return divergence;
}

// Exported for direct testing (mirrors this repo's established _internals pattern).
export const _internals = { computeControlsDivergence, describeSkip };
