/**
 * @fileoverview Debt-ledger domain — `debt_entries` + `debt_events` CRUD.
 *
 * Part of the postgres-parity M3 domain split (plan §2 "Domain-module split").
 * Translates 5 debt-related functions from `scripts/learning-store.mjs`.
 *
 * @module scripts/lib/store/debt
 */

import { many, one, deleteWhere, upsert } from '../db/query.mjs';
import { getPool } from '../db/client.mjs';
import { isCloudEnabled } from './repo.mjs';
import { PersistedDebtEntrySchema, normalizeClassificationEnvelope } from '../schemas.mjs';
import { toVectorLiteral } from '../semantic-suppression.mjs';
import { populateContentAliases } from '../debt-alias.mjs';

/**
 * Best-effort content-aliasing for a batch of debt entries, from a
 * `tech-debt`-domain caller that has no pool of its own
 * (docs/plans/debt-ledger-persisted-record-contract.md §2 Fix C —
 * `debt-memory.mjs`'s `persistDebtEntries`). Pool lifecycle stays private to
 * this `stores`-domain module — never handed back as a raw accessor, which
 * would reopen exactly the `getReadClient`/`getWriteClient` abstraction
 * breach `scripts/learning-store.mjs`'s own module docstring says was
 * deliberately removed (R3/M2). Fail-open by delegation: any failure inside
 * `populateContentAliases` (no pool, no provider, a query error) already
 * returns entries unchanged; a `getPool()` failure here is caught the same
 * way and does the same.
 *
 * @param {object[]} entries
 * @param {object} opts - forwarded to `populateContentAliases` (repoId, embed, embeddingSpace, threshold, maxEntries, deadlineMs, log)
 * @returns {Promise<{entries: object[], embeddingsByTopicId: Record<string, number[]>}>}
 */
export async function enrichDebtEntriesWithAliases(entries, opts = {}) {
  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    // round-1 GPT audit M10 — a real connection failure and "no pool
    // configured" both used to fall silently into the same fail-open return,
    // making them indistinguishable in the logs. Still fail-open (this
    // feature is best-effort), but say WHY.
    process.stderr.write(`  [debt.entries] enrichDebtEntriesWithAliases: getPool() failed, skipping aliasing: ${err.message?.slice(0, 150)}\n`);
    return { entries, embeddingsByTopicId: {} };
  }
  if (!pool) return { entries, embeddingsByTopicId: {} };
  return populateContentAliases(entries, { ...opts, pool });
}

/**
 * Upsert PersistedDebtEntry rows for a repo. Idempotent on
 * `(repo_id, topic_id)`. Returns `{ok, reason?, error?, appliedCount?,
 * rejected?}` — `reason` is set ('no-op' | 'cloud-off') exactly when `ok:true`
 * reflects nothing being attempted, so a caller distinguishing "really wrote"
 * from "declined" (the durable-write seam's `debt.entries` writer,
 * `scripts/lib/audit-store-writers.mjs`) doesn't have to re-probe
 * `isCloudEnabled()` itself. `error`, when present, is the raw Error (not a
 * stringified message) so a caller that rethrows it (for connection-vs-
 * artifact classification) keeps `err.code`.
 *
 * **Schema validation (docs/plans/debt-ledger-persisted-record-contract.md
 * §2 Fix B)** — every entry is normalized (`normalizeClassificationEnvelope`)
 * and validated (`PersistedDebtEntrySchema.safeParse`) before it reaches SQL,
 * closing the gap where this write path trusted Postgres's per-column CHECK
 * constraints alone (which can't see cross-field envelope invariants Zod
 * defines, e.g. the classification-or-reason disjunction). A schema-invalid
 * entry is excluded from the batch and named in `rejected[]` — this is a
 * **permanent** defect (never `ok:false`, never thrown), distinct from a
 * genuine DB/connection failure, because retrying a schema-invalid row on a
 * later attempt accomplishes nothing.
 *
 * @param {string|null} repoId - from upsertRepo(); null skips the call
 * @param {object[]} entries - PersistedDebtEntry-shaped
 * @param {object} [opts]
 * @param {Record<string, number[]>} [opts.embeddingsByTopicId] - plain object
 *   (never a Map — this payload may be JSON-serialized by durableWrite's
 *   spill queue), one vector per topicId to persist into `debt_embeddings`
 *   as a fail-open side effect of this same call (§2 Fix C)
 * @param {{provenanceId:string, dim:number}} [opts.embeddingSpace] - required
 *   whenever `embeddingsByTopicId` is non-empty
 */
export async function upsertDebtEntries(repoId, entries, { embeddingsByTopicId = {}, embeddingSpace } = {}) {
  if (!repoId || !Array.isArray(entries) || entries.length === 0) return { ok: true, reason: 'no-op' };
  if (!await isCloudEnabled()) return { ok: true, reason: 'cloud-off' };

  const valid = [];
  const rejected = [];
  for (const raw of entries) {
    // round-1 GPT audit H2/M5 — a null/non-object element would throw inside
    // normalizeClassificationEnvelope (reads raw.classification) before ever
    // reaching safeParse, crashing the whole batch instead of rejecting the
    // one malformed item.
    if (raw === null || typeof raw !== 'object') {
      rejected.push({ topicId: undefined, reason: `entry is not an object (got ${typeof raw})` });
      continue;
    }
    const normalized = normalizeClassificationEnvelope(raw);
    const result = PersistedDebtEntrySchema.safeParse(normalized);
    if (result.success) valid.push(result.data);
    else rejected.push({ topicId: raw.topicId, reason: result.error.message.slice(0, 300) });
  }
  if (rejected.length > 0) {
    process.stderr.write(
      `  [debt.entries] ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} rejected by schema: `
      + `${rejected.map((r) => r.topicId).join(', ')}\n`,
    );
  }
  if (valid.length === 0) {
    // Nothing durable happened — the writer contract distinguishes this from
    // a partial success (see audit-store-writers.mjs's debt.entries writer).
    return { ok: true, appliedCount: 0, rejected };
  }

  const rows = valid.map((e) => ({
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
    classification_unavailable_reason: e.classificationUnavailableReason ?? null,
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
    review_deadline: e.reviewDeadline ?? null,
    superseded_by: e.supersededBy ?? null,
    updated_at: new Date().toISOString(),
  }));
  try {
    // `superseded_by` is EXCLUDED from the UPDATE SET (round-1 GPT audit H6):
    // it is independently owned by `markSupersededCloud`'s dedicated UPDATE,
    // invoked from a completely separate, operator-triggered code path
    // (`--supersedes`/`--supersedes-with`). Replaying/re-upserting an entry
    // snapshot here — e.g. a re-captured topic, or a durableWrite retry —
    // must never overwrite a supersession link that was set in between with
    // whatever `supersededBy` happened to be on the snapshot being replayed
    // (almost always null, since ordinary callers never set it).
    const updateColumns = Object.keys(rows[0]).filter((k) => k !== 'superseded_by');
    const result = await upsert('debt_entries', rows, {
      onConflict: ['repo_id', 'topic_id'], update: updateColumns,
    });
    // round-1 GPT audit H1 — a validated batch and a batch that actually
    // affected rows are different claims; ON CONFLICT DO UPDATE with no
    // WHERE clause always affects every conflicting row, so a mismatch here
    // means something the schema check could not see (a trigger, a stale
    // connection) silently dropped writes. Treat it as a genuine failure,
    // not a partial success this function has no way to attribute per-row.
    if (result.rowCount !== rows.length) {
      const error = new Error(`upsertDebtEntries: expected ${rows.length} row(s) affected, got ${result.rowCount}`);
      process.stderr.write(`  [learning] ${error.message}\n`);
      return { ok: false, error };
    }
  } catch (err) {
    process.stderr.write(`  [learning] upsertDebtEntries failed: ${err.message}\n`);
    return { ok: false, error: err };
  }

  // Embedding persistence is a fail-open side effect of THIS call, never a
  // second durable-write registration (§2 Fix C / Gemini gate round-2 G2) —
  // a lost or delayed embedding only weakens future aliasing, never the
  // entry write above, which has already succeeded by this point. Batched
  // into ONE multi-row INSERT (round-1 GPT audit M2 — a 25-entry batch
  // previously cost 25 serial round trips) rather than the generic `upsert()`
  // helper, which would bind each vector as a plain array through the
  // jsonb-safe write seam instead of the `::vector` cast this column needs.
  //
  // The WHOLE block — including preparing `embeddingEntries`, not just the
  // INSERT — is inside this try (round-4 GPT audit M2): a malformed
  // `embeddingsByTopicId` argument (e.g. not a plain object) would otherwise
  // throw from `Object.entries` OUTSIDE any error boundary and fail this
  // call even though the entry write above already committed.
  try {
    const validTopicIds = new Set(valid.map((e) => e.topicId));
    const embeddingEntries = Object.entries(embeddingsByTopicId ?? {}).filter(([topicId]) => validTopicIds.has(topicId));
    if (embeddingEntries.length > 0 && embeddingSpace) {
      const values = [];
      const params = [];
      let i = 1;
      for (const [topicId, vector] of embeddingEntries) {
        const snapshotHash = valid.find((e) => e.topicId === topicId)?.semanticHash ?? '';
        values.push(`($${i++}, $${i++}, $${i++}::vector, $${i++}, $${i++}, $${i++})`);
        params.push(repoId, topicId, toVectorLiteral(vector), embeddingSpace.provenanceId, embeddingSpace.dim, snapshotHash);
      }
      await many(
        `INSERT INTO debt_embeddings (repo_id, topic_id, embedding, embedding_model, dimension, snapshot_hash)
         VALUES ${values.join(', ')}
         ON CONFLICT (repo_id, topic_id) DO UPDATE SET
           embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model,
           dimension = EXCLUDED.dimension, snapshot_hash = EXCLUDED.snapshot_hash, created_at = now()`,
        params,
      );
    }
  } catch (err) {
    process.stderr.write(`  [debt.entries] embedding persistence failed: ${err.message?.slice(0, 150)}\n`);
  }

  return { ok: true, appliedCount: valid.length, rejected };
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
      classificationUnavailableReason: row.classification_unavailable_reason ?? undefined,
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
      reviewDeadline: row.review_deadline ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
    }));
  } catch (err) {
    process.stderr.write(`  [learning] readDebtEntriesCloud failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Delete a debt entry by `(repo_id, topic_id)`. Idempotent — no-op when
 * the row doesn't exist.
 *
 * Also deletes the matching `debt_embeddings` row (docs/plans/
 * debt-ledger-persisted-record-contract.md §2 Fix C orphan cleanup, Gemini
 * gate round-1 G2 — this cleanup belongs HERE, the cloud path, never in
 * `debt-ledger.mjs`'s local JSON manager, which has no DB access and no
 * embedding cache to clean up). Fail-open: a failed cleanup delete is logged
 * but never reverts or blocks the entry removal it accompanies.
 */
export async function removeDebtEntryCloud(repoId, topicId) {
  if (!repoId || !await isCloudEnabled()) return { ok: true };
  try {
    await deleteWhere('debt_entries', { repo_id: repoId, topic_id: topicId });
  } catch (err) {
    process.stderr.write(`  [learning] removeDebtEntryCloud failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
  try {
    await deleteWhere('debt_embeddings', { repo_id: repoId, topic_id: topicId });
  } catch (err) {
    process.stderr.write(`  [learning] removeDebtEntryCloud: debt_embeddings cleanup failed for ${topicId}: ${err.message}\n`);
  }
  return { ok: true };
}

/**
 * Link `oldTopicId` to its replacement `newTopicId` by setting the old
 * entry's `superseded_by` field. Verifies BOTH topicIds exist via a real
 * read immediately before writing (docs/plans/debt-ledger-persisted-record-contract.md
 * §2 Fix D, round-3 GPT audit H7) — never inferred from an earlier write's
 * receipt, since a schema-valid new entry may not yet be durably visible
 * here (e.g. a cloud upsert that spilled and hasn't drained).
 *
 * @param {string|null} repoId
 * @param {string} oldTopicId
 * @param {string} newTopicId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function markSupersededCloud(repoId, oldTopicId, newTopicId) {
  if (!repoId || !await isCloudEnabled()) return { ok: false, error: 'cloud-off' };
  if (oldTopicId === newTopicId) return { ok: false, error: 'self-reference' };
  try {
    const oldRow = await one('SELECT 1 FROM debt_entries WHERE repo_id = $1 AND topic_id = $2', [repoId, oldTopicId]);
    if (!oldRow) return { ok: false, error: 'old-topic-not-found' };
    const newRow = await one('SELECT 1 FROM debt_entries WHERE repo_id = $1 AND topic_id = $2', [repoId, newTopicId]);
    if (!newRow) return { ok: false, error: 'new-topic-not-found' };
    await many(
      'UPDATE debt_entries SET superseded_by = $1, updated_at = now() WHERE repo_id = $2 AND topic_id = $3',
      [newTopicId, repoId, oldTopicId],
    );
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] markSupersededCloud failed: ${err.message}\n`);
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
