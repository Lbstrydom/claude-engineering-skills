/**
 * @fileoverview Shared glob-matching utility for accept-v1 markers + audit
 * scope checks. Single source of truth — eliminates the duplicate between
 * findings-pipeline.mjs and deferral-classifier.mjs (audit-code R1/L2).
 *
 * Supports:
 *   `*`   — match any chars excluding `/`
 *   `**`  — match any chars including `/`
 *   double-star + slash — match zero-or-more directory segments
 *   (`a` + double-star + `/b` matches both `a/b` AND `a/x/y/b`)
 *
 * Sufficient for plan-marker file globs without pulling in micromatch.
 *
 * @module scripts/lib/audit/glob-match
 */

/**
 * Translate a glob to a regex (ordered transformations matter):
 *   1. Escape regex metacharacters (preserve `*` for the next steps).
 *   2. double-star + slash → `(?:.*\/)?` — zero-or-more directory segments.
 *   3. `**`   → `.*`     — bare double-star matches anything.
 *   4. `*`    → segment chars only — single-star matches within one segment.
 *
 * @param {string} glob
 * @param {string} filePath
 * @returns {boolean}
 */
export function globMatch(glob, filePath) {
  if (!glob || !filePath) return false;
  const escaped = glob
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll('**/', '__DSS__')
    .replaceAll('**', '__DS__')
    .replaceAll('*', '[^/]*')
    .replaceAll('__DSS__', '(?:.*/)?')
    .replaceAll('__DS__', '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}
