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

/** Pre-registered Phase-14 decision window (docs/completed/tiered-recall-audit-pipeline.md
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

/** Read + parse the local JSONL log. A malformed line is skipped (logged),
 * never fatal — a single corrupt record must not blank the whole summary. */
export function readRecords(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); }
    catch { process.stderr.write(`  [tiered-shadow-summary] skipping malformed line ${i + 1}\n`); return null; }
  }).filter(Boolean);
}

/**
 * @param {object[]} records
 * @returns {{totalRuns:number, comparedRuns:number, legacyFailures:number,
 *   shadowFailures:number, costDeltaUsd:object, latencyDeltaSec:object,
 *   findingOverlapRate:object, tieredRunStatusCounts:object}}
 *
 * `totalRuns` counts every observation attempted (including ones where
 * either pipeline failed); `comparedRuns` counts only records where BOTH
 * pipelines completed and a real cost/latency/overlap comparison exists.
 * The Phase-14 decision needs DECISION-GRADE data points — see
 * `windowProgress()` below, which gates on `comparedRuns`, not `totalRuns`
 * (fixed 2026-07-13: the CLI/dashboard previously both gated on
 * `totalRuns`, so a run of the window's runs failing outright could read
 * as "window met" while zero real comparisons existed).
 */
export function summarize(records) {
  const legacyFailures = records.filter((r) => !r.legacyOk).length;
  const shadowFailures = records.filter((r) => r.legacyOk && !r.shadowOk).length;
  const compared = records.filter((r) => r.comparison);
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
    comparedRuns: compared.length,
    costDeltaUsd: { mean: mean(costDeltas), median: median(costDeltas) },
    latencyDeltaSec: { mean: mean(latencyDeltas), median: median(latencyDeltas) },
    findingOverlapRate: { mean: mean(overlapRates), median: median(overlapRates) },
    tieredRunStatusCounts: compared.reduce((acc, r) => {
      const s = r.comparison.tieredRunStatus || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
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
