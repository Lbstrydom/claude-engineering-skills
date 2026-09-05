/**
 * @fileoverview Is THIS ref behind THAT ref, and by how much — the one oracle
 * for base freshness.
 *
 * WHY THIS EXISTS (the defect class it closes). Two consumers need the same
 * fact and neither had it:
 *
 *  1. `upstream reconcile` reported terminal DB rows with no ledger entry as
 *     *"the accepted crash-window gap"* — its only explanation. Measured
 *     2026-09-05: the actual cause was a checkout **16 commits behind
 *     `origin/main`**, where all three entries already existed. The two causes
 *     take OPPOSITE remedies — write the ledger, versus `git pull` — so acting
 *     on the printed attribution would have hand-written duplicates of entries
 *     already pushed.
 *  2. A 7-round `/audit-code` run — real provider spend, ~50 minutes — executed
 *     against a base 14 commits behind origin, and nothing said so.
 *
 * A second copy of this logic is what the single-oracle rule forbids, so it
 * lives here and both callers pass the ref they actually mean.
 *
 * THE HONESTY INVARIANT (mirrors `push-range.mjs`): every result carries the
 * refs it resolved and a `reason` when it could not answer. `unknown` is never
 * collapsed into `current` — that is the false-negative direction, and it is
 * the one that matters, because a wrong `current` silently re-opens both
 * defects above.
 *
 * NEVER FETCHES. It reads the already-fetched remote-tracking ref. A gate that
 * reaches the network is a gate that fails on a plane, and `npm run check` must
 * stay offline-clean (AGENTS.md sandbox-honesty). The staleness reported is
 * therefore "since your last fetch", and callers say so in their message.
 *
 * Plan: docs/plans/reconcile-attribution-and-base-freshness.md §4.1.
 *
 * @module scripts/lib/git-freshness
 */
import { spawnSync } from 'node:child_process';

/**
 * ENFORCE the never-fetches contract rather than merely intending it
 * (code-audit R1 H4/M4). Avoiding an explicit `git fetch` is not enough: in a
 * **partial clone** git lazily fetches a missing blob on demand, so
 * `git show <ref>:<path>` can reach the network without anyone writing
 * "fetch". `GIT_NO_LAZY_FETCH=1` makes git fail instead — which surfaces as
 * `unreadable`, the honest answer, rather than a silent stall on a plane.
 *
 * The timeout is the same contract from the other side: a promise not to block
 * a gate indefinitely is only kept if something enforces it.
 */
const GIT_TIMEOUT_MS = 10_000;

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    // LC_ALL=C is belt-and-braces: no decision below reads git's prose any
    // more, but pinning the locale keeps any future diagnostic we DO surface
    // in a form an operator and a log grep can both rely on.
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

/** Closed state set — `unknown` is a real answer, never a synonym for `current`. */
export const FRESHNESS_STATE = Object.freeze({
  CURRENT: 'current',
  BEHIND: 'behind',
  UNKNOWN: 'unknown',
});

function unknown(reason, extra = {}) {
  return {
    state: FRESHNESS_STATE.UNKNOWN,
    behindBy: null,
    subject: null,
    subjectOid: null,
    upstream: null,
    upstreamOid: null,
    reason,
    ...extra,
  };
}

/**
 * Resolve the ref to compare AGAINST — deliberately its own step.
 *
 * `@{u}` IS A SUFFIX ON A BRANCH NAME, NOT ON AN ARBITRARY REV. Measured
 * 2026-09-05 against real git:
 *
 *   HEAD~1@{u}  → fatal: no such branch: 'HEAD~1'
 *   HEAD@{u}    → fatal: no upstream configured for branch '<branch>'
 *
 * The subject here is routinely `HEAD~1` (that is `/audit-code`'s dirty-aware
 * base on a clean tree), so `<subject>@{u}` is a git ERROR rather than a
 * lookup. The upstream is therefore resolved from the CURRENT BRANCH,
 * independently of the subject, and the two are reported separately so they can
 * never be conflated into one lookup.
 *
 * **`none` and `unresolvable` are different failures (code-audit R1 H2/H5).**
 * A branch with no upstream configured has ANSWERED the question — there is
 * nothing to compare against, and downstream that is determinate. A configured
 * upstream that will not resolve is a broken repo state, and treating the two
 * alike would let a broken ref read as "no remote" and license a repair. Same
 * distinction the evidence tri-state makes one level up, and the same rule:
 * fail closed when the evidence cannot settle it, not whenever an input is
 * missing.
 *
 * @returns {{ref: string|null, source: 'explicit'|'branch-upstream'|'origin-head'|'none'|'unresolvable', reason: string|null}}
 */
export function resolveUpstreamRef({ upstream = null, repoRoot = process.cwd() } = {}) {
  if (typeof upstream === 'string' && upstream.trim()) {
    return { ref: upstream.trim(), display: upstream.trim(), source: 'explicit', reason: null };
  }

  // NO MESSAGE PARSING (code-audit R3 H1/M1). Two earlier versions decided this
  // by matching git's stderr prose — first on exit codes, then on English
  // phrases — and each still failed OPEN somewhere, because a *diagnostic* is
  // not an API: `git()` inherits the caller's locale, so a translated message
  // silently stops matching and a broken upstream reads as a determinate
  // absence. That is the exact confusion this function exists to prevent, so it
  // must not be built on the one input git does not promise.
  //
  // Every question below is asked of a command with a DOCUMENTED, structured
  // answer:
  //   git symbolic-ref -q HEAD        exit 0 = on a branch, 1 = detached
  //   git config --get <key>          exit 0 = set,          1 = not set
  //   git rev-parse --verify -q <ref> exit 0 = resolves,     1 = does not
  // and any OTHER non-zero is a real failure, which is `unresolvable`.
  // FULL ref, then strip exactly `refs/heads/` (code-audit R4 H1/M2).
  // `--short` returns a *display* abbreviation — git shortens only as far as is
  // unambiguous — so it is not guaranteed to equal the `branch.<name>.*` config
  // subsection. A branch literally named `heads/x`, or one needing
  // disambiguation against a tag, would yield a config key that does not exist,
  // and the "key not set" answer would then read as "no upstream configured":
  // fail-open again, by a different route. The full ref has one exact prefix.
  const branch = git(['symbolic-ref', '-q', 'HEAD'], repoRoot);
  const fullRef = branch.status === 0 ? String(branch.stdout).trim() : '';
  if (fullRef.startsWith('refs/heads/')) {
    const name = fullRef.slice('refs/heads/'.length);
    const remote = git(['config', '--get', `branch.${name}.remote`], repoRoot);
    const merge = git(['config', '--get', `branch.${name}.merge`], repoRoot);
    // exit 1 from `config --get` is the documented "key is not set" — an
    // ANSWER, not a failure. Anything else non-zero is a failure to look.
    for (const [label, res] of [['remote', remote], ['merge', merge]]) {
      if (res.status !== 0 && res.status !== 1) {
        return { ref: null, display: null, source: 'unresolvable', reason: `branch.${name}.${label}: git exit ${res.status}` };
      }
    }
    if (remote.status === 0 && merge.status === 0) {
      // An upstream IS configured. Resolving it is a separate question, and a
      // configured-but-broken upstream must never read as "there is none".
      const u = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot);
      if (u.status === 0 && String(u.stdout).trim()) {
        const ref = String(u.stdout).trim();
        return { ref, display: ref, source: 'branch-upstream', reason: null };
      }
      return {
        ref: null,
        source: 'unresolvable',
        reason: `branch.${name} has an upstream configured (${String(remote.stdout).trim()}/${String(merge.stdout).trim()}) that does not resolve`,
      };
    }
    // Neither key set ⇒ no upstream configured. Determinate.
  } else if (branch.status !== 0 && branch.status !== 1) {
    return { ref: null, display: null, source: 'unresolvable', reason: `symbolic-ref HEAD: git exit ${branch.status}` };
  }

  // Fallback: the remote's default branch — asked as TWO questions, because
  // "not configured" and "configured but broken" are the same distinction this
  // function exists to make, and one exit code cannot carry both (code-audit
  // R4 M1). `symbolic-ref -q` on the remote HEAD answers the first (0 =
  // configured, 1 = not); resolving its target answers the second.
  const oSym = git(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], repoRoot);
  if (oSym.status !== 0 && oSym.status !== 1) {
    return { ref: null, display: null, source: 'unresolvable', reason: `refs/remotes/origin/HEAD: git exit ${oSym.status}` };
  }
  if (oSym.status === 0 && String(oSym.stdout).trim()) {
    const target = String(oSym.stdout).trim();               // refs/remotes/origin/<branch>
    const verify = git(['rev-parse', '--verify', '-q', `${target}^{commit}`], repoRoot);
    if (verify.status === 0) {
      // RETURN WHAT WAS VERIFIED (code-audit R5 H1/H2). Stripping the namespace
      // to `origin/main` returns a DIFFERENT, ambiguous name than the one just
      // checked: a tag or a local branch literally called `origin/main` would
      // make a later resolution pick something else, so the identity verified
      // and the identity used would not be the same ref. `display` carries the
      // readable short form for messages; `ref` is what git is asked about.
      return {
        ref: target,
        display: target.replace(/^refs\/remotes\//, ''),
        source: 'origin-head',
        reason: null,
      };
    }
    // Configured and dangling: a real broken state, never a determinate absence.
    return { ref: null, display: null, source: 'unresolvable', reason: `origin/HEAD points at ${target}, which does not resolve` };
  }
  return { ref: null, display: null, source: 'none', reason: null };
}

/**
 * Is `subject` behind `upstream`?
 *
 * @param {object}  [args]
 * @param {string}  [args.subject='HEAD']  the ref the CALLER means — for
 *   `/audit-code` this is the resolved diff base (`HEAD` or `HEAD~1`), which is
 *   why it is a parameter and not hard-coded.
 * @param {string|null} [args.upstream]    explicit comparison ref; when absent
 *   it is resolved by `resolveUpstreamRef`.
 * @param {string}  [args.repoRoot]
 * @returns {{state: string, behindBy: number|null, subject: string|null,
 *   subjectOid: string|null, upstream: string|null, upstreamOid: string|null,
 *   reason: string|null}}
 *   `subjectOid`/`upstreamOid` are resolved at the same instant as the
 *   comparison and returned, so a caller that later MUTATES state can prove it
 *   is acting on the commits it measured (see `--apply`'s precondition token).
 */
export function resolveBaseFreshness({ subject = 'HEAD', upstream = null, repoRoot = process.cwd() } = {}) {
  const inside = git(['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (inside.status !== 0) return unknown('not-a-work-tree');

  // A SHALLOW repository cannot answer a distance question: history is
  // truncated, so `rev-list --count` returns a number that is not the real
  // distance (code-audit R1 H3). A confidently wrong count is worse than
  // `unknown` here — it is the same false-`current` direction this module
  // exists to prevent, wearing a plausible integer.
  //
  // The probe must CONFIRM completeness, not merely fail to report shallowness
  // (code-audit R2 M1). Handling only `status === 0 && 'true'` lets a timeout,
  // a non-zero exit, or an unexpected answer fall through as if history were
  // complete — asserting the thing it could not establish. Only a positive
  // `false` clears it.
  const shallow = git(['rev-parse', '--is-shallow-repository'], repoRoot);
  const shallowAnswer = shallow.status === 0 ? String(shallow.stdout).trim() : null;
  if (shallowAnswer !== 'false') {
    return unknown(shallowAnswer === 'true' ? 'shallow-repository' : 'shallowness-unverified', { subject });
  }

  const { ref: upstreamRef, display: upstreamDisplay, source, reason: upstreamReason } = resolveUpstreamRef({ upstream, repoRoot });
  if (!upstreamRef) {
    // `none` is determinate (nothing to compare against); `unresolvable` is a
    // broken repo state. Downstream treats them differently, so they must not
    // arrive as the same reason.
    return unknown(source === 'unresolvable' ? 'upstream-unresolvable' : 'no-upstream',
      { subject, ...(upstreamReason ? { detail: upstreamReason } : {}) });
  }

  // THE DEFAULT UPSTREAM IS ONLY MEANINGFUL FOR A SUBJECT ON THIS BRANCH.
  // Falling back to the current branch's upstream is right for the callers here
  // — the audit base is HEAD or HEAD~1 — but it is the wrong comparison for an
  // arbitrary subject on unrelated history, where the two refs may have no
  // useful relationship at all. Report `unknown` rather than a confidently
  // wrong distance. An EXPLICIT upstream means the caller already decided what
  // to compare against, so the check does not apply.
  if (source !== 'explicit') {
    const onBranch = git(['merge-base', '--is-ancestor', subject, 'HEAD'], repoRoot);
    // Exit 1 is a legitimate FALSE here; anything else is "could not tell".
    // Both are `unknown`, but they are different reasons and say so.
    if (onBranch.status === 1) return unknown('subject-not-on-current-branch', { subject, upstream: upstreamRef });
    if (onBranch.status !== 0) return unknown('ancestry-unresolvable', { subject, upstream: upstreamRef });
  }

  const subjectRes = git(['rev-parse', '--verify', `${subject}^{commit}`], repoRoot);
  if (subjectRes.status !== 0) return unknown('subject-unresolvable', { subject, upstream: upstreamRef });
  const upstreamRes = git(['rev-parse', '--verify', `${upstreamRef}^{commit}`], repoRoot);
  if (upstreamRes.status !== 0) return unknown('upstream-unresolvable', { subject, upstream: upstreamRef });
  const subjectOid = String(subjectRes.stdout).trim();
  const upstreamOid = String(upstreamRes.stdout).trim();

  // COUNT BETWEEN THE PINNED OIDs, not the ref names (code-audit R1 H1/M3).
  // The result reports `subjectOid`/`upstreamOid` as the commits it measured,
  // so a caller can bind a later mutation to them — but if the count itself
  // re-resolved `HEAD` and `origin/main`, a concurrent session moving either
  // between the two calls would produce a distance describing commits the
  // result does not name. HEAD moved 16 times in this worktree during one
  // sitting, so this is not a theoretical window.
  const count = git(['rev-list', '--count', `${subjectOid}..${upstreamOid}`], repoRoot);
  if (count.status !== 0) return unknown('count-unresolvable', { subject, upstream: upstreamRef });
  const n = Number.parseInt(String(count.stdout).trim(), 10);
  if (!Number.isFinite(n)) return unknown('count-unparseable', { subject, upstream: upstreamRef });

  return {
    state: n > 0 ? FRESHNESS_STATE.BEHIND : FRESHNESS_STATE.CURRENT,
    behindBy: n,
    subject,
    subjectOid,
    upstream: upstreamDisplay || upstreamRef,
    upstreamRef,
    upstreamOid,
    reason: null,
  };
}

/**
 * The upstream copy of a tracked file, as a THREE-WAY fact.
 *
 * `absent` (the ref genuinely has no such file) and `unreadable` (the read
 * failed) are DIFFERENT, and collapsing them into "empty content" is INC-001's
 * lesson one level down: an empty result produced by a failed read looks
 * exactly like a clean upstream, and would route an operator straight into a
 * repair they must not run.
 *
 * @returns {{status: 'read'|'absent'|'unreadable', content: string|null, reason: string|null}}
 */
export function readFileAtRef({ ref, filePath, repoRoot = process.cwd() }) {
  if (!ref) return { status: 'unreadable', content: null, reason: 'no-ref' };
  const r = git(['show', `${ref}:${filePath}`], repoRoot);
  if (r.status === 0) return { status: 'read', content: String(r.stdout), reason: null };

  // ABSENT vs UNREADABLE is decided by `cat-file -e`, not by reading git's
  // prose (code-audit R3 H1). `-e` exits 0 when the object exists and non-zero
  // when it does not, which is a structured answer that survives a translated
  // locale; the message match this replaced would have silently stopped
  // classifying and sent every absence down the `unreadable` path.
  //
  // The ref itself must resolve first: a bad REF and a missing PATH both make
  // `show` fail, and only the second is an absence.
  const refOk = git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], repoRoot);
  if (refOk.status !== 0) {
    return { status: 'unreadable', content: null, reason: `ref ${ref} does not resolve` };
  }
  const exists = git(['cat-file', '-e', `${ref}:${filePath}`], repoRoot);
  if (exists.status !== 0) return { status: 'absent', content: null, reason: null };
  // The path IS there but `show` failed — a real read failure (a partial clone
  // refusing to lazily fetch the blob is exactly this, and is why it must not
  // be reported as an absence).
  return {
    status: 'unreadable',
    content: null,
    reason: `${ref}:${filePath} exists but could not be read (git exit ${r.status})`,
  };
}
