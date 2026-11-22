/**
 * @fileoverview Completeness reconciliation, PURE core (docs/plans/own-model-full-capture.md
 * section 2.9, phase P0).
 *
 * Silent loss is made visible by reconciling START EVENTS from lifecycle sources that already
 * exist against their COMPLETIONS, never by trusting the capture path to count itself:
 *
 *   audit-dispatch  starts = `audit_runs` rows          completion = the run's call rows, against
 *                                                        the producing process's own counter
 *   chip-launch     starts = ledger `task` rows         completion = a later ledger `outcome` row
 *   fleet-land      starts = ledger merged outcomes     completion = UNMEASURED: no independent
 *                                                        start event exists yet (P0 reports it so)
 *
 * What cannot be observed is `unmeasured`, never zero loss. Zero starts is `unmeasured:zero-starts`,
 * never 100%. A reader never pools capture schema versions.
 *
 * Everything here is PURE (rows in, verdicts out). The store reads live in `./completeness-queries.mjs`.
 *
 * @module scripts/lib/capture/completeness
 */
import { ATTEMPT_OUTCOMES } from './schema-version.mjs';

/** Closed per-run verdicts for the audit-dispatch source. */
export const RUN_VERDICTS = Object.freeze([
  'reconciled',          // rows observed == recorded - dropped, nothing dropped
  'dropped',             // the buffer cap shed rows and counted them: explained loss
  'gap',                 // fewer rows landed than the producer counted: UNEXPLAINED loss
  'in-flight',           // too young to judge (no summary yet, inside the grace window)
  'unmeasured',          // no producer counter exists: cannot tell loss from "no calls"
]);

/** A run younger than this has not had time to flush its summary. */
export const IN_FLIGHT_GRACE_MS = 6 * 60 * 60 * 1000;
/** A chip younger than this has not had time to land or be abandoned. */
export const CHIP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Judge ONE run. PURE.
 * @param {{started_at: string|Date, summaries: number, recorded: number, dropped: number, rows: number}} r
 * @param {number} nowMs
 * @returns {{verdict: string, expected: number|null, observed: number, missing: number}}
 */
export function judgeRun(r, nowMs) {
  const observed = n(r.rows);
  const summaries = n(r.summaries);
  if (summaries === 0) {
    const age = nowMs - new Date(r.started_at).getTime();
    // No counter. A young run may simply not have flushed; an old one is UNMEASURED, because zero
    // rows and zero summary cannot be told apart from a run that made no model calls at all.
    return { verdict: age < IN_FLIGHT_GRACE_MS ? 'in-flight' : 'unmeasured', expected: null, observed, missing: 0 };
  }
  const recorded = n(r.recorded);
  const dropped = n(r.dropped);
  const expected = Math.max(0, recorded - dropped);
  const missing = Math.max(0, expected - observed);
  if (missing > 0) return { verdict: 'gap', expected, observed, missing };
  if (dropped > 0) return { verdict: 'dropped', expected, observed, missing: 0 };
  return { verdict: 'reconciled', expected, observed, missing: 0 };
}

/**
 * Aggregate audit-dispatch runs per repo x capture_schema_version. PURE.
 * @param {Array<object>} runs one row per run: repo, capture_schema_version (nullable), started_at,
 *   summaries, recorded, dropped, rows, logical_calls, outcomes ({outcome: count})
 * @param {number} nowMs
 */
export function reconcileAuditDispatch(runs, nowMs) {
  const groups = new Map();
  for (const r of runs ?? []) {
    const version = r.capture_schema_version == null ? 'pre-p0' : String(r.capture_schema_version);
    const key = `${r.repo ?? 'unknown'}\u0000${version}`;
    let g = groups.get(key);
    if (!g) {
      g = { repo: r.repo ?? 'unknown', capture_schema_version: version, starts: 0, logical_calls: 0, attempts: 0, expected_attempts: 0,
        missing_attempts: 0, outcomes: Object.fromEntries(ATTEMPT_OUTCOMES.map((o) => [o, 0])), runs_by_verdict: Object.fromEntries(RUN_VERDICTS.map((v) => [v, 0])), gap_runs: [] };
      groups.set(key, g);
    }
    const j = judgeRun(r, nowMs);
    g.starts += 1;
    g.runs_by_verdict[j.verdict] += 1;
    g.logical_calls += n(r.logical_calls);
    g.attempts += j.observed;
    g.expected_attempts += j.expected ?? 0;
    g.missing_attempts += j.missing;
    for (const [o, c] of Object.entries(r.outcomes ?? {})) if (o in g.outcomes) g.outcomes[o] += n(c);
    if (j.verdict === 'gap') g.gap_runs.push({ run_id: r.run_id, expected: j.expected, observed: j.observed });
  }
  const out = [...groups.values()].sort((a, b) => (a.repo + a.capture_schema_version).localeCompare(b.repo + b.capture_schema_version));
  for (const g of out) {
    const judged = g.starts - g.runs_by_verdict['in-flight'];
    g.status = judged === 0 ? 'unmeasured:zero-judgeable-starts'
      : g.runs_by_verdict.gap > 0 ? 'gap'
        : g.runs_by_verdict.unmeasured > 0 ? 'partial:unmeasured-runs'
          : 'ok';
  }
  return out;
}

/**
 * Chip launch: ledger `task` rows against later `outcome` rows for the same work item. PURE.
 * @param {Array<{repo: string, work_item_id: string|null, event_at: string|Date, has_outcome: boolean}>} tasks
 */
export function reconcileChipLaunch(tasks, nowMs) {
  const groups = new Map();
  for (const t of tasks ?? []) {
    const repo = t.repo ?? 'unknown';
    const g = groups.get(repo) ?? { repo, starts: 0, completed: 0, open: 0, uncorrelated: 0, gaps: 0 };
    g.starts += 1;
    if (t.work_item_id == null) g.uncorrelated += 1;                       // cannot be joined to a completion: unmeasured
    else if (t.has_outcome) g.completed += 1;
    else if (nowMs - new Date(t.event_at).getTime() < CHIP_GRACE_MS) g.open += 1;
    else g.gaps += 1;                                                      // old, correlated, never landed or abandoned
    groups.set(repo, g);
  }
  const out = [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  for (const g of out) {
    g.status = g.gaps > 0 ? 'gap' : g.uncorrelated > 0 ? 'partial:uncorrelated' : g.completed + g.open === 0 ? 'unmeasured:zero-judgeable-starts' : 'ok';
  }
  return out;
}

/** Fleet land: only the starts are observable in P0. PURE. */
export function reconcileFleetLand(merges) {
  const groups = new Map();
  for (const m of merges ?? []) {
    const repo = m.repo ?? 'unknown';
    groups.set(repo, (groups.get(repo) ?? 0) + n(m.merges));
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([repo, starts]) => ({
    repo, starts, status: 'unmeasured:no-independent-start',
    reason: 'merged outcomes are the only landing record; a land that records nothing leaves no start to reconcile against (needs a start event from `ship-train plan`)',
  }));
}

/**
 * Cost reconciliation: sum of per-call `cost_usd` against `audit_runs.total_cost_estimate`. PURE.
 * `derived`: two stored figures compared, not a metered one. Either side absent or zero reads
 * `unmeasured`, never "within tolerance".
 * @param {{call_cost_usd: number|null, run_cost_usd: number|null, priced_rows: number, rows: number}} c
 * @param {number} [tolerance]
 */
export function reconcileCost(c, tolerance = 0.05) {
  const calls = c?.call_cost_usd == null ? null : Number(c.call_cost_usd);
  const runs = c?.run_cost_usd == null ? null : Number(c.run_cost_usd);
  const rows = n(c?.rows);
  const fill = rows > 0 ? n(c.priced_rows) / rows : null;
  if (calls == null || runs == null || !(runs > 0) || rows === 0) return { status: 'unmeasured:no-eligible-rows', call_cost_usd: calls, run_cost_usd: runs, fill };
  const delta = Math.abs(calls - runs) / runs;
  return { status: delta <= tolerance ? 'ok' : 'outside-tolerance', call_cost_usd: calls, run_cost_usd: runs, delta, fill, label: 'derived' };
}

/**
 * Exit code. 0 = measured and no gap; 1 = a measured gap; 3 = the gating source is unmeasured
 * (an unmeasured report is never green). Fleet-land is permanently `unmeasured` in P0 and is shown,
 * not gating.
 * @param {{auditDispatch: Array<{status: string}>, chipLaunch: Array<{status: string}>}} report
 */
export function exitCodeFor(report) {
  const all = [...(report.auditDispatch ?? []), ...(report.chipLaunch ?? [])];
  if (all.some((g) => g.status === 'gap')) return 1;
  const judged = (report.auditDispatch ?? []).filter((g) => !String(g.status).startsWith('unmeasured'));
  if (judged.length === 0) return 3;
  return 0;
}
