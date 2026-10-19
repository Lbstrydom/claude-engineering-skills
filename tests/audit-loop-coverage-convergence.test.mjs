/**
 * @fileoverview The older audit-loop driver must not print "Converged" over a round whose own `_convergence` withheld it
 * for a COVERAGE reason (upstream 57bd3de9; changed-lines-unread, 58f4e3a5, had the same hole). Pure predicates, no spawn.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.LEARNING_DISABLE = '1';
const { countFindings, isConverged } = await import('../scripts/audit-loop.mjs');

const round = (convergence, over = {}) => ({ verdict: 'PASS', findings: [], _convergence: convergence, ...over });

describe("audit-loop honours the round's coverage convergence reasons", () => {
  it('every coverage reason refuses convergence', () => {
    for (const reason of ['unrecognised-files-unreviewed', 'changed-lines-unread', 'required-subjects-not-full']) {
      const counts = countFindings(round({ converged: false, reason }));
      assert.equal(counts.coverageBlocked, true, reason);
      assert.equal(isConverged(counts), false, reason);
    }
  });
  it('controls: converged, an absent _convergence, and a non-coverage reason are unchanged', () => {
    assert.equal(isConverged(countFindings(round({ converged: true, reason: 'converged' }))), true);
    assert.equal(isConverged(countFindings(round(undefined))), true);
    const other = countFindings(round({ converged: false, reason: 'finding-thresholds' }));
    assert.equal(other.coverageBlocked, false, 'thresholds are already read from the counts');
  });
});
