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

import fs from 'node:fs';
import path from 'node:path';
import { parseDiffPathSections, applyDiffPathMapBudgets } from './diff-path-map.mjs';
import { shouldSkipForIndexing, normalisePath, resolveAndClassify } from '../sensitive-paths.mjs';

/**
 * H2 (code-audit r1): `fs.existsSync` follows the final symlink, so a live
 * BROKEN symlink (present in the worktree, target missing) reads identically
 * to a genuinely deleted file — both return `false` — even though the two
 * are not the same case: a deleted path has no dirent at all, while a broken
 * symlink is a real, present entry whose target `resolveAndClassify` should
 * still be asked to resolve (it fails closed on ENOENT/EACCES/ELOOP itself —
 * see sensitive-paths.mjs). `lstatSync` does not follow the final symlink, so
 * it distinguishes "nothing here" (ENOENT — skip the check, deleted-file
 * case) from "something here, possibly a broken link" (any other outcome —
 * still worth asking resolveAndClassify, which owns the fail-closed policy).
 *
 * H5 (code-audit r2): an ordinary directory-to-file diff (an ancestor path
 * component that used to be a directory is now a file, or vice versa) makes
 * `lstatSync` throw ENOTDIR/ENOENT-adjacent errors that are NOT plain ENOENT
 * — ENOTDIR was rethrown uncaught, crashing the whole diff-scope resolution
 * instead of treating the path as absent. Both ENOENT and ENOTDIR mean "no
 * valid dirent at this exact path" — the only difference is which path
 * segment is missing/wrong-typed — so both take the deleted-file branch.
 *
 * M1 (code-audit r3): a permission-restricted directory (EACCES) — or any
 * other lstat failure that isn't "no dirent here" — used to rethrow too,
 * aborting the whole diff-scope resolution over one inaccessible path. This
 * function never needs to make its own fail-open/fail-closed call for that
 * case: `resolveAndClassify`'s realpathSync hits the SAME error and already
 * fails closed on it (its own doc: "ENOENT, EACCES, ELOOP → fail-closed").
 * So existsOnDisk never rethrows — ENOENT/ENOTDIR (genuinely no dirent) take
 * the deleted-file branch; everything else (including EACCES) reports
 * "exists" and defers the actual policy decision to resolveAndClassify.
 */
function existsOnDisk(abs) {
  try {
    fs.lstatSync(abs);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    return true; // EACCES/ELOOP/etc. — let resolveAndClassify's own fail-closed policy decide
  }
}

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
 * 1. The plan says "filter before mapping, not after". `parseDiffPathSections`
 *    (diff-path-map.mjs) does the parsing; filtering runs on ITS sections,
 *    before `applyDiffPathMapBudgets` mints ids or enforces the entry/byte
 *    budgets — never re-implementing the parser, and never budgeting the
 *    UNFILTERED count (fp=a9c621d7, 2026-08-20 fix: budgeting before
 *    filtering meant a diff with a handful of eligible files and a couple
 *    hundred sensitive ones tripped `discovery_map_exceeds_budget` on files
 *    that would never reach the enum anyway). The enum and table are still
 *    constructed EXCLUSIVELY from the filtered set, never from raw diff
 *    headers or an unfiltered section list.
 * 2. The plan mandates `resolveAndClassify`'s symlink-aware canonicalisation,
 *    fail-closed on `resolutionFailed`. That is NOT unconditionally
 *    implementable over a diff: it realpaths, and a `deleted` file (or a
 *    rename's `oldPath`) legitimately does not exist on disk — running it
 *    unconditionally would fail-closed to `sensitive` and lose the id for
 *    EVERY deleted/renamed file, silently making them unauditable. So the
 *    lexical `shouldSkipForIndexing` seam remains the fallback for paths
 *    that don't exist in the current worktree — exactly the bar the OTHER
 *    half of this same payload already meets (`readFilesAsContext` →
 *    `isSensitiveFile`).
 *
 *    **6cfb5541 (2026-07-26)**: for a path that DOES exist on disk (i.e. not
 *    deleted/renamed-away — nothing is lost by resolving it), additionally
 *    run `resolveAndClassify` and fail closed on `resolutionFailed`/
 *    `escapedRepo`, closing the residual gap where a live symlink with a
 *    benign-looking lexical name resolves to a sensitive target. This is
 *    genuinely additive: it can only turn an eligible path into a skipped
 *    one, never the reverse, and never touches the deleted-file case above.
 *
 *    **H2 (code-audit r1, same day)**: that "does it exist" gate used
 *    `fs.existsSync`, which follows the final symlink — so a LIVE broken
 *    symlink (present in the worktree, dangling target) read identically to
 *    a genuinely deleted file (both `false`), skipping `resolveAndClassify`
 *    entirely and falling through to lexical-only, when `resolveAndClassify`
 *    would have failed it closed via its own realpath ENOENT handling had it
 *    been called. Replaced with `existsOnDisk` (`lstatSync`, does not follow
 *    the final symlink) so only a genuine ENOENT — no dirent at all — takes
 *    the deleted-file path; anything else, including a broken symlink, still
 *    reaches `resolveAndClassify`.
 *
 * **Purity note**: this function was previously fs-free ("no filesystem, no
 * network, no clock" per this module's original header). The `existsOnDisk`
 * probe above makes that no longer strictly true — it is a synchronous,
 * deterministic-for-a-given-worktree-state check used only to decide which
 * of the two already-pure code paths above applies, not a source of
 * nondeterminism or a seam this module needs to mock in tests (both
 * branches are exercised directly with fixtures that do or don't exist on
 * disk).
 *
 * @param {string|null|undefined} diffText - the run's unified diff (ctx.diffText)
 * @param {{repoRoot?: string}} [opts] - repoRoot for resolveAndClassify (defaults to process.cwd())
 * @returns {{map: ReturnType<typeof parseDiffPathSections>|ReturnType<typeof applyDiffPathMapBudgets>, skipped: Array<object>}}
 */
export function resolveEligibleDiffPathMap(diffText, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  // Parse-only first, budget LAST (fp=a9c621d7): filtering sensitive paths out
  // of the section list before the entry/byte budgets are checked means a diff
  // with 200+ files, most of them sensitive, is judged on the handful actually
  // eligible — not starved of budget by paths that will never reach the enum.
  const parsed = parseDiffPathSections(diffText);
  if (parsed.kind !== 'ready') return { map: parsed, skipped: [] };

  const skipped = [];
  const eligibleSections = parsed.sections.filter((e) => {
    // Fail closed on EITHER side: a rename whose base path is `secrets/x` is
    // just as much a disclosure as one whose head path is.
    // G1 (Gemini final review, code-audit): for every non-rename entry
    // (modified/added/deleted) newPath === oldPath, so the un-deduped loop
    // ran shouldSkipForIndexing/existsOnDisk(lstat)/resolveAndClassify
    // (realpath) TWICE on the identical path for >90% of diff entries.
    const pathsToCheck = e.oldPath === e.newPath ? [e.newPath] : [e.newPath, e.oldPath];
    for (const p of pathsToCheck) {
      const r = shouldSkipForIndexing(p, ['sensitive']);
      if (r.skip) {
        skipped.push({ path: normalisePath(p), category: r.category, pattern: r.pattern, action: 'dropped' });
        return false;
      }
      // 6cfb5541: only for a path that currently exists on disk (never a
      // deleted/renamed-away path, which resolveAndClassify would always
      // fail-closed on for lack of a filesystem target) — additionally
      // check symlink-resolved canonical classification. Resolve against
      // repoRoot explicitly (matching resolveAndClassify's own internal
      // resolution) rather than relying on existsSync's implicit
      // process.cwd()-relative behavior, so an explicit repoRoot in tests
      // is actually honored.
      const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
      if (existsOnDisk(abs)) {
        const rc = resolveAndClassify(p, { repoRoot });
        if (rc.resolutionFailed || rc.escapedRepo || rc.category === 'sensitive') {
          skipped.push({ path: normalisePath(p), category: 'sensitive', pattern: 'symlink-resolved', action: 'dropped' });
          return false;
        }
      }
    }
    return true;
  });

  // Every eligible file filtered out is a legitimate empty scope, NOT invalid
  // — the diff parsed fine, it just has nothing we may send (§7j).
  if (eligibleSections.length === 0) return { map: { kind: 'empty', reason: 'no_eligible_diff_files' }, skipped };
  // Budget applies to the FILTERED (eligible) set — see the note above.
  return { map: applyDiffPathMapBudgets(eligibleSections), skipped };
}
