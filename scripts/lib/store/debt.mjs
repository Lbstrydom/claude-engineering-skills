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
  // Idempotency guard runs FIRST — before any cloud work (same ordering
  // rationale as syncFalsePositivePatterns' identity guard: the refusal must
  // not depend on cloud state, and a DB-free suite must be able to prove the
  // WIRING, not just the predicate). `topic_id` sits IN the idempotency key
  // (repo_id, topic_id, run_id, event) and Postgres treats NULLs as DISTINCT
  // in a unique index — a null-topic row can never match itself, so the
  // DO-NOTHING dedup silently degrades to duplicate appends (the 403k-row
  // false_positive_patterns class, bounded here only by event volume; flagged
  // by on-conflict-lint as nullable-conflict-key; topic_id verified nullable
  // in the live schema, so the DB would accept the null). The only
  // legitimately topicId-less event — the local 'reconciled' marker
  // (DebtEventSchema: `topicId: z.string().optional()`) — never reaches this
  // function: reconcileLocalToCloud filters it out of toSync and writes it
  // local-only. So a null here is a caller bug: refuse the whole batch
  // loudly rather than append rows that can never dedup (a partial append
  // would hide the bug behind the valid rows).
  const nullTopic = events.filter((e) => e.topicId == null).length;
  if (nullTopic > 0) {
    const error = `appendDebtEventsCloud: refused — ${nullTopic} event(s) with null/missing topicId would defeat the (repo_id, topic_id, run_id, event) idempotency key`;
    process.stderr.write(`  [debt] ${error}\n`);
    return { inserted: 0, error };
  }
  if (!await isCloudEnabled()) return { inserted: 0 };
  const rows = events.map((e) => ({
    repo_id: repoId,
    // Guaranteed non-null by the guard above — never reintroduce `?? null`
    // here; it silently defeats the conflict target (NULLs are DISTINCT).
    topic_id: e.topicId,
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
