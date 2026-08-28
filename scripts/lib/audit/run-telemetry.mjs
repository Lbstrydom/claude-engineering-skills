/**
 * @fileoverview Phase 4d of the finalization-tail split
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4) — learning
 * and observation telemetry: local outcomes.jsonl, cloud findings/pass-stats
 * durable writes, the model-A/B/C generation shadow, bandit + false-positive
 * tracker flushes, and the adaptive-learning `convergence_predict` /
 * `author_tier` observation decisions.
 *
 * A PURE RELOCATION of `runLegacyProductionAudit`'s telemetry block, verbatim
 * except for parameter threading (`data`/`assembled`/`mergedResult`/
 * `telemetryServices` replace closure variables). Every operation here is
 * best-effort per the plan's finalization behavior matrix: a telemetry
 * failure is logged and swallowed, and must NEVER propagate to fail 4b/4c's
 * already-committed result. `cacheMetrics`/`totalUsage`/`isR2Plus` are
 * already-computed inputs on `FinalizationData` (not this module's own
 * computation) — this module only performs the I/O-having steps.
 *
 * @module scripts/lib/audit/run-telemetry
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendOutcome } from '../findings.mjs';
import { getActiveRevisionId } from '../prompt-registry.mjs';
import { durableWrite } from '../durable-write.mjs';
import { costFromUsage } from '../model-pricing.mjs';
import { writeLearningState, tallyWriteOutcomes, AUDIT_DIR } from '../robustness.mjs';
import { evaluateConvergence } from './convergence.mjs';
import { recordDecision as _learningRecordDecision } from '../learning/decision-logger.mjs';
import { deriveSignals as _deriveTierSignals, buildAuthorTierObservation as _buildAuthorTierObservation } from '../learning/author-tier-observation.mjs';
import { loadDomainRules as _loadDomainRules, computeTargetDomains as _computeTargetDomains } from '../symbol-index/domain-tagger.mjs';
import { validateFinalizationData, validateAssembledFindings, validateTelemetryServices } from './finalization-contract.mjs';

/**
 * Runs every telemetry side effect the spine used to run inline, in the
 * ORIGINAL source order. Mutates `mergedResult` (only for `_modelAbShadow`)
 * and `telemetryServices.writeOutcomes` in place; returns nothing — per the
 * finalization behavior matrix, 4d's outputs are observation-only and never
 * feed 4b/4c or the coordinator's result composition.
 *
 * @param {import('./finalization-contract.mjs').FinalizationDataSchema} data
 * @param {import('./finalization-contract.mjs').AssembledFindingsSchema} assembled
 * @param {Record<string, unknown>} mergedResult - shared composed result object
 * @param {import('./finalization-contract.mjs').TelemetryServicesSchema} telemetryServices
 */
export async function runTelemetry(data, assembled, mergedResult, telemetryServices) {
  validateFinalizationData(data);
  validateAssembledFindings(assembled);
  validateTelemetryServices(telemetryServices);

  const {
    round, cloudRunId, cloudRepoId, learningWritesAllowed,
    bandit, fpTracker, changedFiles, diffLinesChanged, planContent,
    subjectFiles, isR2Plus,
  } = data;
  const { allFindings, passRegistry } = assembled;
  const { writeOutcomes } = telemetryServices;

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
    // `fpPassSuppressedCount`, NOT `suppressionData.suppressedCount` — the
    // latter is the LEDGER count (stays 0 when only the FP passes fired); a
    // real-audit bug fix, see finalization-contract.mjs's field comment.
    if ((isR2Plus || (assembled.fpPassSuppressedCount > 0)) && mergedResult._suppression) {
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
      const { runGenerationShadow } = await import('../audit-shadow.mjs');
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

  // Persist cache metrics to a stable append-only log (.audit/cache-metrics.jsonl)
  // so future analysis (`npm run cache:check`) can correlate hit rates over
  // time without depending on Temp-dir result files (which Windows cleans).
  // Every round emits one line — analysis filters by round >= 2 since cold-start
  // R1 always reports 0%.
  //
  // Ownership vs. execution order (Cluster C audit finding, disclosed
  // deviation): the plan names "cache telemetry" as 4d's own — this block
  // stays here, in run-telemetry.mjs, not run-persistence.mjs. But in the
  // pre-split source this append physically sat AFTER the session-ledger/
  // session-manifest writes that are now in run-persistence.mjs (4c) — and
  // the coordinator's mandated 4b→4d→4c order runs this BEFORE those writes,
  // not after. No data dependency is broken (this block only reads
  // `mergedResult._cacheMetrics`, set well before either stage runs), so the
  // observable effect is limited to the crash window: this line can now be
  // written even on a run that subsequently fails permanently in 4c, where
  // originally it could not. Kept here rather than physically relocated to
  // run-persistence.mjs, because true byte-order fidelity would put a
  // telemetry write inside the persistence module — contradicting its own
  // domain ownership for a cosmetic ordering match.
  try {
    const cacheMetrics = mergedResult._cacheMetrics;
    if (cacheMetrics) {
      const logPath = path.resolve(AUDIT_DIR, 'cache-metrics.jsonl');
      const entry = {
        sid: data.debtRunId,
        round,
        startedAt: new Date().toISOString(),
        mode: 'code',                     // runMultiPassCodeAudit is code-mode only
        plan: data.planFile ? path.basename(data.planFile) : null,
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
export async function classifyShadowFailureSafe(err, importShadowModule = () => import('../audit-shadow.mjs')) {
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
