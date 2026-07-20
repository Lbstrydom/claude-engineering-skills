/**
 * @fileoverview Single source of truth for "which commits is this push about?".
 *
 * WHY THIS EXISTS (the defect class it closes):
 * Drift-scoped gates need a base revision to diff against. Before this module,
 * each gate INFERRED one independently from working-tree state — typically
 * `@{u}`, else `git status --porcelain` dirty ? 'HEAD' : 'HEAD~1'. That
 * inference has two failure modes, and both are silent:
 *
 *   1. MULTI-COMMIT PUSH. `HEAD~1` scopes the gate to the tip commit only, so
 *      a violation in any earlier un-pushed commit sails through. The gate
 *      reports "clean" having read one commit of five.
 *   2. DETACHED / CLEAN CHECKOUT. In a worktree built from the pushed sha
 *      there is no upstream and the tree is never dirty, so the inference
 *      collapses to `HEAD~1` unconditionally — same narrowing, but now it
 *      happens on EVERY push rather than occasionally.
 *
 * git already knows the answer. A pre-push hook receives
 * `<local_ref> <local_sha> <remote_ref> <remote_sha>` on stdin — the exact
 * range the remote is about to receive. This module makes that authoritative
 * answer the primary path and demotes inference to a labelled fallback.
 *
 * THE HONESTY INVARIANT: every result carries `source` and `trusted`. A gate
 * that narrowed its scope because it had to guess must be able to SAY so.
 * `requireExplicit` turns guessing into a hard error for callers (the
 * sandboxed pre-push runner) that have no legitimate reason to guess.
 *
 * @module scripts/lib/push-range
 */
import { execFileSync } from 'node:child_process';
import { isSafeGitRevision } from './vcs.mjs';

/** Env vars the pre-push hook uses to hand the real range to the gates. */
export const PUSH_RANGE_ENV = Object.freeze({
  BASE: 'AUDIT_PUSH_RANGE_BASE',
  HEAD: 'AUDIT_PUSH_RANGE_HEAD',
  /** Set to '1' to make inference a hard error rather than a fallback. */
  REQUIRED: 'AUDIT_PUSH_RANGE_REQUIRED',
});

/**
 * How the range was determined, most to least trustworthy. Only `explicit` is
 * `trusted` — everything else is a guess that may under-scope the gate.
 *
 * @typedef {'explicit'|'upstream'|'fork-point'|'previous-commit'} PushRangeSource
 */

/** Sources that reflect what git actually said about the push. */
const TRUSTED_SOURCES = new Set(['explicit']);

function defaultRun(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the commit range being pushed.
 *
 * Precedence:
 *   1. `AUDIT_PUSH_RANGE_BASE` / `_HEAD`  — set by the pre-push hook from its
 *      own stdin. Authoritative; covers multi-commit and first-push cases.
 *   2. `@{upstream}`                       — correct when a tracking branch exists.
 *   3. fork-point vs the default branch    — correct for an unpushed branch.
 *   4. `HEAD~1`                            — last resort; scopes to one commit.
 *
 * A base supplied via env is VALIDATED (shape + resolvability). An explicit
 * base that does not resolve is a hard failure, never a silent demotion to
 * inference — the caller asked for a specific range and must not be handed a
 * narrower one while being told everything is fine.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(args: string[]) => string|null} [opts.run] injected git runner (tests)
 * @param {boolean} [opts.requireExplicit] fail instead of inferring
 * @param {string} [opts.defaultBranch] used for the fork-point fallback
 * @returns {{ok: true, base: string, head: string, source: PushRangeSource, trusted: boolean}
 *          | {ok: false, reason: 'invalid-explicit'|'unresolvable-explicit'|'inference-forbidden'|'no-base', message: string}}
 */
export function resolvePushRange(opts = {}) {
  const {
    env = process.env,
    run = defaultRun,
    defaultBranch = 'origin/main',
  } = opts;
  const requireExplicit = opts.requireExplicit
    ?? (env[PUSH_RANGE_ENV.REQUIRED] ?? '').trim() === '1';

  const rawBase = (env[PUSH_RANGE_ENV.BASE] ?? '').trim();
  const rawHead = (env[PUSH_RANGE_ENV.HEAD] ?? '').trim() || 'HEAD';

  if (rawBase) {
    // Shape-check both ends before they reach a git argv. These arrive from the
    // hook's stdin, which git controls — but a gate that will diff whatever it
    // is handed should not be the place we start trusting unvalidated input.
    if (!isSafeGitRevision(rawBase) || !isSafeGitRevision(rawHead)) {
      return {
        ok: false,
        reason: 'invalid-explicit',
        message: `${PUSH_RANGE_ENV.BASE}/${PUSH_RANGE_ENV.HEAD} is not a well-formed git revision (base=${JSON.stringify(rawBase)}, head=${JSON.stringify(rawHead)})`,
      };
    }
    // Resolvability is separate from shape: a well-formed sha that this
    // checkout does not contain would make `git diff` fail later, at a point
    // where the caller has already decided the range is good.
    if (!run(['rev-parse', '--verify', '--quiet', `${rawBase}^{commit}`])) {
      return {
        ok: false,
        reason: 'unresolvable-explicit',
        message: `${PUSH_RANGE_ENV.BASE}=${rawBase} does not resolve to a commit in this checkout`,
      };
    }
    return { ok: true, base: rawBase, head: rawHead, source: 'explicit', trusted: true };
  }

  if (requireExplicit) {
    return {
      ok: false,
      reason: 'inference-forbidden',
      message: `${PUSH_RANGE_ENV.BASE} is unset and ${PUSH_RANGE_ENV.REQUIRED}=1 — refusing to infer a range that could silently under-scope this gate`,
    };
  }

  const upstream = run(['rev-parse', '--verify', '--quiet', '@{upstream}']);
  if (upstream) return { ok: true, base: '@{upstream}', head: rawHead, source: 'upstream', trusted: false };

  // No tracking branch: an unpushed branch's true base is where it left the
  // default branch, NOT the previous commit.
  const forkPoint = run(['merge-base', defaultBranch, 'HEAD']);
  if (forkPoint) return { ok: true, base: forkPoint, head: rawHead, source: 'fork-point', trusted: false };

  const parent = run(['rev-parse', '--verify', '--quiet', 'HEAD~1']);
  if (parent) return { ok: true, base: 'HEAD~1', head: rawHead, source: 'previous-commit', trusted: false };

  // Root commit, or not a repo. There is no range; the caller must decide
  // whether that means "gate on everything" or "gate on nothing" — this
  // module will not pick a default that could read as clean.
  return { ok: false, reason: 'no-base', message: 'no base revision available (root commit, or not a git repository)' };
}

/**
 * Human-readable one-liner for a resolved range, for gate summary lines.
 * Always names the source so an under-scoped run is visible in the log.
 *
 * @param {ReturnType<typeof resolvePushRange>} r
 * @returns {string}
 */
export function describePushRange(r) {
  if (!r.ok) return `unresolved (${r.reason})`;
  return `${r.base}..${r.head} [${r.source}${r.trusted ? '' : ', inferred'}]`;
}

/** @internal test seam */
export const _internals = { defaultRun, TRUSTED_SOURCES };
