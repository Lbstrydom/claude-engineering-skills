/**
 * @fileoverview Pure aggregation for Close-out tiered-shadow observations —
 * extracted from the `tiered-shadow-report.mjs` CLI (2026-07-13, dashboard
 * UX batch) so it's a real reusable lib module instead of a dashboard
 * collector importing a CLI entry point (the entry-guard made that
 * import-SAFE, but not architecturally appropriate — a reusable
 * dashboard/data-collection layer should not depend on a command's
 * executable module). The CLI now imports FROM here; behavior is
 * unchanged, this is a pure relocation.
 *
 * `readRecords` was previously private to the CLI, forcing the dashboard
 * collector to hand-roll a second, less careful JSONL parser (no
 * malformed-line logging). Now both share the exact same read path.
 *
 * @module scripts/lib/audit/tiered-shadow-summary
 */
import fs from 'node:fs';

/** Pre-registered Phase-14 decision window (docs/plans/tiered-recall-audit-pipeline.md
 * Close-out). Single source — the CLI text output and the dashboard
 * progress bar both import these instead of hardcoding the numbers twice. */
export const WINDOW_MIN = 10;
export const WINDOW_MAX = 15;

/** DB row (snake_case) → the exact shape `summarize()` expects (camelCase,
 * matching the local JSONL record shape) — one normalizer so both sources
 * feed the SAME aggregation logic, no duplicated math. */
export function normalizeDbRow(row) {
  return {
    legacyOk: row.legacy_ok, shadowOk: row.shadow_ok,
    shadowError: row.shadow_error, comparison: row.comparison,
    _repoId: row.repo_id,
  };
}

export function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(nums) {
  return nums.length === 0 ? null : nums.reduce((s, n) => s + n, 0) / nums.length;
}

/** A record must be a plain, non-array, non-null object whose `legacyOk`
 * field is a real boolean — the ONE field every real record is guaranteed
 * to carry (recordObservation in tiered-shadow-compare.mjs sets it in BOTH
 * branches; the DB persistence schema, AppendObservationSchema in
 * store/tiered-shadow.mjs, requires it non-optional). A scalar, array, or
 * `null` parses successfully via JSON.parse but is NOT a record: property
 * access on it doesn't throw (JS auto-boxes/returns `undefined`), so it
 * silently reads as "no legacyOk" and gets counted as a legacyFailure.
 * `{}` has the same failure mode without even needing a type-coercion bug —
 * round-2 audit H2 caught this: rejecting only scalars/arrays/null still let
 * `{}`, `{legacyOk:"yes"}`, and `{comparison:null}` through, each silently
 * miscounted rather than flagged. This is item 10 (arch-audit-pipeline-
 * observability-hardening.md). Not validating the FULL shape (shadowOk,
 * comparison, etc.) on purpose — legacyOk is the only field summarize()
 * cannot degrade gracefully without; the rest already have `?? `/`||`
 * defaults precisely because a partial record IS a legitimate shape
 * (e.g. a legacy-only failure has no `comparison`). */
function isRecordShaped(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.legacyOk === 'boolean';
}

/** Read + parse the local JSONL log. A malformed line is skipped (logged),
 * never fatal — a single corrupt record must not blank the whole summary. */
export function readRecords(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line, i) => {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { process.stderr.write(`  [tiered-shadow-summary] skipping malformed line ${i + 1}\n`); return null; }
    if (!isRecordShaped(parsed)) {
      process.stderr.write(`  [tiered-shadow-summary] skipping non-record line ${i + 1} (parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object)\n`);
      return null;
    }
    return parsed;
  }).filter(Boolean);
}

/**
 * @param {object[]} records
 * @returns {{totalRuns:number, historicalCompleteRuns:number, comparedRuns:number,
 *   legacyFailures:number, shadowFailures:number, excludedNoStage0Evidence:number,
 *   excludedDegenerateComparison:number, excludedFallback:number,
 *   excludedMalformedAnchors:number,
 *   costDeltaUsd:object, latencyDeltaSec:object, findingOverlapRate:object,
 *   tieredRunStatusCounts:object, tieredFallbackReasons:object,
 *   shadowFailureReasons:object}}
 *
 * **Two reason breakdowns, deliberately** (docs/plans/shadow-no-legacy-fallback.md):
 * `tieredFallbackReasons` reports HISTORICAL `fallback_legacy` rows (the 41
 * pre-plan records; the shadow no longer produces that status).
 * `shadowFailureReasons` reports LIVE causes, since a required-generator
 * failure now lands as `shadowOk:false` + `shadowError`. Both group by raw
 * string — never bucketed, because 19/41 live rows are multi-cause and
 * bucketing would mis-attribute them.
 *
 * `totalRuns` counts every observation attempted (including ones where
 * either pipeline failed).
 *
 * **TWO NAMED, NON-OVERLAPPING completion metrics** (docs/plans/stage0-evidence-relevance-split.md
 * round-3 plan-audit M1 — never conflated):
 *
 *  - `historicalCompleteRuns` — the PRE-EXISTING metric, unchanged:
 *    `tieredRunStatus === 'complete'`, regardless of row shape. Old-shape
 *    rows (`tieredEligibleCount` absent/null, written before the
 *    evidence-relevance split) count here exactly as they did before.
 *  - `comparedRuns` — the NEW, STRICTER, Phase-14-decision-grade metric:
 *    `complete` AND both eligible-count fields confirmed numbers (an
 *    old-shape row's null/absent field is EXCLUDED — insufficient data,
 *    never "zero confirmed") AND at least ONE side's population non-empty.
 *    Deliberately `||`, not the plan's original symmetric `&&` (corrected at
 *    implementation, 2026-07-16): requiring BOTH sides non-empty silently
 *    dropped every one-sided run — legacy-found-tiered-missed (a recall
 *    failure) and tiered-found-legacy-missed (tiered's value-add) — i.e.
 *    exactly the runs the Phase-14 decision most needs, biasing the
 *    surviving overlap rate upward toward a false "flip it". Only a
 *    both-sides-empty run is genuinely uninformative for recall and is
 *    excluded as degenerate. `windowProgress()` consumes ONLY this.
 *
 * Round-1 plan-audit M3: `stage0Verified > 0` alone still admits a
 * degenerate run — the population requirement above (with the one-sided
 * correction) is the real fix.
 *
 * Three EXCLUSION REASONS are reported separately (never collapsed into one
 * count) so an operator can tell "nothing verifiable" apart from "verifiable
 * but degenerate" apart from "fell back to legacy" at a glance.
 *
 * **2026-07-14 incident fix** (retained): `compareAuditRunResults` builds a
 * non-null `comparison` object even when the tiered pipeline fell back to
 * legacy (`tieredRunStatus:'fallback_legacy'`) — a real record worth keeping
 * (it shows the fallback happened), but NOT a genuine tiered-vs-legacy
 * comparison, and it must never count toward the decision window. Before
 * that fix, `compared = records.filter(r => r.comparison)` let 20/20
 * all-fallback observations read as "window met". `tieredRunStatusCounts`
 * and `tieredFallbackReasons` are computed over the WIDER `withComparison`
 * set so the fallback breakdown stays visible even while `comparedRuns`
 * correctly reads 0.
 */
export function summarize(records) {
  const legacyFailures = records.filter((r) => !r.legacyOk).length;
  const shadowFailures = records.filter((r) => r.legacyOk && !r.shadowOk).length;
  const withComparison = records.filter((r) => r.comparison);
  // The PRE-EXISTING metric — deliberately unchanged by this plan.
  const historicalComplete = withComparison.filter((r) => r.comparison.tieredRunStatus === 'complete');
  // The NEW, stricter, decision-grade metric. Two parts, deliberately split:
  //  1. SHAPE — both eligible-count fields must be confirmed numbers. An
  //     old-shape (pre-split) row's null/absent field is insufficient data,
  //     never "zero population confirmed" — asserted explicitly rather than
  //     relying on `null > 0` coercion by accident.
  //  2. POPULATION — at least ONE side non-empty (`||`, NOT `&&`). The
  //     symmetric `&&` the plan originally specified was a vestige of an
  //     earlier eligibility design (a post-bucketing subset); once Gemini
  //     round-2 G2 collapsed eligibility to "reached the comparison at all",
  //     `&&` reduced to "both pipelines found ≥1 finding" — a selection bias
  //     in the DANGEROUS direction: it drops exactly the one-sided runs
  //     (legacy-found-tiered-missed = recall failure; tiered-found-legacy-
  //     missed = tiered's value-add) that the Phase-14 decision most needs,
  //     inflating the headline overlap rate toward a false "flip it". Only a
  //     both-sides-empty run carries no recall information and is excluded
  //     as degenerate. This also keeps the overlap-rate denominator
  //     (legacyFindingCount + onlyTieredCount) non-zero for every compared
  //     run — the null-rate branch stays unreachable by construction.
  const hasComparablePopulation = (c) =>
    typeof c.tieredEligibleCount === 'number' &&
    typeof c.legacyEligibleCount === 'number' &&
    (c.tieredEligibleCount > 0 || c.legacyEligibleCount > 0);
  // evidence-anchor-path-contract §7c — the anti-green rule with teeth.
  // A run whose candidates were destroyed by OUR OWN schema is a contract
  // failure, not a tiered-vs-legacy comparison: counting it would repeat the
  // exact class of false-green this metric has already produced four times.
  //
  // TWO signals, because the contract can break at TWO layers (found by the
  // consolidated union gate, 2026-07-17 — a seam between this plan's clusters):
  //   - `stage0MalformedTripwire` (envelope) — the V2 path, where a raw model
  //     anchor reached Stage 0 and failed `EvidenceAnchorSchema` there.
  //   - `discoveryMalformedRaw` (raw) — the V3 producer boundary. Under the
  //     enum contract, `prepareCandidates` rejects an our-schema failure BEFORE
  //     Stage 0, so it NEVER creates an envelope and the tripwire is 0 by
  //     construction (§9a). Keying the exclusion only on the tripwire left this
  //     exclusion DEAD for the V3 path: a run where our enum ate every
  //     candidate (verified 0, discoveryMalformedRaw N) escaped exclusion and,
  //     with any legacy findings, polluted comparedRuns as a false 0%-overlap
  //     recall failure — the precise vacuity this whole plan exists to kill.
  // Either signal, with nothing verified, is a contract failure.
  //
  // `typeof === 'number'` (never truthiness): a historical row predating a
  // field reads `undefined` = insufficient data, NOT "zero confirmed" — the
  // same shape-check `hasComparablePopulation` uses above.
  const isContractFailure = (c) => {
    if (typeof c.tieredStage0Verified !== 'number' || c.tieredStage0Verified !== 0) return false;
    const tripwire = typeof c.tieredStage0MalformedTripwire === 'number' && c.tieredStage0MalformedTripwire > 0;
    const producerBoundary = typeof c.tieredDiscoveryMalformedRaw === 'number' && c.tieredDiscoveryMalformedRaw > 0;
    return tripwire || producerBoundary;
  };
  // Excluded BEFORE the population check: its tiered side is empty because our
  // schema ate the candidates, so a legacy-only population would otherwise let
  // it count as a legitimate 0%-overlap "recall failure" — attributing OUR bug
  // to the tiered pipeline's quality.
  const compared = historicalComplete
    .filter((r) => !isContractFailure(r.comparison))
    .filter((r) => hasComparablePopulation(r.comparison));

  // Exclusion reasons — computed over the same record sets, reported
  // separately (round-3 plan-audit M1's "not collapsed into one count").
  const excludedFallback = withComparison.filter((r) => r.comparison.tieredRunStatus === 'fallback_legacy').length;
  const notCompared = historicalComplete.filter((r) => !hasComparablePopulation(r.comparison));
  // "Tiered found nothing verifiable at all" — Stage 0 verified zero
  // candidates. Distinct from a degenerate-but-nonzero-evidence run. Under
  // the `||` predicate this class only lands here when the LEGACY side was
  // ALSO empty (a one-sided tiered-zero run with legacy findings now
  // correctly COUNTS as a comparison — a 0% overlap is recall signal, not a
  // measurement artifact).
  const excludedNoStage0Evidence = notCompared.filter((r) => r.comparison.tieredStage0Verified === 0).length;
  const excludedDegenerateComparison = notCompared.length - excludedNoStage0Evidence;

  const excludedMalformedAnchors = withComparison.filter((r) => isContractFailure(r.comparison)).length;

  const costDeltas = compared.map((r) => (r.comparison.legacyCostUsd != null && r.comparison.tieredCostUsd != null) ? r.comparison.tieredCostUsd - r.comparison.legacyCostUsd : null).filter((v) => v != null);
  const latencyDeltas = compared.map((r) => (r.comparison.legacyLatencySec != null && r.comparison.tieredLatencySec != null) ? r.comparison.tieredLatencySec - r.comparison.legacyLatencySec : null).filter((v) => v != null);
  const overlapRates = compared.map((r) => {
    const total = r.comparison.legacyFindingCount + r.comparison.onlyTieredCount;
    return total > 0 ? r.comparison.overlapCount / total : null;
  }).filter((v) => v != null);

  return {
    totalRuns: records.length,
    legacyFailures,
    shadowFailures,
    historicalCompleteRuns: historicalComplete.length,
    comparedRuns: compared.length,
    excludedNoStage0Evidence,
    excludedDegenerateComparison,
    excludedFallback,
    // evidence-anchor-path-contract §7c — reported as its OWN named reason,
    // never folded into excludedNoStage0Evidence: "our schema ate the
    // candidates" and "the tiered pipeline found nothing" look identical in
    // the aggregate and have opposite fixes.
    excludedMalformedAnchors,
    costDeltaUsd: { mean: mean(costDeltas), median: median(costDeltas) },
    latencyDeltaSec: { mean: mean(latencyDeltas), median: median(latencyDeltas) },
    findingOverlapRate: { mean: mean(overlapRates), median: median(overlapRates) },
    tieredRunStatusCounts: withComparison.reduce((acc, r) => {
      const s = r.comparison.tieredRunStatus || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {}),
    tieredFallbackReasons: withComparison
      .filter((r) => r.comparison.tieredRunStatus === 'fallback_legacy')
      .reduce((acc, r) => {
        const reason = r.comparison.tieredFallbackReason || 'unknown';
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
    // The shadow no longer falls back (plan:
    // docs/plans/shadow-no-legacy-fallback.md) — a required-generator failure
    // now surfaces as `shadowOk:false` + a `shadowError` reason instead of a
    // `fallback_legacy` comparison row. So `tieredFallbackReasons` above goes
    // quiet for NEW rows (it still reports the 41 historical ones), and this
    // is where a live cause shows up. Without it the change would trade one
    // silent-failure mode for another — the exact anti-pattern this whole
    // effort exists to end (decision #4).
    //
    // Deliberately byte-identical in shape to the reducer above: group by the
    // RAW reason string, no coarse bucketing. That is not laziness — 19 of the
    // 41 live fallback rows carry TWO generator causes in one string
    // (`sonnet: …; glm: [timeout] …`), so bucketing into one class would
    // mis-attribute the majority of the corpus, and a diagnostic that lies is
    // worse than none. A multi-cause row is simply its own key.
    shadowFailureReasons: records
      .filter((r) => r.legacyOk && !r.shadowOk)
      .reduce((acc, r) => {
        const reason = r.shadowError || 'unknown';
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),

    // Every shadow failure by reason, INDEPENDENT of legacyOk (WS-B3).
    //
    // The reducer above requires `legacyOk`, and `legacyFailures`/`shadowFailures`
    // are a deliberate non-overlapping precedence — correct for COUNTS. But it
    // means a record where BOTH pipelines failed loses its shadow reason into an
    // anonymous `legacyFailures` tally, and when both fail the shadow reason is
    // precisely the diagnostic signal. 51 records reading
    // `providers.anthropicClient unavailable` were invisible this way, and the
    // window was misread as intermittent flakiness rather than one keyless
    // 14-hour session (2026-07-16/17).
    //
    // Additive: the precedence above is untouched, so no existing metric moves.
    shadowFailureReasonsAll: records
      .filter((r) => !r.shadowOk && r.shadowError)
      .reduce((acc, r) => {
        const reason = r.shadowError || 'unknown';
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
  };
}

/**
 * Phase-14 window progress against the DECISION-GRADE metric
 * (`comparedRuns`, not `totalRuns` — see `summarize()`'s doc comment).
 * @param {number} comparedRuns
 * @returns {{met: boolean, withinWindow: boolean, min: number, max: number}}
 */
export function windowProgress(comparedRuns) {
  return {
    met: comparedRuns >= WINDOW_MAX,
    withinWindow: comparedRuns >= WINDOW_MIN,
    min: WINDOW_MIN,
    max: WINDOW_MAX,
  };
}
