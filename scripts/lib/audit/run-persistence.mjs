/**
 * @fileoverview Phase 4c of the finalization-tail split
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4) — ledger and
 * audit-record persistence: R2+ ledger validation, commit-provenance gate
 * evidence, cloud run-record finalization (`audit.runComplete`,
 * `reconcileCompletionRow`), the `pass_selection` learning-outcome backfill,
 * and the session ledger / SID-scoped manifest.
 *
 * A PURE RELOCATION, verbatim except for parameter threading. Per the plan's
 * finalization behavior matrix, 4c never WRITES `runStatus` — it contributes
 * a separate `cloudPersistence` field ('persisted' | 'local-only') that the
 * coordinator folds in alongside whatever `runStatus` 4b already established.
 *
 * @module scripts/lib/audit/run-persistence
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyLedgerEntry, batchWriteLedger } from '../ledger.mjs';
import { atomicWriteFileSync } from '../file-io.mjs';
import { durableWrite } from '../durable-write.mjs';
import { writeLearningState, tallyWriteOutcomes, AUDIT_DIR, SESSION_MANIFEST_PREFIX, SESSION_LEDGER_FILE } from '../robustness.mjs';
import { evaluateConvergenceWithDetectors, resolveDetectorResultForRound } from './convergence.mjs';
import { checkDetectors } from './detector.mjs';
import { insertLearningDecision, backfillLearningOutcome, isCloudEnabled } from '../../learning-store.mjs';
import { recordDecision as _learningRecordDecision, flush as _learningFlush, buildDecisionKey as _learningBuildKey } from '../learning/decision-logger.mjs';
import { validateFinalizationData, validateAssembledFindings, validatePersistenceServices } from './finalization-contract.mjs';

/**
 * Validates an R2+ ledger file for suppression input. Round < 2 is always
 * valid (no ledger required yet).
 *
 * `incomplete` (a valid batch-shape entry that is not a complete ruling) is
 * counted apart from `invalid` — a normal round-2 ledger with nothing yet
 * adjudicated logging `0 valid, N invalid` reads as corrupt; it is not.
 *
 * @param {string|null} ledgerPath
 * @param {number} round
 */
export function validateLedgerForR2(ledgerPath, round) {
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
 * Compact, store-shaped provenance for one round's suppression —
 * `audit_runs.suppression_stats`.
 *
 * **The denominator is the point.** `_suppression` records how many findings
 * were kept, suppressed and reopened; it has never recorded how many RULINGS
 * they were matched against, and `recordSuppressionEvents` writes one row per
 * match (zero rows when there were none). So a round that matched against an
 * all-pending ledger — nothing to suppress WITH — was byte-identical downstream
 * to one that matched against a full ruling set and found nothing to suppress.
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

/**
 * Runs every persistence side effect the spine used to run inline, in the
 * ORIGINAL source order: commit-provenance gate evidence, cloud run-record
 * finalization + pass_selection outcome backfill + reconciliation, then the
 * session ledger + SID-scoped manifest.
 *
 * Mutates `mergedResult` (only for `_gateEvidenceUnwritten`, `_sid`) and
 * `persistenceServices.writeOutcomes` in place. Returns `{cloudPersistence}`
 * — an ORTHOGONAL signal to `runStatus` (4b's), never a replacement for it;
 * the coordinator folds both into the final result.
 *
 * @param {import('./finalization-contract.mjs').FinalizationDataSchema} data
 * @param {import('./finalization-contract.mjs').AssembledFindingsSchema} assembled
 * @param {Record<string, unknown>} mergedResult - shared composed result object
 * @param {import('./finalization-contract.mjs').PersistenceServicesSchema} persistenceServices
 * @returns {Promise<{cloudPersistence: 'persisted'|'local-only'}>}
 */
export async function runPersistence(data, assembled, mergedResult, persistenceServices) {
  validateFinalizationData(data);
  validateAssembledFindings(assembled);
  validatePersistenceServices(persistenceServices);

  const {
    ctx, round, cloudRunId, noCloudRecording, learningWritesAllowed,
    debtRunId, ledgerFile, ledgerStats, totalLatency, diffLinesChanged,
    diffFilesChanged, sessionCacheHit, mapReducePasses,
    suppressionUnavailable, ledger,
  } = data;
  // bf45c2f7: `high`/`medium` are 4b's own effSeverity/countFor-derived
  // counts, not recomputed from raw allFindings/f.severity — see the fuller
  // rationale at their use below.
  const { allFindings, totalUsage, cacheMetrics, high, medium } = assembled;
  const { writeOutcomes } = persistenceServices;
  const _ledgerWriteError = mergedResult._ledgerWriteError;

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
  let cloudPersistence = 'local-only';
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
    cloudPersistence = 'persisted';
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
    if (finalTally !== completionTallySnapshot) {
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

  return { cloudPersistence };
}
