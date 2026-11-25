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
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // A NUL-delimited listing is data, not text: trimming it would eat leading whitespace of the first path.
    return (args.includes('-z') ? out : out.trim()) || null;
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
 * An explicit range is ANCHORED at `merge-base(BASE, HEAD)` (opt out with
 * `anchor: 'verbatim'`). Every gate diffs `base..head`, and `git diff A..B` is
 * TWO-dot: it compares the two trees, not "what B added since it left A". When
 * HEAD is behind BASE (a PR branch behind main: CI hands BASE = main's tip),
 * main's newer changes appear REVERSED, as the branch's own added lines.
 * Measured 2026-11-24 on PR #515: static-gates went red on an undispositioned
 * `[ship]` line that existed only in main's pre-#514 text, and a rebase with no
 * other change made it green; the same reversal can also HIDE a real line. When
 * BASE is an ancestor of HEAD (every fast-forward push) the merge-base IS the
 * base, and the base is returned exactly as given. Each of these is a hard
 * failure: a SHALLOW checkout, where git can return a non-best ancestor
 * (`shallow-history`); a merge-base git cannot compute, e.g. unrelated histories
 * (`no-merge-base`); a criss-cross history with several best common ancestors
 * (`ambiguous-merge-base`). Never a demotion to the verbatim two-dot range, a
 * silent pick, or inference. `requestedBase` carries the base as given
 * whenever it was moved.
 *
 * THE CONTRACT this gives every gate is "what HEAD added since it left BASE's
 * history", NOT "the net delta between two tips". They differ on a force push
 * whose base is the OLD remote tip (CES's own hook; the consumer hook already
 * sends `merge-base origin/main <pushed>` on rewritten history): a line the
 * common ancestor had, the old tip deleted and the new head keeps is NOT reported
 * (it is not the branch's own line), while a line the rebased head adds is. Both
 * cases are pinned in tests/push-range-merge-base.test.mjs.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(args: string[]) => string|null} [opts.run] injected git runner (tests)
 * @param {boolean} [opts.requireExplicit] fail instead of inferring
 * @param {string} [opts.defaultBranch] used for the fork-point fallback
 * @param {'merge-base'|'verbatim'} [opts.anchor] how an EXPLICIT base is used: 'merge-base' (default) diffs what HEAD added
 *   since it left BASE; 'verbatim' keeps BASE as given, for a caller that judges against the base TIP on purpose (gate-provenance)
 * @returns {{ok: true, base: string, head: string, source: PushRangeSource, trusted: boolean, requestedBase?: string}
 *          | {ok: false, reason: 'invalid-explicit'|'unresolvable-explicit'|'shallow-history'|'no-merge-base'|'ambiguous-merge-base'|'invalid-anchor'|'inference-forbidden'|'no-base', message: string}}
 */
export function resolvePushRange(opts = {}) {
  const {
    env = process.env,
    run = defaultRun,
    defaultBranch = 'origin/main',
    anchor = 'merge-base',
  } = opts;
  if (anchor !== 'merge-base' && anchor !== 'verbatim') {
    return { ok: false, reason: 'invalid-anchor', message: `anchor must be 'merge-base' or 'verbatim', got ${JSON.stringify(anchor)}` };
  }
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
    const baseSha = run(['rev-parse', '--verify', '--quiet', `${rawBase}^{commit}`]);
    if (!baseSha) {
      return {
        ok: false,
        reason: 'unresolvable-explicit',
        message: `${PUSH_RANGE_ENV.BASE}=${rawBase} does not resolve to a commit in this checkout`,
      };
    }
    if (anchor === 'verbatim') return { ok: true, base: rawBase, head: rawHead, source: 'explicit', trusted: true };
    // Two-dot `git diff base..head` against a base HEAD is behind reads the base's newer lines as HEAD's own, reversed.
    // Behind a shallow boundary git can return a common ancestor that is not the best one: the answer is a guess, so refuse it.
    if (run(['rev-parse', '--is-shallow-repository']) === 'true') {
      return {
        ok: false,
        reason: 'shallow-history',
        message: `this checkout is shallow, so merge-base(${rawBase}, ${rawHead}) may not be the best common ancestor; fetch full history (actions/checkout fetch-depth: 0) or pass anchor 'verbatim' only where the base tip is meant`,
      };
    }
    const bases = (run(['merge-base', '--all', rawBase, rawHead]) ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (bases.length === 0) {
      return {
        ok: false,
        reason: 'no-merge-base',
        message: `git cannot compute merge-base(${rawBase}, ${rawHead}) in this checkout (shallow clone, unrelated histories, or an unresolvable head); refusing to diff the two-dot range, which reads the base's newer changes as the head's own`,
      };
    }
    // A criss-cross history has several best common ancestors, and each gives a different diff: picking one silently is a guess.
    if (bases.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous-merge-base',
        message: `merge-base(${rawBase}, ${rawHead}) is ambiguous: ${bases.length} best common ancestors (criss-cross merges); refusing to pick one, since each gives a different diff. Inspect the two histories (git merge-base --all) before choosing a recovery: ${rawBase} may be an old remote tip, not the branch's integration base`,
      };
    }
    const mergeBase = bases[0];
    if (mergeBase === baseSha) return { ok: true, base: rawBase, head: rawHead, source: 'explicit', trusted: true };
    return { ok: true, base: mergeBase, head: rawHead, source: 'explicit', trusted: true, requestedBase: rawBase };
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
 * Files the pushed BRANCH itself changed, as opposed to files that merely arrived in the range through a merge of the default
 * branch. `base..head` is what the remote receives, so for a merge-commit push it also holds everything main gained since the
 * remote tip: measured live (storyline, 2026-10-23), a 149 KB plan that main had landed was selected as "the plan this push
 * changed" and audited, for 15 minutes. The branch's own work is (a) the NON-merge commits of the range that the default branch
 * does not already contain, plus (b) what each merge commit AUTHORED itself - a conflict resolution or an "evil merge" change, i.e.
 * the paths its combined diff (`--cc`) shows against ALL parents.
 *
 * This takes the range RESOLVED by `resolvePushRange` and infers nothing about it: `defaultRef` only EXCLUDES commits, it is
 * never a base. Scoping is conservative in one direction only: when it cannot tell (no merge in the range, the default ref does
 * not resolve, any git call fails) it returns the whole diff with `scoped:false`, never a narrower list that could read as
 * "nothing changed". Paths are read NUL-delimited (`-z`): git C-quotes a non-ASCII or special-character path otherwise, and the
 * quoted spelling is not a file.
 *
 * @param {{base: string, head: string}} range
 * @param {{defaultRef?: string, run?: (args: string[]) => string|null}} [opts]
 * @returns {{files: string[], scoped: boolean, excluded: number, reason?: string} | null} `null` when git cannot say
 */
export function branchOwnedChangedFiles(range, opts = {}) {
  const { defaultRef = 'origin/main', run = defaultRun } = opts;
  const span = `${range.base}..${range.head}`;
  const paths = (out) => (out ?? '').split('\0').filter(Boolean);
  // Only the `--format=%x01%H` header token of the merge listing is metadata; a path is never filtered on a byte it merely starts with.
  const MERGE_HEADER = /^\x01[0-9a-f]{40,64}$/;
  const all = run(['diff', '--name-only', '-z', span]);
  if (all === null) return null;
  const everything = paths(all);
  const unscoped = (reason) => ({ files: everything, scoped: false, excluded: 0, reason });
  const merges = run(['rev-list', '--merges', '--count', span]);
  if (merges === null) return unscoped('merge-count-unavailable');
  if (Number(merges) === 0) return unscoped('no-merge-in-range');
  if (!isSafeGitRevision(defaultRef) || !run(['rev-parse', '--verify', '--quiet', `${defaultRef}^{commit}`])) {
    return unscoped('default-ref-unresolvable');
  }
  // `run` reads empty output as null, the same value as a failure. "The branch has no commits of its own" is the exact case this
  // function exists for (a pure merge of main), so COUNT first: a count is never empty, and 0 is a real answer.
  const ownCount = run(['rev-list', '--count', '--no-merges', span, '--not', defaultRef]);
  if (ownCount === null) return unscoped('own-count-unavailable');
  const ownSet = new Set();
  if (Number(ownCount) > 0) {
    const own = run(['log', '--no-merges', '--name-only', '-z', '--format=', span, '--not', defaultRef]);
    // Own commits that changed no file (empty commits) also print nothing: undecidable from here, so keep the whole diff.
    if (own === null) return unscoped('own-log-unavailable');
    for (const f of paths(own)) ownSet.add(f);
  }
  // What the merges themselves wrote. The \x01<sha> marker makes every merge print a line, so a clean merge (no authored file) is
  // not mistaken for a failed command.
  const authored = run(['log', '--merges', '--cc', '--name-only', '-z', '--format=%x01%H', span]);
  if (authored === null) return unscoped('merge-authored-unavailable');
  for (const f of paths(authored)) if (!MERGE_HEADER.test(f)) ownSet.add(f);
  const files = everything.filter((f) => ownSet.has(f)); // a path the branch touched and then restored is not in `everything`
  return { files, scoped: true, excluded: everything.length - files.length };
}

/** Reasons that mean a range WAS given explicitly and is unusable, as opposed to none being given. */
const EXPLICIT_FAILURE_REASONS = new Set(['invalid-explicit', 'unresolvable-explicit', 'shallow-history', 'no-merge-base', 'ambiguous-merge-base', 'invalid-anchor']);

/**
 * Did the caller HAND this resolver a range it could not use? Such a range names a specific commit, so a caller that would read
 * the working tree when no range is given must not do so here: that would judge a different tree than the one named.
 *
 * @param {ReturnType<typeof resolvePushRange>} r
 * @returns {boolean}
 */
export function isExplicitRangeFailure(r) {
  return !r.ok && EXPLICIT_FAILURE_REASONS.has(r.reason);
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
  const anchored = r.requestedBase ? `, merge-base of ${r.requestedBase}` : '';
  return `${r.base}..${r.head} [${r.source}${r.trusted ? '' : ', inferred'}${anchored}]`;
}

/** @internal test seam */
export const _internals = { defaultRun, TRUSTED_SOURCES };
