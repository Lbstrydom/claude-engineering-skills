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

// ── Gaps found by mutation testing (2026-08-10) ─────────────────────────────
//
// `npm run mutation -- --target quickfix-policy` scored 67.9% with 18
// survivors. The most telling: `n < 0` -> `n <= 0` and `n > 1` -> `n >= 1`
// BOTH survived, which means the exact boundaries of the documented [0,1]
// inclusive range were never tested — the two values most likely to be got
// wrong were the two nobody asserted.

describe('parseValidatedThreshold — the boundaries of the documented [0,1] range', () => {
  it('ACCEPTS 0 — the range is inclusive, and a mutant making it exclusive survived', () => {
    assert.equal(parseValidatedThreshold('0', 0.2), 0);
  });

  it('ACCEPTS 1 — likewise the upper bound', () => {
    assert.equal(parseValidatedThreshold('1', 0.2), 1);
  });

  it('rejects just outside the range on both sides', () => {
    assert.equal(parseValidatedThreshold('-0.0001', 0.2), 0.2);
    assert.equal(parseValidatedThreshold('1.0001', 0.2), 0.2);
  });

  it('returns the fallback for undefined WITHOUT touching the value', () => {
    // `raw === undefined -> return fallback` could be deleted entirely and
    // nothing noticed, because no test passed undefined.
    assert.equal(parseValidatedThreshold(undefined, 0.42), 0.42);
  });

  it('does not crash on a non-string input', () => {
    // `typeof raw === 'string' ? raw.trim() : raw` mutated to always-trim and
    // survived — nothing passed a value without .trim(). A number reaching
    // this from a programmatic caller would have thrown.
    assert.doesNotThrow(() => parseValidatedThreshold(0.5, 0.2));
    assert.equal(parseValidatedThreshold(0.5, 0.2), 0.5);
  });

  it('warns on a blank value, naming the variable and the default used', () => {
    // The warning IS the contract — it is the only signal an operator gets
    // that their configured value was discarded. Emptying it left every test
    // green.
    const original = process.stderr.write;
    let out = '';
    process.stderr.write = (c) => { out += c; return true; };
    try { parseValidatedThreshold('   ', 0.2); } finally { process.stderr.write = original; }
    assert.match(out, /LEARNING_QUICKFIX_SKIP_THRESHOLD/);
    assert.match(out, /blank/);
    assert.match(out, /0\.2/, 'the default actually used must appear, or the operator cannot tell what ran');
  });

  it('warns on an invalid value, echoing what was supplied', () => {
    const original = process.stderr.write;
    let out = '';
    process.stderr.write = (c) => { out += c; return true; };
    try { parseValidatedThreshold('0.2junk', 0.2); } finally { process.stderr.write = original; }
    assert.match(out, /0\.2junk/, 'echoing the bad input is how the operator finds the typo');
    assert.match(out, /\[0,1\]/);
  });
});

describe('parseValidatedMinHits — boundaries and warnings', () => {
  it('ACCEPTS 1 — the documented minimum', () => {
    assert.equal(parseValidatedMinHits('1', 10), 1);
  });

  it('rejects 0 and negatives, which would defeat the policy intent', () => {
    assert.equal(parseValidatedMinHits('0', 10), 10);
    assert.equal(parseValidatedMinHits('-1', 10), 10);
  });

  it('returns the fallback for undefined', () => {
    assert.equal(parseValidatedMinHits(undefined, 7), 7);
  });

  it('does not crash on a non-string input', () => {
    assert.equal(parseValidatedMinHits(5, 10), 5);
  });

  it('warns on a blank value and on an invalid one, naming the variable', () => {
    for (const [input, needle] of [['   ', /blank/], ['1.5', /1\.5/]]) {
      const original = process.stderr.write;
      let out = '';
      process.stderr.write = (c) => { out += c; return true; };
      try { parseValidatedMinHits(input, 10); } finally { process.stderr.write = original; }
      assert.match(out, /LEARNING_QUICKFIX_MIN_HITS/);
      assert.match(out, needle);
    }
  });
});
