/**
 * @fileoverview Path-based duplication exemptions for `arch:drift`'s global
 * score — the structural counterpart to the `@duplicate-justification`
 * pragma, for the one case a pragma can never reach.
 *
 * `findRepoPragmas` (`duplicate-justification-pragma.mjs`) excludes
 * `tests/*` from its sweep entirely and deliberately — a test file must not
 * be able to author its own drift-score suppression. That is correct for
 * ordinary test duplication, but it also means a directory that is a
 * DECLARED, deliberate byte-for-byte mirror of real source — built to test
 * something else entirely — has no way to tell the drift score "this is not
 * accidental duplication" from inside the file itself. Measured
 * 2026-09-13: `tests/fixtures/anchor-contract/files/**` (the evidence-anchor
 * -path-contract fixture corpus — see `docs/plans/evidence-anchor-path-
 * contract.md`) accounted for 18 of `arch:drift`'s 63 duplication clusters
 * for exactly this reason, none of them fixable by pragma.
 *
 * This module is that second, narrower channel — resolved into the SAME
 * `duplicate_justified` column the pragma mechanism already writes, and
 * excluded by the SAME SQL predicate `top_duplicate_clusters`/`drift_score`
 * already apply. No schema change, no new SQL: `refresh.mjs` merges this
 * module's matches into the same `recordDuplicateJustifications` call that
 * already carries pragma-resolved entries.
 *
 * Extend `DRIFT_PATH_EXEMPT_PREFIXES` only for a whole DIRECTORY verified to
 * be a mirror corpus (diffed against its real counterpart, or read the
 * mechanism that builds it) — never as a shortcut for an individual symbol a
 * human should instead reach `@duplicate-justification` for.
 *
 * @module scripts/lib/symbol-index/drift-path-exemptions
 */

export const DRIFT_PATH_EXEMPT_PREFIXES = Object.freeze([
  'tests/fixtures/anchor-contract/files/',
]);

/**
 * True if `filePath` (repo-relative, either slash style) falls under a
 * declared drift-exempt directory.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isDriftPathExempt(filePath) {
  const normalised = String(filePath || '').replace(/\\/g, '/');
  return DRIFT_PATH_EXEMPT_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}
