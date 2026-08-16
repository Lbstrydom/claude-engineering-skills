/**
 * @fileoverview The SINGLE resolver for every manifest-derived path in a model
 * comparison. No consumer may read a manifest path directly.
 *
 * INC-001 is the reason this module exists and owns the duty. That incident was
 * not "no classifier existed" — one did. It was that a call site saw the
 * PRE-resolution string, so a symlink named innocently but resolving into
 * `~/.ssh/` was classified on its visible name. A security invariant asserted in
 * prose and assigned to no module is a comment; this is the module.
 *
 * TWO CAPABILITIES, because `realpath` is wrong for half the reads:
 *
 *  - `resolveLocalPath` — working-tree reads (corpora, diffs, transcript dirs).
 *    realpath, then classify, then assert repo containment.
 *  - `resolveGitPath` — historical reads at a revision (cited sources).
 *    Resolved INSIDE the git object tree, never against the host filesystem.
 *
 * The second is not a nicety. `scripts/campaign.mjs` reads cited files at
 * `audited_sha` via `gitShowFileAtRevision`, and `fs.realpathSync` resolves
 * against the CURRENT filesystem — so a file deleted, renamed, or turned into a
 * symlink after the snapshot would fail resolution. Because the resolver is
 * fail-closed, a realpath-everything rule would refuse a legitimate historical
 * read and mark a true finding unverifiable, i.e. the security fix would break
 * the adjudicator exactly when the repo moved on, which is always.
 *
 * Both return a FROZEN HANDLE, never a string. An earlier draft called this a
 * "branded type" — in a JavaScript repo a brand is a comment, enforcing nothing
 * at runtime or build time. Consumers accept the handle; a bare string throws.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md §Security Considerations.
 *
 * @module scripts/lib/comparison/paths
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveAndClassify, classifyPath } from '../sensitive-paths.mjs';
import { gitShowFileAtRevision } from '../vcs.mjs';

/** Thrown for every refusal. Carries a machine-readable `reason`. */
export class PathRefusedError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'PathRefusedError';
    this.reason = reason;
  }
}

/** Refusal reasons — a closed set, so a caller can branch without string matching. */
export const REFUSAL_REASONS = Object.freeze([
  'absolute-path', 'escapes-repo', 'sensitive', 'missing', 'resolution-failed', 'not-a-handle',
]);

/**
 * A resolved path handle. Frozen, and the only thing consumers accept.
 * @typedef {{__resolved: true, kind: 'local'|'git', rel: string, abs: string|null, rev: string|null}} PathHandle
 */

/**
 * Registry of handles this module actually issued. Membership is the authority.
 *
 * Two weaker designs were tried and both are forgeable, which is worth
 * recording because each looked sufficient:
 *  1. `__resolved: true` — any caller can freeze an object carrying it.
 *  2. A module-private `Symbol` key — symbols on a returned object are
 *     ENUMERABLE via `Object.getOwnPropertySymbols`, so a caller holding any
 *     legitimate handle can copy the brand onto a forged one. "Private symbol"
 *     is private to the module's *scope*, not to the objects it hands out.
 *
 * A WeakSet keys on object IDENTITY, which cannot be copied, forged or
 * enumerated off an existing handle — and it holds weakly, so handles stay
 * collectable. This is the difference between a marker and a control.
 */
const ISSUED_HANDLES = new WeakSet();

function makeHandle(kind, rel, abs, rev, extra = {}) {
  // `extra` is spread in BEFORE freezing and registering, because registration
  // keys on object identity: an earlier version registered the base object and
  // then returned `{...base, present, absence}`, so `resolveGitPath` handed back
  // an object the registry had never seen and `assertHandle` rejected the
  // module's own output. Build once, freeze once, register that.
  const h = Object.freeze({ __resolved: true, kind, rel, abs: abs ?? null, rev: rev ?? null, ...extra });
  ISSUED_HANDLES.add(h);
  return h;
}

/**
 * Assert a value is a handle produced by this module. Consumers call this at
 * their boundary so a raw manifest string cannot be read by mistake — the
 * runtime check a "branded type" only pretended to provide.
 *
 * @param {unknown} h
 * @returns {PathHandle}
 */
export function assertHandle(h) {
  // Membership in the issue registry, NOT any property on the object — the
  // `__resolved` flag is retained only so a debugging `console.log` reads
  // clearly, and is deliberately not what is checked.
  if (!h || typeof h !== 'object' || !ISSUED_HANDLES.has(h)) {
    throw new PathRefusedError('not-a-handle',
      '[comparison/paths] expected a resolved path handle, got a bare value — manifest paths must go through '
      + 'resolveLocalPath/resolveGitPath, never be read directly (INC-001)');
  }
  return /** @type {PathHandle} */ (h);
}

/**
 * Resolve a manifest path for a WORKING-TREE read.
 *
 * Fail-closed at every step: an absolute path, a path escaping the repo after
 * realpath, a sensitive classification, an unresolvable path, and a missing
 * path are all refusals — and a missing path is refused at manifest LOAD, so a
 * typo costs nothing rather than being discovered after the spend.
 *
 * @param {string} rel - repo-relative path from a manifest
 * @param {{repoRoot: string}} opts
 * @returns {PathHandle}
 */
/**
 * Does a failed `lstat` prove the entry is ABSENT, or only that we could not
 * look?
 *
 * Key on the errno, never on "lstat threw". `ENOENT` (nothing at that name) and
 * `ENOTDIR` (a parent component is not a directory, so the name cannot exist)
 * are proof of absence. `EACCES`, `EPERM`, `EIO`, `ELOOP` and
 * `ENAMETOOLONG` are not: the entry may exist perfectly well and merely be
 * unreadable by us.
 *
 * A bare `catch { missing = true }` reported every one of those as `missing`,
 * which states `"X" does not exist` about a path we never managed to examine —
 * the false-absence claim this seam exists to prevent. `resolveGitPath` had the
 * identical defect and was fixed on 2026-08-14 (`absent` vs
 * `lookup-failed:<code>`); this is the sibling that fix missed, which is the
 * recurring shape this plan's own status note names.
 *
 * Exported because the discrimination is the contract, and a filesystem cannot
 * portably be made to return `EACCES` in a test — a rule that can only be
 * exercised through the one errno the test host happens to produce is a rule
 * with no coverage. Fail CLOSED on an unrecognised code: `unknown` refuses
 * without claiming absence, which is the safe direction.
 *
 * @param {(Error & {code?: string})|null|undefined} err — the caught error, or null on success
 * @returns {'ok'|'absent'|'unknown'}
 */
export function classifyLookupError(err) {
  if (!err) return 'ok';
  return (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'absent' : 'unknown';
}

export function resolveLocalPath(rel, { repoRoot } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('[comparison/paths] repoRoot is required');
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new PathRefusedError('missing', '[comparison/paths] path must be a non-empty string');
  }
  if (path.isAbsolute(rel)) {
    throw new PathRefusedError('absolute-path',
      `[comparison/paths] refusing absolute path "${rel}" — manifest paths are repo-relative`);
  }

  // Delegate classification to the repo's SINGLE oracle. Never a fifth
  // implementation, and never a lexical check of our own.
  const verdict = resolveAndClassify(rel, { repoRoot });
  if (verdict.resolutionFailed) {
    // Distinguish "no such entry" from "the entry exists but will not resolve".
    // `lstat` is the discriminator and it is exact: a plain missing file throws
    // ENOENT, while a BROKEN SYMLINK lstats successfully and only realpath
    // fails. Collapsing the two would report a dangling link into a sensitive
    // target as a benign typo — the reason code is operator-facing, and both
    // still refuse.
    let lookupError = null;
    try { fs.lstatSync(path.resolve(repoRoot, rel)); } catch (err) { lookupError = err; }
    if (classifyLookupError(lookupError) === 'absent') {
      throw new PathRefusedError('missing',
        `[comparison/paths] "${rel}" does not exist — refused at manifest load, before any provider call`);
    }
    if (lookupError) {
      throw new PathRefusedError('resolution-failed',
        `[comparison/paths] "${rel}" could not be examined (${lookupError.code || 'unknown error'}) — refusing rather `
        + 'than claiming it is absent, which would be a fact we do not have');
    }
    throw new PathRefusedError('resolution-failed',
      `[comparison/paths] "${rel}" exists but does not resolve (dangling link?) — refusing rather than reading an unclassifiable path`);
  }
  if (verdict.escapedRepo) {
    throw new PathRefusedError('escapes-repo',
      `[comparison/paths] "${rel}" resolves outside the repository — refusing, never following`);
  }
  if (verdict.category === 'sensitive') {
    throw new PathRefusedError('sensitive',
      `[comparison/paths] "${rel}" classifies as sensitive — refusing (INC-001)`);
  }

  const abs = verdict.canonical ?? path.resolve(repoRoot, rel);
  // The SIBLING of the check above, and it goes through the same oracle
  // (Cluster A round 7 + the concurrent `classifyLookupError` extraction).
  // This branch used `fs.existsSync`, which collapses EVERY failure — ENOENT,
  // EACCES, EIO — into a bare `false` reported as `missing`: a claim that a
  // path does not exist, made about a path that was never examined. Two
  // sessions independently found this same defect class in this same file,
  // one in each branch; routing BOTH through `classifyLookupError` is what
  // stops a third instance, since a rule with one call site is a rule that
  // gets fixed for one sibling and not the other.
  let statErr = null;
  try { fs.lstatSync(abs); } catch (err) { statErr = err; }
  if (classifyLookupError(statErr) === 'absent') {
    throw new PathRefusedError('missing',
      `[comparison/paths] "${rel}" does not exist — refused at manifest load, before any provider call`);
  }
  if (statErr) {
    throw new PathRefusedError('resolution-failed',
      `[comparison/paths] "${rel}" could not be examined (${statErr.code || 'unknown error'}) — refusing rather `
      + 'than claiming it is absent, which would be a fact we do not have');
  }
  return makeHandle('local', rel, abs, null);
}

/**
 * Resolve a manifest/finding path for a HISTORICAL read at a revision.
 *
 * Containment and existence are answered inside the git object tree, so the
 * question asked is the only meaningful one for a historical read: **what did
 * this path point to in THAT commit** — not what it points to now.
 *
 * A blob absent at that revision is NOT a refusal: it yields
 * `{present: false}`, which the adjudication contract renders as
 * `unverifiable`. Refusing would turn "the repo moved on" into a false absence
 * claim against a true finding.
 *
 * @param {string} rel
 * @param {{repoRoot: string, rev: string}} opts
 * @returns {PathHandle & {present: boolean}}
 */
export function resolveGitPath(rel, { repoRoot, rev } = {}) {
  if (typeof rev !== 'string' || !rev) throw new TypeError('[comparison/paths] rev is required for a historical read');
  const norm = assertGitPathAdmissible(rel, { repoRoot });
  // Signature is (cwd, revision, filePath) — positional. Verified against
  // scripts/lib/vcs.mjs rather than assumed; a transposed argument here would
  // return a structured failure that reads exactly like "absent at that
  // revision", turning a wiring bug into a false `unverifiable`.
  const shown = gitShowFileAtRevision(repoRoot, rev, norm);
  // `present:false` must mean "absent at that revision" and NOTHING else. A
  // bad revision, a git execution failure or a corrupt repository are not
  // evidence of absence, and collapsing them here would manufacture exactly the
  // false absence claim this seam exists to avoid — an arm penalised for
  // correctly citing a file, because git was unavailable. `vcs.mjs` returns a
  // structured `{ok:false, error:{code}}`, so the distinction is already
  // present and only needs to survive.
  const failureCode = shown?.ok ? null : (shown?.error?.code ?? 'UNKNOWN');
  const absent = failureCode === 'NOT_FOUND' || failureCode === 'PATH_NOT_IN_REVISION';
  return makeHandle('git', norm, null, rev, {
    present: Boolean(shown?.ok),
    // null when present; 'absent' when genuinely not in that tree; otherwise
    // the git failure code, so a caller can render `unverifiable (git failed)`
    // rather than a confident absence.
    absence: shown?.ok ? null : (absent ? 'absent' : `lookup-failed:${failureCode}`),
  });
}

/**
 * The ADMISSION half of a historical read, with no git call and no filesystem
 * touch — pure policy: is this path one we are willing to read at all?
 *
 * Separate from `resolveGitPath` because presence and admissibility are
 * different questions, and conflating them breaks callers that own the read.
 * `campaign.mjs::resolveCitedSources` takes an INJECTABLE `show` so its tests
 * can drive synthetic revisions; folding a real `git show` into the admission
 * check silently bypassed that injection and made seven tests fail against a
 * fake revision the real repo has never heard of. Admission must be answerable
 * without knowing whether the blob exists.
 *
 * @param {string} rel
 * @param {{repoRoot: string}} opts
 * @returns {string} the normalised repo-relative path
 */
export function assertGitPathAdmissible(rel, { repoRoot } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('[comparison/paths] repoRoot is required');
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new PathRefusedError('missing', '[comparison/paths] path must be a non-empty string');
  }
  if (path.isAbsolute(rel)) {
    throw new PathRefusedError('absolute-path',
      `[comparison/paths] refusing absolute path "${rel}" — manifest paths are repo-relative`);
  }
  // A repo-relative path containing `..` cannot be inside the tree at any
  // revision; refuse lexically rather than asking git about it.
  const norm = path.normalize(rel).split(path.sep).join('/');
  if (norm.startsWith('../') || norm === '..') {
    throw new PathRefusedError('escapes-repo',
      `[comparison/paths] "${rel}" escapes the repository root — refusing`);
  }
  // LEXICAL classification, and `classifyPath` NOT `resolveAndClassify` — the
  // distinction is the whole point of this function existing separately.
  //
  // `resolveAndClassify` realpaths and fail-closes: a path absent from the
  // CURRENT working tree resolves nowhere and comes back `sensitive`. For a
  // historical read that is exactly backwards — the file legitimately may not
  // exist now, which is the case this seam is built to serve. Calling it here
  // reintroduced the current-filesystem dependency through the classifier and
  // turned every citation to a since-moved file into a spurious
  // `sensitive-path` refusal (caught by seven existing citation tests).
  //
  // Lexical is SOUND here, not a compromise: git tracks no symlink this could
  // follow. A symlink at that revision is a blob whose CONTENT is the target,
  // so reading it yields the link text, never the pointee — the traversal
  // INC-001 closed is unreachable through `git show`.
  if (classifyPath(norm) === 'sensitive') {
    throw new PathRefusedError('sensitive',
      `[comparison/paths] "${rel}" classifies as sensitive — refusing (INC-001)`);
  }

  return norm;
}
