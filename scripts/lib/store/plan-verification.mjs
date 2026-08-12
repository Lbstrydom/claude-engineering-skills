/**
 * @fileoverview `plan_verification_runs` + `plan_verification_items` — the
 * /ux-lock-verify write path and the two views over it.
 *
 * Split out of `plans-ship.mjs` (cross-skill-command-registry Phase 6). That
 * module is now a re-export barrel and remains the import name every consumer
 * uses; this file is where the plan-verification domain actually lives.
 *
 * @module scripts/lib/store/plan-verification
 */

import { getPool } from '../db/client.mjs';
import { isCloudEnabled } from './repo.mjs';
import { many, one } from '../db/query.mjs';
import { insertRunRowWithPolicyFallback } from './run-row-fallback.mjs';

// ── plan_verification_runs / plan_verification_items ───────────────────────

/**
 * Record one /ux-lock-verify run.
 *
 * **Returns a discriminated result** (plan §2b F2, 2026-08-12). It returned a
 * bare `null` for a missing planId, for cloud-off, for an insert that produced
 * no id, and for any caught DB failure — and its CLI caller wrote `ok: !!runId`.
 * Cluster E made the cost concrete: a free variable inside the `try` returned
 * that same `null`, and nothing anywhere could tell it from "no plan".
 *
 * @returns {Promise<{ok:true, cloud:boolean, runId:string}
 *          |{ok:false, cloud:boolean, runId:null,
 *            reason:'cloud-off'|'invalid-input'|'write-failed',
 *            message:string, error?:Error}>}
 */
export async function recordPlanVerificationRun(run) {
  if (!run?.planId) {
    return { ok: false, cloud: true, runId: null, reason: 'invalid-input', message: 'recordPlanVerificationRun requires run.planId' };
  }
  if (!await isCloudEnabled()) {
    return { ok: false, cloud: false, runId: null, reason: 'cloud-off', message: 'cloud store is disabled' };
  }
  const row = {
    plan_id: run.planId,
    spec_id: run.specId || null,
    commit_sha: run.commitSha || null,
    url: run.url || null,
    total_criteria: run.totalCriteria || 0,
    passed_count: run.passedCount || 0,
    failed_count: run.failedCount || 0,
    skipped_count: run.skippedCount || 0,
    duration_ms: run.durationMs || null,
    run_context: run.runContext || 'ux-lock-verify',
  };
  // Optional selector-policy telemetry (plan: ux-lock-selector-policy).
  if (run.selectorPolicyViolations != null) row.selector_policy_violations = run.selectorPolicyViolations;
  try {
    const out = await insertRunRowWithPolicyFallback('plan_verification_runs', row, { returning: ['id'] });
    const runId = out?.id ?? null;
    if (!runId) {
      const message = 'insert returned no row — the write did not verify';
      process.stderr.write(`  [learning] recordPlanVerificationRun: ${message}\n`);
      return { ok: false, cloud: true, runId: null, reason: 'write-failed', message };
    }
    return { ok: true, cloud: true, runId };
  } catch (err) {
    process.stderr.write(`  [learning] recordPlanVerificationRun failed: ${err.message}\n`);
    return { ok: false, cloud: true, runId: null, reason: 'write-failed', message: err.message, error: err };
  }
}

/**
 * Record per-criterion outcomes for a verification run.
 *
 * Returns `{ok, inserted, reason}` rather than `undefined`. Every failure path
 * below logs to stderr and swallows, so a caller that infers a count from
 * `items.length` reports a persistence result this function never established —
 * which is exactly what `cross-skill.mjs record-plan-verify-items` did. `inserted`
 * is the row count Postgres accepted, not the row count we asked it to accept.
 */
export async function recordPlanVerificationItems(runId, planId, items) {
  if (!runId || !planId || !Array.isArray(items) || items.length === 0) {
    return { ok: false, inserted: 0, reason: 'bad-input' };
  }
  if (!await isCloudEnabled()) return { ok: true, inserted: 0, reason: 'cloud-off' };
  const rows = items.map((item) => ({
    run_id: runId,
    plan_id: planId,
    criterion_hash: item.criterionHash,
    criterion_index: item.criterionIndex,
    severity: item.severity,
    category: item.category,
    description: item.description,
    setup_text: item.setupText || null,
    assert_text: item.assertText || null,
    passed: !!item.passed,
    skipped: !!item.skipped,
    error_message: item.errorMessage || null,
    duration_ms: item.durationMs || null,
  }));
  const pool = await getPool();
  if (!pool) return { ok: false, inserted: 0, reason: 'no-pool' };
  const insertItems = async (omitSkipped) => {
    const cols = Object.keys(rows[0]).filter((c) => !(omitSkipped && c === 'skipped'));
    const params = [];
    const valueGroups = rows.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const res = await pool.query(
      `INSERT INTO plan_verification_items (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES ${valueGroups.join(', ')}`,
      params
    );
    return res?.rowCount ?? 0;
  };
  // A short write is a FAILED write (§2b F2, raised in both Cluster F audit
  // rounds). `inserted` was already honest — it is the count Postgres accepted,
  // never the count requested — but `ok: true` rode alongside it regardless, so
  // a caller checking `ok` and a caller comparing `inserted` to `items.length`
  // reached opposite conclusions from the same result. That is the
  // unverified-write-success shape this cluster exists to remove, and the fix
  // is the one the sibling writers already carry: compare, then report.
  const verify = (inserted) => (inserted === rows.length
    ? { ok: true, inserted }
    : {
      ok: false,
      inserted,
      reason: inserted === 0 ? 'no-rows-written' : 'row-count-mismatch',
      message: `INSERT affected ${inserted} of ${rows.length} plan_verification_items row(s)`,
    });
  try {
    return verify(await insertItems(false));
  } catch (err) {
    // 42703-only: consumer DB predates the `skipped` column (migration
    // 20260704…) — retry once without it so the per-criterion rows aren't lost.
    if (err?.code === '42703' && 'skipped' in rows[0]) {
      process.stderr.write('  [learning] plan_verification_items.skipped missing — run setup-postgres --migrate; recording without it\n');
      try { return verify(await insertItems(true)); }
      catch (retryErr) {
        process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${retryErr.message}\n`);
        return { ok: false, inserted: 0, reason: retryErr.message };
      }
    }
    process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${err.message}\n`);
    return { ok: false, inserted: 0, reason: err.message };
  }
}

/** Read the plan_satisfaction view (latest run + failing P0/P1). */
export async function readPlanSatisfaction(planId) {
  if (!planId || !await isCloudEnabled()) return null;
  try {
    return await one(`SELECT * FROM plan_satisfaction WHERE plan_id = $1 LIMIT 1`, [planId]);
  } catch (err) {
    process.stderr.write(`  [learning] readPlanSatisfaction failed: ${err.message}\n`);
    return null;
  }
}

/** Read criteria failing across recent verification runs. */
export async function readPersistentPlanFailures(planId) {
  if (!planId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persistent_plan_failures WHERE plan_id = $1`, [planId]);
  } catch (err) {
    process.stderr.write(`  [learning] readPersistentPlanFailures failed: ${err.message}\n`);
    return [];
  }
}
