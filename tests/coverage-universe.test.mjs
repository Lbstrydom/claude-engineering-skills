/**
 * @fileoverview The coverage DENOMINATOR must be the repo's eligible universe
 * on BOTH run modes — not the extraction scope.
 *
 * ## The defect this locks
 *
 * `extract.mjs` had one `files` variable serving two different questions:
 * "which files am I re-extracting symbols for" (restricted on an incremental
 * run) and "what is the coverage universe" (always whole-repo). Because the
 * two were conflated, incremental runs emitted NO coverage line at all, and
 * `refresh.mjs` copied the prior measurement forward as `stale` -> the verdict
 * read `unknown` -> `coverageGateExitCode` maps `unknown` to 0.
 *
 * **Measured 2026-08-09**: the last real measurement was 2026-07-27. The gate
 * had passed silently for 13 days having measured nothing, because the only
 * producer of a fresh number is a full refresh, whose sole scheduled caller is
 * a weekly GitHub workflow that runs `|| true`.
 *
 * Suppression was the RIGHT call for the code as it stood — a whole-repo
 * numerator over a changed-files denominator is nonsense. But the numerator
 * was never the problem: the dependency-cruise walks `targets` (the source
 * dirs) on every run, incremental included. Only the denominator was missing.
 *
 * ## Why a pure function is the seam
 *
 * Both branches return a plausible array, so a wrong choice produces a
 * real-looking ratio rather than an error — invisible from the outside. The
 * decision is therefore extracted and asserted directly, rather than inferred
 * from a ratio that would look fine either way.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coverageUniverse, isFullRunFromFiles } from '../scripts/symbol-index/extract.mjs';

const REPO = '/repo';
const WHOLE_REPO = ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs'];
const CHANGED = ['a.mjs'];

/** Records how it was called, so "walked unrestricted" is assertable, not assumed. */
function spyEnumerate(result = WHOLE_REPO) {
  const calls = [];
  const fn = (root, restrict) => { calls.push({ root, restrict }); return result; };
  fn.calls = calls;
  return fn;
}

describe('coverageUniverse — the denominator is the repo, not the extraction scope', () => {
  it('INCREMENTAL: walks the whole repo, ignoring the restricted extraction scope', () => {
    const enumerate = spyEnumerate();
    const universe = coverageUniverse(REPO, CHANGED, CHANGED, enumerate);

    assert.deepEqual(universe, WHOLE_REPO,
      'the denominator must be the eligible universe — using the changed set would '
      + 'measure a whole-repo cruise against a handful of files');
    assert.equal(enumerate.calls.length, 1);
    assert.equal(enumerate.calls[0].restrict, null,
      'the walk must be UNRESTRICTED; passing the changed list would reproduce the bug');
  });

  it('FULL: reuses the already-enumerated list instead of walking twice', () => {
    const enumerate = spyEnumerate();
    const universe = coverageUniverse(REPO, null, WHOLE_REPO, enumerate);

    assert.deepEqual(universe, WHOLE_REPO);
    assert.equal(enumerate.calls.length, 0,
      'a full run already holds the whole repo — a second walk is identical work '
      + 'for an identical answer');
  });

  // The empty-scope case is a real one (a diff touching only docs/config) and
  // it is exactly where a truthiness check goes wrong: `[]` means "an
  // incremental run over zero files", NOT "a full run". If it were treated as
  // full, the denominator would become the empty extraction list and the ratio
  // would be computed against nothing.
  it('an EMPTY incremental scope still walks the whole repo', () => {
    const enumerate = spyEnumerate();
    const universe = coverageUniverse(REPO, [], [], enumerate);

    assert.equal(isFullRunFromFiles([]), false, 'precondition: [] is not a full run');
    assert.deepEqual(universe, WHOLE_REPO);
    assert.equal(enumerate.calls[0].restrict, null);
  });

  it('never returns the extraction scope when that scope is narrower than the repo', () => {
    const enumerate = spyEnumerate();
    const universe = coverageUniverse(REPO, CHANGED, CHANGED, enumerate);
    assert.notDeepEqual(
      universe, CHANGED,
      'returning the extraction scope is the regression — it yields a plausible ratio '
      + 'computed from the wrong universe, which no downstream check can detect',
    );
    assert.ok(universe.length > CHANGED.length);
  });

  // Vacuous-pass guard: the fixtures must actually differ, or every assertion
  // above passes for free.
  it('the fixtures distinguish the two answers', () => {
    assert.notDeepEqual(WHOLE_REPO, CHANGED,
      'if the whole-repo and changed lists were equal, these tests could not tell '
      + 'a correct denominator from the bug');
  });
});
