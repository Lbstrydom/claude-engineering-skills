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
import { upsertComparison, maxComparisonArmAttempt } from '../store/model-eval.mjs';
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
    // Resume (D5a's reducer, role-generic — `maxComparisonArmAttempt` is keyed
    // on comparisonId+armId, not role): an arm with a live success is never
    // re-run — re-invoking the driver resumes the cohort by running only the
    // arms without one.
    let nextAttempt = 1;
    let supersede = false;
    if (comparisonId) {
      const existing = await maxComparisonArmAttempt({ comparisonId, armId: arm.id });
      if (existing.hasLiveSuccess) {
        process.stderr.write(`  [manifest-driver] manifest: arm "${arm.id}" already has a live success — skipping (resume)\n`);
        results.push({ armId: arm.id, skipped: true, ok: true, attempt: existing.attempt });
        continue;
      }
      nextAttempt = existing.attempt + 1;
      supersede = existing.attempt > 0;
    }

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
        comparisonId, armId: arm.id, attempt: nextAttempt, supersedePrior: supersede,
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

  const failedArms = results.filter((r) => !r.ok && !r.skipped).map((r) => r.armId);
  const summaryLine = `[manifest-driver] manifest=${manifest.id} role=${manifest.role} comparisonId=${comparisonId ?? '(cloud off)'} arms=${scoredArms.length} failed=${failedArms.length}`;
  writeOutput({ manifestId: manifest.id, role: manifest.role, comparisonId, tier, arms: results }, outFile, summaryLine);
  if (failedArms.length > 0) {
    process.stderr.write(`  [manifest-driver] manifest: arm(s) failed: ${failedArms.join(', ')} — INCONCLUSIVE for those; siblings recorded normally\n`);
  }
}
