#!/usr/bin/env node
/**
 * @fileoverview `audit:convergence` — how many review rounds a change needs before it passes (item 8d).
 *
 * Read-only over `audit_runs`. Reports, for code audits and plan audits
 * separately and per repo: the share passing at the first round, the share
 * needing 5+ rounds, and the mean rounds to pass. The definitions of "a
 * change" and "pass" are in docs/plans/audit-convergence-metrics.md §2.
 *
 * Advisory: exit 0 unless the CLI itself fails. Zero eligible sessions reads
 * `unmeasured`, never 0%.
 *
 * Usage:
 *   node scripts/audit-convergence.mjs                       # human report, last 30 days
 *   node scripts/audit-convergence.mjs --days 7 --mode code
 *   node scripts/audit-convergence.mjs --repo owner/name --json
 *   node scripts/audit-convergence.mjs --out .audit/convergence.json   # JSON to file, 1-line summary
 *
 * Exit codes: 0 ok · 1 store/query failure · 2 usage error.
 *
 * @module scripts/audit-convergence
 */

import fs from 'node:fs';
import path from 'node:path';
import './lib/load-env.mjs';
import { assertKnownFlags, ArgvError, emit, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { readConvergenceRows } from './lib/store/convergence.mjs';
import { buildReport, summaryLine, DEFAULT_GAP_HOURS } from './lib/audit/convergence-metrics.mjs';

const KNOWN_FLAGS = ['--days', '--gap-hours', '--mode', '--repo', '--json', '--out', '--selfcheck-relocation'];

const VALUE_FLAGS = ['--days', '--gap-hours', '--mode', '--repo', '--out'];

/** A value-taking flag needs a real value: missing, or another flag in its place, is a usage error. */
export function assertFlagValues(argv) {
  for (const name of VALUE_FLAGS) {
    for (let i = 2; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new ArgvError(`audit-convergence: ${name} needs a value`);
      } else if (a.startsWith(`${name}=`) && a.length === name.length + 1) {
        throw new ArgvError(`audit-convergence: ${name} needs a value`);
      }
    }
  }
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function posInt(raw, name, fallback, max) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ArgvError(`audit-convergence: ${name} needs a positive integer up to ${max}, got "${raw}"`);
  return n;
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** Human table for one metrics group. PURE. */
export function renderGroup(label, m) {
  const counts = `never passed ${m.unpassedSettled} (+${m.unpassedOpen} open) | unknown ${m.unknownOutcome} | pass rate ${pct(m.passRate)}`;
  if (m.status !== 'measured') return `  ${label.padEnd(34)} UNMEASURED — ${m.reason} | sessions ${m.sessions} | ${counts}`;
  return `  ${label.padEnd(34)} passed ${String(m.passed).padStart(4)} | 1st-round ${pct(m.passedFirstRoundShare).padStart(6)}`
    + ` | 5+ rounds ${pct(m.fiveOrMoreShare).padStart(6)} | mean ${String(m.meanRoundsToPass).padStart(5)}`
    + ` | median ${String(m.medianRoundsToPass).padStart(4)} | ${counts}`;
}

/** Human report. PURE. */
export function renderReport(report) {
  const lines = [`Audit convergence since ${report.window.startIso.slice(0, 10)}, as of ${report.window.asOfIso} (session gap ${report.window.gapHours}h)`];
  for (const [mode, v] of Object.entries(report.byMode)) {
    lines.push('', `${mode} audits`, renderGroup('all repos', v.overall));
    for (const [repo, m] of Object.entries(v.byRepo)) lines.push(renderGroup(repo, m));
    const o = v.overall;
    lines.push(`  grouping: ${o.sessionIdSessions} by session id, ${o.inferredSessions} inferred (${o.weakKey} weak-keyed: ad-hoc/detached HEAD); incomplete rounds: ${o.incompleteRounds}`);
  }
  const e = report.excluded;
  lines.push('', `Excluded, not dropped: ${e.experimentRows} experiment rows, ${e.notFinalisedRows} unfinalised (rounds=0) rows, `
    + `${e.truncatedHeadSessions} sessions whose first row may be cut by the fetch start, ${e.outsideWindowSessions} sessions outside the window.`);
  return lines.join('\n');
}

async function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'audit-convergence' });
    assertFlagValues(process.argv);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }

  let days; let gapHours; let mode;
  try {
    days = posInt(flagValue(process.argv, '--days'), '--days', 30, 3650);
    gapHours = posInt(flagValue(process.argv, '--gap-hours'), '--gap-hours', DEFAULT_GAP_HOURS, 8760);
    mode = flagValue(process.argv, '--mode') ?? 'all';
    if (!['all', 'code', 'plan'].includes(mode)) throw new ArgvError(`audit-convergence: --mode must be all|code|plan, got "${mode}"`);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  const repo = flagValue(process.argv, '--repo') ?? null;
  const out = flagValue(process.argv, '--out');

  let fetched;
  try {
    // The lookback must cover a whole session gap, or a long --gap-hours would mark half the window truncated.
    fetched = await readConvergenceRows({ days, lookbackDays: Math.max(14, Math.ceil(gapHours / 24) + 1) });
  } catch (err) {
    emit({ ok: false, error: { code: 'query-failed', message: String(err?.message || err).slice(0, 300) } });
    await finishAndExit(1);
    return;
  }
  if (!fetched.cloud) {
    // An unasked question is not an empty answer.
    const env = { ok: true, measured: false, reason: 'cloud-off', command: commandLine() };
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      atomicWriteFileSync(path.resolve(out), `${JSON.stringify(env, null, 2)}\n`);
      process.stdout.write(`audit-convergence: UNMEASURED (cloud-off) -> ${out}\n`);
    } else if (process.argv.includes('--json')) emit(env);
    else process.stdout.write('audit-convergence: UNMEASURED — cloud store is off (set AUDIT_DB_URL)\n');
    await finishAndExit(0);
    return;
  }

  const report = {
    ok: true, command: commandLine(), generatedAt: new Date().toISOString(),
    measured: false,
    ...buildReport(fetched.rows, { windowStartMs: fetched.windowStartMs, fetchStartMs: fetched.fetchStartMs, nowMs: fetched.asOfMs, gapHours, mode, repo }),
  };
  // `measured` means at least one mode produced a measured result, not merely that the query ran.
  report.measured = Object.values(report.byMode).some((m) => m.overall.status === 'measured');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    atomicWriteFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${summaryLine(report)} -> ${out}\n`);
  } else if (process.argv.includes('--json')) {
    emit(report);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
  }
  await finishAndExit(0);
}

function commandLine() {
  return `node scripts/audit-convergence.mjs ${process.argv.slice(2).join(' ')}`.trim();
}

if (isInvokedAsScript(import.meta.url)) main();
