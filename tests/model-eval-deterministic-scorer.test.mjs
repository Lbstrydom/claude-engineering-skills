/**
 * @fileoverview `deterministic-scorer.mjs` — binary classification +
 * defect-localization scoring, incl. maximum-cardinality matching.
 *
 * Split out of `tests/model-eval-core.test.mjs` (Phase 5, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim. Two
 * source `describe` blocks (405, 752) land here per the D3 matrix.
 *
 * @module tests/model-eval-deterministic-scorer
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scoreBinaryClassification, scoreDefectLocalization } from '../scripts/lib/model-eval/deterministic-scorer.mjs';

describe('deterministic-scorer.mjs', () => {
  test('scoreBinaryClassification returns a numeric falsePositiveRate when false positives exist', () => {
    const r = scoreBinaryClassification(['true_positive', 'true_positive'], ['true_positive', 'false_positive']);
    assert.equal(typeof r.falsePositiveRate, 'number');
    assert.equal(r.falsePositiveRate, 1);
  });

  test('scoreDefectLocalization matching is order-independent', () => {
    const expected = [
      { files: ['src/a.js'], expectedFindingRubric: 'off by one in loop' },
      { files: ['src/b.js'], expectedFindingRubric: 'null pointer on empty array' },
    ];
    const forward = [
      { file: 'src/a.js', description: 'off by one in loop' },
      { file: 'src/b.js', description: 'null pointer on empty array' },
    ];
    const reversed = [...forward].reverse();
    const rf = scoreDefectLocalization(forward, expected);
    const rr = scoreDefectLocalization(reversed, expected);
    assert.equal(rf.correct, rr.correct);
    assert.equal(rf.correct, 2);
  });

  test('extra/hallucinated candidate outputs are counted, not free', () => {
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: 'off by one in loop' }];
    const candidates = [
      { file: 'src/a.js', description: 'off by one in loop' },
      { file: 'src/z.js', description: 'totally made up defect' },
      { file: 'src/y.js', description: 'another made up defect' },
    ];
    const r = scoreDefectLocalization(candidates, expected);
    assert.equal(r.extraCount, 2);
    assert.ok(r.precision < 1);
  });

  test('an empty candidate/expected description does not score a "perfect" match (round-9 H6 regression guard)', () => {
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: '' }];
    const candidates = [{ file: 'src/a.js', description: '' }];
    const r = scoreDefectLocalization(candidates, expected);
    assert.equal(r.correct, 0);
    // Same for whitespace-only, which normalize() also reduces to ''.
    const r2 = scoreDefectLocalization([{ file: 'src/a.js', description: '   ' }], [{ files: ['src/a.js'], expectedFindingRubric: '   ' }]);
    assert.equal(r2.correct, 0);
  });

  test('an unrecognized matchMode or out-of-bounds fuzzyConfig threshold throws instead of silently weakening the gate (round-9 M2 regression guard)', () => {
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: 'x' }];
    const candidates = [{ file: 'src/a.js', description: 'x' }];
    assert.throws(() => scoreDefectLocalization(candidates, expected, { matchMode: 'eaxct' }), /matchMode must be/);
    assert.throws(() => scoreDefectLocalization(candidates, expected, { fuzzyConfig: { similarityThreshold: 1.5 } }), /similarityThreshold/);
  });

  test('round-15 empirical-verify regression: a semantically-correct finding, worded DIFFERENTLY from the curator\'s expectedFindingRubric, now matches (the exact real-world failure that produced 0/4 recall on the harness\'s first live run)', () => {
    const expected = [{
      files: ['scripts/openai-audit.mjs'],
      expectedFindingRubric: 'flags a block-scoped const/let binding referenced outside its enclosing block by a later call site in the same function (undefined-binding/ReferenceError crash risk that a happy-path test run would not exercise)',
    }];
    // A real model would never reproduce the rubric's exact wording — it
    // describes the concrete code it saw, in its own words.
    const candidates = [{
      file: 'scripts/openai-audit.mjs',
      description: 'subjectFiles is declared as a const inside the A1 guard block, but the model-A/B shadow code later in the same function references subjectFiles outside that block, which throws a ReferenceError since the binding is not in scope there',
    }];
    const r = scoreDefectLocalization(candidates, expected);
    assert.equal(r.correct, 1);
  });

  test('round-15 regression: a genuinely WRONG finding (different file content, same file path) still does not match — the fix must not make matching too lenient', () => {
    const expected = [{
      files: ['scripts/openai-audit.mjs'],
      expectedFindingRubric: 'flags a block-scoped const/let binding referenced outside its enclosing block by a later call site in the same function (undefined-binding/ReferenceError crash risk that a happy-path test run would not exercise)',
    }];
    const candidates = [{
      file: 'scripts/openai-audit.mjs',
      description: 'The A1 guard counts all effective backend/frontend files regardless of which passes are enabled via --passes, which can allow a hollow audit when a requested pass resolves to zero implementation files.',
    }];
    const r = scoreDefectLocalization(candidates, expected);
    assert.equal(r.correct, 0);
  });

  test('an oversized candidateOutputs/expectedRubrics array is rejected at the algorithm boundary, not just the extraction-schema string length (round-12 M8 regression guard)', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ file: `src/f${i}.js`, description: 'x' }));
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: 'x' }];
    assert.throws(() => scoreDefectLocalization(tooMany, expected), /must each be <= 500/);
  });

  test('a malformed expectedRubrics.files (non-array) throws a clean validation error, not a raw TypeError from deep in the matching loop (round-14 M9 regression guard)', () => {
    const candidates = [{ file: 'src/a.js', description: 'x' }];
    const expected = [{ files: 'not-an-array', expectedFindingRubric: 'x' }];
    assert.throws(() => scoreDefectLocalization(candidates, expected), /expectedRubrics\[0\]\.files must be an array/);
  });

  test('an oversized expectedFindingRubric or candidate description (corpus side, not just extraction-schema-bounded output) is a NON-match, never silently truncated-and-compared (round-13 M2/M7, round-14 H4 regression guard)', () => {
    // Must not hang/crash on an oversized string, AND must not corrupt the
    // comparison by truncating-then-comparing (round-14 H4: two DIFFERENT
    // findings sharing a long identical prefix must not score as equal).
    const candidates = [{ file: 'src/a.js', description: 'x'.repeat(3000) }];
    const expectedSamePrefix = [{ files: ['src/a.js'], expectedFindingRubric: 'x'.repeat(2500) + 'DIFFERENT_SUFFIX' }];
    const r = scoreDefectLocalization(candidates, expectedSamePrefix, { matchMode: 'exact' });
    assert.equal(r.correct, 0); // oversized -> non-match, not a truncated false-positive equal
  });

  test('exact mode does not require a valid fuzzyConfig (which it never reads) (round-13 L1 regression guard)', () => {
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: 'x' }];
    const candidates = [{ file: 'src/a.js', description: 'x' }];
    assert.doesNotThrow(() => scoreDefectLocalization(candidates, expected, { matchMode: 'exact', fuzzyConfig: {} }));
    assert.doesNotThrow(() => scoreDefectLocalization(candidates, expected, { matchMode: 'exact' }));
  });

  test('an unrecognized label throws instead of being silently coerced to a negative (round-6 M1 regression guard)', () => {
    assert.throws(
      () => scoreBinaryClassification(['true_positive', 'not_a_real_label'], ['true_positive', 'false_positive']),
      /not a recognized label/,
    );
    assert.throws(
      () => scoreBinaryClassification(['true_positive', 'false_positive'], ['true_positive', null]),
      /not a recognized label/,
    );
  });
});

describe('deterministic-scorer — maximum-cardinality matching (62d7faf3cd80)', () => {
  const rubric = (files, text) => ({ files, expectedFindingRubric: text });
  const out = (file, description) => ({ file, description });

  test('a candidate is not consumed by an earlier rubric that had an alternative (the greedy defect)', () => {
    // r1 can match X or Y; r2 can match only X. The old per-expected greedy
    // walked rubrics in array order, gave X to r1, and left r2 unmatched — a
    // reported recall of 0.5 where 1.0 was achievable.
    const expected = [
      rubric(['src/x.js', 'src/y.js'], 'null pointer dereference on user input'),
      rubric(['src/x.js'], 'null pointer dereference on user input'),
    ];
    const candidates = [
      out('src/x.js', 'null pointer dereference on user input'),
      out('src/y.js', 'null pointer dereference on user input'),
    ];
    const r = scoreDefectLocalization(candidates, expected, { matchMode: 'exact' });
    assert.equal(r.correct, 2, 'both rubrics are matchable simultaneously');
    assert.equal(r.recall, 1);
    assert.equal(r.mismatches.length, 0);
  });

  test('metrics are invariant under permutation of BOTH input arrays', () => {
    const expected = [
      rubric(['src/a.js', 'src/b.js'], 'race condition in the cache write path'),
      rubric(['src/b.js'], 'race condition in the cache write path'),
      rubric(['src/c.js'], 'unbounded retry loop on a 4xx response'),
    ];
    const candidates = [
      out('src/b.js', 'race condition in the cache write path'),
      out('src/a.js', 'race condition in the cache write path'),
      out('src/c.js', 'unbounded retry loop on a 4xx response'),
    ];
    const forward = scoreDefectLocalization(candidates, expected, { matchMode: 'exact' });
    const revCandidates = scoreDefectLocalization([...candidates].reverse(), expected, { matchMode: 'exact' });
    const revExpected = scoreDefectLocalization(candidates, [...expected].reverse(), { matchMode: 'exact' });
    for (const [label, r] of [['candidates reversed', revCandidates], ['rubrics reversed', revExpected]]) {
      assert.equal(r.correct, forward.correct, `${label}: correct`);
      assert.equal(r.recall, forward.recall, `${label}: recall`);
      assert.equal(r.precision, forward.precision, `${label}: precision`);
      assert.equal(r.f1, forward.f1, `${label}: f1`);
    }
  });

  test('an ambiguous basename produces NO edge — CANDIDATE side', () => {
    const desc = 'timeout value read from the wrong key';
    // Two DISTINCT candidate files share the basename config.js and neither is
    // the rubric's path, so "which config.js did the model mean?" has no
    // answer. Pre-fix, one of them was credited arbitrarily (correct: 1).
    const r = scoreDefectLocalization(
      [out('src/a/config.js', desc), out('src/c/config.js', desc)],
      [rubric(['src/b/config.js'], desc)],
      { matchMode: 'exact' },
    );
    assert.equal(r.correct, 0, 'an ambiguous basename must not be credited to either candidate');
    assert.equal(r.mismatches[0].reason, 'no-matching-candidate-output');
  });

  test('an ambiguous basename produces NO edge — RUBRIC side', () => {
    const desc = 'timeout value read from the wrong key';
    // One candidate, at src/a/config.js. Rubric 0 names src/b/config.js
    // (basename-only) and rubric 1 names src/a/config.js (exact). Only one can
    // match. Pre-fix both were eligible and the winner was an artifact of
    // iteration order; post-fix the basename edge to rubric 0 does not exist,
    // so the candidate is credited to the rubric it actually names.
    const r = scoreDefectLocalization(
      [out('src/a/config.js', desc)],
      [rubric(['src/b/config.js'], desc), rubric(['src/a/config.js'], desc)],
      { matchMode: 'exact' },
    );
    assert.equal(r.correct, 1);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].index, 0, 'the exact-path rubric must be the one credited');
    assert.equal(r.mismatches[0].reason, 'no-matching-candidate-output');
  });

  test('two findings on the SAME file do not make its basename ambiguous (audit R2 M4)', () => {
    // Grouping by candidate index rather than by distinct file made two
    // outputs on one file look like two files sharing a basename, suppressing
    // an edge that was never ambiguous.
    const r = scoreDefectLocalization(
      [out('src/new/thing.js', 'off-by-one in the pagination offset'), out('src/new/thing.js', 'unbounded retry loop on a 4xx response')],
      [rubric(['src/old/thing.js'], 'off-by-one in the pagination offset')],
      { matchMode: 'exact' },
    );
    assert.equal(r.correct, 1, 'the moved-file basename edge must survive a second finding on the same file');
  });

  test('two rubrics naming the SAME file do not make its basename ambiguous either (audit R3 M3)', () => {
    // The rubric-side mirror of the case above: ambiguity is a property of
    // file paths, not of how many rubrics happen to mention one.
    const r = scoreDefectLocalization(
      [out('src/new/thing.js', 'off-by-one in the pagination offset')],
      [
        rubric(['src/old/thing.js'], 'off-by-one in the pagination offset'),
        rubric(['src/old/thing.js'], 'off-by-one in the pagination offset'),
      ],
      { matchMode: 'exact' },
    );
    assert.equal(r.correct, 1, 'one candidate matches one of the two identical rubrics');
    assert.equal(r.mismatches[0].reason, 'candidate-consumed-by-another-rubric');
  });

  test('an exact path still matches with a same-basename decoy present', () => {
    const desc = 'timeout value read from the wrong key';
    const r = scoreDefectLocalization(
      [out('src/a/config.js', desc), out('src/b/config.js', desc)],
      [rubric(['src/b/config.js'], desc)],
      { matchMode: 'exact' },
    );
    assert.equal(r.correct, 1, 'the decoy suppresses only BASENAME edges, never the exact-path one');
    assert.equal(r.extraCount, 1, 'the decoy counts as a hallucinated extra, not a match');
  });

  test('an UNAMBIGUOUS basename still matches — the moved-file fallback survives', () => {
    // The fallback's real use case: the rubric names the old path, the model
    // reports the new one. Measuring ambiguity across the union of both sides
    // would call this ambiguous and delete the edge.
    const r = scoreDefectLocalization(
      [out('src/new/thing.js', 'off-by-one in the pagination offset')],
      [rubric(['src/old/thing.js'], 'off-by-one in the pagination offset')],
      { matchMode: 'exact' },
    );
    assert.equal(r.correct, 1);
  });

  test('a rubric whose candidates were all claimed elsewhere is not reported as a MISS', () => {
    // Gemini gate R1: among equally-maximal matchings, which rubric goes
    // unmatched can differ — reporting the loser as 'no-matching-candidate-
    // output' tells a human the model missed a defect it actually reported.
    const r = scoreDefectLocalization(
      [out('src/shared.js', 'deadlock when two writers contend for the lock')],
      [
        rubric(['src/shared.js'], 'deadlock when two writers contend for the lock'),
        rubric(['src/shared.js'], 'deadlock when two writers contend for the lock'),
      ],
      { matchMode: 'exact' },
    );
    assert.equal(r.correct, 1, 'one candidate can only satisfy one rubric');
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].reason, 'candidate-consumed-by-another-rubric');
    // and a genuine miss still reads as one
    const miss = scoreDefectLocalization(
      [out('src/unrelated.js', 'something else entirely happening here')],
      [rubric(['src/absent.js'], 'deadlock when two writers contend for the lock')],
      { matchMode: 'exact' },
    );
    assert.equal(miss.mismatches[0].reason, 'no-matching-candidate-output');
  });

  test('matching is provably maximum + internally consistent under displacement (brute-force oracle)', () => {
    // Settles the Gemini gate's H1 concern (a reverse index left stale when an
    // augmenting path displaces an earlier assignment) by MEASURING the result
    // against an independent brute-force maximum matching, rather than by
    // reading the algorithm. Deterministic LCG — no Math.random in a test.
    let seed = 0x2f6e2b1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const DESC = 'identical description so eligibility is decided purely by file';

    // independent oracle: exhaustive maximum bipartite matching
    const bruteForceMax = (adj, nCand) => {
      const best = { n: 0 };
      const used = new Array(nCand).fill(false);
      const walk = (i, count) => {
        if (i === adj.length) { if (count > best.n) best.n = count; return; }
        walk(i + 1, count); // leave rubric i unmatched
        for (const c of adj[i]) {
          if (used[c]) continue;
          used[c] = true; walk(i + 1, count + 1); used[c] = false;
        }
      };
      walk(0, 0);
      return best.n;
    };

    for (let iter = 0; iter < 200; iter++) {
      const nCand = 1 + Math.floor(rnd() * 5);
      const nRub = 1 + Math.floor(rnd() * 5);
      const files = Array.from({ length: nCand }, (_, i) => `src/f${i}.js`);
      const candidates = files.map((f) => out(f, DESC));
      const adj = [];
      const expected = Array.from({ length: nRub }, () => {
        const picked = files.filter(() => rnd() < 0.5);
        adj.push(picked.map((f) => files.indexOf(f)));
        return rubric(picked, DESC);
      });

      const r = scoreDefectLocalization(candidates, expected, { matchMode: 'exact' });
      assert.equal(r.correct, bruteForceMax(adj, nCand), `iter ${iter}: not a maximum matching`);
      // internal consistency: every rubric is either matched or reported once
      assert.equal(r.mismatches.length, nRub - r.correct, `iter ${iter}: mismatches must account for exactly the unmatched rubrics`);
      assert.equal(new Set(r.mismatches.map((m) => m.index)).size, r.mismatches.length, `iter ${iter}: no rubric reported twice`);
      assert.equal(r.extraCount, nCand - r.correct, `iter ${iter}: extraCount must be the unclaimed candidates`);
      // a rubric with NO eligible edge can only ever be a genuine miss
      for (const m of r.mismatches) {
        if (adj[m.index].length === 0) assert.equal(m.reason, 'no-matching-candidate-output', `iter ${iter}: edgeless rubric mislabelled`);
      }
    }
  });

  test('the pair-count precondition still throws before any edge is built', () => {
    const many = Array.from({ length: 201 }, (_, i) => out(`src/f${i}.js`, `finding number ${i}`));
    const rubrics = Array.from({ length: 101 }, (_, i) => rubric([`src/f${i}.js`], `finding number ${i}`));
    assert.throws(() => scoreDefectLocalization(many, rubrics), /must be <= 20000/);
  });
});
