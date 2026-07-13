#!/usr/bin/env node
/**
 * @fileoverview Summarizes `.audit/tiered-shadow-log.jsonl` — the Close-out
 * shadow-validation log `tiered-shadow-compare.mjs` writes to on every real
 * audit run (when `AUDIT_TIERED_SHADOW_ENABLED=true`). This is the "operator
 * reviews the shadow numbers before the flip" surface Phase 14's decision
 * gate needs; without it the log is write-only and the shadow mechanism
 * collects data nobody reads back.
 *
 * Usage: node scripts/tiered-shadow-report.mjs [--log <path>] [--json]
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Close-out (shadow validation).
 */
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

import fs from 'node:fs';
import { SHADOW_LOG_PATH } from './lib/audit/tiered-shadow-compare.mjs';

function argOption(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
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

function readRecords(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); }
    catch { process.stderr.write(`  [tiered-shadow-report] skipping malformed line ${i + 1}\n`); return null; }
  }).filter(Boolean);
}

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

function main() {
  const logPath = argOption('log', SHADOW_LOG_PATH);
  const jsonMode = process.argv.includes('--json');
  const records = readRecords(logPath);

  if (records.length === 0) {
    if (jsonMode) console.log(JSON.stringify({ ok: true, totalRuns: 0, note: 'no shadow runs recorded yet' }));
    else console.log(`No shadow runs recorded yet at ${logPath} — set AUDIT_TIERED_SHADOW_ENABLED=true and run /audit-code a few times.`);
    return 0;
  }

  const summary = summarize(records);
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
    return 0;
  }

  console.log(`Tiered-pipeline shadow validation — ${summary.totalRuns} run(s) recorded (${logPath})`);
  console.log(`  legacy failures:    ${summary.legacyFailures}`);
  console.log(`  shadow failures:    ${summary.shadowFailures}`);
  console.log(`  compared runs:      ${summary.comparedRuns}`);
  if (summary.comparedRuns > 0) {
    console.log(`  cost delta (tiered - legacy, USD):    mean ${summary.costDeltaUsd.mean?.toFixed(3)}  median ${summary.costDeltaUsd.median?.toFixed(3)}`);
    console.log(`  latency delta (tiered - legacy, sec): mean ${summary.latencyDeltaSec.mean?.toFixed(1)}  median ${summary.latencyDeltaSec.median?.toFixed(1)}`);
    console.log(`  finding overlap rate:                 mean ${(summary.findingOverlapRate.mean * 100)?.toFixed(0)}%  median ${(summary.findingOverlapRate.median * 100)?.toFixed(0)}%`);
    console.log(`  tiered runStatus breakdown: ${JSON.stringify(summary.tieredRunStatusCounts)}`);
  }
  if (summary.totalRuns < 10) {
    console.log(`\n  NOTE: fewer than 10 runs so far — the plan's own pre-registered comparison window is 10-15 real commits; keep collecting before treating this as a Phase-14 decision basis.`);
  }
  return 0;
}

process.exitCode = main();
