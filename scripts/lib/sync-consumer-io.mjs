/**
 * @fileoverview The ONE seam through which the sync reads and mutates a
 * consumer's files (debts 3b96a5ef7971, 8fca02c6915a; plan
 * docs/plans/sync-to-repos-debt-cluster.md §2 C).
 *
 * Two defects shared a root:
 *
 *  - Payload writes went through `assertContainedDestination`, but the sync's own
 *    bookkeeping (journal, manifest, ownership sidecar, watermark, receipt,
 *    managed `.gitignore`/`.gitattributes` blocks) was written to a plain
 *    `path.join`. A consumer whose `scripts/.claude-skills/` is a symlink or
 *    Windows junction therefore had its manifest written OUTSIDE the repo.
 *  - Reads were `try { ... } catch { null }`, which cannot tell "the file is not
 *    there" from "the file is there and could not be read". An existing,
 *    unreadable `.gitignore` read as absent, so the managed-block writer built a
 *    fresh file holding only its own block and REPLACED the consumer's.
 *
 * So a read answers in four states and a mutation is always contained first:
 *
 *   absent      ENOENT/ENOTDIR on a path that passed containment
 *   present     the file, with its text
 *   unreadable  it exists (or may) and could not be read: EACCES, EIO, EISDIR...
 *   refused     containment rejected the path (a symlink or reparse point in it)
 *
 * `absent` is the ONLY state a caller may treat as "no file". A caller that
 * folds `unreadable` or `refused` into it is the bug this module exists to end.
 *
 * RESIDUAL, stated rather than hidden: containment is checked, then the path is
 * used again, so a process that replaces a checked directory with a link in that
 * gap can still redirect one operation. Node exposes no `openat`/`O_NOFOLLOW`
 * directory handle to close it, and the payload writes always had the same
 * window. The threat needs a concurrent writer inside the consumer's own tree,
 * i.e. someone who can already write there; the per-consumer lock excludes the
 * cooperating writer (another sync), nothing excludes an adversarial one.
 *
 * @module scripts/lib/sync-consumer-io
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertContainedDestination } from './install/safe-destination.mjs';
import { atomicWriteFileSync } from './file-io.mjs';
import { withFileLock } from './file-lock.mjs';
import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';

/** @typedef {{state: 'absent'} | {state: 'present', content: string} | {state: 'unreadable', code: string|null, message: string} | {state: 'refused', reason: string}} ConsumerRead */

/**
 * Read one consumer file as text, in the four states above. Never throws.
 *
 * @param {string} root  canonical consumer root
 * @param {string} rel   path relative to `root`
 * @param {{read?: (abs: string) => string, contain?: (a: {root: string, relPath: string}) => string}} [seams]
 * @returns {ConsumerRead}
 */
export function readConsumerFile(root, rel, { read = (abs) => fs.readFileSync(abs, 'utf-8'), contain = assertContainedDestination } = {}) {
  let abs;
  try { abs = contain({ root, relPath: rel }); } catch (err) { return { state: 'refused', reason: err.message }; }
  try { return { state: 'present', content: read(abs) }; } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'unreadable', code: err?.code ?? null, message: err?.message ?? String(err) };
  }
}

/**
 * Parse a consumer JSON file. Same four states as `readConsumerFile`, plus
 * `malformed` for text that is there but is not JSON. `absent` stays distinct.
 * @returns {ConsumerRead | {state: 'present', content: string, json: any} | {state: 'malformed', message: string}}
 */
export function readConsumerJson(root, rel, seams) {
  const r = readConsumerFile(root, rel, seams);
  if (r.state !== 'present') return r;
  try { return { ...r, json: JSON.parse(r.content) }; } catch (err) { return { state: 'malformed', message: err.message }; }
}

/**
 * Hash a consumer file's RAW bytes in the manifest's own form (`sha256:<hex>`), containing the path first. Never throws.
 * @returns {{state: 'present', hash: string} | {state: 'absent'} | {state: 'refused'|'failed', reason: string}}
 */
export function hashConsumerFile(root, rel, { read = fs.readFileSync, contain = assertContainedDestination } = {}) {
  let abs;
  try { abs = contain({ root, relPath: rel }); } catch (err) { return { state: 'refused', reason: err.message }; }
  try { return { state: 'present', hash: `sha256:${createHash('sha256').update(read(abs)).digest('hex')}` }; } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'failed', reason: `${err?.code ?? 'error'}: ${err?.message ?? String(err)}` };
  }
}

/**
 * Write a consumer file, containing the destination first. Creates parent
 * directories. Throws (a containment refusal or an fs error) — callers decide
 * whether that is fatal; it is never swallowed here.
 * @param {string} root
 * @param {string} rel
 * @param {string|Buffer} content
 * @returns {string} the absolute path written
 */
export function writeConsumerFile(root, rel, content, { contain = assertContainedDestination, write = atomicWriteFileSync, mkdir = fs.mkdirSync } = {}) {
  const abs = contain({ root, relPath: rel });
  mkdir(path.dirname(abs), { recursive: true });
  write(abs, content);
  return abs;
}

/**
 * Remove a consumer file, containing the path first.
 * @returns {{state: 'removed'} | {state: 'absent'} | {state: 'failed', reason: string}}
 */
export function removeConsumerFile(root, rel, { contain = assertContainedDestination, unlink = fs.unlinkSync } = {}) {
  let abs;
  try { abs = contain({ root, relPath: rel }); } catch (err) { return { state: 'failed', reason: `refused: ${err.message}` }; }
  try { unlink(abs); return { state: 'removed' }; } catch (err) {
    if (err?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'failed', reason: `${err?.code ?? 'error'}: ${err?.message ?? String(err)}` };
  }
}

/**
 * Hold the per-consumer lock for the duration of a target's sync.
 *
 * The sync runs from `.githooks/pre-push` in every worktree, so two pushes can
 * run two syncs into the SAME consumer, racing on payload files, the manifest and
 * the receipt. This serialises them using the repo's existing sentinel-file lock
 * (`file-lock.mjs`: `wx` acquire carrying pid + token, stale recovery that needs a
 * dead pid AND an old mtime, token-checked release).
 *
 * `withFileLock` takes a callback; the target body is a long loop body with many
 * `continue`s, so the callback here only parks until `release()` — the lock is
 * held exactly as long as the caller holds the handle.
 *
 * It does not exclude a non-cooperating writer (an editor, a `git checkout` of a
 * tracked file); the receipt commit detects and discloses that case instead.
 *
 * The lock file's parent must exist for the `wx` open, so it is created first —
 * through the same containment check as every other consumer write.
 *
 * @param {string} root  canonical consumer root
 * @param {{maxWaitMs?: number, lock?: typeof withFileLock, contain?: Function, mkdir?: Function}} [opts]
 * @returns {Promise<{release: () => Promise<void>}>}  rejects (LOCK_TIMEOUT) when another sync holds it past `maxWaitMs`.
 *   `release()` resolves only AFTER the lock file is gone. It must be awaited: the CLI ends its run with a synchronous
 *   `process.exit`, so a release that merely queued its unlink as a microtask left the file behind and the NEXT sync
 *   waited out the whole stale window on a dead owner (measured: a normal run left the lock on disk).
 */
export async function acquireConsumerLock(root, { maxWaitMs = 30_000, lock = withFileLock, contain = assertContainedDestination, mkdir = fs.mkdirSync } = {}) {
  const lockPath = contain({ root, relPath: LAYOUT_CONSTANTS.SYNC_LOCK });
  mkdir(path.dirname(lockPath), { recursive: true });
  return new Promise((resolve, reject) => {
    let unpark;
    const parked = new Promise((r) => { unpark = r; });
    const done = lock(lockPath, { maxWaitMs }, () => { resolve({ release: async () => { unpark(); await done; } }); return parked; });
    done.catch(reject);
  });
}
