/**
 * @fileoverview Cross-skill data-loop domain — plans, regression specs,
 * persona↔audit correlations, plan verification, ship events.
 *
 * Part of the postgres-parity M3 split. 13 functions covering the
 * plans / ux-lock / persona-correlation / ship feedback loop (migration
 * 20260419120000_cross_skill_data_loop.sql + 20260419130000_plan_verify.sql).
 *
 * @module scripts/lib/store/plans-ship
 */

import { many, one, insertReturning, upsert, updateWhere } from '../db/query.mjs';
import { getPool } from '../db/client.mjs';
import { isCloudEnabled } from './repo.mjs';

// ── plans ──────────────────────────────────────────────────────────────────

/**
 * Upsert a plan artefact. Returns the plan UUID so audit_runs can link.
 * Idempotent on `(repo_id, path)`.
 */
export async function upsertPlan(repoId, plan) {
  if (!plan?.path || !plan?.skill) return null;
  if (!await isCloudEnabled()) return null;
  if (!repoId) {
    // Idempotence is claimed on (repo_id, path), a FULL unique index. A NULL
    // repo_id is distinct from every other NULL in Postgres, so a null here
    // INSERTs a duplicate plan row on every call instead of updating — same
    // defect class as recordRegressionSpec's repoId guard. Refuse.
    process.stderr.write('  [learning] upsertPlan: requires a resolved repoId (NULL would duplicate on the (repo_id, path) unique index)\n');
    return null;
  }
  try {
    const rows = await upsert('plans', [{
      repo_id: repoId || null,
      path: plan.path,
      skill: plan.skill,
      status: plan.status || 'draft',
      principles_cited: plan.principlesCited || [],   // jsonb — serialized by the db-layer seam
      focus_areas: plan.focusAreas || [],
      commit_sha: plan.commitSha || null,
      checksum: plan.checksum || null,
      updated_at: new Date().toISOString(),
    }], { onConflict: ['repo_id', 'path'], update: 'all', returning: ['id'] });
    return rows[0]?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] upsertPlan failed: ${err.message}\n`);
    return null;
  }
}

/** Update a plan's status. Returns { ok, rowCount }. */
export async function updatePlanStatus(planId, status) {
  if (!planId || !await isCloudEnabled()) return { ok: false, rowCount: 0 };
  try {
    const { rowCount } = await updateWhere('plans',
      { status, updated_at: new Date().toISOString() },
      { id: planId }
    );
    // A 0-row update means the planId matched nothing (stale id, or an RLS
    // policy silently filtered the row) — surface it rather than reporting a
    // phantom success the caller can't distinguish from a real write.
    if (rowCount === 0) {
      process.stderr.write(`  [learning] updatePlanStatus: no row updated for planId=${planId} (stale id or RLS)\n`);
    }
    return { ok: rowCount > 0, rowCount };
  } catch (err) {
    process.stderr.write(`  [learning] updatePlanStatus failed: ${err.message}\n`);
    return { ok: false, rowCount: 0 };
  }
}

// ── regression_specs ───────────────────────────────────────────────────────

/**
 * Record a regression spec authored by /ux-lock. Handles three source-kinds:
 *   - 'persona-consistency-candidate' — upserts by (repo_id, candidate_fingerprint)
 *   - 'persona-consistency-locked'    — upserts by (repo_id, spec_path)
 *   - everything else                  — upserts by (repo_id, spec_path)
 *
 * Pre-egress redaction applies to the three JSONB columns (witness_snapshot,
 * contradiction_payload, journey_context) for both candidate + locked rows
 * (Gemini-R6-G3).
 */
export async function recordRegressionSpec(repoId, spec) {
  if (!await isCloudEnabled()) return null;
  if (!spec?.sourceKind) return null;
  const isCandidate = spec.sourceKind === 'persona-consistency-candidate';
  const isLocked    = spec.sourceKind === 'persona-consistency-locked';

  if (isCandidate) {
    if (!spec.candidateFingerprint || !spec.witnessSnapshot || !spec.contradictionPayload || !spec.journeyContext) {
      process.stderr.write('  [learning] recordRegressionSpec: candidate rows require candidateFingerprint, witnessSnapshot, contradictionPayload, journeyContext\n');
      return null;
    }
    if (!repoId) {
      process.stderr.write('  [learning] recordRegressionSpec: candidate rows require resolved repoId (NULL would silently allow duplicates through the partial unique index)\n');
      return null;
    }
  } else {
    if (!spec.specPath) {
      process.stderr.write('  [learning] recordRegressionSpec: spec_path is required for non-candidate source_kind\n');
      return null;
    }
    if (!repoId) {
      // The (repo_id, spec_path) unique constraint is a FULL index; a NULL
      // repo_id is distinct from every other NULL in Postgres, so the upsert
      // would silently INSERT a duplicate on every re-run instead of updating.
      // Mirror the candidate branch: refuse rather than accrue dupes.
      process.stderr.write('  [learning] recordRegressionSpec: non-candidate rows require a resolved repoId (NULL would duplicate on the (repo_id, spec_path) unique index)\n');
      return null;
    }
  }
  if (!spec.description) return null;

  let redactionCount = 0;
  let witnessSnapshot      = null;
  let contradictionPayload = null;
  let journeyContext       = null;
  if (isCandidate || isLocked) {
    try {
      const { redactObject } = await import('../redact.mjs');
      const w = redactObject(spec.witnessSnapshot ?? null);
      const c = redactObject(spec.contradictionPayload ?? null);
      const j = redactObject(spec.journeyContext ?? null);
      witnessSnapshot      = w.redacted;
      contradictionPayload = c.redacted;
      journeyContext       = j.redacted;
      redactionCount = w.count + c.count + j.count;
    } catch (err) {
      process.stderr.write(`  [learning] recordRegressionSpec: redact failed (${err.message})\n`);
      return null;
    }
  }

  const row = {
    repo_id: repoId || null,
    spec_path: spec.specPath ?? null,
    description: spec.description,
    commit_sha: spec.commitSha || null,
    assertion_count: spec.assertionCount || 0,
    dom_contract_types: spec.domContractTypes || [], // jsonb — serialized by the db-layer seam
    source_kind: spec.sourceKind,
    source_finding_id: spec.sourceFindingId || null,
    source_finding_type: spec.sourceFindingType || null,
    candidate_fingerprint: spec.candidateFingerprint || null,
    witness_snapshot: witnessSnapshot,
    contradiction_payload: contradictionPayload,
    journey_context: journeyContext,
    redaction_count: redactionCount,
    updated_at: new Date().toISOString(),
  };
  const onConflict = isCandidate ? ['repo_id', 'candidate_fingerprint'] : ['repo_id', 'spec_path'];
  // The candidate arbiter is a PARTIAL unique index
  // (idx_regression_specs_candidate_fingerprint, migration 20260520120000);
  // Postgres can only infer it as the ON CONFLICT arbiter when the statement
  // carries a WHERE matching the index predicate. Without this the upsert
  // raises 42P10 on every candidate write. The (repo_id, spec_path) arbiter
  // for non-candidate rows is a full constraint and needs no predicate.
  const conflictWhere = isCandidate
    ? "candidate_fingerprint IS NOT NULL AND source_kind = 'persona-consistency-candidate' AND repo_id IS NOT NULL"
    : undefined;
  try {
    const rows = await upsert('regression_specs', [row], {
      onConflict, conflictWhere, update: 'all', returning: ['id'],
    });
    return rows[0]?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] recordRegressionSpec failed: ${err.message}\n`);
    return null;
  }
}

/**
 * List pending consistency candidates for a repo. Used by /ship at promotion.
 */
export async function listConsistencyCandidates(repoId, opts = {}) {
  if (!repoId || !await isCloudEnabled()) return [];
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;
  try {
    if (opts.sinceTs) {
      return await many(
        `SELECT id, candidate_fingerprint, witness_snapshot, contradiction_payload,
                journey_context, redaction_count, description, commit_sha, created_at
           FROM regression_specs
          WHERE repo_id = $1
            AND source_kind = 'persona-consistency-candidate'
            AND created_at >= $2
          ORDER BY created_at DESC
          LIMIT $3`,
        [repoId, opts.sinceTs, limit]
      );
    }
    return await many(
      `SELECT id, candidate_fingerprint, witness_snapshot, contradiction_payload,
              journey_context, redaction_count, description, commit_sha, created_at
         FROM regression_specs
        WHERE repo_id = $1
          AND source_kind = 'persona-consistency-candidate'
        ORDER BY created_at DESC
        LIMIT $2`,
      [repoId, limit]
    );
  } catch (err) {
    process.stderr.write(`  [learning] listConsistencyCandidates failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Promote a candidate spec row to locked. Atomic update + records
 * spec_path + promoter identity. Optional belt-and-braces re-check on
 * candidate_fingerprint.
 */
export async function promoteRegressionSpec(specId, args) {
  if (!await isCloudEnabled()) return { ok: false, rowsAffected: 0 };
  if (!specId || !args?.specPath || !args?.promotedBy) {
    return { ok: false, rowsAffected: 0 };
  }
  try {
    const pool = await getPool();
    if (!pool) return { ok: false, rowsAffected: 0 };
    const params = [
      args.specPath,
      new Date().toISOString(),
      args.promotedBy,
      specId,
    ];
    let whereExtra = '';
    if (args.candidateFingerprint) {
      params.push(args.candidateFingerprint);
      whereExtra = ` AND candidate_fingerprint = $${params.length}`;
    }
    const res = await pool.query(
      `UPDATE regression_specs
          SET source_kind = 'persona-consistency-locked',
              spec_path = $1,
              promoted_at = $2,
              promoted_by = $3,
              updated_at = $2
        WHERE id = $4
          AND source_kind = 'persona-consistency-candidate'
          ${whereExtra}`,
      params
    );
    return { ok: (res.rowCount || 0) > 0, rowsAffected: res.rowCount || 0 };
  } catch (err) {
    process.stderr.write(`  [learning] promoteRegressionSpec failed: ${err.message}\n`);
    return { ok: false, rowsAffected: 0 };
  }
}

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

/** Append a run outcome for a regression spec. */
export async function recordRegressionSpecRun(specId, run) {
  if (!specId || !await isCloudEnabled()) return;
  const row = {
    spec_id: specId,
    commit_sha: run.commitSha || null,
    passed: !!run.passed,
    captured_regression: !!run.capturedRegression,
    duration_ms: run.durationMs || null,
    error_message: run.errorMessage || null,
    run_context: run.runContext || null,
  };
  // Optional selector-policy telemetry (plan: ux-lock-selector-policy).
  if (run.selectorPolicyViolations != null) row.selector_policy_violations = run.selectorPolicyViolations;
  try {
    await insertRunRowWithPolicyFallback('regression_spec_runs', row);
  } catch (err) {
    process.stderr.write(`  [learning] recordRegressionSpecRun failed: ${err.message}\n`);
  }
}

/**
 * Recent fixes lacking a regression spec (from the `unlocked_fixes` view).
 * Optionally scoped to a repo.
 */
export async function getUnlockedFixes(repoId) {
  if (!await isCloudEnabled()) return [];
  try {
    if (repoId) {
      return await many(
        `SELECT * FROM unlocked_fixes WHERE repo_id = $1 LIMIT 20`,
        [repoId]
      );
    }
    return await many(`SELECT * FROM unlocked_fixes LIMIT 20`);
  } catch (err) {
    process.stderr.write(`  [learning] getUnlockedFixes failed: ${err.message}\n`);
    return [];
  }
}

// ── persona_audit_correlations ─────────────────────────────────────────────

/**
 * Record a correlation between a persona finding and an audit finding —
 * the highest-leverage ground-truth labelling for the bandit reward.
 */
export async function recordPersonaAuditCorrelation(personaSessionId, correlation) {
  if (!personaSessionId || !await isCloudEnabled()) return;
  if (!correlation?.personaFindingHash || !correlation?.correlationType || !correlation?.personaSeverity) return;
  try {
    await upsert('persona_audit_correlations', [{
      persona_session_id: personaSessionId,
      persona_finding_hash: correlation.personaFindingHash,
      persona_severity: correlation.personaSeverity,
      audit_finding_id: correlation.auditFindingId || null,
      audit_run_id: correlation.auditRunId || null,
      correlation_type: correlation.correlationType,
      match_score: correlation.matchScore ?? null,
      match_rationale: correlation.matchRationale || null,
    }], { onConflict: ['persona_session_id', 'persona_finding_hash', 'audit_finding_id'], update: 'all' });
  } catch (err) {
    process.stderr.write(`  [learning] recordPersonaAuditCorrelation failed: ${err.message}\n`);
  }
}

/** Read correlations for a specific audit_run. */
export async function readCorrelationsForRun(auditRunId) {
  if (!auditRunId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persona_audit_correlations WHERE audit_run_id = $1`, [auditRunId]);
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationsForRun failed: ${err.message}\n`);
    return [];
  }
}

/** Read correlations for a specific audit finding. */
export async function readCorrelationsForFinding(auditFindingId) {
  if (!auditFindingId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persona_audit_correlations WHERE audit_finding_id = $1`, [auditFindingId]);
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationsForFinding failed: ${err.message}\n`);
    return [];
  }
}

/** Read the audit_effectiveness view rollup for a repo. */
export async function readAuditEffectiveness(repoId) {
  if (!await isCloudEnabled()) return null;
  try {
    return await one(`SELECT * FROM audit_effectiveness WHERE repo_id = $1 LIMIT 1`, [repoId]);
  } catch (err) {
    process.stderr.write(`  [learning] readAuditEffectiveness failed: ${err.message}\n`);
    return null;
  }
}

// ── plan_verification_runs / plan_verification_items ───────────────────────

/**
 * Record one /ux-lock-verify run; returns the run UUID.
 */
export async function recordPlanVerificationRun(run) {
  if (!run?.planId || !await isCloudEnabled()) return null;
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
    return out?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] recordPlanVerificationRun failed: ${err.message}\n`);
    return null;
  }
}

/** Record per-criterion outcomes for a verification run. */
export async function recordPlanVerificationItems(runId, planId, items) {
  if (!runId || !planId || !Array.isArray(items) || items.length === 0) return;
  if (!await isCloudEnabled()) return;
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
  if (!pool) return;
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
    await pool.query(
      `INSERT INTO plan_verification_items (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES ${valueGroups.join(', ')}`,
      params
    );
  };
  try {
    await insertItems(false);
  } catch (err) {
    // 42703-only: consumer DB predates the `skipped` column (migration
    // 20260704…) — retry once without it so the per-criterion rows aren't lost.
    if (err?.code === '42703' && 'skipped' in rows[0]) {
      process.stderr.write('  [learning] plan_verification_items.skipped missing — run setup-postgres --migrate; recording without it\n');
      try { await insertItems(true); return; }
      catch (retryErr) { process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${retryErr.message}\n`); return; }
    }
    process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${err.message}\n`);
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

// ── ship_events ────────────────────────────────────────────────────────────

/**
 * Record a /ship outcome.
 */
export async function recordShipEvent(repoId, event) {
  if (!event?.outcome || !await isCloudEnabled()) return;
  try {
    await insertReturning('ship_events', {
      repo_id: repoId || null,
      commit_sha: event.commitSha || null,
      branch: event.branch || null,
      outcome: event.outcome,
      block_reasons: event.blockReasons || [], // jsonb — serialized by the db-layer seam
      open_p0_count: event.openP0Count || 0,
      open_p1_count: event.openP1Count || 0,
      missing_spec_count: event.missingSpecCount || 0,
      overridden_by_user: !!event.overriddenByUser,
      override_flag: event.overrideFlag || null,
      stack_detected: event.stackDetected || null,
      framework: event.framework || null,
      duration_ms: event.durationMs || null,
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordShipEvent failed: ${err.message}\n`);
  }
}

/**
 * Read ship-event health for a repo (Cluster D / Phase 7 dashboard).
 * Returns per-outcome counts + the most recent events, or null when cloud is
 * off / the query fails. Repo-scoped (the caller resolves the canonical id).
 *
 * @param {string} repoId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{byOutcome: Array<{outcome:string,count:number}>, recent: object[]}|null>}
 */
export async function readShipEvents(repoId, { limit = 10 } = {}) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    const byOutcome = await many(
      `SELECT outcome, count(*)::int AS count FROM ship_events
        WHERE repo_id = $1 GROUP BY outcome ORDER BY count DESC`,
      [repoId],
    );
    const recent = await many(
      `SELECT outcome, branch, commit_sha, overridden_by_user, created_at
         FROM ship_events WHERE repo_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [repoId, limit],
    );
    return { byOutcome, recent };
  } catch (err) {
    process.stderr.write(`  [learning] readShipEvents failed: ${err.message}\n`);
    return null;
  }
}
