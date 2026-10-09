/**
 * @fileoverview What is in a worktree that git history does not show — the ONE
 * porcelain probe behind four readers: the default view's "is this worktree
 * clean?", uncommitted overlap evidence, "merged but work remains", and
 * `archive-check`'s loss verdict.
 *
 * Bounded like every fleet probe: a per-call timeout, a candidate cap and an
 * aggregate deadline. Anything over budget, and any failed call, is
 * `{queried:false, reason}` — never an empty (clean) answer.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.1, §2.3.
 *
 * @module scripts/lib/fleet/worktree-status
 */
import { runGit } from './git-facts.mjs';

/** Bounds of the worktree probes (plan §2.2 of the storyline plan): per process, candidate cap, aggregate. */
export const CLEAN_PROBE = Object.freeze({ timeoutMs: 5_000, maxCandidates: 20, deadlineMs: 15_000 });

/**
 * Parse `git status --porcelain=v1 -z --no-renames` output into entries. With
 * `--no-renames` every record is exactly `XY <path>` (no second path), so the
 * NUL split is unambiguous.
 * @param {string} text
 * @returns {Array<{x: string, y: string, path: string}>}
 */
export function parsePorcelainZ(text) {
  const out = [];
  for (const rec of String(text).split('\0')) {
    if (rec.length < 4 || rec[2] !== ' ') continue;
    out.push({ x: rec[0], y: rec[1], path: rec.slice(3) });
  }
  return out;
}

/**
 * Sort entries into the loss classes `archive-check` reports. `??` is untracked,
 * `!!` ignored; otherwise X (index) and Y (worktree) say staged / unstaged —
 * deletions included (`D`).
 * @param {Array<{x: string, y: string, path: string}>} entries
 */
export function classifyEntries(entries) {
  const out = { staged: [], unstaged: [], untracked: [], ignored: [] };
  for (const e of entries) {
    if (e.x === '?' && e.y === '?') out.untracked.push(e.path);
    else if (e.x === '!' && e.y === '!') out.ignored.push(e.path);
    else {
      if (e.x !== ' ') out.staged.push(e.path);
      if (e.y !== ' ') out.unstaged.push(e.path);
    }
  }
  return out;
}

/**
 * One worktree's porcelain status.
 * @param {string} dir worktree path
 * @param {{ignored?: boolean, untrackedAll?: boolean, timeoutMs?: number, git?: typeof runGit}} [opts]
 * @returns {{queried: true, entries: object[]} | {queried: false, reason: string}}
 */
export function worktreeStatus(dir, { ignored = false, untrackedAll = true, timeoutMs = CLEAN_PROBE.timeoutMs, git = runGit } = {}) {
  // --ignore-submodules=none: a repo's submodule-ignore config must not hide a dirty submodule from a loss check.
  const args = ['status', '--porcelain=v1', '-z', '--no-renames', '--ignore-submodules=none', `--untracked-files=${untrackedAll ? 'all' : 'normal'}`];
  if (ignored) args.push('--ignored=matching');
  const r = git(args, dir, { timeoutMs });
  return r.ok ? { queried: true, entries: parsePorcelainZ(r.stdout) } : { queried: false, reason: r.reason ?? 'git status failed' };
}

/** The paths a worktree holds that are not committed (staged, unstaged, untracked; ignored excluded). */
export const uncommittedPaths = (entries) => entries.filter((e) => !(e.x === '!' && e.y === '!')).map((e) => e.path);

/**
 * Probe several worktrees within the shared budget. Sequential, the deadline
 * checked before each call, so the worst case is deadline + one timeout.
 * @param {string[]} dirs
 * @param {{clock?: () => number, probe?: (dir: string) => object, bounds?: typeof CLEAN_PROBE}} [opts]
 * @returns {Record<string, {queried: boolean, entries?: object[], reason?: string}>}
 */
export function probeWorktrees(dirs, { clock = Date.now, probe = (d) => worktreeStatus(d), bounds = CLEAN_PROBE } = {}) {
  const out = {};
  const start = clock();
  [...new Set(dirs)].forEach((d, i) => {
    if (i >= bounds.maxCandidates) { out[d] = { queried: false, reason: `probe cap of ${bounds.maxCandidates} worktrees reached` }; return; }
    if (clock() - start > bounds.deadlineMs) { out[d] = { queried: false, reason: `probe deadline of ${bounds.deadlineMs}ms reached` }; return; }
    out[d] = probe(d);
  });
  return out;
}
