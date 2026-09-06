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
 * **`sectionLociOf` does NOT reverse that** (2026-08-19), and the difference is
 * the point. The rule above forbids a heading entering the FILE key space,
 * where `"§0.3"` would sit beside `scripts/a.mjs` and be intersected with it.
 * Section keys live in their own `section:`-prefixed space, are reachable only
 * when a finding names no file at all, and are still gated by the similarity
 * threshold — so a heading can group two findings that cite it, and can never
 * be mistaken for a path. What the rule protects against is a heading
 * masquerading as a file; what it must not be read to require is that
 * plan-mode findings stay permanently unmatchable, which is invariant 3
 * failing in the other direction.
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
 * The REPORTING spelling of the first file a `section` cites — the prose's own case.
 *
 * This module's header states the split it exists to keep: *"`_primaryFile` is for
 * REPORTING; `affectedFilesOf` is for MATCHING."* `extractFileRefs` serves the second
 * half, and it must keep folding case — a grouping key that distinguishes `SKILL.md`
 * from `skill.md` on a case-insensitive filesystem would split one file into two keys.
 * But `populateFindingMetadata` filled the reporting key from that same folded list, so
 * the value written to `audit_findings.primary_file` — the one a reader OPENS — arrived
 * lowercased.
 *
 * Measured against store `d5a9d07b91225a93` scoped to this repo (2026-09-06): 138 of
 * 5,022 code-mode rows differed from a tracked file by case alone, concentrated on this
 * bundle's own convention — a skill's `skill.md`, an `agents.md`, a plans `readme.md`.
 * (Those spellings are STORED VALUES quoted as evidence, not references: the real files
 * are uppercase, which is the entire point, and `docs:refs:gate` rightly said so.)
 * Invisible on Windows, where `existsSync` is case-insensitive; a silent skip on Linux
 * for `remediation-verification.mjs` and `campaign/cited-source.mjs`, which open it.
 *
 * **It is not a second path normaliser, and the guard is structural rather than a
 * promise.** The prose spelling is returned ONLY when normalising it changes nothing
 * but case; any other difference (a `../` escape, a different drive, cwd-relativisation)
 * means the value needed real normalisation, and the normalised key is returned instead.
 * So `normalizePath(displayPathOf(s)) === extractFileRefs(s)[0]` holds for every input —
 * asserted over a repo-derived corpus in `tests/primary-file-display-case.test.mjs`.
 *
 * Returns `null` — never a prose fragment — on the same terms as `extractFileRefs`.
 * `_primaryFile`'s legacy heading fallback stays where it is, in the caller.
 *
 * @param {string} section
 * @returns {string|null}
 */
export function displayPathOf(section) {
  if (typeof section !== 'string' || section === '') return null;
  const re = buildFileReferenceRegex();
  let m;
  while ((m = re.exec(section)) !== null) {
    const key = normalizePath(m[1]);
    // Same skip as extractFileRefs, so this returns the display form of ITS first
    // element and not of some earlier match that normalised away to nothing.
    if (!key) continue;
    const candidate = m[1].replace(/^\.\//, '');
    return normalizePath(candidate) === candidate.toLowerCase() ? candidate : key;
  }
  return null;
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

/**
 * `§`-section and decision-id keys — the LOCUS of a finding that cites no file.
 *
 * A plan-mode finding is not about a file. Its `primary_file` is a section
 * reference (`"§1 D1b vs 'Out of Scope (Future)' vs §8 promotion matrix"`), so
 * `affectedFilesOf` returns nothing and the matcher's file-sharing conjunction
 * can never fire — every such finding is `unmatchable`, which is the state that
 * makes "unique" mean "total". Measured on campaign cohort `e52eec728688fcab`
 * (2026-08-19): **89 of 201 findings cite no file, and 171 of the 201 are
 * plan-mode**, so per-snapshot locus coverage sat at 0.31–0.65 against a 0.6
 * floor. Clustering refused five complete snapshots and the campaign's
 * attribution gate was not merely unmet but UNREACHABLE.
 *
 * Two key shapes, both normalised to lower case: the `§N` marker (`§2`, `§6b`,
 * `§2.5c`) and structured decision ids (`D7c`, `KD-3`, `R3-M1`). Measured over
 * the same cohort: 84 of the 89 no-file findings (94%) carry at least one, which
 * lifts every snapshot to 0.89–1.00.
 *
 * **A narrowing key, not a merging one.** Of 1861 cross-arm pairs, a shared
 * section key admits 240 (13%) — the prefilter still discriminates rather than
 * degenerating into "everything shares the document". Their similarity
 * distribution is median 0.088 / p75 0.109, so the calibrated 0.14 threshold
 * still decides: 31 of the 240 actually match. The shared section text does NOT
 * inflate the score into automatic merges, which was the hazard worth checking
 * before shipping this — `signatureOf` includes `section`, so a long shared
 * section phrase could have dominated the Jaccard.
 */
const SECTION_MARKER_RE = /§\s*([\w.]+)/g;
const DECISION_ID_RE = /\b((?:KD|D|R\d+|M|H|L)-?\d+[a-z]?)\b/g;

export function sectionLociOf(finding) {
  const text = [finding?.section, finding?.primaryFile, finding?._primaryFile]
    .filter((t) => typeof t === 'string' && t !== '')
    .join(' ');
  if (text === '') return [];
  const out = [];
  const seen = new Set();
  // `section:` prefixed so a locus can never collide with a file path, and so
  // a reader of `sharedLoci` can tell which space a match came from.
  const add = (raw) => {
    const key = `section:${String(raw).toLowerCase().replace(/\.+$/, '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  for (const m of text.matchAll(SECTION_MARKER_RE)) add(`§${m[1]}`);
  for (const m of text.matchAll(DECISION_ID_RE)) add(m[1]);
  return out;
}

/**
 * The matching LOCUS: files when the finding names any, section keys otherwise.
 *
 * A FALLBACK, not a union, and that is the load-bearing half. A union would
 * hand every code finding a second key space, so two findings that share no
 * file could match on a stray `§2` in their prose — silently changing what
 * "same defect" means for every comparison this repo has already run. Under the
 * fallback a finding that resolves a file behaves EXACTLY as it did before
 * (asserted as a negative control), and only the findings that were previously
 * unmatchable gain a locus.
 */
export function affectedLociOf(finding) {
  const files = affectedFilesOf(finding);
  return files.length > 0 ? files : sectionLociOf(finding);
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

  // LOCUS, not file: a plan-mode finding cites a `§`-section rather than a path
  // (see `affectedLociOf`). Files still win whenever a finding names one, so
  // nothing that matched before matches differently now.
  const pLoci = P.map((f) => affectedLociOf(f));
  const sLoci = S.map((f) => affectedLociOf(f));

  const candidates = [];
  for (let i = 0; i < P.length; i++) {
    if (pLoci[i].length === 0) continue;          // unmatchable — never a candidate
    for (let k = 0; k < S.length; k++) {
      if (sLoci[k].length === 0) continue;
      const shared = pLoci[i].filter((p) => sLoci[k].includes(p));
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
      // `sharedFiles` keeps its historical meaning — file paths only — because
      // it is a PERSISTED field (gemini-review stores `pairs` verbatim), and a
      // field named for files that sometimes holds `section:§2` would be a lie
      // to whoever reads those records next. `sharedLoci` is the whole truth.
      sharedFiles: c.shared.filter((x) => !x.startsWith('section:')),
      sharedLoci: c.shared,
      locusKind: c.shared.some((x) => x.startsWith('section:')) ? 'section' : 'file',
    });
  }

  const unmatchablePrimary = pLoci.filter((f) => f.length === 0).length;
  const unmatchableShadow = sLoci.filter((f) => f.length === 0).length;
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
