/**
 * @fileoverview VCS scope + sensitive-path filtering + file-list assembly for
 * `refresh.mjs` — combined into one file since they are sequential steps of
 * ONE pipeline stage (git diff → filter → union with the summary-retry queue
 * → restrictFiles/touchedSet), not two independently callable concerns.
 *
 * Extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/symbol-index/refresh-file-scope
 */

import * as vcs from '../lib/vcs.mjs';
import { filterDiffFiles, formatSkipLog, shouldSkipForIndexing, normalisePath } from '../lib/sensitive-paths.mjs';
import { listFilesNeedingSummaryRetry } from '../learning-store.mjs';

/**
 * Throw a tagged Error so the outer `main()` try/catch can abort the
 * in-flight refresh_run BEFORE exiting. The catch block in `main()`
 * inspects `err.vcsCode` to look up the exit code via `vcs.exitCodeFor`
 * — direct `process.exit()` here would skip `abortRefreshRun`, leaving
 * the row stuck in `running` and the per-repo lock held (R1-audit H10).
 *
 * @param {{code: string, message: string, cause?: Error}} err
 */
export function throwVcsError(err) {
  const e = new Error(`vcs failure: ${err.code} — ${err.message}`);
  e.code = 'VCS_FAILURE';
  e.vcsCode = err.code;
  e.vcsMessage = err.message;
  if (err.cause) e.cause = err.cause;
  throw e;
}

/**
 * Enumerate the incremental file scope: git diff since `sinceCommit`,
 * sensitive-path filtered, unioned with the summary-retry re-queue.
 *
 * A full run (or an incremental run mode-promoted to `full`) gets the exact
 * same `{restrictFiles: null, touchedSet: null, diffStats: null}` it gets
 * today — ONE function, one contract, both modes, not two functions or a
 * mode-branch in `main()`. `main()` calls it unconditionally and always
 * receives a fully-defined result.
 *
 * @param {{mode: string, repoRoot: string, sinceCommit: string|null, repoId: string, prior: object|null, logOk: (s: string) => void}} args
 * @returns {Promise<{restrictFiles: string[]|null, touchedSet: Set<string>|null, diffStats: object|null}>}
 */
export async function resolveIncrementalFileScope({ mode, repoRoot, sinceCommit, repoId, prior, logOk }) {
  if (mode !== 'incremental' || !sinceCommit) {
    return { restrictFiles: null, touchedSet: null, diffStats: null };
  }

  const diffResult = vcs.gitDiffWithWorkingTree(repoRoot, sinceCommit);
  if (!diffResult.ok) {
    throwVcsError(diffResult.error);
  }
  // State-aware filter: sensitive `modified` → rewritten as `deleted`
  // so the indexer tombstones prior rows; sensitive `deleted` is
  // preserved as tombstone. See sensitive-paths.mjs filterDiffFiles.
  const { diff, skipped } = filterDiffFiles(diffResult.files, ['sensitive', 'generatedNoise']);
  // Capture the POST-filter diff (what the indexer actually acts on:
  // sensitive paths already rewritten to `deleted`) for the annotation
  // columns. Sourced from the structured `diff`, NOT the flattened
  // `touchedSet` — touchedSet collapses all five categories into one set
  // and folds in non-git summary-retry files, so it cannot honestly
  // populate a per-category column.
  const diffStats = {
    added: diff.added,
    modified: diff.modified,
    deleted: diff.deleted,
    renamed: diff.renamed,
    untracked: diff.untracked,
  };
  for (const line of formatSkipLog(skipped, { logger: 'refresh' })) {
    process.stderr.write(`  ${line}\n`);
  }
  const fileList = [
    ...diff.added,
    ...diff.modified,
    ...diff.untracked,
    ...diff.renamed.map(r => r.to),
  ];
  // NULL-SUMMARY RE-QUEUE (plan §2.1 C9).
  //
  // Incremental extraction is scoped to git-touched files, so a symbol
  // whose summarisation failed is revisited ONLY if its file happens to
  // be edited again. One transient provider outage would otherwise leave
  // a permanent, silent blind spot: those symbols hold no embedding and
  // surface as `unscored` forever, with nothing ever retrying them.
  //
  // Union their files into the extraction set so they flow back through
  // the normal extract → summarise → embed path. Bounded by
  // SUMMARY_RETRY_CAP on symbol_definitions, so permanently-
  // unsummarisable symbols (oversized body, safety-filter trip) stop
  // being retried rather than burning provider calls every refresh.
  let retryFiles = [];
  if (prior?.refreshId) {
    try {
      retryFiles = await listFilesNeedingSummaryRetry(repoId, prior.refreshId);
    } catch (err) {
      // Never block a refresh on the re-queue lookup.
      logOk(`WARNING: summary re-queue lookup failed (${err.message}) — continuing without it`);
    }
  }
  // round-1 H4: retryFiles come from symbol_definitions (not from the git
  // diff above), so they never passed through the sensitive-path filter a
  // fresh diff entry gets at line 59 — a file that became sensitive since it
  // was last indexed (a new .auditignore rule, a move into a sensitive dir)
  // could otherwise re-enter the extraction set purely via the summary-retry
  // queue. Same categories, same shouldSkipForIndexing() used above; logged
  // through the identical formatSkipLog() convention.
  const retrySkipped = [];
  const retryOnly = retryFiles
    .filter(f => !fileList.includes(f))
    .filter((f) => {
      const r = shouldSkipForIndexing(f, ['sensitive', 'generatedNoise']);
      if (r.skip) {
        retrySkipped.push({ path: normalisePath(f), category: r.category, pattern: r.pattern, action: 'dropped' });
        return false;
      }
      return true;
    });
  for (const line of formatSkipLog(retrySkipped, { logger: 'refresh' })) {
    process.stderr.write(`  ${line}\n`);
  }
  const restrictFiles = [...fileList, ...retryOnly];
  const touchedSet = new Set([
    ...restrictFiles,
    ...diff.deleted,
    ...diff.renamed.map(r => r.from),
  ]);
  logOk(
    `incremental: ${fileList.length} touched files (since ${sinceCommit})`
    + (retryOnly.length ? ` + ${retryOnly.length} re-queued for failed summarisation` : ''),
  );

  return { restrictFiles, touchedSet, diffStats };
}
