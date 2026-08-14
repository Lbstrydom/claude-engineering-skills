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

function makeHandle(kind, rel, abs, rev) {
  return Object.freeze({ __resolved: true, kind, rel, abs: abs ?? null, rev: rev ?? null });
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
  if (!h || typeof h !== 'object' || h.__resolved !== true) {
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
    let entryExists = true;
    try { fs.lstatSync(path.resolve(repoRoot, rel)); } catch { entryExists = false; }
    if (!entryExists) {
      throw new PathRefusedError('missing',
        `[comparison/paths] "${rel}" does not exist — refused at manifest load, before any provider call`);
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
  if (!fs.existsSync(abs)) {
    throw new PathRefusedError('missing',
      `[comparison/paths] "${rel}" does not exist — refused at manifest load, before any provider call`);
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
  return Object.freeze({ ...makeHandle('git', norm, null, rev), present: Boolean(shown?.ok) });
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
