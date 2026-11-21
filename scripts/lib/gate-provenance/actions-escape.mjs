/**
 * @fileoverview GitHub Actions workflow-command escaping. Any line a runner reads from stdout or stderr that starts with
 * `::` is a COMMAND, so every string that can carry attacker text (a filename, a reason built from one, gh output) must be
 * escaped before it reaches output in CI. Percent goes first, so an escape is never double-decoded.
 *
 * @module scripts/lib/gate-provenance/actions-escape
 */

/** Data (the message after `::notice::`): `%`, CR, LF. */
export function escapeData(value) {
  return String(value ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Property values (`title=...`): data escapes plus `:` and `,`. */
export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}
