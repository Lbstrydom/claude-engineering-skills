/**
 * @fileoverview The optional-`selector_policy_violations` insert fallback,
 * shared by the two `*_runs` writers.
 *
 * Its own module because it belongs to NEITHER domain that calls it.
 * `regression_spec_runs` (/ux-lock) and `plan_verification_runs`
 * (/ux-lock-verify) have no relationship beyond both carrying one optional
 * column added by migration 20260703200000, and the split of `plans-ship.mjs`
 * put them in separate files. Leaving the helper in `regression-specs.mjs` and
 * importing it into `plan-verification.mjs` would have manufactured a
 * regression-spec → plan-verification dependency that means nothing, and a
 * later reader would take it for a real one.
 *
 * @module scripts/lib/store/run-row-fallback
 */

import { insertReturning } from '../db/query.mjs';

/**
 * Insert a run row that may carry the optional `selector_policy_violations`
 * column (migration 20260703200000). EXACTLY undefined_column (42703) on a row
 * that carries the column → the consumer DB predates the migration: retry ONCE
 * without the field so the run row itself isn't lost, with a single warning
 * naming the pending migration. Any OTHER error propagates to the caller's
 * existing handling — never a broader swallow (db-write-seam rule).
 *
 * `insertFn` is injectable for tests (defaults to the real insertReturning).
 */
export async function insertRunRowWithPolicyFallback(table, row, opts = undefined, insertFn = insertReturning) {
  try {
    return await insertFn(table, row, opts);
  } catch (err) {
    if (err?.code === '42703' && 'selector_policy_violations' in row) {
      process.stderr.write(`  [learning] ${table}.selector_policy_violations missing — run setup-postgres --migrate; recording without it\n`);
      const { selector_policy_violations: _dropped, ...rest } = row;
      return await insertFn(table, rest, opts);
    }
    throw err;
  }
}
