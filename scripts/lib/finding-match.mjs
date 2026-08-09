/**
 * @fileoverview Cross-model finding matching — the single oracle for
 * "are these two reviewers talking about the same defect?"
 *
 * ## Why this exists (measured, not assumed)
 *
 * Findings were matched by `semanticId` — sha256 over `category|section|detail`,
 * all three of which are model-authored free prose. Across the 5 collected
 * bake-off snapshots, **0 of 48** cross-model pairs matched by hash while **9**
 * named the same source file. Gemini writes
 * `"scripts/check-gate-poison-pills.mjs"`; Opus writes
 * `"scripts/check-gate-poison-pills.mjs — extractCheckGates()"`. So
 * `diffFindingBuckets`' `both` bucket was unreachable across models, `shadowOnly`
 * degenerated to "everything the shadow said", and the bake-off's headline
 * `opusUnique` measured VOLUME, not uniqueness.
 *
 * ## The three invariants this module enforces (plan §2.6)
 *
 * 1. **File comparison is set-membership, never positional.** `_primaryFile` is
 *    `files[0]` — an artifact of prose ordering. Two reviewers naming the same
 *    files in a different order must still match (observed live on snapshot
 *    `c63035cbe740`). `_primaryFile` is for REPORTING; `affectedFilesOf` is for
 *    MATCHING.
 * 2. **A nullable metric never meets an arithmetic operator.** `null` coerces to
 *    `0` in JS, turning "not measured" into a measurement. Hence the explicit
 *    `not-applicable` verdict rather than a coverage of 0 or 1.
 * 3. **Absence of a comparable key is not evidence of distinctness.** A finding
 *    with no extractable file is `unmatchable`, never `shadowOnly` — that would
 *    be the exact defect this module fixes, relocated.
 *
 * ## What it deliberately is NOT
 *
 * Pure and zero-I/O. The extracted path is a **grouping key**, never a file
 * handle: nothing is opened, stat'ed, or egressed, so a path that no longer
 * exists on disk is a VALID key (historical snapshots must stay re-derivable).
 * No `realpath`, deliberately — INC-001's canonicalise-before-classify lesson
 * governs paths that decide whether content is READ or EGRESSED, and this path
 * makes no such decision. Adding it would break offline re-derivation and the
 * Tier-1 test strategy for a threat that does not exist here.
 *
 * Plan: docs/plans/cross-model-finding-matching.md §2.5.
 * @module scripts/lib/finding-match
 */
import { buildFileReferenceRegex } from './language-profiles.mjs';
import { normalizePath } from './file-io.mjs';
import { jaccardSimilarity } from './text-similarity.mjs';

/**
 * Every file path referenced by a free-text `section`, normalised, de-duplicated,
 * in first-appearance order.
 *
 * This is the extraction primitive `populateFindingMetadata` already used
 * inline; lifting it here gives `ledger.mjs`, the final-review path and
 * `semantic-suppression.mjs` ONE oracle instead of three near-copies.
 *
 * Returns `[]` — never a prose fragment — when the section names no file. That
 * is the deliberate difference from `_primaryFile`, whose legacy fallback yields
 * e.g. `"§0.3"` for `"§0.3 (Activation Addendum) vs §6.1"`. A heading is not a
 * file: treating one as a grouping key would merge unrelated §-referenced
 * findings, which is a fresh instance of the bug this module exists to fix.
 *
 * `dedupe:false` exists for exactly one caller: `populateFindingMetadata`, whose
 * current loop pushes every match including repeats. De-duplicating there would
 * change `affectedFiles` for a section naming one file twice — a real (if rare)
 * input, and Phase 1 promised a behaviour-PRESERVING refactor. Improving that
 * output while claiming preservation is the kind of quiet drift this repo's
 * regeneration checks exist to catch, so the ledger keeps its exact semantics
 * and the matching path gets the de-duplicated view it needs.
 *
 * @param {string} section
 * @param {{dedupe?: boolean}} [opts]
 * @returns {string[]}
 */
export function extractFileRefs(section, { dedupe = true } = {}) {
  if (typeof section !== 'string' || section === '') return [];
  const re = buildFileReferenceRegex();
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(section)) !== null) {
    const p = normalizePath(m[1]);
    if (!p) continue;
    if (dedupe) {
      if (seen.has(p)) continue;
      seen.add(p);
    }
    out.push(p);
  }
  return out;
}

/**
 * Coerce ONE value that may already be a resolved path into path form.
 *
 * `normalizePath` FIRST, then the extractor. That ordering is the whole trick
 * and it fixes two bugs at once: a stored `scripts\win\c.mjs` becomes
 * `scripts/win/c.mjs` before the prose regex sees it (the regex matches
 * forward slashes only, so the raw form extracted to nothing), while a prose
 * fragment like `§0.3` still yields `[]` because it has no file extension. One
 * mechanism, no "is this already a path?" guesswork.
 */
function asPath(value) {
  if (typeof value !== 'string' || value === '') return [];
  return extractFileRefs(normalizePath(value));
}

/**
 * The MATCHING key: every file a finding refers to, from EVERY source it has.
 *
 * A UNION, deliberately — not a precedence chain. Four consecutive review
 * rounds found the same defect in different places, always the same shape: some
 * caller picked ONE source (or `files[0]`) and silently narrowed the key,
 * re-creating §2.6 invariant 1 one hop downstream of wherever it was last
 * fixed. `affectedFiles ∪ primaryFile ∪ _primaryFile ∪ section` cannot narrow,
 * because there is nothing to choose between: every path the finding mentions
 * is a path it is about.
 *
 * @param {{affectedFiles?: string[], primaryFile?: string, _primaryFile?: string,
 *          section?: string}|null|undefined} finding
 * @returns {string[]} normalised, de-duplicated, first-appearance order
 */
export function affectedFilesOf(finding) {
  const out = [];
  const seen = new Set();
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };

  for (const p of (Array.isArray(finding?.affectedFiles) ? finding.affectedFiles : [])) {
    for (const q of asPath(p)) add(q);
  }
  for (const q of asPath(finding?.primaryFile)) add(q);
  for (const q of asPath(finding?._primaryFile)) add(q);
  for (const q of extractFileRefs(finding?.section)) add(q);
  return out;
}

/**
 * The REPORTING key: the one file a finding is filed under, or `null`.
 *
 * Null — not a prose fragment — when nothing was extractable, so callers can
 * distinguish "no file" from "a file called §0.3". Never use this to decide
 * whether two findings concern the same code (invariant 1); use
 * `affectedFilesOf` intersection.
 * @param {object|null|undefined} finding
 * @returns {string|null}
 */
export function primaryFileOf(finding) {
  // Just the head of the union. The old form special-cased `_primaryFile`
  // through the prose parser first, which both duplicated the resolution logic
  // and dropped backslash paths — the same double-parse defect the union's
  // `asPath` now handles in one place.
  return affectedFilesOf(finding)[0] ?? null;
}

/** Do two findings refer to at least one file in common? Order-independent. */
export function sharesFile(a, b) {
  const bs = new Set(affectedFilesOf(b));
  return affectedFilesOf(a).some((p) => bs.has(p));
}

/** The signature Jaccard scores — identical to `applyDebtSuppression`'s (plan §2.5a). */
export function signatureOf(finding) {
  return `${finding?.category ?? ''} ${finding?.section ?? ''} ${finding?.detail ?? ''}`;
}

/** Stable identity for a finding within a match run. */
function hashOf(finding, index, side) {
  return finding?._hash ?? `nohash:${side}:${index}`;
}

/**
 * Match two reviewers' finding sets into a partition.
 *
 * Greedy mutual-best, one-to-one: candidates are `(p, s)` sharing ≥1 file AND
 * scoring ≥ `threshold`; they are accepted in descending similarity, with a
 * `(primaryHash, shadowHash)` ascending tiebreak so two runs over one snapshot
 * bucket identically. Each finding is matched at most once, which is what makes
 * many-to-many impossible — the ambiguity a bare pairwise predicate leaves open.
 *
 * Greedy rather than optimal bipartite matching on purpose: sets are ~10
 * findings, the two differ only when three findings contest one file at
 * near-identical similarity, and a Hungarian-algorithm dependency for that is
 * the over-engineering cliff.
 *
 * @param {object[]} primary
 * @param {object[]} shadow
 * @param {{threshold:number, coverageFloor:number, similarity?:Function}} opts
 */
export function matchFindings(primary, shadow, opts) {
  const { threshold, coverageFloor, similarity = jaccardSimilarity } = opts;
  const P = (Array.isArray(primary) ? primary : []).filter(Boolean);
  const S = (Array.isArray(shadow) ? shadow : []).filter(Boolean);

  const pFiles = P.map((f) => affectedFilesOf(f));
  const sFiles = S.map((f) => affectedFilesOf(f));

  const candidates = [];
  for (let i = 0; i < P.length; i++) {
    if (pFiles[i].length === 0) continue;          // unmatchable — never a candidate
    for (let k = 0; k < S.length; k++) {
      if (sFiles[k].length === 0) continue;
      const shared = pFiles[i].filter((p) => sFiles[k].includes(p));
      if (shared.length === 0) continue;
      const score = similarity(signatureOf(P[i]), signatureOf(S[k]));
      if (score < threshold) continue;
      candidates.push({ i, k, score, shared });
    }
  }
  // Descending score; then a TOTAL order on hashes so the result is deterministic.
  candidates.sort((a, b) => (b.score - a.score)
    || String(hashOf(P[a.i], a.i, 'p')).localeCompare(String(hashOf(P[b.i], b.i, 'p')))
    || String(hashOf(S[a.k], a.k, 's')).localeCompare(String(hashOf(S[b.k], b.k, 's'))));

  const usedP = new Set();
  const usedS = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedP.has(c.i) || usedS.has(c.k)) continue;
    usedP.add(c.i); usedS.add(c.k);
    pairs.push({
      primaryHash: hashOf(P[c.i], c.i, 'p'),
      shadowHash: hashOf(S[c.k], c.k, 's'),
      similarity: c.score,
      sharedFiles: c.shared,
    });
  }

  const unmatchablePrimary = pFiles.filter((f) => f.length === 0).length;
  const unmatchableShadow = sFiles.filter((f) => f.length === 0).length;
  const both = pairs.length;
  const primaryOnly = P.length - both - unmatchablePrimary;
  const shadowOnly = S.length - both - unmatchableShadow;

  const total = P.length + S.length;
  // Invariant 2: the empty state is `null` + `not-applicable`, NOT 0 (which
  // would read as "measured, and terrible") and NOT 1 (which would read as
  // perfect coverage derived from no evidence).
  const coverage = total === 0
    ? null
    : 1 - (unmatchablePrimary + unmatchableShadow) / total;
  const verdict = total === 0 ? 'not-applicable' : (coverage < coverageFloor ? 'unknown' : 'ok');

  return {
    both, primaryOnly, shadowOnly,
    unmatchablePrimary, unmatchableShadow,
    coverage, verdict, pairs,
  };
}

/**
 * Conservation check (plan §2.5b) — exported so it can be asserted in tests AND
 * cheaply re-asserted by callers. A partition that leaks is the defect class
 * this module exists to fix.
 * @returns {boolean}
 */
export function conserves(result, primaryCount, shadowCount) {
  return primaryCount === result.both + result.primaryOnly + result.unmatchablePrimary
    && shadowCount === result.both + result.shadowOnly + result.unmatchableShadow;
}
