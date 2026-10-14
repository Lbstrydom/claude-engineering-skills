/**
 * @fileoverview The drift-only size ratchet's decision core, shared by the two
 * gates that govern a size against a committed baseline:
 * `scripts/file-size-ratchet.mjs` (lines of `scripts/**` source) and
 * `scripts/skill-size-ratchet.mjs` (characters of skill markdown).
 *
 * Extracted, not copied: the core has been fixed four times (the
 * invalid-vs-absent baseline split, ratchet-down-only updates, the dropped vs
 * shrank distinction, the tolerance), and a copy would let the next fix reach
 * one ratchet and miss the other. Everything here is UNIT-NEUTRAL — a "size" is
 * a number, and the caller owns what it counts. Plan:
 * docs/plans/skill-markdown-size-ratchet.md §2 decision 1.
 *
 * @module scripts/lib/size-ratchet
 */

import fs from 'node:fs';

/**
 * Pure decision logic, testable without touching disk.
 *
 * Four outcomes, and the two self-cleaning cases are deliberately distinct:
 *   - `grew`     — a baselined file gained more than the tolerance. FAIL.
 *   - `newOver`  — an unbaselined file crossed the limit. FAIL.
 *   - `shrank`   — a baselined file lost more than the tolerance and is STILL
 *                  over the limit. FAIL, asking for a ratchet-down; the
 *                  baseline is *updated*, and the file stays baselined.
 *   - `dropped`  — a baselined file fell BELOW the limit. FAIL, asking for its
 *                  removal from the baseline entirely.
 *
 * Conflating the last two is a real trap: removing a still-oversized file from
 * the baseline would make it fail immediately as an unbaselined file over the
 * limit.
 *
 * @param {Record<string, number>} current  sizes of the files currently over the limit
 * @param {Record<string, number>} baseline
 * @param {number} tolerance  growth/shrink within this is noise, not a ratchet event
 */
export function diffAgainstBaseline(current, baseline, tolerance) {
  const grew = [];
  const newOver = [];
  const shrank = [];
  const dropped = [];

  for (const [file, size] of Object.entries(current)) {
    if (!(file in baseline)) { newOver.push({ file, size }); continue; }
    const was = baseline[file];
    if (size - was > tolerance) grew.push({ file, was, now: size });
    else if (was - size > tolerance) shrank.push({ file, was, now: size });
  }
  for (const [file, was] of Object.entries(baseline)) {
    if (!(file in current)) dropped.push({ file, was });
  }
  return { grew, newOver, shrank, dropped };
}

/**
 * The baseline `--update-baseline` writes. It only ever RATCHETS DOWN: each
 * baselined file keeps `min(old mark, current)`, a file now under the limit
 * leaves, and a file newly over the limit is NOT admitted. Writing every
 * file's current size (the previous behaviour) silently raised the mark of
 * any file that had grown within the tolerance — locking in one shrink
 * re-baselined unrelated creep upward. Accepting growth, or a new oversized
 * file, is a reviewed hand edit of that one entry, never a side effect.
 * With no baseline at all, the current sizes ARE the baseline (bootstrap).
 *
 * @param {Record<string, number>} current
 * @param {Record<string, number>|null} baseline
 * @returns {Record<string, number>}
 */
export function updatedBaseline(current, baseline) {
  if (!baseline) return { ...current };
  const next = {};
  for (const [file, was] of Object.entries(baseline)) {
    if (file in current) next[file] = Math.min(was, current[file]);
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * What is on disk at the baseline path, as one of THREE outcomes. `absent`
 * (ENOENT) is the only one `--update-baseline` may bootstrap from; `invalid`
 * (unreadable, unparseable, or no `files` map of numeric sizes) must refuse
 * with the file untouched. Collapsing the two into `null` let a corrupt baseline
 * read as "no baseline", so the update wrote every current size over it — the
 * growth the ratchet exists to refuse, absorbed.
 *
 * @param {string} p
 * @returns {{kind: 'absent'} | {kind: 'invalid', reason: string} | {kind: 'ok', files: Record<string, number>}}
 */
export function readBaselineState(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid', reason: `unreadable: ${err?.code || err?.message}` };
  }
  let files;
  try { files = JSON.parse(raw)?.files; } catch (err) { return { kind: 'invalid', reason: `not valid JSON: ${err.message}` }; }
  if (!files || typeof files !== 'object' || Array.isArray(files)
      || !Object.values(files).every((n) => Number.isFinite(n))) {
    return { kind: 'invalid', reason: 'no `files` map of numeric sizes' };
  }
  return { kind: 'ok', files };
}
