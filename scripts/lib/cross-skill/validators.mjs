/**
 * @fileoverview Value-domain validators shared by the cross-skill commands that
 * issue and accept keyset cursors (`final-review-pending`, and the two /ship
 * nudge readers). Both bind the decoded members straight into an ordering query,
 * so each must check the VALUE's domain, not just its type.
 *
 * Lives beside the commands rather than inside one of them: `commands/ship.mjs`
 * used to import these from `commands/final-review.mjs`, which made an unrelated
 * command module a dependency of the ship domain for two regexes.
 */

const PG_TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape AND semantics (audit-code cluster B R2 M1 / R3 M1): `2026-13-01 …`
 * matches the shape and is not a date; `2026-02-30 …` is NORMALISED by
 * Date.parse to March 2nd rather than rejected, so the calendar date is
 * checked by round-trip — the parsed instant must report the same Y-M-D.
 */
export const isPgTimestamptzText = (s) => {
  if (!PG_TIMESTAMPTZ_TEXT.test(s)) return false;
  const iso = s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  // Compare the date part in the string's own offset: shift by the offset so
  // the UTC getters read the local calendar day the string named.
  const off = /(?:Z|([+-])(\d{2}):?(\d{2})?)$/.exec(iso);
  const offMin = off && off[1] ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] || 0)) : 0;
  const d = new Date(ms + offMin * 60_000);
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return s.startsWith(ymd);
};
