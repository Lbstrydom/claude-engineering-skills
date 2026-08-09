/**
 * @fileoverview PURE candidate-pagination and batch-resolution logic —
 * cursor codec, keyset query construction, page-result derivation, batch
 * bounds and state projection.
 *
 * Split out of `plans-ship.mjs` deliberately. The `learning-store.mjs`
 * barrel `export *`s that module, and the barrel's pinned public surface is
 * store OPERATIONS (functions), with constants explicitly excluded — see
 * tests/learning-store-exports.test.mjs. These helpers are implementation
 * detail that must nonetheless be directly testable, because a caller-level
 * fake cannot catch a bad SQL predicate: a wrong comparison still returns
 * rows. Living here keeps them assertable without widening a curated API.
 *
 * The barrel does NOT re-export this module. Import it directly.
 *
 * Plan: docs/plans/learning-persona-quickfix-honest-failure.md §2 item 7.
 *
 * @module scripts/lib/store/candidate-pagination
 */
import { createHash } from 'node:crypto';

// ── consistency candidates: two questions, two queries ─────────────────────
//
// docs/plans/learning-persona-quickfix-honest-failure.md §2 item 7. The two
// callers are asking genuinely different things, and serving both from one
// list was the original design error:
//
//   promoteCandidates          "what is pending, for a human to approve?"
//                              -> paginated enumeration; an approximate,
//                                 point-in-time view is fine.
//   reconcilePromotionJournal  "for these N specific fingerprints, what is
//                              each one's state?"
//                              -> targeted batch resolution, bounded by N.
//
// Pagination cannot serve the second: a SEQUENCE OF PAGES IS NOT A SNAPSHOT.
// Rows can be created, promoted, or leave candidate status between page 1 and
// page N, so `complete:true` would still be a false statement about the state
// reconcile makes an irreversible rename-and-journal-delete decision on. That
// trades a truncation bug for a concurrency-dependent completeness bug.

/** Rows per page. Named; unchanged from the previous effective limit. */
export const CANDIDATE_PAGE_SIZE = 100;
/** Bounds a pathological loop => 5 000 candidates. Hitting it is `incomplete`, never a silent stop. */
export const CANDIDATE_MAX_PAGES = 50;
/** Fingerprints per resolver REQUEST — bounds payload and query cost. */
export const RECONCILE_BATCH_SIZE = 200;
/** Max resolver requests per RUN => <=1 000 journals. Hitting it is `incomplete:true`. */
export const RECONCILE_MAX_BATCHES_PER_RUN = 5;

const CURSOR_VERSION = 1;
const CURSOR_MAX_BYTES = 512;

/**
 * A cursor is only meaningful against the filter set that produced it, so it
 * carries a digest of those filters and `--resume` rejects a mismatch rather
 * than resuming into a different result set and reporting success.
 */
export function cursorFilterDigest({ repoId, sinceTs }) {
  return createHash('sha256')
    .update(JSON.stringify({ repoId: repoId ?? null, sinceTs: sinceTs ?? null }))
    .digest('hex')
    .slice(0, 16);
}

export function encodeCandidateCursor({ ts, id, digest }) {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ts, id, digest }), 'utf-8')
    .toString('base64url');
}

/**
 * Decode + validate. Malformed / wrong-version / oversize returns a typed
 * failure, never a raw DB error and never a silent reset to page 1 (which
 * would re-enumerate rows the caller already processed).
 */
export function decodeCandidateCursor(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'invalid-cursor' };
  }
  if (Buffer.byteLength(raw, 'utf-8') > CURSOR_MAX_BYTES) {
    return { ok: false, error: 'invalid-cursor' };
  }
  let obj;
  try { obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')); }
  catch { return { ok: false, error: 'invalid-cursor' }; }
  if (!obj || typeof obj !== 'object' || obj.v !== CURSOR_VERSION) {
    return { ok: false, error: 'invalid-cursor' };
  }
  if (typeof obj.ts !== 'string' || typeof obj.id !== 'string' || typeof obj.digest !== 'string') {
    return { ok: false, error: 'invalid-cursor' };
  }
  return { ok: true, cursor: { ts: obj.ts, id: obj.id, digest: obj.digest } };
}

// `ts` is produced by SQL, never by JS, in exactly ONE form. `created_at::text`
// is NOT an accepted alternative: it renders per the session's TimeZone /
// DateStyle, so "portable and opaque" would be untrue of it. And never derive
// `ts` from a JS Date — `pg` materialises timestamptz as a ms-precision Date
// while Postgres stores microseconds, so toISOString() rounds DOWN, producing
// a predicate EARLIER than the last row returned, which repeats rows or trips
// the non-advancing check.
const CURSOR_TS_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CANDIDATE_COLUMNS = `id, candidate_fingerprint, witness_snapshot, contradiction_payload,
                journey_context, redaction_count, description, commit_sha, created_at,
                ${CURSOR_TS_SQL} AS cursor_ts`;

/**
 * One page of consistency candidates, keyset-paginated.
 *
 * Keyset, NOT `OFFSET`: `ORDER BY created_at DESC` + OFFSET is unstable under
 * concurrent inserts and would re-introduce the silent-loss class this fixes.
 *
 * Returns a typed result. The previous `catch -> []` made a dependency failure
 * indistinguishable from "genuinely no candidates" — finding **C**, and the
 * same conflation that made finding **B** destructive.
 *
 * @returns {Promise<{ok:true, candidates:Array, nextCursor:string|null} | {ok:false, error:string}>}
 */
/**
 * Build the page query. PURE — separated so the SQL predicate and its
 * parameter BINDING can be asserted without a database. A caller-level fake
 * cannot catch a bad predicate (a wrong comparison still returns rows), which
 * is exactly the class this pagination exists to prevent, so the query text
 * itself has to be the thing under test.
 *
 * @returns {{ok:true, sql:string, params:Array, limit:number, digest:string} | {ok:false, error:string}}
 */
export function buildCandidatePageQuery({ repoId, sinceTs = null, cursor: rawCursor = null, limit: rawLimit } = {}) {
  if (!repoId) return { ok: false, error: 'repo-id-required' };
  // Bounded by the page size, not merely "positive". An unbounded limit
  // defeats the whole bounded-work design this pagination exists to provide —
  // one caller asking for 10_000_000 rows reproduces the unbounded read that
  // CANDIDATE_MAX_PAGES is there to prevent. The ceiling is DERIVED from the
  // documented page size rather than invented.
  const requested = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : CANDIDATE_PAGE_SIZE;
  const limit = Math.min(requested, CANDIDATE_PAGE_SIZE);
  const digest = cursorFilterDigest({ repoId, sinceTs });

  // PRESENT-but-empty is not the same fact as ABSENT. `if (rawCursor)` treated
  // `''` as "no cursor supplied" and silently returned page 1 — a resume that
  // restarts from the beginning while reporting success, which is the same
  // class of lie this plan exists to remove. Only `null`/`undefined` mean
  // "first page"; anything else must decode or be refused.
  let cursor = null;
  if (rawCursor !== null && rawCursor !== undefined) {
    const decoded = decodeCandidateCursor(rawCursor);
    if (!decoded.ok) return { ok: false, error: decoded.error };
    // A cursor is only meaningful against the filter set that produced it.
    // Resuming into a DIFFERENT result set and reporting success is the
    // failure this rejects.
    if (decoded.cursor.digest !== digest) return { ok: false, error: 'cursor-filter-mismatch' };
    cursor = decoded.cursor;
  }

  const where = ['repo_id = $1', `source_kind = 'persona-consistency-candidate'`];
  const params = [repoId];
  if (sinceTs) { params.push(sinceTs); where.push(`created_at >= $${params.length}`); }
  if (cursor) {
    // Row-comparison keyset predicate. `id` breaks ties — without it, rows
    // sharing a created_at can duplicate or skip across a page boundary.
    // Bound as parameters, never interpolated.
    params.push(cursor.ts, cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit);

  return {
    ok: true,
    digest,
    limit,
    params,
    sql: `SELECT ${CANDIDATE_COLUMNS}
         FROM regression_specs
        WHERE ${where.join('\n          AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
  };
}

/**
 * Turn a page of rows into the caller's result. PURE, for the same reason as
 * the query builder: next-cursor derivation and the non-advancing check are
 * where a keyset loop silently spins or skips.
 *
 * @returns {{ok:true, candidates:Array, nextCursor:string|null} | {ok:false, error:string}}
 */
export function derivePageResult(rows, built, priorCursor = null) {
  const last = rows.length === built.limit ? rows[rows.length - 1] : null;
  if (last && priorCursor && last.cursor_ts === priorCursor.ts && String(last.id) === priorCursor.id) {
    // A full page whose last row equals the cursor it was fetched with cannot
    // advance — looping on it would spin forever. Typed failure, not a re-loop.
    return { ok: false, error: 'non-advancing-cursor' };
  }
  return {
    ok: true,
    candidates: rows,
    nextCursor: last
      ? encodeCandidateCursor({ ts: last.cursor_ts, id: String(last.id), digest: built.digest })
      : null,
  };
}

/** The closed union a fingerprint can resolve to. Anything else is a typed failure. */
export const CANDIDATE_STATE_VALUES = Object.freeze(['promoted', 'candidate', 'absent', 'unknown']);

/**
 * Resolve the CURRENT state of specific fingerprints in one query.
 *
 * This is what `reconcilePromotionJournal` asks instead of "give me every
 * candidate and I'll check membership" — a bounded question with a bounded,
 * consistent answer, needing no completeness claim at all.
 *
 * Independently defensive about its input size: an array bound to `= ANY($2)`
 * is ONE bind parameter, so the parameter limit places NO bound on how many
 * fingerprints it carries. A corrupted or long-accumulated journal directory
 * would otherwise reach an unbounded allocation, request payload and result
 * map inside the recovery path — the one path that most needs to stay robust.
 * It REFUSES rather than chunking internally, so a future second caller
 * cannot silently reintroduce the gap.
 *
 * @returns {Promise<{ok:true, states:Record<string,string>} | {ok:false, error:string}>}
 */
/**
 * Deduplicate, shape-validate and BOUND a fingerprint batch. PURE.
 *
 * Independently defensive rather than trusting its caller: an array bound to
 * `= ANY($2)` is ONE bind parameter, so the driver's parameter limit places no
 * bound at all on how many fingerprints it carries. It REFUSES an oversized
 * batch rather than chunking internally, so a future second caller cannot
 * silently reintroduce the unbounded allocation inside the recovery path.
 *
 * @returns {{ok:true, clean:string[]} | {ok:false, error:string}}
 */
export function validateFingerprintBatch(fingerprints) {
  if (!Array.isArray(fingerprints)) return { ok: false, error: 'fingerprints-must-be-array' };
  const clean = [...new Set(
    fingerprints.filter(f => typeof f === 'string' && f.length > 0 && f.length <= 200),
  )];
  if (clean.length > RECONCILE_BATCH_SIZE) {
    return { ok: false, error: `too-many-fingerprints: ${clean.length} > ${RECONCILE_BATCH_SIZE}` };
  }
  return { ok: true, clean };
}


/**
 * Project queried rows onto the closed state union. PURE.
 *
 * `absent` is the DEFAULT and is deliberately NOT actionable downstream: it
 * means "no row at all — deleted, wrong repo, or never written", which is
 * precisely what a beyond-page-100 candidate looked like in finding B. The
 * container is null-prototype so a fingerprint spelled `__proto__` becomes
 * data rather than reassigning the map's prototype.
 */
export function mapFingerprintRowsToStates(clean, rows) {
  const states = Object.create(null);
  for (const f of clean) states[f] = 'absent';
  for (const r of rows) {
    const fp = r.candidate_fingerprint;
    if (!Object.hasOwn(states, fp)) continue;
    if (r.source_kind === 'persona-consistency-locked') states[fp] = 'promoted';
    else if (r.source_kind === 'persona-consistency-candidate') states[fp] = 'candidate';
    else states[fp] = 'unknown';
  }
  return states;
}
