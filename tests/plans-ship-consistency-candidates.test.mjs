/**
 * @fileoverview PURE store tests for consistency-candidate enumeration and
 * targeted state resolution — docs/plans/learning-persona-quickfix-honest-failure.md
 * §7 (item 7).
 *
 * No DSN, no live DB, deliberately (INC-002 — the destructive-DSN incident;
 * plan §4 says item 7 must be covered by SQL-SHAPE tests only).
 *
 * These assert the query TEXT and its parameter BINDING, not just behaviour
 * through a fake. That distinction is the whole reason this file exists: a
 * caller-level fake cannot catch a bad SQL predicate, because a wrong
 * comparison still returns rows. The predicate is the thing that was broken.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCandidatePageQuery,
  derivePageResult,
  encodeCandidateCursor,
  decodeCandidateCursor,
  cursorFilterDigest,
  validateFingerprintBatch,
  mapFingerprintRowsToStates,
  CANDIDATE_PAGE_SIZE,
  RECONCILE_BATCH_SIZE,
} from '../scripts/lib/store/candidate-pagination.mjs';

const REPO = '11111111-1111-1111-1111-111111111111';

describe('listConsistencyCandidates — first page vs continuation SQL', () => {
  it('the first page has NO continuation predicate', () => {
    const q = buildCandidatePageQuery({ repoId: REPO });
    assert.equal(q.ok, true);
    assert.ok(!/created_at, id\) </.test(q.sql), 'no cursor -> no keyset predicate');
    assert.deepEqual(q.params, [REPO, CANDIDATE_PAGE_SIZE]);
  });

  it('a continuation page adds a row-comparison keyset predicate with BOUND params', () => {
    const digest = cursorFilterDigest({ repoId: REPO, sinceTs: null });
    const cursor = encodeCandidateCursor({
      ts: '2026-08-01T10:00:00.123456Z', id: 'abcd-1234', digest,
    });
    const q = buildCandidatePageQuery({ repoId: REPO, cursor });

    assert.equal(q.ok, true);
    assert.match(
      q.sql, /\(created_at, id\) < \(\$2::timestamptz, \$3::uuid\)/,
      'must be a row comparison, and both sides must be BOUND, never interpolated',
    );
    assert.deepEqual(q.params, [REPO, '2026-08-01T10:00:00.123456Z', 'abcd-1234', CANDIDATE_PAGE_SIZE]);
    // Vacuous-pass guard: the cursor values must not appear as literals.
    assert.ok(
      !q.sql.includes('2026-08-01T10:00:00.123456Z') && !q.sql.includes('abcd-1234'),
      'interpolating the cursor into SQL would be an injection surface',
    );
  });

  // An unbounded limit defeats the bounded-work design: one caller asking for
  // 10_000_000 rows reproduces exactly the unbounded read CANDIDATE_MAX_PAGES
  // exists to prevent.
  it('clamps an oversized limit to the page size rather than honouring it', () => {
    const q = buildCandidatePageQuery({ repoId: REPO, limit: 10_000_000 });
    assert.equal(q.ok, true);
    assert.equal(q.limit, CANDIDATE_PAGE_SIZE);
    assert.deepEqual(q.params, [REPO, CANDIDATE_PAGE_SIZE]);
  });

  it('honours a smaller explicit limit (vacuous-pass guard — the clamp is a ceiling, not a constant)', () => {
    const q = buildCandidatePageQuery({ repoId: REPO, limit: 7 });
    assert.equal(q.limit, 7);
  });

  it('orders by created_at AND id so equal timestamps cannot duplicate or skip', () => {
    const q = buildCandidatePageQuery({ repoId: REPO });
    assert.match(
      q.sql, /ORDER BY created_at DESC, id DESC/,
      'without the id tiebreak, rows sharing a created_at can repeat or vanish across a page boundary',
    );
  });

  it('sinceTs is bound as a parameter and shifts the cursor placeholders', () => {
    const digest = cursorFilterDigest({ repoId: REPO, sinceTs: '2026-01-01T00:00:00Z' });
    const cursor = encodeCandidateCursor({ ts: 'T', id: 'I', digest });
    const q = buildCandidatePageQuery({ repoId: REPO, sinceTs: '2026-01-01T00:00:00Z', cursor });
    assert.deepEqual(q.params, [REPO, '2026-01-01T00:00:00Z', 'T', 'I', CANDIDATE_PAGE_SIZE]);
    assert.match(q.sql, /\(created_at, id\) < \(\$3::timestamptz, \$4::uuid\)/);
  });

  // R2-M5 / R3-M1: `ts` is produced by SQL, never by JS. `pg` materialises
  // timestamptz as a ms-precision Date while Postgres stores microseconds, so
  // deriving the cursor from a JS Date rounds DOWN — producing a predicate
  // EARLIER than the last row returned, which repeats rows or trips the
  // non-advancing check.
  it('selects the cursor timestamp from SQL at microsecond precision, in ONE explicit-UTC form', () => {
    const q = buildCandidatePageQuery({ repoId: REPO });
    assert.match(q.sql, /to_char\(created_at AT TIME ZONE 'UTC'/, 'must pin the zone explicitly');
    assert.match(q.sql, /HH24:MI:SS\.US"Z"/, 'must carry microseconds, not milliseconds');
    assert.match(q.sql, /AS cursor_ts/);
    assert.ok(
      !/created_at::text/.test(q.sql),
      '::text renders per the session TimeZone/DateStyle — not portable, not opaque',
    );
  });
});

describe('cursor validation — typed failure, never a silent reset', () => {
  for (const [label, raw] of [
    ['garbage', 'not-base64url-json'],
    ['empty', ''],
    ['a non-string', 42],
    ['valid base64 of a non-object', Buffer.from('"hello"').toString('base64url')],
    ['a wrong version', Buffer.from(JSON.stringify({ v: 99, ts: 't', id: 'i', digest: 'd' })).toString('base64url')],
    ['a missing digest', Buffer.from(JSON.stringify({ v: 1, ts: 't', id: 'i' })).toString('base64url')],
  ]) {
    it(`rejects ${label} as invalid-cursor`, () => {
      const d = decodeCandidateCursor(raw);
      assert.equal(d.ok, false);
      assert.equal(d.error, 'invalid-cursor');
    });
  }

  it('rejects an oversize cursor rather than parsing it', () => {
    const huge = Buffer.from(JSON.stringify({
      v: 1, ts: 'x'.repeat(600), id: 'i', digest: 'd',
    })).toString('base64url');
    assert.equal(decodeCandidateCursor(huge).error, 'invalid-cursor');
  });

  it('round-trips a well-formed cursor (vacuous-pass guard)', () => {
    const c = encodeCandidateCursor({ ts: 'T', id: 'I', digest: 'D' });
    assert.deepEqual(decodeCandidateCursor(c), { ok: true, cursor: { ts: 'T', id: 'I', digest: 'D' } });
  });

  // R3-H3 / G3: a cursor is only meaningful against the filters that produced
  // it. Resuming into a different result set and reporting success is the
  // failure being prevented.
  it('rejects a cursor whose filter digest disagrees with the current invocation', () => {
    const cursor = encodeCandidateCursor({
      ts: 'T', id: 'I', digest: cursorFilterDigest({ repoId: REPO, sinceTs: '2026-01-01T00:00:00Z' }),
    });
    const q = buildCandidatePageQuery({ repoId: REPO, sinceTs: '2026-06-01T00:00:00Z', cursor });
    assert.equal(q.ok, false);
    assert.equal(q.error, 'cursor-filter-mismatch');
  });

  it('accepts the same cursor under the filters that produced it (negative control)', () => {
    const sinceTs = '2026-01-01T00:00:00Z';
    const cursor = encodeCandidateCursor({
      ts: 'T', id: 'I', digest: cursorFilterDigest({ repoId: REPO, sinceTs }),
    });
    assert.equal(buildCandidatePageQuery({ repoId: REPO, sinceTs, cursor }).ok, true);
  });

  // A PRESENT-but-empty cursor is not the same fact as an ABSENT one. A
  // truthiness test conflated them and silently returned page 1 — a resume
  // that restarts from the beginning while reporting success. Same
  // present-vs-absent shape as the session-store schemaVersion branch.
  it('rejects a present-but-empty cursor instead of silently restarting at page 1', () => {
    const q = buildCandidatePageQuery({ repoId: REPO, cursor: '' });
    assert.equal(q.ok, false, 'an empty resume cursor must refuse, not restart');
    assert.equal(q.error, 'invalid-cursor');
  });

  it('still treats null and undefined as "first page" (negative control)', () => {
    for (const absent of [null, undefined]) {
      const q = buildCandidatePageQuery({ repoId: REPO, cursor: absent });
      assert.equal(q.ok, true, `${absent} means no cursor was supplied`);
      assert.deepEqual(q.params, [REPO, CANDIDATE_PAGE_SIZE]);
    }
  });

  it('the digest changes when repoId changes, not only when sinceTs does', () => {
    assert.notEqual(
      cursorFilterDigest({ repoId: REPO, sinceTs: null }),
      cursorFilterDigest({ repoId: 'other-repo', sinceTs: null }),
    );
  });
});

describe('page-result derivation — next cursor and the non-advancing trip', () => {
  const built = { limit: 2, digest: 'D' };

  it('a short page ends the enumeration (nextCursor null)', () => {
    const r = derivePageResult([{ id: 'a', cursor_ts: 'T1' }], built);
    assert.equal(r.ok, true);
    assert.equal(r.nextCursor, null);
  });

  it('a full page yields a cursor derived from its LAST row', () => {
    const r = derivePageResult([{ id: 'a', cursor_ts: 'T1' }, { id: 'b', cursor_ts: 'T2' }], built);
    assert.equal(r.ok, true);
    assert.deepEqual(decodeCandidateCursor(r.nextCursor).cursor, { ts: 'T2', id: 'b', digest: 'D' });
  });

  it('a full page ending where it started is a typed failure, not a re-loop', () => {
    const prior = { ts: 'T2', id: 'b', digest: 'D' };
    const r = derivePageResult([{ id: 'a', cursor_ts: 'T1' }, { id: 'b', cursor_ts: 'T2' }], built, prior);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'non-advancing-cursor', 'looping on a non-advancing cursor spins forever');
  });

  // Equal timestamps across a page boundary: the id tiebreak must carry the
  // cursor forward so the next page resumes after the right row.
  it('equal created_at across the boundary still advances via the id tiebreak', () => {
    const r = derivePageResult([{ id: 'a', cursor_ts: 'SAME' }, { id: 'b', cursor_ts: 'SAME' }], built);
    const c = decodeCandidateCursor(r.nextCursor).cursor;
    assert.equal(c.ts, 'SAME');
    assert.equal(c.id, 'b', 'must resume after the LAST row, not the first with that timestamp');
  });
});

describe('resolveCandidateStatesByFingerprint — bounded, defensive, closed union', () => {
  // R2-M6 / G2: an array bound to `= ANY($2)` is ONE bind parameter, so the
  // driver's parameter limit bounds nothing. The helper REFUSES rather than
  // chunking internally, so a future second caller cannot reintroduce the gap.
  it(`refuses a batch larger than RECONCILE_BATCH_SIZE (${RECONCILE_BATCH_SIZE}) rather than chunking`, () => {
    const tooMany = Array.from({ length: RECONCILE_BATCH_SIZE + 1 }, (_, i) => `fp-${i}`);
    const v = validateFingerprintBatch(tooMany);
    assert.equal(v.ok, false);
    assert.match(v.error, /too-many-fingerprints/);
  });

  it('accepts exactly RECONCILE_BATCH_SIZE (boundary, negative control)', () => {
    const exact = Array.from({ length: RECONCILE_BATCH_SIZE }, (_, i) => `fp-${i}`);
    assert.equal(validateFingerprintBatch(exact).ok, true);
  });

  it('deduplicates before counting, so duplicates cannot trip the bound', () => {
    const dupes = Array.from({ length: RECONCILE_BATCH_SIZE + 50 }, () => 'same-fp');
    const v = validateFingerprintBatch(dupes);
    assert.equal(v.ok, true);
    assert.deepEqual(v.clean, ['same-fp']);
  });

  it('drops non-string and over-long entries', () => {
    const v = validateFingerprintBatch(['ok', 42, null, undefined, '', 'x'.repeat(201)]);
    assert.deepEqual(v.clean, ['ok']);
  });

  it('rejects a non-array outright', () => {
    assert.equal(validateFingerprintBatch('fp').ok, false);
    assert.equal(validateFingerprintBatch(null).error, 'fingerprints-must-be-array');
  });

  it('defaults every requested fingerprint to absent, then overlays what the DB returned', () => {
    const states = mapFingerprintRowsToStates(['a', 'b', 'c', 'd'], [
      { candidate_fingerprint: 'a', source_kind: 'persona-consistency-locked' },
      { candidate_fingerprint: 'b', source_kind: 'persona-consistency-candidate' },
      { candidate_fingerprint: 'c', source_kind: 'something-else' },
    ]);
    assert.equal(states.a, 'promoted');
    assert.equal(states.b, 'candidate');
    assert.equal(states.c, 'unknown');
    assert.equal(states.d, 'absent', 'a fingerprint with no row is absent — never silently promoted');
  });

  it('ignores rows for fingerprints that were not asked about', () => {
    const states = mapFingerprintRowsToStates(['a'], [
      { candidate_fingerprint: 'zzz', source_kind: 'persona-consistency-locked' },
    ]);
    assert.deepEqual(Object.keys(states), ['a']);
    assert.equal(states.a, 'absent');
  });

  it('uses a null-prototype map so a fingerprint named __proto__ cannot poison it', () => {
    const states = mapFingerprintRowsToStates(['__proto__'], [
      { candidate_fingerprint: '__proto__', source_kind: 'persona-consistency-locked' },
    ]);
    assert.equal(states.__proto__, 'promoted');
    assert.equal(Object.getPrototypeOf(states), null);
  });
});
