/**
 * @fileoverview Pure, deterministic scoring — no I/O, no LLM calls. Consumes
 * already-extracted, already-validated structured output only.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/deterministic-scorer
 */

// text-similarity.mjs has zero dependencies (no fs, no env reads) — safe to
// import here without breaking this file's own "no I/O" guarantee (unlike
// importing jaccardSimilarity from ledger.mjs directly, which transitively
// reads the shared cloud config env at module-load time).
import { jaccardSimilarity } from '../text-similarity.mjs';

/**
 * Adjudicator T/F extraction scoring — confusion matrix + derived metrics.
 * @param {Array<'true_positive'|'false_positive'>} candidatePredictions
 * @param {Array<'true_positive'|'false_positive'>} groundTruthLabels
 */
const BINARY_LABELS = Object.freeze(['true_positive', 'false_positive']);

export function scoreBinaryClassification(candidatePredictions, groundTruthLabels) {
  if (candidatePredictions.length !== groundTruthLabels.length) {
    throw new Error('scoreBinaryClassification: predictions and labels must be the same length');
  }
  // Round-6 audit M1 fix — an unrecognized label (typo, null, a future third
  // classification the caller forgot to update this scorer for) must fail
  // loud, never be silently coerced to "not true_positive" and counted as a
  // correct negative — that would let bad extraction data score as accurate.
  for (let i = 0; i < candidatePredictions.length; i++) {
    if (!BINARY_LABELS.includes(candidatePredictions[i])) {
      throw new Error(`scoreBinaryClassification: candidatePredictions[${i}] is not a recognized label ("${candidatePredictions[i]}") — expected one of ${BINARY_LABELS.join(', ')}`);
    }
    if (!BINARY_LABELS.includes(groundTruthLabels[i])) {
      throw new Error(`scoreBinaryClassification: groundTruthLabels[${i}] is not a recognized label ("${groundTruthLabels[i]}") — expected one of ${BINARY_LABELS.join(', ')}`);
    }
  }
  let truePositives = 0, falsePositives = 0, trueNegatives = 0, falseNegatives = 0;
  for (let i = 0; i < candidatePredictions.length; i++) {
    const pred = candidatePredictions[i] === 'true_positive';
    const actual = groundTruthLabels[i] === 'true_positive';
    if (pred && actual) truePositives++;
    else if (pred && !actual) falsePositives++;
    else if (!pred && actual) falseNegatives++;
    else trueNegatives++;
  }
  const precision = (truePositives + falsePositives) > 0 ? truePositives / (truePositives + falsePositives) : null;
  const recall = (truePositives + falseNegatives) > 0 ? truePositives / (truePositives + falseNegatives) : null;
  const f1 = precision != null && recall != null && (precision + recall) > 0
    ? (2 * precision * recall) / (precision + recall) : null;
  const total = candidatePredictions.length;
  const accuracy = total > 0 ? (truePositives + trueNegatives) / total : null;
  // Implementation H5 fix: verdict.mjs's threshold checks read falsePositiveRate
  // directly — it must come from the scorer, never default to 0 downstream.
  const falsePositiveRate = (falsePositives + trueNegatives) > 0 ? falsePositives / (falsePositives + trueNegatives) : null;
  return { truePositives, falsePositives, trueNegatives, falseNegatives, precision, recall, f1, accuracy, falsePositiveRate };
}

// Committed, versioned normalization+threshold algorithm — constants named
// here, not implicit.
//
// V1 (Levenshtein ratio, threshold 0.6) is RETIRED — round-15 empirical-verify
// finding: it compared two independently-worded English sentences (the
// model's free-text description vs. the curator's deliberately generic
// expectedFindingRubric) via character-edit-distance, which cannot recognize
// a semantically-correct paraphrase. V2 uses jaccardSimilarity (token-set
// overlap) instead, with a threshold recalibrated for that metric's value
// range — empirically, real correct-vs-incorrect pairs cluster around
// ~0.23-0.26 vs ~0.04-0.09, so 0.15 cleanly separates them with margin on
// both sides (still a v0.1-style bootstrap calibration — recalibrate after
// enough real promotion-tier runs accumulate, per auditor-thresholds.json's
// own calibration discipline).
export const FUZZY_CONFIG_V2 = Object.freeze({
  version: 2,
  similarityMetric: 'jaccard',
  similarityThreshold: 0.15,
});

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).pop();
}

// Bounding candidate/expected string length remains worthwhile even though
// jaccardSimilarity's tokenize+set-overlap cost is O(n), not the old
// O(len×len) Levenshtein DP matrix — an unbounded model-output description
// is still an unnecessary cost/DoS surface at this boundary.
//
// Round-13 audit M2/M7 fix — round-11's M3 fix bounded the CANDIDATE side's
// description length at the extraction schema (structured-extractor.mjs),
// but the EXPECTED side (corpus rubric text, file lists) has no equivalent
// cap anywhere yet (its schema is Cluster B's known-defect-corpus.mjs, not
// built), and MAX_SCORING_ITEMS (round-12 M8) bounds item COUNT, not
// per-item string length. Bound at the algorithm boundary itself so the
// cost is capped regardless of which side (or future caller) an oversized
// string comes from.
const MAX_MATCH_STRING_LEN = 2000;

/**
 * Basenames that cannot identify a file unambiguously (62d7faf3cd80 fix).
 *
 * Measured per SIDE, never across the union of both — that distinction is
 * load-bearing. A MOVED file is `src/old/thing.js` in the rubric and
 * `src/new/thing.js` in the candidate: two distinct paths sharing a basename,
 * so a union-scoped test would call it ambiguous and delete exactly the edge
 * the basename fallback exists to create. Per-side, it is unambiguous on both
 * and the fallback still works.
 *
 * @returns {{candidates: Set<string>, rubrics: Set<string>}} basenames appearing
 *   in >=2 distinct candidate files / in the `files` of >=2 distinct rubrics.
 */
function ambiguousBasenames(candidateOutputs, expectedRubrics) {
  const collect = (groups) => {
    const byBasename = new Map();
    groups.forEach((paths, groupIndex) => {
      for (const p of new Set(paths)) {
        const b = basename(p);
        if (!byBasename.has(b)) byBasename.set(b, new Set());
        byBasename.get(b).add(groupIndex);
      }
    });
    const ambiguous = new Set();
    for (const [b, groupIndexes] of byBasename) if (groupIndexes.size > 1) ambiguous.add(b);
    return ambiguous;
  };
  return {
    // Audit R2 M4 — this grouped by CANDIDATE (`candidateOutputs.map(c =>
    // [c.file])`), so two findings reported against the SAME file became two
    // groups and their shared basename was called ambiguous — suppressing a
    // perfectly unambiguous edge, which is the opposite of the intent stated
    // one line above it. Group by DISTINCT FILE: two outputs on one file are
    // one group, two files sharing a basename are two.
    // Audit R3 M3 — the two sides were measured asymmetrically: candidates by
    // distinct FILE, rubrics by rubric INDEX, so two rubrics naming the SAME
    // path counted as two collisions. Ambiguity is a property of files ("does
    // this basename identify one file?"), not of how many rubrics mention one,
    // so both sides now group by distinct path.
    candidates: collect([...new Set(candidateOutputs.map((c) => c.file))].map((f) => [f])),
    rubrics: collect([...new Set(expectedRubrics.flatMap((e) => e.files || []))].map((f) => [f])),
  };
}

/**
 * @returns {{score: number, pathClass: 0|1}|null} — `pathClass` 0 = full-path
 *   match, 1 = basename-only. null when the pair is not an eligible edge.
 */
function matchScore(candidate, expected, matchMode, fuzzyConfig, ambiguous) {
  const files = expected.files || [];
  const exactFileMatch = files.some((f) => f === candidate.file);
  let pathClass = 0;
  if (!exactFileMatch) {
    // 62d7faf3cd80 fix — the basename fallback used to rank EQUAL to a
    // full-path match, so `src/a/config.js` and `src/b/config.js` were
    // interchangeable and a candidate naming the WRONG file could be credited.
    // Ordering was the wrong lever (it only decides which ambiguous edge wins);
    // the fix is that an ambiguous basename yields NO edge at all, so a
    // wrong-file credit is unconstructable rather than deprioritised. The
    // correct candidate still matches by exact path.
    const cb = basename(candidate.file);
    const eligible = !ambiguous.candidates.has(cb)
      && !ambiguous.rubrics.has(cb)
      && files.some((f) => basename(f) === cb);
    if (!eligible) return null;
    pathClass = 1;
  }
  const normCandidate = normalize(candidate.description);
  const normExpected = normalize(expected.expectedFindingRubric);
  // Round-14 audit H4 fix — the round-13 fix SLICED both strings to
  // MAX_MATCH_STRING_LEN before comparing, which corrupts the comparison
  // itself: two genuinely DIFFERENT findings sharing an identical 2000-char
  // prefix would score as identical in exact mode (and artificially inflate
  // fuzzy similarity too, since truncating to a shared prefix hides any
  // divergence past the cutoff). Bounding cost must not silently change
  // WHAT is being compared — an oversized string is a non-match (fails
  // preflight), never a truncated-and-compared one.
  if (normCandidate.length > MAX_MATCH_STRING_LEN || normExpected.length > MAX_MATCH_STRING_LEN) return null;
  // Round-9 audit H6 fix — normalize() reduces a missing/whitespace-only
  // description to '', and an empty-vs-empty comparison scores as "perfect"
  // under both exact (string equality) and fuzzy (jaccardSimilarity('','')
  // would otherwise need a special case) matching, so an empty candidate
  // capture against an empty expected rubric scored a "perfect" match — the
  // exact "empty capture reads clean" anti-pattern this repo's doctrine
  // repeatedly guards against. A vacuous comparison is a NON-match, not a
  // perfect one.
  if (normCandidate.length === 0 || normExpected.length === 0) return null;
  const descScore = matchMode === 'exact'
    ? (normCandidate === normExpected ? 1 : 0)
    : jaccardSimilarity(normCandidate, normExpected);
  const threshold = matchMode === 'exact' ? 1 : fuzzyConfig.similarityThreshold;
  return descScore >= threshold ? { score: descScore, pathClass } : null;
}

/**
 * Auditor Tier-C defect-localization scoring. Set-based greedy matching by
 * best fuzzy score (implementation M12/M8 fix — order-independent, no
 * positional i-to-i comparison), and unmatched candidate outputs are counted
 * as `extraCount` (implementation H9 fix — a candidate that reports every
 * expected defect plus many hallucinated ones no longer scores as if noise
 * were free; `precision` exposes it for callers to gate on).
 * @param {Array<{file: string, description: string}>} candidateOutputs
 * @param {Array<{files: string[], expectedFindingRubric: string}>} expectedRubrics
 * @param {{matchMode?: 'exact'|'fuzzy', fuzzyConfig?: object}} [opts]
 */
export function scoreDefectLocalization(candidateOutputs, expectedRubrics, { matchMode = 'fuzzy', fuzzyConfig = FUZZY_CONFIG_V2 } = {}) {
  // Round-9 audit M2 fix — matchMode/fuzzyConfig were trusted without
  // validation; matchScore()'s own check is `matchMode === 'exact' ? ... :
  // fuzzy`, so ANY unrecognized value (a typo like 'eaxct') silently fell
  // through to fuzzy — weakening an intended exact-match gate instead of
  // failing loud. similarityThreshold is likewise a bare number with
  // no bounds check.
  if (matchMode !== 'exact' && matchMode !== 'fuzzy') {
    throw new Error(`scoreDefectLocalization: matchMode must be "exact" or "fuzzy", got "${matchMode}"`);
  }
  // Round-13 audit L1 fix — exact mode never reads fuzzyConfig at all
  // (matchScore's threshold is hardcoded to 1 for exact mode); validating
  // it unconditionally rejected a caller who passed matchMode:'exact' with
  // no fuzzy settings, or an explicitly-empty fuzzyConfig, even though
  // nothing would have used it.
  if (matchMode === 'fuzzy') {
    const threshold = fuzzyConfig?.similarityThreshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error(`scoreDefectLocalization: fuzzyConfig.similarityThreshold must be a finite number in [0,1], got ${threshold}`);
    }
  }
  // Round-12 audit M8 fix — the round-11 M3 fix bounded per-STRING length at
  // the extraction schema (structured-extractor.mjs), but this exported
  // scorer is a reusable boundary in its own right and still accepted
  // unbounded ARRAY lengths; the O(candidates×rubrics) outer loop compounds
  // with each pairing's matching cost. Cap at the algorithm's own
  // boundary too, not just the one source path that happens to call it today.
  const MAX_SCORING_ITEMS = 500;
  if (candidateOutputs.length > MAX_SCORING_ITEMS || expectedRubrics.length > MAX_SCORING_ITEMS) {
    throw new Error(`scoreDefectLocalization: candidateOutputs/expectedRubrics must each be <= ${MAX_SCORING_ITEMS} items (got ${candidateOutputs.length}/${expectedRubrics.length})`);
  }
  // Round-14 audit H5 fix — bounding EACH dimension independently still
  // allows the worst case: 500×500 = 250,000 pairs, and every pair that
  // shares a file (matchScore's fast pre-filter) runs a bounded-but-still-
  // real matching cost. A pathological corpus where every entry shares one
  // file (all fileMatch checks pass) hits the full pair count. Bound the
  // TOTAL pair count directly, tighter than the product of two generous
  // per-dimension ceilings.
  const MAX_SCORING_PAIRS = 20_000;
  if (candidateOutputs.length * expectedRubrics.length > MAX_SCORING_PAIRS) {
    throw new Error(`scoreDefectLocalization: candidateOutputs.length × expectedRubrics.length must be <= ${MAX_SCORING_PAIRS} (got ${candidateOutputs.length * expectedRubrics.length})`);
  }
  // Round-14 audit M9 fix — matchScore() does `(expected.files || [])
  // .some(...)`; a malformed expected.files that's truthy-but-not-an-array
  // (e.g. a string) throws an unstructured TypeError from deep inside the
  // matching loop instead of a clean validation error at the scorer boundary.
  for (const [i, e] of expectedRubrics.entries()) {
    if (e.files !== undefined && !Array.isArray(e.files)) {
      throw new Error(`scoreDefectLocalization: expectedRubrics[${i}].files must be an array when present`);
    }
  }
  // 62d7faf3cd80 fix — this was a per-expected greedy loop: it walked
  // expectedRubrics in ARRAY ORDER and let each take its best still-unused
  // candidate. An early rubric could consume a candidate a later rubric matched
  // far better, so `correct` (and every metric derived from it) depended on
  // rubric ordering and could be strictly below the achievable match count.
  //
  // Replaced with a maximum-cardinality bipartite matching (Kuhn's augmenting
  // paths). Maximum cardinality is a property of the GRAPH, so `correct` is now
  // invariant under permutation of either input array — the guarantee the
  // greedy loop never had. Note the eligible-edge graph must be built AFTER the
  // MAX_SCORING_ITEMS/MAX_SCORING_PAIRS preconditions above, which is what
  // keeps those bounds gating edge materialization and not merely the loop.
  //
  // Deliberately NOT a min-cost / max-weight assignment: weight reaches no
  // output. `correct`, `precision`, `recall`, `f1` and `extraCount` are all
  // functions of the match COUNT, so a solver optimizing which equally-maximal
  // matching is chosen would buy nothing a caller can observe.
  const ambiguous = ambiguousBasenames(candidateOutputs, expectedRubrics);
  // adjacency[i] = eligible candidates for rubric i, in a deterministic order:
  // full-path before basename-only, then higher score, then lower index. Same
  // input => same assignment, every run.
  const adjacency = expectedRubrics.map((expected) => candidateOutputs
    .map((c, j) => {
      const m = matchScore(c, expected, matchMode, fuzzyConfig, ambiguous);
      return m == null ? null : { j, score: m.score, pathClass: m.pathClass };
    })
    .filter((e) => e != null)
    .sort((a, b) => a.pathClass - b.pathClass || b.score - a.score || a.j - b.j));

  const candidateToRubric = new Array(candidateOutputs.length).fill(-1);
  const rubricToCandidate = new Array(expectedRubrics.length).fill(-1);
  const tryAugment = (i, visited) => {
    for (const edge of adjacency[i]) {
      if (visited[edge.j]) continue;
      visited[edge.j] = true;
      if (candidateToRubric[edge.j] === -1 || tryAugment(candidateToRubric[edge.j], visited)) {
        candidateToRubric[edge.j] = i;
        rubricToCandidate[i] = edge.j;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < expectedRubrics.length; i++) {
    if (adjacency[i].length > 0) tryAugment(i, new Array(candidateOutputs.length).fill(false));
  }

  const correct = rubricToCandidate.reduce((n, j) => n + (j !== -1 ? 1 : 0), 0);
  const mismatches = [];
  for (let i = 0; i < expectedRubrics.length; i++) {
    if (rubricToCandidate[i] !== -1) continue;
    // Gemini gate R1 fix — an unmatched rubric used to report a flat
    // 'no-matching-candidate-output', conflating two very different facts.
    // Among equally-maximal matchings, WHICH rubric goes unmatched can differ,
    // so a rubric whose candidates were all claimed by other rubrics was being
    // reported to a human as a defect the model MISSED, when the model had in
    // fact reported it. Name the contention instead of hiding it behind an
    // arbitration.
    mismatches.push({
      index: i,
      reason: adjacency[i].length === 0 ? 'no-matching-candidate-output' : 'candidate-consumed-by-another-rubric',
    });
  }

  const total = expectedRubrics.length;
  const extraCount = candidateOutputs.length - correct;
  const precision = (correct + extraCount) > 0 ? correct / (correct + extraCount) : null;
  const recall = total > 0 ? correct / total : null;
  const f1 = precision != null && recall != null && (precision + recall) > 0
    ? (2 * precision * recall) / (precision + recall) : null;
  // Implementation H4 fix — verdict.mjs's oracle-mode auditor thresholds
  // (auditor-thresholds.json) read canonical `recall`/`falsePositiveRate`/`f1`
  // keys; the scorer previously only returned `accuracy`/`precision`, a
  // cross-file contract mismatch. `recall` === `accuracy` for this scorer
  // (both are correct/total); `falsePositiveRate` is the extra/hallucinated
  // share of all candidate outputs (extraCount / (correct + extraCount) —
  // the complement of precision).
  const falsePositiveRate = (correct + extraCount) > 0 ? extraCount / (correct + extraCount) : null;
  return { correct, total, extraCount, accuracy: recall, precision, recall, f1, falsePositiveRate, mismatches };
}
