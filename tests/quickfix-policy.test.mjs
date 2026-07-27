/**
 * @fileoverview Regression tests for `scripts/lib/quickfix-policy.mjs`
 * (docs/plans/refactor-failure-contract.md, Phase 1). Both validators are
 * pure and exercised directly with plain values — no env-var mutation or
 * child-process spawning needed here (that's `quickfix-patterns.test.mjs`'s
 * migration-regression test, which asserts the module actually IMPORTS
 * these functions rather than re-implementing parsing locally).
 *
 * Deliberately placed at `scripts/lib/quickfix-policy.mjs` — a domain-
 * neutral sibling location, not under `scripts/lib/learning/` — so neither
 * of its two real consumers (`learning-store`'s quickfix-stats.mjs,
 * `claude-hooks`'s quickfix-patterns.mjs) appears to "own" a module the
 * other depends on (code-audit round-1 finding 7eb839d1, compromise).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseValidatedThreshold, parseValidatedMinHits } from '../scripts/lib/quickfix-policy.mjs';

describe('parseValidatedThreshold', () => {
  it('rejects a partial numeric parse ("0.2junk") — the actual bug parseFloat had', () => {
    assert.equal(parseValidatedThreshold('0.2junk', 0.20), 0.20);
  });
  it('accepts a valid override', () => {
    assert.equal(parseValidatedThreshold('0.5', 0.20), 0.5);
  });
  it('rejects an out-of-range value (> 1)', () => {
    assert.equal(parseValidatedThreshold('1.5', 0.20), 0.20);
  });
  it('rejects an out-of-range value (< 0)', () => {
    assert.equal(parseValidatedThreshold('-0.1', 0.20), 0.20);
  });
  it('an unset env var silently falls back (not a warning-worthy event)', () => {
    assert.equal(parseValidatedThreshold(undefined, 0.20), 0.20);
  });
  it('rejects a blank string — round-1 finding H2 (Number("") is 0, a real accepted value, not "unset")', () => {
    assert.equal(parseValidatedThreshold('', 0.20), 0.20);
  });
  it('rejects a whitespace-only string — same H2 lock', () => {
    assert.equal(parseValidatedThreshold('   ', 0.20), 0.20);
  });
});

describe('parseValidatedMinHits', () => {
  it('rejects a non-integer ("1.5") rather than truncating it the way parseInt did', () => {
    assert.equal(parseValidatedMinHits('1.5', 10), 10);
  });
  it('rejects zero — defeats "single-digit hits never trigger a skip"', () => {
    assert.equal(parseValidatedMinHits('0', 10), 10);
  });
  it('rejects a negative value', () => {
    assert.equal(parseValidatedMinHits('-3', 10), 10);
  });
  it('accepts a valid override', () => {
    assert.equal(parseValidatedMinHits('25', 10), 25);
  });
  it('rejects a blank string — same H2 lock as the threshold validator', () => {
    assert.equal(parseValidatedMinHits('', 10), 10);
  });
});
