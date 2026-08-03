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
