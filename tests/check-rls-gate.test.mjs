/**
 * @fileoverview `check-rls --gate` blocking semantics.
 *
 * WHY THIS EXISTS: `scripts/check-rls.mjs` existed for months wired into
 * NOTHING — absent from `npm run check`, from every workflow, and from every
 * git hook. Meanwhile a consumer's only P0 of an entire security engagement
 * lived on exactly this surface (three `SECURITY DEFINER` views granted to
 * `anon`, leaking 242 rows of per-user history to anyone holding the public
 * anon key). A check nobody runs is indistinguishable from a check that
 * doesn't exist.
 *
 * Wiring it in required deciding what it blocks ON. Blocking on "any table
 * without RLS" would have made the gate cry wolf immediately — this repo has
 * one such table (`symbol_refresh_coverage`) with zero anon grants, i.e. zero
 * practical exposure. The same consumer audit made the ranking argument
 * empirically: 91 of 121 advisories were INFO-level default-deny noise while 3
 * ERROR rows were the actual breach. Rank by exploitability, not lint level —
 * a gate that cries wolf gets bypassed, and a bypassed gate protects nothing.
 *
 * These assertions pin that distinction. The decision is a pure function so it
 * can be tested without a live database.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideRlsExit } from '../scripts/check-rls.mjs';

describe('check-rls exit semantics', () => {
  describe('gate mode (--gate) — blocks on EXPLOITABLE exposure only', () => {
    it('blocks when a no-RLS table carries an anon/authenticated grant', () => {
      assert.equal(decideRlsExit({ gateMode: true, noRlsCount: 1, exposedGrantCount: 1 }), 1);
    });

    it('does NOT block on a no-RLS table with no grants (advisory, the wolf-crying case)', () => {
      // This repo's live state as of 2026-07-19: symbol_refresh_coverage.
      assert.equal(decideRlsExit({ gateMode: true, noRlsCount: 1, exposedGrantCount: 0 }), 0);
    });

    it('does not block a fully clean database', () => {
      assert.equal(decideRlsExit({ gateMode: true, noRlsCount: 0, exposedGrantCount: 0 }), 0);
    });

    it('blocks on many exposed grants', () => {
      assert.equal(decideRlsExit({ gateMode: true, noRlsCount: 3, exposedGrantCount: 9 }), 1);
    });
  });

  describe('diagnostic mode (default) — blocks on ANY missing RLS', () => {
    it('blocks on a no-RLS table even with zero grants', () => {
      // The mode difference is the whole point; if these two agreed, --gate
      // would be decorative.
      assert.equal(decideRlsExit({ gateMode: false, noRlsCount: 1, exposedGrantCount: 0 }), 1);
    });

    it('passes a fully clean database', () => {
      assert.equal(decideRlsExit({ gateMode: false, noRlsCount: 0, exposedGrantCount: 0 }), 0);
    });
  });

  it('the two modes genuinely disagree on the advisory case', () => {
    const advisory = { noRlsCount: 1, exposedGrantCount: 0 };
    assert.notEqual(
      decideRlsExit({ gateMode: true, ...advisory }),
      decideRlsExit({ gateMode: false, ...advisory }),
      'if these agree, the gate is either crying wolf or the diagnostic went blind'
    );
  });

  it('exploitable exposure blocks in BOTH modes — the gate never weakens the diagnostic', () => {
    const breach = { noRlsCount: 1, exposedGrantCount: 1 };
    assert.equal(decideRlsExit({ gateMode: true, ...breach }), 1);
    assert.equal(decideRlsExit({ gateMode: false, ...breach }), 1);
  });
});
