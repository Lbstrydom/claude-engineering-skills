/**
 * @fileoverview Pure-core tests for semantic re-raise suppression.
 * The I/O parts (nearestOpenReRaise, the CLI) are exercised against the live
 * store by scripts/semantic-suppress.mjs --dry-run; these pin the deterministic
 * decision + clustering logic that decides what gets suppressed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideReRaise, cosine, greedyReRaiseClusters, toVectorLiteral,
} from '../scripts/lib/audit/semantic-suppression.mjs';

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
