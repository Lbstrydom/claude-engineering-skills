/**
 * @fileoverview "Is this branch the SAME PATCHES the audit read?" - ONE predicate for the two places that ask it.
 *
 * Both consumers of an audit marker identify the audited code by a commit or a tree, and a rebase onto a moved main changes both
 * while leaving the branch's own work untouched:
 *   - the consumer pre-push hook's audit REUSE (`prepush-step.mjs audit-reuse`) keys on the pushed commit's TREE, so a squash-
 *     divergence cherry-pick recovery re-ran a ~14 minute audit over a branch whose own diff had not changed (fleet p-...-eb21);
 *   - `/ship`'s AI-Gate provenance (`commit-trailers.mjs checkEvidenceProvenance`) refuses a marker whose audited sha is no longer
 *     an ancestor of HEAD, so a ship that only rebased recorded `not-run` (fleet p-...-f757).
 * They share this predicate rather than each growing a spelling of it: two spellings of "equivalent" is how a reuse accepts what
 * a provenance check refuses.
 *
 * The rule is `git range-diff`'s own: the branch's OWN non-merge commits (those the default branch does not contain) are compared
 * by `git patch-id --stable`, as a multiset, between the audited tip and the pushed tip. Equal means every audited change is in
 * the push, byte-for-byte as a patch, and nothing else is. It deliberately says NOTHING about whether the patches still behave
 * the same on the new base - that is the accepted residual risk of rebasing at all, and the caller says "range-diff-equivalent" in
 * its output rather than "same tree" so the weaker claim is never worn as the stronger one.
 *
 * Conservative in every direction it can be: an unresolvable ref, a commit with an empty/uncomparable diff, a count above the cap,
 * zero own commits (nothing to compare is not equality), or ANY git failure is "not equivalent" with the reason named.
 *
 * @module scripts/lib/patch-equivalence
 */
import { spawnSync } from 'node:child_process';
import { isSafeGitRevision } from './vcs.mjs';

/** More own commits than this is not compared: patch-id is O(diff), and a branch that long is not a rebase-recovery case. */
export const MAX_COMPARED_COMMITS = 200;
/** Per git call. A comparison must never be able to hang the hook (the caller bounds the whole step too). */
const GIT_TIMEOUT_MS = 20_000;
const OBJECT_ID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * @param {string} cwd
 * @returns {(args: string[], input?: string) => string|null} stdout, or null on ANY failure (spawn error, non-zero, timeout)
 */
export function makeGit(cwd) {
  return (args, input) => {
    const r = spawnSync('git', args, {
      cwd, encoding: 'utf8', input, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
    });
    return r.error || r.status !== 0 ? null : r.stdout;
  };
}

/**
 * Patch ids of the non-merge commits reachable from `rev` and not from `defaultRef`.
 * @param {string} rev
 * @param {{defaultRef: string, git: (args: string[], input?: string) => string|null}} ctx
 * @returns {{ok: true, ids: string[]} | {ok: false, reason: string}}
 */
export function ownPatchIds(rev, { defaultRef, git }) {
  if (!isSafeGitRevision(rev)) return { ok: false, reason: `${JSON.stringify(rev)} is not a well-formed git revision` };
  if (!isSafeGitRevision(defaultRef) || git(['rev-parse', '--verify', '--quiet', `${defaultRef}^{commit}`]) === null) {
    return { ok: false, reason: `the default ref ${defaultRef} does not resolve in this checkout, so the branch's own commits cannot be told from main's` };
  }
  if (git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) === null) return { ok: false, reason: `${rev} does not resolve to a commit in this checkout` };
  const countOut = git(['rev-list', '--count', '--no-merges', rev, '--not', defaultRef]);
  const count = countOut === null ? NaN : Number(countOut.trim());
  if (!Number.isInteger(count)) return { ok: false, reason: `the own-commit count for ${rev} could not be read` };
  if (count === 0) return { ok: true, ids: [] };
  if (count > MAX_COMPARED_COMMITS) return { ok: false, reason: `${count} own commits exceed the ${MAX_COMPARED_COMMITS} that are compared` };
  const log = git(['log', '-p', '--no-merges', '--no-color', rev, '--not', defaultRef]);
  if (log === null) return { ok: false, reason: `the patches of ${rev} could not be read` };
  const out = git(['patch-id', '--stable'], log);
  if (out === null) return { ok: false, reason: `git patch-id failed over ${rev}` };
  const ids = out.split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean);
  // A commit with no diff (an empty commit) produces no patch id: fewer ids than commits means one cannot be compared.
  if (ids.length !== count) return { ok: false, reason: `${count - ids.length} of ${count} own commit(s) of ${rev} have no comparable patch (empty or unreadable diff)` };
  return { ok: true, ids };
}

/**
 * Are the branch's own patches at `headRef` exactly the ones at `auditedRef`?
 *
 * `expectedAuditedTree` (when given) must be the tree of `auditedRef` itself: an audit of an UNCOMMITTED tree records the parent as
 * its sha, and that sha's commits do not contain what the audit read, so comparing them proves nothing about it.
 *
 * @param {{auditedRef: string, headRef: string, defaultRef?: string, expectedAuditedTree?: string|null, cwd?: string, git?: (args: string[], input?: string) => string|null}} input
 * @returns {{equivalent: true, commits: number} | {equivalent: false, reason: string}}
 */
export function patchRangesEquivalent({ auditedRef, headRef, defaultRef = 'origin/main', expectedAuditedTree = null, cwd = process.cwd(), git = makeGit(cwd) }) {
  if (expectedAuditedTree !== null) {
    const tree = git(['rev-parse', '--verify', '--quiet', `${auditedRef}^{tree}`]);
    if (!OBJECT_ID_RE.test(String(expectedAuditedTree)) || tree === null || tree.trim() !== expectedAuditedTree) {
      return { equivalent: false, reason: 'the audit read a tree that is not its recorded commit (uncommitted changes on top), so that commit\'s patches are not what was audited' };
    }
  }
  const audited = ownPatchIds(auditedRef, { defaultRef, git });
  if (!audited.ok) return { equivalent: false, reason: `audited side: ${audited.reason}` };
  const pushed = ownPatchIds(headRef, { defaultRef, git });
  if (!pushed.ok) return { equivalent: false, reason: `pushed side: ${pushed.reason}` };
  if (audited.ids.length === 0 || pushed.ids.length === 0) {
    return { equivalent: false, reason: `no own commits to compare (audited ${audited.ids.length}, pushed ${pushed.ids.length}): nothing to compare is not equality` };
  }
  const remaining = new Map();
  for (const id of audited.ids) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  let unmatched = 0;
  for (const id of pushed.ids) {
    const n = remaining.get(id) ?? 0;
    if (n > 0) remaining.set(id, n - 1); else unmatched += 1;
  }
  const missing = [...remaining.values()].reduce((a, b) => a + b, 0);
  if (unmatched > 0 || missing > 0) {
    return { equivalent: false, reason: `the patches differ: audited ${audited.ids.length} own commit(s), pushed ${pushed.ids.length}; ${unmatched} pushed patch(es) were never audited, ${missing} audited patch(es) are not in the push` };
  }
  return { equivalent: true, commits: pushed.ids.length };
}
