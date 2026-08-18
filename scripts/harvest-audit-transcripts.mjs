#!/usr/bin/env node
/**
 * @fileoverview `harvest-audit-transcripts` — sweep every checkout of this
 * repository for audit transcripts and copy them into the main checkout's
 * durable archive.
 *
 * This is the BACKSTOP, not the primary mechanism. The primary is the
 * mirror-at-write in `lib/audit/transcript-archive.mjs`, which is durable by
 * construction. The sweep exists for the three cases the mirror cannot cover:
 *
 *   1. worktrees created BEFORE the mirror shipped, whose transcripts are still
 *      on disk (measured 2026-08-18: one live worktree held four);
 *   2. a transcript written by any path that did not go through the helper;
 *   3. the deregistered-orphan case below.
 *
 * **WHY IT WALKS THE FILESYSTEM AND NOT JUST GIT.** On 2026-08-18
 * `.claude/worktrees/` held four directories while `git worktree list` reported
 * only two of them — a failed `git worktree remove` deregisters the worktree
 * and can still leave it on disk. The first scan of that investigation iterated
 * `git worktree list` and was blind to both orphans. Those two happened to be
 * empty, but a teardown that fails MIDWAY leaves real artifacts somewhere no
 * git-based scan can reach. So candidates are the UNION of two enumerations,
 * because each is blind where the other sees:
 *
 *   filesystem `<main>/.claude/worktrees/*`  → catches deregistered orphans,
 *                                              misses worktrees living elsewhere
 *   `git worktree list --porcelain`          → catches worktrees anywhere,
 *                                              misses what git has forgotten
 *
 * Deleting either half re-opens a hole that has already cost transcripts;
 * `tests/audit-transcript-durability.test.mjs` pins both directions.
 *
 * COPY ONLY — this never deletes a source. Reclaiming disk is `audit-clean.mjs`'s
 * job and it is not this command's business to do it implicitly.
 *
 * Usage:
 *   node scripts/harvest-audit-transcripts.mjs [--json] [--quiet]
 *
 * EXIT CODES. `0` only when every transcript found is now in the archive —
 * finding nothing is a legitimate `0`, because nothing was at risk. `1` when
 * the repository could not be resolved, or when ANY discovered transcript
 * could not be archived: this command exists to repair durability, so a
 * partial repair reported as success leaves those sources one `git worktree
 * remove` from being lost while the operator believes they are safe.
 *
 * @module scripts/harvest-audit-transcripts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertKnownFlags } from './lib/cli-io.mjs';
import { resolveMainRoot } from './lib/pinned-worktree/paths.mjs';
import {
  ARCHIVE_REASONS, TRANSCRIPT_BASENAME_RE, archiveTranscript, canonicalPathKey, resolveArchiveDir,
} from './lib/audit/transcript-archive.mjs';

const KNOWN_FLAGS = ['--json', '--quiet', '--selfcheck-relocation'];

/** Where the harness parks its throwaway worktrees, relative to the main checkout. */
const HARNESS_WORKTREE_RELDIR = path.join('.claude', 'worktrees');

/**
 * The only `readdir` failures that mean "this optional directory is not here".
 *
 * Everything else — EACCES, EIO, EMFILE — means the directory may hold
 * transcripts this sweep could not see, and swallowing it makes an unreadable
 * checkout indistinguishable from an empty one. Same distinction
 * `audit-clean.mjs` draws with its own benign-code set, and the same class as
 * the git-enumeration failure below: a scan that could not look must never
 * report the same result as a scan that looked and found nothing.
 */
const ABSENT_FS_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Is this `readdir` failure just "the directory is not there"?
 *
 * Exported as the testable seam for the classification: EACCES cannot be
 * produced portably in a unit test (Windows ignores `chmod`), so the decision
 * is tested directly rather than through a filesystem it is impossible to
 * stage on every platform.
 *
 * @param {string|undefined} code
 * @returns {boolean}
 */
export function isAbsentDirError(code) {
  return ABSENT_FS_CODES.has(code);
}

/** Default sink for a scan error — loud, because the alternative is silence. */
function defaultScanError({ dir, code, message }) {
  process.stderr.write(`  [harvest] UNREADABLE: ${dir} (${code || message}) — not swept\n`);
}

/**
 * Dedup key for a candidate directory — the shared `canonicalPathKey`, never a
 * local rule.
 *
 * A false merge here means a real worktree is never scanned, i.e. losing
 * exactly the transcripts this command exists to rescue. Two rejected
 * approaches: unconditional lowercasing (wrong on any case-sensitive volume),
 * and case-folding by `process.platform` (wrong on case-sensitive APFS and on
 * per-directory case-sensitive NTFS — a guess dressed as a rule). Asking the
 * filesystem is the only answer that does not encode a guess.
 */
const key = canonicalPathKey;

/**
 * Directories under `<main>/.claude/worktrees/`, straight off the filesystem.
 *
 * The half git cannot provide. Symlinked entries are skipped — the same
 * boundary `audit-clean.mjs` draws, for the same reason: a link makes a
 * lexically-scoped walk reach outside the tree.
 *
 * @param {string} mainRoot
 * @returns {string[]}
 */
export function worktreeDirsOnDisk(mainRoot, { onError = defaultScanError } = {}) {
  const base = path.join(mainRoot, HARNESS_WORKTREE_RELDIR);
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (!isAbsentDirError(err.code)) onError({ dir: base, code: err.code, message: err.message });
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && !e.isSymbolicLink())
    .map(e => path.join(base, e.name));
}

/**
 * Worktree paths git knows about (main checkout included; the caller filters).
 *
 * The half the filesystem scan cannot provide: a registered worktree can live
 * anywhere — `C:/GIT/ces-bakeoff`, a pinned-revision fixture beside the repo.
 *
 * @param {string} mainRoot
 * @returns {{ok: boolean, dirs: string[], error?: string}} — `ok:false` means git
 *   ENUMERATION FAILED, which is not the same fact as "no worktrees".
 */
export function worktreeDirsFromGit(mainRoot) {
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: mainRoot, encoding: 'utf-8' });
  } catch (err) {
    // A git failure is NOT "no worktrees". Collapsing the two would let this
    // half of the union die silently and still report a clean sweep — the
    // "green having checked nothing" failure the whole union exists to avoid.
    return { ok: false, dirs: [], error: err.message };
  }
  const dirs = out.split('\n')
    .filter(line => line.startsWith('worktree '))
    // Strip ONLY the CR of a CRLF split, never `.trim()`: on a case-sensitive
    // filesystem a trailing space is a legal part of a path, and trimming it
    // addresses a different directory than the one git named.
    .map(line => line.slice('worktree '.length).replace(/\r$/, ''))
    .filter(Boolean);
  return { ok: true, dirs };
}

/**
 * Every checkout to sweep — the union, deduped, minus anything that is not a
 * readable directory.
 *
 * **The main checkout is INCLUDED**, and that is not an oversight. Its
 * `.audit/` survives worktree teardown, but `audit-clean.mjs` caps the working
 * copies at the newest 25 — so the main checkout is durable against the defect
 * this command was written for and NOT durable against the retention policy.
 * The archive is what campaigns replay from, so a transcript that only ever
 * lived in the main checkout is still on a clock. Excluding it would have made
 * the archive silently incomplete.
 *
 * @param {string} mainRoot
 * @returns {{dirs: string[], gitEnumerationFailed: boolean, gitError: string|null}}
 */
export function candidateWorktrees(mainRoot, { onError = defaultScanError } = {}) {
  const git = worktreeDirsFromGit(mainRoot);
  const seen = new Set();
  const dirs = [];
  for (const dir of [mainRoot, ...worktreeDirsOnDisk(mainRoot, { onError }), ...git.dirs]) {
    const k = key(dir);
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch (err) {
      // Same policy as the readdir sites, not a looser one: a worktree git
      // still lists but whose directory is gone is an expected stale
      // registration and skippable; EACCES/EIO is a candidate we could not
      // even classify, and must be visible rather than quietly dropped.
      if (!isAbsentDirError(err.code)) onError({ dir, code: err.code, message: err.message });
      continue;
    }
    dirs.push(path.resolve(dir));
  }
  return { dirs, gitEnumerationFailed: !git.ok, gitError: git.error ?? null };
}

/**
 * Transcript files in one worktree's `.audit/`. Non-recursive: transcripts are
 * written at the top of `.audit/`, and descending would pull in bake-off and
 * model-eval scratch trees that are not session transcripts.
 *
 * @param {string} worktreeDir
 * @returns {string[]}
 */
export function transcriptsIn(worktreeDir, { onError = defaultScanError } = {}) {
  const dir = path.join(worktreeDir, '.audit');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A checkout with no `.audit/` is the common case and not an error; one we
    // were REFUSED entry to is a hole in the sweep and must be said out loud.
    if (!isAbsentDirError(err.code)) onError({ dir, code: err.code, message: err.message });
    return [];
  }
  return entries
    .filter(e => e.isFile() && TRANSCRIPT_BASENAME_RE.test(e.name))
    .map(e => path.join(dir, e.name))
    .sort();
}

/**
 * Run the sweep.
 *
 * `unreadable` collects directories the sweep was REFUSED (EACCES/EIO/…), as
 * distinct from directories that simply are not there. Each one is a place a
 * transcript could be hiding that this run did not look in, so it counts as an
 * incomplete sweep, not a clean one.
 *
 * @param {{cwd?: string}} [opts]
 * @returns {{ok: boolean, archiveDir: string|null, checkouts: number, found: number,
 *            archived: number, alreadyPresent: number, failed: Array<{source: string, reason: string}>,
 *            unreadable: Array<{dir: string, code: string}>,
 *            gitEnumerationFailed: boolean, gitError: string|null}}
 */
export function harvest({ cwd = process.cwd() } = {}) {
  let mainRoot;
  try {
    mainRoot = resolveMainRoot(cwd);
  } catch {
    return {
      ok: false, archiveDir: null, checkouts: 0, found: 0, archived: 0,
      alreadyPresent: 0, failed: [], unreadable: [], gitEnumerationFailed: false, gitError: null,
    };
  }
  const archiveDir = resolveArchiveDir(cwd);
  const unreadable = [];
  const onError = ({ dir, code, message }) => unreadable.push({ dir, code: code || message });
  const { dirs, gitEnumerationFailed, gitError } = candidateWorktrees(mainRoot, { onError });

  let found = 0; let archived = 0; let alreadyPresent = 0;
  const failed = [];
  for (const wt of dirs) {
    for (const src of transcriptsIn(wt, { onError })) {
      found += 1;
      // `mainRoot` is passed rather than re-derived per file: one `git
      // rev-parse` for the whole sweep instead of one per transcript.
      const outcome = archiveTranscript(src, { cwd: mainRoot, archiveDir, mainRoot });
      if (outcome.reason === ARCHIVE_REASONS.ARCHIVED) archived += 1;
      else if (outcome.archived) alreadyPresent += 1;
      else failed.push({ source: src, reason: outcome.reason });
    }
  }
  return {
    ok: true, archiveDir, checkouts: dirs.length, found, archived,
    alreadyPresent, failed, unreadable, gitEnumerationFailed, gitError,
  };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'harvest-audit-transcripts' });

  const jsonMode = process.argv.includes('--json');
  const quiet = process.argv.includes('--quiet');
  const result = harvest();

  if (!result.ok) {
    if (jsonMode) console.log(JSON.stringify({ ok: false, reason: 'not-in-a-repo' }));
    else console.error('harvest-audit-transcripts: not inside a git repository — nothing to sweep.');
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(result));
  } else if (!quiet || result.archived > 0 || result.failed.length > 0 || result.gitEnumerationFailed) {
    // `--quiet` still speaks when something CHANGED or something failed: a
    // silent failure in a non-blocking hook is a failure nobody learns about.
    console.log(
      `harvest-audit-transcripts: ${result.archived} archived, ${result.alreadyPresent} already present`
      + ` (${result.found} found across ${result.checkouts} checkout(s)) → ${result.archiveDir}`,
    );
  }
  if (result.gitEnumerationFailed) {
    // Say it, and say what it costs: the sweep ran on the filesystem half
    // alone, so a registered worktree outside `.claude/worktrees/` was not
    // visited. A partial sweep must never read as a complete one.
    process.stderr.write(
      `  [harvest] PARTIAL: \`git worktree list\` failed (${result.gitError}) — only`
      + ' `.claude/worktrees/` was swept; registered worktrees elsewhere were NOT visited.\n',
    );
  }
  for (const f of result.failed) {
    process.stderr.write(`  [harvest] NOT archived: ${f.source} — ${f.reason}\n`);
  }
  for (const u of result.unreadable) {
    process.stderr.write(`  [harvest] UNREADABLE: ${u.dir} (${u.code}) — not swept\n`);
  }
  // A partial repair must not exit 0. This command's whole job is to make
  // at-risk transcripts durable; reporting success while some remain only in a
  // removable worktree is the same "failure in the envelope, success in the
  // exit code" defect the build-side gate closes. An UNREADABLE directory
  // counts: it is a place a transcript could be that this run did not look in.
  if (result.failed.length > 0 || result.unreadable.length > 0) process.exitCode = 1;
}

// Guarded so the enumeration helpers can be imported by tests without the
// sweep firing as an import side effect against the real repository.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
