#!/usr/bin/env node
/**
 * @fileoverview Live quickfix pattern-weight learner.  Reads the canonical
 * `learning_decisions` cloud table for `decision_type='quickfix_hit'`
 * outcomes, computes per-pattern Beta posteriors, and writes a derived
 * `.audit/quickfix-pattern-stats.json` cache that `matchPatterns()` consults
 * synchronously on the hot path.
 *
 * Two rebuild modes:
 *   --rebuild              cloud-canonical — reads learning_decisions
 *   --rebuild --bootstrap  RETIRED. Refuses and redirects to
 *                          "npm run learning:backfill-outcomes -- --rebuild-stats",
 *                          which owns outcome detection. It writes nothing:
 *                          the old path synthesised inert weights and
 *                          overwrote cloud-built caches with them.
 *
 * Skip rule: a pattern is skipped when `acceptance_rate < SKIP_THRESHOLD
 * AND total_hits >= MIN_HITS` — both gates required to avoid disabling on
 * single-digit-sample noise.
 *
 * CLI output contract: stdout is JSON; stderr carries human-readable
 * progress logs.  --format markdown produces a comparison table on stdout.
 *
 * Plan: docs/plans/adaptive-learning-phase-2-quickfix.md §2 (quickfix-stats)
 *
 * @module scripts/lib/learning/quickfix-stats
 */
import 'dotenv/config';
import fs from 'node:fs';

import { betaPosterior } from './beta-posterior.mjs';
import { atomicWriteFileSync } from '../file-io.mjs';
import {
  parseValidatedThreshold, parseValidatedMinHits,
  QUICKFIX_SKIP_THRESHOLD_DEFAULT, QUICKFIX_MIN_HITS_DEFAULT,
} from '../quickfix-policy.mjs';

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_PATH        = '.audit/quickfix-pattern-stats.json';
const SKIP_THRESHOLD    = parseValidatedThreshold(process.env.LEARNING_QUICKFIX_SKIP_THRESHOLD, QUICKFIX_SKIP_THRESHOLD_DEFAULT);
const MIN_HITS          = parseValidatedMinHits(process.env.LEARNING_QUICKFIX_MIN_HITS, QUICKFIX_MIN_HITS_DEFAULT);
const CACHE_VERSION     = 1;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Load the derived stats cache.  Returns an empty object when the cache
 * file is absent OR malformed (graceful degradation — matchPatterns()
 * falls through to default behaviour).
 *
 * @returns {{
 *   _version: number,
 *   _generatedAt: string,
 *   _watermark: { maxOutcomeAt: string|null, totalRowCount: number },
 *   patterns: Record<string, {alpha:number, beta:number, acceptanceRate:number, totalHits:number, ci_low:number}>,
 * } | { patterns: {} }}
 */
export function loadStats(cachePath = CACHE_PATH) {
  try {
    if (!fs.existsSync(cachePath)) return { patterns: {} };
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.patterns) return { patterns: {} };
    return parsed;
  } catch {
    return { patterns: {} };
  }
}

/**
 * Decide whether a pattern should be skipped on the hot path.  Pure
 * function — given a pattern name and the loaded stats, returns boolean.
 *
 * Skip rule: acceptance below threshold AND enough samples to trust the
 * signal.  Single-digit hits never trigger a skip.
 *
 * @param {string} patternName
 * @param {object} stats — return shape of loadStats()
 * @returns {boolean}
 */
export function shouldSkipPattern(patternName, stats) {
  if (!patternName || !stats || !stats.patterns) return false;
  const p = stats.patterns[patternName];
  if (!p) return false;
  if (typeof p.acceptanceRate !== 'number' || typeof p.totalHits !== 'number') return false;
  return p.acceptanceRate < SKIP_THRESHOLD && p.totalHits >= MIN_HITS;
}

/**
 * Rebuild the stats cache from the cloud canonical source.  Reads
 * `learning_decisions WHERE decision_type='quickfix_hit'`, groups by
 * pattern name (stored in context.pattern), counts outcomes, computes
 * Beta posteriors, writes the cache atomically (temp+rename).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoId] — restrict to one repo
 * @param {boolean} [opts.allRepos] — read EVERY repo's decisions; must be asked for
 * @param {string} [opts.cachePath]
 * @param {object} [opts.store] — injected for tests; defaults to learning-store.mjs
 * @returns {Promise<{ok: boolean, totalDecisions: number, patternCount: number, written?: string, error?: string}>}
 */
export async function rebuildFromCloud({ repoId = null, allRepos = false, cachePath = CACHE_PATH, store = null } = {}) {
  // Global access must be ASKED for, never inherited from an omitted argument —
  // the same rule the unlocked-fixes / unremediated-acceptances readers already
  // enforce, and for the same reason: `repoId = null` documented as meaning
  // "all" turned an ordinary no-argument call into an unscoped cross-repo read.
  // Both production call sites pass an explicit repoId, so this narrows nothing
  // they do; it closes the default.
  if (!repoId && !allRepos) {
    return {
      ok: false, totalDecisions: 0, patternCount: 0,
      error: 'repo-scope-required: pass repoId, or allRepos:true to read every repo deliberately',
    };
  }
  const learningStore = store || await import('../../learning-store.mjs');
  if (typeof learningStore.initLearningStore === 'function') {
    await learningStore.initLearningStore();
  }
  const cloudEnabled = typeof learningStore.isCloudEnabled === 'function' && await learningStore.isCloudEnabled();
  if (!cloudEnabled) {
    return { ok: false, totalDecisions: 0, patternCount: 0, error: 'cloud-disabled' };
  }
  const readResult = await readQuickfixDecisions(learningStore, { repoId: allRepos ? null : repoId });
  if (!readResult.ok) {
    // Reuses the exact {ok:false, error} shape the cloud-disabled branch
    // above already returns — a transient read failure or a malformed
    // success payload must never clobber an existing good cache, so
    // writeAtomic is never reached on this path.
    return { ok: false, totalDecisions: 0, patternCount: 0, error: readResult.error };
  }
  const decisions = readResult.decisions;
  const stats = aggregateDecisions(decisions);
  // Round 3 fix M4: every legitimate quickfix_hit decision carries a
  // recognizable context.pattern by construction — a non-empty decisions
  // array where NONE aggregated into a pattern is a protocol/data-shape
  // regression, not a genuine empty result. aggregateDecisions already
  // tolerates a MIX of good and malformed records correctly (this only
  // fires when EVERY record failed to aggregate).
  if (decisions.length > 0 && Object.keys(stats).length === 0) {
    return {
      ok: false,
      totalDecisions: decisions.length,
      patternCount: 0,
      error: `all ${decisions.length} decisions read from cloud lacked a recognizable pattern field — treating as a protocol/data-shape regression, not a genuine empty result`,
    };
  }
  const cacheBody = {
    _version: CACHE_VERSION,
    _generatedAt: new Date().toISOString(),
    _watermark: computeWatermark(decisions),
    _repoScope: repoId || 'all',
    patterns: stats,
  };
  writeAtomic(cachePath, JSON.stringify(cacheBody, null, 2));
  return {
    ok: true,
    totalDecisions: decisions.length,
    patternCount: Object.keys(stats).length,
    written: cachePath,
  };
}

/**
 * RETIRED — the bootstrap rebuild no longer runs. It is kept as a typed
 * refusal, not deleted outright, so an automation consumer that still calls
 * it fails loudly and is told what to run instead.
 *
 * Why retired (plan §2 items 2+3,
 * docs/plans/learning-persona-quickfix-honest-failure.md):
 *
 *  - It was a SECOND implementation of outcome detection, able to diverge
 *    from the one `backfill-outcomes.mjs --rebuild-stats` already owns and
 *    already runs weekly. The capability is not lost by retiring this copy.
 *  - It had no outcome data, so it synthesised every hit as `no_action` and
 *    wrote the resulting inert weights over whatever was in the cache —
 *    including a good, cloud-built one. A path that cannot compute an answer
 *    must not overwrite a better one.
 *
 * It therefore writes NOTHING. The refusal is stable and typed so callers can
 * branch on it rather than parse prose.
 *
 * @returns {Promise<{ok: false, totalHits: 0, patternCount: 0, error: string, hint: string}>}
 */
export async function rebuildFromBootstrap() {
  return {
    ok: false,
    totalHits: 0,
    patternCount: 0,
    error: 'bootstrap-retired',
    hint: 'run: npm run learning:backfill-outcomes -- --rebuild-stats',
  };
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Aggregate decisions into per-pattern Beta posteriors.
 * Outcomes:
 *   accept   → alpha += 1
 *   suppress → beta  += 1
 *   ignore   → beta  += 1
 *   no_action → not counted (insufficient evidence yet)
 *   <missing>→ not counted
 *
 * `context.pattern` is untrusted cloud-read data — round-1 code-audit
 * finding 0e342a58 (sustained): a truthy-but-non-string value (an object,
 * array, boolean, number) previously passed the old `if (!pattern)
 * continue;` guard and became a Map/object key via implicit coercion,
 * which for a value like `'__proto__'` risks reassigning the plain
 * object's prototype rather than creating an own property. Now requires a
 * non-blank STRING pattern, and the result container is a null-prototype
 * object (`Object.create(null)`) so no pattern string, however chosen, can
 * ever reach `Object.prototype`. Mixed good/bad records stay tolerant
 * (unchanged) — only individual malformed records are skipped, same as
 * today's `!pattern` guard already did for falsy values.
 *
 * @param {Array<{context: {pattern: string}, outcome: {action: string}|null}>} decisions
 * @returns {Record<string, {alpha:number, beta:number, acceptanceRate:number, totalHits:number, ci_low:number}>}
 */
export function aggregateDecisions(decisions) {
  const counters = new Map(); // pattern → { alpha, beta, totalHits }
  for (const d of decisions) {
    const pattern = d?.context?.pattern;
    if (typeof pattern !== 'string' || pattern.trim() === '') continue;
    let c = counters.get(pattern);
    if (!c) { c = { alpha: 0, beta: 0, totalHits: 0 }; counters.set(pattern, c); }
    c.totalHits += 1;
    const action = d?.outcome?.action;
    if (action === 'accept')        c.alpha += 1;
    else if (action === 'suppress' || action === 'ignore') c.beta += 1;
    // 'no_action' or unknown → not counted in alpha/beta (totalHits still bumps)
  }
  const out = Object.create(null);
  for (const [pattern, c] of counters) {
    const post = betaPosterior(c.alpha, c.beta);
    out[pattern] = {
      alpha: c.alpha,
      beta: c.beta,
      acceptanceRate: post.mean,
      ci_low: post.ci_low,
      totalHits: c.totalHits,
    };
  }
  return out;
}

function computeWatermark(decisions) {
  let maxOutcomeAt = null;
  for (const d of decisions) {
    const t = d?.outcome_at || d?.outcomeAt || null;
    if (t && (maxOutcomeAt === null || t > maxOutcomeAt)) maxOutcomeAt = t;
  }
  return { maxOutcomeAt, totalRowCount: decisions.length };
}

/**
 * Read all quickfix_hit decisions from cloud.  Pulls in pages of 1000
 * to avoid Supabase row-limit truncation surprises.
 *
 * Returns a typed result rather than a bare array (failure-contract
 * refactor, Defect 2): the missing-capability branch, the caught-exception
 * branch, and a non-array success payload (Round 1 finding M1 — a protocol
 * violation, not a legitimate empty result) all now return
 * `{ok:false, error}` instead of `[]`, which was bitwise indistinguishable
 * from a genuinely empty cloud response and let `rebuildFromCloud` silently
 * overwrite a good cache with an empty one on a transient read failure.
 * @returns {Promise<{ok:true, decisions: Array} | {ok:false, error:string}>}
 */
async function readQuickfixDecisions(learningStore, { repoId } = {}) {
  // M3 P3 — replaced the raw `lib/stores/supabase-store::getWriteClient()` +
  // a hand-rolled pagination loop with the typed `readDecisionsPaginated`
  // export. The store passed in is the barrel learning-store; if it's
  // missing the helper we degrade gracefully to a failure result.
  const ls = learningStore;
  if (!ls || typeof ls.readDecisionsPaginated !== 'function') {
    return { ok: false, error: 'readDecisionsPaginated is not available on the provided learning store' };
  }
  let decisions;
  try {
    decisions = await ls.readDecisionsPaginated({
      decisionType: 'quickfix_hit',
      repoId: repoId || null,
      pageSize: 1000,
      hardCap: 50000,
    });
  } catch (err) {
    process.stderr.write(`[quickfix-stats] read exception: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
  if (!Array.isArray(decisions)) {
    return { ok: false, error: `readDecisionsPaginated returned a non-array payload (${typeof decisions}) — protocol violation` };
  }
  return { ok: true, decisions };
}

/**
 * Atomic write: temp file + rename.  Crash-safe and avoids partial-read
 * races for matchPatterns() consumers reading concurrently.
 */
function writeAtomic(targetPath, content) {
  atomicWriteFileSync(targetPath, content);
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

async function cliMain() {
  const args = process.argv.slice(2);
  const wantStats     = args.includes('--stats');
  const wantRebuild   = args.includes('--rebuild');
  const wantBootstrap = args.includes('--bootstrap');
  const wantReset     = args.includes('--reset');
  const repoIdx       = args.indexOf('--repo');
  const repoId        = repoIdx >= 0 ? args[repoIdx + 1] : null;
  const formatIdx     = args.indexOf('--format');
  const format        = formatIdx >= 0 ? args[formatIdx + 1] : 'json';

  if (wantReset) {
    if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
    process.stdout.write(JSON.stringify({ ok: true, action: 'reset' }) + '\n');
    return;
  }

  if (wantRebuild) {
    const result = wantBootstrap
      ? await rebuildFromBootstrap()
      : await rebuildFromCloud({ repoId });
    process.stdout.write(JSON.stringify({ ok: result.ok, action: 'rebuild', mode: wantBootstrap ? 'bootstrap' : 'cloud', ...result }) + '\n');
    if (!result.ok) process.exit(1);
    return;
  }

  // Default: --stats (also implicit when no other action given)
  const stats = loadStats();
  if (format === 'markdown') {
    const lines = ['| Pattern | α | β | Acceptance | Hits | Skip? |',
                   '|---|---|---|---|---|---|'];
    for (const [name, p] of Object.entries(stats.patterns || {})) {
      const skip = shouldSkipPattern(name, stats) ? '✓' : '';
      lines.push(`| \`${name}\` | ${p.alpha} | ${p.beta} | ${p.acceptanceRate.toFixed(3)} | ${p.totalHits} | ${skip} |`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }
  // JSON output
  const skipMap = {};
  for (const name of Object.keys(stats.patterns || {})) skipMap[name] = shouldSkipPattern(name, stats);
  process.stdout.write(JSON.stringify({
    ok: true,
    action: 'stats',
    cachePath: CACHE_PATH,
    cacheExists: fs.existsSync(CACHE_PATH),
    generatedAt: stats._generatedAt || null,
    watermark: stats._watermark || null,
    skipThreshold: SKIP_THRESHOLD,
    minHits: MIN_HITS,
    patterns: stats.patterns || {},
    wouldSkip: skipMap,
  }) + '\n');
}

if (isMain) {
  await cliMain();
}

// ── Test-only export ─────────────────────────────────────────────────────

export const _internals = Object.freeze({
  CACHE_PATH,
  SKIP_THRESHOLD,
  MIN_HITS,
  CACHE_VERSION,
  computeWatermark,
  writeAtomic,
});
