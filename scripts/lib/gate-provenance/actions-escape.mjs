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

/**
 * A runner reads a COMMAND from any line that starts with `::`, leading whitespace included. Data escaping handles newlines
 * inside a fragment, but a fragment that IS the start of a line could still open a command, so a leading marker is neutralised
 * by prefixing `| `.
 */
export function neutralizeLeadingCommand(line) {
  return /^\s*::/.test(line) ? `| ${line}` : line;
}

/** For a standalone stdout/stderr line built from untrusted text: data-escaped, and never starting a command. */
export function escapeLogLine(value) {
  return neutralizeLeadingCommand(escapeData(value));
}
