import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { stratifiedSelectKDs } from '../scripts/model-eval-auditor.mjs';

const FIXTURE_DEFECTS = [
  { id: 'KD-001', severity: 'HIGH', repo: 'r1' },
  { id: 'KD-002', severity: 'HIGH', repo: 'r1' },
  { id: 'KD-003', severity: 'MEDIUM', repo: 'r2' },
  { id: 'KD-004', severity: 'MEDIUM', repo: 'r1' },
  { id: 'KD-005', severity: 'LOW', repo: 'r3' },
  { id: 'KD-006', severity: 'HIGH', repo: 'r2' },
];

describe('model-eval-auditor.mjs — stratifiedSelectKDs', () => {
  test('deterministic: the same seed + n always yields the same subset', () => {
    const a = stratifiedSelectKDs(FIXTURE_DEFECTS, { seed: 12345, n: 4 });
    const b = stratifiedSelectKDs(FIXTURE_DEFECTS, { seed: 12345, n: 4 });
    assert.deepEqual(a.map((d) => d.id), b.map((d) => d.id));
  });

  test('a different seed can yield a different subset/order', () => {
    const a = stratifiedSelectKDs(FIXTURE_DEFECTS, { seed: 1, n: 4 });
    const b = stratifiedSelectKDs(FIXTURE_DEFECTS, { seed: 2, n: 4 });
    // Not a hard guarantee for every possible seed pair, but true for these two.
    assert.notDeepEqual(a.map((d) => d.id), b.map((d) => d.id));
  });

  test('spreads selection across severity groups rather than exhausting the largest first', () => {
    const selected = stratifiedSelectKDs(FIXTURE_DEFECTS, { seed: 42, n: 3 });
    const severities = new Set(selected.map((d) => d.severity));
    // 3 distinct severities exist (HIGH/MEDIUM/LOW) — round-robin across
    // groups means picking 3 should touch more than one severity, not just
    // the largest (HIGH, which has 3 members and could satisfy n=3 alone).
    assert.ok(severities.size > 1, `expected >1 severity in the first 3 picks, got ${[...severities]}`);
  });

  test('never returns more than n, and never duplicates', () => {
    const selected = stratifiedSelectKDs(FIXTURE_DEFECTS, { seed: 7, n: 5 });
    assert.equal(selected.length, 5);
    assert.equal(new Set(selected.map((d) => d.id)).size, 5);
  });

  test('requesting more than available returns everything, no crash', () => {
    const selected = stratifiedSelectKDs(FIXTURE_DEFECTS, { seed: 7, n: 100 });
    assert.equal(selected.length, FIXTURE_DEFECTS.length);
  });

  test('an entry with no severity field is grouped under UNKNOWN, not dropped', () => {
    const withUnknown = [...FIXTURE_DEFECTS, { id: 'KD-007', repo: 'r4' }];
    const selected = stratifiedSelectKDs(withUnknown, { seed: 1, n: withUnknown.length });
    assert.ok(selected.some((d) => d.id === 'KD-007'));
  });
});

describe('model-eval-auditor.mjs — CLI preflight', () => {
  test('--selfcheck-relocation exits 0 and prints OK', () => {
    const out = execFileSync('node', ['scripts/model-eval-auditor.mjs', '--selfcheck-relocation'], { encoding: 'utf8' });
    assert.match(out, /OK/);
  });

  test('missing --candidate exits non-zero with a usage message', () => {
    assert.throws(() => execFileSync('node', ['scripts/model-eval-auditor.mjs', '--tier', 'screen'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  test('an invalid --tier exits non-zero', () => {
    assert.throws(() => execFileSync('node', ['scripts/model-eval-auditor.mjs', '--candidate', '{"kind":"sentinel","value":"latest-gpt"}', '--tier', 'bogus'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  });
});
