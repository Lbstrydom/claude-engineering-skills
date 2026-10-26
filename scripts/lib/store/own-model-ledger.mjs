/**
 * @fileoverview Store side of the own-model decision ledger
 * (docs/plans/own-model-decision-ledger.md decisions 3, 8, 10, 12, 13).
 *
 * `recordLedgerEvents` is the ONLY writer. It re-validates the PERSISTED contract
 * (never ingress: shaping already happened in `prepareLedgerEvent`), takes the
 * purge advisory lock in SHARED mode so a concurrent `own_model_purge` waits for
 * it, refuses events older than their scope's purge barrier, and inserts
 * `ON CONFLICT DO NOTHING` so a replay or a duplicate derived observation is a
 * counted no-op rather than a second row.
 *
 * Per-event receipt states: `persisted | duplicate | refused`. Delivery states
 * that involve no store (`spooled`, `disabled`, `failed-*`) belong to the caller.
 *
 * @module scripts/lib/store/own-model-ledger
 */
import { many, query, withTx } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { parsePersisted } from '../ledger/schemas.mjs';
import { scanForSecrets } from '../secret-patterns.mjs';

/** Strings of a payload that are narrative, for the writer's second secret check. */
function narrativeText(p) {
  const out = [];
  for (const k of ['brief_text', 'brief_ref', 'rationale', 'state_summary', 'proposal_text', 'revision_text']) if (typeof p?.[k] === 'string') out.push(p[k]);
  for (const o of p?.options ?? []) for (const k of ['label', 'summary']) if (typeof o?.[k] === 'string') out.push(o[k]);
  return out.join('\n');
}

/**
 * The generation producers should stamp: the highest barrier generation, or 0.
 * @returns {Promise<number>}
 */
export async function readPurgeGeneration() {
  const rows = await many('SELECT COALESCE(MAX(generation), 0)::text AS g FROM own_model_purge_barrier');
  return Number(rows[0]?.g ?? 0);
}

/**
 * Resolve a repo by canonical name and read its eligibility flag. A lookup that
 * cannot run is `'unknown'` — never `null` — so the shaping fails closed.
 * @param {string|null} repoName
 * @returns {Promise<{id: string|null, name: string|null, flag: true|false|null|'unknown'}>}
 */
export async function lookupRepoFlag(repoName) {
  if (!repoName) return { id: null, name: null, flag: 'unknown' };
  try {
    if (!await isCloudEnabled()) return { id: null, name: repoName, flag: 'unknown' };
    const rows = await many('SELECT id, name, training_eligible FROM audit_repos WHERE name = $1', [repoName]);
    if (rows.length !== 1) return { id: null, name: repoName, flag: 'unknown' };
    return { id: rows[0].id, name: rows[0].name, flag: rows[0].training_eligible };
  } catch {
    return { id: null, name: repoName, flag: 'unknown' };
  }
}

/**
 * @param {object[]} events PERSISTED events
 * @returns {Promise<{ok: boolean, reason?: string, receipts: Array<{event_id: string, state: 'persisted'|'duplicate'|'refused', reason?: string}>, generation: number}>}
 */
export async function recordLedgerEvents(events) {
  if (!await isCloudEnabled()) return { ok: false, reason: 'cloud-off', receipts: [], generation: 0 };
  const receipts = [];
  const accepted = [];
  for (const raw of events) {
    const v = parsePersisted(raw);
    if (!v.ok) { receipts.push({ event_id: raw?.event_id ?? null, state: 'refused', reason: `persisted:${v.error}` }); continue; }
    if (scanForSecrets(narrativeText(v.event.payload)).matched) {
      receipts.push({ event_id: v.event.event_id, state: 'refused', reason: 'secret-in-content' });
      continue;
    }
    accepted.push(v.event);
  }
  let generation = 0;
  await withTx(async () => {
    // SHARED: any number of writers; an exclusive purge waits for all of them.
    await query('SELECT pg_advisory_xact_lock_shared(own_model_purge_lock_key())');
    const items = [...new Set(accepted.map((e) => e.work_item_id).filter(Boolean))];
    const repos = [...new Set(accepted.flatMap((e) => [e.repo_name, e.repo_id]).filter(Boolean))];
    const barriers = await many(
      `SELECT scope_kind, scope_value, generation::text AS g FROM own_model_purge_barrier
        WHERE (scope_kind = 'work_item' AND scope_value = ANY($1::text[]))
           OR (scope_kind = 'repo' AND scope_value = ANY($2::text[]))`, [items, repos]);
    const byItem = new Map(barriers.filter((b) => b.scope_kind === 'work_item').map((b) => [b.scope_value, Number(b.g)]));
    const byRepo = new Map(barriers.filter((b) => b.scope_kind === 'repo').map((b) => [b.scope_value, Number(b.g)]));
    generation = await readPurgeGeneration();
    for (const e of accepted) {
      const barrier = Math.max(byItem.get(e.work_item_id) ?? 0, byRepo.get(e.repo_name) ?? 0, byRepo.get(e.repo_id) ?? 0);
      if (e.purge_generation < barrier) {
        receipts.push({ event_id: e.event_id, state: 'refused', reason: 'purged-scope' });
        continue;
      }
      const res = await query(
        `INSERT INTO own_model_ledger
           (event_id, kind, work_item_id, decision_id, parent_decision_id, parent_event_id, repo_id, repo_name,
            coordinator, actor, event_at, purge_generation, schema_version, redaction_version, tool_sha,
            policy_version, session_ref, content_state, training_eligible, eligibility_basis, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT DO NOTHING`,
        [e.event_id, e.kind, e.work_item_id ?? null, e.decision_id ?? null, e.parent_decision_id ?? null,
          e.parent_event_id ?? null, e.repo_id ?? null, e.repo_name ?? null, e.coordinator, e.actor, e.event_at,
          e.purge_generation, e.schema_version, e.redaction_version, e.tool_sha ?? null, e.policy_version ?? null,
          e.session_ref ?? null, e.content_state, e.training_eligible, e.eligibility_basis ?? null, JSON.stringify(e.payload)]);
      receipts.push({ event_id: e.event_id, state: res.rowCount === 1 ? 'persisted' : 'duplicate' });
    }
  });
  return { ok: true, receipts, generation };
}

/**
 * Purge by work item and/or repo through the one supported function.
 * @param {{workItem?: string|null, repo?: string|null}} scope
 * @returns {Promise<{deleted: number, generation: number}>}
 */
export async function purgeLedger({ workItem = null, repo = null }) {
  const rows = await many('SELECT deleted::text AS d, generation::text AS g FROM own_model_purge($1, $2)', [workItem, repo]);
  return { deleted: Number(rows[0].d), generation: Number(rows[0].g) };
}

/** Per-work-item cost rollup (view `own_model_task_cost`). */
export async function readTaskCost({ limit = 50 } = {}) {
  return many('SELECT * FROM own_model_task_cost ORDER BY total_cost_usd DESC NULLS LAST LIMIT $1', [limit]);
}

/** Counts for `ledger status`; an empty ledger is reported as such, never as a measurement of zero health. */
export async function readLedgerCounts() {
  return many(`SELECT kind, content_state, count(*)::int AS n, count(*) FILTER (WHERE work_item_id IS NULL)::int AS uncorrelated
                 FROM own_model_ledger GROUP BY 1, 2 ORDER BY 1, 2`);
}

/**
 * Merged outcomes older than `olderThanDays` with no terminal observation whose
 * parent_event_id is theirs (plan decision 13), a bounded page after the cursor.
 * @param {{olderThanDays?: number, limit?: number, after?: {eventAt: string, eventId: string}|null}} o
 */
export async function listMergedAwaitingObservation({ olderThanDays = 7, limit = 200, after = null, repoName = null } = {}) {
  return many(
    `SELECT m.event_id, m.event_at, m.repo_name, m.work_item_id, m.coordinator, m.purge_generation::text AS purge_generation, m.payload
       FROM own_model_ledger m
      WHERE m.kind = 'outcome' AND m.payload->>'kind' = 'merged'
        AND m.event_at < now() - ($1::int * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM own_model_ledger c WHERE c.parent_event_id = m.event_id AND c.kind = 'outcome'
                          AND c.payload->>'kind' IN ('reverted', 'observed-clean'))
        AND ($3::timestamptz IS NULL OR (m.event_at, m.event_id) > ($3::timestamptz, $4::uuid))
        AND ($5::text IS NULL OR m.repo_name = $5)
      ORDER BY m.event_at, m.event_id
      LIMIT $2`,
    [olderThanDays, limit, after?.eventAt ?? null, after?.eventId ?? null, repoName]);
}
