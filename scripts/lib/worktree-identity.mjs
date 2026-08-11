/**
 * @fileoverview Worktree-identity oracle — the single place this repo decides
 * whether the checkout it is about to mutate is still the one it assumed.
 *
 * Plan: docs/plans/worktree-identity-guards.md §5.
 *
 * WHY ONE MODULE. Three call sites need the same three questions answered
 * (`ship-commit` before a commit, `openai-audit` before a diff, and whatever
 * comes next). Three inline `merge-base` calls would be three chances to get the
 * exit-status semantics wrong — the same reason `sensitive-paths.mjs` is the one
 * classifier and `selector-policy.mjs` the one selector oracle. Do not add a
 * second implementation; add a reason to the enums below.
 *
 * EVERY function is pure apart from an injected `run`, so the decision logic is
 * unit-testable with zero subprocesses (testing doctrine Tier 1).
 *
 *   run(args: string[]) => { status: number|null, stdout: string, stderr: string, error?: Error }
 *
 * That is `spawnSync`'s own shape, so the real runner is a thin wrapper and a
 * test runner is a literal. `cwd` is always passed explicitly, never inherited.
 *
 * THE LOAD-BEARING RULE — a failed measurement is never a verdict. Both
 * `git merge-base --is-ancestor` and `git rev-parse --verify --quiet` signal a
 * legitimate negative answer with a NON-ZERO exit, which is indistinguishable
 * from an execution failure unless the caller says which is which. Conflating
 * them is precisely how "I could not check" becomes "the check passed". Each
 * probe below therefore states its accepted negative status explicitly and maps
 * everything else to `git-exec-failed`, which is a refusal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { isSafeGitRevision } from './vcs.mjs';

/** Closed reason enums — the outcome matrix in the plan's §5 is the contract. */
export const EXPECTATION_REASONS = Object.freeze([
  'no-expectation', 'incomplete-expectation', 'pre-bundle-evidence',
]);
export const IDENTITY_REASONS = Object.freeze([
  'head-moved', 'ref-moved', 'unborn-head', 'git-exec-failed',
]);
export const SCOPE_REASONS = Object.freeze([
  'unscoped-index', 'nothing-staged', 'path-is-directory', 'path-escapes-repo',
  'path-untracked-absent', 'git-exec-failed',
]);
export const ANCESTRY_REASONS = Object.freeze([
  'invalid-explicit', 'unresolvable-explicit', 'not-an-ancestor',
  'head-unresolvable', 'git-exec-failed',
]);

/**
 * The persisted git object-id contract, in ONE place.
 *
 * `commit-trailers.mjs` imports this rather than keeping its own copy: the
 * evidence marker's `auditedSha`/`auditedTree` and this module's expectation
 * head are THE SAME VALUES crossing a writer/reader seam, so two independent
 * regexes are two chances for the seam to disagree about what a valid id is.
 * Same reason `sensitive-paths.mjs` is the single classifier.
 *
 * SHA-1 only, deliberately: every id this repo persists today is produced by a
 * SHA-1 repository. Widening to SHA-256 is a real change (64 hex) and must be
 * made here, once, rather than discovered as drift between two copies.
 */
export const GIT_OBJECT_ID_RE = /^[0-9a-f]{40}$/;

/** @param {unknown} v @returns {boolean} */
export function isGitObjectId(v) {
  return typeof v === 'string' && GIT_OBJECT_ID_RE.test(v);
}

const SHA_RE = GIT_OBJECT_ID_RE;

/** Default runner. Kept trivial so the injected one is a faithful stand-in. */
export function makeGitRunner(cwd) {
  return (args) => spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true, timeout: 10000 });
}

/** A spawn that never produced a status is always an execution failure. */
function execFailed(res) {
  return !res || res.error || res.status === null || res.status === undefined;
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * Reconcile flags and audit evidence into ONE canonical identity, or refuse.
 *
 * Identity := { head, ref: {kind:'attached', name} | {kind:'detached'} }
 *
 * The bundle is ATOMIC on purpose. A head-only expectation passes whenever two
 * refs point at the same commit — a feature branch freshly cut from `main` is
 * exactly that — and the commit then lands on the wrong branch. That is the
 * field incident this guard exists to prevent, so a partial bundle is refused
 * rather than degraded to a SHA-only check.
 *
 * @param {{flags: {expectHead?: string, expectBranch?: string, expectDetached?: boolean},
 *          evidence: null | {state: string, auditedSha?: string, auditedBranch?: string|null}}} args
 * @returns {{ok: true, identity: object, source: 'flag'|'audit-evidence'}
 *          | {ok: false, reason: string, detail?: string}}
 */
export function resolveExpectedIdentity({ flags = {}, evidence = null } = {}) {
  const { expectHead, expectBranch, expectDetached } = flags;
  const anyFlag = expectHead != null || expectBranch != null || expectDetached === true;

  if (anyFlag) {
    if (expectBranch != null && expectDetached === true) {
      return { ok: false, reason: 'incomplete-expectation', detail: '--expect-branch and --expect-detached are mutually exclusive' };
    }
    if (expectHead == null) {
      return { ok: false, reason: 'incomplete-expectation', detail: 'a ref disposition was given without --expect-head' };
    }
    if (expectBranch == null && expectDetached !== true) {
      return { ok: false, reason: 'incomplete-expectation', detail: '--expect-head was given without --expect-branch or --expect-detached' };
    }
    // Shape-check before this value can reach a git argv (push-range.mjs:101).
    if (!SHA_RE.test(expectHead) || !isSafeGitRevision(expectHead)) {
      return { ok: false, reason: 'incomplete-expectation', detail: `--expect-head is not a full 40-hex commit id: ${JSON.stringify(expectHead)}` };
    }
    if (expectBranch != null && (!expectBranch.trim() || !isSafeGitRevision(expectBranch))) {
      return { ok: false, reason: 'incomplete-expectation', detail: `--expect-branch is not a well-formed ref name: ${JSON.stringify(expectBranch)}` };
    }
    const ref = expectDetached === true
      ? { kind: 'detached' }
      : { kind: 'attached', name: normaliseBranch(expectBranch) };
    return { ok: true, identity: { head: expectHead, ref }, source: 'flag' };
  }

  if (!evidence || evidence.state !== 'fresh') {
    return { ok: false, reason: 'no-expectation' };
  }
  if (!evidence.auditedSha || !SHA_RE.test(evidence.auditedSha)) {
    return { ok: false, reason: 'no-expectation', detail: 'fresh evidence carries no usable audited-sha' };
  }
  // PRESENCE, not nullish-coalescing. `auditedBranch: null` is a COMPLETE
  // bundle meaning "detached at capture"; the property being ABSENT means the
  // marker predates the bundle. `??` collapses the two and would read a real
  // detached capture as legacy evidence.
  if (!Object.hasOwn(evidence, 'auditedBranch')) {
    return { ok: false, reason: 'pre-bundle-evidence' };
  }
  const ref = evidence.auditedBranch === null
    ? { kind: 'detached' }
    : { kind: 'attached', name: normaliseBranch(evidence.auditedBranch) };
  return { ok: true, identity: { head: evidence.auditedSha, ref }, source: 'audit-evidence' };
}

function normaliseBranch(name) {
  return String(name).trim().replace(/^refs\/heads\//, '');
}

/**
 * Read the live checkout's identity — the one place `symbolic-ref` is called.
 *
 * `symbolic-ref --quiet --short HEAD` — NOT `rev-parse --abbrev-ref HEAD`, which
 * returns the literal string `HEAD` on a detached checkout and is therefore
 * indistinguishable from a branch genuinely named `HEAD`.
 *
 * Producers of gate evidence use this so the branch they RECORD and the branch
 * `verifyHeadIdentity` later COMPARES are read the same way. A second reader
 * that normalised differently would make the bundle fail to match itself.
 *
 * @param {{run: Function}} opts
 * @returns {{ok: true, identity: {head: string, ref: object}}
 *          | {ok: false, reason: 'unborn-head'|'git-exec-failed'}}
 */
export function readActualIdentity({ run }) {
  const headRes = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (execFailed(headRes) || (headRes.status !== 0 && headRes.status !== 1)) {
    return { ok: false, reason: 'git-exec-failed' };
  }
  // status 1 is rev-parse --quiet's DOCUMENTED missing-ref outcome (unborn HEAD).
  if (headRes.status === 1) return { ok: false, reason: 'unborn-head' };

  const refRes = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (execFailed(refRes) || (refRes.status !== 0 && refRes.status !== 1)) {
    return { ok: false, reason: 'git-exec-failed' };
  }
  // --quiet turns "not a symbolic ref" (i.e. detached) into a silent status 1.
  const ref = refRes.status === 0
    ? { kind: 'attached', name: normaliseBranch(refRes.stdout || '') }
    : { kind: 'detached' };
  return { ok: true, identity: { head: (headRes.stdout || '').trim(), ref } };
}

/**
 * Compare a resolved expectation against the live checkout.
 *
 * @param {{head: string, ref: object}} identity
 * @param {{run: Function}} opts
 * @returns {{ok: true} | {ok: false, reason: string, expected: object, actual: object|null}}
 */
export function verifyHeadIdentity(identity, { run }) {
  const read = readActualIdentity({ run });
  if (!read.ok) return { ok: false, reason: read.reason, expected: identity, actual: null };
  const actual = read.identity;
  const actualHead = actual.head;
  const actualRef = actual.ref;

  if (actualHead !== identity.head) {
    return { ok: false, reason: 'head-moved', expected: identity, actual };
  }
  if (actualRef.kind !== identity.ref.kind
      || (actualRef.kind === 'attached' && actualRef.name !== identity.ref.name)) {
    return { ok: false, reason: 'ref-moved', expected: identity, actual };
  }
  return { ok: true, actual };
}

// ── Scope ───────────────────────────────────────────────────────────────────

/**
 * Decide whether the caller has DECLARED what it intends to commit.
 *
 * `ship-commit` cannot know whose staged entries the index holds — there is no
 * ownership signal there — so the question is not "are these foreign?" but "has
 * a scope been declared?". No declaration plus a non-empty index is refused.
 *
 * A directory value is refused because git expands it: `--path sub` was measured
 * to commit `sub/b.txt`, a file the caller never named. Both the existing and
 * the DELETED directory cases are covered — `lstat` throws ENOENT for a deleted
 * directory, and `cat-file -e` exits 0 for a tree as happily as for a blob, so
 * the absent-path probe is `cat-file -t` and accepts `blob` only.
 *
 * @returns {{ok: true, rels: string[], mode: 'pathspec'}
 *          | {ok: false, reason: string, staged?: string[], offending?: string[], detail?: string}}
 */
export function classifyStagedScope({ paths = [], repoRoot, run, fsMod = fs }) {
  if (paths.length === 0) {
    const staged = run(['diff', '--cached', '--name-only']);
    if (execFailed(staged) || staged.status !== 0) {
      return { ok: false, reason: 'git-exec-failed', detail: 'could not read the index' };
    }
    const entries = (staged.stdout || '').trim();
    const list = entries ? entries.split('\n').filter(Boolean) : [];
    if (list.length === 0) return { ok: false, reason: 'nothing-staged', staged: [] };
    return { ok: false, reason: 'unscoped-index', staged: list };
  }

  const rels = [];
  const offending = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(repoRoot, p);
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, reason: 'path-escapes-repo', offending: [p] };
    }

    let exists = true;
    let isDir = false;
    try {
      isDir = fsMod.lstatSync(abs).isDirectory();
    } catch (e) {
      if (e && e.code === 'ENOENT') exists = false;
      else return { ok: false, reason: 'git-exec-failed', detail: `could not stat ${rel}: ${e?.code || e?.message}` };
    }

    if (exists) {
      if (isDir) { offending.push(rel); continue; }
      if (!rels.includes(rel)) rels.push(rel);
      continue;
    }

    // Absent from disk: a tracked path is a legitimate DELETION, an untracked
    // one is an input error, and a TREE is the deleted-directory widening case.
    const tracked = run(['ls-files', '--error-unmatch', '--', rel]);
    if (execFailed(tracked)) return { ok: false, reason: 'git-exec-failed', detail: `ls-files failed for ${rel}` };
    if (tracked.status === 0) { if (!rels.includes(rel)) rels.push(rel); continue; }

    const typed = run(['cat-file', '-t', `HEAD:${rel}`]);
    if (execFailed(typed)) return { ok: false, reason: 'git-exec-failed', detail: `cat-file failed for ${rel}` };
    const kind = typed.status === 0 ? (typed.stdout || '').trim() : null;
    if (kind === 'tree') { offending.push(rel); continue; }
    if (kind === 'blob') { if (!rels.includes(rel)) rels.push(rel); continue; }
    return { ok: false, reason: 'path-untracked-absent', offending: [rel] };
  }

  if (offending.length > 0) return { ok: false, reason: 'path-is-directory', offending };
  return { ok: true, rels, mode: 'pathspec' };
}

/**
 * Cap a directory-expansion sample WITHOUT walking the whole set.
 *
 * The refusal decision never depends on enumeration (that is `lstat`'s job), and
 * this stops collecting the moment the cap is hit. It deliberately does NOT
 * report an exact remainder count — computing one would reintroduce the
 * unbounded traversal the cap exists to avoid.
 *
 * @returns {{sample: string[], truncated: boolean}}
 */
export function sampleDirectoryEntries(absDir, { cap = 5, fsMod = fs } = {}) {
  const sample = [];
  let truncated = false;
  try {
    const dir = fsMod.opendirSync(absDir);
    try {
      let ent;
      while ((ent = dir.readSync()) !== null) {
        if (sample.length >= cap) { truncated = true; break; }
        sample.push(ent.name);
      }
    } finally { dir.closeSync(); }
  } catch { /* unreadable → no sample; the refusal stands on lstat alone */ }
  sample.sort();
  return { sample, truncated };
}

// ── Range ───────────────────────────────────────────────────────────────────

/**
 * Resolve an audit range to an IMMUTABLE pair of commit OIDs.
 *
 * Validating a ref EXPRESSION and then letting downstream code re-resolve it is
 * not validation: a movable ref can resolve to commit A during `merge-base` and
 * to commit B during `git diff`. HEAD is resolved FIRST and an inferred base is
 * derived from that resolved `headSha` rather than from a second textual `HEAD`
 * — that ordering is what makes the returned pair a snapshot.
 *
 * There is deliberately NO worktree/commit discriminator. The changed-file
 * computation always diffs `baseSha` against the WORKING TREE
 * (`git diff --name-only <baseSha>`, no `..`), which is correct for all four
 * clean/dirty x inferred/explicit combinations. A discriminator was tried and
 * was itself a silent under-scoping bug.
 *
 * @returns {{ok: true, baseSha: string, headSha: string, relation: 'ancestor'|'identical'}
 *          | {ok: false, reason: string, detail?: string}}
 */
export function resolveRangeSnapshot({ explicitBase = null, workingTreeDirty = false, run }) {
  if (explicitBase != null && !isSafeGitRevision(explicitBase)) {
    return { ok: false, reason: 'invalid-explicit', detail: `not a well-formed git revision: ${JSON.stringify(explicitBase)}` };
  }

  const headRes = run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (execFailed(headRes) || (headRes.status !== 0 && headRes.status !== 1)) {
    return { ok: false, reason: 'git-exec-failed', detail: 'could not resolve HEAD' };
  }
  if (headRes.status === 1) return { ok: false, reason: 'head-unresolvable' };
  const headSha = (headRes.stdout || '').trim();

  if (explicitBase == null) {
    // Dirty tree ⇒ the operator is auditing UNCOMMITTED work, so the base IS
    // head and the diff runs against the worktree. Clean ⇒ the previous commit.
    if (workingTreeDirty) {
      return { ok: true, baseSha: headSha, headSha, relation: 'identical' };
    }
    const parent = run(['rev-parse', '--verify', '--quiet', `${headSha}^^{commit}`]);
    if (execFailed(parent) || (parent.status !== 0 && parent.status !== 1)) {
      return { ok: false, reason: 'git-exec-failed', detail: 'could not resolve the parent commit' };
    }
    if (parent.status === 1) {
      // Root commit: there is no parent to diff against. Base at head, which
      // scopes to the worktree rather than silently producing an empty range.
      return { ok: true, baseSha: headSha, headSha, relation: 'identical' };
    }
    return { ok: true, baseSha: (parent.stdout || '').trim(), headSha, relation: 'ancestor' };
  }

  const baseRes = run(['rev-parse', '--verify', '--quiet', `${explicitBase}^{commit}`]);
  if (execFailed(baseRes) || (baseRes.status !== 0 && baseRes.status !== 1)) {
    return { ok: false, reason: 'git-exec-failed', detail: `could not resolve ${explicitBase}` };
  }
  if (baseRes.status === 1) {
    return { ok: false, reason: 'unresolvable-explicit', detail: `${explicitBase} does not resolve to a commit in this checkout` };
  }
  const baseSha = (baseRes.stdout || '').trim();
  if (baseSha === headSha) return { ok: true, baseSha, headSha, relation: 'identical' };

  const anc = run(['merge-base', '--is-ancestor', baseSha, headSha]);
  if (execFailed(anc)) return { ok: false, reason: 'git-exec-failed', detail: 'merge-base could not be run' };
  if (anc.status === 0) return { ok: true, baseSha, headSha, relation: 'ancestor' };
  // THE trap: --is-ancestor reports a negative answer with exit 1, and an
  // execution failure ALSO exits non-zero. Only a clean exit-1 is an answer.
  if (anc.status === 1 && !(anc.stderr || '').trim()) {
    return { ok: false, reason: 'not-an-ancestor', detail: `${baseSha.slice(0, 12)} is not an ancestor of ${headSha.slice(0, 12)}` };
  }
  return { ok: false, reason: 'git-exec-failed', detail: `merge-base --is-ancestor exited ${anc.status}: ${(anc.stderr || '').trim()}` };
}
