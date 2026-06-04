/**
 * @fileoverview Audit-runs + findings + pass-stats + adjudication domain.
 *
 * Part of the postgres-parity M3 split. The hottest part of the audit-loop
 * persistence surface — every audit run lands here, every finding is
 * recorded here, and every adjudication event mutates here.
 *
 * 11 functions:
 *   audit_runs:      recordRunStart, recordRunComplete, updateRunMeta
 *   audit_findings:  recordFindings (+ _resetClassificationColumnCache test seam)
 *   audit_pass_stats: recordPassStats, updatePassStatsPostDeliberation,
 *                    getPassTimings
 *   suppression_events: recordSuppressionEvents
 *   finding_adjudication_events: recordAdjudicationEvent
 *
 * @module scripts/lib/store/runs-findings
 */

import { many, one, insertReturning, updateWhere, deleteWhere, withTx } from '../db/query.mjs';
import { getPool } from '../db/client.mjs';
import { isCloudEnabled } from './repo.mjs';

// Cached classification-column probe (column shape doesn't change mid-run).
let _hasClassificationColumns = null;

/** Test-only reset for the probe cache (mirrors legacy export). */
export function _resetClassificationColumnCache() {
  _hasClassificationColumns = null;
}

async function detectClassificationColumns() {
  if (_hasClassificationColumns !== null) return _hasClassificationColumns;
  if (!await isCloudEnabled()) {
    _hasClassificationColumns = false;
    return false;
  }
  try {
    // Probe with a 0-row SELECT — succeeds if the column exists.
    await many(`SELECT sonar_type FROM audit_findings LIMIT 0`);
    _hasClassificationColumns = true;
  } catch {
    _hasClassificationColumns = false;
    process.stderr.write('  [learning] classification columns not present — run migration to enable\n');
  }
  return _hasClassificationColumns;
}

// Cached probe for the run-unification `audit_pass_stats.round` column
// (migration 20260605120000). Mirrors the classification probe so the round
// code degrades to the columnless path on an un-migrated store (WS1 §1.3a —
// defense-in-depth: the shared store has it applied, but air-gapped / fresh
// self-hosted stores may not).
let _hasPassStatsRoundColumn = null;

/** Test-only reset for the round-column probe cache. */
export function _resetPassStatsRoundColumnCache() {
  _hasPassStatsRoundColumn = null;
}

async function detectPassStatsRoundColumn() {
  if (_hasPassStatsRoundColumn !== null) return _hasPassStatsRoundColumn;
  if (!await isCloudEnabled()) {
    _hasPassStatsRoundColumn = false;
    return false;
  }
  try {
    await many(`SELECT round FROM audit_pass_stats LIMIT 0`);
    _hasPassStatsRoundColumn = true;
  } catch {
    _hasPassStatsRoundColumn = false;
    process.stderr.write('  [learning] audit_pass_stats.round not present — run migration 20260605120000 for per-round pass telemetry\n');
  }
  return _hasPassStatsRoundColumn;
}

// ── audit_runs ─────────────────────────────────────────────────────────────

/**
 * Insert a new audit_runs row. Returns the new run's id, or null when
 * cloud is disabled / the insert fails.
 */
export async function recordRunStart(repoId, planFile, mode, { scopeMode, commitSha, branch, planId, runId } = {}) {
  if (!await isCloudEnabled()) return null;
  // Run-unification (WS1 §1.2/§1.3b): when the orchestrator threads an explicit
  // `runId`, REUSE the existing audit_runs row so all rounds of one audit share
  // a single run_id. Idempotent — a second call with the same runId returns it
  // without inserting a duplicate or clobbering round-1 metadata. When `runId`
  // is absent (manual single-shot /audit-code) behaviour is byte-identical to
  // before (mint a fresh row).
  if (runId) {
    try {
      const existing = await one(`SELECT id FROM audit_runs WHERE id = $1`, [runId]);
      if (existing?.id) return existing.id; // reuse — do not re-insert
    } catch (err) {
      process.stderr.write(`  [learning] recordRunStart reuse-probe failed: ${err.message}\n`);
      // fall through to insert with the explicit id
    }
  }
  const row = {
    ...(runId ? { id: runId } : {}),
    repo_id: repoId,
    plan_file: planFile,
    mode,
    rounds: 0,
    total_findings: 0,
    accepted_count: 0,
    dismissed_count: 0,
    fixed_count: 0,
    ...(scopeMode ? { scope_mode: scopeMode } : {}),
    ...(commitSha ? { commit_sha: commitSha } : {}),
    ...(branch ? { branch } : {}),
    ...(planId ? { plan_id: planId } : {}),
  };
  try {
    const out = await insertReturning('audit_runs', row, { returning: ['id'] });
    return out?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] recordRunStart failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Update a completed run with final stats + cost / cache telemetry.
 * Best-effort.
 */
export async function recordRunComplete(runId, stats) {
  if (!runId || !await isCloudEnabled()) return;
  const update = {
    rounds: stats.rounds,
    total_findings: stats.totalFindings,
    accepted_count: stats.accepted,
    dismissed_count: stats.dismissed,
    fixed_count: stats.fixed,
    gemini_verdict: stats.geminiVerdict,
    total_cost_estimate: stats.costEstimate,
    total_duration_ms: stats.durationMs,
  };
  if (stats.diffLinesChanged != null) update.diff_lines_changed = stats.diffLinesChanged;
  if (stats.diffFilesChanged != null) update.diff_files_changed = stats.diffFilesChanged;
  if (stats.sessionCacheHit != null) update.session_cache_hit = stats.sessionCacheHit;
  if (stats.mapReducePasses != null) update.map_reduce_passes = stats.mapReducePasses;
  if (stats.r2SkipReason != null) update.r2_skip_reason = stats.r2SkipReason;
  if (stats.cacheInputTokens != null) update.cache_input_tokens = stats.cacheInputTokens;
  if (stats.cacheCachedTokens != null) update.cache_cached_tokens = stats.cacheCachedTokens;
  if (stats.cacheHitRate != null) update.cache_hit_rate = stats.cacheHitRate;
  if (stats.cacheEstimatedSavingsPct != null) update.cache_estimated_savings_pct = stats.cacheEstimatedSavingsPct;
  try {
    await updateWhere('audit_runs', update, { id: runId });
  } catch (err) {
    process.stderr.write(`  [learning] recordRunComplete failed: ${err.message}\n`);
  }
}

/**
 * Non-destructive partial update of run metadata (only the supplied
 * fields are written). Best-effort.
 */
export async function updateRunMeta(runId, meta) {
  if (!runId) return;
  const update = {};
  if (meta.r2SkipReason != null)   update.r2_skip_reason   = meta.r2SkipReason;
  if (meta.geminiVerdict != null)  update.gemini_verdict   = meta.geminiVerdict;
  if (meta.labeled != null)        update.labeled          = meta.labeled;
  if (meta.acceptedCount != null)  update.accepted_count   = meta.acceptedCount;
  if (meta.dismissedCount != null) update.dismissed_count  = meta.dismissedCount;
  if (Object.keys(update).length === 0) return;
  if (!await isCloudEnabled()) return;
  try {
    await updateWhere('audit_runs', update, { id: runId });
  } catch (err) {
    process.stderr.write(`  [learning] updateRunMeta failed: ${err.message}\n`);
  }
}

// ── audit_findings ─────────────────────────────────────────────────────────

/**
 * Insert a batch of findings rows. Optionally includes the Phase B
 * classification columns when the schema supports them.
 */
export async function recordFindings(runId, findings, passName, round) {
  if (!runId || !await isCloudEnabled()) return;
  const hasClassification = await detectClassificationColumns();
  const rows = findings.map((f) => {
    const base = {
      run_id: runId,
      finding_fingerprint: f._hash || 'unknown',
      pass_name: passName,
      severity: f.severity,
      category: f.category,
      primary_file: f._primaryFile || f.section,
      detail_snapshot: f.detail?.slice(0, 600),
      round_raised: round,
    };
    if (!hasClassification) return base;
    return {
      ...base,
      sonar_type: f.classification?.sonarType ?? null,
      effort: f.classification?.effort ?? null,
      source_kind: f.classification?.sourceKind ?? null,
      source_name: f.classification?.sourceName ?? null,
    };
  });
  if (rows.length === 0) return;
  // Bulk INSERT — use the pool directly since we want a multi-row insert
  // with consistent column shape (rows are homogeneous here by construction).
  try {
    const pool = await getPool();
    if (!pool) return;
    const cols = Object.keys(rows[0]);
    const params = [];
    const valueGroups = rows.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const sql = `INSERT INTO audit_findings (${cols.map((c) => `"${c}"`).join(', ')})
                 VALUES ${valueGroups.join(', ')}`;
    await pool.query(sql, params);
  } catch (err) {
    process.stderr.write(`  [learning] recordFindings failed: ${err.message}\n`);
  }
}

// ── audit_pass_stats ───────────────────────────────────────────────────────

/**
 * Insert a pass-level stats row.
 *
 * @param {number} [round] 1-based audit round. Written only when the `round`
 *   column exists (migration 20260605120000); on an un-migrated store it is
 *   omitted and the row defaults to round 1 server-side — preserving today's
 *   behaviour (WS1 §1.3a).
 */
export async function recordPassStats(runId, passName, stats, round) {
  if (!runId || !await isCloudEnabled()) return;
  const hasRound = await detectPassStatsRoundColumn();
  try {
    await insertReturning('audit_pass_stats', {
      run_id: runId,
      pass_name: passName,
      findings_raised: stats.raised || 0,
      findings_accepted: stats.accepted || 0,
      findings_dismissed: stats.dismissed || 0,
      findings_compromised: stats.compromised || 0,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      latency_ms: stats.latencyMs,
      reasoning_effort: stats.reasoning,
      prompt_variant_id: stats.promptVariantId,
      ...(hasRound && Number.isInteger(round) ? { round } : {}),
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordPassStats failed: ${err.message}\n`);
  }
}

/**
 * After deliberation, update findings_accepted / findings_dismissed /
 * findings_compromised on each pass's stats row. Called by outcome-sync.
 */
export async function updatePassStatsPostDeliberation(runId, passCounts) {
  if (!runId || !await isCloudEnabled()) return;
  // Post-deliberation counts are run-FINAL (canonical adjudication truth lives in
  // audit_findings.adjudication_outcome; these are denormalized telemetry). Under
  // run-unification one run_id spans many per-round pass_stats rows, so matching
  // on (run_id, pass_name) alone overwrites EVERY round's row. Scope to the LATEST
  // round's row per pass so the final counts land unambiguously on the
  // convergence-round row (WS1 §1.3a / Gemini-R2-H1). On an un-migrated store
  // (no `round` column) fall back to the original match — today's behaviour.
  const hasRound = await detectPassStatsRoundColumn();
  for (const [passName, counts] of Object.entries(passCounts)) {
    try {
      const patch = {
        findings_accepted: counts.accepted,
        findings_dismissed: counts.dismissed,
        findings_compromised: counts.compromised || 0,
      };
      if (hasRound) {
        const maxRow = await one(
          `SELECT max(round) AS r FROM audit_pass_stats WHERE run_id = $1 AND pass_name = $2`,
          [runId, passName]
        );
        if (maxRow?.r == null) continue; // no row for this pass under the run
        await updateWhere('audit_pass_stats', patch, { run_id: runId, pass_name: passName, round: maxRow.r });
      } else {
        await updateWhere('audit_pass_stats', patch, { run_id: runId, pass_name: passName });
      }
    } catch (err) {
      process.stderr.write(`  [learning] updatePassStats(${passName}) failed: ${err.message}\n`);
    }
  }
}

/**
 * Read convergence/stop-round signals for one audit_runs row. Powers the
 * convergence_predict outcome detector in
 * scripts/learning/backfill-outcomes.mjs, which previously reached for a
 * raw supabase client (M3 P3 raw-client removal).
 *
 * @param {string} runId
 * @returns {Promise<{roundConvergedAfter: number|null, rigorPressureRound: number|null, rounds: number|null}|null>}
 */
/**
 * Per-run finding-outcome counts, used by the `pass_selection` resolver
 * (Cluster B / Phase 4). `acceptedOrFixed` counts findings the deliberation
 * sustained; `anyAdjudicated` tells the resolver whether outcome-sync has run
 * yet (if not, the decision stays pending rather than resolving to a false 0).
 *
 * @param {string} runId
 * @returns {Promise<{total:number, acceptedOrFixed:number, anyAdjudicated:boolean}|null>}
 */
export async function getRunFindingOutcomeCounts(runId) {
  if (!runId || !await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE adjudication_outcome = 'accepted')::int AS accepted_or_fixed,
              count(*) FILTER (WHERE adjudication_outcome IS NOT NULL)::int AS adjudicated
         FROM audit_findings WHERE run_id = $1`,
      [runId],
    );
    if (!row) return null;
    return {
      total: Number(row.total),
      acceptedOrFixed: Number(row.accepted_or_fixed),
      anyAdjudicated: Number(row.adjudicated) > 0,
    };
  } catch {
    return null;
  }
}

export async function getAuditRunConvergence(runId) {
  if (!runId || !await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT round_converged_after, rigor_pressure_round, rounds
         FROM audit_runs WHERE id = $1 LIMIT 1`,
      [runId]
    );
    if (!row) return null;
    return {
      roundConvergedAfter: row.round_converged_after,
      rigorPressureRound:  row.rigor_pressure_round,
      rounds:              row.rounds,
    };
  } catch {
    return null;
  }
}

/**
 * Aggregate average pass timing/token data across all rows where
 * input_tokens > 0. In-memory aggregation matches the legacy approach.
 */
export async function getPassTimings() {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await many(
      `SELECT pass_name, input_tokens, output_tokens, latency_ms
         FROM audit_pass_stats
        WHERE input_tokens > 0`
    );
    const byPass = {};
    for (const row of rows) {
      if (!byPass[row.pass_name]) byPass[row.pass_name] = { totalIn: 0, totalOut: 0, totalLat: 0, count: 0 };
      const p = byPass[row.pass_name];
      p.totalIn += row.input_tokens || 0;
      p.totalOut += row.output_tokens || 0;
      p.totalLat += row.latency_ms || 0;
      p.count++;
    }
    return Object.entries(byPass).map(([passName, p]) => ({
      passName,
      avgInputTokens: Math.round(p.totalIn / p.count),
      avgOutputTokens: Math.round(p.totalOut / p.count),
      avgLatencyMs: Math.round(p.totalLat / p.count),
      runCount: p.count,
    }));
  } catch (err) {
    process.stderr.write(`  [learning] getPassTimings failed: ${err.message}\n`);
    return [];
  }
}

// ── suppression_events ─────────────────────────────────────────────────────

/**
 * Record both suppressed-and-reopened events from an R2+ post-processing pass.
 */
export async function recordSuppressionEvents(runId, suppressionResult) {
  if (!runId || !await isCloudEnabled()) return;
  const rows = [
    ...suppressionResult.suppressed.map((s) => ({
      run_id: runId,
      finding_fingerprint: s.finding?._hash || 'unknown',
      matched_topic_id: s.matchedTopic,
      match_score: s.matchScore,
      action: 'suppressed',
      reason: s.reason,
    })),
    ...suppressionResult.reopened.map((f) => ({
      run_id: runId,
      finding_fingerprint: f._hash || 'unknown',
      matched_topic_id: f._matchedTopic,
      match_score: f._matchScore,
      action: 'reopened',
      reason: 'Scope changed',
    })),
  ];
  if (rows.length === 0) return;
  try {
    const pool = await getPool();
    if (!pool) return;
    const cols = Object.keys(rows[0]);
    const params = [];
    const valueGroups = rows.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const sql = `INSERT INTO suppression_events (${cols.map((c) => `"${c}"`).join(', ')})
                 VALUES ${valueGroups.join(', ')}`;
    await pool.query(sql, params);
  } catch (err) {
    process.stderr.write(`  [learning] recordSuppressionEvents failed: ${err.message}\n`);
  }
}

// ── finding_adjudication_events ────────────────────────────────────────────

/**
 * Record an adjudication event for a finding. Two-step:
 *   1. Resolve the audit_findings.id from the finding fingerprint
 *      (+ optional pass_name / round_raised disambiguation)
 *   2. Inside a transaction:
 *        - DELETE any prior adjudication events on this finding (idempotent re-record)
 *        - INSERT the new event
 *        - UPDATE audit_findings.adjudication_outcome (denormalised)
 */
export async function recordAdjudicationEvent(runId, findingFingerprint, event) {
  if (!runId || !await isCloudEnabled()) return;
  try {
    // Build the disambiguating WHERE clause for the finding lookup.
    const where = ['run_id = $1', 'finding_fingerprint = $2'];
    const params = [runId, findingFingerprint];
    if (event.passName) {
      where.push(`pass_name = $${params.length + 1}`);
      params.push(event.passName);
    }
    if (event.round) {
      where.push(`round_raised = $${params.length + 1}`);
      params.push(event.round);
    }
    const finding = await one(
      `SELECT id FROM audit_findings WHERE ${where.join(' AND ')} LIMIT 1`,
      params
    );
    if (!finding?.id) return;

    await withTx(async () => {
      await deleteWhere('finding_adjudication_events', { finding_id: finding.id });
      await insertReturning('finding_adjudication_events', {
        finding_id: finding.id,
        adjudication_outcome: event.adjudicationOutcome,
        remediation_state: event.remediationState,
        ruling: event.ruling,
        ruling_rationale: event.rulingRationale,
        round: event.round,
      });
      await updateWhere('audit_findings',
        { adjudication_outcome: event.adjudicationOutcome },
        { id: finding.id }
      );
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordAdjudicationEvent failed: ${err.message}\n`);
  }
}
