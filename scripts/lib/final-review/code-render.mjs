/**
 * @fileoverview Tiered code renderer for the final-review envelope.
 *
 * A HEAD cut is the wrong shape for a review whose subject is a diff: the
 * changed region can sit anywhere in the file, so an 8,000-char head slice of a
 * 22,000-char file is a coin flip on whether the reviewer sees the change at
 * all. Measured 2026-09-02 (audit SID audit-code-1788374248, store run
 * 081547a7): it did not — `AUTOCRLF_PROBE` began at char 16,170 of
 * `scripts/lib/doctor/probes.mjs`, the render carried the first 8,000, and the
 * gate returned APPROVE having received none of the change.
 *
 * So the render is TIERED: changed files first, at a cap large enough to carry
 * an ordinary source file whole; ambient context files afterwards, out of
 * whatever budget survives, at the historical cap. BOTH halves are load-bearing
 * — ordering alone would not have fixed the measured case (the file was cut,
 * not dropped), and a larger cap alone would still have spent the budget on
 * ambient files before reaching the diff.
 *
 * Lives in its own module rather than inline in `runFinalReview` because a
 * contract needs a function boundary: an inline closure cannot be exercised by
 * a test, and this one decides what the paid reviewer is allowed to see.
 *
 * @module scripts/lib/final-review/code-render
 */

import { readFilesAsContextDetailed, mergeCodeRenderStats, normalizePath } from '../file-io.mjs';
import { THIN_CODE_MAX_CHARS, THIN_CODE_MAX_PER_FILE } from './envelope.mjs';

/** Per-file cap for files IN the diff. 40K covers ~99% of source files here. */
export const CHANGED_FILE_MAX_PER_FILE = 40_000;
/** Per-file cap for ambient (non-diff) context on the `full` path — unchanged. */
export const FULL_AMBIENT_MAX_PER_FILE = 8_000;
/** Total code budget on the `full` path — unchanged. */
export const FULL_CODE_MAX_CHARS = 100_000;

/**
 * Build the `renderCode` reader the envelope injects.
 *
 * @param {object} opts
 * @param {string[]} opts.changedFiles - the declared diff set. On reduced
 *   scopes the caller's `codePaths` already IS this set, so the tiering
 *   degenerates cleanly to a single render.
 * @param {boolean} [opts.reduced=false] - thin/gap budgets instead of full.
 * @param {Function} [opts.read=readFilesAsContextDetailed] - injected for tests.
 * @returns {(paths: string[]) => {text: string, stats: object|null}}
 */
export function makeTieredCodeRenderer({ changedFiles = [], reduced = false, read = readFilesAsContextDetailed } = {}) {
  const changedKeys = new Set(
    (Array.isArray(changedFiles) ? changedFiles : [])
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map(normalizePath),
  );
  const codeTotalBudget = reduced ? THIN_CODE_MAX_CHARS : FULL_CODE_MAX_CHARS;
  const ambientMaxPerFile = reduced ? THIN_CODE_MAX_PER_FILE : FULL_AMBIENT_MAX_PER_FILE;
  const changedMaxPerFile = Math.min(CHANGED_FILE_MAX_PER_FILE, codeTotalBudget);

  return function renderCode(paths) {
    const list = Array.isArray(paths) ? paths : [];
    if (list.length === 0) return { text: '', stats: null };

    const changed = list.filter((p) => changedKeys.has(normalizePath(p)));
    const ambient = list.filter((p) => !changedKeys.has(normalizePath(p)));

    if (changed.length === 0) {
      // Nothing declared changed among these paths — one render, historical caps.
      const only = read(list, { maxPerFile: ambientMaxPerFile, maxTotal: codeTotalBudget });
      return { text: only.context, stats: only.stats };
    }

    const first = read(changed, { maxPerFile: changedMaxPerFile, maxTotal: codeTotalBudget });
    const remaining = Math.max(0, codeTotalBudget - first.stats.charsRendered);
    // Ambient is rendered even when `remaining` is 0: every block then exceeds
    // the budget and lands in `budgetOmitted`, so the files appear in the record
    // as DROPPED. Skipping the call instead would make an unasked question
    // render as an empty result — the shape AGENTS.md warns about.
    const second = ambient.length > 0
      ? read(ambient, { maxPerFile: ambientMaxPerFile, maxTotal: remaining })
      : null;
    return {
      text: first.context + (second?.context ?? ''),
      stats: mergeCodeRenderStats(first.stats, second?.stats ?? null),
    };
  };
}
