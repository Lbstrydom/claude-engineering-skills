/**
 * @fileoverview Garbage collection of files a consumer no longer receives —
 * what to delete, deleting it safely, and reporting what actually happened.
 *
 * ## Why this is not five lines in the sync loop any more
 *
 * It was, and each of those lines had a hole (verified by fixture, 2026-10-13,
 * docs/plans/sync-to-repos-failure-honesty.md):
 *
 *   - **No containment.** It unlinked `path.join(root, key)` directly. Every
 *     WRITE goes through `assertContainedDestination`, because a managed
 *     destination (`scripts/.claude-skills/` itself) can be a junction pointing
 *     out of the consumer — but the write guard only runs on files that
 *     CHANGE, so on a steady-state run nothing at all noticed the junction, and
 *     gc deleted a file outside the repo it was pointed at.
 *   - **A prefix test is not a path test.** `scripts/.claude-skills/../../x`
 *     starts with the tooling prefix and resolves INSIDE the root, so even
 *     containment would let it delete the consumer's own `x`. Manifest keys are
 *     only ever written by the sync, so a key that does not normalise to itself
 *     names nothing we wrote — and is refused, not trusted.
 *   - **Requested ≠ done.** A failed unlink only warned. The receipt still listed
 *     the path under `gcDeleted`, the replacement manifest dropped it (so no
 *     later run would ever retry it), and the run exited 0 — leaving a retired
 *     file in the tooling tree for ever, under a record saying it was gone.
 *
 * So: plan (pure) → execute (every path through the containment oracle, each
 * with its own outcome) → the caller records only what happened. Failures stay
 * in the manifest so the next run retries them, and fail the run.
 *
 * @module scripts/lib/sync-gc
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { assertContainedDestination } from './install/safe-destination.mjs';

/**
 * Is this manifest key a plain, normalised, POSIX repo-relative path?
 *
 * @param {string} key
 * @returns {boolean}
 */
function isPlainRelativeKey(key) {
  if (typeof key !== 'string' || key === '' || key.includes('\\') || path.posix.isAbsolute(key)) return false;
  if (key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return path.posix.normalize(key) === key;
}

/**
 * Decide what gc should do with the prior manifest's keys. PURE.
 *
 * - A key still intended this run is not gc's business.
 * - A key that is not a plain normalised relative path names nothing the sync
 *   ever wrote: `unsafeKeys` — never deleted, never advised, reported.
 * - A key under the tooling dir is gitignored, regenerable payload: delete it.
 * - Anything else is a TRACKED consumer path: deleting it would be a commit in
 *   someone's repo, so it is only ADVISED (`orphanedTracked`), and only while it
 *   still exists. `exists` is consulted for that advisory and nothing else —
 *   deletion candidates are never pre-filtered by existence, so a dangling link
 *   still reaches the executor and gets an honest outcome there.
 *
 * @param {object} args
 * @param {Record<string, string>} args.priorFiles  prior manifest `files`
 * @param {Set<string>} args.intendedDests          destinations written/held this run
 * @param {string} args.toolingDir                  e.g. `scripts/.claude-skills`
 * @param {(rel: string) => boolean} args.exists
 * @returns {{deletions: string[], orphanedTracked: string[], unsafeKeys: string[]}}
 */
export function planGarbageCollection({ priorFiles, intendedDests, toolingDir, exists }) {
  const prefix = `${toolingDir}/`;
  const deletions = [];
  const orphanedTracked = [];
  const unsafeKeys = [];
  for (const key of Object.keys(priorFiles || {})) {
    if (intendedDests.has(key)) continue;
    if (!isPlainRelativeKey(key)) unsafeKeys.push(key);
    else if (key.startsWith(prefix)) deletions.push(key);
    else if (exists(key)) orphanedTracked.push(key);
  }
  return { deletions, orphanedTracked, unsafeKeys };
}

/**
 * Delete each planned path through the containment oracle, recording an
 * outcome per path. Never throws.
 *
 * `absent` (ENOENT) is the goal state, but this run did not delete it — so it
 * is not claimed as deleted. `failed` covers a refused containment check and
 * every other unlink error.
 *
 * @param {object} args
 * @param {string} args.root
 * @param {string[]} args.deletions
 * @param {(p: string) => void} [args.unlink]
 * @param {(a: {root: string, relPath: string}) => string} [args.contain]
 * @returns {{deleted: string[], absent: string[], failed: Array<{path: string, reason: string}>}}
 */
export function executeGarbageCollection({
  root, deletions, unlink = fs.unlinkSync, contain = assertContainedDestination,
}) {
  const deleted = [];
  const absent = [];
  const failed = [];
  for (const rel of deletions) {
    let abs;
    try {
      abs = contain({ root, relPath: rel });
    } catch (err) {
      failed.push({ path: rel, reason: `refused: ${err.message}` });
      continue;
    }
    try {
      unlink(abs);
      deleted.push(rel);
    } catch (err) {
      if (err?.code === 'ENOENT') absent.push(rel);
      else failed.push({ path: rel, reason: `${err?.code ?? 'error'}: ${err?.message ?? String(err)}` });
    }
  }
  return { deleted, absent, failed };
}

/**
 * How many tracked files still cite `rel` (excluding `rel` itself)?
 *
 * Advisory only — it decides what the operator is told, never what is deleted.
 * No shell: the path is an argv element and the pattern goes in via `-e`, so
 * neither `%VAR%`/`$VAR` expansion nor a leading `-` can change what runs.
 *
 * @param {string} repoRoot
 * @param {string} rel
 * @param {{run?: (file: string, args: string[], opts: object) => string}} [opts]
 * @returns {{count: number} | {count: null, reason: string}}
 *   `{count: 0}` on git grep's "no match" (exit 1, stderr empty); `count: null` when the
 *   question could not be answered — never rendered as "no citations".
 */
export function countCitations(repoRoot, rel, { run = execFileSync } = {}) {
  try {
    // `-z`: NUL-terminated, UNQUOTED names. The default output quotes a path
    // with non-ASCII bytes (core.quotePath), so `docs/café.md` would never
    // compare equal to itself and would count as its own citation.
    const out = run('git', ['grep', '-l', '-z', '-F', '-e', rel], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    return { count: String(out).split('\0').filter((name) => name !== '' && name !== rel).length };
  } catch (err) {
    // Exit 1 is "no match" only when git said nothing else: an unreadable file
    // is reported on stderr, and a search that skipped one cannot claim zero.
    if (err?.status === 1 && !String(err.stderr ?? '').trim()) return { count: 0 };
    if (err?.status === 1) return { count: null, reason: `incomplete search: ${String(err.stderr).trim().split('\n')[0].slice(0, 120)}` };
    const why = err?.status != null ? `git exited ${err.status}` : (err?.code ?? err?.signal ?? 'spawn failed');
    return { count: null, reason: String(why) };
  }
}

/**
 * Prior manifest entries to carry forward for deletions that FAILED, so the
 * next run sees them again and retries. PURE.
 *
 * @param {Array<{path: string}>} failed
 * @param {Record<string, string>} priorFiles
 * @returns {Record<string, string>}
 */
export function carriedForFailedDeletions(failed, priorFiles) {
  const out = {};
  for (const { path: rel } of failed) {
    if (priorFiles?.[rel]) out[rel] = priorFiles[rel];
  }
  return out;
}
