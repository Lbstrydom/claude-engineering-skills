#!/usr/bin/env node
/**
 * @fileoverview Cache-hit-rate empirical check — validates the
 * `AUDIT_CACHE_SEED` default-ON flip (2026-07-14). While the default was
 * still OFF this script decided WHETHER to flip; post-flip it watches the
 * seed-ON cohort and recommends reverting to opt-out if seeding isn't
 * paying off.
 *
 * Reads `.audit/session-audit-*.json` files (written by every audit run),
 * extracts the `_cacheMetrics.hitRate` from each, filters to runs since
 * the cached_tokens field-name fix (commit 63912c0 on 2026-05-11 — older
 * runs reported 0% due to the bug regardless of actual cache behaviour),
 * and computes the median.
 *
 * Decision rule (per docs/plans/openai-prefix-cache.md §8 PR-6):
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

/**
 * Median of a numeric series. Returns `null` when nothing usable is present —
 * NOT 0, which would read as a measured "0% hit rate" and is indistinguishable
 * from a real one.
 *
 * Coerces before averaging because Postgres `numeric` columns arrive as STRINGS
 * over node-pg: `cache_hit_rate` reaches us as "0.1130". The previous version
 * summed the two middle elements directly, so an even-sized series concatenated
 * ("0.11" + "0.13" → "0.110.13") and divided to NaN, while an odd-sized one
 * returned its middle element untouched and coerced correctly later. The result
 * was a verdict that depended on cohort parity rather than on the data.
 */
function median(nums) {
  // Reject empties BEFORE coercing: `Number(null)` and `Number('')` are both 0,
  // a finite value, so a missing hit rate would otherwise survive as a measured
  // "0%" — indistinguishable from a genuine zero and dragging the median down.
  const sorted = (nums ?? [])
    .filter((n) => n !== null && n !== undefined && n !== '')
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Render a 0..1 rate as a percentage, or `n/a` when it was never measured. */
function pct(rate) {
  return rate === null || rate === undefined ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

async function loadFromSupabase() {
  // M4 — migrated off @supabase/supabase-js to the pg seam. Same query
  // shape; the SOURCE label stays 'supabase' since the live target is
  // still the Supabase-hosted Postgres.
  const { many } = await import('./lib/db/query.mjs');
  const select = (controlCols) =>
    `SELECT id, rounds, created_at,
            cache_input_tokens, cache_cached_tokens,
            cache_hit_rate, cache_estimated_savings_pct, cache_seed_enabled${controlCols}
       FROM audit_runs
      WHERE created_at >= $1
        AND rounds >= 2
        AND cache_hit_rate IS NOT NULL
      ORDER BY created_at DESC`;
  const args = [new Date(SINCE_MS).toISOString()];
  let rows;
  try {
    rows = await many(select(',\n            cache_seed_eligible, cache_seed_skip_reason'), args);
  } catch (err) {
    // 42703 = undefined_column. A consumer store that has not applied migration
    // 20260808190000 still answers the legacy question correctly; it just cannot
    // offer a control arm. Degrade to the old columns rather than fail the check
    // — but only for THIS error, so a real query fault still surfaces.
    if (err?.code !== '42703') throw err;
    process.stderr.write('  [cache-check] control-arm columns absent (pre-20260808190000 store) — comparison will report as uncontrolled\n');
    rows = await many(select(''), args);
  }
  return rows.map((r) => ({
    sid: r.id,
    startedAt: new Date(r.created_at).getTime(),
    round: r.rounds,
    // Number(...) is load-bearing, not cosmetic: these are Postgres `numeric`
    // columns, which node-pg hands back as strings. Left as strings they sort
    // fine (via `a - b` coercion) but sum by CONCATENATION downstream.
    totalInputTokens: Number(r.cache_input_tokens ?? 0),
    totalCachedTokens: Number(r.cache_cached_tokens ?? 0),
    // A rate is NOT a count: an absent `cache_hit_rate` means the run never
    // measured one, which is not the same claim as "measured, and it was 0%".
    // `?? 0` collapsed those together, and 112 of 251 R2+ rows are null — enough
    // fabricated zeros to drag the median the revert decision rests on.
    hitRate: r.cache_hit_rate == null ? null : Number(r.cache_hit_rate),
    estimatedSavingsPct: Number(r.cache_estimated_savings_pct ?? 0),
    // null/undefined → unknown cohort (pre-canary rows have no seed state).
    seedEnabled: r.cache_seed_enabled ?? null,
    // null on pre-20260808190000 rows = eligibility UNKNOWN, not false.
    seedEligible: r.cache_seed_eligible ?? null,
    seedSkipReason: r.cache_seed_skip_reason ?? null,
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
function segmentAndDecide(runs, { minRuns = MIN_RUNS, flipThreshold = FLIP_THRESHOLD, minControlRuns = MIN_RUNS } = {}) {
  const seedOn = runs.filter((r) => r.seedEnabled === true);
  const seedOff = runs.filter((r) => r.seedEnabled === false);
  const unknown = runs.filter((r) => r.seedEnabled !== true && r.seedEnabled !== false);

  const seedOnMedian = median(seedOn.map((r) => r.hitRate));
  const seedOffMedian = median(seedOff.map((r) => r.hitRate));

  // ── The control arm (migration 20260808190000) ────────────────────────────
  // `seedOff` is NOT a control: it mixes runs that were eligible but opted out
  // with runs that could never have seeded (single unit, prefix too small).
  // Since ineligibility correlates with small audits, comparing seed-ON against
  // all of seedOff measures audit size, not seeding.
  //
  // `seedEligible === true` is required explicitly — `null` means the row
  // predates the migration and its eligibility is UNKNOWN. Treating null as
  // eligible would re-admit the exact confound this arm exists to remove.
  const control = seedOff.filter((r) => r.seedEligible === true);
  const ineligible = seedOff.filter((r) => r.seedEligible === false);
  const eligibilityUnknown = seedOff.filter((r) => r.seedEligible === null || r.seedEligible === undefined);
  const controlMedian = median(control.map((r) => r.hitRate));

  let controlled;
  if (control.length < minControlRuns) {
    controlled = {
      available: false,
      controlCount: control.length,
      ineligibleCount: ineligible.length,
      eligibilityUnknownCount: eligibilityUnknown.length,
      controlMedian,
      note: `Uncontrolled: ${control.length}/${minControlRuns} eligible-but-withheld runs. `
        + `Of the ${seedOff.length} seed-OFF runs, ${ineligible.length} could never have seeded and `
        + `${eligibilityUnknown.length} predate the control-arm migration. Any seed-ON vs seed-OFF `
        + `gap is therefore confounded by audit size. To populate this arm, run some audits with `
        + `AUDIT_CACHE_SEED=0 — they now record eligibility instead of short-circuiting.`,
    };
  } else {
    // Ratio, not difference: hit rates are proportions, and a 2x lift off a
    // small base is the claim worth making. Guarded against a zero denominator.
    const lift = (seedOnMedian !== null && controlMedian !== null && controlMedian > 0)
      ? seedOnMedian / controlMedian
      : null;
    controlled = {
      available: true,
      controlCount: control.length,
      ineligibleCount: ineligible.length,
      eligibilityUnknownCount: eligibilityUnknown.length,
      controlMedian,
      treatmentMedian: seedOnMedian,
      lift,
      note: `Controlled: seed-ON ${pct(seedOnMedian)} (${seedOn.length} runs) vs eligible-but-withheld `
        + `${pct(controlMedian)} (${control.length} runs)`
        + (lift === null ? '; lift not computable.' : `; lift ${lift.toFixed(2)}x.`),
    };
  }
  const baseline = `Seed-OFF baseline: ${pct(seedOffMedian)} across ${seedOff.length} run(s)` +
    (unknown.length ? `; ${unknown.length} pre-canary run(s) have unknown seed state (excluded).` : '.');

  let recommendation, reason;
  if (seedOn.length < minRuns) {
    recommendation = 'INSUFFICIENT_SEED_ON_DATA';
    reason = `Need >= ${minRuns} seed-ON R2+ runs to decide; have ${seedOn.length}. ` +
      `Seed is default-ON since 2026-07-14, so data accumulates automatically as audits run ` +
      `(a run can opt out with AUDIT_CACHE_SEED=0). ${baseline}`;
  } else if (seedOnMedian === null) {
    // Enough runs, but not one carried a usable hit rate. HOLD would assert
    // "seeding isn't paying off" on the strength of no measurement at all —
    // the failure this whole function exists to avoid.
    recommendation = 'INSUFFICIENT_SEED_ON_DATA';
    reason = `${seedOn.length} seed-ON R2+ runs found, but none carried a usable cache_hit_rate ` +
      `value — cannot compute a median, so no verdict is possible. This is a data-integrity ` +
      `problem, not evidence against seeding. ${baseline}`;
  } else if (seedOnMedian > flipThreshold) {
    recommendation = 'FLIP_TO_ON';
    reason = `Seed-ON median hit-rate ${pct(seedOnMedian)} > ${(flipThreshold * 100).toFixed(0)}% ` +
      `across ${seedOn.length} seed-ON runs. Default is already ON (2026-07-14 flip) — keep it. ${baseline}`;
  } else {
    recommendation = 'HOLD';
    reason = `Seed-ON median hit-rate ${pct(seedOnMedian)} does not exceed ` +
      `${(flipThreshold * 100).toFixed(0)}% across ${seedOn.length} seed-ON runs — seeding isn't paying off. ` +
      `${baseline} ${controlled.note}` +
      (controlled.available
        ? ' A revert is justified only if the controlled lift above is also unconvincing.'
        : ' DO NOT revert on this alone: the threshold arm has fired, but there is no controlled'
          + ' comparison to confirm that seeding is worse than withholding it.');
  }
  return {
    recommendation, reason,
    seedOnCount: seedOn.length, seedOffCount: seedOff.length, unknownCount: unknown.length,
    seedOnMedian, seedOffMedian,
    controlled,
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
    controlled: decision.controlled,
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
  console.log(`  Seed-ON median:  ${pct(result.medianHitRate)}   (seed-OFF baseline: ${pct(result.seedOffMedian)})`);
  if (result.controlled) {
    const c = result.controlled;
    console.log(`  Control arm:     ${c.available ? `${pct(c.controlMedian)} across ${c.controlCount} eligible-but-withheld run(s)` + (c.lift === null ? '' : `  → lift ${c.lift.toFixed(2)}x`) : `NOT POPULATED (${c.controlCount} run(s))`}`);
    if (!c.available) console.log(`  ${c.note}`);
  }
  console.log(`  Threshold:       seed-ON median >${(FLIP_THRESHOLD * 100).toFixed(0)}% AND >= ${MIN_RUNS} seed-ON runs`);
  console.log('');
  console.log(`  ${result.reason}`);
  if (result.runs.length > 0) {
    console.log('');
    console.log('  Per-run breakdown:');
    for (const r of result.runs) {
      const date = new Date(r.startedAt).toISOString().slice(0, 10);
      const seed = r.seedEnabled === true ? 'seed' : r.seedEnabled === false ? 'off ' : '????';
      console.log(`    ${date} R${r.round} [${seed}] sid=${String(r.sid).slice(-12)}: ${pct(r.hitRate)} (${r.totalCachedTokens}/${r.totalInputTokens})`);
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
