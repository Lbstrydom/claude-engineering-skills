/**
 * @fileoverview Dependency-neutral text-normalization primitives shared
 * between `shared-lib` (`vcs.mjs`) and `audit-orchestration`
 * (`evidence-triage.mjs`) — extracted so neither domain imports from the
 * other for a primitive this generic (plan:
 * docs/plans/stage0-evidence-relevance-split.md, round-2 plan-audit M1).
 *
 * @module scripts/lib/text-normalize
 */

/**
 * Collapse all whitespace runs to a single space and trim. A quote copied
 * from a diff or a file may have different leading indentation or
 * line-ending style than what a naive substring search would require.
 *
 * @param {string|null|undefined|*} s - any nullish or coercible value
 *   (`null`/`undefined` become `''`; a non-string like `0`/`false`/a number
 *   is coerced via `String()` before normalizing) — never throws.
 * @returns {string}
 */
export function normalizeWhitespace(s) {
  return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
}
