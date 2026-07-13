#!/usr/bin/env node
/**
 * @fileoverview Summarizes the Close-out shadow-validation observations —
 * the "operator reviews the shadow numbers before the flip" surface Phase
 * 14's decision gate needs; without it the data is write-only and the
 * shadow mechanism collects observations nobody reads back.
 *
 * **Cloud-first, cross-repo** (2026-07-13): when `AUDIT_DB_URL` is
 * configured, queries `tiered_shadow_observations` (the single-tenant
 * Supabase project every repo already shares) across THIS repo plus every
 * `--repos <path>` sibling checkout, giving a true cross-repo total for a
 * multi-repo shadow-validation window on one operator's machine — a bare
 * per-repo count from independent local files can't answer "have we hit
 * 15 total yet" without manually summing. Falls back to the local
 * `.audit/tiered-shadow-log.jsonl` (this repo only) when cloud is off.
 *
 * Usage:
 *   node scripts/tiered-shadow-report.mjs [--json]
 *   node scripts/tiered-shadow-report.mjs --repos <path1,path2,...> [--json]
 *   node scripts/tiered-shadow-report.mjs --log <path> [--json]   (local-only override)
 *
 * Plan: docs/completed/tiered-recall-audit-pipeline.md Close-out (shadow validation).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SHADOW_LOG_PATH } from './lib/audit/tiered-shadow-compare.mjs';
import { resolveRepoIdentity } from './lib/repo-identity.mjs';
import { isCloudEnabled } from './lib/store/repo.mjs';
import { getTieredShadowObservations } from './lib/store/tiered-shadow.mjs';

/** DB row (snake_case) → the exact shape `summarize()` already expects
 * (camelCase, matching the local JSONL record shape) — one normalizer so
 * both sources feed the SAME aggregation logic, no duplicated math. */
function normalizeDbRow(row) {
  return {
    legacyOk: row.legacy_ok, shadowOk: row.shadow_ok,
    shadowError: row.shadow_error, comparison: row.comparison,
    _repoId: row.repo_id,
  };
}

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

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const jsonMode = process.argv.includes('--json');
  const explicitLog = argOption('log', null);
  const reposArg = (argOption('repos', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

  // Explicit --log always means "local-only, this file" — an intentional
  // override, skip cloud entirely.
  if (explicitLog) {
    return reportLocal(explicitLog, jsonMode);
  }

  if (await isCloudEnabled()) {
    const repoIds = [];
    const repoLabels = {};
    for (const p of [process.cwd(), ...reposArg]) {
      try {
        const { repoUuid, name } = resolveRepoIdentity(p);
        repoIds.push(repoUuid);
        repoLabels[repoUuid] = name || p;
      } catch (err) {
        process.stderr.write(`  [tiered-shadow-report] WARNING: could not resolve repo identity for "${p}" (skipped): ${err.message}\n`);
      }
    }
    if (repoIds.length > 0) {
      const result = await getTieredShadowObservations({ repoIds });
      if (!result.ok) {
        process.stderr.write(`  [tiered-shadow-report] WARNING: cloud read failed (${result.error}) — falling back to local (this repo only, cross-repo totals unavailable).\n`);
        return reportLocal(SHADOW_LOG_PATH, jsonMode);
      }
      if (result.truncated) {
        process.stderr.write(`  [tiered-shadow-report] WARNING: result hit the query limit — older rows may be excluded from this summary.\n`);
      }
      return reportRows(result.rows.map(normalizeDbRow), jsonMode, { repoLabels, source: 'cloud', repoCount: repoIds.length, truncated: result.truncated });
    }
  }

  // Cloud off, or no repo identity resolved — local-only fallback (this
  // repo's own log; cross-repo aggregation isn't available offline).
  return reportLocal(SHADOW_LOG_PATH, jsonMode);
}

function reportLocal(logPath, jsonMode) {
  const records = readRecords(logPath);
  return reportRows(records, jsonMode, { source: 'local', logPath });
}

function reportRows(records, jsonMode, { source, logPath, repoLabels, repoCount, truncated }) {
  if (records.length === 0) {
    const note = source === 'local'
      ? `no shadow runs recorded yet at ${logPath} — set AUDIT_TIERED_SHADOW_ENABLED=true and run /audit-code a few times.`
      : 'no shadow runs recorded yet in the cloud store for the resolved repo(s).';
    if (jsonMode) console.log(JSON.stringify({ ok: true, totalRuns: 0, source, note }));
    else console.log(note.charAt(0).toUpperCase() + note.slice(1));
    return 0;
  }

  const summary = summarize(records);
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, source, truncated: Boolean(truncated), ...summary }, null, 2));
    return 0;
  }

  const scopeLine = source === 'cloud'
    ? `Tiered-pipeline shadow validation — ${summary.totalRuns} run(s) across ${repoCount} repo(s) (cloud)${truncated ? ' [TRUNCATED — older rows may be missing]' : ''}: ${Object.values(repoLabels).join(', ')}`
    : `Tiered-pipeline shadow validation — ${summary.totalRuns} run(s) recorded (local, ${logPath})`;
  console.log(scopeLine);
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
    console.log(`\n  ${summary.totalRuns}/10-15 — keep collecting before treating this as a Phase-14 decision basis.`);
  } else if (summary.totalRuns < 15) {
    console.log(`\n  ${summary.totalRuns}/15 — within the plan's pre-registered window; a few more before the Phase-14 review.`);
  } else {
    console.log(`\n  ${summary.totalRuns} runs — the plan's pre-registered 10-15 window is met. Time for the Phase-14 production-flip review.`);
  }
  return 0;
}

// CLI entry — only fire main() when this module is executed directly, not
// when imported by tests for its exported median/mean/summarize (2026-07-13
// bug: main() ran unconditionally at import time, using the TEST RUNNER's
// own process.argv — harmless while main() was pure-local, a real cloud
// leak once it started querying Supabase). Mirrors model-eval-auditor.mjs's
// own pathToFileURL guard (Windows drive-letter robustness).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
