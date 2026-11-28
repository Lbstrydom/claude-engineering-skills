/**
 * @fileoverview Condense a project instruction file (AGENTS.md / CLAUDE.md) BY
 * SECTION under a character budget, and measure what was read.
 *
 * Upstream report 477617f6: every reader of the instruction file in
 * `context.mjs` took its HEAD — `slice(0, 48000)` for the brief's LLM legs,
 * `slice(0, 1500|2000|4000)` for the fallbacks — with no log and no marker.
 * CES's own AGENTS.md (58,916 chars) lost its last 11 sections (Scope
 * discipline, the prose↔code seam, Sensitive paths, Verification discipline,
 * Code Style, Do NOT, Accepted Technical Debt) and the brief read exactly as a
 * full read would.
 *
 * The fix is not a bigger budget. Under the SAME budget:
 *   1. every `## ` section is represented — its heading line is allocated
 *      first, in file order, skipping any heading that cannot fit;
 *   2. the rest is shared round-robin by whole BLOCK (paragraph, list item,
 *      quote paragraph, table row — never inside a code fence): every section
 *      is offered its next block before any gets another, so a short section
 *      ends whole and what it leaves goes to the others;
 *   3. a section therefore ends on a block boundary — no instruction item is
 *      truncated mid-sentence, no fence is left open — and a cut is marked;
 *   4. the output, markers and separators included, is ≤ `budget`;
 *   5. a coverage line states sections and chars read out of total.
 * Deterministic: integer arithmetic, no clock, no ranking judgement.
 *
 * @module scripts/lib/instruction-sections
 */

import { makeFenceTracker } from './markdown-fence-tracker.mjs';

/** An ATX h2: up to three spaces of indent (CommonMark), then `##` + space or tab. */
const H2 = /^ {0,3}##[ \t]/;
const QUOTE_PREFIX = /^\s*(?:>\s?)+/;

/**
 * Tracks the regions whose lines are never headings and never cut points: a
 * code fence — also one inside a blockquote, which a non-quote line closes
 * (the container ends) — and a multi-line HTML comment.
 * `update(line)` → true when the line is inside or delimits such a region;
 * `update.isOpen()` → whether one is open AFTER the last line fed.
 */
function makeOpaqueTracker() {
  let fence = makeFenceTracker();
  let fenceInQuote = false;
  let inComment = false;
  function update(line) {
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      return true;
    }
    const quoted = QUOTE_PREFIX.test(line);
    if (fence.isOpen() && fenceInQuote && !quoted) fence = makeFenceTracker();
    const wasOpen = fence.isOpen();
    if (fence(quoted ? line.replace(QUOTE_PREFIX, '') : line)) {
      if (!wasOpen) fenceInQuote = quoted;
      return true;
    }
    const open = line.lastIndexOf('<!--');
    if (open !== -1 && line.indexOf('-->', open + 4) === -1) { inComment = true; return true; }
    return false;
  }
  update.isOpen = () => inComment || fence.isOpen();
  return update;
}

/**
 * Split markdown on `## ` headings, fence-aware (a `## ` inside a code fence is
 * content). Text before the first heading is its own section (heading null).
 * `sections.map(s => s.text).join('\n') === content` — the split is lossless.
 *
 * Sibling of check-context-drift.mjs's `extractH2Sections`, not a reuse: that
 * one drops the preamble (CES's is ~12.5K chars of tripwires) and lives in a
 * CLI module a library must not import.
 * @param {string} content
 * @returns {Array<{heading: string|null, text: string}>}
 */
export function splitInstructionSections(content) {
  const isFenced = makeOpaqueTracker();
  const sections = [];
  let cur = { heading: null, lines: [] };
  for (const line of content.split('\n')) {
    const fenced = isFenced(line); // stateful: call for EVERY line, in order
    const h = fenced ? null : H2.exec(line);
    if (h) {
      if (cur.heading !== null || cur.lines.length > 0) sections.push(cur);
      cur = { heading: line.slice(h[0].length).trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);
  return sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n') }));
}

const BLANK = /^\s*$/;
const QUOTE = /^\s*>/;
const BLANK_QUOTE = /^\s*>\s*$/;
const INDENTED = /^\s/;
const BLOCK_START = /^(?:[-*+]\s|\d+[.)]\s|\||```|~~~|#{1,6}\s)/;
const LIST_ITEM = /^(?:[-*+]\s|\d+[.)]\s)/;

/**
 * Does `line` begin a new block, given the line before it? Deliberately
 * coarse: a boundary that is missed only makes a block bigger; a FALSE
 * boundary splits an instruction from its own qualification.
 *   - nothing starts right after an introduction — a line ending in `:` keeps
 *     what it introduces ("Allow writes only when:" + its list), blank line
 *     or not;
 *   - an indented line never starts a block — it is a continuation or a nested
 *     item, and belongs to its parent;
 *   - a quote line starts one only after a non-quote or a blank `>` line;
 *   - otherwise a block starts after a blank line, or at an unindented list
 *     item, table row, fence or heading.
 * @param {string} line
 * @param {string} prev - the line before it
 * @param {string} introducer - the line that introduced it (see cutPoints)
 * @param {boolean} afterFence - the previous line closed a code fence
 */
function startsBlock(line, prev, introducer, afterFence) {
  if (/:\s*$/.test(introducer)) return false;
  if (afterFence) return true; // a closed fence ends its block
  if (QUOTE.test(line)) return !QUOTE.test(prev) || BLANK_QUOTE.test(prev);
  if (INDENTED.test(line)) return false;
  if (BLANK.test(prev) || BLANK_QUOTE.test(prev)) return true;
  return BLOCK_START.test(line);
}

const isBlank = (l) => BLANK.test(l) || BLANK_QUOTE.test(l);

/**
 * Kept-text lengths at which a section may end, ascending. Index 0 is the
 * heading line alone — or, for the headingless preamble, NOTHING (0): its
 * first line is not a heading and may open a fence or a paragraph. Each later
 * point ends a complete block with no code fence open; the last is the whole
 * section. One linear pass: the introducer lookups and the trimmed end of the
 * kept text are carried forward, never rescanned.
 * @param {{heading: string|null, text: string}} section
 * @returns {number[]}
 */
function cutPoints({ heading, text }) {
  const lines = text.split('\n');
  const tracker = makeOpaqueTracker();
  const points = [heading === null ? 0 : lines[0].length];
  let offset = 0;
  let fenceOpen = false;
  let lastNonBlank = 0;   // index of the last non-blank line before i
  let lastNonList = 0;    // ... that is also not a list item or indented line
  let keptEnd = 0;        // end offset of lastNonBlank, trailing spaces trimmed
  let inListRun = false;  // the previous line belongs to a list item
  let closedFence = false; // the previous line closed a code fence
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0 && !fenceOpen) {
      // The line that introduced this one: past blanks, and for a list item
      // past the list run it belongs to.
      const introducer = lines[LIST_ITEM.test(line) ? lastNonList : lastNonBlank];
      if (startsBlock(line, lines[i - 1], introducer, closedFence) && keptEnd > points[points.length - 1]) points.push(keptEnd);
    }
    const wasOpen = fenceOpen;
    tracker(line);
    fenceOpen = tracker.isOpen();
    closedFence = wasOpen && !fenceOpen;
    if (isBlank(line)) {
      inListRun = false;
    } else {
      lastNonBlank = i;
      keptEnd = offset + line.trimEnd().length;
      const listish = LIST_ITEM.test(line) || INDENTED.test(line);
      // An unindented line straight after a list line is a LAZY continuation
      // of that item, not a new introducer: it must not detach the rest of the
      // list from the line that introduced it.
      if (!listish && !inListRun) lastNonList = i;
      inListRun = listish || inListRun;
    }
    offset += line.length + 1;
  }
  if (points[points.length - 1] < text.length) points.push(text.length);
  return points;
}

const cutMarker = (kept, len) => `\n…[cut: ${kept}/${len} chars]`;
const summaryNote = (headingOnly, omitted) => `\n…[${headingOnly} section(s) heading-only, ${omitted} omitted: budget]`;

/**
 * @typedef {object} SectionCoverage
 * @property {number} totalSections
 * @property {number} represented - sections with at least their heading kept
 *   (the headingless preamble: at least one block)
 * @property {number} whole
 * @property {number} condensed - some body text kept, ending on a block boundary
 * @property {number} headingOnly - heading kept, no body
 * @property {number} omitted - nothing kept
 * @property {number} charsRead - SOURCE chars kept (markers excluded)
 * @property {number} totalChars - JS string length of the input
 */

/**
 * Condense `content` to at most `budget` chars of output, by section.
 * Under budget the input is returned verbatim.
 *
 * Over budget: (1) heading floor — each section whose heading line fits is
 * named, in file order, skipping any that does not; (2) round-robin by BLOCK —
 * pass over the sections in order, each taking its next whole block if it
 * fits, until a pass adds nothing. Every section is offered the same number of
 * blocks before any gets one more, and a block too big for what is left stalls
 * only its own section. Every cost (block, marker, join, summary note) is
 * charged against the budget, so `text.length <= budget` — when the budget
 * cannot hold even the note, the text is empty and the coverage says so.
 * @param {string} content
 * @param {number} budget
 * @returns {{text: string, coverage: SectionCoverage}}
 */
export function condenseBySection(content, budget) {
  const src = content ?? '';
  const sections = splitInstructionSections(src);
  const n = sections.length;
  const totalChars = src.length;
  if (totalChars <= budget) {
    return { text: src, coverage: { totalSections: n, represented: n, whole: n, condensed: 0, headingOnly: 0, omitted: 0, charsRead: totalChars, totalChars } };
  }

  const len = (i) => sections[i].text.length;
  const points = sections.map(cutPoints);
  /** Output cost of ending section i at `kept`: text + join (+ a marker when cut past its heading). */
  const costAt = (i, kept) => (kept === 0 ? 0
    : kept + 1 + (kept > points[i][0] && kept < len(i) ? cutMarker(kept, len(i)).length : 0));

  let left = budget - summaryNote(n, n).length;
  if (left < 0) {
    return { text: '', coverage: { totalSections: n, represented: 0, whole: 0, condensed: 0, headingOnly: 0, omitted: n, charsRead: 0, totalChars } };
  }
  // 1. Heading floor. `at[i]` indexes points[i]; -1 = omitted. The preamble
  //    has no heading to pay for: it starts at "nothing" and competes for
  //    blocks in step 2 like every body.
  const at = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const cost = costAt(i, points[i][0]);
    if (cost <= left) { at[i] = 0; left -= cost; }
  }
  // 2. Round-robin by block, over the ACTIVE sections only. `left` never
  //    grows, so a section whose next step does not fit now never will: it
  //    leaves the rotation, as does a finished one. Every pass therefore
  //    advances every section still in it, and the total work is linear in
  //    the number of blocks.
  let active = sections.map((_, i) => i).filter((i) => at[i] >= 0 && at[i] < points[i].length - 1);
  while (active.length > 0) {
    const next = [];
    for (const i of active) {
      const now = costAt(i, points[i][at[i]]);
      const last = points[i].length - 1;
      const delta = costAt(i, points[i][at[i] + 1]) - now;
      if (delta <= left) { at[i] += 1; left -= delta; }
      else {
        // Completing the section drops its cut marker, so "whole" can cost
        // less than the next cut point did: take it when it fits.
        const toWhole = costAt(i, points[i][last]) - now;
        if (toWhole > left) continue; // stalled for good
        at[i] = last;
        left -= toWhole;
      }
      if (at[i] < last) next.push(i);
    }
    active = next;
  }

  // 3. Render.
  const parts = [];
  let whole = 0, condensed = 0, headingOnly = 0, omitted = 0, charsRead = 0;
  for (let i = 0; i < n; i++) {
    const t = sections[i].text;
    const kept = at[i] < 0 ? 0 : points[i][at[i]];
    if (kept === 0) { omitted++; continue; }
    charsRead += kept;
    if (kept >= t.length) { whole++; parts.push(t); continue; }
    if (at[i] === 0) { headingOnly++; parts.push(t.slice(0, kept)); continue; }
    condensed++;
    parts.push(`${t.slice(0, kept)}${cutMarker(kept, t.length)}`);
  }
  let text = parts.join('\n');
  if (headingOnly + omitted > 0) text += summaryNote(headingOnly, omitted);
  return { text, coverage: { totalSections: n, represented: n - omitted, whole, condensed, headingOnly, omitted, charsRead, totalChars } };
}

/**
 * The measured coverage line — logged AND carried in the brief, so an
 * under-read is visible to whoever reads the brief, not just to stderr.
 * @param {SectionCoverage} c
 * @param {string} label - which file was read
 * @returns {string}
 */
export function formatSectionCoverage(c, label) {
  const pct = c.totalChars === 0 ? 100 : Math.floor((c.charsRead / c.totalChars) * 100);
  const parts = [`${c.whole} whole`, `${c.condensed} condensed`];
  if (c.headingOnly > 0) parts.push(`${c.headingOnly} heading-only`);
  if (c.omitted > 0) parts.push(`${c.omitted} omitted`);
  return `Instruction-file coverage (${label}): ${c.represented}/${c.totalSections} sections represented (${parts.join(', ')}); ${c.charsRead} of ${c.totalChars} chars read (${pct}%)`;
}
