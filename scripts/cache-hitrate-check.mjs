#!/usr/bin/env node
/**
 * @fileoverview Cache-hit-rate empirical check — decides whether the
 * `AUDIT_CACHE_SEED=1` default should flip from OFF to ON.
 *
 * Reads `.audit/session-audit-*.json` files (written by every audit run),
 * extracts the `_cacheMetrics.hitRate` from each, filters to runs since
 * the cached_tokens field-name fix (commit 63912c0 on 2026-05-11 — older
 * runs reported 0% due to the bug regardless of actual cache behaviour),
 * and computes the median.
 *
 * Decision rule (per docs/completed/openai-prefix-cache.md §8 PR-6):
 *   - N >= 5 R2+ audit runs AND median hit-rate > 30% → recommend flip
 *   - N < 5 → "insufficient data, keep collecting"
 *   - N >= 5 but median <= 30% → "cache is not paying off, hold or investigate"
 *
 * Usage:
 *   node scripts/cache-hitrate-check.mjs                  # human-readable
 *   node scripts/cache-hitrate-check.mjs --json           # machine-readable
 *   node scripts/cache-hitrate-check.mjs --since 2026-05-11  # override cutoff
 *
 * Exit code:
 *   0 — analysis ran (regardless of recommendation)
 *   1 — could not read .audit/ directory
 */
import fs from 'node:fs';
import path from 'node:path';

const AUDIT_DIR = path.resolve(import.meta.dirname, '..', '.audit');
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
// Cutoff: the bugfix commit landed on 2026-05-11. Audits BEFORE this reported
// `hitRate: 0` even when the cache fired (wrong field path).  Anything from
// 2026-05-11 onwards reflects reality.  Operator can override via --since.
const sinceIdx = args.indexOf('--since');
const SINCE = sinceIdx === -1 ? '2026-05-11' : args[sinceIdx + 1];
const SINCE_MS = new Date(SINCE + 'T00:00:00Z').getTime();

const MIN_RUNS = 5;
const FLIP_THRESHOLD = 0.3;

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function analyse() {
  const logPath = path.join(AUDIT_DIR, 'cache-metrics.jsonl');
  if (!fs.existsSync(logPath)) {
    return { ok: true, recommendation: 'INSUFFICIENT_DATA', reason: `No cache-metrics log yet at ${logPath}. The log accumulates after each audit run starting from the 63912c0 bugfix commit (2026-05-11).`, runCount: 0, medianHitRate: 0, since: SINCE, runs: [] };
  }
  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const r2Plus = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const startedAt = entry.startedAt ? new Date(entry.startedAt).getTime() : null;
      if (startedAt === null || startedAt < SINCE_MS) continue;
      // Only R2+ runs are relevant — R1 cold-starts always report 0%
      if (entry.round && entry.round >= 2) {
        r2Plus.push({ ...entry, startedAt });
      }
    } catch { /* skip malformed line */ }
  }

  const medianHitRate = median(r2Plus.map(r => r.hitRate));
  const N = r2Plus.length;

  let recommendation, reason;
  if (N < MIN_RUNS) {
    recommendation = 'INSUFFICIENT_DATA';
    reason = `Need >= ${MIN_RUNS} R2+ audit runs since ${SINCE} to decide; have ${N}.`;
  } else if (medianHitRate > FLIP_THRESHOLD) {
    recommendation = 'FLIP_TO_ON';
    reason = `Median R2+ hit-rate ${(medianHitRate * 100).toFixed(1)}% > ${(FLIP_THRESHOLD * 100).toFixed(0)}% threshold across ${N} runs. Set AUDIT_CACHE_SEED=1 as default.`;
  } else {
    recommendation = 'HOLD';
    reason = `Median R2+ hit-rate ${(medianHitRate * 100).toFixed(1)}% does not exceed ${(FLIP_THRESHOLD * 100).toFixed(0)}% across ${N} runs. Keep default OFF or investigate cache stability.`;
  }

  return { ok: true, recommendation, reason, runCount: N, medianHitRate, since: SINCE, runs: r2Plus };
}

function renderHuman(result) {
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    return;
  }
  console.log('═══════════════════════════════════════');
  console.log('  AUDIT_CACHE_SEED — empirical check');
  console.log('═══════════════════════════════════════');
  console.log(`  Recommendation: ${result.recommendation}`);
  console.log(`  Since:          ${result.since}`);
  console.log(`  R2+ runs:       ${result.runCount}`);
  console.log(`  Median hitRate: ${(result.medianHitRate * 100).toFixed(1)}%`);
  console.log(`  Threshold:      >${(FLIP_THRESHOLD * 100).toFixed(0)}% AND >= ${MIN_RUNS} runs`);
  console.log('');
  console.log(`  ${result.reason}`);
  if (result.runs.length > 0) {
    console.log('');
    console.log('  Per-run breakdown:');
    for (const r of result.runs) {
      const date = new Date(r.startedAt).toISOString().slice(0, 10);
      console.log(`    ${date} R${r.round} sid=${r.sid.slice(-12)}: ${(r.hitRate * 100).toFixed(1)}% (${r.totalCachedTokens}/${r.totalInputTokens})`);
    }
  }
  console.log('');
}

const result = analyse();
if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  renderHuman(result);
}
process.exit(result.ok ? 0 : 1);
