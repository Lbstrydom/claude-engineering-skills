/**
 * @fileoverview Finding SCOPE: is a finding about code the change introduced, or code that was already there?
 * (docs/plans/audit-out-of-diff-noise.md, item 8a; consumer report 1c: 15 of 17 findings on one push were about unchanged code.)
 *
 * A `pre-existing` finding is STORED, reported under its own heading and debt-captured exactly like any other, but it does not
 * count toward the verdict, the pre-push gate's HIGH/MEDIUM, or `/audit-code` convergence: the author did not introduce it.
 *
 * The classification is mechanical and never reads model prose. Two kinds of line evidence exist, and only these:
 *  - an ANCHOR (`anchor` / `triggerAnchor`, the tiered pipeline's verified `{newFile, startLine, endLine}`), and
 *  - a `_scopeEvidence` stamp the MAP stage puts on a finding from a CHUNKED unit: the line ranges of the chunk the model was shown.
 *    A model that was shown only unchanged lines cannot have found a defect IN the change.
 * Everything else - the legacy passes' findings carry no line field, deliberately (schemas.mjs `FindingBase`) - has no evidence and
 * is `in-diff`. FAIL CLOSED: a finding is pre-existing only when evidence exists AND every piece of it lies outside the diff.
 *
 * @module scripts/lib/finding-scope
 */

export const PRE_EXISTING = 'pre-existing';
export const IN_DIFF = 'in-diff';

/** Lines of slack either side of a hunk: a finding a few lines from an edit is usually about the edit's surroundings. */
export const PRE_EXISTING_WINDOW_LINES = 15;

/** The finding's stored scope. Anything but the exact pre-existing marker counts (a missing/garbled field is in-diff). */
export const isPreExisting = (f) => f?.scope === PRE_EXISTING;

/** The complement, for count sites: `findings.filter(countsAsInDiff)`. */
export const isInDiff = (f) => !isPreExisting(f);

/** Does `[start, end]` touch any hunk widened by `window` lines? A deletion-only hunk (lineCount 0) is a point at its anchor. */
export function rangeTouchesHunks(start, end, hunks, window) {
  for (const h of hunks) {
    // A malformed hunk (no integer startLine >= 1, or a lineCount that is not a non-negative integer) is no evidence of absence: fail closed.
    if (!h || !Number.isInteger(h.startLine) || h.startLine < 1 || !Number.isInteger(h.lineCount) || h.lineCount < 0) return true;
    const hs = h.startLine - window;
    const he = h.startLine + Math.max(h.lineCount, 1) - 1 + window;
    if (start <= he && end >= hs) return true;
  }
  return false;
}
const touchesHunks = rangeTouchesHunks;

/**
 * The line ranges a chunk's items span, or null when ANY item lacks a usable `startLine`/`source`: a partly known chunk is not
 * evidence of where its content is, so the caller falls back to the fail-closed path. (The import block is not an item.)
 * @param {{items?: Array<{startLine?: number, source?: string}>}|undefined|null} chunk
 * @returns {Array<[number, number]>|null}
 */
export function strictChunkRanges(chunk) {
  const items = chunk?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const out = [];
  for (const it of items) {
    if (!it || !Number.isInteger(it.startLine) || it.startLine < 1 || typeof it.source !== 'string') return null;
    out.push([it.startLine, it.startLine + it.source.split('\n').length - 1]);
  }
  return out;
}

/** One evidence item -> `{file, ranges}` or null when it does not name a file and a usable line range. */
function evidenceOf(item) {
  if (!item || typeof item !== 'object') return null;
  const file = item.newFile ?? item.file ?? null;
  if (typeof file !== 'string' || !file) return null;
  const raw = Array.isArray(item.ranges) ? item.ranges : [[item.startLine, item.endLine ?? item.startLine]];
  const ranges = raw.filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 1 && r[1] >= r[0]);
  if (ranges.length === 0 || ranges.length !== raw.length) return null;   // a partly unreadable range is not evidence
  return { file, ranges };
}

/**
 * Classify one finding.
 * @param {object} finding
 * @param {{hunksFor: ((p: string) => Array<{startLine: number, lineCount: number}>|null)|null, window?: number}} ctx
 *   `hunksFor`: the round's ONE hunk map. null/absent = no diff evidence, so everything is in-diff.
 * @returns {{scope: 'pre-existing'|'in-diff', reason: string}}
 */
export function classifyFindingScope(finding, { hunksFor, window = PRE_EXISTING_WINDOW_LINES } = {}) {
  if (typeof hunksFor !== 'function') return { scope: IN_DIFF, reason: 'no-diff-evidence' };
  const items = [finding?.anchor, finding?.triggerAnchor, finding?._scopeEvidence].filter(Boolean);
  if (items.length === 0) return { scope: IN_DIFF, reason: 'no-line-evidence' };
  for (const item of items) {
    const ev = evidenceOf(item);
    if (!ev) return { scope: IN_DIFF, reason: 'unreadable-line-evidence' };
    let hunks;
    try { hunks = hunksFor(ev.file); } catch { hunks = null; }
    if (!Array.isArray(hunks)) return { scope: IN_DIFF, reason: 'no-hunks-for-file' };   // not a changed file / unavailable
    for (const [s, e] of ev.ranges) {
      if (touchesHunks(s, e, hunks, window)) return { scope: IN_DIFF, reason: 'overlaps-change' };
    }
  }
  return { scope: PRE_EXISTING, reason: 'outside-change' };
}

/**
 * Stamp `scope` on every finding (in place) from the round's hunk map; returns the pre-existing count. A finding already marked
 * pre-existing keeps it. With no `hunksFor` nothing is stamped (a missing field reads as in-diff everywhere).
 */
export function stampFindingScopes(findings, ctx) {
  let n = 0;
  if (!Array.isArray(findings) || typeof ctx?.hunksFor !== 'function') return 0;
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    if (isPreExisting(f) || classifyFindingScope(f, ctx).scope === PRE_EXISTING) { f.scope = PRE_EXISTING; n++; }
  }
  return n;
}

/**
 * The H/M/L tally of the findings that COUNT (everything but pre-existing), plus the pre-existing count. One spelling of "what the
 * author is held to", for the report printers that tally by severity.
 * @param {object[]} findings
 */
export function tallySeverities(findings) {
  const counted = (findings ?? []).filter(isInDiff);
  const n = (sev) => counted.filter((f) => f.severity === sev).length;
  return { high: n('HIGH'), medium: n('MEDIUM'), low: n('LOW'), preExisting: (findings ?? []).length - counted.length };
}
