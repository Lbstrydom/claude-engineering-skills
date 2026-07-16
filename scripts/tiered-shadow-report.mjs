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
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Close-out (shadow validation).
 */
import { pathToFileURL } from 'node:url';
import { SHADOW_LOG_PATH } from './lib/audit/tiered-shadow-compare.mjs';
import { resolveRepoIdentity } from './lib/repo-identity.mjs';
import { isCloudEnabled } from './lib/store/repo.mjs';
import { getTieredShadowObservations } from './lib/store/tiered-shadow.mjs';
import {
  WINDOW_MIN, WINDOW_MAX, normalizeDbRow, median, mean, readRecords, summarize, windowProgress,
} from './lib/audit/tiered-shadow-summary.mjs';

// Re-exported for backward compatibility — tests and any external caller
// importing these from this file (rather than the new lib module) keep
// working unchanged. The lib module is the canonical source (2026-07-13).
export { normalizeDbRow, median, mean, summarize };

// Guards against swallowing a following flag as this option's value (e.g.
// `--repos --json` — a missing value followed by a real flag) — without the
// `startsWith('--')` check, `--json` would silently become the repos value
// and the actual --json flag would vanish (Gemini final-review fix, 2026-07-13).
// Exported for direct (I/O-free) unit testing.
export function argOption(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : dflt;
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
    // repoLabels is keyed by repoUuid, so it naturally dedupes — e.g.
    // `--repos .` re-resolving process.cwd()'s own identity. repoCount
    // (and the query's repoIds) derive from its keys rather than a raw
    // push-per-input array, which would otherwise overcount a repeated
    // path in the CLI's "across N repo(s)" summary (Gemini gate, round 3).
    const repoLabels = {};
    for (const p of [process.cwd(), ...reposArg]) {
      try {
        const { repoUuid, name } = resolveRepoIdentity(p);
        repoLabels[repoUuid] = name || p;
      } catch (err) {
        process.stderr.write(`  [tiered-shadow-report] WARNING: could not resolve repo identity for "${p}" (skipped): ${err.message}\n`);
      }
    }
    const repoIds = Object.keys(repoLabels);
    if (repoIds.length > 0) {
      const result = await getTieredShadowObservations({ repoIds });
      if (!result.ok) {
        process.stderr.write(`  [tiered-shadow-report] WARNING: cloud read failed (${result.error}) — falling back to local (this repo only, cross-repo totals unavailable).\n`);
        return reportLocal(SHADOW_LOG_PATH, jsonMode);
      }
      if (result.truncated) {
        process.stderr.write(`  [tiered-shadow-report] WARNING: result hit the query limit — newer rows may be excluded from this summary.\n`);
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

  // NEWER rows are the ones a LIMIT can cut off here — the query orders
  // ascending (oldest first) and truncates the tail, so a truncated result
  // is missing the MOST RECENT observations, not the oldest ones.
  const scopeLine = source === 'cloud'
    ? `Tiered-pipeline shadow validation — ${summary.totalRuns} run(s) across ${repoCount} repo(s) (cloud)${truncated ? ' [TRUNCATED — newer rows may be missing]' : ''}: ${Object.values(repoLabels).join(', ')}`
    : `Tiered-pipeline shadow validation — ${summary.totalRuns} run(s) recorded (local, ${logPath})`;
  console.log(scopeLine);
  console.log(`  legacy failures:    ${summary.legacyFailures}`);
  console.log(`  shadow failures:    ${summary.shadowFailures}`);
  console.log(`  compared runs:      ${summary.comparedRuns}   (decision-grade: tiered completed AND at least one side had a non-empty eligible population)`);
  // The two metrics are printed TOGETHER, never interchangeably
  // (docs/plans/stage0-evidence-relevance-split.md round-3 M1) — an operator
  // seeing only `comparedRuns: 0` after a run of `complete` shadows would
  // reasonably think the pipeline never ran. Showing the historical metric
  // beside it makes "it completed, but the comparison was degenerate/
  // old-shape" legible at a glance instead of alarming.
  if (summary.historicalCompleteRuns !== summary.comparedRuns) {
    console.log(`  (tiered-complete runs: ${summary.historicalCompleteRuns} — the wider, pre-split metric; the delta is broken out below)`);
  }
  // Three exclusion reasons, reported SEPARATELY — "nothing verifiable" vs
  // "verifiable but degenerate" vs "fell back to legacy" are different
  // problems with different fixes, and collapsing them into one number is
  // exactly what made the 2026-07-14 all-fallback window undiagnosable.
  const excluded = summary.excludedNoStage0Evidence + summary.excludedDegenerateComparison + summary.excludedFallback;
  if (excluded > 0) {
    console.log(`  excluded from the decision window (${excluded}):`);
    if (summary.excludedFallback > 0) {
      console.log(`    ${summary.excludedFallback} × fell back to legacy — the tiered pipeline never really ran (see fallback reasons below)`);
    }
    if (summary.excludedNoStage0Evidence > 0) {
      console.log(`    ${summary.excludedNoStage0Evidence} × no Stage-0 evidence — tiered completed but verified zero candidates`);
    }
    if (summary.excludedDegenerateComparison > 0) {
      console.log(`    ${summary.excludedDegenerateComparison} × degenerate comparison — BOTH sides empty despite Stage-0 evidence, or a pre-split row with no eligible counts recorded (a one-sided zero is NOT excluded — it counts as a real comparison)`);
    }
  }
  if (summary.comparedRuns > 0) {
    // `null` must render as "no data" (—), never as a formatted number: raw
    // `null * 100` coerces to 0 in JS, so an EMPTY overlap-rate sample (e.g.
    // every compared run found zero findings on either side) previously
    // printed "0%" — indistinguishable from "the tiered pipeline found none
    // of what legacy found," a false catastrophic-recall reading (Gemini
    // gate finding, 2026-07-13). `?.toFixed()` on a null mean similarly
    // printed the literal string "undefined".
    const num = (v, digits) => (v == null ? '—' : v.toFixed(digits));
    const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
    console.log(`  cost delta (tiered - legacy, USD):    mean ${num(summary.costDeltaUsd.mean, 3)}  median ${num(summary.costDeltaUsd.median, 3)}`);
    console.log(`  latency delta (tiered - legacy, sec): mean ${num(summary.latencyDeltaSec.mean, 1)}  median ${num(summary.latencyDeltaSec.median, 1)}`);
    console.log(`  finding overlap rate:                 mean ${pct(summary.findingOverlapRate.mean)}  median ${pct(summary.findingOverlapRate.median)}`);
  }
  // Printed whenever ANY shadow attempt produced a comparison object — NOT
  // gated on comparedRuns > 0 — because the exact failure mode this exists
  // to surface (2026-07-14 incident) is comparedRuns:0 with 20/20
  // fallback_legacy: an operator needs to see THAT breakdown precisely when
  // there's nothing else to show.
  if (Object.keys(summary.tieredRunStatusCounts).length > 0) {
    console.log(`  tiered runStatus breakdown: ${JSON.stringify(summary.tieredRunStatusCounts)}`);
  }
  if (Object.keys(summary.tieredFallbackReasons).length > 0) {
    console.log(`  fallback reasons (historical rows — the shadow no longer falls back): ${JSON.stringify(summary.tieredFallbackReasons)}`);
  }
  // The LIVE cause breakdown. Printed whenever any shadow attempt failed —
  // NOT gated on comparedRuns > 0 — for the same reason the fallback
  // breakdown above isn't: the state an operator most needs to diagnose is
  // precisely the one where there's nothing else to show
  // (docs/plans/shadow-no-legacy-fallback.md decision #4).
  if (Object.keys(summary.shadowFailureReasons).length > 0) {
    console.log(`  shadow failure reasons (live): ${JSON.stringify(summary.shadowFailureReasons)}`);
  }
  // Gated on comparedRuns (decision-grade data points), NOT totalRuns — a
  // run whose shadow attempt failed outright contributes no cost/latency/
  // overlap information, so it can't count toward "ready to decide" even
  // though it's a real, informative failure data point in its own right
  // (surfaced above via shadowFailures). Fixed 2026-07-13 — this previously
  // gated on totalRuns, so 15 failed shadow attempts could read as
  // "window met" with zero real comparisons behind it.
  const win = windowProgress(summary.comparedRuns);
  const totalNote = summary.comparedRuns !== summary.totalRuns
    ? ` (${summary.totalRuns} total attempts recorded)` : '';
  if (!win.withinWindow) {
    console.log(`\n  ${summary.comparedRuns}/${win.min}-${win.max} compared runs${totalNote} — keep collecting before treating this as a Phase-14 decision basis.`);
  } else if (!win.met) {
    console.log(`\n  ${summary.comparedRuns}/${win.max} compared runs${totalNote} — within the plan's pre-registered window; a few more before the Phase-14 review.`);
  } else {
    console.log(`\n  ${summary.comparedRuns} compared runs${totalNote} — the plan's pre-registered ${win.min}-${win.max} window is met. Time for the Phase-14 production-flip review.`);
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
