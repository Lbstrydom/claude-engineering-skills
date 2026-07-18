/**
 * @fileoverview The containment-adjacency wave's result composer — the SOLE
 * owner of the final result, and the only place `buildAdjacencyState` is called.
 *
 * Plan: docs/plans/adjacency-check-containment.md §D9a.
 *
 * **Why a separate module for ~40 lines.** Incompleteness is produced at three
 * different stages: mechanical analysis (input bounds, parse failures,
 * enumeration caps), prompt formatting/egress (a candidate whose minimum context
 * will not fit), and the bouncer (a completeness violation → fallback). The last
 * two happen AFTER the detector has returned. An earlier design had the detector
 * compute the state, which made the honesty invariants — "every incompleteness
 * emits a control finding", "`clean` is forbidden when incompleteness exists" —
 * unenforceable against a state that was stale by construction: a
 * formatting-stage incompleteness could coexist with a `clean` label.
 *
 * The fix is structural: the detector returns FACTS, every stage contributes
 * facts, and exactly ONE call composes them at the end. Keeping that call out of
 * both the detector and the orchestrator is what makes "called from exactly one
 * place" a greppable, testable invariant rather than a convention — see the
 * guard in tests/adjacency-compose.test.mjs.
 *
 * @module scripts/lib/audit/adjacency-compose
 */

import { buildAdjacencyState, assertCleanIsEarned } from './adjacency-state.mjs';
import {
  mapDecisionsToFindings,
  deriveFindingsFromAdjacencyReport,
  buildAdjacencyIncompleteFinding,
  buildAdjacencyFailedFinding,
} from './adjacency-report.mjs';

/**
 * Merge every stage's facts, derive the state once, and turn the result into
 * the findings the audit consumes.
 *
 * @param {object} args
 * @param {object} args.analysis - `runAdjacencyAnalysis` output (facts, not a state)
 * @param {object|null} [args.bouncer] - `runAdjacencyBouncer` output, or null if not run
 * @param {boolean} [args.selected=true]
 * @param {boolean} [args.diffContractAvailable=true]
 * @returns {{result:object, findings:object[]}}
 */
export function composeAdjacencyResult({
  analysis,
  bouncer = null,
  selected = true,
  diffContractAvailable = true,
} = {}) {
  const analysisInc = analysis?.incompleteness ?? [];
  const bouncerInc = bouncer?.incompleteness ?? [];
  const evidence = analysis?.candidates ?? [];

  // ── Resolve the judgement BEFORE the state is built. ──
  // A completeness violation (the model omitted, duplicated, or invented a
  // candidate id) is a bouncer failure, and it is only discoverable by running
  // the mapper. An earlier ordering ran the mapper *after* `buildAdjacencyState`
  // inside finding-derivation, so that failure silently degraded to the
  // deterministic fallback and was NEVER recorded as incompleteness — no
  // `bouncer-degraded` record, no control finding, and the result could still
  // present as full-strength. That is this wave's own defect class (a
  // degradation that produces plausible output and reports nothing), caught by
  // the consolidated Gemini gate. The mapping now happens here, and its outcome
  // feeds the same incompleteness list every other stage feeds.
  let mapped = null;
  if (evidence.length > 0 && bouncer?.ok && Array.isArray(bouncer.decisions)) {
    mapped = mapDecisionsToFindings(bouncer.decisions, evidence, bouncer.includedIds ?? []);
  }

  const degradedInc = [];
  if (bouncer && bouncer.ok === false) {
    degradedInc.push({ kind: 'bouncer-degraded', scope: 'adjacency', detail: bouncer.reason ?? 'bouncer unavailable' });
  } else if (mapped && !mapped.ok) {
    degradedInc.push({ kind: 'bouncer-degraded', scope: 'adjacency', detail: `incomplete judgement — ${mapped.reason}` });
  }

  const incompleteness = [...analysisInc, ...bouncerInc, ...degradedInc];

  // ── The single buildAdjacencyState call in the codebase. ──
  const result = buildAdjacencyState({
    selected,
    diffContractAvailable,
    coverage: analysis?.coverage,
    candidates: evidence,
    incompleteness,
    threw: analysis?.threw ?? null,
  });

  // Belt-and-braces: a hand-built or future-refactored result that claims a
  // clean it did not earn throws here rather than shipping a false green.
  assertCleanIsEarned(result);

  return { result, findings: deriveFindings(result, analysis, bouncer, mapped) };
}

/**
 * Findings are derived from the FACTS (candidates + incompleteness), never from
 * the state label — the label is a summary and must never be able to suppress
 * a finding underneath it.
 */
function deriveFindings(result, analysis, bouncer, mapped) {
  const findings = [];

  if (result.threw || result.reason === 'ADJACENCY_DETECTOR_FAILED' || analysis?.threw) {
    findings.push(buildAdjacencyFailedFinding(analysis?.threw));
  }

  const evidence = result.candidates ?? [];
  if (evidence.length > 0) {
    // `mapped` was resolved by the caller so its failure could be recorded as
    // incompleteness. A completeness violation routes the WHOLE set to the
    // deterministic fallback — a partial judgement is not a judgement.
    findings.push(...(mapped?.ok
      ? mapped.findings
      : deriveFindingsFromAdjacencyReport(evidence, bouncer?.includedIds)));
  }

  // EVERY incompleteness record emits its own control finding — this is what
  // makes "partial coverage" impossible to mistake for a pass.
  for (const record of result.incompleteness ?? []) {
    findings.push(buildAdjacencyIncompleteFinding(record));
  }

  return findings;
}
