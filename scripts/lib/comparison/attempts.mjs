/**
 * @fileoverview D5a's attempt reducer and cap, plus D6's across-attempt budget
 * check — one pure decision per arm, made before anything is spent.
 *
 * Why this exists: before it, the manifest driver re-ran any arm lacking a
 * live success on EVERY re-invocation. A deterministically failing arm (a
 * route that always 404s, a model that always returns malformed output)
 * therefore re-spent money each time the manifest was re-run, with no bound.
 * D5a specified `maxAttemptsPerArm` (default 2 — one retry) and it was never
 * built.
 *
 * Three things the decision reads, all from ONE set of rows
 * (`store/model-eval.mjs::getComparisonArmAttempts`), so the cap and the
 * budget can never disagree about what happened:
 *
 * - **Attempts = the highest recorded `attempt`, superseded rows included.**
 *   A superseded attempt was claimed and (possibly) paid for. A crashed attempt
 *   still `running` counts too: paid-or-not is unknown, and treating it as
 *   free is the double-charge the cap exists to prevent.
 * - **Live success = a `completed` row with `superseded_at IS NULL`.** A live
 *   `stopped_budget` row is NOT a success — raising the budget must be able to
 *   resume the arm.
 * - **Spend = `armSpend` over every attempt** (D5), never a second summation.
 *   One attempt with no recorded cost makes the evidence `unknown`.
 *
 * `maxAttemptsPerArm` and `budgetUsdPerArm` are ANALYSIS-TIME (D2a's
 * membership rule): changing either changes how much the operator is willing
 * to pay, not what already-collected evidence means — so neither is in the
 * lock, and raising one resumes the same cohort rather than orphaning it.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D5a, D6.
 *
 * @module scripts/lib/comparison/attempts
 */

import { armSpend, armBudgetStop } from './spend.mjs';

/** D5a: one retry. Bounded because every attempt is paid. */
export const DEFAULT_MAX_ATTEMPTS_PER_ARM = 2;

/** The upper bound the manifest accepts — a cap that is effectively
 * unlimited is not a cap. */
export const MAX_ATTEMPTS_PER_ARM_LIMIT = 10;

const NO_SPEND = Object.freeze({ spendUsd: 0, costEvidence: 'known', unpricedAttempts: 0 });

/**
 * @param {Array<{attempt: number, status: string, supersededAt: string|null, costUsd: number|null}>} rows
 * @returns {{attempts: number, hasLiveSuccess: boolean,
 *   spend: {spendUsd: number, costEvidence: 'known'|'unknown', unpricedAttempts: number}}}
 */
export function summarizeArmAttempts(rows) {
  const list = rows || [];
  const attempts = list.reduce((max, r) => Math.max(max, Number(r.attempt) || 0), 0);
  const hasLiveSuccess = list.some((r) => r.status === 'completed' && r.supersededAt == null);
  if (list.length === 0) return { attempts, hasLiveSuccess, spend: { ...NO_SPEND } };
  // One synthetic snapshot: armSpend flattens across snapshots before summing,
  // so the grouping only has to be consistent, and every row here is one arm.
  const perArm = armSpend([{
    armRuns: list.map((r) => ({
      armId: 'arm',
      attempt: r.attempt,
      costUsd: r.costUsd,
      costStatus: Number.isFinite(r.costUsd) ? 'priced' : 'unpriced',
      supersededAt: r.supersededAt,
    })),
  }]).arm;
  return {
    attempts, hasLiveSuccess,
    spend: { spendUsd: perArm.spendUsd, costEvidence: perArm.costEvidence, unpricedAttempts: perArm.unpricedAttempts },
  };
}

/**
 * Decide, before spending anything, whether this arm runs again.
 *
 * Order matters and is deliberate: a live success short-circuits everything
 * (resume); then the attempt cap; then the budget. A cap check that ran
 * after the budget would let a budget-stopped arm report "budget" when the
 * operator's real lever is the cap, and vice versa.
 *
 * @param {{history: null|{ok: boolean, error?: string, rows?: Array<object>},
 *   maxAttemptsPerArm?: number, budgetUsdPerArm?: number|null}} args
 *   `history: null` means the store is off — there is no cross-invocation
 *   record to read.
 * @returns {{action: 'run', attempt: number, supersedePrior: boolean, remainingBudgetUsd: number|null, enforcement?: string}
 *   | {action: 'skip', outcome: 'ok'|'permanently-failed'|'budget-stopped'|'refused', reason: string, [k: string]: unknown}}
 */
export function decideArmAttempt({ history, maxAttemptsPerArm = DEFAULT_MAX_ATTEMPTS_PER_ARM, budgetUsdPerArm = null }) {
  // Malformed is not unlimited — NaN fails every comparison, so an unchecked
  // NaN would silently disable the cap.
  if (!Number.isInteger(maxAttemptsPerArm) || maxAttemptsPerArm < 1) {
    throw new Error(`[comparison/attempts] maxAttemptsPerArm must be a positive integer, got ${maxAttemptsPerArm}`);
  }

  // Store off: no record of earlier invocations exists to read. Run once; the
  // per-unit budget still applies within this attempt. Said out loud rather
  // than implied — the cap cannot bound re-invocations it cannot see.
  if (history == null) {
    return { action: 'run', attempt: 1, supersedePrior: false, remainingBudgetUsd: budgetUsdPerArm ?? null, enforcement: 'this-invocation-only' };
  }

  // Unreadable is not empty. Guessing "attempt 1" here is how the cap would be
  // bypassed by a transient DB error — and every guess is a paid call.
  if (!history.ok) {
    return { action: 'skip', outcome: 'refused', reason: 'attempt-history-unreadable', detail: history.error ?? 'unknown error' };
  }

  const { attempts, hasLiveSuccess, spend } = summarizeArmAttempts(history.rows);
  if (hasLiveSuccess) {
    return { action: 'skip', outcome: 'ok', reason: 'live-success', attempts };
  }
  if (attempts >= maxAttemptsPerArm) {
    return { action: 'skip', outcome: 'permanently-failed', reason: 'max-attempts-exhausted', attempts, maxAttemptsPerArm };
  }

  // D6: retries are paid calls, so they count against the same budget.
  const stop = armBudgetStop({ spendSoFarUsd: spend.spendUsd, budgetUsdPerArm, costEvidence: spend.costEvidence });
  if (stop.stop) {
    return {
      action: 'skip', outcome: 'budget-stopped', reason: stop.reason, attempts,
      spendUsd: spend.costEvidence === 'known' ? spend.spendUsd : null,
      unpricedAttempts: spend.unpricedAttempts, budgetUsdPerArm,
    };
  }
  return { action: 'run', attempt: attempts + 1, supersedePrior: attempts > 0, remainingBudgetUsd: stop.remainingUsd };
}
