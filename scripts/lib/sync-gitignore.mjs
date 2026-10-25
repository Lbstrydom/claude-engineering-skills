/**
 * @fileoverview Managed-block manager for the consumer's `.gitignore`.
 *
 * Idempotent. Treats malformed marker states as VALIDATION ERRORS (not
 * fail-soft) so corruption can't compound silently. Plan §2 KD #5.
 *
 * Marker state table:
 *   Begin | End | Order        | Action
 *   ------|-----|--------------|--------
 *   0     | 0   | n/a          | append block at EOF with leading blank line
 *   1     | 1   | begin<end    | replace contents between markers (idempotent)
 *   1     | 0   | n/a          | VALIDATION ERROR (orphan begin)
 *   0     | 1   | n/a          | VALIDATION ERROR (orphan end)
 *   ≥2    | any | n/a          | VALIDATION ERROR (duplicate block)
 *   any   | ≥2  | n/a          | VALIDATION ERROR (duplicate block)
 *   1     | 1   | end<begin    | VALIDATION ERROR (out of order)
 *   missing file (input null)  | create with just the block
 *
 * @module scripts/lib/sync-gitignore
 */

import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';

const BEGIN = LAYOUT_CONSTANTS.MARKER_BEGIN;
const END = LAYOUT_CONSTANTS.MARKER_END;

/**
 * Detect the dominant line ending of an existing consumer file.
 *
 * We own a marked BLOCK inside a file the consumer owns, so rewriting the
 * whole file's line endings is a side effect beyond that ownership. On a
 * Windows consumer (`core.autocrlf=true`, no `.gitattributes` pin covering
 * the path) renormalizing CRLF→LF leaves the file permanently stat-dirty:
 * `git status` reports ` M` forever while `git diff` is empty, because the
 * normalized blob still matches HEAD. Ties and empty input default to LF,
 * which is git's canonical in-repo form.
 *
 * @param {string|null|undefined} content
 * @returns {'\r\n'|'\n'}
 */
function detectEol(content) {
  if (typeof content !== 'string' || content.length === 0) return '\n';
  const crlf = (content.match(/\r\n/g) || []).length;
  const bareLf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > bareLf ? '\r\n' : '\n';
}

/**
 * Introspect a .gitignore content string.  Pure function.
 *
 * @param {string|null} content
 * @returns {{beginIndices: number[], endIndices: number[], orderValid: boolean, blockSpan: null | {beginLine: number, endLine: number}}}
 */
export function parseGitignoreState(content) {
  if (content === null || content === undefined) {
    return { beginIndices: [], endIndices: [], orderValid: true, blockSpan: null };
  }
  const lines = String(content).split(/\r?\n/);
  const beginIndices = [];
  const endIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === BEGIN) beginIndices.push(i);
    else if (t === END) endIndices.push(i);
  }
  let orderValid = true;
  let blockSpan = null;
  if (beginIndices.length === 1 && endIndices.length === 1) {
    if (beginIndices[0] < endIndices[0]) {
      blockSpan = { beginLine: beginIndices[0], endLine: endIndices[0] };
    } else {
      orderValid = false;
    }
  }
  return { beginIndices, endIndices, orderValid, blockSpan };
}

/**
 * Update or create the managed block.  Returns an action descriptor; the
 * caller decides whether to write the result.
 *
 * @param {string|null} existingContent — null means file doesn't exist
 * @param {string[]} ignorePatterns — lines to include between the markers
 * @returns {{content: string, action: 'create'|'replace'|'noop'|'abort', error?: string}}
 */
export function updateManagedBlock(existingContent, ignorePatterns) {
  if (!Array.isArray(ignorePatterns) || ignorePatterns.length === 0) {
    return { content: existingContent ?? '', action: 'abort', error: 'updateManagedBlock: ignorePatterns must be a non-empty array' };
  }

  const eol = detectEol(existingContent);
  const blockBody = ignorePatterns.map((p) => String(p).trim()).filter(Boolean).join(eol);
  const blockText = `${BEGIN}${eol}${blockBody}${eol}${END}`;

  if (existingContent === null || existingContent === undefined) {
    return { content: blockText + eol, action: 'create' };
  }

  const state = parseGitignoreState(existingContent);
  const { beginIndices, endIndices, orderValid } = state;

  if (beginIndices.length >= 2 || endIndices.length >= 2) {
    return {
      content: existingContent,
      action: 'abort',
      error: `.gitignore has duplicate managed block(s): ${beginIndices.length} begin markers, ${endIndices.length} end markers. Manually consolidate before re-syncing.`,
    };
  }

  if (beginIndices.length === 1 && endIndices.length === 0) {
    return {
      content: existingContent,
      action: 'abort',
      error: `.gitignore has orphan begin marker at line ${beginIndices[0] + 1}; no matching end marker. Remove the orphan or pair it.`,
    };
  }

  if (beginIndices.length === 0 && endIndices.length === 1) {
    return {
      content: existingContent,
      action: 'abort',
      error: `.gitignore has orphan end marker at line ${endIndices[0] + 1}; no matching begin marker. Remove the orphan or pair it.`,
    };
  }

  if (beginIndices.length === 1 && endIndices.length === 1 && !orderValid) {
    return {
      content: existingContent,
      action: 'abort',
      error: `.gitignore has managed markers out of order: end at line ${endIndices[0] + 1} appears before begin at line ${beginIndices[0] + 1}.`,
    };
  }

  if (beginIndices.length === 0 && endIndices.length === 0) {
    const trimmed = existingContent.endsWith(eol) ? existingContent : existingContent + eol;
    const separator = trimmed.endsWith(eol + eol) ? '' : eol;
    return { content: trimmed + separator + blockText + eol, action: 'create' };
  }

  // beginIndices.length === 1 && endIndices.length === 1 && orderValid
  const lines = String(existingContent).split(/\r?\n/);
  const before = lines.slice(0, beginIndices[0]).join(eol);
  const after = lines.slice(endIndices[0] + 1).join(eol);
  const next = `${before}${before ? eol : ''}${blockText}${after ? eol + after : ''}`;
  // Preserve trailing newline if original had one.
  const final = existingContent.endsWith(eol) && !next.endsWith(eol) ? next + eol : next;

  if (final === existingContent) return { content: existingContent, action: 'noop' };
  return { content: final, action: 'replace' };
}

export const _internals = { BEGIN, END, detectEol };

/**
 * Is a consumer's `.gitignore` edit nothing but the managed block? PURE - built on the one canonical parser
 * (`parseGitignoreState`), never a second one.
 *
 * `sync:pr` commits the sync's output, and the sync rewrites the managed block in a file the consumer owns. That edit used to be
 * left uncommitted (proposal a5ce: both WCA and STO reported an unexplained `.gitignore` change in their main checkout), but
 * committing the file blind would sweep in any hand edit beside the block. This asks the narrow question: with the block cut out,
 * is everything else byte-for-byte what `headText` has?
 *
 *   outcome       when
 *   unchanged     the two texts are identical
 *   block-only    the only difference is the managed block: replaced in place, inserted into a file that had none (first
 *                 install), or - `headText === null`, the file absent from the base - the file consists of the block alone
 *   mixed         anything else differs, or the block vanished (line endings are NOT compared: git normalises them, and a Windows
 *                 consumer's working file is CRLF while the base blob is LF)
 *   invalid       either side has duplicate, orphan or out-of-order markers
 *
 * Surrounding blank lines are not part of the comparison: `updateManagedBlock` inserts one before a new block.
 *
 * @param {string|null} headText - the file at the base, or null when the path does not exist there
 * @param {string} workText - the working-tree file
 * @returns {'unchanged'|'block-only'|'mixed'|'invalid'}
 */
export function classifyGitignoreTransition(headText, workText) {
  if (typeof workText !== 'string') return 'invalid';
  // Line endings are git's business, not a change: a Windows working file is CRLF where the base blob is LF (final review G1).
  const lf = (s) => s.replace(/\r\n/g, '\n');
  if (headText === workText || (headText !== null && lf(headText) === lf(workText))) return 'unchanged';
  const split = (text) => {
    const state = parseGitignoreState(text);
    const { beginIndices, endIndices, orderValid, blockSpan } = state;
    const wellFormed = (beginIndices.length === 0 && endIndices.length === 0)
      || (beginIndices.length === 1 && endIndices.length === 1 && orderValid && blockSpan);
    if (!wellFormed) return null;
    const lines = text.split(/\r?\n/);
    const trim = (ls) => {
      let a = 0;
      let b = ls.length;
      while (a < b && ls[a].trim() === '') a++;
      while (b > a && ls[b - 1].trim() === '') b--;
      return ls.slice(a, b);
    };
    return blockSpan
      ? { hasBlock: true, block: lines.slice(blockSpan.beginLine, blockSpan.endLine + 1), before: trim(lines.slice(0, blockSpan.beginLine)), after: trim(lines.slice(blockSpan.endLine + 1)) }
      : { hasBlock: false, before: trim(lines), after: [] };
  };
  const work = split(workText);
  const head = headText === null ? { hasBlock: false, before: [], after: [] } : split(headText);
  if (!work || !head) return 'invalid';
  if (!work.hasBlock) return 'mixed';
  const same = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);
  if (!same(head.before, work.before) || !same(head.after, work.after)) return 'mixed';
  // Same surroundings AND the same block, yet the texts differ (we already ruled out line endings): only blank lines moved - a hand edit, and
  // nothing the sync wrote. Reporting it block-only would commit a change that is not the block's (final review G1).
  if (head.hasBlock && same(head.block, work.block)) return 'mixed';
  return 'block-only';
}
