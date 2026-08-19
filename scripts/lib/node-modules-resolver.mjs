/**
 * @fileoverview Find the `node_modules` a directory would actually resolve
 * against — Node's own upward walk, not `path.join(root, 'node_modules')`.
 *
 * **The failure class this exists to stop.** A git WORKTREE has no
 * `node_modules` of its own. Everything else in a worktree still works, because
 * Node walks up and — for a worktree nested inside the main checkout, which is
 * how this repo's are created — finds the main checkout's copy. Any tool that
 * hard-codes `<repoRoot>/node_modules` therefore breaks in a worktree and
 * nowhere else, which is the worst place for a bug to live: it never reproduces
 * where anyone is looking. AGENTS.md records it as a standing rule ("never
 * hand-link one in").
 *
 * It has now been found twice. `check-gate-poison-pills.mjs` hit it 2026-08-08
 * (linking a path that did not exist; on Windows a junction to a MISSING target
 * succeeds, so the try/catch never fired and the only symptom was a control run
 * dying on `Cannot find package 'zod'`). `prepush-check.mjs` hit it again
 * 2026-08-11: its `existsSync(<repoRoot>/node_modules)` was false in every
 * worktree, so the instant-link fast path was unreachable and every push in a
 * worktree paid a full `npm ci`. A second finding is what turned a private
 * helper into a shared one — two copies of this walk would be two chances to
 * regress it.
 *
 * @module scripts/lib/node-modules-resolver
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Nearest real `node_modules` at or above `startDir`, mirroring Node's own
 * upward resolution.
 *
 * Resolving the way Node does makes a copied or linked tree behave like the
 * checkout it came FROM, which is the property callers actually need.
 *
 * Returns null when nothing is found anywhere up the chain — a real "you have
 * not installed dependencies" state, which the caller must report as such rather
 * than proceed into.
 *
 * @param {string} startDir
 * @returns {string|null} absolute path to a node_modules directory, or null
 */
export function findNodeModules(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    // existsSync follows links, so a dangling junction correctly reads as absent.
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Cheap corruption fingerprint for a node_modules directory: its top-level
 * entry count.
 *
 * Not a full hash, and not meant to catch legitimate content drift — it
 * exists so the pre-push sandbox (which links the MAIN checkout's real
 * node_modules into a throwaway worktree via provisionNodeModules()) can
 * detect anything that reaches back through that link and deletes from the
 * real tree during the run, and say so loudly instead of silently.
 *
 * @param {string} dir
 * @returns {number|null} entry count, or null if the directory is unreadable
 */
export function countTopLevelEntries(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return null;
  }
}
