/**
 * @fileoverview PURE parsers for the head of `status.md`, for the dashboard Home card.
 *
 * `status.md` is newest-entry-first, so only its head matters and a fixed window is
 * enough: {@link STATUS_HEAD_BYTES} (256 KB). Entries are `## YYYY-MM-DD — title`;
 * a `## ` heading that does not match is COUNTED and surfaced (`skippedHeadings`),
 * never silently dropped — a format drift would otherwise read as "fewer ships".
 *
 * `latestBacklogLine` returns the newest `Backlog <ISO>Z: …` line (the one `/ship`
 * pastes from `renderBacklogSnapshot`); `parseBacklogLine` in
 * `lib/store/backlog-snapshot.mjs` is its reader.
 *
 * Fenced code blocks are skipped through `markdown-fence-tracker.mjs` (the repo's one fence
 * oracle), so a heading or Backlog line inside an example is ignored. No I/O. Plan: docs/plans/dashboard-home-summary.md §2 (Recently shipped).
 *
 * @module scripts/lib/dashboard/status-entries
 */

import { makeFenceTracker } from '../markdown-fence-tracker.mjs';

/** How much of the file's head is read (bytes on disk) and parsed (characters). */
export const STATUS_HEAD_BYTES = 256 * 1024;


const ENTRY_HEADING = /^## (\d{4}-\d{2}-\d{2}) (?:—|–|-) (.+?)\s*$/;
const PLAN_PATH = /docs\/plans\/[A-Za-z0-9][A-Za-z0-9._-]*\.md/;
const BACKLOG_LINE = /^Backlog \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z: .+$/;

/**
 * Complete lines of the head. `capped` says the text is a PREFIX of a larger file (decided by
 * the caller from the file size — the string length alone cannot tell an exact-cap prefix from
 * a whole file); the possibly-cut final line is then dropped rather than parsed as garbage.
 */
function headLines(text, capped) {
  const s = String(text ?? '');
  const isCapped = capped ?? s.length > STATUS_HEAD_BYTES;
  const lines = (s.length > STATUS_HEAD_BYTES ? s.slice(0, STATUS_HEAD_BYTES) : s).split(/\r?\n/);
  if (isCapped) lines.pop();
  return { lines, capped: isCapped };
}

/** Lines outside any fenced block (CommonMark open/close rules, via the shared tracker). */
function* outsideFences(lines) {
  const inside = makeFenceTracker();
  for (const line of lines) if (!inside(line)) yield line;
}

/**
 * Parse dated entries from the head of `status.md`.
 *
 * @param {string} text
 * @param {number} [limit=10] - entries to return (newest first, file order)
 * @param {{capped?: boolean}} [opts] - `capped`: the text is a prefix of a larger file
 * @returns {{entries: Array<{date: string, title: string, planPath: string|null}>, skippedHeadings: number, capped: boolean}}
 */
export function parseStatusEntries(text, limit = 10, { capped } = {}) {
  const h = headLines(text, capped);
  const entries = [];
  let skippedHeadings = 0;
  let current = null;
  for (const line of outsideFences(h.lines)) {
    if (/^## /.test(line)) {
      const m = ENTRY_HEADING.exec(line);
      if (!m) { skippedHeadings += 1; current = null; continue; }
      current = { date: m[1], title: m[2], planPath: planIn(m[2]) };
      entries.push(current);
      continue;
    }
    if (current && !current.planPath) current.planPath = planIn(line);
  }
  return { entries: entries.slice(0, Math.max(0, limit)), skippedHeadings, capped: h.capped };
}

/** The first plan path an entry names (title or body), or null. Never contains `..`. */
function planIn(line) {
  const m = PLAN_PATH.exec(line);
  return m && !m[0].includes('..') ? m[0] : null;
}

/**
 * The newest `Backlog <ISO>Z: …` line in the head (fenced examples ignored), or null.
 * @param {string} text
 * @param {{capped?: boolean}} [opts]
 * @returns {string|null}
 */
export function latestBacklogLine(text, { capped } = {}) {
  for (const line of outsideFences(headLines(text, capped).lines)) {
    if (BACKLOG_LINE.test(line.trim())) return line.trim();
  }
  return null;
}
