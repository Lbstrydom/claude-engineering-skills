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
import { buildOwnedInsert, classifyOwnedWrite, ownedReadPredicate } from './ownership.mjs';
import { validateCountFields } from '../command-input.mjs';

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
export async function recordPlanVerificationRun(run, opts = {}) {
  if (!run?.planId) {
    return { ok: false, cloud: true, runId: null, reason: 'invalid-input', message: 'recordPlanVerificationRun requires run.planId' };
  }
  if (!await isCloudEnabled()) {
    return { ok: false, cloud: false, runId: null, reason: 'cloud-off', message: 'cloud store is disabled' };
  }
  // Validated at the STORE, not only at the CLI handler. `ux-lock-run.mjs`
  // calls this writer directly, so a handler-only guard leaves the direct
  // caller unprotected — and the handler's guard was itself inert until
  // 2026-08-12 (it checked passedCriteria while the payload carries
  // passedCount). Four audit rounds reported these counts as unvalidated with
  // a validator sitting at the call site; the honest fix is at the boundary
  // that actually persists them.
  const counts = validateCountFields(run, {
    required: ['totalCriteria'],
    optional: ['passedCount', 'failedCount', 'skippedCount'],
  });
  if (!counts.ok) {
    return { ok: false, cloud: true, runId: null, reason: 'invalid-input', message: counts.reason };
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
  // Parent-joined since D7 / Phase 7: `planId` is an opaque uuid the caller
  // supplies, and this used to INSERT against it without proving the plan
  // exists or belongs to any resolvable repo. The `plans` parent carries
  // `repo_id` directly, so the tenant predicate needs no extra hop.
  const write = async (omitPolicy) => {
    const cols = Object.keys(row).filter((c) => !(omitPolicy && c === 'selector_policy_violations'));
    const { text, values } = buildOwnedInsert({
      parentTable: 'plans',
      childTable: 'plan_verification_runs',
      columns: cols,
      rows: [cols.map((c) => row[c])],
      parentId: run.planId,
      repoId: opts.repoId ?? null,
    });
    // The id comes OUT of the statement (`inserted_id`), not from a follow-up
    // SELECT. The first version read it back with
    // `ORDER BY created_at DESC LIMIT 1`, which hands back a CONCURRENT
    // invocation's row whenever two verify runs for the same plan overlap —
    // caught by the Phase-7 audit, and a shortcut around a RETURNING the
    // statement already performed.
    const counts = await one(text, values);
    const res = classifyOwnedWrite(counts, 1);
    if (!res.ok) return res;
    return counts?.inserted_id
      ? { ok: true, inserted: 1, runId: counts.inserted_id }
      : { ok: false, inserted: 1, reason: 'write-failed', message: 'row written but the statement returned no id' };
  };
  try {
    const res = await write(false);
    return res.ok
      ? { ok: true, cloud: true, runId: res.runId }
      : { ok: false, cloud: true, runId: null, reason: res.reason, message: res.message };
  } catch (err) {
    if (err?.code === '42703' && 'selector_policy_violations' in row) {
      process.stderr.write('  [learning] plan_verification_runs.selector_policy_violations missing — run setup-postgres --migrate; recording without it\n');
      try {
        const retry = await write(true);
        return retry.ok
          ? { ok: true, cloud: true, runId: retry.runId }
          : { ok: false, cloud: true, runId: null, reason: retry.reason, message: retry.message };
      } catch (retryErr) {
        process.stderr.write(`  [learning] recordPlanVerificationRun failed: ${retryErr.message}\n`);
        return { ok: false, cloud: true, runId: null, reason: 'write-failed', message: retryErr.message, error: retryErr };
      }
    }
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
export async function recordPlanVerificationItems(runId, planId, items, opts = {}) {
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
    // `=== true`, not `!!`. Truthiness turns the STRING "false" — which a JSON
    // payload from a shell pipeline routinely carries — into `true`, silently
    // inverting a criterion's outcome in the durable record. A non-boolean is
    // treated as not-passed / not-skipped rather than accepted as passed, which
    // is the safe direction: under-reporting a pass is visible, a fabricated
    // pass is not. (Phase 7-8 audit H5.)
    passed: item.passed === true,
    skipped: item.skipped === true,
    error_message: item.errorMessage || null,
    duration_ms: item.durationMs || null,
  }));
  const pool = await getPool();
  if (!pool) return { ok: false, inserted: 0, reason: 'no-pool' };

  // `planId` is INPUT-VALIDATED before anything is written. It is no longer
  // written at all — `plan_id` comes from the parent run — which left it a
  // vestigial argument a caller could get wrong and never hear about. The first
  // cut reconciled it AFTER the insert, so a mismatch left the rows committed
  // while telling the caller it had failed: write-then-refuse, worse than
  // either alternative (audit H2/H5).
  //
  // A pre-check is right HERE and wrong for ownership: this validates an
  // argument the caller supplied against the row it names, and the write does
  // not depend on the answer (the parent's value is used either way). The
  // ownership predicate stays in the SQL, where a caller cannot skip it.
  //
  // The preflight is itself TENANT-SCOPED. Unscoped, it answered "run r-1
  // belongs to plan p-9" for a run in another repository — a refusal message
  // that discloses a foreign row's contents. Scoped, a run the caller may not
  // see simply returns nothing, the mismatch check is skipped, and the INSERT's
  // ownership join gives the correct answer (`parent-not-owned`). A read that
  // exists to validate input must not see further than the write it guards.
  const parent = await one(
    `SELECT plan_id FROM plan_verification_runs WHERE id = $1 AND `
    + `${ownedReadPredicate({ parentTable: 'plan_verification_runs', idColumnInQuery: 'id', idParam: 1, repoParam: 2 })}`,
    [runId, opts.repoId ?? null],
  );
  if (parent && parent.plan_id !== planId) {
    return {
      ok: false, inserted: 0, reason: 'plan-id-mismatch',
      message: `run ${runId} belongs to plan ${parent.plan_id}, not the supplied ${planId} — refusing before writing anything`,
    };
  }
  // Parent-joined since D7 / Phase 7. The parent here is the RUN, not the plan:
  // `plan_verification_runs` is what `runId` addresses, and attaching criterion
  // rows to a run that does not exist is the defect. That table carries no
  // `repo_id` of its own — measured against the committed schema fixture — so
  // the allowlist reaches its tenant through `plans` (`repoVia`). Declaring the
  // hop rather than exempting this one child is what keeps the weakest link
  // visible.
  const insertItems = async (omitSkipped) => {
    const cols = Object.keys(rows[0]).filter((c) => !(omitSkipped && c === 'skipped'));
    const { text, values } = buildOwnedInsert({
      parentTable: 'plan_verification_runs',
      childTable: 'plan_verification_items',
      columns: cols,
      rows: rows.map((row) => cols.map((c) => row[c])),
      parentId: runId,
      repoId: opts.repoId ?? null,
      // `plan_id` comes from the PARENT RUN, never from the caller. The
      // ownership join proves the RUN is owned; writing a separately-supplied
      // planId into each child let the run and its criterion rows name
      // different plans — the join proved one thing and the row recorded
      // another (Phase-7 audit H2/H7). Sourcing it from the parent makes the
      // mismatch unrepresentable rather than merely unchecked.
      fromParent: { plan_id: 'plan_id' },
    });
    const res = await pool.query(text, values);
    return classifyOwnedWrite(res?.rows?.[0], rows.length);
  };
  // The short-write check (§2b F2, raised in both Cluster F audit rounds) now
  // lives in `classifyOwnedWrite`, alongside the two ownership refusals — one
  // place that turns the statement's counts into an outcome, rather than two
  // that could disagree about what a partial write means.
  try {
    return await insertItems(false);
  } catch (err) {
    // 42703-only: consumer DB predates the `skipped` column (migration
    // 20260704…) — retry once without it so the per-criterion rows aren't lost.
    if (err?.code === '42703' && 'skipped' in rows[0]) {
      process.stderr.write('  [learning] plan_verification_items.skipped missing — run setup-postgres --migrate; recording without it\n');
      try {
        // The retry loses the `skipped` flag — a real loss of information,
        // REPORTED rather than silent (audit H3). Losing one boolean beats
        // losing every per-criterion row, but a caller that cannot SEE the
        // degradation reads the rows as complete.
        const retry = await insertItems(true);
        return retry.ok ? { ...retry, degraded: 'skipped-column-missing' } : retry;
      } catch (retryErr) {
        process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${retryErr.message}\n`);
        return { ok: false, inserted: 0, reason: retryErr.message };
      }
    }
    process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${err.message}\n`);
    return { ok: false, inserted: 0, reason: err.message };
  }
}

/**
 * Read the plan_satisfaction view (latest run + failing P0/P1).
 *
 * `repoId` is additive and OPTIONAL (read-path tenancy close-out, 2026-08-12):
 * null relaxes the tenant match, a supplied value refuses a plan belonging to
 * another repository. The rows carry no repo of their own, so without it a
 * caller presents another repo's satisfaction as its own — the 207-vs-0 shape.
 */
export async function readPlanSatisfaction(planId, { repoId = null } = {}) {
  if (!planId || !await isCloudEnabled()) return null;
  try {
    return await one(
      `SELECT * FROM plan_satisfaction WHERE plan_id = $1 AND `
      + `${ownedReadPredicate({ parentTable: 'plans', idColumnInQuery: 'plan_id', idParam: 1, repoParam: 2 })} LIMIT 1`,
      [planId, repoId],
    );
  } catch (err) {
    process.stderr.write(`  [learning] readPlanSatisfaction failed: ${err.message}\n`);
    return null;
  }
}

/** Read criteria failing across recent verification runs. `repoId` as above. */
export async function readPersistentPlanFailures(planId, { repoId = null } = {}) {
  if (!planId || !await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT * FROM persistent_plan_failures WHERE plan_id = $1 AND `
      + `${ownedReadPredicate({ parentTable: 'plans', idColumnInQuery: 'plan_id', idParam: 1, repoParam: 2 })}`,
      [planId, repoId],
    );
  } catch (err) {
    process.stderr.write(`  [learning] readPersistentPlanFailures failed: ${err.message}\n`);
    return [];
  }
}
