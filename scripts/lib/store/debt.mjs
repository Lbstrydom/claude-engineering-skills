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
 * `(repo_id, topic_id)`. Returns `{ok, reason?, error?}` — `reason` is set
 * ('no-op' | 'cloud-off') exactly when `ok:true` reflects nothing being
 * attempted, so a caller distinguishing "really wrote" from "declined" (the
 * durable-write seam's `debt.entries` writer, `scripts/lib/audit-store-writers.mjs`)
 * doesn't have to re-probe `isCloudEnabled()` itself. `error`, when present,
 * is the raw Error (not a stringified message) so a caller that rethrows it
 * (for connection-vs-artifact classification) keeps `err.code`.
 *
 * @param {string|null} repoId - from upsertRepo(); null skips the call
 * @param {object[]} entries - PersistedDebtEntry-shaped
 */
export async function upsertDebtEntries(repoId, entries) {
  if (!repoId || !Array.isArray(entries) || entries.length === 0) return { ok: true, reason: 'no-op' };
  if (!await isCloudEnabled()) return { ok: true, reason: 'cloud-off' };
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
    return { ok: false, error: err };
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

/**
 * Read the reconciliation snapshot in ONE statement.
 *
 * **Why one statement and not a transaction.** The classification needs the
 * `debt_entries` row set and each topic's latest lifecycle event to describe the
 * SAME instant — otherwise a concurrent resolve can land between two reads and
 * the classifier decides on a state that never existed. A `withTx` wrapper does
 * not give that: under Postgres `READ COMMITTED` (the default) two consecutive
 * `SELECT`s can observe different committed states. A single statement is
 * atomic under every isolation level, so this needs no isolation negotiation.
 *
 * Returns one row per topic known to the store, carrying whether an entry row
 * currently exists and the topic's most recent lifecycle event. Deliberately
 * covers topics with events but no entry — that is exactly the "resolved
 * remotely" case the caller must be able to see.
 *
 * @param {string|null} repoId
 * @returns {Promise<{available: boolean, reason: string|null, rows: Array<{topicId: string, hasEntry: boolean, latestEvent: string|null, latestTs: string|null}>}>}
 */
export async function readReconciliationSnapshot(repoId) {
  if (!repoId) return { available: false, reason: 'repo-identity-unresolved', rows: [] };
  if (!await isCloudEnabled()) return { available: false, reason: 'cloud-off', rows: [] };
  try {
    const rows = await many(
      `WITH topics AS (
         SELECT topic_id FROM debt_entries WHERE repo_id = $1 AND topic_id IS NOT NULL
         UNION
         SELECT topic_id FROM debt_events  WHERE repo_id = $1 AND topic_id IS NOT NULL
       ),
       latest AS (
         SELECT DISTINCT ON (topic_id) topic_id, event, ts
         FROM debt_events
         WHERE repo_id = $1 AND topic_id IS NOT NULL
         -- reopened wins a same-timestamp tie: it is the safer state, and it
         -- makes the tie-break a property of the query rather than of row order.
         ORDER BY topic_id, ts DESC, (event = 'reopened') DESC
       )
       SELECT t.topic_id,
              (e.topic_id IS NOT NULL) AS has_entry,
              l.event AS latest_event,
              l.ts    AS latest_ts
       FROM topics t
       LEFT JOIN debt_entries e ON e.repo_id = $1 AND e.topic_id = t.topic_id
       LEFT JOIN latest l       ON l.topic_id = t.topic_id`,
      [repoId]
    );
    return {
      available: true,
      reason: null,
      rows: rows.map((r) => ({
        topicId: r.topic_id,
        hasEntry: r.has_entry === true,
        latestEvent: r.latest_event ?? null,
        latestTs: r.latest_ts ? new Date(r.latest_ts).toISOString() : null,
      })),
    };
  } catch (err) {
    // Never degrade to an empty snapshot: an empty result would classify every
    // local entry as an orphan and push duplicates, or worse, look like "no
    // debt". Report the failure and let the caller refuse to act.
    process.stderr.write(`  [learning] readReconciliationSnapshot failed: ${err.message}\n`);
    return { available: false, reason: `query-failed:${err.code || 'unknown'}`, rows: [] };
  }
}
