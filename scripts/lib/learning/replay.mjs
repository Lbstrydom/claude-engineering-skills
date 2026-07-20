/**
 * @fileoverview Offline replay engine for the adaptive-learning system.
 * Reads historical `learning_decisions` rows for a given `decision_type`,
 * runs both a baseline policy and a candidate policy on each row's
 * recorded context, computes counterfactual reward distributions, and
 * returns a structured comparison summary.
 *
 * Phase 3 ships this as the keystone evaluation infrastructure that
 * graduates a telemetry-only logger to a live learner: write a candidate
 * policy fn, replay it against ≥30 days of recorded decisions, validate
 * recall/cost/precision metrics meet the master plan §5 promotion gates,
 * then flip the live flag.
 *
 * The engine is PURE given its inputs (rows + policies + reward fn).
 * Cloud reads are isolated to {@link readDecisionsForType}, which is
 * injected via the `store` parameter so unit tests can inject fixtures.
 *
 * Plan: docs/plans/adaptive-learning-phase-3-replay.md §2 (replay engine)
 *
 * @module scripts/lib/learning/replay
 */

const DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a counterfactual replay of a candidate policy against historical
 * decisions of the given type.
 *
 * @param {object} input
 * @param {string} input.decisionType — must be one of the registered types
 *   in decision-logger (`pass_selection`, `convergence_predict`, etc.)
 * @param {number} [input.sinceMs=30d] — replay window in milliseconds
 * @param {(row: object) => object} input.candidatePolicy — pure fn
 *   that maps a recorded learning_decisions row → a candidate `choice` object.
 *   The row carries `context`, `outcome`, `created_at`, etc.; most policies
 *   only read `row.context` but the full row is provided so policies can
 *   inspect outcome distributions or other historical signals if useful.
 * @param {(row: object) => object} [input.baselinePolicy] — defaults
 *   to "always pick the historical choice", i.e. the decision the system
 *   actually made.  Same row-shape contract as candidatePolicy.  Useful
 *   baseline for "would the candidate have done better than what we
 *   already shipped?"
 * @param {(row: object, choice: object) => number} input.rewardFn — pure
 *   reward function that scores a (row, choice) pair.  Must return a
 *   finite number; higher = better.
 * @param {object} [input.store] — defaults to learning-store.mjs; injected
 *   for unit testing
 * @param {string} [input.repoId] — optional per-repo filter
 * @returns {Promise<{
 *   ok: boolean,
 *   decisionType: string,
 *   sampleSize: number,
 *   sinceMs: number,
 *   baselineDist: { mean: number, p50: number, p90: number, total: number },
 *   candidateDist: { mean: number, p50: number, p90: number, total: number },
 *   deltaSummary: { meanDelta: number, candidateBetterPct: number, ties: number },
 *   error?: string,
 * }>}
 */
export async function replay(input) {
  const { decisionType, sinceMs = DEFAULT_SINCE_MS, candidatePolicy,
          baselinePolicy = null, rewardFn, store = null, repoId = null } = input || {};

  validateInput({ decisionType, candidatePolicy, rewardFn });

  const rows = await readDecisionsForType({ store, decisionType, sinceMs, repoId });
  if (!rows || rows.length === 0) {
    return {
      ok: true,
      decisionType,
      sampleSize: 0,
      sinceMs,
      truncated: false,
      baselineDist: emptyDist(),
      candidateDist: emptyDist(),
      deltaSummary: { meanDelta: 0, candidateBetterPct: 0, ties: 0 },
    };
  }

  const baselineRewards = [];
  const candidateRewards = [];
  let candidateBetter = 0;
  let ties = 0;
  for (const row of rows) {
    // Audit-fix Phase 3 R1 H2/H7: policies receive the FULL row (not just
    // ctx) so the historicalBaseline can read row.choice and outcome-aware
    // policies can read row.outcome.  Pure-context policies should accept
    // and ignore the extra fields.
    const baselineChoice = baselinePolicy
      ? baselinePolicy(row)
      : (row?.choice || {});
    const candidateChoice = candidatePolicy(row);

    const baseReward = safeReward(rewardFn, row, baselineChoice);
    const candReward = safeReward(rewardFn, row, candidateChoice);
    baselineRewards.push(baseReward);
    candidateRewards.push(candReward);

    if (candReward > baseReward) candidateBetter += 1;
    else if (candReward === baseReward) ties += 1;
  }

  return {
    ok: true,
    decisionType,
    sampleSize: rows.length,
    sinceMs,
    // Audit-fix Phase 3 R1 H5: surface truncation when the 5000-row cap
    // was hit so replay reports don't silently lose data.
    truncated: rows.length >= 5000,
    baselineDist: distSummary(baselineRewards),
    candidateDist: distSummary(candidateRewards),
    deltaSummary: {
      meanDelta: distSummary(candidateRewards).mean - distSummary(baselineRewards).mean,
      candidateBetterPct: candidateBetter / rows.length,
      ties,
    },
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateInput({ decisionType, candidatePolicy, rewardFn }) {
  if (!decisionType || typeof decisionType !== 'string') {
    throw new TypeError('replay: decisionType must be a non-empty string');
  }
  if (typeof candidatePolicy !== 'function') {
    throw new TypeError('replay: candidatePolicy must be a function');
  }
  if (typeof rewardFn !== 'function') {
    throw new TypeError('replay: rewardFn must be a function');
  }
}

// ── Reward + distribution helpers ──────────────────────────────────────────

function safeReward(rewardFn, row, choice) {
  let r;
  try { r = rewardFn(row, choice); }
  catch { return 0; } // policy/reward failures count as zero, never as NaN
  if (!Number.isFinite(r)) return 0;
  return r;
}

/**
 * Pure distribution summary — mean + p50 + p90 + total.  Returns zeros
 * for an empty input (so replay never produces NaN downstream).
 *
 * @param {number[]} values
 * @returns {{mean: number, p50: number, p90: number, total: number}}
 */
export function distSummary(values) {
  if (!Array.isArray(values) || values.length === 0) return emptyDist();
  const n = values.length;
  const total = values.reduce((a, b) => a + b, 0);
  const mean = total / n;
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  return { mean, p50, p90, total };
}

function emptyDist() { return { mean: 0, p50: 0, p90: 0, total: 0 }; }

function percentile(sortedAsc, q) {
  if (sortedAsc.length === 0) return 0;
  // Linear interpolation between bracketed values.
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

// ── Cloud read (isolated for testability) ─────────────────────────────────

/**
 * Read decisions of the given type from the past `sinceMs`.  Pages
 * through up to 5000 rows by default; callers needing more should
 * supply a tighter `repoId` filter.
 *
 * @param {object} input
 * @param {object} [input.store] — learning-store-like; defaults to
 *   `scripts/learning-store.mjs` lazy import
 * @param {string} input.decisionType
 * @param {number} input.sinceMs
 * @param {string|null} [input.repoId]
 * @returns {Promise<Array<object>>}
 */
export async function readDecisionsForType({ store = null, decisionType, sinceMs, repoId = null }) {
  const ls = store || await import('../../learning-store.mjs');
  if (typeof ls.initLearningStore === 'function') {
    await ls.initLearningStore().catch(() => {});
  }
  const cloud = typeof ls.isCloudEnabled === 'function' && await ls.isCloudEnabled();
  if (!cloud) return [];

  // M3 P3 — replaced the raw `getWriteClient()` + hand-rolled pagination
  // with the typed `readDecisionsPaginated` export. The `readDecisions`
  // fixture-injection contract (R2 M5/M12) is preserved.
  if (typeof ls.readDecisions === 'function') {
    return ls.readDecisions({ decisionType, sinceMs, repoId });
  }
  if (typeof ls.readDecisionsPaginated !== 'function') return [];
  try {
    return await ls.readDecisionsPaginated({
      decisionType,
      sinceMs,
      repoId: repoId || null,
      pageSize: 1000,
      hardCap: 5000,
    });
  } catch (err) {
    process.stderr.write(`[replay] read exception: ${err.message}\n`);
    return [];
  }
}

// ── Built-in baseline policies ────────────────────────────────────────────
//
// Convenience policies for replay scenarios that don't care about an
// alternative baseline.

/** Returns the row's historical choice — "what we actually shipped". */
export function historicalBaseline(row) { return row?.choice || {}; }

/** No-op baseline — emits a fixed neutral choice; useful for unit tests. */
export function neutralBaseline() { return { chose: 'neutral' }; }

// ── Standard reward functions per decision_type ───────────────────────────
//
// Reward fn must return a number; higher = better policy.  Replay callers
// usually want to import one of these defaults rather than writing their
// own — they encode the master plan §5 reward formulas.

/**
 * Reward for `pass_selection` decisions.
 *
 *   reward = (HIGH_kept + 0.5 * MEDIUM_kept) / costUsd
 *          + 2.0 * personaCorrelationConfirmedHits
 *          - 0.5 * dismissedFalsePositives
 *
 * All terms come from the row's recorded `outcome` (set by
 * openai-audit.mjs at the audit's post-run backfill).  Missing-outcome
 * rows return 0 — replay treats them as undecidable.
 */
export function passSelectionReward(row /* , choice */) {
  const o = row?.outcome;
  if (!o || typeof o !== 'object') return 0;
  const highKept   = Number(o.highKept   || 0);
  const mediumKept = Number(o.mediumKept || 0);
  const cost       = Math.max(Number(o.costUsd || o.durationMs / 1000 || 0), 0.001);
  const persona    = Number(o.personaCorrelationConfirmedHits || 0);
  const fp         = Number(o.dismissedFalsePositives || 0);
  return (highKept + 0.5 * mediumKept) / cost
       + 2.0 * persona
       - 0.5 * fp;
}

/**
 * Reward for `convergence_predict` decisions.  Higher when the candidate
 * policy correctly predicts that the run WILL converge in the next round
 * (saves cost) AND doesn't false-positive on rounds that actually
 * needed more iterations (avoids missing real findings).
 */
export function convergencePredictReward(row, choice) {
  const o = row?.outcome;
  if (!o || typeof o !== 'object') return 0;
  // chose === 'continue' AND outcome.converged_at > round → correct continue
  // chose === 'stop'     AND outcome.converged_at === round → correct stop
  // chose === 'stop'     AND outcome.converged_at  >  round → bad early stop (missed findings)
  // chose === 'continue' AND outcome.converged_at === row.round → wasted round
  const convergedAt = Number(o.converged_at || 0);
  const recordedRound = Number(row?.round || 0);
  const c = choice?.chose;
  if (c === 'stop' && convergedAt === recordedRound) return 1;          // correct stop
  if (c === 'stop' && convergedAt >  recordedRound) return -2;          // missed findings
  if (c === 'continue' && convergedAt > recordedRound) return 0.5;      // correct continue
  if (c === 'continue' && convergedAt === recordedRound) return -0.2;   // wasted round
  return 0;
}

/**
 * Reward for `arch_memory_band` decisions.  +1 when the candidate band
 * matches the eventual outcome ('reuse-correct', 'extend-correct'), 0
 * for 'uncertain', -1 for 'wrong-fork' (recommended reuse but user
 * actually wrote a sibling).
 */
export function archMemoryBandReward(row, choice) {
  const o = row?.outcome;
  if (!o || typeof o !== 'object') return 0;
  const action = o.action;
  const candidateBand = choice?.band;
  // Band vocabulary updated 2026-07-20: `reuse`/`extend` retired in favour of
  // `precedent`. Legacy rows keep the old strings, so both score — a historical
  // row must remain scoreable under the vocabulary it was recorded with, or
  // replay silently rewrites its own history.
  const ACTIONABLE = new Set(['precedent', 'reuse', 'extend']);
  if (action === 'reuse-correct'  && ACTIONABLE.has(candidateBand)) return 1;
  if (action === 'extend-correct' && ACTIONABLE.has(candidateBand)) return 1;
  if (action === 'wrong-fork')                                      return -1;
  return 0;
}

// ── Test-only export ─────────────────────────────────────────────────────

export const _internals = Object.freeze({
  DEFAULT_SINCE_MS,
  validateInput,
  safeReward,
  percentile,
});
