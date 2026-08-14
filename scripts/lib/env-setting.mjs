/**
 * @fileoverview Pure `.env` setting writer + value-origin resolver.
 *
 * Extracted from gemini-review.mjs's `applyProviderSetting` (Cluster B / Phase 3)
 * so a second `.env` mutator (azure-doctor) doesn't duplicate the line-editing
 * logic (#1 DRY). Pure — no IO — so the edit semantics are unit-testable and the
 * caller owns the read/atomic-write (#11).
 *
 * **Safety posture for a secret-bearing file (plan §8 R4):**
 *   - Only the target key's line is inserted/replaced/removed. Unrelated lines —
 *     including secret values — are preserved byte-for-byte.
 *   - The file's dominant line ending (CRLF vs LF) is preserved; we never rewrite
 *     every line ending of a Windows `.env`.
 *   - Blank-line runs are NOT collapsed by default. `applyProviderSetting`'s
 *     historical normalisation is opt-in via `{ reformat: true }`, so its output
 *     stays byte-identical while a fresh caller (azure-doctor) leaves the user's
 *     formatting untouched.
 *
 * @module scripts/lib/env-setting
 */

/** Escape a string for use as a literal inside a RegExp. */
// @duplicate-justification: target=scripts/lib/cli-io.mjs:escapeRegExp reason=this module documents itself as intentionally dependency-free/pure (no imports) so a second .env mutator can unit-test it in isolation; importing cli-io.mjs (which pulls in node:fs/node:crypto for its own unrelated helpers) would be a backwards coupling for a 2-line utility, so the copy stays local and justified here instead
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Detect the dominant line ending so we can round-trip it. */
function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

/**
 * Compute new `.env` contents after inserting / replacing / removing one key.
 *
 * @param {string} existingText - current file contents ('' when the file is absent)
 * @param {string} key - env var name (e.g. `AZURE_OPENAI_EMBED_DEPLOYMENT`)
 * @param {string|null} value - new value; `null` REMOVES the key (and its managed comment)
 * @param {{comment?: string|null, reformat?: boolean}} [opts]
 *   - `comment`: a managed comment line written directly above an INSERTED key,
 *     and removed with the key on `value === null` (only if it's the line above).
 *   - `reformat`: collapse blank-line runs to a single blank (opt-in — matches the
 *     legacy `applyProviderSetting` output). Default false: preserve user formatting.
 * @returns {{text: string, changed: boolean}} `text` equals the input when nothing changed.
 */
export function applyEnvSetting(existingText, key, value, opts = {}) {
  const { comment = null, reformat = false } = opts;
  const eol = detectEol(existingText || '');
  const eolEsc = escapeRegExp(eol);
  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const lines = existingText && existingText.length ? existingText.split(/\r?\n/) : [];
  // ALL matching lines. dotenv resolves a duplicated key to the LAST assignment,
  // so we must act on the last (audit H3): editing the first while a later dupe
  // wins would report success yet leave the effective value unchanged.
  const matchIdx = [];
  lines.forEach((l, i) => { if (keyRe.test(l)) matchIdx.push(i); });

  if (value === null) {
    // REMOVE. No key → genuine no-op (input returned verbatim). Remove ALL dupes
    // (+ each managed comment directly above) so nothing stale survives.
    if (matchIdx.length === 0) return { text: existingText, changed: false };
    for (let k = matchIdx.length - 1; k >= 0; k--) {
      const idx = matchIdx[k];
      lines.splice(idx, 1);
      if (comment && idx - 1 >= 0 && lines[idx - 1] === comment) lines.splice(idx - 1, 1);
    }
  } else if (matchIdx.length === 0) {
    // INSERT. Separate from prior content with one blank line if needed.
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    if (comment) lines.push(comment);
    lines.push(`${key}=${value}`);
  } else {
    // REPLACE the LAST (dotenv-effective) assignment; drop earlier dupes of the
    // SAME key so the file matches what dotenv actually resolves.
    lines[matchIdx[matchIdx.length - 1]] = `${key}=${value}`;
    for (let k = matchIdx.length - 2; k >= 0; k--) lines.splice(matchIdx[k], 1);
  }

  let text = lines.join(eol);
  if (reformat) {
    // Opt-in normalisation (legacy applyProviderSetting output): collapse blank
    // runs AND strip trailing blank lines to exactly one terminal EOL.
    text = text.replace(new RegExp(`(?:${eolEsc}){3,}`, 'g'), eol + eol)
               .replace(new RegExp(`(?:${eolEsc})*$`), '') + eol;
  } else {
    // Default: preserve the user's formatting, including terminal blank lines
    // (audit L1/M1). Only GUARANTEE the file ends with a newline — never strip.
    if (!text.endsWith(eol)) text += eol;
  }
  return { text, changed: true };
}

/**
 * Resolve a key's value AND whether an active process-environment value would
 * shadow the file we can write (plan §2 / H6→H10).
 *
 * We do NOT claim to recover the value's *origin* — once dotenv has merged, a
 * `process.env` value is indistinguishable from one loaded out of a `.env`, and
 * dotenv here is `override:false` so a shell export beats the file anyway. What
 * IS observable: parse the target file directly and compare its value to the live
 * `process.env` value. The doctor uses `liveValue !== fileValue` (after writing)
 * to warn that a shell export will keep overriding the file — a claim we can
 * actually support.
 *
 * @param {string} key
 * @param {{envFileText?: string}} [opts] - the ALREADY-READ target file text ('' if absent).
 *   The caller reads the file (this module stays pure/IO-free).
 * @returns {{fileValue: string|null, liveValue: string|null}}
 */
export function resolveEnvValue(key, opts = {}) {
  const { envFileText = '' } = opts;
  const keyLineRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=(.*)$`);
  let fileValue = null;
  for (const line of envFileText.split(/\r?\n/)) {
    const m = keyLineRe.exec(line);
    if (m) fileValue = m[1]; // last wins, mirroring dotenv
  }
  const live = process.env[key];
  return { fileValue, liveValue: (live === undefined ? null : live) };
}

export const _internals = { escapeRegExp, detectEol };
