/**
 * @fileoverview Tier-1 tests for `scripts/symbol-index/refresh-subprocess.mjs`'s
 * 8b timed-out-full recovery decision — extracted from `refresh.mjs`
 * (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md Phase 5).
 *
 * This is the DIRECT regression lock for the round-2 `recoveredTouchedSet`
 * contract bug (the plan's round-1 wiring-table draft specified an
 * UNCONDITIONAL `touchedSet` destructure that would have silently discarded
 * a valid step-6 value on the ordinary incremental path; caught in round 2
 * and fixed to a conditional rebind — see refresh.mjs's own comment at its
 * call site).
 *
 * Two tiers, reusing this repo's own established split for the identical
 * problem one layer down (tests/subprocess-idle-timeout.test.mjs's own
 * documented Tier A/Tier B split):
 *
 * - **Tier A** (below): `shouldAttemptTimeoutRecovery`/`buildTimeoutRecovery`
 *   are both pure, plain-data functions — deterministic, no DB, no
 *   subprocess, no mocking needed.
 * - **Tier B** (real end-to-end `main()` run against a disposable DB +
 *   genuinely-idle child process, proving a `recoveredTouchedSet` returned
 *   by `runExtractSummariseEmbed` is the SAME set `main()`'s copy-forward
 *   call receives): NOT implemented here. Constructing a deterministic
 *   genuinely-idle extract subprocess (rather than a real ts-morph parse,
 *   which cannot be reliably wedged on demand) proved impractical within
 *   this phase, exactly the contingency the plan's own Testing Strategy
 *   names ("if constructing a genuinely-idle child process deterministically
 *   proves impractical within Phase 5, Tier A's direct-call proof is the
 *   acceptance floor and the Tier-B gap is recorded honestly ... rather than
 *   claimed done"). Recorded here rather than silently skipped: the
 *   behavioural proof that `refresh.mjs`'s conditional rebind
 *   (`if (recoveredTouchedSet) touchedSet = recoveredTouchedSet;`) actually
 *   wires the two together stays at the level of direct source inspection,
 *   not an executed integration test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAttemptTimeoutRecovery, buildTimeoutRecovery } from '../scripts/symbol-index/refresh-subprocess.mjs';

describe('shouldAttemptTimeoutRecovery', () => {
  it('true only for {mode: "full", extractionTimedOut: true}', () => {
    assert.equal(shouldAttemptTimeoutRecovery({ mode: 'full', extractionTimedOut: true }), true);
  });

  it('false for every other combination', () => {
    assert.equal(shouldAttemptTimeoutRecovery({ mode: 'incremental', extractionTimedOut: true }), false);
    assert.equal(shouldAttemptTimeoutRecovery({ mode: 'full', extractionTimedOut: false }), false);
    assert.equal(shouldAttemptTimeoutRecovery({ mode: 'incremental', extractionTimedOut: false }), false);
  });
});

describe('buildTimeoutRecovery', () => {
  const finalSymbols = [{ filePath: 'a.js' }, { filePath: 'b.js' }, { filePath: 'a.js' }];

  it('no prior snapshot (null) → both fields null, no recovery attempted', () => {
    assert.deepEqual(
      buildTimeoutRecovery({ priorForRecovery: null, finalSymbols }),
      { timeoutRecovery: null, recoveredTouchedSet: null },
    );
  });

  it('a prior snapshot with no refreshId → still both null (nothing to recover FROM)', () => {
    assert.deepEqual(
      buildTimeoutRecovery({ priorForRecovery: { refreshId: null }, finalSymbols }),
      { timeoutRecovery: null, recoveredTouchedSet: null },
    );
  });

  it('a real prior refreshId → populated shape, recoveredTouchedSet built from finalSymbols filePaths (deduped)', () => {
    const prior = { refreshId: 'prior-run-1' };
    const result = buildTimeoutRecovery({ priorForRecovery: prior, finalSymbols });
    assert.deepEqual(result.timeoutRecovery, { prior });
    assert.ok(result.recoveredTouchedSet instanceof Set);
    assert.deepEqual([...result.recoveredTouchedSet].sort(), ['a.js', 'b.js']);
  });

  it('empty finalSymbols with a real prior → an empty (not null) recoveredTouchedSet', () => {
    const prior = { refreshId: 'prior-run-2' };
    const result = buildTimeoutRecovery({ priorForRecovery: prior, finalSymbols: [] });
    assert.ok(result.recoveredTouchedSet instanceof Set);
    assert.equal(result.recoveredTouchedSet.size, 0);
  });
});
