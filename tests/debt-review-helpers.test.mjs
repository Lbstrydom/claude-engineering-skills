/**
 * @fileoverview Phase D.3 — debt-review helper tests.
 * Covers leverage scoring, TTL staleness, local clustering, and budget violations.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EFFORT_WEIGHTS,
  SONAR_TYPE_WEIGHTS,
  computeLeverage,
  rankRefactorsByLeverage,
  findStaleEntries,
  oldestEntryDays,
  groupByFile,
  groupByPrinciple,
  findRecurringEntries,
  buildLocalClusters,
  countDebtByFile,
  findBudgetViolations,
} from '../scripts/lib/debt-review-helpers.mjs';

function makeEntry(overrides = {}) {
  return {
    topicId: 'a',
    severity: 'MEDIUM',
    category: 'test',
    affectedFiles: ['src/x.js'],
    affectedPrinciples: ['DRY'],
    distinctRunCount: 0,
    deferredAt: '2026-04-01T10:00:00.000Z',
    classification: { sonarType: 'CODE_SMELL', effort: 'EASY' },
    ...overrides,
  };
}

// ── computeLeverage ─────────────────────────────────────────────────────────

describe('computeLeverage', () => {
  test('known case: 3 BUGs, MEDIUM effort = 9/4 = 2.25', () => {
    const index = new Map([
      ['a', makeEntry({ topicId: 'a', classification: { sonarType: 'BUG' } })],
      ['b', makeEntry({ topicId: 'b', classification: { sonarType: 'BUG' } })],
      ['c', makeEntry({ topicId: 'c', classification: { sonarType: 'BUG' } })],
    ]);
    const r = { effortEstimate: 'MEDIUM', resolvedTopicIds: ['a', 'b', 'c'] };
    assert.equal(computeLeverage(r, index), 2.25);
  });

  test('VULNERABILITY + CODE_SMELL, EASY effort', () => {
    const index = new Map([
      ['a', makeEntry({ topicId: 'a', classification: { sonarType: 'VULNERABILITY' } })],
      ['b', makeEntry({ topicId: 'b', classification: { sonarType: 'CODE_SMELL' } })],
    ]);
    // (3 + 1) / 2 = 2
    assert.equal(computeLeverage({ effortEstimate: 'EASY', resolvedTopicIds: ['a', 'b'] }, index), 2);
  });

  test('missing classification defaults to weight 1', () => {
    const index = new Map([
      ['a', makeEntry({ topicId: 'a', classification: null })],
    ]);
    assert.equal(computeLeverage({ effortEstimate: 'EASY', resolvedTopicIds: ['a'] }, index), 0.5);
  });

  test('missing topicId skipped', () => {
    const index = new Map([['a', makeEntry({ topicId: 'a', classification: { sonarType: 'BUG' } })]]);
    // a=3, missing→0, total=3 / MEDIUM=4 = 0.75
    assert.equal(computeLeverage({ effortEstimate: 'MEDIUM', resolvedTopicIds: ['a', 'missing'] }, index), 0.75);
  });

  test('unknown effort estimate returns 0', () => {
    const index = new Map();
    assert.equal(computeLeverage({ effortEstimate: 'UNKNOWN', resolvedTopicIds: [] }, index), 0);
  });

  test('CRITICAL effort has weight 16 (lowest leverage multiplier)', () => {
    const index = new Map([['a', makeEntry({ topicId: 'a', classification: { sonarType: 'BUG' } })]]);
    // 3 / 16 = 0.1875, rounded to 3 decimals = 0.188
    assert.equal(computeLeverage({ effortEstimate: 'CRITICAL', resolvedTopicIds: ['a'] }, index), 0.188);
  });
});

// ── rankRefactorsByLeverage ─────────────────────────────────────────────────

describe('rankRefactorsByLeverage', () => {
  test('sorts descending by leverage', () => {
    const entries = [
      makeEntry({ topicId: 'a', classification: { sonarType: 'BUG' } }),
      makeEntry({ topicId: 'b', classification: { sonarType: 'CODE_SMELL' } }),
    ];
    const refactors = [
      { clusterId: 'low', effortEstimate: 'MAJOR', resolvedTopicIds: ['b'], targetModules: [], effortRationale: '', risks: [], rollbackStrategy: '' },
      { clusterId: 'high', effortEstimate: 'EASY', resolvedTopicIds: ['a'], targetModules: [], effortRationale: '', risks: [], rollbackStrategy: '' },
    ];
    const ranked = rankRefactorsByLeverage(refactors, entries);
    assert.equal(ranked[0].clusterId, 'high');
    assert.ok(ranked[0].leverageScore > ranked[1].leverageScore);
  });

  test('attaches leverageScore to each candidate', () => {
    const ranked = rankRefactorsByLeverage([
      { clusterId: 'x', effortEstimate: 'EASY', resolvedTopicIds: [], targetModules: [], effortRationale: '', risks: [], rollbackStrategy: '' },
    ], []);
    assert.ok('leverageScore' in ranked[0]);
  });

  test('effort and sonar weight tables exposed', () => {
    assert.equal(EFFORT_WEIGHTS.TRIVIAL, 1);
    assert.equal(EFFORT_WEIGHTS.CRITICAL, 16);
    assert.equal(SONAR_TYPE_WEIGHTS.BUG, 3);
    assert.equal(SONAR_TYPE_WEIGHTS.CODE_SMELL, 1);
  });
});

// ── TTL Staleness ───────────────────────────────────────────────────────────

describe('findStaleEntries', () => {
  const now = new Date('2026-04-05T12:00:00.000Z');

  test('flags entries older than ttlDays', () => {
    const entries = [
      makeEntry({ topicId: 'old', deferredAt: '2025-10-01T10:00:00.000Z' }),  // ~186 days
      makeEntry({ topicId: 'new', deferredAt: '2026-04-01T10:00:00.000Z' }),  // ~4 days
    ];
    assert.deepEqual(findStaleEntries(entries, 90, now), ['old']);
    assert.deepEqual(findStaleEntries(entries, 1, now), ['old', 'new']);
  });

  test('invalid ttlDays returns empty', () => {
    const entries = [makeEntry({ deferredAt: '2020-01-01T00:00:00.000Z' })];
    assert.deepEqual(findStaleEntries(entries, 0), []);
    assert.deepEqual(findStaleEntries(entries, -10), []);
    assert.deepEqual(findStaleEntries(entries, Infinity), []);
  });

  test('invalid deferredAt safely skipped', () => {
    const entries = [makeEntry({ topicId: 'bad', deferredAt: 'not-a-date' })];
    assert.deepEqual(findStaleEntries(entries, 90, now), []);
  });
});

describe('oldestEntryDays', () => {
  const now = new Date('2026-04-05T12:00:00.000Z');
  test('returns 0 for empty ledger', () => {
    assert.equal(oldestEntryDays([], now), 0);
  });
  test('returns age of oldest entry', () => {
    const entries = [
      makeEntry({ deferredAt: '2026-04-01T10:00:00.000Z' }),
      makeEntry({ deferredAt: '2025-10-01T10:00:00.000Z' }),
      makeEntry({ deferredAt: '2026-04-03T10:00:00.000Z' }),
    ];
    assert.equal(oldestEntryDays(entries, now), 186);
  });
});

// ── Local Clustering ────────────────────────────────────────────────────────

describe('groupByFile', () => {
  test('groups by first affectedFile', () => {
    const entries = [
      makeEntry({ topicId: 'a', affectedFiles: ['src/x.js'] }),
      makeEntry({ topicId: 'b', affectedFiles: ['src/x.js'] }),
      makeEntry({ topicId: 'c', affectedFiles: ['src/y.js'] }),
    ];
    const g = groupByFile(entries);
    assert.equal(g.get('src/x.js').length, 2);
    assert.equal(g.get('src/y.js').length, 1);
  });

  test('no affectedFiles → "unknown" bucket', () => {
    const g = groupByFile([makeEntry({ affectedFiles: [] })]);
    assert.equal(g.get('unknown').length, 1);
  });
});

describe('findRecurringEntries', () => {
  test('filters by distinctRunCount', () => {
    const entries = [
      makeEntry({ topicId: 'a', distinctRunCount: 5 }),
      makeEntry({ topicId: 'b', distinctRunCount: 2 }),
      makeEntry({ topicId: 'c', distinctRunCount: 3 }),
    ];
    const r = findRecurringEntries(entries, 3);
    assert.equal(r.length, 2);
    assert.equal(r[0].topicId, 'a');  // sorted desc
    assert.equal(r[1].topicId, 'c');
  });

  test('falls back to occurrences when distinctRunCount absent', () => {
    const entries = [makeEntry({ topicId: 'a', distinctRunCount: undefined, occurrences: 4 })];
    assert.equal(findRecurringEntries(entries, 3).length, 1);
  });
});

describe('buildLocalClusters', () => {
  test('emits file + principle + recurrence clusters above minSize', () => {
    const entries = [
      makeEntry({ topicId: 'a', affectedFiles: ['src/x.js'], affectedPrinciples: ['SRP'], distinctRunCount: 4 }),
      makeEntry({ topicId: 'b', affectedFiles: ['src/x.js'], affectedPrinciples: ['SRP'], distinctRunCount: 3 }),
      makeEntry({ topicId: 'c', affectedFiles: ['src/y.js'], affectedPrinciples: ['SRP'], distinctRunCount: 1 }),
    ];
    const clusters = buildLocalClusters(entries, { minSize: 2, recurrenceThreshold: 3 });
    const kinds = clusters.map(c => c.kind).sort();
    assert.deepEqual(kinds, ['file', 'principle', 'recurrence']);
  });

  test('respects minSize', () => {
    const entries = [makeEntry({ topicId: 'a', affectedFiles: ['src/x.js'] })];
    assert.equal(buildLocalClusters(entries, { minSize: 2 }).length, 0);
  });

  test('excludes unknown principle/file buckets', () => {
    const entries = [
      makeEntry({ topicId: 'a', affectedFiles: [], affectedPrinciples: [] }),
      makeEntry({ topicId: 'b', affectedFiles: [], affectedPrinciples: [] }),
    ];
    assert.equal(buildLocalClusters(entries, { minSize: 2 }).length, 0);
  });
});

// ── Budgets ─────────────────────────────────────────────────────────────────

describe('findBudgetViolations', () => {
  test('detects over-budget paths', () => {
    const entries = [
      makeEntry({ topicId: 'a', affectedFiles: ['src/big.js'] }),
      makeEntry({ topicId: 'b', affectedFiles: ['src/big.js'] }),
      makeEntry({ topicId: 'c', affectedFiles: ['src/big.js'] }),
      makeEntry({ topicId: 'd', affectedFiles: ['src/small.js'] }),
    ];
    const v = findBudgetViolations(entries, { 'src/big.js': 2, 'src/small.js': 5 });
    assert.equal(v.length, 1);
    assert.equal(v[0].path, 'src/big.js');
    assert.equal(v[0].count, 3);
    assert.equal(v[0].budget, 2);
  });

  test('no budgets → no violations', () => {
    assert.deepEqual(findBudgetViolations([makeEntry()], {}), []);
    assert.deepEqual(findBudgetViolations([makeEntry()], null), []);
  });

  test('sorts by severity of over-budget', () => {
    const entries = [
      ...Array(10).fill(0).map((_, i) => makeEntry({ topicId: 't' + i, affectedFiles: ['a.js'] })),
      ...Array(4).fill(0).map((_, i) => makeEntry({ topicId: 'u' + i, affectedFiles: ['b.js'] })),
    ];
    const v = findBudgetViolations(entries, { 'a.js': 3, 'b.js': 3 });
    assert.equal(v[0].path, 'a.js');  // over by 7, should be first
    assert.equal(v[1].path, 'b.js');  // over by 1
  });
});

describe('findBudgetViolations — glob support (D.5)', () => {
  const entries = [
    makeEntry({ topicId: 'a', affectedFiles: ['scripts/lib/x.mjs'] }),
    makeEntry({ topicId: 'b', affectedFiles: ['scripts/lib/y.mjs'] }),
    makeEntry({ topicId: 'c', affectedFiles: ['scripts/lib/sub/z.mjs'] }),
    makeEntry({ topicId: 'd', affectedFiles: ['scripts/openai-audit.mjs'] }),
    makeEntry({ topicId: 'e', affectedFiles: ['docs/plan.md'] }),
  ];

  test('glob pattern scripts/lib/** matches all 3 lib files', () => {
    const v = findBudgetViolations(entries, { 'scripts/lib/**': 2 });
    assert.equal(v.length, 1);
    assert.equal(v[0].path, 'scripts/lib/**');
    assert.equal(v[0].count, 3);
    assert.equal(v[0].isGlob, true);
  });

  test('exact path still works alongside glob', () => {
    const v = findBudgetViolations(entries, {
      'scripts/lib/**': 10,                  // not violated (3 <= 10)
      'scripts/openai-audit.mjs': 0,         // violated (1 > 0)
    });
    assert.equal(v.length, 1);
    assert.equal(v[0].path, 'scripts/openai-audit.mjs');
    assert.equal(v[0].isGlob, false);
  });

  test('glob within-budget not flagged', () => {
    assert.deepEqual(findBudgetViolations(entries, { 'scripts/lib/**': 5 }), []);
  });

  test('multiple glob violations sort by how much over-budget', () => {
    const v = findBudgetViolations(entries, {
      'scripts/**': 1,       // 4 entries, over by 3
      'docs/**': 0,          // 1 entry, over by 1
    });
    assert.equal(v.length, 2);
    assert.equal(v[0].path, 'scripts/**');  // biggest over first
    assert.equal(v[1].path, 'docs/**');
  });

  test('isGlob flag distinguishes pattern types', () => {
    const v = findBudgetViolations(entries, {
      'scripts/lib/**': 0,
      'scripts/openai-audit.mjs': 0,
    });
    const byPath = Object.fromEntries(v.map(x => [x.path, x.isGlob]));
    assert.equal(byPath['scripts/lib/**'], true);
    assert.equal(byPath['scripts/openai-audit.mjs'], false);
  });

  test('accepts injected matcher for testability', () => {
    let called = false;
    const fakeMatcher = (files, pattern) => { called = true; return files; };
    findBudgetViolations(entries, { '**/*.mjs': 0 }, { matcher: fakeMatcher });
    assert.equal(called, true);
  });
});

describe('countDebtByFile', () => {
  test('counts primary files', () => {
    const entries = [
      makeEntry({ affectedFiles: ['a.js'] }),
      makeEntry({ affectedFiles: ['a.js'] }),
      makeEntry({ affectedFiles: ['b.js'] }),
    ];
    const c = countDebtByFile(entries);
    assert.equal(c.get('a.js'), 2);
    assert.equal(c.get('b.js'), 1);
  });

  test('skips entries with no affectedFiles', () => {
    const c = countDebtByFile([makeEntry({ affectedFiles: [] })]);
    assert.equal(c.size, 0);
  });
});
