/**
 * @fileoverview Shared CommonMark fenced-code-block tracker.
 *
 * Extracted from scripts/check-context-drift.mjs (Gemini shadow finding,
 * refactor-architecture-debt-remainder-2026-07.md item 3 audit) after
 * scripts/check-architecture-intent-drift.mjs independently hand-derived
 * the identical char+length fence-matching logic across three audit
 * rounds, converging on behavior this module already had. Two copies of
 * a subtle Markdown parser drift apart; this is the single source.
 *
 * @module scripts/lib/markdown-fence-tracker
 */

/**
 * Track whether the current line is inside a fenced code block, following
 * CommonMark rules: opening fence is N>=3 backticks or tildes; closing
 * fence must use the SAME character AND have length >= the opening fence.
 * This means a block opened with ```` (4 backticks) is not closed by ```
 * (3 backticks) — the latter is treated as content inside the block.
 *
 * Returns an updater that takes a line and returns whether that line is
 * either inside a fence or is a fence delimiter (i.e. not a heading).
 */
export function makeFenceTracker() {
  let inFence = false;
  let marker = null;
  let openLength = 0;
  // `update.isOpen()` — whether a fence is open AFTER the last line fed. The
  // return value cannot say this: it is true for a closing delimiter too.
  update.isOpen = () => inFence;
  return update;
  function update(line) {
    // 0-3 spaces of indent: CommonMark reads a fence indented 4+ as indented code.
    const m = /^ {0,3}(```+|~~~+)/.exec(line);
    if (!m) return inFence;
    const fenceStr = m[1];
    const ch = fenceStr[0];
    const len = fenceStr.length;
    if (!inFence) {
      inFence = true;
      marker = ch;
      openLength = len;
      return true;
    }
    // Closing requires same char AND length >= open length AND nothing but
    // whitespace after it: CommonMark gives a closing fence no info string, so
    // a "```js" inside a "```markdown" block is content, not a close.
    if (ch === marker && len >= openLength && line.slice(m[0].length).trim() === '') {
      inFence = false;
      marker = null;
      openLength = 0;
    }
    return true; // line is a fence delimiter or inside a fence — not a heading
  }
}
