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
/**
 * Run a store write and report BOTH contracts this module is read under.
 *
 * `{ok}` is the historical shape every existing caller here reads. `applied` /
 * `rows` / `reason` is the shape `durable-write.mjs`'s `receipt()` requires —
 * it computes `applied = r?.applied === true`, so a bare `{ok:true}` reads as
 * NOT APPLIED. That mismatch is not theoretical: when
 * `recordConvergenceState` / `recordDiffComplexity` / `backfillLearningOutcome`
 * became spill-eligible writers (2026-08-13), their replays returned
 * `{ok:true}` for writes that had genuinely landed, so `drainSpill` scored
 * every one as `failed`, incremented no attempt counter, quarantined nothing,
 * and handed the artifact straight back to the queue. Measured: 31 artifacts,
 * 0 drained, on a store that already held the data. Every audit run in the repo
 * then reported `runStatus: incomplete` on the strength of it — the durability
 * signal inverted, reporting loss where there was none.
 *
 * Returning a SUPERSET rather than switching contracts is deliberate: nothing
 * reading `.ok` changes behaviour, and `receipt()` starts seeing the truth.
 * `rows` is the driver's real `rowCount`, never a fabricated 1 — a 0-row UPDATE
 * is `applied:true, rows:0`, which is an honest "the statement ran and matched
 * nothing", distinct from a failure.
 */
async function safeWrite(fn) {
  try {
    const res = await fn();
    return { ok: true, applied: true, rows: res?.rowCount ?? 0 };
  } catch (err) {
    return { ok: false, applied: false, error: err.message };
  }
}

/**
 * A write that was never attempted, with a reason `receipt()` recognises as a
 * DECLINE (`cloud-off` / `no-run-id`) rather than a retryable failure. Without
 * the reason a spilled artifact for a cloud-off run would be retried forever
 * instead of being recorded as declined.
 *
 * @param {'cloud-off'|'no-run-id'|'nothing-to-write'} reason
 */
function notAttempted(reason) {
  return { ok: true, applied: false, rows: 0, reason };
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
  // @on-conflict-ok: decision_key is GLOBALLY unique by construction — buildDecisionKey emits either `<audit_run_id uuid>:<type>:r<n>:s<n>` or `<type>:<external_id>`, so the scope is already carried inside the key text. Adding repo_id would WEAKEN this: UNIQUE(repo_id, decision_key) starts permitting the same decision_key under two repos, and repo_id is nullable — reintroducing the NULL-distinct bug WS-C exists to close. Measured 2026-07-19: 1876 rows, 0 NULL repo_id, 2 distinct repos, no key collisions (WS-C2).
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
  if (!await isCloudEnabled()) return notAttempted('cloud-off');
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
  if (!runId) return notAttempted('no-run-id');
  if (!await isCloudEnabled()) return notAttempted('cloud-off');
  return safeWrite(() => updateWhere(
    'audit_runs', { diff_complexity: complexity }, { id: runId }
  ));
}

/**
 * Update audit_runs.round_converged_after + rigor_pressure_round.
 */
export async function recordConvergenceState(runId, state) {
  if (!runId) return notAttempted('no-run-id');
  if (!await isCloudEnabled()) return notAttempted('cloud-off');
  const patch = {};
  if (state.round_converged_after !== undefined) patch.round_converged_after = state.round_converged_after;
  if (state.rigor_pressure_round  !== undefined) patch.rigor_pressure_round  = state.rigor_pressure_round;
  // E1 hop 2 — bind the verdict to a SUBJECT, not just a time. The local
  // `.audit/last-audit-run.json` marker is a file anyone could hand-author, so
  // it can only ever be necessary evidence; the store's copy is written by the
  // pipeline and is what makes a forged marker detectable (a hand-written
  // `auditedTree` would disagree with the row for the same runId).
  if (state.audited_sha  !== undefined) patch.audited_sha  = state.audited_sha;
  if (state.audited_tree !== undefined) patch.audited_tree = state.audited_tree;
  // Nothing to write is NOT "applied" — but it is also not a failure, and it
  // must not be retried forever. `nothing-to-write` is deliberately OUTSIDE
  // DECLINED_REASONS: a spilled artifact carrying an empty patch is malformed,
  // and dressing that up as a clean decline would hide it.
  if (Object.keys(patch).length === 0) return notAttempted('nothing-to-write');
  return safeWrite(() => updateWhere('audit_runs', patch, { id: runId }));
}

// ── audit_findings patches ─────────────────────────────────────────────────

/**
 * Update audit_findings resolution columns.
 *
 * @deprecated Cluster B (§Phase 3): writes the `user_action` column, but the
 * single source of truth for finding outcomes is `adjudication_outcome` (written
 * by `recordAdjudicationEvent` and consumed by the `audit_effectiveness` view).
 * This function has no production callers; it is retained only for the frozen
 * public-export contract + graceful-degradation test. Do not wire new code to
 * `user_action` — use the adjudication path.
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

/**
 * Aggregate author_tier observation rows for a repo (model-tier-observation —
 * observation-only telemetry). Returns RAW grouped rows; the dashboard collector
 * shapes them via aggregateAuthorTier(). Graceful: cloud off / no repo → empty.
 *
 * @param {{repoId:string|null}} opts
 * @returns {Promise<{cloud:boolean, rows:Array}>}
 */
export async function getAuthorTierStats({ repoId }) {
  if (!repoId || !await isCloudEnabled()) return { cloud: false, rows: [] };
  try {
    const rows = await many(
      `SELECT
          context->>'declaredTierSource' AS declared_source,
          context->>'authorProvider'     AS provider,
          context->>'authorFamily'       AS family,
          context->>'authorModel'        AS model,
          choice->>'suggestedTier'       AS suggested_tier,
          choice->>'declaredTier'        AS declared_tier,
          (outcome->>'converged')        AS converged,
          COUNT(*)::int                  AS n
         FROM learning_decisions
        WHERE decision_type = 'author_tier' AND repo_id = $1
        GROUP BY 1, 2, 3, 4, 5, 6, 7`,
      [repoId]
    );
    return { cloud: true, rows };
  } catch {
    return { cloud: false, rows: [] };
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

/**
 * Recompute recurring_finding_clusters for one repo from audit_findings
 * (signal-recovery Cluster C / Phase 6). Idempotent full per-repo recompute via
 * the `refresh_recurring_clusters` RPC; returns the upserted cluster count (0
 * when cloud is off). Never throws — best-effort maintenance.
 *
 * @param {string} repoId
 * @returns {Promise<number>}
 */
export async function refreshRecurringClusters(repoId) {
  if (!repoId || !await isCloudEnabled()) return 0;
  try {
    const row = await one(`SELECT refresh_recurring_clusters($1) AS n`, [repoId]);
    return Number(row?.n) || 0;
  } catch (err) {
    process.stderr.write(`  [learning] refreshRecurringClusters failed: ${err.message}\n`);
    return 0;
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

// ── learning_decisions reads (replaces the raw-client callers M3 removes) ──

/**
 * Paginated read of learning_decisions filtered by decision_type, time
 * range, and (optional) repo. Returns up to `hardCap` rows total — replaces
 * the raw-client pagination loop in scripts/lib/learning/replay.mjs and
 * scripts/lib/learning/quickfix-stats.mjs.
 *
 * Plan §7 P3 — one of the 6 named exports the caller migrations consume.
 *
 * @param {object} input
 * @param {string}      input.decisionType
 * @param {number}      [input.sinceMs]   — only rows with created_at >= now - sinceMs
 * @param {string|null} [input.repoId]
 * @param {number}      [input.pageSize=1000]
 * @param {number}      [input.hardCap=5000] — safety cap to bound memory
 * @returns {Promise<Array<object>>}
 */
export async function readDecisionsPaginated({
  decisionType, sinceMs, repoId = null, pageSize = 1000, hardCap = 5000,
}) {
  if (!decisionType) throw new Error('decisionType is required');
  if (!await isCloudEnabled()) return [];
  const cols = 'decision_key, decision_type, context, choice, outcome, outcome_at, created_at, repo_id';
  const rows = [];
  let offset = 0;
  while (rows.length < hardCap) {
    const params = [decisionType];
    let where = `decision_type = $1`;
    if (sinceMs != null) {
      const cutoff = new Date(Date.now() - sinceMs).toISOString();
      params.push(cutoff);
      where += ` AND created_at >= $${params.length}`;
    }
    if (repoId) {
      params.push(repoId);
      where += ` AND repo_id = $${params.length}`;
    }
    params.push(pageSize);
    params.push(offset);
    let page;
    try {
      page = await many(
        `SELECT ${cols} FROM learning_decisions
          WHERE ${where}
          ORDER BY created_at ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
    } catch (err) {
      process.stderr.write(`  [learning] readDecisionsPaginated error: ${err.message}\n`);
      break;
    }
    if (page.length === 0) break;
    for (const r of page) rows.push(r);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

/**
 * Read learning_decisions where `outcome IS NULL` and `created_at < cutoff`,
 * filtered by allowed decision_types. Powers the out-of-band outcome-
 * resolution loop in scripts/learning/backfill-outcomes.mjs.
 *
 * Plan §7 P3 — one of the 6 named exports.
 *
 * @param {object} input
 * @param {string[]}    input.types  — allowlist of decision_types to consider
 * @param {string|Date} input.cutoff — created_at < cutoff
 * @param {string|null} [input.repoId]
 * @param {number}      [input.limit=500]
 * @returns {Promise<Array<object>>}
 */
export async function readUnresolvedDecisions({ types, cutoff, repoId = null, limit = 500 }) {
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error('readUnresolvedDecisions: types array is required');
  }
  if (!await isCloudEnabled()) return [];
  const cutoffIso = cutoff instanceof Date ? cutoff.toISOString() : String(cutoff);
  const params = [types, cutoffIso];
  let where = `decision_type = ANY($1) AND outcome IS NULL AND created_at < $2`;
  if (repoId) {
    params.push(repoId);
    where += ` AND repo_id = $${params.length}`;
  }
  params.push(limit);
  try {
    return await many(
      `SELECT decision_key, decision_type, context, choice, created_at,
              audit_run_id, round, sequence
         FROM learning_decisions
        WHERE ${where}
        LIMIT $${params.length}`,
      params
    );
  } catch (err) {
    process.stderr.write(`  [learning] readUnresolvedDecisions error: ${err.message}\n`);
    return [];
  }
}
