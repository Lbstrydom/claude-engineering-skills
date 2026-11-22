/**
 * @fileoverview The pilot's FROZEN instrument (verification-lessons Phase 5 redesign, 2026-11-22). A confirmation is only a
 * confirmation if nothing it is scored with moved after the data was seen, so the three things that decide a figure are pinned by
 * sha256 (CRLF folded to LF): the checklist, the matcher, and the scoring code. `checklist-pilot --verify-frozen` reports any
 * difference; `--replay --confirmation` refuses to run unless there is none.
 *
 * Changing any of the three is allowed and deliberate: it ends the freeze, and the confirmation window must then start after
 * the NEW freeze. Update the constants and the doc section together, never one alone.
 *
 * @module scripts/lib/checklist/frozen
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const FROZEN = Object.freeze({
  frozenOn: '2026-11-22',
  files: Object.freeze({
    checklist: Object.freeze({ path: '.audit-loop/checklist.json', sha256: '7f574f3fa1f0f1e0232be8e1497ec805d63181db2cdc7e0b8d041e963dd37f04' }),
    matcher: Object.freeze({ path: 'scripts/lib/checklist/match.mjs', sha256: 'dcb4e4df0afc58d22a8ff29f7808b6a7db7a31c6d4c565b4244591acd48a5f50' }),
    scoring: Object.freeze({ path: 'scripts/lib/checklist/pilot.mjs', sha256: 'c758c13a21c6b582dafde08c9e0249657cf7bdfcb08720118ef47cc20d615b39' }),
  }),
});

/**
 * The PR windows already SEEN (the pilot window and the held-out window before it, measured from `tip`). A confirmation must not overlap
 * them: re-scoring seen PRs confirms nothing. Recorded as PR-number ranges (squash-commit subjects `(#n)`), inclusive.
 */
export const SEEN_WINDOWS = Object.freeze({
  tip: '9865dc651db4fc3f4faa554c5ea1c09c3a4f4ef6',
  pilot: Object.freeze({ oldest: 410, newest: 442 }),
  heldOut: Object.freeze({ oldest: 380, newest: 409 }),
});

/** @returns {number[]} the PRs (of `prs`) that fall inside a window already seen */
export function seenPrsIn(prs) {
  return prs.filter((n) => Object.values(SEEN_WINDOWS).some((w) => typeof w === 'object' && n >= w.oldest && n <= w.newest));
}

const sha = (abs) => createHash('sha256').update(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

/** @returns {{ok: boolean, frozenOn: string, mismatches: Array<{name: string, path: string, expected: string, actual: string|null}>}} */
export function verifyFrozen(repoRoot, { checklistFile } = {}) {
  const mismatches = [];
  for (const [name, { path: rel, sha256 }] of Object.entries(FROZEN.files)) {
    let actual = null;
    // The checklist a run is actually GIVEN (`--checklist`) is the one that must be frozen, not merely the committed file.
    const readPath = name === 'checklist' && checklistFile ? checklistFile : rel;
    try { actual = sha(path.resolve(repoRoot, readPath)); } catch { /* absent: a mismatch */ }
    if (actual !== sha256) mismatches.push({ name, path: rel, expected: sha256, actual });
  }
  return { ok: mismatches.length === 0, frozenOn: FROZEN.frozenOn, mismatches };
}
