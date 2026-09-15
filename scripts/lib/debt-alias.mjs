/**
 * @fileoverview docs/plans/debt-ledger-persisted-record-contract.md §2 Fix C —
 * best-effort, fail-open content-aliasing for debt-ledger entries, reusing
 * the same cosine-over-`VECTOR(768)` machinery already promoted for
 * `audit_findings` dedup (`semantic-suppression.mjs`) rather than growing a
 * second similarity mechanism.
 *
 * FORWARD-ONLY, NEVER A BACKFILL. This module only ever runs at capture time
 * for entries being written right now; the 181/222 historical entries with
 * empty `contentAliases` are untouched (per the parent document's explicit
 * "Not attempted here").
 *
 * SAFETY IS THE CONTRACT, same as `partitionRecordTimeReRaises`: any failure
 * — no pool, no embedding provider, a query error, the batch budget running
 * out — leaves the affected entry (or the untouched remainder of the batch)
 * exactly as it would be with `contentAliases: []`, never blocks the persist
 * this augments.
 *
 * @module scripts/lib/debt-alias
 */

import crypto from 'node:crypto';
import { redactSecrets } from './secret-patterns.mjs';
import { toVectorLiteral, parseVectorLiteral, assertEmbeddingSpace } from './semantic-suppression.mjs';
import { cosineSimilarity } from './arch-memory/background-calibration.mjs';

const MIN_TEXT_LENGTH = 30;
const DEFAULT_MAX_ENTRIES = 25;
const DEFAULT_DEADLINE_MS = 5000;
const MAX_ALIASES = 20;
// PersistedDebtEntrySchema's contentAliases is z.array(z.string().max(12)) —
// an alias longer than this would make the ALIASED entry (not just this one)
// fail schema validation at its next write (round-1 GPT audit H3).
const MAX_ALIAS_LENGTH = 12;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function dedupeCapped(aliases) {
  return Array.from(new Set(aliases)).slice(0, MAX_ALIASES);
}

/**
 * Embed text for a debt entry: `category + section + detailSnapshot`,
 * redacted defensively (docs/plans/debt-ledger-persisted-record-contract.md
 * §2 Fix C, Gemini gate round-1 H2) so this module's guarantee never depends
 * on which constructor built the entry — `buildDebtEntry` already redacts,
 * but `debt-backfill.mjs --promote`'s records (via `backfill-parser.mjs`)
 * never do.
 */
function buildEmbedText(entry) {
  const raw = [entry.category, entry.section, entry.detailSnapshot].filter(Boolean).join(' ');
  return redactSecrets(raw).text;
}

/**
 * Find the nearest OPEN debt topic (same repo, same vector space) above
 * `threshold`, excluding the candidate's own topicId. Mirrors
 * `nearestOpenReRaise`'s query shape, extended with a `debt_entries` EXISTS
 * check (round-1 GPT audit H4/H7 — "nearest OPEN debt topic" is a claim
 * about `debt_entries`, the authoritative table; `debt_embeddings` alone
 * cannot tell a live topic from a stale vector left behind by a resolution
 * path that didn't also clean up its embedding row).
 *
 * @param {import('pg').Pool|import('pg').PoolClient} pool
 * @param {{repoId:string, embedding:number[], embeddingSpace:{provenanceId:string,dim:number}, threshold:number, excludeTopicId?:string}} args
 * @returns {Promise<{topicId:string, cosine:number}|null>}
 */
export async function findNearDuplicateDebtTopic(pool, { repoId, embedding, embeddingSpace, threshold, excludeTopicId } = {}) {
  assertEmbeddingSpace(embeddingSpace, 'findNearDuplicateDebtTopic');
  if (!repoId || !Array.isArray(embedding) || embedding.length === 0) return null;
  const lit = toVectorLiteral(embedding);
  const { rows } = await pool.query(
    `SELECT e.topic_id, (1 - (e.embedding <=> $1::vector)) AS cosine
       FROM debt_embeddings e
       JOIN debt_entries d ON d.repo_id = e.repo_id AND d.topic_id = e.topic_id
      WHERE e.repo_id = $2
        AND e.embedding IS NOT NULL
        AND e.embedding_model = $3::text
        AND e.dimension = $4::int
        AND ($5::text IS NULL OR e.topic_id <> $5::text)
        -- round-3 GPT audit M2: a superseded topic still has a live
        -- debt_entries row (supersession sets a field, it doesn't delete),
        -- but it is no longer the canonical "open" topic — a new alias
        -- should never point at one that has itself been retired.
        AND d.superseded_by IS NULL
      ORDER BY e.embedding <=> $1::vector
      LIMIT 1`,
    [lit, repoId, embeddingSpace.provenanceId, embeddingSpace.dim, excludeTopicId ?? null],
  );
  const r = rows[0];
  if (!r || Number(r.cosine) < threshold) return null;
  return { topicId: r.topic_id, cosine: Number(r.cosine) };
}

/**
 * Best-effort content-aliasing for a batch of debt entries about to be
 * persisted. See module docstring for the fail-open contract.
 *
 * @param {object[]} entries - PersistedDebtEntry-shaped, about to be written
 * @param {object} opts
 * @param {string} opts.repoId
 * @param {import('pg').Pool} opts.pool
 * @param {(text:string)=>Promise<number[]>} opts.embed
 * @param {{provenanceId:string, dim:number}} opts.embeddingSpace
 * @param {number} [opts.threshold=0.92] - reuse semanticSuppressConfig's bar; an alias is a stronger claim than a re-raise
 * @param {number} [opts.maxEntries=25] - per-batch enrichment cap
 * @param {number} [opts.deadlineMs=5000] - wall-clock budget for the whole batch
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{entries:object[], embeddingsByTopicId: Record<string, number[]>}>}
 */
export async function populateContentAliases(entries, {
  repoId, pool, embed, embeddingSpace, threshold = 0.92,
  maxEntries = DEFAULT_MAX_ENTRIES, deadlineMs = DEFAULT_DEADLINE_MS, log = () => {},
} = {}) {
  const embeddingsByTopicId = {};
  if (!repoId || !pool || !embed || !Array.isArray(entries) || entries.length === 0) {
    return { entries, embeddingsByTopicId };
  }
  assertEmbeddingSpace(embeddingSpace, 'populateContentAliases');

  const byTopicId = new Map(entries.map(e => [e.topicId, e]));
  const deadline = Date.now() + deadlineMs;
  let processed = 0;

  // Round-5 GPT audit H1: the in-batch eligibility check below can only see
  // what THIS capture batch's own DTOs declare. A RE-CAPTURED topic that was
  // superseded by a prior write carries no `supersededBy` in its new DTO at
  // all — that state lives only in the `debt_entries` row, and
  // `upsertDebtEntries` deliberately excludes `superseded_by` from its
  // update columns so a re-upsert never clobbers it. Without this, the
  // in-batch guard (unlike `findNearDuplicateDebtTopic`'s own
  // `superseded_by IS NULL` filter) would judge eligibility against a value
  // persistence will not retain. Query persisted state ONCE per batch —
  // never per-candidate, the batch can be large — so both eligibility
  // checks share one definition of "superseded".
  //
  // Round-6 GPT audit H1/H2 (bugs in the round-5 fix above): (1) the query
  // sat outside any timeout, so a hung preflight could block the whole
  // batch past its wall-clock budget before a single per-entry check ever
  // ran; (2) its failure path degraded straight to "assume nothing is
  // superseded" — unlike every OTHER failure path in this module, which
  // fails toward NO alias, that one fails toward a WRONG alias, exactly the
  // invariant round-5 exists to protect. Fixed by racing the query against
  // the batch's own remaining budget and, on EITHER a timeout or a query
  // error, disabling in-batch matching entirely for this batch —
  // `inBatchMatchingSafe` below — rather than only the new exclusion. The DB
  // fallback path (`findNearDuplicateDebtTopic`) stays fully available and
  // is unconditionally safe on its own `superseded_by IS NULL` filter, so
  // this narrows what is skipped to exactly the unsafe optimization, never
  // the whole batch.
  const batchTopicIds = entries.map((e) => e?.topicId).filter(Boolean);
  let persistedSupersededTopicIds = new Set();
  let inBatchMatchingSafe = entries.length > 1 && batchTopicIds.length > 0;
  if (inBatchMatchingSafe) {
    let timer;
    try {
      const remaining = Math.max(deadline - Date.now(), 0);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('persisted-supersession preflight budget exceeded')), remaining);
      });
      const { rows } = await Promise.race([
        pool.query(
          `SELECT topic_id FROM debt_entries
            WHERE repo_id = $1 AND topic_id = ANY($2::text[]) AND superseded_by IS NOT NULL`,
          [repoId, batchTopicIds],
        ),
        timeout,
      ]);
      persistedSupersededTopicIds = new Set(rows.map((r) => r.topic_id));
    } catch {
      // Fail CLOSED for in-batch matching specifically (never for the whole
      // batch): every entry still gets a DB-fallback chance, which cannot
      // return a superseded topic regardless of this preflight's outcome.
      inBatchMatchingSafe = false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The actual per-entry work — READS `embeddingsByTopicId` (safe: only the
   * loop below ever writes to it) but never mutates shared state directly.
   * Returns `{ matchTopicId, vector } | null` for the loop to apply.
   *
   * This separation (round-2 GPT audit H1/M1) is what makes the per-entry
   * timeout below safe: a `processEntry` call that loses the race keeps
   * running to completion (JS has no true cancellation), but since it only
   * ever returns a value — never writes `byTopicId`/`embeddingsByTopicId`
   * itself — a late resolution after `Promise.race` has already moved on is
   * simply an unused return value, never a mutation racing the next entry's
   * own read of the same maps.
   */
  async function processEntry(entry) {
    // Gemini gate G2 (round after round-6): every prior fix here excluded a
    // SUPERSEDED CANDIDATE from being matched TO, but nothing ever excluded a
    // superseded entry from being the SOURCE of a match — so a superseded
    // entry processed AFTER a live batch-mate would still find that live
    // entry as `otherTopicId` (which is not itself superseded, so none of
    // the candidate-side guards fire) and the RECIPROCAL update in
    // `applyOutcome` would pollute the live topic's own `contentAliases`
    // with a link to the dead one. A superseded entry (DTO-declared or
    // DB-persisted) must never enter the aliasing graph at all — as a
    // source OR a target — so it is excluded here, before any embedding
    // work, which also makes the old per-candidate exclusion checks below
    // provably unreachable (removed, not just redundant: nothing that ever
    // reaches `embeddingsByTopicId` can be superseded any more).
    if (entry.supersededBy || persistedSupersededTopicIds.has(entry.topicId)) return null;

    const text = buildEmbedText(entry);
    if (text.length < MIN_TEXT_LENGTH) return null;
    const hash = sha256(text);

    // Reuse a cached embedding only when BOTH the text and the vector
    // space match (round-2 GPT audit H4) — a snapshot_hash match against a
    // retired embedding_model/dimension is treated as a miss.
    let vector = null;
    const cached = await pool.query(
      `SELECT embedding, embedding_model, dimension FROM debt_embeddings
        WHERE repo_id = $1 AND topic_id = $2 AND snapshot_hash = $3`,
      [repoId, entry.topicId, hash],
    );
    const cachedRow = cached.rows[0];
    if (cachedRow && cachedRow.embedding_model === embeddingSpace.provenanceId
      && Number(cachedRow.dimension) === embeddingSpace.dim && cachedRow.embedding) {
      // Gemini gate G1: `pg` has no built-in type parser for the custom
      // `vector` extension type, so a real Postgres returns this column as
      // a text literal ("[0.1,0.2,...]"), not a number[] — a mocked pool
      // (every prior unit test here) can't catch this, it just hands back
      // whatever array it was given. Left unparsed, every downstream
      // `cosineSimilarity(vector, otherVec)` call silently breaks on a real
      // cache hit. `parseVectorLiteral` is the same fix already shipped for
      // this exact class in `store/security.mjs`.
      vector = parseVectorLiteral(cachedRow.embedding);
    } else {
      vector = await embed(text);
    }

    // 1. In-batch check first (Gemini gate round-1 G4) — same-batch
    //    entries aren't queryable in debt_embeddings until after upsert.
    //    Every candidate reached here is guaranteed non-superseded (the
    //    guard at the top of this function is the only place that needs to
    //    check `supersededBy`/`persistedSupersededTopicIds` any more).
    let matchTopicId = null;
    let bestCosine = 0;
    // Round-6 GPT audit H2: skip in-batch matching ENTIRELY when the
    // persisted-supersession preflight above didn't complete — never match
    // against `persistedSupersededTopicIds` as if it were a confirmed-empty
    // result when it is actually an unknown one.
    if (inBatchMatchingSafe) {
      for (const [otherTopicId, otherVec] of Object.entries(embeddingsByTopicId)) {
        if (otherTopicId === entry.topicId) continue;
        const cos = cosineSimilarity(vector, otherVec) ?? 0;
        if (cos >= threshold && cos > bestCosine) { matchTopicId = otherTopicId; bestCosine = cos; }
      }
    }

    // 2. Previously-committed DB entries, only if no in-batch match.
    if (!matchTopicId) {
      const dbMatch = await findNearDuplicateDebtTopic(pool, {
        repoId, embedding: vector, embeddingSpace, threshold, excludeTopicId: entry.topicId,
      });
      if (dbMatch) matchTopicId = dbMatch.topicId;
    }

    return { matchTopicId, vector };
  }

  /**
   * Apply a resolved `processEntry` outcome to the shared maps. The ONLY
   * place either map is mutated — called just once per entry, only when
   * `processEntry` actually won its race (round-2 GPT audit H1/M1).
   *
   * Both alias directions are length-checked (round-2 GPT audit H2/H3 — the
   * original fix validated only `matchTopicId`, the forward direction; the
   * reciprocal in-batch update appends `entry.topicId` to the OTHER entry's
   * `contentAliases`, and `topicId` itself carries no schema-level max
   * length, so that direction needs the identical guard).
   */
  function applyOutcome(entry, outcome) {
    if (!outcome) return;
    let { matchTopicId, vector } = outcome;

    if (matchTopicId && matchTopicId.length > MAX_ALIAS_LENGTH) {
      log(`  [debt-alias] skipping alias to ${matchTopicId} — exceeds the ${MAX_ALIAS_LENGTH}-char contentAliases contract`);
      matchTopicId = null;
    }

    if (matchTopicId) {
      const current = byTopicId.get(entry.topicId);
      byTopicId.set(entry.topicId, {
        ...current,
        contentAliases: dedupeCapped([...(current.contentAliases || []), matchTopicId]),
      });
      // An in-batch match makes BOTH entries alias each other — neither is
      // more "canonical" than the other at this point. `entry.topicId` gets
      // the SAME length check before being written into the OTHER entry's
      // contentAliases.
      if (entry.topicId.length > MAX_ALIAS_LENGTH) {
        log(`  [debt-alias] skipping reciprocal alias to ${entry.topicId} — exceeds the ${MAX_ALIAS_LENGTH}-char contentAliases contract`);
      } else {
        const other = byTopicId.get(matchTopicId);
        if (other) {
          byTopicId.set(matchTopicId, {
            ...other,
            contentAliases: dedupeCapped([...(other.contentAliases || []), entry.topicId]),
          });
        }
      }
    }

    if (vector) embeddingsByTopicId[entry.topicId] = vector;
  }

  for (const entry of entries) {
    if (processed >= maxEntries) {
      log(`  [debt-alias] batch cap (${maxEntries}) reached — remaining entries left unaliased`);
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      log(`  [debt-alias] time budget (${deadlineMs}ms) exhausted — remaining entries left unaliased`);
      break;
    }
    processed++;

    // Race the entry's actual work against the REMAINING budget (round-1 GPT
    // audit H5 — a between-iteration-only check does not bound a single slow
    // embed()/query call, which could otherwise consume the whole batch's
    // time alone). A timeout is a per-entry failure like any other — caught
    // below, fail-open, next entry still gets whatever budget is left. The
    // losing side of the race (if `processEntry` itself resolves late) is
    // discarded here — never applied — by `applyOutcome` only running on the
    // value `Promise.race` actually returned.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`per-entry budget (${remaining}ms) exceeded`)), remaining);
    });
    try {
      const outcome = await Promise.race([processEntry(entry), timeout]);
      applyOutcome(entry, outcome);
    } catch (err) {
      log(`  [debt-alias] keep-on-error for ${entry.topicId}: ${err?.message?.slice(0, 120)}`);
      // fail-open — this entry's contentAliases stays whatever it already was
    } finally {
      clearTimeout(timer);
    }
  }

  return { entries: entries.map(e => byTopicId.get(e.topicId) ?? e), embeddingsByTopicId };
}

// Test-only accessors (mirrors the `anthropic-client.mjs`/`file-io.mjs` project
// pattern) — `tests/debt-alias-integration.test.mjs` needs the EXACT
// snapshot_hash `processEntry` will look up in order to seed a real cache-hit
// row and prove the pgvector-text-literal deserialization fix (Gemini gate
// G1) against a live Postgres, not just a mocked pool.
export const _internals = { buildEmbedText, sha256 };
