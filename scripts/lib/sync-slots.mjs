/**
 * @fileoverview Named slots in synced skill markdown: the ONE owner of the
 * marker grammar and of splicing a consumer's block into a slot.
 *
 * ## Why this exists
 *
 * A consumer that needed one repo-specific block inside a synced SKILL.md had
 * to hold the WHOLE file through `.sync-overrides.json`, so the file stopped
 * receiving every upstream fix. Measured 2026-11-28 in one consumer: four held
 * SKILL.md files had drifted 359, 128, 692 and 51 lines from upstream, each to
 * keep one inserted adapter block. Every such block was an INSERTION, never a
 * replacement of upstream text, so the mechanism is a named place to insert,
 * not a merge.
 *
 * Upstream declares the place: a line `<!-- sync-slot:<name> -->` in its own
 * source, at column 0, outside frontmatter and fenced code, at most once per
 * name. The consumer declares the bytes (`blocks` in `.sync-overrides.json`,
 * a committed fragment file). The sync renders the marker as a fenced span:
 *
 *   <!-- sync-slot:<name>:start — from <from> (edit it there; a sync rewrites this span) -->
 *   <fragment bytes, LF, exactly one trailing newline>
 *   <!-- sync-slot:<name>:end -->
 *
 * ## The contract is render-from-source determinism, not idempotence
 *
 * The renderer always starts from UPSTREAM source, so the same source and the
 * same fragments yield the same bytes on every run, and the manifest hash the
 * divergence gate uses as its base is stable. Feeding a rendered file back in is
 * a caller bug, refused as `already-spliced`, rather than a case to tolerate.
 *
 * ## A declared slot that cannot be filled THROWS
 *
 * The consumer's block must never be silently dropped. A missing, duplicated,
 * frontmatter-placed or fence-placed marker throws a `SlotError`. The sync's
 * write loop turns that into a failed file (not written, target exits
 * non-zero), while historical rendering treats it as "incomparable".
 *
 * PURE throughout: no fs, no clock, no git.
 *
 * Plan: docs/plans/sync-skill-block-holds.md
 *
 * @module scripts/lib/sync-slots
 */

import { canonicalizeEol } from './file-io.mjs';

/** A slot name: lowercase, digits and hyphens, starting with a letter. */
export const SLOT_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** The text every marker, rendered or not, carries. A fragment may not contain it. */
export const SLOT_TOKEN = 'sync-slot:';

const MARKER_LINE_RE = /^<!-- sync-slot:([a-z][a-z0-9-]{0,39}) -->$/;
const RENDERED_START_RE = /^<!-- sync-slot:([a-z][a-z0-9-]{0,39}):start\b/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Every reason a slot cannot be filled, or a fragment cannot be used. */
export const SLOT_ERROR = Object.freeze({
  MISSING: 'slot-missing',
  DUPLICATE: 'slot-duplicate',
  IN_FRONTMATTER: 'slot-in-frontmatter',
  IN_FENCE: 'slot-in-fence',
  ALREADY_SPLICED: 'already-spliced',
  MALFORMED: 'slot-malformed',
  FRAGMENT_EMPTY: 'fragment-empty',
  FRAGMENT_HAS_MARKER: 'fragment-has-marker',
  FRAGMENT_UNBALANCED_FENCE: 'fragment-unbalanced-fence',
});

/** A slot could not be filled. `code` is one of `SLOT_ERROR`. */
export class SlotError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{slot?: string|null, line?: number|null}} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SlotError';
    this.code = code;
    this.slot = detail.slot ?? null;
    this.line = detail.line ?? null;
  }
}

/**
 * Walk markdown lines once, classifying each by frontmatter / fence state and
 * tracking the nearest preceding heading.
 *
 * Frontmatter is a leading `---` line through the next `---` line. A fence
 * opens on 3+ backticks or tildes (up to 3 spaces of indent) and closes on a
 * line of the SAME character at least as long, which is CommonMark's rule; a
 * fence never closed runs to the end of the file.
 *
 * @param {string[]} lines
 * @returns {Array<{text: string, inFrontmatter: boolean, inFence: boolean, heading: string|null}>}
 */
function classifyLines(lines) {
  const out = [];
  let inFrontmatter = lines[0] === '---';
  let frontmatterOpen = inFrontmatter;
  let fence = null; // {char, len}
  let heading = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (frontmatterOpen) {
      out.push({ text, inFrontmatter: true, inFence: false, heading });
      if (i > 0 && text === '---') frontmatterOpen = false;
      continue;
    }
    inFrontmatter = false;
    const m = FENCE_RE.exec(text);
    if (fence) {
      out.push({ text, inFrontmatter, inFence: true, heading });
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && text.trim() === m[1]) fence = null;
      continue;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      out.push({ text, inFrontmatter, inFence: true, heading });
      continue;
    }
    const h = HEADING_RE.exec(text);
    if (h) heading = `${h[1]} ${h[2]}`;
    out.push({ text, inFrontmatter, inFence: false, heading });
  }
  return out;
}

/**
 * Every exact marker line, with where it sits.
 *
 * @param {string} text — LF-canonical markdown
 * @returns {Array<{name: string, line: number, inFrontmatter: boolean, inFence: boolean, heading: string|null}>}
 *   `line` is 1-based.
 */
export function findSlotMarkers(text) {
  const lines = String(text ?? '').split('\n');
  const classified = classifyLines(lines);
  const out = [];
  classified.forEach((c, i) => {
    const m = MARKER_LINE_RE.exec(c.text);
    if (m) out.push({ name: m[1], line: i + 1, inFrontmatter: c.inFrontmatter, inFence: c.inFence, heading: c.heading });
  });
  return out;
}

/**
 * Normalise a consumer fragment into the exact bytes a splice inserts. THROWS a
 * `SlotError` for a fragment that cannot be used.
 *
 * CRLF → LF (the same fold as the outbound renderer, so a Windows checkout of
 * the fragment renders identically), a leading BOM dropped, trailing blank
 * lines trimmed, then exactly one trailing newline. An empty fragment is a
 * forgotten declaration, never an intent; a fragment containing the slot token
 * could open a slot of its own; an unclosed fence would swallow the end marker
 * and every line after it for a markdown reader.
 *
 * @param {string} raw
 * @param {{from?: string}} [ctx]
 * @returns {string}
 */
export function normaliseFragment(raw, { from = '(fragment)' } = {}) {
  let s = canonicalizeEol(Buffer.from(String(raw ?? ''), 'utf-8')).toString('utf-8');
  if (s.startsWith('﻿')) s = s.slice(1);
  s = s.replace(/(?:[ \t]*\n)+$/, '').replace(/[ \t]+$/, '');
  if (!s.trim()) throw new SlotError(SLOT_ERROR.FRAGMENT_EMPTY, `${from}: the fragment is empty — an empty block is a forgotten declaration`);
  if (s.includes(SLOT_TOKEN)) {
    throw new SlotError(SLOT_ERROR.FRAGMENT_HAS_MARKER, `${from}: a fragment may not contain "${SLOT_TOKEN}" — it would open or close a slot of its own`);
  }
  // The fence state AFTER the last line is what matters: a sentinel line that is
  // not a fence reports whether one is still open. The leading blank line keeps
  // a fragment that starts with `---` from being read as frontmatter.
  const walked = classifyLines(['', ...s.split('\n'), '\u0000sentinel']);
  if (walked[walked.length - 1].inFence) {
    throw new SlotError(SLOT_ERROR.FRAGMENT_UNBALANCED_FENCE, `${from}: the fragment opens a fenced code block it never closes`);
  }
  return `${s}\n`;
}

/**
 * The first line of a rendered span. `from` is validated upstream of this
 * (safe characters only), so it cannot close the comment.
 *
 * @param {string} slot
 * @param {string} from
 */
export function renderStartLine(slot, from) {
  return `<!-- sync-slot:${slot}:start — from ${from} (edit it there; a sync rewrites this span) -->`;
}

/** @param {string} slot */
export function renderEndLine(slot) {
  return `<!-- sync-slot:${slot}:end -->`;
}

/**
 * Splice each declared block into its slot. PURE. THROWS `SlotError`.
 *
 * With no blocks this is the identity, deliberately without validating the
 * text: a consumer that declared nothing must never be failed by upstream's
 * marker hygiene, which `lintSlotMarkers` enforces at upstream's push instead.
 *
 * @param {string} text — LF-canonical upstream markdown (post-rewriter)
 * @param {Array<{slot: string, content: string, from: string}>} blocks —
 *   `content` already passed through `normaliseFragment`
 * @returns {{content: string, applied: Array<{slot: string, anchorHeading: string|null}>}}
 */
export function spliceBlocks(text, blocks = []) {
  if (!blocks.length) return { content: text, applied: [] };
  const lines = String(text).split('\n');
  const classified = classifyLines(lines);
  classified.forEach((c, i) => {
    const m = c.inFence ? null : RENDERED_START_RE.exec(c.text);
    if (m) throw new SlotError(SLOT_ERROR.ALREADY_SPLICED, `line ${i + 1}: input already carries a rendered span for slot "${m[1]}" — splicing starts from upstream source, never from a rendered file`, { slot: m[1], line: i + 1 });
  });
  const markers = findSlotMarkers(text);
  const replacements = new Map(); // 0-based line index → replacement lines
  const applied = [];
  for (const block of blocks) {
    const hits = markers.filter((mk) => mk.name === block.slot);
    if (hits.length === 0) {
      throw new SlotError(SLOT_ERROR.MISSING, `slot "${block.slot}" is declared but upstream's file has no <!-- sync-slot:${block.slot} --> marker (removed or renamed upstream)`, { slot: block.slot });
    }
    if (hits.length > 1) {
      throw new SlotError(SLOT_ERROR.DUPLICATE, `slot "${block.slot}" appears ${hits.length} times (lines ${hits.map((h) => h.line).join(', ')}); a slot may appear once`, { slot: block.slot, line: hits[1].line });
    }
    const [hit] = hits;
    if (hit.inFrontmatter) throw new SlotError(SLOT_ERROR.IN_FRONTMATTER, `slot "${block.slot}" sits inside the YAML frontmatter (line ${hit.line})`, { slot: block.slot, line: hit.line });
    if (hit.inFence) throw new SlotError(SLOT_ERROR.IN_FENCE, `slot "${block.slot}" sits inside fenced code (line ${hit.line})`, { slot: block.slot, line: hit.line });
    if (replacements.has(hit.line - 1)) {
      throw new SlotError(SLOT_ERROR.DUPLICATE, `slot "${block.slot}" is declared twice for one file`, { slot: block.slot, line: hit.line });
    }
    const body = block.content.endsWith('\n') ? block.content.slice(0, -1) : block.content;
    replacements.set(hit.line - 1, [renderStartLine(block.slot, block.from), ...body.split('\n'), renderEndLine(block.slot)]);
    applied.push({ slot: block.slot, anchorHeading: hit.heading });
  }
  const out = [];
  lines.forEach((l, i) => { if (replacements.has(i)) out.push(...replacements.get(i)); else out.push(l); });
  applied.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  return { content: out.join('\n'), applied };
}

/**
 * Upstream-side lint of a SKILL.md's markers: every problem, never the first.
 *
 * A line carrying the slot token that is not an exact marker is `slot-malformed`
 * (a typo would otherwise be an inert comment no consumer can fill, found only
 * at a consumer's sync). Placement and uniqueness are the same rules
 * `spliceBlocks` enforces, moved to upstream's push.
 *
 * @param {string} text
 * @returns {Array<{line: number, code: string, message: string}>}
 */
export function lintSlotMarkers(text) {
  const s = canonicalizeEol(Buffer.from(String(text ?? ''), 'utf-8')).toString('utf-8');
  const lines = s.split('\n');
  const classified = classifyLines(lines);
  const problems = [];
  const seen = new Map();
  classified.forEach((c, i) => {
    if (!c.text.includes(SLOT_TOKEN)) return;
    const line = i + 1;
    const m = MARKER_LINE_RE.exec(c.text);
    if (!m) {
      if (c.inFence) return; // documentation of the grammar inside a code fence is prose, not a marker
      problems.push({ line, code: SLOT_ERROR.MALFORMED, message: `"${c.text.trim().slice(0, 80)}" is not an exact <!-- sync-slot:<name> --> marker line` });
      return;
    }
    if (c.inFrontmatter) problems.push({ line, code: SLOT_ERROR.IN_FRONTMATTER, message: `slot "${m[1]}" sits inside the frontmatter` });
    else if (c.inFence) problems.push({ line, code: SLOT_ERROR.IN_FENCE, message: `slot "${m[1]}" sits inside fenced code` });
    if (seen.has(m[1])) problems.push({ line, code: SLOT_ERROR.DUPLICATE, message: `slot "${m[1]}" already appears at line ${seen.get(m[1])}` });
    else seen.set(m[1], line);
  });
  return problems;
}
