/**
 * @fileoverview Heading-aware extraction of named H2 sections from the
 * repo's canonical instruction file (`AGENTS.md` → `CLAUDE.md`).
 *
 * This is shared infrastructure — consumed by `/brainstorm` (`--with-arch`,
 * via `arch-context.mjs`) and by the audit context layer (`repo-context.mjs`
 * tier T2). It lives in a neutral `lib/` location rather than under the
 * `brainstorm/` feature namespace so a shared concern is not owned by one
 * feature (audit P2-M15 / P3-M4).
 *
 * @module scripts/lib/doc-sections
 */
import fs from 'node:fs';
import path from 'node:path';

/** Default section heading — the architecture overview. */
export const ARCH_SECTION_HEADING = '## Architecture';

/** Instruction-file candidates, in resolution order. */
const CANDIDATE_FILES = ['AGENTS.md', 'CLAUDE.md'];

/**
 * Extract a named H2 section with a heading-aware line parser. Not a
 * regex: `\Z` is not a JS anchor, and a single `[\s\S]*?` regex mishandles
 * CRLF, EOF-without-newline, and `## ` lines inside fenced code blocks.
 * Heading match is exact string comparison (whitespace-tolerant) — no
 * regex, so a heading containing regex metacharacters (`## R2+ Audit
 * Mode`) is matched literally.
 *
 * @param {string} content - raw file content
 * @param {string} heading - the full H2 heading line, e.g. `## Architecture`
 * @returns {string|null} the section (heading line through the line
 *   before the next H1/H2), or null if no such heading exists
 */
export function extractSection(content, heading) {
  const want = String(heading).trim();
  const lines = String(content).split(/\r\n|\r|\n/);
  let inFence = false;
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed === want) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const collected = [lines[start]];
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      collected.push(line);
      continue;
    }
    // A non-fenced H1 or H2 ends the section. `### …` subsections stay.
    if (!inFence && (/^## /.test(line) || /^# /.test(line))) break;
    collected.push(line);
  }
  return collected.join('\n').trimEnd();
}

/**
 * Load a named H2 section from the repo's instruction file.
 *
 * Walks `[AGENTS.md, CLAUDE.md]` (resolved against `baseDir`) and returns
 * the FIRST candidate that yields the requested section. Reads literal
 * file content — does NOT resolve `@./AGENTS.md` import indirection (an
 * importer-stub CLAUDE.md simply parses to `no-section`).
 *
 * Never throws: all `fs` exceptions are caught at the boundary and
 * collapse to `state:'unreadable'`. Terminal-state precedence when no
 * candidate yields the section: `no-section` (a readable file lacked the
 * heading) beats `unreadable` (I/O error) beats `no-file` (nothing
 * existed) — a definite "not here" outranks an I/O error.
 *
 * @param {{heading?: string, baseDir?: string}} [opts]
 * @returns {{state: 'ok'|'no-file'|'no-section'|'unreadable', text: string, sourceFile: string|null, heading: string, error?: string}}
 */
export function loadSection({ heading = ARCH_SECTION_HEADING, baseDir = process.cwd() } = {}) {
  let sawReadableNoSection = false;
  let firstError = null;
  let unreadableFile = null;

  for (const name of CANDIDATE_FILES) {
    const filePath = path.resolve(baseDir, name);
    if (!fs.existsSync(filePath)) continue;
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      if (firstError === null) {
        firstError = err.message || String(err);
        unreadableFile = name;
      }
      continue;
    }
    const section = extractSection(content, heading);
    if (section && section.length > 0) {
      return { state: 'ok', text: section, sourceFile: name, heading };
    }
    sawReadableNoSection = true;
  }

  if (sawReadableNoSection) {
    return { state: 'no-section', text: '', sourceFile: null, heading };
  }
  if (firstError !== null) {
    return { state: 'unreadable', text: '', sourceFile: unreadableFile, heading, error: firstError };
  }
  return { state: 'no-file', text: '', sourceFile: null, heading };
}
