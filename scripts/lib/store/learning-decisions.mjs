/**
 * @fileoverview Learning-decisions + RPC bridges + friction-log domain.
 *
 * Part of the postgres-parity M3 domain split. Translates 11 functions
 * spanning the learning telemetry surface — `learning_decisions` upserts,
 * audit_runs/audit_findings patch helpers, the two RPC procedures
 * (defer_finding / mark_finding_needs_triage), the per-repo Phase 1
 * weekly-review reads, and the friction log.
 *
 * @module scripts/lib/store/learning-decisions
 */

import { many, one, insertReturning, upsert, updateWhere } from '../db/query.mjs';
import { deferFinding as rpcDeferFinding, markFindingNeedsTriage as rpcMarkFindingNeedsTriage } from '../db/rpc.mjs';
import { isCloudEnabled } from './repo.mjs';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * `_safeWriteCall` analogue — wraps a thunk + returns `{ok, error?}`.
 * Preserves the legacy `_safeWriteCall` error-swallowing contract (#16
 * graceful degradation).
 */
async function safeWrite(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── learning_decisions ─────────────────────────────────────────────────────

/**
 * Insert one learning_decisions row. Idempotent via decision_key UNIQUE
 * (`ON CONFLICT DO NOTHING`). Caller MUST derive decision_key first via
 * scripts/lib/learning/decision-logger.mjs::buildDecisionKey().
 *
 * @param {object} entry
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function insertLearningDecision(entry) {
  if (!await isCloudEnabled()) return { ok: true };
  return safeWrite(() => upsert(
    'learning_decisions',
    [{
      decision_key:  entry.decisionKey,
      audit_run_id:  entry.auditRunId  ?? null,
      decision_type: entry.decisionType,
      round:         entry.round       ?? null,
      sequence:      entry.sequence    ?? null,
      external_id:   entry.externalId  ?? null,
      repo_id:       entry.repoId      ?? null,
      context:       entry.context,
      context_hash:  entry.contextHash,
      choice:        entry.choice,
      outcome:       entry.outcome     ?? null,
    }],
    { onConflict: 'decision_key', update: 'ignore' }   // matches ignoreDuplicates: true
  ));
}

/**
 * Update `outcome` + `outcome_at` on a learning_decisions row by
 * decision_key. Idempotent — same outcome twice is a no-op.
 *
 * @param {{decisionKey: string, outcome: object}} input
 */
export async function backfillLearningOutcome({ decisionKey, outcome }) {
  if (!await isCloudEnabled()) return { ok: true };
  return safeWrite(() => updateWhere(
    'learning_decisions',
    { outcome, outcome_at: new Date().toISOString() },
    { decision_key: decisionKey }
  ));
}

// ── audit_runs patches ─────────────────────────────────────────────────────

/**
 * Update audit_runs.diff_complexity. Best-effort.
 */
export async function recordDiffComplexity(runId, complexity) {
  if (!runId || !await isCloudEnabled()) return { ok: true };
  return safeWrite(() => updateWhere(
    'audit_runs', { diff_complexity: complexity }, { id: runId }
  ));
}

/**
 * Update audit_runs.round_converged_after + rigor_pressure_round.
 */
export async function recordConvergenceState(runId, state) {
  if (!runId || !await isCloudEnabled()) return { ok: true };
  const patch = {};
  if (state.round_converged_after !== undefined) patch.round_converged_after = state.round_converged_after;
  if (state.rigor_pressure_round  !== undefined) patch.rigor_pressure_round  = state.rigor_pressure_round;
  if (Object.keys(patch).length === 0) return { ok: true };
  return safeWrite(() => updateWhere('audit_runs', patch, { id: runId }));
}

// ── audit_findings patches ─────────────────────────────────────────────────

/**
 * Update audit_findings resolution columns.
 */
export async function recordFindingResolution(findingId, resolution) {
  if (!findingId || !await isCloudEnabled()) return { ok: true };
  const patch = {};
  if (resolution.user_action            !== undefined) patch.user_action            = resolution.user_action;
  if (resolution.dismiss_reason         !== undefined) patch.dismiss_reason         = resolution.dismiss_reason;
  if (resolution.fix_commit_sha         !== undefined) patch.fix_commit_sha         = resolution.fix_commit_sha;
  if (resolution.time_to_resolution_ms  !== undefined) patch.time_to_resolution_ms  = resolution.time_to_resolution_ms;
  if (Object.keys(patch).length === 0) return { ok: true };
  return safeWrite(() => updateWhere('audit_findings', patch, { id: findingId }));
}

// ── RPC bridges (M1 wrappers) ──────────────────────────────────────────────

/**
 * Invoke `defer_finding(...)` — single transactional write boundary that
 * updates audit_findings, upserts recurring_clusters, and inserts
 * learning_decisions. Idempotent via decision_key.
 */
export async function callDeferFinding({
  findingId, dismissReason, evidence, clusterHash, severity,
  auditRunId, round, sequence,
}) {
  if (!await isCloudEnabled()) return { ok: true };
  return safeWrite(() => rpcDeferFinding({
    findingId, dismissReason, evidence, clusterHash, severity,
    auditRunId, round, sequence,
  }));
}

/** Invoke `mark_finding_needs_triage(...)`. */
export async function callMarkFindingNeedsTriage({
  findingId, reason, auditRunId, round, sequence, evidence,
}) {
  if (!await isCloudEnabled()) return { ok: true };
  return safeWrite(() => rpcMarkFindingNeedsTriage({
    findingId, reason, auditRunId, round, sequence, evidence,
  }));
}

// ── Phase 1 per-repo reads (weekly-review) ─────────────────────────────────

/**
 * Read pending_triage_findings view, scoped to a repo. The required
 * `repoId` argument prevents accidental cross-tenant queries — never
 * defaults to global.
 */
export async function readPendingTriageFindings({ repoId, limit = 100 }) {
  if (!repoId) throw new Error('repoId is required');
  if (!await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT * FROM pending_triage_findings WHERE repo_id = $1 LIMIT $2`,
      [repoId, limit]
    );
  } catch {
    return [];
  }
}

export async function readNoBrainerRecommendations({ repoId, limit = 50 }) {
  if (!repoId) throw new Error('repoId is required');
  if (!await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT * FROM no_brainer_recommendations WHERE repo_id = $1 LIMIT $2`,
      [repoId, limit]
    );
  } catch {
    return [];
  }
}

export async function readStaleClusters({ repoId, ageDays = 30, limit = 50 }) {
  if (!repoId) throw new Error('repoId is required');
  if (!await isCloudEnabled()) return [];
  try {
    const cutoff = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
    return await many(
      `SELECT * FROM recurring_finding_clusters
         WHERE repo_id = $1 AND status = 'open' AND last_seen < $2
         LIMIT $3`,
      [repoId, cutoff, limit]
    );
  } catch {
    return [];
  }
}

// ── Friction log ───────────────────────────────────────────────────────────

/**
 * Insert one friction-log row. Service-role; never throws.
 *
 * @param {{repoId?: string|null, auditRunId?: string|null, message: string,
 *          cwd?: string|null, severity?: 'note'|'annoyance'|'blocker'}} input
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
export async function insertFrictionNote(input) {
  if (!await isCloudEnabled()) return { ok: true };
  try {
    const row = await insertReturning(
      'friction_log',
      {
        repo_id:      input.repoId      ?? null,
        audit_run_id: input.auditRunId  ?? null,
        message:      input.message,
        cwd:          input.cwd         ?? null,
        severity:     input.severity    ?? 'note',
      },
      { returning: ['id'] }
    );
    return { ok: true, id: row?.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Read recent friction-log entries for one repo. Ordered by created_at
 * DESC. Anon-readable.
 *
 * @param {{repoId: string, sinceMs?: number, limit?: number}} input
 */
export async function readRecentFriction({ repoId, sinceMs = 7 * 24 * 60 * 60 * 1000, limit = 100 }) {
  if (!repoId) throw new Error('repoId is required');
  if (!await isCloudEnabled()) return [];
  try {
    const cutoff = new Date(Date.now() - sinceMs).toISOString();
    return await many(
      `SELECT id, message, severity, created_at, cwd, audit_run_id
         FROM friction_log
        WHERE repo_id = $1 AND created_at >= $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [repoId, cutoff, limit]
    );
  } catch {
    return [];
  }
}
