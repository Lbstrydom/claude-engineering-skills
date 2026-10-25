/**
 * @fileoverview The facts `planConsumerPr` weighs beyond the consumer's own dirty files: is the consumer's bundle stamp the
 * source's current commit (da9a), and what did the sync do to the consumer's managed `.gitignore` block (a5ce). Split out of
 * `sync-pr.mjs` to keep that file under the size ratchet; `sync-pr.mjs` re-exports everything here, so there is one door.
 *
 * @module scripts/lib/sync-pr-facts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from './sync-base-lag.mjs';
import { classifyGitignoreTransition } from './sync-gitignore.mjs';

/** @typedef {import('./sync-base-lag.mjs').Runner} Runner */

export const GITIGNORE_PATH = '.gitignore';

const FULL_SHA = /^[0-9a-f]{40}$/;
/** `block-only` is the one state that rides in the PR; the rest are named under leftBehind. */
export const GITIGNORE_PATH_STATE = Object.freeze({ BLOCK_ONLY: 'block-only' });
export const GITIGNORE_LEFT_BEHIND_REASON = Object.freeze({
  mixed: 'edited beyond the sync-managed block',
  invalid: 'managed-block markers are malformed',
  unverified: 'could not be compared with the base',
});

/**
 * Is the consumer's bundle stamp the source's current commit? PURE.
 *
 * A 'clean' consumer only means the tracked surface on disk is committed - it compares nothing against the source, so a STALE
 * bundle read 'skip clean' (storyline, 2026-10-16: the bundle lacked #265 until a separate sync). Decision table:
 *
 *   stamp not 40-hex (missing/short/malformed) -> unverified
 *   sourceSha not 40-hex                       -> unverified
 *   different                                  -> different (NEVER 'behind': no ancestry is verified - it may be ahead or divergent)
 *   equal, source tree dirty or unknown        -> unverified (a matching HEAD stamp does not prove equal content)
 *   equal, source tree clean                   -> current
 *
 * @param {{stamp: unknown, sourceSha: unknown, sourceDirty: unknown}} input
 * @returns {'current'|'different'|'unverified'}
 */
export function classifyBundleFreshness({ stamp, sourceSha, sourceDirty }) {
  if (typeof stamp !== 'string' || !FULL_SHA.test(stamp)) return 'unverified';
  if (typeof sourceSha !== 'string' || !FULL_SHA.test(sourceSha)) return 'unverified';
  if (stamp !== sourceSha) return 'different';
  return sourceDirty === false ? 'current' : 'unverified';
}

/**
 * The SOURCE repo's HEAD and whether its tree is dirty - the two facts `planConsumerPr` needs to say whether a 'clean' consumer is
 * actually current (da9a). Any git failure yields `undefined` for that fact, which the planner reads as UNVERIFIED, never as current.
 *
 * @param {Runner} run
 * @param {string} sourceRoot
 * @returns {{sourceSha: string|undefined, sourceDirty: boolean|undefined}}
 */
export function gatherSourceFacts(run, sourceRoot) {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot });
  const status = run('git', ['status', '--porcelain'], { cwd: sourceRoot });
  return {
    sourceSha: ok(head) ? head.stdout.trim() : undefined,
    sourceDirty: ok(status) ? status.stdout.trim().length > 0 : undefined,
  };
}

/**
 * What the sync did to the consumer's `.gitignore`, compared with the commit the PR branch will fork from (`baseSha`, never the local
 * HEAD - that is the stale-base lesson of header rule 3). IMPURE; never throws. "The path is absent at the base" and "git could not
 * answer" are different outcomes: the first is a legitimate new file, the second is `unverified` and the file is left behind.
 *
 * @param {Runner} run
 * @param {string} repoRoot
 * @param {string|null} baseSha
 * @returns {'unchanged'|'block-only'|'mixed'|'invalid'|'unverified'}
 */
export function gatherGitignoreTransition(run, repoRoot, baseSha) {
  if (typeof baseSha !== 'string' || !baseSha) return 'unverified';
  let work;
  try {
    work = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'unchanged' : 'unverified';
  }
  const tree = run('git', ['ls-tree', baseSha, '--', '.gitignore'], { cwd: repoRoot });
  if (!ok(tree)) return 'unverified';
  let head = null;
  if (tree.stdout.trim()) {
    const shown = run('git', ['show', `${baseSha}:.gitignore`], { cwd: repoRoot });
    if (!ok(shown)) return 'unverified';
    head = shown.stdout;
  }
  return classifyGitignoreTransition(head, work);
}
