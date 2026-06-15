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
import { pathToFileURL } from 'node:url';
// Import config.mjs (not bare 'dotenv/config') for its env-loading side effect:
// it loads the cwd/git-root .env AND the shared ~/.audit-loop.env, where the
// AUDIT_DB_URL DSN usually lives. Bare 'dotenv/config' only reads cwd .env, so
// a cron/routine run (DSN in the shared file) would not see AUDIT_DB_URL, fall
// back to the per-machine local log, find nothing, and falsely report
// INSUFFICIENT_DATA — even though the DB has plenty of R2+ runs.
import './lib/config.mjs';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

// Resolve `.audit/` via the canonical repo-root finder. This script always
// lives under a `scripts/` ancestor (in source: `scripts/`; in consumer:
// `scripts/.claude-skills/`), so findRepoRootFromScript always returns a
// value. See lib/assert-repo-root.mjs for why a parent-resolve pattern
// (going UP one level from import.meta.dirname) would break in the
// consumer-isolated layout — it resolves to `scripts/` or `.claude-skills/`
// rather than the actual repo root.
const REPO_ROOT = findRepoRootFromScript(import.meta.url);
const AUDIT_DIR = path.join(REPO_ROOT, '.audit');
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
// Cutoff: the bugfix commit landed on 2026-05-11. Audits BEFORE this reported
// `hitRate: 0` even when the cache fired (wrong field path).  Anything from
// 2026-05-11 onwards reflects reality.  Operator can override via --since.
const sinceIdx = args.indexOf('--since');
const SINCE = sinceIdx === -1 ? '2026-05-11' : args[sinceIdx + 1];
const SINCE_MS = new Date(SINCE + 'T00:00:00Z').getTime();

// Data source: 'local' (JSONL — this-machine only) or 'supabase'
// (cross-machine via audit_runs table).  Default to supabase when
// credentials are available; falls back to local otherwise.
// M4 — `supabase` source now means the pg seam (AUDIT_DB_URL); the
// legacy SUPABASE_AUDIT_* env triplet is sunset.
const sourceIdx = args.indexOf('--source');
const SOURCE_OVERRIDE = sourceIdx === -1 ? null : args[sourceIdx + 1];
const HAS_SUPABASE = !!process.env.AUDIT_DB_URL;
const SOURCE = SOURCE_OVERRIDE ?? (HAS_SUPABASE ? 'supabase' : 'local');

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

async function loadFromSupabase() {
  // M4 — migrated off @supabase/supabase-js to the pg seam. Same query
  // shape; the SOURCE label stays 'supabase' since the live target is
  // still the Supabase-hosted Postgres.
  const { many } = await import('./lib/db/query.mjs');
  const rows = await many(
    `SELECT id, rounds, created_at,
            cache_input_tokens, cache_cached_tokens,
            cache_hit_rate, cache_estimated_savings_pct, cache_seed_enabled
       FROM audit_runs
      WHERE created_at >= $1
        AND rounds >= 2
        AND cache_hit_rate IS NOT NULL
      ORDER BY created_at DESC`,
    [new Date(SINCE_MS).toISOString()]
  );
  return rows.map((r) => ({
    sid: r.id,
    startedAt: new Date(r.created_at).getTime(),
    round: r.rounds,
    totalInputTokens: r.cache_input_tokens ?? 0,
    totalCachedTokens: r.cache_cached_tokens ?? 0,
    hitRate: r.cache_hit_rate ?? 0,
    estimatedSavingsPct: r.cache_estimated_savings_pct ?? 0,
    // null/undefined → unknown cohort (pre-canary rows have no seed state).
    seedEnabled: r.cache_seed_enabled ?? null,
  }));
}

function loadFromLocal() {
  const logPath = path.join(AUDIT_DIR, 'cache-metrics.jsonl');
  if (!fs.existsSync(logPath)) return null;
  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const r2Plus = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const startedAt = entry.startedAt ? new Date(entry.startedAt).getTime() : null;
      if (startedAt === null || startedAt < SINCE_MS) continue;
      if (entry.round && entry.round >= 2) {
        // normalize the local `seedUsed` field to `seedEnabled` (undefined on
        // pre-canary lines → unknown cohort).
        r2Plus.push({ ...entry, startedAt, seedEnabled: entry.seedUsed ?? null });
      }
    } catch { /* skip malformed line */ }
  }
  return r2Plus;
}

/**
 * Pure segmentation + decision (exported for unit tests). Splits R2+ runs into
 * seed-ON / seed-OFF / unknown cohorts and decides off the seed-ON cohort —
 * because seed-OFF runs never warm the cache (structural ~0%) and would
 * contaminate a global median into a permanent HOLD.
 *
 * @param {Array<{hitRate:number, seedEnabled:boolean|null}>} runs
 * @param {{ minRuns?: number, flipThreshold?: number }} [opts]
 */
function segmentAndDecide(runs, { minRuns = MIN_RUNS, flipThreshold = FLIP_THRESHOLD } = {}) {
  const seedOn = runs.filter((r) => r.seedEnabled === true);
  const seedOff = runs.filter((r) => r.seedEnabled === false);
  const unknown = runs.filter((r) => r.seedEnabled !== true && r.seedEnabled !== false);

  const seedOnMedian = median(seedOn.map((r) => r.hitRate));
  const seedOffMedian = median(seedOff.map((r) => r.hitRate));
  const baseline = `Seed-OFF baseline: ${(seedOffMedian * 100).toFixed(1)}% across ${seedOff.length} run(s)` +
    (unknown.length ? `; ${unknown.length} pre-canary run(s) have unknown seed state (excluded).` : '.');

  let recommendation, reason;
  if (seedOn.length < minRuns) {
    recommendation = 'INSUFFICIENT_SEED_ON_DATA';
    reason = `Need >= ${minRuns} seed-ON R2+ runs to decide; have ${seedOn.length}. ` +
      `Run a canary: set AUDIT_CACHE_SEED=1 and run audits to accumulate seed-ON data. ${baseline}`;
  } else if (seedOnMedian > flipThreshold) {
    recommendation = 'FLIP_TO_ON';
    reason = `Seed-ON median hit-rate ${(seedOnMedian * 100).toFixed(1)}% > ${(flipThreshold * 100).toFixed(0)}% ` +
      `across ${seedOn.length} seed-ON runs. Set AUDIT_CACHE_SEED=1 as default. ${baseline}`;
  } else {
    recommendation = 'HOLD';
    reason = `Seed-ON median hit-rate ${(seedOnMedian * 100).toFixed(1)}% does not exceed ` +
      `${(flipThreshold * 100).toFixed(0)}% across ${seedOn.length} seed-ON runs — seeding isn't paying off. ${baseline}`;
  }
  return {
    recommendation, reason,
    seedOnCount: seedOn.length, seedOffCount: seedOff.length, unknownCount: unknown.length,
    seedOnMedian, seedOffMedian,
  };
}

async function analyse() {
  let r2Plus;
  let sourceLabel;
  if (SOURCE === 'supabase') {
    try {
      r2Plus = await loadFromSupabase();
      sourceLabel = 'supabase audit_runs';
    } catch (err) {
      return { ok: false, error: `supabase load failed: ${err.message}. Try --source local.`, source: 'supabase' };
    }
  } else {
    r2Plus = loadFromLocal();
    sourceLabel = 'local .audit/cache-metrics.jsonl';
    if (r2Plus === null) {
      return { ok: true, recommendation: 'INSUFFICIENT_DATA', reason: `No cache-metrics log yet at ${path.join(AUDIT_DIR, 'cache-metrics.jsonl')}. The log accumulates after each audit run starting from the 63912c0 bugfix commit (2026-05-11).`, runCount: 0, medianHitRate: 0, since: SINCE, source: SOURCE, runs: [] };
    }
  }

  const N = r2Plus.length;
  const decision = segmentAndDecide(r2Plus);

  return {
    ok: true,
    recommendation: decision.recommendation,
    reason: decision.reason,
    runCount: N,
    seedOnCount: decision.seedOnCount,
    seedOffCount: decision.seedOffCount,
    unknownCount: decision.unknownCount,
    medianHitRate: decision.seedOnMedian, // headline = the cohort we decide on
    seedOffMedian: decision.seedOffMedian,
    since: SINCE,
    source: sourceLabel,
    runs: r2Plus,
  };
}

function renderHuman(result) {
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    return;
  }
  console.log('═══════════════════════════════════════');
  console.log('  AUDIT_CACHE_SEED — empirical check');
  console.log('═══════════════════════════════════════');
  console.log(`  Recommendation:  ${result.recommendation}`);
  console.log(`  Source:          ${result.source ?? '(unknown)'}`);
  console.log(`  Since:           ${result.since}`);
  console.log(`  R2+ runs:        ${result.runCount} (seed-ON ${result.seedOnCount ?? 0} / seed-OFF ${result.seedOffCount ?? 0} / unknown ${result.unknownCount ?? 0})`);
  console.log(`  Seed-ON median:  ${(result.medianHitRate * 100).toFixed(1)}%   (seed-OFF baseline: ${((result.seedOffMedian ?? 0) * 100).toFixed(1)}%)`);
  console.log(`  Threshold:       seed-ON median >${(FLIP_THRESHOLD * 100).toFixed(0)}% AND >= ${MIN_RUNS} seed-ON runs`);
  console.log('');
  console.log(`  ${result.reason}`);
  if (result.runs.length > 0) {
    console.log('');
    console.log('  Per-run breakdown:');
    for (const r of result.runs) {
      const date = new Date(r.startedAt).toISOString().slice(0, 10);
      const seed = r.seedEnabled === true ? 'seed' : r.seedEnabled === false ? 'off ' : '????';
      console.log(`    ${date} R${r.round} [${seed}] sid=${String(r.sid).slice(-12)}: ${(r.hitRate * 100).toFixed(1)}% (${r.totalCachedTokens}/${r.totalInputTokens})`);
    }
  }
  console.log('');
}

// Run as a CLI only when invoked directly — import the module (e.g. tests)
// without triggering analyse()/process.exit().
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = await analyse();
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    renderHuman(result);
  }
  process.exit(result.ok ? 0 : 1);
}

export { segmentAndDecide, median };
