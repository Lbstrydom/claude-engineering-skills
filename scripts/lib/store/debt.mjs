/**
 * @fileoverview Debt-ledger domain — `debt_entries` + `debt_events` CRUD.
 *
 * Part of the postgres-parity M3 domain split (plan §2 "Domain-module split").
 * Translates 5 debt-related functions from `scripts/learning-store.mjs`.
 *
 * @module scripts/lib/store/debt
 */

import { many, deleteWhere, upsert } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

/**
 * Upsert PersistedDebtEntry rows for a repo. Idempotent on
 * `(repo_id, topic_id)`. Returns `{ok, error?}`.
 *
 * @param {string|null} repoId - from upsertRepo(); null skips the call
 * @param {object[]} entries - PersistedDebtEntry-shaped
 */
export async function upsertDebtEntries(repoId, entries) {
  if (!repoId || !Array.isArray(entries) || entries.length === 0) return { ok: true };
  if (!await isCloudEnabled()) return { ok: true };
  const rows = entries.map((e) => ({
    repo_id: repoId,
    topic_id: e.topicId,
    semantic_hash: e.semanticHash,
    severity: e.severity,
    category: e.category,
    section: e.section,
    detail_snapshot: e.detailSnapshot,
    affected_files: e.affectedFiles ?? [],          // jsonb — serialized by the db-layer seam
    affected_principles: e.affectedPrinciples ?? [],
    pass: e.pass,
    sonar_type: e.classification?.sonarType ?? null,
    effort: e.classification?.effort ?? null,
    source_kind: e.classification?.sourceKind ?? null,
    source_name: e.classification?.sourceName ?? null,
    deferred_reason: e.deferredReason,
    deferred_at: e.deferredAt,
    deferred_run: e.deferredRun,
    deferred_rationale: e.deferredRationale,
    blocked_by: e.blockedBy ?? null,
    followup_pr: e.followupPr ?? null,
    approver: e.approver ?? null,
    approved_at: e.approvedAt ?? null,
    policy_ref: e.policyRef ?? null,
    owner: e.owner ?? null,
    content_aliases: e.contentAliases || [], // jsonb — serialized by the db-layer seam
    sensitive: e.sensitive ?? false,
    updated_at: new Date().toISOString(),
  }));
  try {
    await upsert('debt_entries', rows, { onConflict: ['repo_id', 'topic_id'], update: 'all' });
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] upsertDebtEntries failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Read all debt entries for a repo. Returns PersistedDebtEntry-shaped
 * objects (no derived fields — derive via events).
 *
 * @param {string|null} repoId
 */
export async function readDebtEntriesCloud(repoId) {
  if (!repoId || !await isCloudEnabled()) return [];
  try {
    const rows = await many(
      `SELECT * FROM debt_entries WHERE repo_id = $1`,
      [repoId]
    );
    return rows.map((row) => ({
      source: 'debt',
      topicId: row.topic_id,
      semanticHash: row.semantic_hash,
      severity: row.severity,
      category: row.category,
      section: row.section,
      detailSnapshot: row.detail_snapshot,
      affectedFiles: row.affected_files || [],
      affectedPrinciples: row.affected_principles || [],
      pass: row.pass,
      classification: row.sonar_type
        ? { sonarType: row.sonar_type, effort: row.effort, sourceKind: row.source_kind, sourceName: row.source_name }
        : null,
      deferredReason: row.deferred_reason,
      deferredAt: row.deferred_at,
      deferredRun: row.deferred_run,
      deferredRationale: row.deferred_rationale,
      blockedBy: row.blocked_by ?? undefined,
      followupPr: row.followup_pr ?? undefined,
      approver: row.approver ?? undefined,
      approvedAt: row.approved_at ?? undefined,
      policyRef: row.policy_ref ?? undefined,
      owner: row.owner ?? undefined,
      contentAliases: row.content_aliases || [],
      sensitive: row.sensitive ?? false,
    }));
  } catch (err) {
    process.stderr.write(`  [learning] readDebtEntriesCloud failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Delete a debt entry by `(repo_id, topic_id)`. Idempotent — no-op when
 * the row doesn't exist.
 */
export async function removeDebtEntryCloud(repoId, topicId) {
  if (!repoId || !await isCloudEnabled()) return { ok: true };
  try {
    await deleteWhere('debt_entries', { repo_id: repoId, topic_id: topicId });
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] removeDebtEntryCloud failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Append debt events. Idempotent via the
 * `(repo_id, topic_id, run_id, event)` UNIQUE constraint — duplicate
 * inserts are silently dropped, enabling the offline→cloud reconciler.
 *
 * @param {string|null} repoId
 * @param {object[]} events - DebtEvent-shaped
 * @returns {Promise<{inserted: number, error?: string}>}
 */
export async function appendDebtEventsCloud(repoId, events) {
  if (!repoId || !Array.isArray(events) || events.length === 0) return { inserted: 0 };
  if (!await isCloudEnabled()) return { inserted: 0 };
  const rows = events.map((e) => ({
    repo_id: repoId,
    topic_id: e.topicId ?? null,
    event: e.event,
    run_id: e.runId,
    ts: e.ts,
    match_count: e.matchCount ?? null,
    rationale: e.rationale ?? null,
    resolution_rationale: e.resolutionRationale ?? null,
    resolved_by: e.resolvedBy ?? null,
  }));
  try {
    const out = await upsert('debt_events', rows, {
      onConflict: ['repo_id', 'topic_id', 'run_id', 'event'],
      update: 'ignore',   // matches supabase-js ignoreDuplicates: true
      returning: ['id'],
    });
    return { inserted: Array.isArray(out) ? out.length : 0 };
  } catch (err) {
    process.stderr.write(`  [learning] appendDebtEventsCloud failed: ${err.message}\n`);
    return { inserted: 0, error: err.message };
  }
}

/**
 * Read all debt events for a repo, ordered chronologically.
 *
 * @param {string|null} repoId
 */
export async function readDebtEventsCloud(repoId) {
  if (!repoId || !await isCloudEnabled()) return [];
  try {
    const rows = await many(
      `SELECT * FROM debt_events WHERE repo_id = $1 ORDER BY ts ASC`,
      [repoId]
    );
    return rows.map((row) => ({
      ts: row.ts,
      runId: row.run_id,
      topicId: row.topic_id ?? undefined,
      event: row.event,
      matchCount: row.match_count ?? undefined,
      rationale: row.rationale ?? undefined,
      resolutionRationale: row.resolution_rationale ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
    }));
  } catch (err) {
    process.stderr.write(`  [learning] readDebtEventsCloud failed: ${err.message}\n`);
    return [];
  }
}
