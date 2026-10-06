/**
 * @fileoverview ONE helper for rendering copy-pasteable commands. DISPLAY ONLY —
 * fleet never executes a string built here (every spawn is an argv array).
 *
 * POSIX: a token of plain characters is left bare, anything else is single-quoted
 * with embedded `'` written as `'\''`. Windows (PowerShell): single-quoted with
 * `'` doubled — a PowerShell single-quoted string is fully literal (no `$`,
 * backtick or `%` expansion). A command whose first token had to be quoted needs
 * the call operator in PowerShell, which `renderCommand` adds.
 *
 * @module scripts/lib/fleet/shell-quote
 */

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
// PowerShell argument mode gives @ + = , ~ # % special meaning: only this set stays bare.
const PLAIN_WIN = /^[A-Za-z0-9_./\\:-]+$/;

/**
 * @param {string} arg
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function quoteArg(arg, platform = process.platform) {
  const s = String(arg);
  if (platform === 'win32') {
    if (PLAIN_WIN.test(s)) return s;
    return `'${s.replace(/'/g, "''")}'`;
  }
  if (PLAIN.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Render an argv as one pasteable command line.
 * @param {string[]} argv
 * @param {NodeJS.Platform} [platform]
 */
export function renderCommand(argv, platform = process.platform) {
  const parts = argv.map((a) => quoteArg(a, platform));
  if (platform === 'win32' && parts[0] !== argv[0]) return `& ${parts.join(' ')}`;
  return parts.join(' ');
}
