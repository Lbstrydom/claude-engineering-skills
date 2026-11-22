/**
 * @fileoverview The capture-completeness report builder and renderer, shared by the `capture:completeness`
 * CLI and the dashboard panel so the two can never disagree (docs/plans/own-model-full-capture.md section 2.9).
 * Metadata only. `deps.queries` is the test seam.
 *
 * @module scripts/lib/capture/report
 */
import { reconcileAuditDispatch, reconcileChipLaunch, reconcileFleetLand, reconcileCost, exitCodeFor } from './completeness.mjs';
import { CAPTURE_SCHEMA_VERSION } from './schema-version.mjs';

/** Build the report from the store. `deps` is the test seam. */
export async function buildReport({ days = 7, repo = null, nowMs = Date.now(), deps = {} } = {}) {
  const q = deps.queries ?? await import('../store/capture-completeness-queries.mjs');
  const [runs, tasks, merges, cost] = await Promise.all([
    q.readAuditRuns({ days, repo }), q.readChipTasks({ days, repo }), q.readFleetMerges({ days, repo }), q.readCostFigures({ days, repo }),
  ]);
  const report = {
    schema: 'capture-completeness/v1', capture_schema_version: CAPTURE_SCHEMA_VERSION, windowDays: days, repo,
    auditDispatch: reconcileAuditDispatch(runs, nowMs),
    chipLaunch: reconcileChipLaunch(tasks, nowMs),
    fleetLand: reconcileFleetLand(merges),
    cost: reconcileCost(cost),
  };
  report.exitCode = exitCodeFor(report);
  return report;
}

/** One line per group, so a person reads the loss without reading JSON. */
export function renderReport(r) {
  const lines = [`capture:completeness (window ${r.windowDays}d, schema v${r.capture_schema_version}) exit ${r.exitCode}`];
  const sect = (title, rows, fmt) => {
    lines.push(`${title}:${rows.length ? '' : ' unmeasured:zero-starts'}`);
    for (const g of rows) lines.push(`  ${fmt(g)}`);
  };
  sect('audit-dispatch', r.auditDispatch, (g) => `${g.repo} v${g.capture_schema_version}: ${g.status} | starts ${g.starts}, attempts ${g.attempts}/${g.expected_attempts} expected, logical ${g.logical_calls}, ${JSON.stringify(g.runs_by_verdict)}`);
  sect('chip-launch', r.chipLaunch, (g) => `${g.repo}: ${g.status} | starts ${g.starts}, completed ${g.completed}, open ${g.open}, gaps ${g.gaps}, uncorrelated ${g.uncorrelated}`);
  sect('fleet-land', r.fleetLand, (g) => `${g.repo}: ${g.status} | starts ${g.starts}`);
  lines.push(`cost: ${r.cost.status}${r.cost.delta == null ? '' : ` (delta ${(r.cost.delta * 100).toFixed(1)}%, derived)`}`);
  return lines.join('\n');
}
