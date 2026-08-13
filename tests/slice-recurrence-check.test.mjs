/**
 * @fileoverview Tier 1 unit tests for `decideVerdict` — the ordering contract of
 * the one-shot god-module slice-1 recurrence check.
 *
 * **The ordering IS the contract.** Both `unknown` arms are evaluated before the
 * green arm, so a window that measured nothing can never fall through to
 * "stopped". Without that, `newFindings === 0` reads as success on a repo where
 * nobody ran an audit — the precise false-green this repo has already been
 * burned by (a tiered-recall shadow window read "met" while every run was a
 * silent fallback). Verified live on 2026-08-13: 24 pass runs, 0 new findings,
 * and the check still returned `unknown`.
 *
 * Retires with `scripts/slice-recurrence-check.mjs` — delete this file when that
 * check reports a non-`unknown` verdict and is removed. See that script's header
 * for the full retirement predicate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { decideVerdict } = await import('../scripts/slice-recurrence-check.mjs');

describe('slice-recurrence decideVerdict — a window that measured nothing is never green', () => {
  it('no qualifying pass run at all → unknown, not stopped', () => {
    const v = decideVerdict({ passRuns: 0, passRunsWithTokens: 0, newFindings: 0 });
    assert.equal(v.verdict, 'unknown');
    assert.match(v.action, /Do NOT read this as/);
  });

  it('pass runs happened but none recorded bouncer tokens → unknown (no positive control)', () => {
    // The live reading on the day the check shipped. `newFindings: 0` here is
    // the trap: it is the same value a genuine "stopped" carries.
    const v = decideVerdict({ passRuns: 24, passRunsWithTokens: 0, newFindings: 0 });
    assert.equal(v.verdict, 'unknown');
  });

  it('the dormant arms are checked BEFORE the green arm (the ordering, stated as a test)', () => {
    // If the green arm were reachable first, both of these would read 'stopped'
    // because newFindings is 0 in each.
    for (const m of [{ passRuns: 0, passRunsWithTokens: 0 }, { passRuns: 5, passRunsWithTokens: 0 }]) {
      assert.equal(decideVerdict({ ...m, newFindings: 0 }).verdict, 'unknown');
    }
  });

  it('real tokens + new findings → recurring, and says the diagnosis was wrong', () => {
    const v = decideVerdict({ passRuns: 10, passRunsWithTokens: 4, newFindings: 2 });
    assert.equal(v.verdict, 'recurring');
    assert.match(v.action, /diagnosis was WRONG/);
  });

  it('real tokens + no new findings → stopped, and points slice 2 at the boundary list', () => {
    const v = decideVerdict({ passRuns: 10, passRunsWithTokens: 4, newFindings: 0 });
    assert.equal(v.verdict, 'stopped');
    assert.match(v.action, /audit-backlog-triage-hardening\.md item 5/);
  });

  it('recurring wins over stopped even when most runs looked healthy', () => {
    // Guards the other direction: a single new finding must not be drowned out
    // by a high token-carrying run count.
    assert.equal(decideVerdict({ passRuns: 100, passRunsWithTokens: 99, newFindings: 1 }).verdict, 'recurring');
  });
});
