/**
 * @fileoverview Default-branch publish guard for `refresh.mjs`.
 *
 * **Why (storyline, 2026-09-29).** Every refresh publishes its snapshot as the
 * repo's ACTIVE index, and the next incremental refresh anchors on it: it diffs
 * from the active snapshot's commit and copies forward every symbol of a file
 * that diff did not touch. A refresh run LOCALLY on a feature branch (3a099f75,
 * a commit that only ever existed on that branch) and an earlier
 * `workflow_dispatch` on a branch (2aea3a7c) each became the active index. The
 * scheduled refresh on `main` then diffed from those non-`main` commits, so
 * files the branch had never seen were never re-extracted, and their stale
 * symbols survived — functions moved out of a file on `main` were still indexed
 * in it. That produced 7 false duplicate clusters and failed the consumer's
 * duplication-policy CI; a full refresh (which does not anchor) reported 3.
 *
 * A workflow can refuse to run off the default branch, but a LOCAL refresh on a
 * branch could still publish, and the publishing code lives here, upstream.
 *
 * **Rule.** Publish only when HEAD is the default branch (attached), or detached
 * at a commit already contained in the default branch's tip (CI checkouts of a
 * `main` SHA). Anything else — a feature branch, a PR merge ref, a detached
 * commit `main` does not contain, or a default branch that cannot be resolved —
 * does NOT publish. The whole refresh is skipped rather than run-and-abandoned:
 * every write it makes goes to the shared store, so there is no "local part"
 * worth paying the summarise/embed cost for, and an unpublished snapshot would
 * only leave an aborted `refresh_runs` row behind.
 *
 * **Fail closed.** A git failure or an unresolvable default branch is a refusal
 * to publish, never a pass: publishing on an unanswered question is exactly
 * the defect above. `--allow-branch-publish` (or
 * `ARCH_REFRESH_ALLOW_BRANCH_PUBLISH=1`) is the explicit, logged override.
 *
 * @module scripts/symbol-index/refresh-publish-guard
 */

import { makeGitRunner, readActualIdentity } from '../lib/worktree-identity.mjs';

/** The env override. `'1'` only, matching this repo's other boolean env flags. */
export const ALLOW_BRANCH_PUBLISH_ENV = 'ARCH_REFRESH_ALLOW_BRANCH_PUBLISH';

/** Fallback names, in order, when `origin/HEAD` is not configured. */
const DEFAULT_BRANCH_FALLBACKS = Object.freeze(['main', 'master']);

/** A spawn that produced no exit status is an execution failure, not an answer. */
function execFailed(res) {
  return !res || res.error || res.status === null || res.status === undefined;
}

/** `rev-parse --verify --quiet <ref>^{commit}` → true | false | null (git failed). */
function refResolves(run, ref) {
  const res = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (execFailed(res)) return null;
  return res.status === 0;
}

/**
 * Resolve the repository's default branch and the refs that carry its tip.
 *
 * `origin/HEAD` first (the remote's own answer); when it is not configured —
 * `actions/checkout` does not set it, and plenty of clones lack it — fall back
 * to `main`, then `master`, whichever exists as a remote-tracking or local ref.
 *
 * `tips` lists every ref for that name that resolves, remote-tracking first. A
 * detached HEAD contained in EITHER is a commit of the default branch: the
 * remote ref is what CI fetched, the local ref is what a developer committed.
 *
 * @param {{run: Function}} opts
 * @returns {{ok: true, name: string, tips: string[], source: 'origin-head'|'fallback'}
 *          | {ok: false, reason: 'git-exec-failed'|'no-default-branch', detail: string}}
 */
export function resolveDefaultBranch({ run }) {
  const sym = run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (execFailed(sym) || (sym.status !== 0 && sym.status !== 1)) {
    return { ok: false, reason: 'git-exec-failed', detail: 'symbolic-ref refs/remotes/origin/HEAD failed' };
  }

  let name = null;
  let source = null;
  const target = sym.status === 0 ? String(sym.stdout || '').trim() : '';
  if (target.startsWith('refs/remotes/origin/')) {
    name = target.slice('refs/remotes/origin/'.length);
    source = 'origin-head';
  }

  const candidates = name ? [name] : DEFAULT_BRANCH_FALLBACKS;
  for (const candidate of candidates) {
    const tips = [];
    for (const ref of [`refs/remotes/origin/${candidate}`, `refs/heads/${candidate}`]) {
      const ok = refResolves(run, ref);
      if (ok === null) return { ok: false, reason: 'git-exec-failed', detail: `rev-parse ${ref} failed` };
      if (ok) tips.push(ref);
    }
    if (tips.length > 0) return { ok: true, name: candidate, tips, source: source ?? 'fallback' };
    // origin/HEAD named a branch that resolves nowhere: a broken remote state,
    // not permission to guess a different branch.
    if (source === 'origin-head') {
      return { ok: false, reason: 'no-default-branch', detail: `origin/HEAD points at ${target}, which does not resolve` };
    }
  }
  return {
    ok: false,
    reason: 'no-default-branch',
    detail: `origin/HEAD is not set and none of ${DEFAULT_BRANCH_FALLBACKS.join('/')} exists`,
  };
}

/**
 * Decide whether this refresh may publish its snapshot as the active index.
 *
 * @param {object} opts
 * @param {Function} opts.run   git runner (`makeGitRunner(repoRoot)`); injectable
 * @param {boolean} [opts.override=false]  `--allow-branch-publish` or the env flag
 * @returns {{publish: boolean, reason: string, detail: string,
 *            head: string|null, branch: string|null, defaultBranch: string|null}}
 *   `reason` is one of: `default-branch`, `detached-on-default-branch`,
 *   `override` (publish) · `not-default-branch`, `detached-off-default-branch`,
 *   `default-branch-unresolvable`, `head-unresolvable` (no publish).
 */
export function assessPublishEligibility({ run, override = false }) {
  const identity = readActualIdentity({ run });
  const head = identity.ok ? identity.identity.head : null;
  const branch = identity.ok && identity.identity.ref.kind === 'attached' ? identity.identity.ref.name : null;
  const def = resolveDefaultBranch({ run });
  const defaultBranch = def.ok ? def.name : null;
  const base = { head, branch, defaultBranch };
  const where = branch ? `branch ${branch}` : (head ? `detached HEAD ${head.slice(0, 8)}` : 'HEAD');

  if (override) {
    return { ...base, publish: true, reason: 'override', detail: `publish override set — publishing from ${where}` };
  }
  if (!identity.ok) {
    return { ...base, publish: false, reason: 'head-unresolvable', detail: `could not read HEAD (${identity.reason})` };
  }
  if (!def.ok) {
    return { ...base, publish: false, reason: 'default-branch-unresolvable', detail: def.detail };
  }
  if (branch !== null) {
    return branch === def.name
      ? { ...base, publish: true, reason: 'default-branch', detail: `on ${def.name}` }
      : { ...base, publish: false, reason: 'not-default-branch', detail: `on ${where}, not ${def.name}` };
  }

  // Detached: publish only when the default branch already CONTAINS this commit.
  // `--is-ancestor` exits 1 for a legitimate "no"; anything else is "could not
  // tell" (a shallow clone missing the history, say), and that is a refusal too.
  for (const tip of def.tips) {
    const res = run(['merge-base', '--is-ancestor', head, tip]);
    if (!execFailed(res) && res.status === 0) {
      return { ...base, publish: true, reason: 'detached-on-default-branch', detail: `${where} is contained in ${tip}` };
    }
  }
  return {
    ...base,
    publish: false,
    reason: 'detached-off-default-branch',
    detail: `${where} is not contained in ${def.tips.join(' or ')}`,
  };
}

/**
 * CLI-facing wrapper: read the override from args + env and assess `repoRoot`.
 *
 * @param {{repoRoot: string, allowBranchPublish?: boolean, env?: NodeJS.ProcessEnv, run?: Function}} opts
 */
export function checkRefreshPublishEligibility({ repoRoot, allowBranchPublish = false, env = process.env, run = makeGitRunner(repoRoot) }) {
  const override = allowBranchPublish === true || env[ALLOW_BRANCH_PUBLISH_ENV] === '1';
  return assessPublishEligibility({ run, override });
}
