/**
 * @fileoverview Pure-core tests for semantic re-raise suppression.
 * The I/O parts (nearestOpenReRaise, the CLI) are exercised against the live
 * store by scripts/semantic-suppress.mjs --dry-run; these pin the deterministic
 * decision + clustering logic that decides what gets suppressed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideReRaise, cosine, greedyReRaiseClusters, toVectorLiteral, buildOpenFindingsQuery, CAP_ORDERS,
  partitionRecordTimeReRaises,
} from '../scripts/lib/semantic-suppression.mjs';

// A mock pg pool whose nearestOpenReRaise query returns a scripted neighbour.
const mockPool = (neighbourRow) => ({ query: async () => ({ rows: neighbourRow ? [neighbourRow] : [] }) });
const okEmbed = async () => [1, 0, 0];

const OPTS = { threshold: 0.92, requireSameFile: true };

test('decideReRaise suppresses a same-file above-threshold neighbour', () => {
  const d = decideReRaise({ primaryFile: 'a/b.mjs' },
    { finding_id: 'x', cosine: 0.95, primary_file: 'a/b.mjs' }, OPTS);
  assert.equal(d.suppress, true);
  assert.equal(d.matchedId, 'x');
});

test('decideReRaise does NOT suppress below threshold', () => {
  const d = decideReRaise({ primaryFile: 'a/b.mjs' },
    { finding_id: 'x', cosine: 0.90, primary_file: 'a/b.mjs' }, OPTS);
  assert.equal(d.suppress, false);
  assert.equal(d.reason, 'below-threshold');
});

test('decideReRaise does NOT suppress a different-file match (conservative guard)', () => {
  const d = decideReRaise({ primaryFile: 'a/b.mjs' },
    { finding_id: 'x', cosine: 0.99, primary_file: 'c/d.mjs' }, OPTS);
  assert.equal(d.suppress, false);
  assert.equal(d.reason, 'different-file');
});

test('decideReRaise CAN cross files when requireSameFile is relaxed', () => {
  const d = decideReRaise({ primaryFile: 'a/b.mjs' },
    { finding_id: 'x', cosine: 0.99, primary_file: 'c/d.mjs' },
    { threshold: 0.92, requireSameFile: false });
  assert.equal(d.suppress, true);
});

test('decideReRaise is safe on a null / cosineless neighbour', () => {
  assert.equal(decideReRaise({}, null, OPTS).suppress, false);
  assert.equal(decideReRaise({}, { finding_id: 'x', cosine: NaN, primary_file: 'a' }, OPTS).suppress, false);
});

test('cosine: identical=1, orthogonal=0, zero-norm=NaN', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1]) - 0) < 1e-9);
  assert.ok(Number.isNaN(cosine([0, 0], [1, 1])));
  assert.ok(Number.isNaN(cosine([1], [1, 2])));
});

test('greedy clustering: oldest is canonical; reworded same-file repeats are duplicates', () => {
  // Three near-identical vectors (same issue, reworded) + one distinct.
  const base = [1, 0, 0, 0];
  const near1 = [0.99, 0.1, 0, 0];
  const near2 = [0.98, 0.14, 0, 0];
  const distinct = [0, 1, 0, 0];
  const findings = [
    { id: 'newest', primaryFile: 'f.mjs', createdAt: '2026-07-03', embedding: near2 },
    { id: 'oldest', primaryFile: 'f.mjs', createdAt: '2026-07-01', embedding: base },
    { id: 'mid', primaryFile: 'f.mjs', createdAt: '2026-07-02', embedding: near1 },
    { id: 'other', primaryFile: 'f.mjs', createdAt: '2026-07-04', embedding: distinct },
  ];
  const clusters = greedyReRaiseClusters(findings, { threshold: 0.9, requireSameFile: true });
  const dupCluster = clusters.find((c) => c.duplicates.length > 0);
  assert.equal(dupCluster.canonical.id, 'oldest', 'oldest raising is canonical');
  assert.deepEqual(dupCluster.duplicates.map((d) => d.id).sort(), ['mid', 'newest']);
  // the distinct finding stands alone
  assert.ok(clusters.some((c) => c.canonical.id === 'other' && c.duplicates.length === 0));
});

test('greedy clustering keeps same-meaning findings on DIFFERENT files separate', () => {
  const v = [1, 0, 0];
  const findings = [
    { id: 'a', primaryFile: 'x.mjs', createdAt: '2026-07-01', embedding: v },
    { id: 'b', primaryFile: 'y.mjs', createdAt: '2026-07-02', embedding: v },
  ];
  const clusters = greedyReRaiseClusters(findings, { threshold: 0.9, requireSameFile: true });
  assert.equal(clusters.length, 2, 'same vector, different file → two clusters, no suppression');
});

test('clustering is order-independent (oldest-canonical is the invariant)', () => {
  const mk = (id, t, e) => ({ id, primaryFile: 'f.mjs', createdAt: t, embedding: e });
  const set = [
    mk('c', '2026-07-03', [0.98, 0.14, 0]),
    mk('a', '2026-07-01', [1, 0, 0]),
    mk('b', '2026-07-02', [0.99, 0.1, 0]),
  ];
  const c1 = greedyReRaiseClusters(set, { threshold: 0.9, requireSameFile: true });
  const c2 = greedyReRaiseClusters([...set].reverse(), { threshold: 0.9, requireSameFile: true });
  const canon = (cs) => cs.find((c) => c.duplicates.length).canonical.id;
  assert.equal(canon(c1), 'a');
  assert.equal(canon(c2), 'a', 'input order must not change the canonical');
});

test('toVectorLiteral formats + rejects non-finite', () => {
  assert.equal(toVectorLiteral([0.1, 0.2, -0.3]), '[0.1,0.2,-0.3]');
  assert.throws(() => toVectorLiteral([]));
  assert.throws(() => toVectorLiteral([1, NaN]));
});

// ── record-time hook: partitionRecordTimeReRaises ──────────────────────────

const RT = { threshold: 0.92, requireSameFile: true, runId: 'run-1' };

test('record-time: suppresses a finding matching a same-file open neighbour', async () => {
  const pool = mockPool({ finding_id: 'open-9', primary_file: 'a/b.mjs', detail_snapshot: 'x', cosine: 0.97 });
  const findings = [{ detail: 'a'.repeat(40), section: 'a/b.mjs', _hash: 'fp1' }];
  const r = await partitionRecordTimeReRaises({ pool, repoId: 'r', embed: okEmbed, findings, ...RT });
  assert.equal(r.kept.length, 0);
  assert.equal(r.suppressed.length, 1);
  assert.equal(r.suppressed[0].matchedId, 'open-9');
});

test('record-time: keeps a finding with NO neighbour', async () => {
  const pool = mockPool(null);
  const findings = [{ detail: 'a'.repeat(40), section: 'a/b.mjs', _hash: 'fp1' }];
  const r = await partitionRecordTimeReRaises({ pool, repoId: 'r', embed: okEmbed, findings, ...RT });
  assert.equal(r.kept.length, 1);
  assert.equal(r.suppressed.length, 0);
  assert.ok(r.vectorByFinding.get(findings[0]), 'kept finding carries its vector for persistence');
});

test('record-time: FAIL-OPEN — an embed error records the finding, never drops it', async () => {
  const pool = mockPool({ finding_id: 'open-9', primary_file: 'a/b.mjs', detail_snapshot: 'x', cosine: 0.99 });
  const badEmbed = async () => { throw new Error('gemini down'); };
  const findings = [{ detail: 'a'.repeat(40), section: 'a/b.mjs', _hash: 'fp1' }];
  const r = await partitionRecordTimeReRaises({ pool, repoId: 'r', embed: badEmbed, findings, ...RT });
  assert.equal(r.kept.length, 1, 'embed failure must keep the finding');
  assert.equal(r.suppressed.length, 0);
});

test('record-time: FAIL-OPEN — a query error keeps the finding', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  const findings = [{ detail: 'a'.repeat(40), section: 'a/b.mjs', _hash: 'fp1' }];
  const r = await partitionRecordTimeReRaises({ pool, repoId: 'r', embed: okEmbed, findings, ...RT });
  assert.equal(r.kept.length, 1);
});

test('record-time: a too-short detail is kept without embedding (nothing to compare)', async () => {
  let embedCalls = 0;
  const pool = mockPool(null);
  const findings = [{ detail: 'short', section: 'a/b.mjs', _hash: 'fp1' }];
  const r = await partitionRecordTimeReRaises({ pool, repoId: 'r', embed: async () => { embedCalls++; return [1, 0]; }, findings, ...RT });
  assert.equal(r.kept.length, 1);
  assert.equal(embedCalls, 0, 'no embed call for sub-threshold-length detail');
});

// ── The retrospective reconciler's cap ───────────────────────────────────────
// Regression origin (2026-08-13). The cap was `ROW_NUMBER() OVER (ORDER BY
// created_at DESC) <= cap`, so it kept the NEWEST rows. Measured on this repo:
// of 991 eligible findings older than 14 days — the population /ship's
// unremediated-acceptance gate counts, and the one whose rows are days from
// crossing the 30-day ceiling and never being surfaced again — ZERO fell inside
// the default cap of 400, which reached back only to the previous day. The
// reconciler structurally could not see the backlog it exists to collapse.
//
// Asserted on the generated SQL rather than against a store because the defect
// IS the SQL, and it is invisible in the CLI's output either way.

test('the cap keeps the OLDEST findings by default — the aging backlog is reachable', () => {
  const { sql, params } = buildOpenFindingsQuery({ repoId: 'r1', windowDays: 30, cap: 400 });
  assert.match(sql, /ROW_NUMBER\(\)\s+OVER\s+\(ORDER BY f\.created_at ASC\)/,
    'default must order oldest-first; DESC is the defect that hid 991 rows');
  assert.deepEqual(params, ['r1', 30, 400]);
});

test('--order newest is still available, and is the only other direction', () => {
  const { sql } = buildOpenFindingsQuery({ repoId: 'r1', windowDays: 30, cap: 10, order: 'newest' });
  assert.match(sql, /ORDER BY f\.created_at DESC/);
  assert.deepEqual(CAP_ORDERS, ['oldest', 'newest']);
});

test('the cap cannot truncate silently — the eligible total rides along', () => {
  const { sql } = buildOpenFindingsQuery({ repoId: 'r1', windowDays: 30, cap: 400 });
  assert.match(sql, /count\(\*\) OVER \(\) AS eligible/,
    'without the window total, a capped read is indistinguishable from a complete one');
  assert.match(sql, /SELECT id, snap, primary_file, category, created_at, eligible FROM base/,
    'the total must survive into the projection, not just the CTE');
});

test('an unknown order is rejected before it can reach the SQL', () => {
  // A sort direction cannot be a bound parameter, so it is interpolated —
  // validation is what keeps that safe.
  assert.throws(() => buildOpenFindingsQuery({ repoId: 'r1', windowDays: 30, cap: 5, order: 'ASC; DROP TABLE audit_findings' }),
    /order must be one of oldest\|newest/);
  assert.throws(() => buildOpenFindingsQuery({ repoId: 'r1', windowDays: 30, cap: 5, order: 'random' }), TypeError);
});
