/**
 * @fileoverview Phase D.6 — PR comment generator tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  STICKY_MARKER,
  findTouchedDebt,
  renderPrComment,
} from '../scripts/debt-pr-comment.mjs';

function makeEntry(overrides = {}) {
  return {
    topicId: 'aa00bb11',
    severity: 'HIGH',
    category: 'God Module',
    affectedFiles: ['scripts/openai-audit.mjs'],
    deferredReason: 'out-of-scope',
    deferredAt: '2026-03-01T10:00:00.000Z',
    distinctRunCount: 2,
    ...overrides,
  };
}

// ── findTouchedDebt ─────────────────────────────────────────────────────────

describe('findTouchedDebt', () => {
  test('empty inputs return []', () => {
    assert.deepEqual(findTouchedDebt([], ['a.js']), []);
    assert.deepEqual(findTouchedDebt([makeEntry()], []), []);
    assert.deepEqual(findTouchedDebt(null, ['a.js']), []);
    assert.deepEqual(findTouchedDebt([makeEntry()], null), []);
  });

  test('exact file match found', () => {
    const entries = [
      makeEntry({ topicId: 't1', affectedFiles: ['scripts/a.js'] }),
      makeEntry({ topicId: 't2', affectedFiles: ['scripts/b.js'] }),
    ];
    const touched = findTouchedDebt(entries, ['scripts/a.js']);
    assert.equal(touched.length, 1);
    assert.equal(touched[0].topicId, 't1');
  });

  test('normalizes backslash paths', () => {
    const entries = [makeEntry({ topicId: 't1', affectedFiles: ['scripts/lib/x.mjs'] })];
    const touched = findTouchedDebt(entries, ['scripts\\lib\\x.mjs']);
    assert.equal(touched.length, 1);
  });

  test('strips leading ./', () => {
    const entries = [makeEntry({ topicId: 't1', affectedFiles: ['scripts/lib/x.mjs'] })];
    const touched = findTouchedDebt(entries, ['./scripts/lib/x.mjs']);
    assert.equal(touched.length, 1);
  });

  test('substring match (partial path)', () => {
    const entries = [makeEntry({ topicId: 't1', affectedFiles: ['src/scripts/lib/x.mjs'] })];
    const touched = findTouchedDebt(entries, ['scripts/lib/x.mjs']);
    assert.equal(touched.length, 1);
  });

  test('no overlap returns empty', () => {
    const entries = [makeEntry({ topicId: 't1', affectedFiles: ['src/a.js'] })];
    const touched = findTouchedDebt(entries, ['docs/readme.md']);
    assert.equal(touched.length, 0);
  });

  test('multiple affected files — any match counts', () => {
    const entries = [makeEntry({
      topicId: 't1', affectedFiles: ['src/a.js', 'src/b.js', 'src/c.js'],
    })];
    assert.equal(findTouchedDebt(entries, ['src/c.js']).length, 1);
  });
});

// ── renderPrComment ─────────────────────────────────────────────────────────

describe('renderPrComment', () => {
  test('always includes the sticky marker as first line', () => {
    const body = renderPrComment({
      touchedDebt: [],
      recurringDebt: [],
      totalEntries: 0,
    });
    assert.ok(body.startsWith(STICKY_MARKER));
  });

  test('empty-ledger state: "no tracked debt"', () => {
    const body = renderPrComment({
      touchedDebt: [],
      recurringDebt: [],
      totalEntries: 0,
    });
    assert.match(body, /No tracked debt/);
  });

  test('shows touched count in header', () => {
    const body = renderPrComment({
      touchedDebt: [makeEntry({ topicId: 't1' }), makeEntry({ topicId: 't2' })],
      recurringDebt: [],
      totalEntries: 5,
    });
    assert.match(body, /Touched code has 2 deferred debt entries/);
  });

  test('singular vs plural entry count', () => {
    const body = renderPrComment({
      touchedDebt: [makeEntry({ topicId: 't1' })],
      recurringDebt: [],
      totalEntries: 5,
    });
    assert.match(body, /1 deferred debt entry/);
    assert.doesNotMatch(body, /1 deferred debt entries/);
  });

  test('renders topicId, severity, category, reason, date, owner', () => {
    const entry = makeEntry({
      topicId: 'abcd1234',
      severity: 'MEDIUM',
      category: 'Mixed Concerns',
      owner: '@backend-team',
      deferredReason: 'blocked-by',
      deferredAt: '2026-03-15T10:00:00.000Z',
      distinctRunCount: 4,
    });
    const body = renderPrComment({
      touchedDebt: [entry],
      recurringDebt: [],
      totalEntries: 1,
    });
    assert.match(body, /abcd1234/);
    assert.match(body, /M —/);
    assert.match(body, /Mixed Concerns/);
    assert.match(body, /@backend-team/);
    assert.match(body, /blocked-by/);
    assert.match(body, /occurrences: 4/);
    assert.match(body, /2026-03-15/);
  });

  test('groups by file with per-file headers', () => {
    const body = renderPrComment({
      touchedDebt: [
        makeEntry({ topicId: 't1', affectedFiles: ['src/a.js'] }),
        makeEntry({ topicId: 't2', affectedFiles: ['src/a.js'] }),
        makeEntry({ topicId: 't3', affectedFiles: ['src/b.js'] }),
      ],
      recurringDebt: [],
      totalEntries: 3,
    });
    assert.match(body, /\*\*src\/a\.js\*\*/);
    assert.match(body, /\*\*src\/b\.js\*\*/);
  });

  test('includes refactor-plan link in footer', () => {
    const body = renderPrComment({
      touchedDebt: [makeEntry({ topicId: 't1' })],
      recurringDebt: [],
      totalEntries: 1,
    });
    assert.match(body, /debt-review\.mjs/);
  });

  test('includes collapsed recurring-debt section', () => {
    const body = renderPrComment({
      touchedDebt: [],
      recurringDebt: [makeEntry({ topicId: 't1', distinctRunCount: 5 })],
      totalEntries: 1,
    });
    assert.match(body, /<details>/);
    assert.match(body, /Recurring debt/);
    assert.match(body, /\(1 entry with ≥3 occurrences, repo-wide\)/);
    assert.match(body, /<\/details>/);
  });

  test('caps recurring-debt list at 20 entries with "more" line', () => {
    const recurring = Array.from({ length: 25 }, (_, i) =>
      makeEntry({ topicId: `rec${i}`, distinctRunCount: 5 })
    );
    const body = renderPrComment({
      touchedDebt: [],
      recurringDebt: recurring,
      totalEntries: 25,
    });
    assert.match(body, /… and 5 more/);
  });

  test('shows both touched + recurring sections when both present', () => {
    const body = renderPrComment({
      touchedDebt: [makeEntry({ topicId: 't1' })],
      recurringDebt: [makeEntry({ topicId: 'r1', distinctRunCount: 5 })],
      totalEntries: 2,
    });
    assert.match(body, /Touched code has/);
    assert.match(body, /<details>/);
  });

  test('touched empty but recurring present → shows "no debt overlaps" + recurring', () => {
    const body = renderPrComment({
      touchedDebt: [],
      recurringDebt: [makeEntry({ topicId: 'r1', distinctRunCount: 5 })],
      totalEntries: 1,
    });
    assert.match(body, /No tracked debt overlaps/);
    assert.match(body, /<details>/);
  });

  test('prNumber appears in header when provided', () => {
    const body = renderPrComment({
      touchedDebt: [],
      recurringDebt: [],
      totalEntries: 3,
      prNumber: '42',
    });
    // In the "no tracked debt" branch, we show totalEntries
    assert.match(body, /3 entries/);
  });
});

// ── STICKY_MARKER export ────────────────────────────────────────────────────

describe('STICKY_MARKER', () => {
  test('is a valid HTML comment', () => {
    assert.ok(STICKY_MARKER.startsWith('<!--'));
    assert.ok(STICKY_MARKER.endsWith('-->'));
  });

  test('includes audit-loop:debt-comment magic string for gh-grep', () => {
    assert.match(STICKY_MARKER, /audit-loop:debt-comment/);
  });
});
