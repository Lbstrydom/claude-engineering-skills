import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesKnownDefect, stratifiedMediumSample } from '../scripts/lib/solo-control/stratified-sample.mjs';

test('matchesKnownDefect: commit + exact file match returns the KD id', () => {
  const kd = [{ id: 'KD-001', buggyCommit: 'abc123', files: ['scripts/reconcile-repo-identity.mjs'] }];
  assert.equal(matchesKnownDefect({ commit: 'abc123', file: 'scripts/reconcile-repo-identity.mjs' }, kd), 'KD-001');
});

test('matchesKnownDefect: recall-biased suffix match (basename-only reference)', () => {
  const kd = [{ id: 'KD-001', buggyCommit: 'abc123', files: ['scripts/reconcile-repo-identity.mjs'] }];
  assert.equal(matchesKnownDefect({ commit: 'abc123', file: 'reconcile-repo-identity.mjs' }, kd), 'KD-001');
});

test('matchesKnownDefect: wrong commit or wrong file returns null', () => {
  const kd = [{ id: 'KD-001', buggyCommit: 'abc123', files: ['scripts/x.mjs'] }];
  assert.equal(matchesKnownDefect({ commit: 'zzz', file: 'scripts/x.mjs' }, kd), null);
  assert.equal(matchesKnownDefect({ commit: 'abc123', file: 'unrelated.js' }, kd), null);
});

test('matchesKnownDefect: normalizes Windows path separators', () => {
  const kd = [{ id: 'KD-002', buggyCommit: 'xyz', files: ['src/routes/ratings.js'] }];
  assert.equal(matchesKnownDefect({ commit: 'xyz', file: 'src\\routes\\ratings.js' }, kd), 'KD-002');
});

test('matchesKnownDefect: no defects or empty file → null, never throws', () => {
  assert.equal(matchesKnownDefect({ commit: 'x', file: '' }, []), null);
  assert.equal(matchesKnownDefect({ commit: 'x' }, [{ id: 'K', buggyCommit: 'x', files: ['a.js'] }]), null);
});

test('stratifiedMediumSample: returns exactly targetSize when enough clusters exist and the cap is not binding', () => {
  // capFraction: 1 → the per-commit cap equals targetSize itself, so with only
  // 2 commits contributing it never constrains reaching the full target. The
  // default (tighter) cap is exercised by the dedicated capping test below,
  // where — correctly — it can make targetSize unreachable with few commits.
  const clusters = Array.from({ length: 200 }, (_, i) => ({ clusterKey: `k${i}`, commit: i % 4 === 0 ? 'c1' : 'c2', arms: new Set(['A']) }));
  const sample = stratifiedMediumSample(clusters, { targetSize: 50, seed: 1, capFraction: 1 });
  assert.equal(sample.size, 50);
});

test('stratifiedMediumSample: per-commit cap prevents one commit from dominating', () => {
  // one giant commit (200 clusters) + 4 small commits (10 each) — mirrors the
  // live ff20d85e domination (176/599 = ~29% of the sheet).
  const clusters = [];
  for (let i = 0; i < 200; i++) clusters.push({ clusterKey: `big:${i}`, commit: 'big', arms: new Set(['A']) });
  for (const c of ['c1', 'c2', 'c3', 'c4']) for (let i = 0; i < 10; i++) clusters.push({ clusterKey: `${c}:${i}`, commit: c, arms: new Set(['A', 'S']) });
  const sample = stratifiedMediumSample(clusters, { targetSize: 100, capFraction: 0.15, seed: 42 });
  const bigCount = [...sample.values()].filter((v) => v.commit === 'big').length;
  assert.ok(bigCount <= 15, `big commit should be capped near 15% of target (got ${bigCount}/100)`);
});

test('stratifiedMediumSample: deterministic given the same seed', () => {
  const clusters = Array.from({ length: 50 }, (_, i) => ({
    clusterKey: `k${i}`, commit: i % 3 === 0 ? 'c1' : 'c2', arms: new Set(i % 2 === 0 ? ['A', 'S'] : ['A']),
  }));
  const s1 = stratifiedMediumSample(clusters, { targetSize: 20, seed: 7 });
  const s2 = stratifiedMediumSample(clusters, { targetSize: 20, seed: 7 });
  assert.deepEqual([...s1.keys()].sort(), [...s2.keys()].sort());
});

test('stratifiedMediumSample: different seeds can produce different samples', () => {
  const clusters = Array.from({ length: 50 }, (_, i) => ({ clusterKey: `k${i}`, commit: 'c1', arms: new Set(['A']) }));
  const s1 = stratifiedMediumSample(clusters, { targetSize: 20, seed: 1 });
  const s2 = stratifiedMediumSample(clusters, { targetSize: 20, seed: 2 });
  assert.notDeepEqual([...s1.keys()].sort(), [...s2.keys()].sort());
});

test('stratifiedMediumSample: empty input or targetSize<=0 returns an empty map', () => {
  assert.equal(stratifiedMediumSample([], { targetSize: 100, seed: 1 }).size, 0);
  assert.equal(stratifiedMediumSample([{ clusterKey: 'a', commit: 'c', arms: new Set() }], { targetSize: 0, seed: 1 }).size, 0);
});

test('stratifiedMediumSample: both multi-arm and single-arm strata represented when both exist', () => {
  const clusters = [
    ...Array.from({ length: 20 }, (_, i) => ({ clusterKey: `multi${i}`, commit: 'c1', arms: new Set(['A', 'S']) })),
    ...Array.from({ length: 20 }, (_, i) => ({ clusterKey: `single${i}`, commit: 'c1', arms: new Set(['A']) })),
  ];
  const sample = stratifiedMediumSample(clusters, { targetSize: 20, seed: 3, capFraction: 1 });
  const multiCount = [...sample.keys()].filter((k) => k.startsWith('multi')).length;
  const singleCount = [...sample.keys()].filter((k) => k.startsWith('single')).length;
  assert.ok(multiCount > 0 && singleCount > 0, `both strata should be represented (multi=${multiCount}, single=${singleCount})`);
});

test('stratifiedMediumSample: inclusionProb reflects the actual within-stratum sampling rate', () => {
  const clusters = Array.from({ length: 40 }, (_, i) => ({ clusterKey: `k${i}`, commit: 'c1', arms: new Set(['A']) })); // all single-arm
  const sample = stratifiedMediumSample(clusters, { targetSize: 10, seed: 5, capFraction: 1 });
  for (const v of sample.values()) {
    assert.ok(v.inclusionProb > 0 && v.inclusionProb <= 1);
    // 10 picked from a 40-item single-arm stratum → prob should be ~0.25.
    assert.ok(Math.abs(v.inclusionProb - 0.25) < 0.01, `expected ~0.25, got ${v.inclusionProb}`);
  }
});
