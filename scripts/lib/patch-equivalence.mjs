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
 * The rule is `git range-diff`'s own idea, made content-preserving: the branch's OWN commits (those the default branch does not
 * contain) are compared by a fingerprint of each commit's diff (whitespace and binary payload included; see COMMIT_DIFF_ARGS),
 * as a multiset, between the audited tip and the pushed tip. Equal means every audited change is in the push, byte for byte, and
 * nothing else is. A range holding a merge commit is never compared. It deliberately says NOTHING about whether the patches still behave
 * the same on the new base - that is the accepted residual risk of rebasing at all, and the caller says "range-diff-equivalent" in
 * its output rather than "same tree" so the weaker claim is never worn as the stronger one.
 *
 * Conservative in every direction it can be: an unresolvable ref, a commit with an empty/uncomparable diff, a count above the cap,
 * zero own commits (nothing to compare is not equality), or ANY git failure is "not equivalent" with the reason named.
 *
 * @module scripts/lib/patch-equivalence
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { isSafeGitRevision } from './vcs.mjs';

/** More own commits than this is not compared: fingerprinting is O(diff), and a branch that long is not a rebase-recovery case. */
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
 * What makes one commit's patch "the same" as another's. `git patch-id --stable` was rejected as the proof: it IGNORES WHITESPACE, and
 * whitespace is code (Python indentation, a space inside a string literal), so an amended commit could keep its patch id and be
 * reused unaudited (audit R1 H2/H4/H7). The fingerprint is the commit's own diff, content-preserving and configuration-independent:
 * `-U0` (no context, so a base that moved only around the change does not matter), `--no-renames`, `--binary` (full payload),
 * `--no-textconv --no-ext-diff` (no presentation filter), colour off. Only the lines that are NOT the change are dropped: the
 * `index <blob>..<blob>` line (blob ids depend on the base) and the hunk-header line numbers. Every added, removed, mode and
 * binary byte stays in the hash.
 */
const COMMIT_DIFF_ARGS = Object.freeze([
  // Pin every setting that changes the TEXT of a diff, so the evidence is the change and not the operator's `.gitconfig`. `diff-tree` is
  // plumbing (it already ignores most porcelain presentation config); the rest is pinned explicitly anyway.
  '-c', 'diff.renames=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'core.quotepath=true',
  '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=false', '-c', 'diff.ignoreSubmodules=none', '-c', 'diff.submodule=short', '-c', 'diff.orderFile=',
  'diff-tree', '-p', '-r', '--root', '--no-commit-id', '-U0', '--no-renames', '--binary', '--no-textconv', '--no-ext-diff', '--no-color',
  '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers', '--no-indent-heuristic',
]);

/** @param {string} body one commit's diff text @returns {string} */
function fingerprintOf(body) {
  const kept = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('index ')) continue;
    kept.push(line.startsWith('@@ ') ? '@@' : line);
  }
  return crypto.createHash('sha256').update(kept.join('\n')).digest('hex');
}

/**
 * Content fingerprints of the commits reachable from `rev` and not from `defaultRef`. A range that contains a MERGE commit is not
 * compared at all: what a merge introduces (a conflict resolution, a manual edit) is in no non-merge commit, so a multiset of the
 * non-merge ones would call a range equivalent that carries unaudited changes (audit R1 H3/H5/H8).
 * @param {string} rev
 * @param {{defaultRef: string, git: (args: string[], input?: string) => string|null}} ctx
 * @returns {{ok: true, ids: string[]} | {ok: false, reason: string}}
 */
export function ownPatchFingerprints(rev, { defaultRef, git }) {
  if (!isSafeGitRevision(rev)) return { ok: false, reason: `${JSON.stringify(rev)} is not a well-formed git revision` };
  if (!isSafeGitRevision(defaultRef) || git(['rev-parse', '--verify', '--quiet', `${defaultRef}^{commit}`]) === null) {
    return { ok: false, reason: `the default ref ${defaultRef} does not resolve in this checkout, so the branch's own commits cannot be told from main's` };
  }
  if (git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) === null) return { ok: false, reason: `${rev} does not resolve to a commit in this checkout` };
  const mergesOut = git(['rev-list', '--merges', '--count', rev, '--not', defaultRef]);
  const merges = mergesOut === null ? NaN : Number(mergesOut.trim());
  if (!Number.isInteger(merges)) return { ok: false, reason: `the merge count for ${rev} could not be read` };
  if (merges > 0) return { ok: false, reason: `${rev} has ${merges} merge commit(s) of its own, and what a merge introduces is in no non-merge commit, so the patches cannot be compared` };
  const countOut = git(['rev-list', '--count', '--no-merges', rev, '--not', defaultRef]);
  const count = countOut === null ? NaN : Number(countOut.trim());
  if (!Number.isInteger(count)) return { ok: false, reason: `the own-commit count for ${rev} could not be read` };
  if (count === 0) return { ok: true, ids: [] };
  if (count > MAX_COMPARED_COMMITS) return { ok: false, reason: `${count} own commits exceed the ${MAX_COMPARED_COMMITS} that are compared` };
  // One commit at a time: a delimiter inside `git log -p` output is in-band (any byte can occur in a changed line), so the framing is
  // the commit list itself - never a separator searched for in diff text.
  const list = git(['rev-list', '--no-merges', rev, '--not', defaultRef]);
  const shas = list === null ? [] : list.split(/\s+/).filter(Boolean);
  if (shas.length !== count) return { ok: false, reason: `the commit list of ${rev} could not be read (${shas.length} of ${count})` };
  const ids = [];
  for (const sha of shas) {
    if (!OBJECT_ID_RE.test(sha)) return { ok: false, reason: `unexpected commit id ${JSON.stringify(sha)} in the range of ${rev}` };
    const body = git([...COMMIT_DIFF_ARGS, sha]);
    if (body === null) return { ok: false, reason: `the patch of ${sha.slice(0, 12)} could not be read` };
    // A commit with no diff (an empty commit) has no content to compare.
    if (body.trim() !== '') ids.push(fingerprintOf(body));
  }
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
  const audited = ownPatchFingerprints(auditedRef, { defaultRef, git });
  if (!audited.ok) return { equivalent: false, reason: `audited side: ${audited.reason}` };
  const pushed = ownPatchFingerprints(headRef, { defaultRef, git });
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
