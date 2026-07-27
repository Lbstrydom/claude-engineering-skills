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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * A real `Set` subclass whose mutators throw instead of silently
 * succeeding. `Object.freeze(new Set(...))` does NOT prevent `.add()`/
 * `.delete()` mutation (verified empirically — freeze only protects an
 * object's own properties, not a Set's internal storage slots), so the
 * override happens at the method level instead.
 *
 * Constructed via `Set.prototype.add.call(this, item)` rather than
 * `super(items)`: passing an iterable to `super()` makes the native `Set`
 * constructor call `this.add()` for each item, which would dispatch to
 * THIS subclass's own throwing override during construction and break it.
 * Calling `Set.prototype.add` directly bypasses the override for seeding
 * only — the override applies to every call after the constructor returns.
 */
class ReadOnlySet extends Set {
  constructor(items) {
    super();
    for (const item of items) Set.prototype.add.call(this, item);
  }
  add() { throw new TypeError('RETRYABLE_VCS_ERRORS is read-only; see isRetryableVcsError()'); }
  delete() { throw new TypeError('RETRYABLE_VCS_ERRORS is read-only; see isRetryableVcsError()'); }
  clear() { throw new TypeError('RETRYABLE_VCS_ERRORS is read-only; see isRetryableVcsError()'); }
}

/**
 * Codes where retry can succeed — only transient subprocess crashes.
 * Private — `isRetryableVcsError()` is the only access point production
 * code should use.
 */
const _retryableVcsErrors = new Set(['EXEC_FAILED']);

/**
 * Deprecated compatibility export: a real `Set` (`instanceof Set` is
 * `true`, every native read method — `has`/`size`/iteration/`forEach`/
 * `Object.prototype.toString` — works unmodified) constructed from the
 * SAME canonical `_retryableVcsErrors` above, not a second literal, so
 * the two can never diverge. `.add()`/`.delete()`/`.clear()` throw
 * immediately on any mutation attempt (production code never reads this
 * export — only `isRetryableVcsError()`'s private Set — so even a
 * deliberate bypass of the throwing overrides, e.g. via
 * `Set.prototype.add.call(RETRYABLE_VCS_ERRORS, code)`, cannot affect
 * this module's own retry behaviour). `Object.freeze` on top guards the
 * instance's own properties as a further layer, though the overridden
 * methods — not the freeze — are what actually block ordinary mutation.
 * Prefer `isRetryableVcsError(code)`; this export is retained only for
 * external compatibility and removal goes through this repo's own
 * consumer-adoption/release process, not a unilateral change here.
 */
export const RETRYABLE_VCS_ERRORS = Object.freeze(new ReadOnlySet(_retryableVcsErrors));

/**
 * Read-only accessor: true iff the code is in the retryable set. This is
 * the SOLE place the retryable-code policy is expressed — prefer this
 * over reading `RETRYABLE_VCS_ERRORS` directly.
 *
 * @param {VcsErrorCode | string} code
 * @returns {boolean}
 */
export function isRetryableVcsError(code) {
  return _retryableVcsErrors.has(code);
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
 * @param {{env?: NodeJS.ProcessEnv}} [opts] - `env`, when supplied, REPLACES
 *   the inherited `process.env` for this subprocess (e.g. `gitFixtureEnv()`
 *   for a caller exercising this function against an isolated test fixture).
 *   Omitted (the default) → identical to today's behaviour, full ambient
 *   inherit — every existing production call site is unaffected.
 * @returns {{ok: true, sha: string} | {ok: false, error: VcsError}}
 */
export function gitCommitSha(cwd, opts = {}) {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.env ? { env: opts.env } : {}),
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
 * Hash the **worktree's** content identity as a git tree object (WS-E / E1).
 *
 * This is the subject an audit actually read, and it is what `AI-Gate: passed`
 * binds its claim to. Two things about it are load-bearing:
 *
 * 1. **It hashes the WORKTREE, not the index.** A plain `git write-tree` hashes
 *    the index, but a code audit reads the files on disk, and the two diverge
 *    routinely (unstaged edits). If the index held a broken version while the
 *    worktree held the fix, the audit would evaluate the good content while the
 *    recorded identity named the broken index — and committing the index would
 *    then satisfy the equality check, re-opening the false-pass hole one level
 *    down. So we stage the worktree into a THROWAWAY index via `GIT_INDEX_FILE`
 *    and hash that. The repo's real index is never touched.
 * 2. **A commit SHA cannot substitute for it.** `ship-commit` validates trailers
 *    *before* the new commit exists, so HEAD is still the parent: audit a clean
 *    tree at A → pass → edit → commit compares `A === A` and succeeds while the
 *    claim it encodes is false. Only content identity survives a post-audit edit.
 *
 * `git add -A` honours `.gitignore`, so ignored paths (node_modules, `.audit/`)
 * are excluded — matching what an audit reads and keeping the hash stable.
 *
 * @param {string} cwd
 * @param {{env?: NodeJS.ProcessEnv}} [opts] - `env`, when supplied, is the
 *   base environment instead of `process.env` (still overridden with
 *   `GIT_INDEX_FILE` either way). Omitted (the default) → identical to
 *   today's intentional-inherit behaviour — see the comment below.
 * @returns {{ok: true, tree: string} | {ok: false, error: VcsError}}
 */
export function gitWorktreeTree(cwd, opts = {}) {
  let tmpIndex;
  try {
    tmpIndex = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tree-'));
  } catch (err) {
    return { ok: false, error: { code: 'EXEC_FAILED', message: `cannot create temp index dir: ${err?.code || 'unknown'}`, cause: err } };
  }
  const indexFile = path.join(tmpIndex, 'index');
  // Inherit the caller's env (or opts.env, when a caller explicitly wants
  // isolation — e.g. a test exercising this against a throwaway fixture)
  // so git still sees GIT_DIR/credentials/etc by default; only
  // GIT_INDEX_FILE is overridden, which is what keeps the real index pristine.
  const env = { ...(opts.env ?? process.env), GIT_INDEX_FILE: indexFile };
  try {
    // `read-tree HEAD` seeds the temp index so `add -A` records deletions
    // relative to HEAD rather than starting from an empty tree. A repo with no
    // commits yet has no HEAD — that is fine, the empty-index start is correct.
    // Gemini final-review catch (2026-07-24): a blanket `catch {}` here would
    // ALSO swallow a misdirected/corrupt GIT_DIR (exactly the failure mode this
    // plan's `opts.env` isolation exists to prevent regressions of) and silently
    // hash an empty-tree lie instead of surfacing it — this fn feeds the
    // `AI-Gate: passed` identity hash (see the docstring above), so a masked
    // failure here is load-bearing, not cosmetic. Only swallow the one message
    // git actually emits for "no HEAD yet"; anything else propagates.
    try {
      execSync('git read-tree HEAD', { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const stderr = String(err?.stderr || '');
      if (!/not a valid object name ['"]?head['"]?/i.test(stderr)) throw err;
      // else: no HEAD yet (fresh repo) — empty index is the right base
    }
    execSync('git add -A', { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tree = execSync('git write-tree', { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString().trim();
    if (!/^[0-9a-f]{40}$/.test(tree)) {
      return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: `git write-tree returned an unexpected object id: ${tree.slice(0, 60)}` } };
    }
    return { ok: true, tree };
  } catch (err) {
    return { ok: false, error: classifyChildError(err) };
  } finally {
    try { fs.rmSync(tmpIndex, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp cleanup is best-effort */ }
  }
}

/**
 * Hash the tree that a commit right now WOULD produce — i.e. the current index.
 *
 * This is the verifier's side of the E1 equality. It deliberately reads the
 * INDEX (not the worktree), because that is precisely what `git commit` will
 * turn into a tree. The asymmetry with {@link gitWorktreeTree} is intentional
 * and is the whole check: staging only a SUBSET of an audited worktree yields a
 * different tree and correctly degrades the gate to `not-run`, because a
 * whole-worktree audit does not cover a partial commit.
 *
 * @param {string} cwd
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{ok: true, tree: string} | {ok: false, error: VcsError}}
 */
export function gitIndexTree(cwd, opts = {}) {
  try {
    const tree = execSync('git write-tree', {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(opts.env ? { env: opts.env } : {}),
    })
      .toString().trim();
    if (!/^[0-9a-f]{40}$/.test(tree)) {
      return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: `git write-tree returned an unexpected object id: ${tree.slice(0, 60)}` } };
    }
    return { ok: true, tree };
  } catch (err) {
    return { ok: false, error: classifyChildError(err) };
  }
}

/**
 * Parse `git diff --name-status -z` output into bucketed file lists.
 *
 * Wire format: empty stdout is valid and yields empty buckets. Non-empty
 * stdout MUST end in a NUL — splitting on `\0` then yields exactly one
 * trailing empty token, which is discarded (it is not a record). An
 * interior empty token (an empty status, path, or rename endpoint) means
 * the stream is truncated or otherwise malformed and is NOT tolerated —
 * silently skipping it would desync every subsequent record.
 *
 * Token consumption per status letter (required for every letter, not
 * just the bucketed ones — an unconsumed or over-consumed token desyncs
 * the rest of the stream): `A`/`M`/`D`/`T`/`U`/`X`/`B` each consume 1
 * status token + 1 path token (2 total); `R`/`C` consume 1 status token +
 * 2 path tokens (from/to, 3 total). Only `A`/`M`/`D`/`R` are bucketed
 * (byte-identical to the pre-existing shape); `C`/`T`/`U`/`X`/`B` are
 * consumed to keep the stream aligned but produce no entry.
 *
 * @param {string} stdout
 * @returns {{ok: true, files: {added: string[], modified: string[], deleted: string[], renamed: {from: string, to: string}[]}} | {ok: false, error: VcsError}}
 */
function parseNameStatusZ(stdout) {
  const files = { added: [], modified: [], deleted: [], renamed: [] };
  if (stdout === '') return { ok: true, files };
  if (!stdout.endsWith('\0')) {
    return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: 'git diff --name-status -z output did not end with a NUL terminator' } };
  }
  const tokens = stdout.split('\0');
  tokens.pop(); // discard exactly one trailing token — the empty string after the final NUL

  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i];
    if (statusToken === '') {
      return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: `malformed git diff -z stream: empty status token at index ${i}` } };
    }
    const status = statusToken[0];
    if (status === 'R' || status === 'C') {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (!from || !to) {
        return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: `malformed git diff -z stream: incomplete ${status} record at index ${i}` } };
      }
      if (status === 'R') files.renamed.push({ from, to });
      i += 3;
    } else {
      const p = tokens[i + 1];
      if (!p) {
        return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: `malformed git diff -z stream: incomplete ${status} record at index ${i}` } };
      }
      if (status === 'A') files.added.push(p);
      else if (status === 'M') files.modified.push(p);
      else if (status === 'D') files.deleted.push(p);
      // C/T/U/X/B: token consumed, not bucketed.
      i += 2;
    }
  }
  return { ok: true, files };
}

/**
 * Parse `git ls-files --others --exclude-standard -z` output into a flat
 * path list. Same framing contract as {@link parseNameStatusZ} (empty
 * stdout valid; non-empty must end in NUL; exactly one trailing token
 * discarded) but each record is a single path — no status letter.
 *
 * @param {string} stdout
 * @returns {{ok: true, paths: string[]} | {ok: false, error: VcsError}}
 */
function parseUntrackedPathsZ(stdout) {
  if (stdout === '') return { ok: true, paths: [] };
  if (!stdout.endsWith('\0')) {
    return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: 'git ls-files -z output did not end with a NUL terminator' } };
  }
  const tokens = stdout.split('\0');
  tokens.pop();
  const paths = [];
  for (const t of tokens) {
    if (t === '') {
      return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: 'malformed git ls-files -z stream: empty path token' } };
    }
    paths.push(t);
  }
  return { ok: true, paths };
}

/**
 * Working-tree-aware diff: includes uncommitted + untracked entries.
 * Both git calls use `-z` (NUL-delimited) output, parsed via
 * {@link parseNameStatusZ}/{@link parseUntrackedPathsZ} — safe against
 * filenames containing spaces or newlines (the prior whitespace-splitting
 * regex parse truncated those).
 *
 * `sinceCommit` MUST already pass `isSafeGitRevision` — callers that take
 * the value from CLI flags should validate eagerly so a malformed input
 * surfaces as BAD_REVISION at the right layer.
 *
 * `trackedDiffOmitted` is `true` whenever `sinceCommit` is falsy: the
 * tracked-diff half of the call is skipped entirely (untracked files are
 * still collected) and this field makes that an explicit, checkable part
 * of the return shape rather than a silent gap a caller could mistake for
 * "no tracked changes" (one range, one resolver — see push-range.mjs).
 *
 * @param {string} cwd
 * @param {string | null | undefined} sinceCommit
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{ok: true, files: DiffShape, trackedDiffOmitted: boolean} | {ok: false, error: VcsError}}
 */
export function gitDiffWithWorkingTree(cwd, sinceCommit, opts = {}) {
  const files = { added: [], modified: [], deleted: [], untracked: [], renamed: [] };
  const trackedDiffOmitted = !sinceCommit;

  if (sinceCommit) {
    if (!isSafeGitRevision(sinceCommit)) {
      return {
        ok: false,
        error: { code: 'BAD_REVISION', message: `refusing unsafe --since-commit: ${JSON.stringify(sinceCommit).slice(0, 80)}` },
      };
    }
    let diffRes;
    try {
      diffRes = spawnSync('git', ['diff', '--name-status', '-z', sinceCommit], {
        cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...(opts.env ? { env: opts.env } : {}),
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
    const parsed = parseNameStatusZ(diffRes.stdout || '');
    if (!parsed.ok) return parsed;
    files.added = parsed.files.added;
    files.modified = parsed.files.modified;
    files.deleted = parsed.files.deleted;
    files.renamed = parsed.files.renamed;
  }

  let lsRes;
  try {
    lsRes = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...(opts.env ? { env: opts.env } : {}),
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
  const untrackedParsed = parseUntrackedPathsZ(lsRes.stdout || '');
  if (!untrackedParsed.ok) return untrackedParsed;
  files.untracked = untrackedParsed.paths;

  return { ok: true, files, trackedDiffOmitted };
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
/**
 * Cheap changed-line census: `git diff --numstat <base>` → one
 * `added\tdeleted\tpath` row per file. **Run this BEFORE materialising a
 * unified diff**, which is the whole point of its existence.
 *
 * Why it exists (adjacency plan R3-H1): a bound applied to a string you have
 * already built does not bound building it. `gitUnifiedDiffWithWorkingTree`
 * returns a fully-materialised string, so by the time a `maxBytes` check can
 * run, a 40MB diff has already been generated, buffered across the
 * child-process boundary, decoded and retained. Numstat is the preflight that
 * makes the bound real — measured at ~50 bytes vs ~10.7KB of unified diff for
 * the same single-file commit, and the ratio widens sharply with diff size.
 *
 * Binary files report `-` for both counts; they are reported as `binary:true`
 * with zero counts rather than being silently dropped, so a caller can decide.
 *
 * @param {string} cwd
 * @param {string} sinceCommit - MUST pass isSafeGitRevision
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{ok:true, files:{path:string, added:number, deleted:number, binary:boolean}[],
 *            totalChangedLines:number} | {ok:false, error:VcsError}}
 */
export function gitNumstatWithWorkingTree(cwd, sinceCommit, opts = {}) {
  if (!isSafeGitRevision(sinceCommit)) {
    return {
      ok: false,
      error: { code: 'BAD_REVISION', message: `refusing unsafe revision: ${JSON.stringify(String(sinceCommit)).slice(0, 80)}` },
    };
  }
  let res;
  try {
    res = spawnSync('git', ['diff', '--numstat', sinceCommit], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...(opts.env ? { env: opts.env } : {}),
    });
  } catch (err) {
    return { ok: false, error: classifyChildError(err, { wantedRev: sinceCommit }) };
  }
  if (res.error) return { ok: false, error: classifyChildError(res.error, { wantedRev: sinceCommit }) };
  if (res.status !== 0) {
    const synth = { stderr: res.stderr, status: res.status, signal: res.signal };
    return { ok: false, error: classifyChildError(synth, { wantedRev: sinceCommit }) };
  }

  const files = [];
  let totalChangedLines = 0;
  for (const line of (res.stdout || '').split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const added = binary ? 0 : Number(m[1]);
    const deleted = binary ? 0 : Number(m[2]);
    totalChangedLines += added + deleted;
    files.push({ path: m[3], added, deleted, binary });
  }
  return { ok: true, files, totalChangedLines };
}

/**
 * The unified diff of `sinceCommit` → **working tree**, with ZERO context lines.
 *
 * `--unified=0` is deliberate, not a micro-optimisation: with no context, a
 * hunk's `+` lines ARE its changes, so mapping a hunk to the set of new-side
 * lines it touches is exact rather than approximate. It is also the smallest
 * payload and the least to mis-parse.
 *
 * Base→working-tree (not base→HEAD) so new-side hunk coordinates index the
 * files actually on disk — the same snapshot a caller will parse. That
 * correspondence is what makes a hunk line number meaningful as an AST anchor.
 *
 * @param {string} cwd
 * @param {string} sinceCommit - MUST pass isSafeGitRevision
 * @param {{maxBytes?: number, env?: NodeJS.ProcessEnv}} [opts] - `maxBytes` is a
 *   belt-and-braces cap (the real bound is the numstat preflight); `env`
 *   replaces the inherited `process.env` when supplied.
 * @returns {{ok:true, diffText:string, truncated:false} | {ok:false, error:VcsError}}
 */
export function gitUnifiedDiffWithWorkingTree(cwd, sinceCommit, { maxBytes = null, env = null } = {}) {
  if (!isSafeGitRevision(sinceCommit)) {
    return {
      ok: false,
      error: { code: 'BAD_REVISION', message: `refusing unsafe revision: ${JSON.stringify(String(sinceCommit)).slice(0, 80)}` },
    };
  }
  let res;
  try {
    res = spawnSync('git', ['diff', '--unified=0', sinceCommit], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBuffer: maxBytes } : {}),
      ...(env ? { env } : {}),
    });
  } catch (err) {
    return { ok: false, error: classifyChildError(err, { wantedRev: sinceCommit }) };
  }
  if (res.error) return { ok: false, error: classifyChildError(res.error, { wantedRev: sinceCommit }) };
  if (res.status !== 0) {
    const synth = { stderr: res.stderr, status: res.status, signal: res.signal };
    return { ok: false, error: classifyChildError(synth, { wantedRev: sinceCommit }) };
  }
  return { ok: true, diffText: res.stdout || '', truncated: false };
}

/**
 * @param {string} cwd
 * @param {string} revision - MUST pass isSafeGitRevision
 * @param {string} filePath - repo-relative path, forward-slash form
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{ok: true, content: string} | {ok: false, error: VcsError}}
 */
export function gitShowFileAtRevision(cwd, revision, filePath, opts = {}) {
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
      ...(opts.env ? { env: opts.env } : {}),
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
 * Occurrence-specific pre-existence check for the tiered-recall Stage 0
 * evidence-relevance split (plan: docs/plans/stage0-evidence-relevance-split.md
 * decision #4/§4). Confirms whether a specific, ALREADY-DIFF-LINE-MAPPED
 * base-revision line range contains `quote`, unchanged since `baseSha` —
 * never a whole-file content search (round-2 plan-audit H1: a global search
 * can misclassify a genuinely new occurrence of a common snippet as
 * pre-existing when the SAME snippet also exists, unrelatedly, elsewhere in
 * the file).
 *
 * Deliberately takes NO free-floating "search the whole base file" mode —
 * `mappedBaseRange` MUST already be the caller's diff-derived mapping
 * (`evidence-triage.mjs::mapHeadRangeToBase`), not a raw guess.
 *
 * @param {string} cwd
 * @param {string} filePath - repo-relative path, forward-slash form
 * @param {{startLine: number, endLine: number}} mappedBaseRange - 1-indexed, inclusive
 * @param {string} quote - the anchor's own cited text, compared against the
 *   mapped range's content (round-3 plan-audit H1 — the comparison operand
 *   the earlier draft's signature omitted)
 * @param {string} baseSha - MUST already pass `isSafeGitRevision`
 * @param {{preloadedContent?: string, env?: NodeJS.ProcessEnv}} [opts] -
 *   `preloadedContent` (decision #5/M4's run-scoped caching): when the
 *   caller already fetched this file's base-revision content (e.g. a prior
 *   candidate cited the same file), pass it here to skip the
 *   `gitShowFileAtRevision` call entirely — one fetch per unique
 *   `(filePath, baseSha)` per run, not per candidate. Omitted (the default)
 *   → fetches internally, identical to this function's original behavior.
 *   `env`, when supplied and `preloadedContent` is absent, is forwarded to
 *   that internal `gitShowFileAtRevision` call.
 * @returns {boolean | null} `true` if `quote` (source-preservingly
 *   canonicalized — see below) is found within the mapped range's content
 *   at `baseSha`; `false` if the range exists but the content differs
 *   (genuinely new/moved/reworded); `null` on any resolution failure —
 *   file didn't exist at `baseSha` (added by this commit), an unreadable
 *   revision, an out-of-bounds range, or an empty quote — fail-closed,
 *   never guessed.
 */
export function contentExistsAtMappedRange(cwd, filePath, mappedBaseRange, quote, baseSha, opts = {}) {
  let content;
  if (typeof opts.preloadedContent === 'string') {
    content = opts.preloadedContent;
  } else {
    const result = gitShowFileAtRevision(cwd, baseSha, filePath, opts.env ? { env: opts.env } : {});
    if (!result.ok) return null;
    content = result.content;
  }
  const canonQuote = canonicalizeForOccurrenceMatch(quote);
  if (!canonQuote) return null;
  const lines = content.split('\n');
  const { startLine, endLine } = mappedBaseRange || {};
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  if (startLine < 1 || startLine > endLine || endLine > lines.length) return null;
  const windowContent = lines.slice(startLine - 1, endLine).join('\n');
  return canonicalizeForOccurrenceMatch(windowContent).includes(canonQuote);
}

/**
 * Source-preserving canonicalization for `contentExistsAtMappedRange`'s
 * exact-occurrence comparison — deliberately NOT `normalizeWhitespace`
 * (round-2 plan-audit-code H2: `normalizeWhitespace` collapses every
 * interior whitespace run, so `"a  b"` and `"a b"` compare equal — fine for
 * Gate A's coarser "is this a real quote" question, where a false-negative
 * is the unsafe direction, but wrong for Gate B's "is this EXACTLY
 * unchanged" question, where a false-positive match inside a string
 * literal, template literal, or comment would misclassify genuinely new
 * content as pre-existing). Only tolerates line-ending differences and
 * per-line leading/trailing whitespace (indentation) — never collapses
 * whitespace WITHIN a line.
 *
 * @param {string} s
 * @returns {string}
 */
function canonicalizeForOccurrenceMatch(s) {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

/**
 * Test-only: re-export the classifier so unit tests can drive each
 * VcsErrorCode without a live git environment. NOT part of the public API.
 *
 * @internal
 */
export const _internals = Object.freeze({ classifyChildError, parseNameStatusZ, parseUntrackedPathsZ });
