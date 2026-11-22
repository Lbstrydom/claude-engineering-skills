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
    checklist: Object.freeze({ path: '.audit-loop/checklist.json', sha256: '8a6555dd12b06cfd53724fcd7c0e6cae6994be461b67f6a14691b0ecf1aea36d' }),
    matcher: Object.freeze({ path: 'scripts/lib/checklist/match.mjs', sha256: '6528b057e49c7279224bd9e14e15ad61bfac58c1618659c05775ccb1e0a6ccfb' }),
    scoring: Object.freeze({ path: 'scripts/lib/checklist/pilot.mjs', sha256: 'b79b4d7d4d84f1f82a22c508be8b4d23da2baedcbeb1ab460fef1479fd3346f4' }),
  }),
});

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
