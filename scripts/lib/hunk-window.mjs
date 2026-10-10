/**
 * @fileoverview Hunk-centred read windows — what part of an oversized changed file an audit pass is shown.
 *
 * ## The defect this closes (upstream report 58f4e3a5, 2026-10-10)
 *
 * Every pass rendered a file from its first character and cut it at a fixed `maxPerFile`. A diff audit's subject is
 * the CHANGED lines, which sit anywhere in a file, so in any file past a few KB they were the first thing to fall off
 * the end. A six-round audit converged PASS with 844 changed lines in five files never shown to any pass; reading
 * them found four real defects.
 *
 * ## The shape (docs/plans/audit-hunk-window-coverage.md D2–D4)
 *
 * PURE: no I/O. For a file over its budget with known new-side hunks, `planHunkWindow` chooses which ORIGINAL lines
 * to show — a head (imports), then changed lines, then context around them — and `renderRanges` prints them with
 * one marker line per elided span naming the real line numbers, so a reviewer can still cite a line. Every function
 * speaks 1-based inclusive `[start, end]` line ranges, which is also what the readers report as render evidence:
 * a windowed render cannot be described by a prefix length.
 *
 * `assembleBlocks` is the breadth-first budget rule both readers share: every file's base block first (today's exact
 * omit rule), then leftover budget grows windowed files to every changed line. No file is ever omitted so that
 * another can grow.
 *
 * @module scripts/lib/hunk-window
 */

/** Context lines kept either side of a changed range when the budget allows. */
export const DEFAULT_CONTEXT_LINES = 3;
/** Share of the per-file budget reserved for the head of the file (imports, module docs). */
export const DEFAULT_HEAD_SHARE = 0.15;
/** Budget reserved per elided span for its marker line. Generous: a marker is ~40 chars. */
const GAP_COST = 60;

/**
 * Merge ranges: sorted, overlapping or ADJACENT ranges fused. Ignores malformed entries.
 * @param {Array<[number, number]>} ranges
 * @returns {Array<[number, number]>}
 */
export function unionRanges(ranges) {
  const valid = (ranges || [])
    .filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 1 && r[1] >= r[0])
    .map(([s, e]) => [s, e])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** Number of lines the ranges cover (after merging). */
export function countLines(ranges) {
  return unionRanges(ranges).reduce((n, [s, e]) => n + (e - s + 1), 0);
}

/**
 * Lines of `target` NOT inside `covered`.
 * @param {Array<[number, number]>} target
 * @param {Array<[number, number]>} covered
 * @returns {number}
 */
export function countUncovered(target, covered) {
  const cov = unionRanges(covered);
  let unread = 0;
  for (const [s, e] of unionRanges(target)) {
    let inside = 0;
    for (const [cs, ce] of cov) {
      if (ce < s) continue;
      if (cs > e) break;
      inside += Math.min(e, ce) - Math.max(s, cs) + 1;
    }
    unread += (e - s + 1) - inside;
  }
  return unread;
}

/**
 * New-side diff hunks → the changed line ranges of a file `lineCount` lines long.
 *
 * A pure-deletion hunk (`+X,0`) changes no line on the new side but marks a site — the line it follows — and is
 * kept as that one line, matching the ledger's long-standing `Math.max(1, lineCount)`. Ranges are clipped to the
 * file, so a hunk from a stale diff can never claim lines that do not exist.
 *
 * @param {Array<{startLine: number, lineCount: number}>|null|undefined} hunks
 * @param {number} lineCount
 * @returns {Array<[number, number]>}
 */
export function changedLineRanges(hunks, lineCount) {
  if (!Array.isArray(hunks) || !(lineCount >= 1)) return [];
  const out = [];
  for (const h of hunks) {
    if (!h || !Number.isInteger(h.startLine)) continue;
    const n = Number.isInteger(h.lineCount) && h.lineCount > 0 ? h.lineCount : 0;
    const s = Math.min(Math.max(1, h.startLine), lineCount);
    const e = n > 0 ? Math.min(h.startLine + n - 1, lineCount) : s;
    if (h.startLine > lineCount && n > 0) continue;   // wholly past the end: a stale hunk, not a change here
    if (e >= s) out.push([s, e]);
  }
  return unionRanges(out);
}

/** Line count of a text, the way the readers split it (`split('\n')`). */
export function lineCountOf(text) {
  return String(text).split('\n').length;
}

/**
 * Choose which lines of an oversized file to show.
 *
 * Priority, within `maxPerFile`: (1) a head of at most `headShare` of the budget, (2) changed lines in file order,
 * (3) up to `contextLines` either side of each changed range. `grown` is the same plan without the budget — every
 * changed line plus full context — returned only when `base` could not hold every changed line.
 *
 * @param {string[]} lines the file, split on '\n'
 * @param {Array<[number, number]>} changed from `changedLineRanges`
 * @param {{maxPerFile: number, contextLines?: number, headShare?: number, lineOverhead?: number, rangeOverhead?: number}} opts
 *   `lineOverhead` / `rangeOverhead`: characters a renderer adds per shown line (a line-number gutter) and per changed
 *   range (annotation marker lines), charged against the budget so the RENDERED block stays within `maxPerFile`.
 * @returns {{base: Array<[number, number]>, grown: Array<[number, number]>|null, complete: boolean}}
 */
export function planHunkWindow(lines, changed, {
  maxPerFile, contextLines = DEFAULT_CONTEXT_LINES, headShare = DEFAULT_HEAD_SHARE, lineOverhead = 0, rangeOverhead = 0,
} = {}) {
  const n = lines.length;
  const ranges = unionRanges(changed).filter(([s]) => s <= n).map(([s, e]) => [s, Math.min(e, n)]);
  const cost = (i) => lines[i - 1].length + 1 + lineOverhead;
  // One gap marker is reserved up front; each changed range pays its own gap marker and render overhead only when it is
  // actually shown (code audit R3: reserving for every requested range up front could zero the budget on a many-hunk file).
  const budget = Math.max(0, maxPerFile - GAP_COST);
  const perRange = GAP_COST + rangeOverhead;
  const kept = new Uint8Array(n + 2);
  let used = 0;
  const spend = (i) => {
    if (i < 1 || i > n || kept[i]) return true;
    const c = cost(i);
    if (used + c > budget) return false;
    kept[i] = 1;
    used += c;
    return true;
  };

  // (1) head
  const headBudget = Math.floor(maxPerFile * headShare);
  let headUsed = 0;
  let headEnd = 0;
  for (let i = 1; i <= n; i++) {
    const c = cost(i);
    if (headUsed + c > headBudget || !spend(i)) break;
    headUsed += c;
    headEnd = i;
  }

  // (2) changed lines, in order, until the budget runs out
  let complete = true;
  outer: for (const [s, e] of ranges) {
    if (!kept[s]) {
      if (used + perRange + cost(s) > budget) { complete = false; break; }
      used += perRange;
    }
    for (let i = s; i <= e; i++) {
      if (!spend(i)) { complete = false; break outer; }
    }
  }

  // (3) context, nearest lines first, around every changed range that got shown at all
  for (let d = 1; d <= contextLines; d++) {
    for (const [s, e] of ranges) {
      if (!kept[s] && !kept[e]) continue;
      spend(s - d);
      spend(e + d);
    }
  }

  const base = keptToRanges(kept, n);
  if (complete) return { base, grown: null, complete: true };
  const grown = [];
  if (headEnd > 0) grown.push([1, headEnd]);
  for (const [s, e] of ranges) grown.push([Math.max(1, s - contextLines), Math.min(n, e + contextLines)]);
  return { base, grown: unionRanges(grown), complete: false };
}

function keptToRanges(kept, n) {
  const out = [];
  let start = 0;
  for (let i = 1; i <= n + 1; i++) {
    if (i <= n && kept[i]) { if (!start) start = i; } else if (start) { out.push([start, i - 1]); start = 0; }
  }
  return out;
}

/**
 * A gap-marker line in the file's own comment syntax. Never contains `*` followed by `/`: a marker landing inside a
 * block comment must stay inert (the same invariant the diff annotator's markers keep).
 *
 * @param {string|null} prefix line-comment prefix (`//`, `#`, `--`), or null for a language with none
 * @returns {(from: number, to: number) => string}
 */
export function gapMarkerFor(prefix) {
  const lead = prefix ? `${prefix} ` : '';
  return (from, to) => `${lead}... [lines ${from}-${to} not shown] ...`;
}

/**
 * Print the kept ranges of `lines`, one marker line per elided span (including before the first and after the last).
 *
 * @param {string[]} lines
 * @param {Array<[number, number]>} ranges
 * @param {(from: number, to: number) => string} gapLine
 * @param {(segment: string[], firstLine: number) => string} [renderSegment] how a kept segment prints (default: as is)
 * @returns {string}
 */
export function renderRanges(lines, ranges, gapLine, renderSegment = (seg) => seg.join('\n')) {
  const n = lines.length;
  const parts = [];
  let cursor = 1;
  for (const [s, e] of unionRanges(ranges)) {
    if (s > n) break;
    const end = Math.min(e, n);
    if (s > cursor) parts.push(gapLine(cursor, s - 1));
    parts.push(renderSegment(lines.slice(s - 1, end), s));
    cursor = end + 1;
  }
  if (cursor <= n) parts.push(gapLine(cursor, n));
  return parts.join('\n');
}

/** Original characters the ranges show (each line plus its newline). */
export function charsInRanges(lines, ranges) {
  let total = 0;
  for (const [s, e] of unionRanges(ranges)) {
    for (let i = s; i <= Math.min(e, lines.length); i++) total += lines[i - 1].length + 1;
  }
  return total;
}

/** "1-40, 120-260" — for a block header. */
export function formatRanges(ranges) {
  return unionRanges(ranges).map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(', ');
}

/**
 * The line range a head cut of `chars` characters shows. A partly shown last line counts (at least one of its
 * characters reached the reader); a line none of whose characters were shown does not — a cut ending exactly on a
 * newline shows nothing of the line after it. An empty cut shows no line: `[1, 0]`, which every range consumer drops.
 */
export function prefixRange(text, chars) {
  const end = Math.min(Math.max(0, chars), text.length);
  let newlines = 0;
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) newlines++;
  if (end === 0) return [1, 0];
  return [1, text.charCodeAt(end - 1) === 10 ? newlines : newlines + 1];
}

/**
 * Breadth-first block assembly against a total budget.
 *
 * Phase 1 places every entry's `base` in order with the exact rule the readers always used — a block that would take
 * the total past `maxTotal` is omitted. Phase 2 walks the placed entries in order and swaps `base` for `grown` when
 * the growth fits what phase 1 left. So no entry is omitted to let another grow, and with no `grown` blocks the
 * output is byte-identical to phase 1 alone.
 *
 * @param {Array<{base: string, grown?: string|null}>} entries
 * @param {number} maxTotal
 * @returns {{text: string, placement: Array<'base'|'grown'|'omitted'>}}
 */
export function assembleBlocks(entries, maxTotal) {
  const placement = [];
  let used = 0;
  for (const e of entries) {
    if (used + e.base.length > maxTotal) { placement.push('omitted'); continue; }
    used += e.base.length;
    placement.push('base');
  }
  for (let i = 0; i < entries.length; i++) {
    const g = entries[i].grown;
    if (placement[i] !== 'base' || typeof g !== 'string') continue;
    const delta = g.length - entries[i].base.length;
    if (delta > 0 && used + delta > maxTotal) continue;
    used += delta;
    placement[i] = 'grown';
  }
  const text = entries.map((e, i) => (placement[i] === 'grown' ? e.grown : placement[i] === 'base' ? e.base : '')).join('');
  return { text, placement };
}
