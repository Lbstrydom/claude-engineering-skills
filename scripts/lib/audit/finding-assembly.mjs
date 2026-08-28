/**
 * @fileoverview Phase 4b of the finalization tail split
 * (docs/plans/legacy-production-audit-decomposition.md) — pass-result-
 * registry assembly, run-wide finding-counter/id assignment and registry
 * merge, post-output suppression, deterministic finding-verification gate,
 * ledger auto-write, and shared-verdict computation.
 *
 * A pure function of `FinalizationData` (`assembleFindings(data)`): it does
 * not mutate its input and returns a NEW `AssembledFindings` value. Ledger
 * auto-write physically stays here (not in run-persistence.mjs, despite
 * being ledger-shaped) — it sits inline in the ORIGINAL code between the
 * verification gate and verdict computation, reading the gate's own output
 * (a refuted finding must be known BEFORE the write), and this plan's
 * dependency direction prohibits 4b from importing 4c to call it out-of-line.
 *
 * Extracted verbatim from `legacy-production-audit.mjs`'s tail — no behavior
 * change beyond taking one `data: FinalizationData` param instead of closing
 * over the orchestrator's own locals.
 *
 * @module scripts/lib/audit/finding-assembly
 */

import { normalizeArchCategory, computeAuditVerdict } from './findings-pipeline.mjs';
import { semanticId } from '../findings.mjs';
import {
  populateFindingMetadata, suppressReRaises,
  computeFixLifecycleUpdates, applyLifecycleUpdates, generateTopicId, batchWriteLedger,
} from '../ledger.mjs';
import { normalizePath } from '../file-io.mjs';
import { listRepoFiles } from '../repo-inventory.mjs';
import { verifyExistenceFindings, effectiveSeverity, countsTowardVerdict, isRefuted } from './finding-verification.mjs';
import { runSuppressionPasses } from '../suppression-policy.mjs';
import { reconcileRemediationProjection, markFindingsRemediation } from '../../learning-store.mjs';
import { appendEvents, mergeLedgers as mergeLedgersForSuppression } from '../debt-memory.mjs';
import { wireModel } from './llm-helpers.mjs';
// Documented allow-list exception (final-review finding, union-diff gate):
// the plan's literal dependency-direction text allows a stage module to
// import only finalization-contract.mjs + "pre-existing domain primitives" —
// map-reduce-scheduler.mjs is itself a Phase-2 module of THIS decomposition,
// not a pre-existing primitive. Needed here because the cache-metrics
// computation below (a direct continuation of pass-registry assembly, moved
// into 4b's own output) reads the run-scoped cache-seed state
// map-reduce-scheduler.mjs already owns. Asserted explicitly, not silently
// allowed: tests/finalization-module-layering.test.mjs.
import { getSeedTelemetry } from './map-reduce-scheduler.mjs';
import { costFromUsage } from '../model-pricing.mjs';
import { openaiConfig } from '../config.mjs';

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
export function dedupReplacementId(existingId, existingSeverity, newSeverity, findingCounter) {
  if (existingSeverity === newSeverity) return existingId;
  findingCounter[newSeverity]++;
  const letter = newSeverity === 'HIGH' ? 'H' : newSeverity === 'MEDIUM' ? 'M' : 'L';
  return `${letter}${findingCounter[newSeverity]}`;
}

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

/**
 * Assemble, dedup, suppress, verify and verdict-score this run's findings.
 * Pure function of `FinalizationData` — does not mutate `data`.
 * @param {import('./finalization-contract.mjs').FinalizationDataSchema} data
 * @returns {Promise<import('./finalization-contract.mjs').AssembledFindingsSchema>}
 */
export async function assembleFindings(data) {
  const {
    runStructure, structureResult, runWiring, wiringResult, backendPassNames, backendResults,
    frontendWillRun, frontendResult, runSustainability, sustainResult, runQuickfix, quickfixResult,
    runDuplication, duplicationResult, runAdjacency, adjacencyResult,
    archState, archResult, orphanState, orphanResult, eventWiringState, eventWiringResult,
    toolFindings, ledger, debtLedger, changedFiles, impactSet, cloudRepoId, cloudFpPolicy, fpTracker,
    ledgerFile, noLedger, round, strictLint, debtRunId, debtContext, debtEventsPath, newlyEscalated,
    totalLatency,
  } = data;

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

  const linterOverlapData = { linterOverlapCount, linterOnlyCount, gptOnlyCount };

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
  let suppressionData;
  let debtMemoryData;

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
    suppressionData = {
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

    debtMemoryData = {
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
    suppressionData: suppressionData ?? null,
    cloudEnabled: cloudRepoId != null,
    log: (line) => process.stderr.write(line),
  });
  allFindings.length = 0;
  allFindings.push(...passes.findings);
  suppressionData = passes.suppressionData ?? undefined;

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
  let ledgerRejectedCount;
  let ledgerWriteError;
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
        ledgerRejectedCount = rejected.length;
      }
    } catch (err) {
      process.stderr.write(`  [ledger] WRITE FAILED: ${err.message}\n`);
      ledgerWriteError = err.message;
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
  // returns a bare `null`, so this dereference is safe.
  // Cache discounts are ignored (a slight over-estimate, the conservative
  // direction for a cost comparison).
  totalUsage.costUsd = costFromUsage(totalUsage, openaiConfig.model).totalUsd;

  // ── Cache telemetry (PR-4) ───────────────────────────────────────────
  // Aggregate prompt-prefix-cache hit metrics across all audit-pass calls.
  // hitRate guard: 0/0 → 0 (per Gemini R2 review of plan).
  // Per-pass entries keyed by passName; map-reduce sub-units use their
  // map-<passName>-<i> keys (kept distinct for diagnostic per-unit visibility,
  // per plan §2 telemetry contract).
  // Effective cache-seed state for this run (plan R1-M4): true iff ≥1 pass
  // actually warmed the prefix cache (decideSeed→seedUsed), NOT just the env
  // flag. Powers the seed-ON cohort in `cache-hitrate-check`.
  const _seedTelemetry = getSeedTelemetry();
  const cacheMetrics = {
    totalInputTokens: totalUsage.input_tokens,
    totalCachedTokens: totalUsage.cached_tokens,
    hitRate: totalUsage.input_tokens > 0
      ? totalUsage.cached_tokens / totalUsage.input_tokens : 0,
    estimatedSavingsPct: 0,
    seedUsed: _seedTelemetry.seedUsed,
    seedEligible: _seedTelemetry.seedEligible,
    seedSkipReason: _seedTelemetry.seedSkipReason,
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

  return {
    allFindings, passRegistry, allResults, failedPasses, verdict, high, medium, low, reopenedSet,
    linterOverlapData, totalUsage, cacheMetrics, passTimings, summaryLines,
    ...(suppressionData !== undefined ? { suppressionData } : {}),
    ...(debtMemoryData !== undefined ? { debtMemoryData } : {}),
    ...(ledgerRejectedCount !== undefined ? { ledgerRejectedCount } : {}),
    ...(ledgerWriteError !== undefined ? { ledgerWriteError } : {}),
  };
}
