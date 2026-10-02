/**
 * @fileoverview Turns a `docs/experiments/audit-effectiveness/known-defects.json`
 * entry into `auditInput` for `runAuditGenerationArm`/`runMultiPassCodeAudit`
 * (model-swap-eval-harness Phase 3 — round-6 audit H6 fix: this loader was
 * entirely missing from every prior planning round). `solo-control-audit.mjs`'s
 * `locateCommit`/`extractDiff`/`chunkDiff` helpers are frozen and out of
 * scope (Audit Trail) — this module is a NEW, independent implementation of
 * the same "find a commit across sibling repo checkouts, extract its diff"
 * shape, not an extraction from that file. Diff PARSING reuses
 * `diff-annotation.mjs::parseDiffFile` — the same primitive
 * `openai-audit.mjs`'s production pass already calls — never a bespoke parser.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 3.
 *
 * @module scripts/lib/model-eval/known-defect-corpus
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDiffFile } from '../diff-annotation.mjs';
import { atomicWriteFileSync, normalizePath } from '../file-io.mjs';
import { assertEgressSafe, isPathSensitive } from '../sensitive-egress-gate.mjs';
import { findSensitivePathMentions, EgressGateError } from './egress-path-scan.mjs';
import { resolveMainRoot } from '../pinned-worktree/paths.mjs';

export const CORPUS_LOADER_VERSION = 'v1';

// A known-defects.json entry is a hand-curated, LOCALIZED fix commit (see
// the corpus itself — every entry to date touches 1-2 files). A diff this
// large means the KD entry doesn't fit the bounded-corpus contract this
// loader promises; fail loud (diff_too_large) rather than silently
// truncating, which would test something other than the real defect.
const MAX_DIFF_CHARS = 200_000;

export class CorpusCaseUnavailable extends Error {
  /** @param {'invalid_kd_id'|'repo_not_found'|'commit_not_found'|'diff_extraction_failed'|'diff_too_large'|'declared_files_not_in_diff'} reason */
  constructor(reason, message) {
    super(message);
    this.name = 'CorpusCaseUnavailable';
    this.reason = reason;
  }
}

// Round-1 (Cluster B) audit M8 fix — a bare inherited environment lets the
// operator's global git config (pager, or a per-path `.gitattributes`
// diff=<driver>/textconv attribute) alter `git diff`'s output, undermining
// the "same corpus version always yields the same subset/diff"
// reproducibility goal (round-2 audit M2) this module exists to serve.
// `--no-ext-diff --no-textconv` are the CORRECT way to suppress those
// (confirmed empirically) — `-c diff.external=''`/`-c diff.textconv=''`
// looks equivalent but is NOT: an empty string is a real (empty) command
// git then tries to spawn, which fails hard the moment a `.gitattributes`
// entry configures a driver for any touched path (as this very repo's own
// tests/ tree does) — `error: cannot spawn : No such file or directory`.
// core.pager is harmless on every subcommand; the diff-only flags are
// appended at the one `diff` call site below, not applied globally (they
// don't apply to cat-file).
//
// 2026-07-23 audit fix: `opts.env`, when supplied, REPLACES the base
// `process.env` spread (previously this always spread the full ambient
// env, so an `env` KEY existed here without ever being able to strip
// GIT_DIR-family vars — a caller exercising this against an isolated test
// fixture with a leaked GIT_DIR got no isolation despite the env option
// looking handled). GIT_PAGER is still layered on top either way. Omitted
// `opts.env` (the default) → identical to today's production behaviour.
function git(root, args, opts = {}) {
  return execFileSync('git', ['-c', 'core.pager=cat', '-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(opts.env ?? process.env), GIT_PAGER: 'cat' },
  });
}

// Round-1 (Cluster B) audit M16 fix — swallowing every git failure into a
// bare null previously discarded the underlying stderr, masking distinct
// root causes (invalid repo path, permission denied, corrupted checkout,
// missing git binary) behind one "commit not found" message. Surface the
// real stderr in the caller's thrown message; the CLASSIFICATION
// (commit_not_found) stays the same — the harness fails the run identically
// either way — but the diagnostic text is no longer thrown away.
function tryGit(root, args, opts = {}) {
  try { return { ok: true, output: git(root, args, opts) }; }
  catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Resolves a known-defects `repo` name (e.g. "wine-cellar-app") against the
 * caller-supplied `repoRoots` list of absolute local checkout paths — the
 * SAME "cwd + extra roots" shape `/audit-code`'s own multi-repo tooling uses
 * (solo-control-audit.mjs's `SOLO_CONTROL_REPO_ROOTS` convention), forked as
 * a fresh implementation here rather than importing the frozen file.
 *
 * A root's identity is its own directory basename OR its MAIN checkout's
 * basename (`resolveMainRoot`, via `--git-common-dir`). The basename alone was
 * blind to a linked worktree (2026-10-01, experiment 7): run from
 * `.claude/worktrees/<name>`, `process.cwd()`'s basename is the worktree name,
 * so every KD for the current repo failed preflight `repo_not_found` unless
 * the operator also passed the main checkout via `--repo-roots`. The root
 * RETURNED is still the one supplied — a linked worktree shares the main
 * checkout's object store, so `cat-file`/`diff` resolve the KD commit there.
 * @param {string} repoName
 * @param {string[]} repoRoots
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function resolveRepoRoot(repoName, repoRoots, env) {
  for (const root of repoRoots) {
    if (!fs.existsSync(root)) continue;
    if (repoRootNames(root, env).includes(repoName)) return root;
  }
  return null;
}

/**
 * Every name `root` answers to: its basename, plus its main checkout's
 * basename when `root` is inside a git repository. Not a repo (or git
 * unavailable) → the basename alone, the pre-fix behaviour.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function repoRootNames(root, env) {
  const names = [path.basename(path.resolve(root))];
  try {
    const main = path.basename(resolveMainRoot(root, env ? { env } : {}));
    if (!names.includes(main)) names.push(main);
  } catch { /* not a git checkout — basename is the only identity it has */ }
  return names;
}

/**
 * @param {{kdEntry: {id:string, repo:string, buggyCommit:string, files:string[], defectDesc:string, expectedFindingRubric:string, severity:string}, repoRoots: string[]}} args
 * @returns {{repoRoot: string, visibleInput: {diff:string, files:string[]}, hiddenGroundTruth: {files:string[], defectDesc:string, expectedFindingRubric:string, severity:string, kdId:string}}}
 * @throws {CorpusCaseUnavailable}
 */
// Round-2 (Cluster B) audit M3 fix — kdEntry.id is interpolated directly
// into the scratch cache filename (${kdEntry.id}.diff); a malformed id
// containing a path separator or traversal segment could otherwise escape
// .audit/tmp/model-eval/corpus-cache. known-defects.json is a trusted,
// reviewed, committed file (Category B), not untrusted runtime input, but
// this is a cheap, defensive check matching this repo's own established
// safe-identifier convention (db/query.mjs's SAFE_IDENT_RE) — catches a
// typo, not just a hypothetical attack.
const SAFE_KD_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @param {{kdEntry: object, repoRoots: string[], env?: NodeJS.ProcessEnv}} args
 *   `env`, when supplied, REPLACES the inherited `process.env` for every
 *   git subprocess this loader spawns. Omitted (the default) → identical
 *   to today's full-ambient-inherit production behaviour.
 */
export function loadCorpusCase({ kdEntry, repoRoots, env }) {
  // Gemini final-review catch (2026-07-24): RegExp#test coerces its argument
  // to a string, so a missing/malformed corpus entry with id === null or
  // undefined would test as "null"/"undefined" — both match [A-Za-z0-9_-]+ —
  // and slip past the guard this line exists to enforce. Reject non-strings
  // explicitly before the pattern check.
  if (typeof kdEntry.id !== 'string' || !SAFE_KD_ID_RE.test(kdEntry.id)) {
    throw new CorpusCaseUnavailable('invalid_kd_id', `loadCorpusCase: kdEntry.id "${kdEntry.id}" is not a safe identifier (expected [A-Za-z0-9_-]+) — refusing to use it in a scratch filename`);
  }
  const root = resolveRepoRoot(kdEntry.repo, repoRoots, env);
  if (!root) {
    throw new CorpusCaseUnavailable('repo_not_found', `loadCorpusCase: no repo root named "${kdEntry.repo}" (by directory or main-checkout basename) found among [${repoRoots.join(', ')}] for ${kdEntry.id}`);
  }

  const gitOpts = env ? { env } : {};
  const sha = kdEntry.buggyCommit;
  const commitCheck = tryGit(root, ['cat-file', '-e', `${sha}^{commit}`], gitOpts);
  if (!commitCheck.ok) {
    throw new CorpusCaseUnavailable('commit_not_found', `loadCorpusCase: commit ${sha} not found in repo "${kdEntry.repo}" (${root}) for ${kdEntry.id} — git: ${commitCheck.error}`);
  }

  let diff;
  try {
    // -U8 local context — the SAME context width this repo's own
    // /audit-code diff-extraction recipe uses (AGENTS.md), not `-W`
    // whole-function (which would inflate the prompt beyond what the
    // production audit path itself sees for a real commit). --no-ext-diff
    // --no-textconv suppress any .gitattributes-configured diff driver/
    // textconv filter (round-1 audit M8) — the diff-only hardening flags,
    // not applied to the cat-file call above.
    diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '-U8', `${sha}^`, sha], gitOpts);
  } catch (err) {
    throw new CorpusCaseUnavailable('diff_extraction_failed', `loadCorpusCase: git diff failed for ${sha} in "${kdEntry.repo}": ${err.message}`);
  }
  if (diff.length > MAX_DIFF_CHARS) {
    throw new CorpusCaseUnavailable('diff_too_large', `loadCorpusCase: diff for ${sha} in "${kdEntry.repo}" is ${diff.length} chars (max ${MAX_DIFF_CHARS}) for ${kdEntry.id} — narrow the KD's fix commit rather than bypassing the bound`);
  }

  // Round-1 (Cluster B) audit H7/H10 fix — defense-in-depth egress check at
  // this raw-extraction boundary too (not just at each consumer's own
  // boundary — structured-extractor.mjs's extractStructured and arm-
  // generation.mjs's runAuditGenerationArm both already gate independently;
  // this repo's established doctrine is "a boundary must not trust that
  // every caller remembered to gate upstream," so this producer-side check
  // is a genuine second layer, not a redundant no-op).
  assertEgressSafe(diff, { label: `known-defect-corpus:${kdEntry.id}` });
  const sensitiveDiffPaths = findSensitivePathMentions(diff);
  if (sensitiveDiffPaths.length > 0) {
    throw new EgressGateError(`loadCorpusCase: refusing to extract a diff containing sensitive path mention(s) for ${kdEntry.id}: ${sensitiveDiffPaths.join(', ')}`);
  }

  // Reuse diff-annotation.mjs::parseDiffFile (openai-audit.mjs's own
  // production-pass primitive) for the changed-file list — it only reads
  // from a path, so the extracted diff is cached to a bounded, Category-A
  // scratch file first. Keyed by kdEntry.id (not a run id): a KD's
  // (repo, buggyCommit) pair is immutable git history, so this is a safe,
  // correctness-neutral cross-run cache, not per-run scratch state.
  // Round-1 audit M6 fix — atomicWriteFileSync (temp+rename), not a bare
  // writeFileSync, for this shared scratch path (two concurrent CLI
  // invocations for the same KD could otherwise race on a torn write).
  const cacheDir = path.join('.audit', 'tmp', 'model-eval', 'corpus-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const diffPath = path.join(cacheDir, `${kdEntry.id}.diff`);
  atomicWriteFileSync(diffPath, diff);
  const diffMap = parseDiffFile(diffPath);
  const files = [...diffMap.keys()].sort();

  // Round-1 audit M10 fix — kdEntry.files (the curated ground-truth defect
  // location) was never cross-checked against the diff's OWN actual
  // changed-file list. A typo'd/stale/renamed path in kdEntry.files would
  // previously pass silently through to scoreDefectLocalization, where it
  // reads as an unmatchable expectedRubrics entry — indistinguishable from
  // "the candidate genuinely missed this defect." Fail loud at the corpus
  // boundary instead, where the actual cause (bad corpus metadata) is clear.
  //
  // Pre-ship empirical verify fix — caught via a REAL run, not static
  // review: `files` (from parseDiffFile) is normalizePath()-lowercased (an
  // established, ACCEPTED repo-wide trade-off — AGENTS.md's own Accepted
  // Technical Debt table — for Windows case-insensitive filesystems), but
  // `kdEntry.files` is case-PRESERVING as authored in known-defects.json.
  // Comparing them raw false-rejected any KD entry whose path contains an
  // uppercase character (e.g. an ISO-8601 `Z` UTC suffix in a filename) —
  // a real corpus entry, not stale metadata. Normalize BOTH sides the same
  // way before comparing.
  const normalizedFiles = new Set(files.map(normalizePath));
  const missingDeclaredFiles = (kdEntry.files || []).filter((f) => !normalizedFiles.has(normalizePath(f)));
  if (missingDeclaredFiles.length > 0) {
    throw new CorpusCaseUnavailable('declared_files_not_in_diff', `loadCorpusCase: ${kdEntry.id}'s declared files [${missingDeclaredFiles.join(', ')}] do not appear in the extracted diff's changed-file list [${files.join(', ')}] — corpus metadata is stale or has a typo`);
  }

  return {
    // The root the case resolved against — callers that need it (promotion
    // tier's generation arm) read it here rather than re-deriving it with a
    // second, divergent matcher.
    repoRoot: root,
    visibleInput: { diff, files },
    hiddenGroundTruth: {
      // `files` — the KD's OWN declared defect-location files (known-defects.json's
      // top-level `files` field), NOT `visibleInput.files` (the diff's changed-file
      // list) — required by deterministic-scorer.mjs::scoreDefectLocalization's
      // expectedRubrics[].files match target (verified directly against its own
      // matchScore() implementation: `expected.files.some(f => f === candidate.file)`).
      files: kdEntry.files,
      defectDesc: kdEntry.defectDesc,
      expectedFindingRubric: kdEntry.expectedFindingRubric,
      severity: kdEntry.severity,
      kdId: kdEntry.id,
    },
  };
}
