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

/** The largest timeout a child process honours: Node's timers are 32-bit signed ms; above it the value is not a bound. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The operator's knob for a slow disk (a cold cache, an on-access scanner): the per-call `git status` timeout, in ms. */
export const GIT_STATUS_TIMEOUT_ENV = 'FLEET_GIT_STATUS_TIMEOUT_MS';

/**
 * `CLEAN_PROBE` with the per-call timeout `GIT_STATUS_TIMEOUT_ENV` sets. Measured 2026-11-25: one `git status` of a
 * 4k-file checkout costs ~130 ms warm, whatever the flags, yet a VS Code host smoke run saw several pass 5000 ms — the
 * cost is the machine's, not the invocation's, so the fix is a knob, not a guess at a bigger constant. The aggregate
 * deadline grows with it so a raised timeout still admits at least one probe. Unset, empty, not a positive integer, or
 * above 2^31-1 ms ⇒ the defaults (an unparseable value must not silently become 0, which spawnSync reads as "no
 * timeout", nor a value the timer cannot hold).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{timeoutMs: number, maxCandidates: number, deadlineMs: number, configured: boolean}}
 */
export function cleanProbeBounds(env = process.env) {
  const raw = String(env?.[GIT_STATUS_TIMEOUT_ENV] ?? '').trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(Number.isSafeInteger(n) && n > 0 && n <= MAX_TIMEOUT_MS)) return { ...CLEAN_PROBE, configured: false };
  return { timeoutMs: n, maxCandidates: CLEAN_PROBE.maxCandidates, deadlineMs: Math.max(CLEAN_PROBE.deadlineMs, n), configured: true };
}

/** A timed-out probe's reason names the knob, so "unmeasured" comes with its remedy. Other failures pass through. */
export function probeFailureReason(reason) {
  const r = reason ?? 'git status failed';
  return /timed out/.test(r) ? `${r} — unmeasured, not clean (set ${GIT_STATUS_TIMEOUT_ENV} to allow longer)` : r;
}

/**
 * The two `git status` argv lists the loss checks run, spelled ONCE: `archiveReport` captures with them and
 * `fleet archive` revalidates with them, so a capture and its re-check cannot be spelled differently.
 * `--ignore-submodules=none`: a repo's submodule-ignore config must not hide a dirty submodule. The ignored
 * listing collapses ignored directories (`node_modules/` is one line, not 100k), so it stays bounded.
 */
export const STATUS_ARGS = Object.freeze(['status', '--porcelain=v1', '-z', '--no-renames', '--ignore-submodules=none', '--untracked-files=all']);
export const IGNORED_STATUS_ARGS = Object.freeze(['status', '--porcelain=v1', '-z', '--no-renames', '--ignored=traditional', '--untracked-files=normal']);

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
export function worktreeStatus(dir, { ignored = false, untrackedAll = true, timeoutMs = cleanProbeBounds().timeoutMs, git = runGit } = {}) {
  // --ignore-submodules=none: a repo's submodule-ignore config must not hide a dirty submodule from a loss check.
  const args = ['status', '--porcelain=v1', '-z', '--no-renames', '--ignore-submodules=none', `--untracked-files=${untrackedAll ? 'all' : 'normal'}`];
  if (ignored) args.push('--ignored=matching');
  const r = git(args, dir, { timeoutMs });
  return r.ok ? { queried: true, entries: parsePorcelainZ(r.stdout) } : { queried: false, reason: probeFailureReason(r.reason) };
}

/** The paths a worktree holds that are not committed (staged, unstaged, untracked; ignored excluded). */
export const uncommittedPaths = (entries) => entries.filter((e) => !(e.x === '!' && e.y === '!')).map((e) => e.path);

/**
 * Probe several worktrees within the shared budget. Sequential, the deadline
 * checked before each call, so the worst case is deadline + one timeout.
 * `deadlineAt` (epoch ms) lets several sweeps share ONE budget — `gatherFacts` runs two
 * (session worktrees, then cleanliness) and must not pay two deadlines; omitted, the
 * sweep's own `bounds.deadlineMs` from its start. Each probe is handed `{timeoutMs}`, the per-call timeout clipped to the
 * budget left, so the sweep ends within its deadline (plus process start-up), not deadline + one full timeout.
 * `bounds` defaults to `cleanProbeBounds()` (the environment's knob).
 * @param {string[]} dirs
 * @param {{clock?: () => number, probe?: (dir: string, o: {timeoutMs: number}) => object, bounds?: typeof CLEAN_PROBE, deadlineAt?: number|null}} [opts]
 * @returns {Record<string, {queried: boolean, entries?: object[], reason?: string}>}
 */
export function probeWorktrees(dirs, { clock = Date.now, bounds = cleanProbeBounds(), deadlineAt = null, git = runGit, probe = (d, o) => worktreeStatus(d, { timeoutMs: o.timeoutMs, git }) } = {}) {
  const out = {};
  const until = deadlineAt ?? clock() + bounds.deadlineMs;
  [...new Set(dirs)].forEach((d, i) => {
    if (i >= bounds.maxCandidates) { out[d] = { queried: false, reason: `probe cap of ${bounds.maxCandidates} worktrees reached` }; return; }
    if (clock() > until) { out[d] = { queried: false, reason: `probe deadline of ${bounds.deadlineMs}ms reached — unmeasured, not clean` }; return; }
    out[d] = probe(d, { timeoutMs: Math.max(1, Math.min(bounds.timeoutMs, until - clock())) });
  });
  return out;
}
