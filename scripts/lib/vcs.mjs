/**
 * @fileoverview Structured VCS helpers — closed `VcsErrorCode` enum +
 * categorised diff shape. Replaces ad-hoc try/return-null patterns in
 * `scripts/symbol-index/refresh.mjs` (plan: docs/plans/sustainability-cleanup-batch.md WS3).
 *
 * Callers switch on `{ok, …}` and translate failures to CLI exits via
 * `exitCodeFor(errorCode)`. The split from a single `GIT_UNAVAILABLE`
 * umbrella into precise causes (R2-H1) gives operators actionable signal
 * — a missing `git` binary (terminal, exit 127) is fundamentally different
 * from a transient subprocess crash (retryable, exit 1).
 *
 * @module scripts/lib/vcs
 */

import { execSync, spawnSync } from 'node:child_process';

/**
 * @typedef {'GIT_BINARY_MISSING'
 *         | 'NOT_A_GIT_REPOSITORY'
 *         | 'BAD_REVISION'
 *         | 'WORKING_TREE_UNREADABLE'
 *         | 'EXEC_FAILED'} VcsErrorCode
 */

/**
 * @typedef {object} DiffShape
 * @property {string[]} added
 * @property {string[]} modified
 * @property {string[]} deleted
 * @property {string[]} untracked
 * @property {{from: string, to: string}[]} renamed
 */

/**
 * @typedef {object} VcsError
 * @property {VcsErrorCode} code
 * @property {string} message
 * @property {Error} [cause]
 */

/**
 * Codes where retry can succeed — only transient subprocess crashes.
 * NOTE: V8's `Object.freeze(new Set(...))` does NOT prevent `.add()` /
 * `.delete()` mutation (R1-audit M6). The exported binding is `const`,
 * but the Set's contents are mutable at runtime. Treat this as read-only
 * by convention or call `isRetryableVcsError(code)` instead.
 */
export const RETRYABLE_VCS_ERRORS = new Set(['EXEC_FAILED']);

/**
 * Read-only accessor: true iff the code is in the retryable set. Prefer
 * this over reading the Set directly — it can't be poisoned by callers.
 *
 * @param {VcsErrorCode | string} code
 * @returns {boolean}
 */
export function isRetryableVcsError(code) {
  return code === 'EXEC_FAILED';
}

/**
 * Map a VcsErrorCode to a CLI exit code (see plan §2 #7 blast-radius table).
 * Unknown codes default to 1.
 *
 * @param {VcsErrorCode | string} code
 * @returns {number}
 */
export function exitCodeFor(code) {
  switch (code) {
    case 'GIT_BINARY_MISSING':       return 127;
    case 'NOT_A_GIT_REPOSITORY':     return 5;
    case 'BAD_REVISION':             return 4;
    case 'WORKING_TREE_UNREADABLE':  return 5;
    case 'EXEC_FAILED':              return 1;
    default:                          return 1;
  }
}

/**
 * Validate that `s` is a safe git revision spec — defends against
 * command injection (R1 audit H6/H11). Allows: SHA prefix, `HEAD` / `HEAD~N`,
 * `@{upstream}`, `origin/<branch>`, plain branch/tag names. Rejects anything
 * with shell metacharacters or a leading `-` (would be misread as a git flag).
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function isSafeGitRevision(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 200) return false;
  return /^[A-Za-z0-9._\/@{}~^][A-Za-z0-9._\/@{}~^-]*$/.test(s);
}

/**
 * Classify a `spawnSync`/`execSync` failure into a VcsErrorCode + message.
 * Centralised so call-site branches stay simple.
 *
 * @param {unknown} err - the thrown Error or a spawnSync result object
 * @param {{wantedRev?: string}} [ctx]
 * @returns {VcsError}
 */
function classifyChildError(err, ctx = {}) {
  // execSync throws; spawnSync returns a result object we synthesise into err.
  // ENOENT on git itself → binary missing
  const code = err && err.code;
  if (code === 'ENOENT') {
    return { code: 'GIT_BINARY_MISSING', message: 'git binary not found on PATH', cause: err };
  }
  const stderrBuf = err && (err.stderr || (err.error && err.error.message));
  const stderr = stderrBuf ? String(stderrBuf) : '';
  if (/not a git repository/i.test(stderr)) {
    return { code: 'NOT_A_GIT_REPOSITORY', message: 'cwd is not inside a git repository', cause: err };
  }
  if (/unknown revision|bad revision|ambiguous argument/i.test(stderr) ||
      /fatal: bad revision/i.test(stderr)) {
    const what = ctx.wantedRev ? `: ${ctx.wantedRev}` : '';
    return { code: 'BAD_REVISION', message: `git did not resolve the requested revision${what}`, cause: err };
  }
  // Signal / non-numeric status → treat as a transient subprocess crash
  if (err && (err.signal || (typeof err.status === 'number' && err.status < 0))) {
    return { code: 'EXEC_FAILED', message: `git subprocess terminated by signal (${err.signal || err.status})`, cause: err };
  }
  // Catch-all for non-zero exits we can't classify
  return { code: 'WORKING_TREE_UNREADABLE', message: stderr.trim().slice(0, 200) || 'git command failed', cause: err };
}

/**
 * Resolve the HEAD commit SHA of the working tree at `cwd`.
 * Returns the structured result so callers can distinguish "no commits yet"
 * (BAD_REVISION) from "not a git repo" (NOT_A_GIT_REPOSITORY).
 *
 * @param {string} cwd
 * @returns {{ok: true, sha: string} | {ok: false, error: VcsError}}
 */
export function gitCommitSha(cwd) {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    if (!sha) {
      return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: 'git rev-parse HEAD returned empty' } };
    }
    return { ok: true, sha };
  } catch (err) {
    return { ok: false, error: classifyChildError(err, { wantedRev: 'HEAD' }) };
  }
}

/**
 * Working-tree-aware diff: includes uncommitted + untracked entries.
 *
 * `sinceCommit` MUST already pass `isSafeGitRevision` — callers that take
 * the value from CLI flags should validate eagerly so a malformed input
 * surfaces as BAD_REVISION at the right layer.
 *
 * @param {string} cwd
 * @param {string | null | undefined} sinceCommit
 * @returns {{ok: true, files: DiffShape} | {ok: false, error: VcsError}}
 */
export function gitDiffWithWorkingTree(cwd, sinceCommit) {
  const files = { added: [], modified: [], deleted: [], untracked: [], renamed: [] };

  if (sinceCommit) {
    if (!isSafeGitRevision(sinceCommit)) {
      return {
        ok: false,
        error: { code: 'BAD_REVISION', message: `refusing unsafe --since-commit: ${JSON.stringify(sinceCommit).slice(0, 80)}` },
      };
    }
    let diffRes;
    try {
      diffRes = spawnSync('git', ['diff', '--name-status', sinceCommit], {
        cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return { ok: false, error: classifyChildError(err, { wantedRev: sinceCommit }) };
    }
    if (diffRes.error) {
      return { ok: false, error: classifyChildError(diffRes.error, { wantedRev: sinceCommit }) };
    }
    if (diffRes.status !== 0) {
      // spawnSync doesn't throw — synthesise the error shape for the classifier
      const synth = { stderr: diffRes.stderr, status: diffRes.status, signal: diffRes.signal };
      return { ok: false, error: classifyChildError(synth, { wantedRev: sinceCommit }) };
    }
    for (const line of (diffRes.stdout || '').split('\n')) {
      const m = line.match(/^([AMDR])\d*\s+(.+?)(?:\s+(.+))?$/);
      if (!m) continue;
      if (m[1] === 'A') files.added.push(m[2]);
      else if (m[1] === 'M') files.modified.push(m[2]);
      else if (m[1] === 'D') files.deleted.push(m[2]);
      else if (m[1] === 'R') files.renamed.push({ from: m[2], to: m[3] });
    }
  }

  let lsRes;
  try {
    lsRes = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { ok: false, error: classifyChildError(err) };
  }
  if (lsRes.error) {
    return { ok: false, error: classifyChildError(lsRes.error) };
  }
  if (lsRes.status !== 0) {
    const synth = { stderr: lsRes.stderr, status: lsRes.status, signal: lsRes.signal };
    return { ok: false, error: classifyChildError(synth) };
  }
  for (const line of (lsRes.stdout || '').split('\n')) {
    const t = line.trim();
    if (t) files.untracked.push(t);
  }

  return { ok: true, files };
}

/**
 * Read a file's content at a specific revision — `git show <revision>:<filePath>`.
 * Used by the duplication-detector (docs/plans/audit-code-duplication-wave.md
 * §2) to diff a changed symbol's base-revision content without touching the
 * architectural-memory DB snapshot at all (Gemini-round-3 decoupling — see
 * the plan's §8 Audit Trail).
 *
 * A file that doesn't exist at `revision` (e.g. it was added after the base
 * commit) is a `BAD_REVISION`-shaped, expected outcome, not a crash — callers
 * treat it as "no base-revision side" per the plan's `added` classification.
 *
 * @param {string} cwd
 * @param {string} revision - MUST already pass `isSafeGitRevision`
 * @param {string} filePath - repo-relative path, forward-slash form
 * @returns {{ok: true, content: string} | {ok: false, error: VcsError}}
 */
export function gitShowFileAtRevision(cwd, revision, filePath) {
  if (!isSafeGitRevision(revision)) {
    return {
      ok: false,
      error: { code: 'BAD_REVISION', message: `refusing unsafe revision: ${JSON.stringify(revision).slice(0, 80)}` },
    };
  }
  let res;
  try {
    res = spawnSync('git', ['show', `${revision}:${filePath}`], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, error: classifyChildError(err, { wantedRev: revision }) };
  }
  if (res.error) {
    return { ok: false, error: classifyChildError(res.error, { wantedRev: revision }) };
  }
  if (res.status !== 0) {
    // Non-zero here is overwhelmingly "path does not exist at this revision"
    // (a new file) — classify via the same BAD_REVISION/stderr heuristics
    // rather than a bespoke branch, so callers get one consistent error shape.
    const synth = { stderr: res.stderr, status: res.status, signal: res.signal };
    const classified = classifyChildError(synth, { wantedRev: revision });
    if (classified.code === 'WORKING_TREE_UNREADABLE' && /path .* (does not exist|exists on disk, but not in)/i.test(res.stderr || '')) {
      return { ok: false, error: { code: 'BAD_REVISION', message: `${filePath} does not exist at ${revision}`, cause: res } };
    }
    return { ok: false, error: classified };
  }
  return { ok: true, content: res.stdout || '' };
}

/**
 * Test-only: re-export the classifier so unit tests can drive each
 * VcsErrorCode without a live git environment. NOT part of the public API.
 *
 * @internal
 */
export const _internals = Object.freeze({ classifyChildError });
