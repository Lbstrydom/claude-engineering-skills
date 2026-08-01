/**
 * @fileoverview Repo-local scratch paths for artifacts someone reads LATER.
 *
 * Two classes of transient file, two homes — the distinction is the AUDIENCE,
 * not the lifetime:
 *
 *   1. Disposable, private to one run (test sandboxes, extracted archives,
 *      intermediate files deleted before the command exits).
 *      → `fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-'))`. Already the
 *        idiomatic Node form; it needs no wrapper, so this module deliberately
 *        does not provide one. Just never spell the temp root as a literal.
 *
 *   2. Inspectable later by a human, an agent, or a subsequent step (reports,
 *      ledgers, debug dumps, handoff JSON).
 *      → `scratchPath()` here: `<repo>/.claude/tmp/...`, gitignored in this
 *        repo and in every consumer.
 *
 * Putting class 2 in the OS temp directory is what makes artifacts hard to
 * find. On Windows there are three different "temp" resolutions live at once —
 * git-bash/MSYS rewrites a `/tmp` **argv** to `%LOCALAPPDATA%\Temp`, Node
 * resolves a literal `'/tmp'` path to `<drive>:\tmp`, and `os.tmpdir()` returns
 * `%LOCALAPPDATA%\Temp` — so "it wrote to /tmp" identifies no single directory.
 * That ambiguity has already cost one full mis-triage. A repo-relative path
 * resolves identically under MSYS, cmd, PowerShell, Node and Docker, because
 * MSYS only rewrites arguments that look like absolute POSIX paths.
 *
 * Still echo the resolved absolute path when another PROCESS must read the
 * file (see `ledger.mjs`): argv crossing a git-bash boundary is rewritten
 * regardless of how disciplined the code that built the path was.
 *
 * @module scripts/lib/temp-paths
 */
import fs from 'node:fs';
import path from 'node:path';
import { findRepoRootFromScript } from './assert-repo-root.mjs';

/** Repo-relative home for class-2 artifacts. Gitignored in source + consumers. */
const SCRATCH_SEGMENTS = ['.claude', 'tmp'];

/**
 * Repo root that owns this module. Resolved from the module's own location
 * rather than `process.cwd()`, so it stays correct when a script is invoked
 * from elsewhere (several test harnesses deliberately set cwd to os.tmpdir()),
 * and it resolves to the CONSUMER root for the synced copy under
 * `scripts/.claude-skills/`.
 */
function repoRoot() {
  return findRepoRootFromScript(import.meta.url) || process.cwd();
}

/**
 * Absolute path to the repo-local scratch directory, created if absent.
 *
 * @returns {string} `<repo>/.claude/tmp`
 */
export function scratchDir() {
  const dir = path.join(repoRoot(), ...SCRATCH_SEGMENTS);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Absolute path for a class-2 artifact under the scratch directory. Parent
 * directories are created; the file itself is not.
 *
 * Caller-supplied segments are confined to the scratch directory — a segment
 * containing `..` cannot be used to escape it.
 *
 * @param {...string} segments - Path segments, e.g. `('audit', 'ledger.json')`.
 * @returns {string} Absolute path.
 */
export function scratchPath(...segments) {
  if (segments.length === 0) return scratchDir();
  const base = scratchDir();
  const full = path.resolve(base, ...segments);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`scratchPath: segments escape the scratch directory: ${segments.join('/')}`);
  }
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  return full;
}

export const _internals = Object.freeze({ SCRATCH_SEGMENTS, repoRoot });
