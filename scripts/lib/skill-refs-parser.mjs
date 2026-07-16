/**
 * @fileoverview Parser for the "## Reference files" section of a SKILL.md
 * and the `summary:` frontmatter of reference files. Deterministic regex
 * parsing — no LLMs, no fuzzy matching.
 *
 * Contract documented in docs/reference/skill-reference-format.md.
 * @module scripts/lib/skill-refs-parser
 */

import fs from 'node:fs';
import path from 'node:path';

const SECTION_HEADING_RE = /^##\s+Reference files\s*$/m;
// A three-column table row: | cell | cell | cell |
const TABLE_ROW_RE = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/;
// Detects the header row explicitly (we skip both header and separator)
const HEADER_CELLS = ['file', 'summary', 'read when'];
const SEPARATOR_RE = /^\|?\s*:?-{3,}:?\s*\|/;

// Matches YAML frontmatter at the top of a file
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\r?\n|$)/;
const SUMMARY_KEY_RE = /^\s*summary\s*:\s*(.+?)\s*$/m;

const SUMMARY_MAX_CHARS = 120;

/**
 * Locate and slice the reference-files section from a SKILL.md body.
 * @param {string} markdown
 * @returns {{ found: boolean, lines: string[] }}
 */
export function locateReferenceSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADING_RE.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return { found: false, lines: [] };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return { found: true, lines: lines.slice(start + 1, end) };
}

/**
 * Parse the reference-files table from a SKILL.md body.
 *
 * @param {string} markdown
 * @returns {{
 *   found: boolean,
 *   entries: Array<{ file: string, summary: string, readWhen: string }>,
 *   errors: string[],
 * }}
 */
export function parseReferenceTable(markdown) {
  const section = locateReferenceSection(markdown);
  if (!section.found) return { found: false, entries: [], errors: [] };

  const entries = [];
  const errors = [];
  let sawHeader = false;

  for (const raw of section.lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (!line.startsWith('|')) continue;
    if (SEPARATOR_RE.test(line)) continue;

    const m = TABLE_ROW_RE.exec(line);
    if (!m) continue;
    const [, file, summary, readWhen] = m;

    if (!sawHeader) {
      // The first matching row is expected to be the header
      const headerCells = [file, summary, readWhen].map(s => s.toLowerCase().trim());
      if (JSON.stringify(headerCells) !== JSON.stringify(HEADER_CELLS)) {
        errors.push(`Reference table header expected [File, Summary, Read when]; got [${file}, ${summary}, ${readWhen}]`);
      }
      sawHeader = true;
      continue;
    }

    const fileTrim = file.replaceAll(/^`|`$/g, '').trim();
    const summaryTrim = summary.trim();
    const readWhenTrim = readWhen.trim();

    if (!fileTrim.startsWith('references/') && !fileTrim.startsWith('examples/')) {
      errors.push(`Row file path must start with references/ or examples/: "${fileTrim}"`);
    }
    if (summaryTrim.length > SUMMARY_MAX_CHARS) {
      errors.push(`Summary exceeds ${SUMMARY_MAX_CHARS} chars: "${summaryTrim}"`);
    }
    if (summaryTrim.length === 0) {
      errors.push(`Row for "${fileTrim}" has empty Summary`);
    }
    if (readWhenTrim.length === 0) {
      errors.push(`Row for "${fileTrim}" has empty Read when`);
    }

    entries.push({ file: fileTrim, summary: summaryTrim, readWhen: readWhenTrim });
  }

  return { found: true, entries, errors };
}

/**
 * Parse the `summary:` line from a reference file's YAML frontmatter.
 * @param {string} markdown
 * @returns {{ summary: string|null, error?: string }}
 */
export function parseReferenceFrontmatter(markdown) {
  const fm = FRONTMATTER_RE.exec(markdown);
  if (!fm) return { summary: null, error: 'No YAML frontmatter found — expected --- fenced block at top of file' };

  const body = fm[1];
  const m = SUMMARY_KEY_RE.exec(body);
  if (!m) return { summary: null, error: 'Frontmatter missing required "summary:" key' };

  let value = m[1].trim();
  // Strip quoted string wrappers if present
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value.length === 0) return { summary: null, error: 'Frontmatter "summary:" value is empty' };
  if (value.length > SUMMARY_MAX_CHARS) {
    return { summary: value, error: `Frontmatter summary exceeds ${SUMMARY_MAX_CHARS} chars` };
  }
  return { summary: value };
}

/**
 * Full lint of a single skill directory.
 * @param {string} skillDir — absolute path to skills/<name>/
 * @returns {{
 *   skillName: string,
 *   ok: boolean,
 *   errors: string[],
 *   entries: Array<{ file: string, summary: string, readWhen: string }>,
 * }}
 */
export function lintSkill(skillDir) {
  const skillName = path.basename(skillDir);
  const errors = [];
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return { skillName, ok: false, errors: [`SKILL.md not found at ${skillPath}`], entries: [] };
  }

  const body = fs.readFileSync(skillPath, 'utf8');
  const table = parseReferenceTable(body);
  errors.push(...table.errors);

  const refsDir = path.join(skillDir, 'references');
  const examplesDir = path.join(skillDir, 'examples');

  if (!table.found) {
    // No reference-files section: refs/examples dirs must not exist or must be empty
    for (const dir of [refsDir, examplesDir]) {
      if (fs.existsSync(dir)) {
        const contents = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
        if (contents.length > 0) {
          errors.push(
            `${path.relative(skillDir, dir)}/ contains files but SKILL.md has no "## Reference files" section: ${contents.join(', ')}`,
          );
        }
      }
    }
    return { skillName, ok: errors.length === 0, errors, entries: [] };
  }

  // Section exists — verify every entry points at a real file with matching frontmatter
  const listedFiles = new Set();
  for (const entry of table.entries) {
    listedFiles.add(entry.file);
    const absFile = path.join(skillDir, entry.file);
    if (!fs.existsSync(absFile)) {
      errors.push(`Reference entry "${entry.file}" — file does not exist`);
      continue;
    }
    const refBody = fs.readFileSync(absFile, 'utf8');
    const fm = parseReferenceFrontmatter(refBody);
    if (!fm.summary) {
      errors.push(`${entry.file}: ${fm.error}`);
      continue;
    }
    if (fm.error) errors.push(`${entry.file}: ${fm.error}`);
    if (fm.summary !== entry.summary) {
      errors.push(
        `${entry.file}: frontmatter summary does not match index.\n  index:   "${entry.summary}"\n  frontmatter: "${fm.summary}"`,
      );
    }
  }

  // Orphan check — every file under references/ or examples/ must be listed
  for (const dir of [refsDir, examplesDir]) {
    if (!fs.existsSync(dir)) continue;
    const relDir = path.basename(dir);
    // Walk one level deep (and one level of nesting for grouped refs)
    const walk = (d, prefix = relDir) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const sub = path.join(d, ent.name);
        const relPath = `${prefix}/${ent.name}`;
        if (ent.isDirectory()) walk(sub, relPath);
        else if (ent.name.endsWith('.md') && !listedFiles.has(relPath)) {
          errors.push(`Orphan file: "${relPath}" exists but is not listed in the reference table`);
        }
      }
    };
    walk(dir);
  }

  return { skillName, ok: errors.length === 0, errors, entries: table.entries };
}
