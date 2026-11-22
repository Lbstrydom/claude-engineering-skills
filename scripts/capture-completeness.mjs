#!/usr/bin/env node
/**
 * @fileoverview `capture:completeness` - make silent capture loss visible from METADATA alone
 * (docs/plans/own-model-full-capture.md section 2.9, phase P0). Stores no content.
 *
 *   node scripts/capture-completeness.mjs report [--days N] [--repo NAME] [--json]
 *   node scripts/capture-completeness.mjs canary [--break-write]
 *
 * report: start events from audit dispatch, chip launch and fleet land, reconciled against
 *   completions, per repo x capture_schema_version. Exit 0 measured and no gap / 1 a measured gap /
 *   3 unmeasured (zero judgeable starts is never green).
 * canary: one synthetic two-attempt call through the real metadata pipeline into the store, read back
 *   and deleted. Exit 0 ok (or disabled by LEARNING_DISABLE=1) / 1 failed / 3 unmeasured.
 *   `--break-write` is its negative control: it must exit 1.
 *
 * @module scripts/capture-completeness
 */
import './lib/load-env.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { assertKnownFlags, ArgvError, arg, emit, finishAndExit } from './lib/cli-io.mjs';
import { reconcileAuditDispatch, reconcileChipLaunch, reconcileFleetLand, reconcileCost, exitCodeFor } from './lib/capture/completeness.mjs';
import { CAPTURE_SCHEMA_VERSION } from './lib/capture/schema-version.mjs';

const FLAGS = ['--days', '--repo', '--json', '--break-write', '--selfcheck-relocation'];

/** Build the report from the store. `deps` is the test seam. */
export async function buildReport({ days = 7, repo = null, nowMs = Date.now(), deps = {} } = {}) {
  const q = deps.queries ?? await import('./lib/store/capture-completeness-queries.mjs');
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

export async function main(argv = process.argv, deps = {}) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  const sub = argv[2];
  assertKnownFlags(argv.slice(3), FLAGS, { cli: 'capture-completeness', from: 0 });
  if (sub !== 'report' && sub !== 'canary') throw new ArgvError('usage: capture-completeness.mjs report [--days N] [--repo NAME] [--json] | canary [--break-write]');
  // Each subcommand accepts only its own flags: a flag that is accepted and ignored reads as honoured.
  assertKnownFlags(argv.slice(3), [...(sub === 'report' ? ['--days', '--repo', '--json'] : ['--break-write']), '--selfcheck-relocation'], { cli: `capture-completeness ${sub}`, from: 0 });
  const initStore = deps.initStore ?? (async () => (await import('./lib/store/repo.mjs')).initLearningStore());
  const { closePool } = await import('./lib/db/client.mjs');
  try {
    if (sub === 'canary') {
      if (process.env.LEARNING_DISABLE === '1') { emit({ ok: true, result: 'disabled', checks: [] }); return 0; }
      if (!await initStore()) { emit({ ok: false, result: 'unmeasured:cloud-off', checks: [] }); return 3; }
      const { runCanary } = await import('./lib/capture/canary.mjs');
      const out = await runCanary({ breakWrite: argv.includes('--break-write') });
      const code = out.result === 'ok' ? 0 : out.result.startsWith('unmeasured') ? 3 : 1;
      emit({ ok: code === 0, ...out });
      return code;
    }
    for (const f of ['--days', '--repo']) {   // a flag with no value must not silently fall back to the default scope
      const i = argv.indexOf(f);
      if (i >= 0 && (argv[i + 1] === undefined || String(argv[i + 1]).startsWith('--'))) throw new ArgvError(`${f} needs a value`);
    }
    const days = Number(arg(argv, '--days') ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new ArgvError('--days must be an integer 1..365');
    if (!await initStore()) { emit({ ok: false, schema: 'capture-completeness/v1', unmeasured: 'store-unreachable' }); return 3; }
    const report = await buildReport({ days, repo: arg(argv, '--repo') ?? null });
    if (argv.includes('--json')) emit({ ok: report.exitCode === 0, ...report }); else process.stdout.write(`${renderReport(report)}\n`);
    return report.exitCode;
  } finally {
    await closePool().catch(() => {});
  }
}

if (isInvokedAsScript(import.meta.url)) {
  main(process.argv).then((code) => finishAndExit(code), (err) => {
    process.stderr.write(`capture-completeness: ${err?.message ?? err}\n`);
    if (process.argv.includes('--json')) emit({ ok: false, error: String(err?.message ?? err) });
    return finishAndExit(err?.code === 'ARGV_ERROR' ? 2 : 1);
  });
}
