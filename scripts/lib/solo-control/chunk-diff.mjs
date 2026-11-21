/**
 * @fileoverview Diff chunking for the solo-control audit passes. Extracted from scripts/solo-control-audit.mjs (an over-1000-line
 * file that may not grow); behaviour unchanged.
 * @module scripts/lib/solo-control/chunk-diff
 */

/** Split a diff into ≤maxChars blocks at file (`diff --git`) boundaries so each
 * audit chunk is coherent; a single file larger than maxChars is hard-split.
 *
 * A hard-split slice after the first loses the `diff --git a/x b/x` header —
 * the audit pass sees ONLY a mid-file hunk fragment with no filename and no
 * indication it's a partial view. An arm reading that fragment in isolation
 * (e.g. a run of `-` lines whose matching `+` lines landed in the NEXT chunk)
 * can misread it as a whole-file deletion — confirmed root cause of the
 * split-misread-as-deletion / phantom-missing-file false-positive family in
 * the 2026-07 solo-control run (docs/experiments/audit-effectiveness). Every
 * slice after the first is prefixed with a synthetic marker line naming the
 * file and stating this is a continuation, not a deletion. */
export function chunkDiff(diff, maxChars) {
  if (diff.length <= maxChars) return [diff];
  const perFile = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (let part of perFile) {
    const headerMatch = part.match(/^diff --git a\/(.+?) b\/(.+?)\n/);
    const fileLabel = headerMatch ? headerMatch[2] : null;
    let sliceIndex = 0;
    while (part.length > maxChars) {
      const slice = part.slice(0, maxChars);
      part = part.slice(maxChars);
      sliceIndex += 1;
      chunks.push(sliceIndex > 1 && fileLabel ? continuationMarker(fileLabel, sliceIndex) + slice : slice);
    }
    if (sliceIndex > 0 && fileLabel && part) part = continuationMarker(fileLabel, sliceIndex + 1) + part;
    if (cur.length + part.length > maxChars && cur) { chunks.push(cur); cur = ''; }
    cur += part;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Synthetic marker prepended to a hard-split diff continuation — see chunkDiff. */
export function continuationMarker(fileLabel, partNumber) {
  return `# [diff continuation: ${fileLabel}, part ${partNumber} — earlier/later hunks of this SAME file `
    + `are in a different audit chunk; this fragment alone is NOT evidence the file was deleted or is missing]\n`;
}
