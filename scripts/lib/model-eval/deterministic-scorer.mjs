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

function matchScore(candidate, expected, matchMode, fuzzyConfig) {
  const fileMatch = (expected.files || []).some((f) => f === candidate.file) // full-path match preferred
    || (expected.files || []).some((f) => basename(f) === basename(candidate.file)); // fallback, collision-prone
  if (!fileMatch) return null;
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
  return descScore >= threshold ? descScore : null;
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
  const usedCandidates = new Set();
  const mismatches = [];
  let correct = 0;

  for (let i = 0; i < expectedRubrics.length; i++) {
    const expected = expectedRubrics[i];
    let best = null, bestScore = -1;
    for (let j = 0; j < candidateOutputs.length; j++) {
      if (usedCandidates.has(j)) continue;
      const score = matchScore(candidateOutputs[j], expected, matchMode, fuzzyConfig);
      if (score != null && score > bestScore) { best = j; bestScore = score; }
    }
    if (best != null) { usedCandidates.add(best); correct++; }
    else mismatches.push({ index: i, reason: 'no-matching-candidate-output' });
  }

  const total = expectedRubrics.length;
  const extraCount = candidateOutputs.length - usedCandidates.size;
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
