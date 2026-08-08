/**
 * @fileoverview Parser for the "Acceptance Criteria" section of a /plan
 * plan. Extracts structured criteria so /ux-lock verify can generate one
 * Playwright test case per criterion.
 *
 * Format parsed:
 *   ### 10. Acceptance Criteria (Playwright-verifiable)
 *   - [P0] [visibility] Cellar grid is visible after login
 *     - Setup: login → navigate to /cellar
 *     - Assert: getByRole('grid', { name: /cellar/i }) is visible
 *   - [P1] [a11y] No WCAG AA violations on grid
 *     - Setup: ...
 *     - Assert: ...
 *
 * Rules:
 *   - Section is detected by a heading containing "Acceptance Criteria"
 *     (tolerant of numbered prefixes and casing).
 *   - Each criterion is a top-level bullet starting with `[SEVERITY]` (P0-P3).
 *   - Severity + category tags are required; description is the text that follows.
 *   - Setup/Assert are optional nested bullets; when missing, the description
 *     itself is treated as the assertion hint.
 *
 * This is a deterministic regex-based parser — the spec-generation step
 * (LLM-driven inside the skill) handles translating the text into Playwright code.
 * @module lib/plan-criteria-parser
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VALID_SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const VALID_CATEGORIES = new Set([
  'visibility', 'interaction', 'a11y', 'state', 'responsive', 'text', 'navigation', 'other',
]);

const HEADING_RE = /^#{2,4}\s*(?:\d+\.\s*)?acceptance\s+criteria/i;
// Loose match — severity and category are validated after extraction so malformed
// entries surface as errors rather than silently disappearing.
// Anchored at column 0 — a criterion is a TOP-LEVEL bullet, as the module
// docblock states. The old `^\s*` also matched INDENTED bullets, and because
// the criterion branch is tested before the nested Setup/Assert branch, a
// nested `- [P1] …` line was promoted to a standalone criterion of its own.
const CRITERION_RE = /^[-*]\s*\[([A-Za-z0-9]+)\]\s*\[([A-Za-z0-9_-]+)\]\s*(.+?)\s*$/;

// A bullet that OPENS like a criterion (`- [` …) but does not parse as one.
// Such a line is a malformed criterion, not prose, and must surface as an
// error: silently skipping it drops a criterion from the verify run while the
// run still reports success over the ones that parsed.
//
// Deliberately NOT anchored to column 0, unlike CRITERION_RE. An INDENTED
// criterion-shaped bullet is the ambiguous case — CommonMark allows a
// top-level list item up to 3 leading spaces, while this format uses
// indentation for the nested Setup/Assert lines. Rather than guess which the
// author meant, the parser refuses to promote it (that was the original bug)
// AND refuses to swallow it: it reports the line so the author can fix the
// indentation. Nested Setup/Assert lines never reach here — NESTED_RE consumes
// them first.
const CRITERION_SHAPED_RE = /^\s*[-*]\s*\[/;
const NESTED_RE = /^\s+[-*]\s*(setup|assert)\s*:\s*(.+?)\s*$/i;

/**
 * Stable hash for a criterion — matches the DB `criterion_hash` column so
 * per-criterion history can be tracked across verify runs.
 */
export function criterionHash({ severity, category, description }) {
  const norm = `${severity.toUpperCase()}|${category.toLowerCase()}|${description.trim()}`;
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/**
 * Locate the Acceptance Criteria section of a plan markdown body. Returns the
 * slice of lines from the heading to the next heading-of-equal-or-higher level.
 * @param {string} markdown — full plan file contents
 * @returns {{ headingIndex: number, lines: string[] } | null}
 */
export function locateAcceptanceSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{2,4})\s+/.exec(lines[i]);
    if (!m) continue;
    if (HEADING_RE.test(lines[i])) {
      start = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (start === -1) return null;

  // Terminator scans levels 1-6, not 2-4. A level-1 heading is HIGHER than any
  // supported Acceptance Criteria heading, so it must end the section — under
  // the old `#{2,4}` it did not, and every bullet after it (a whole other
  // document) was parsed as acceptance criteria. The `<= startLevel` test still
  // keeps deeper subsections inside.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= startLevel) { end = i; break; }
  }
  return { headingIndex: start, lines: lines.slice(start + 1, end) };
}

/**
 * Parse criteria from the Acceptance Criteria section.
 * @param {string} markdown
 * @returns {{
 *   criteria: Array<{
 *     index: number,
 *     severity: 'P0'|'P1'|'P2'|'P3',
 *     category: string,
 *     description: string,
 *     setup: string|null,
 *     assertion: string|null,
 *     hash: string,
 *   }>,
 *   errors: string[],
 *   found: boolean,
 * }}
 */
export function parseAcceptanceCriteria(markdown) {
  const section = locateAcceptanceSection(markdown);
  if (!section) {
    return { criteria: [], errors: ['Acceptance Criteria section not found'], found: false };
  }

  const criteria = [];
  const errors = [];
  let current = null;
  let index = 0;

  for (const rawLine of section.lines) {
    const line = rawLine.replaceAll('\u2192', '->');  // → to plain arrow for assertion text
    if (!line.trim()) continue;

    const topMatch = CRITERION_RE.exec(line);
    if (topMatch) {
      if (current) criteria.push(current);
      const [, sevRaw, catRaw, desc] = topMatch;
      const severity = sevRaw.toUpperCase();
      const category = catRaw.toLowerCase();
      if (!VALID_SEVERITIES.has(severity)) {
        errors.push(`Invalid severity "${sevRaw}" in: ${line.trim()}`);
        current = null;
        continue;
      }
      if (!VALID_CATEGORIES.has(category)) {
        errors.push(`Invalid category "${catRaw}" in: ${line.trim()} — valid: ${[...VALID_CATEGORIES].join(',')}`);
        current = null;
        continue;
      }
      const description = desc.trim();
      current = {
        index: index++,
        severity, category, description,
        setup: null,
        assertion: null,
        hash: criterionHash({ severity, category, description }),
      };
      continue;
    }

    const nestedMatch = NESTED_RE.exec(line);
    if (nestedMatch && current) {
      const [, kind, text] = nestedMatch;
      if (kind.toLowerCase() === 'setup') current.setup = text.trim();
      else current.assertion = text.trim();
      continue;
    }

    // A top-level bullet that LOOKS like a criterion but did not parse is a
    // malformed criterion, not prose. Report it — the caller stops on
    // `errors.length > 0`, and a silently-dropped criterion is one the verify
    // run never checks while still reporting on the ones that parsed.
    if (CRITERION_SHAPED_RE.test(line)) {
      const indented = /^\s/.test(line);
      errors.push(
        indented
          ? `Indented criterion-shaped bullet — criteria must start at column 0 (nested bullets are `
            + `Setup:/Assert: only). Fix the indentation in: ${line.trim()}`
          : `Malformed criterion (expected \`- [P0] [category] description\`) in: ${line.trim()}`,
      );
      // Finalize and CLEAR the pending criterion, exactly as the invalid-
      // severity/category branches do. Without the clear, the malformed
      // criterion's own `Setup:`/`Assert:` sub-bullets match NESTED_RE on the
      // following lines and attach to the PREVIOUS valid criterion — silently
      // giving it another criterion's setup and assertion. Caught by the Gemini
      // final gate 2026-08-08 and reproduced: P0's setup became "belongs to the
      // MALFORMED one".
      if (current) criteria.push(current);
      current = null;
      continue;
    }
    // Anything else is ignored — tolerant to prose between criteria.
  }
  if (current) criteria.push(current);

  if (criteria.length === 0) {
    errors.push('Acceptance Criteria section found but no valid criteria parsed');
  }
  return { criteria, errors, found: true };
}

/**
 * Summarise criteria for reporting.
 * @param {ReturnType<typeof parseAcceptanceCriteria>['criteria']} criteria
 */
export function summariseCriteria(criteria) {
  const bySev = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const byCat = {};
  for (const c of criteria) {
    bySev[c.severity]++;
    byCat[c.category] = (byCat[c.category] || 0) + 1;
  }
  return { total: criteria.length, bySeverity: bySev, byCategory: byCat };
}

// ── CLI: /ux-lock verify Step 1 — parse a plan's Acceptance Criteria ───────
//
// A real CLI rather than a `node --input-type=module -e "import { … } from
// './scripts/lib/plan-criteria-parser.mjs'"` snippet: that module specifier is
// invisible to the consumer sync's command rewriter (which only relocates
// `node scripts/<path>`), so the documented step could not run in a consumer
// repo, where the bundle lives under `scripts/.claude-skills/`. Same class
// reported 2026-08-08 for /plan's Gate-1 self-check; guarded by
// tests/skill-command-portability.test.mjs.
//
// Exit 0 = parsed (read `found`/`errors` from the JSON, which is the real
// verdict); exit 1 = the plan file could not be read.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const planFile = process.argv[2];
  if (!planFile) {
    process.stderr.write('Usage: node scripts/lib/plan-criteria-parser.mjs <plan-file.md>\n');
    process.exit(1);
  }
  let markdown;
  try {
    markdown = fs.readFileSync(path.resolve(planFile), 'utf-8');
  } catch (err) {
    process.stderr.write(`Error: cannot read ${planFile} — ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(parseAcceptanceCriteria(markdown), null, 2)}\n`);
}
