/**
 * @fileoverview Diff-path scope resolution with sensitive-path filtering for
 * the tiered discovery generators — the enum enumerates file paths as
 * first-class, structured, citable ids inside the tool schema, so a
 * `.env`/`secrets/db.yaml` entry must never become a citable id.
 *
 * Extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/lib/audit/discovery-diff-scope
 */

import { buildDiffPathMap } from './diff-path-map.mjs';
import { shouldSkipForIndexing, normalisePath } from '../sensitive-paths.mjs';

/**
 * Resolve this run's diff-path map, with sensitive paths excluded BEFORE the
 * enum and prompt table exist (plan §Security).
 *
 * WHY THIS FILTER IS NOT OPTIONAL: the enum enumerates file paths as
 * first-class, structured, citable ids inside the tool schema. `redactSecrets`
 * masks secret *values*; it does not exclude sensitive *paths*. Without this,
 * a `.env`/`secrets/db.yaml` entry in the diff would be disclosed to the
 * provider as a schema member — a path-level disclosure the redacted payload
 * alone does not imply. A file excluded here simply has no id, so no anchor
 * can cite it.
 *
 * TWO DELIBERATE DEVIATIONS from the plan's §Security prose, both reported:
 *
 * 1. The plan says "filter before mapping, not after". `buildDiffPathMap`
 *    takes diff TEXT, so filtering "before" would mean re-implementing its
 *    parser to split sections — the exact duplication §7i exists to prevent.
 *    Filtering the parsed entries is equivalent for the property that
 *    matters: the enum and table are constructed EXCLUSIVELY from the
 *    filtered set, never from raw diff headers.
 * 2. The plan mandates `resolveAndClassify`'s symlink-aware canonicalisation,
 *    fail-closed on `resolutionFailed`. That is NOT implementable over a diff:
 *    it realpaths, and a `deleted` file (or a rename's `oldPath`) legitimately
 *    does not exist on disk — every one would fail-closed to `sensitive` and
 *    lose its id, silently making deleted files unauditable. We use the
 *    lexical `shouldSkipForIndexing` seam instead, which is exactly the bar
 *    the OTHER half of this same payload already meets (`readFilesAsContext`
 *    → `isSensitiveFile`), and the map discloses only the path string that
 *    check already covers.
 *
 * @param {string|null|undefined} diffText - the run's unified diff (ctx.diffText)
 * @returns {{map: ReturnType<typeof buildDiffPathMap>, skipped: Array<object>}}
 */
export function resolveEligibleDiffPathMap(diffText) {
  const map = buildDiffPathMap(diffText);
  if (map.kind !== 'ready') return { map, skipped: [] };

  const skipped = [];
  const entries = map.entries.filter((e) => {
    // Fail closed on EITHER side: a rename whose base path is `secrets/x` is
    // just as much a disclosure as one whose head path is.
    for (const p of [e.newPath, e.oldPath]) {
      const r = shouldSkipForIndexing(p, ['sensitive']);
      if (r.skip) {
        skipped.push({ path: normalisePath(p), category: r.category, pattern: r.pattern, action: 'dropped' });
        return false;
      }
    }
    return true;
  });

  // Every eligible file filtered out is a legitimate empty scope, NOT invalid
  // — the diff parsed fine, it just has nothing we may send (§7j).
  if (entries.length === 0) return { map: { kind: 'empty', reason: 'no_eligible_diff_files' }, skipped };
  return { map: { kind: 'ready', entries }, skipped };
}
