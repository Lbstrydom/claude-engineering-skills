/**
 * The durable reopen record must carry WHY a finding reopened.
 *
 * Regression pin for a 2026-08-14 write-side defect. `recordSuppressionEvents`
 * wrote `reason: 'Scope changed'` — a hardcoded literal, identical for every
 * reopened finding. `suppression_events` is the only place a reopen survives
 * the run (the round summary goes to stderr and the result JSON, both per-run
 * and gitignored), so the store could not distinguish:
 *
 *   - a model-declared reopen that cited a changed line invalidating the ruling
 *   - a purely mechanical file-touch reopen of a dismissal the operator had
 *     already disproved (the cluster-A churn shape)
 *
 * A constant in a telemetry column reads as a measurement while carrying no
 * information — the same class as a hardcoded 0. The reopen-policy decision
 * this signal feeds is docs/plans/dismissed-fp-reopen-policy.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reopenReason } from '../scripts/lib/store/runs-findings.mjs';
import { suppressReRaises } from '../scripts/lib/ledger.mjs';

describe('reopenReason — the distinction the column used to throw away', () => {
  test('a mechanical reopen of a dismissal is distinguishable from a declared one', () => {
    const mechanical = reopenReason({ _reopenDeclared: false, _matchedOutcome: 'dismissed' });
    const declared = reopenReason({ _reopenDeclared: true, _matchedOutcome: 'dismissed' });
    assert.notEqual(mechanical, declared, 'the two must not collapse to one string');
    assert.match(mechanical, /declared=no/);
    assert.match(declared, /declared=yes/);
    assert.match(mechanical, /matched=dismissed/);
  });

  test('keeps the historical prefix so an existing query still matches', () => {
    assert.match(reopenReason({ _reopenDeclared: false, _matchedOutcome: 'dismissed' }), /^Scope changed/);
  });

  test('a finding from an older bundle reports unknown, never dismissed', () => {
    // Absent `_matchedOutcome` must not be read as `dismissed` — that would
    // inflate the very churn count this string exists to measure.
    const stale = reopenReason({});
    assert.match(stale, /matched=unknown/);
    assert.doesNotMatch(stale, /matched=dismissed/);
  });

  test('a reopen on a FIXED entry is not counted as dismissal churn', () => {
    // Reopen-on-touch is correct regression detection for a `fixed` entry; only
    // the `dismissed` variant is the re-litigation this measures.
    assert.match(reopenReason({ _reopenDeclared: false, _matchedOutcome: 'fixed' }), /matched=fixed/);
  });
});

describe('reopenReason — end-to-end against real suppressReRaises output', () => {
  // Derived from the matcher's own output rather than a hand-written object:
  // a factory built from what the WRITER expects would encode the assumption
  // under test.
  const ledger = {
    version: 1,
    entries: [{
      topicId: 'aaaaaaaaaaaa',
      pass: 'Adjacency',
      category: '[Adjacency] Statement may be trapped inside a conditional',
      section: 'scripts/gemini-review.mjs',
      detailSnapshot: 'scripts/gemini-review.mjs:1193 sits inside the if at scripts/gemini-review.mjs:1186, '
        + 'but reads nothing declared in that branch and nothing its condition tests.',
      affectedFiles: ['scripts/gemini-review.mjs'],
      adjudicationOutcome: 'dismissed',
      remediationState: 'pending',
      ruling: 'overrule',
      source: 'session',
    }],
  };
  const finding = (extra = {}) => ({
    category: '[Adjacency] Statement may be trapped inside a conditional',
    section: 'scripts/gemini-review.mjs',
    detail: 'scripts/gemini-review.mjs:1193 sits inside the if at scripts/gemini-review.mjs:1186, '
      + 'but reads nothing declared in that branch and nothing its condition tests. '
      + 'codePaths is consumed after the branch.',
    _pass: 'Adjacency',
    _primaryFile: 'scripts/gemini-review.mjs',
    _hash: 'h1',
    ...extra,
  });

  test('the cluster-A case records as undeclared churn on a dismissal', () => {
    const r = suppressReRaises([finding()], ledger, { changedFiles: ['scripts/gemini-review.mjs'] });
    assert.equal(r.reopened.length, 1, 'precondition: the real matcher reopens this');
    assert.equal(reopenReason(r.reopened[0]), 'Scope changed; declared=no; matched=dismissed');
  });

  test('the same case with a model declaration records differently', () => {
    const r = suppressReRaises([finding({ is_reopened: true })], ledger, {
      changedFiles: ['scripts/gemini-review.mjs'],
    });
    assert.equal(reopenReason(r.reopened[0]), 'Scope changed; declared=yes; matched=dismissed');
  });
});
