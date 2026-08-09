/**
 * @fileoverview POSIX shell quoting for values rendered into copy-pasteable
 * command lines.
 *
 * **Not the same job as `quoteWinArg` in anthropic-client.mjs.** That one
 * quotes argv for *spawning* a process on Windows. This one quotes values for
 * *display* inside a ```bash fence that a human (or a Run button) will execute.
 * Same word, different contract — hence a sibling rather than an extension.
 *
 * ## Why this exists
 *
 * `cmdLockWithTestWorksheet` rendered:
 *
 *     ... --test ${guess} --description "pins: ${category.replace(/"/g, "'")}"
 *
 * `guess` is a filesystem path discovered by globbing the repo's test tree and
 * `category` is model-generated text. The `--description` value sat inside
 * DOUBLE quotes, which in every POSIX shell still expand `$(...)`, backticks,
 * `$VAR` and `\`. Escaping only `"` therefore closed the least interesting
 * hole. Nothing is `exec`'d by the tool, so this is a copy-paste hazard rather
 * than live injection — but the whole value of a rendered command is that an
 * operator runs it without re-reading it, which is exactly what makes an
 * unescaped one dangerous.
 *
 * ## Why single quotes, and the one thing they cost
 *
 * Inside POSIX single quotes NOTHING is special — no expansion, no escapes.
 * That makes the rule total rather than a denylist of characters someone has to
 * keep current. The single exception is `'` itself, which cannot appear inside
 * a single-quoted string at all and must be spliced: close, emit an escaped
 * quote, reopen (`'\''`).
 *
 * **PowerShell caveat, stated because this repo's operators use it.** Single
 * quotes are literal in PowerShell too, so a quoted value pastes correctly
 * there — EXCEPT for that splice, since PowerShell escapes an embedded quote by
 * doubling it (`''`) rather than with `'\''`. The two are irreconcilable in one
 * string. `shellQuoteSingle` is POSIX-correct (the fences are tagged ```bash);
 * for free-text fields prefer `shellQuoteLabel`, which removes the divergence
 * at the source by not letting a quote reach the splice.
 *
 * @module scripts/lib/shell-quote
 */

/**
 * Quote a value for safe inclusion in a POSIX shell command line.
 *
 * @param {unknown} value - coerced with String(); null/undefined become ''
 * @returns {string} a single-quoted token, safe to paste verbatim
 */
export function shellQuoteSingle(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Quote a free-text LABEL (a finding category, a description) for a rendered
 * command line.
 *
 * Two normalisations before quoting, both because the target is a one-line
 * pasteable command rather than prose:
 *
 *  - **Newlines and tabs collapse to spaces.** An embedded newline would end
 *    the command early and turn the remainder into a second line the operator
 *    did not mean to run — the shell-injection outcome reached without any
 *    metacharacter at all.
 *  - **`'` becomes a typographic right quote.** It is the ONLY character whose
 *    escaping differs between POSIX and PowerShell, so removing it makes the
 *    quoted result correct in both. A label is a human-readable string, not an
 *    identifier, so substituting the glyph loses nothing that matters.
 *
 * Use `shellQuoteSingle` for values that must survive byte-exact (paths, ids).
 *
 * @param {unknown} value
 * @returns {string} a single-quoted, single-line token
 */
export function shellQuoteLabel(value) {
  const s = (value === null || value === undefined ? '' : String(value))
    .replace(/[\r\n\t]+/g, ' ')
    .replaceAll("'", '’')
    .trim();
  return shellQuoteSingle(s);
}
