/**
 * @fileoverview The skills inventory — `skills/<name>/SKILL.md` frontmatter parsed into
 * structured records. Answers ONE question: *what skills exist, and what do they do?*
 *
 * **Why this is not in `scripts/skills-help.mjs`.** It used to be. That module is a
 * CLI entry point, and `scripts/lib/dashboard/collect-reference.mjs` imported it as a
 * library — a `dashboard -> scripts` edge that was the SOLE reason
 * `allowedDeps.dashboard` had to grant the whole root-scripts domain. Extracting the
 * two pure functions here (`shared-lib`) let that grant be deleted outright.
 * Plan: docs/plans/dashboard-skills-index-layering.md (L5 of the layering series).
 *
 * **Deliberately NOT merged into `skill-refs-parser.mjs`** — that parses the
 * `## Reference files` *table* and reference-file frontmatter for the skills:check
 * lint. Different input, different consumer, different question.
 *
 * **cwd contract (load-bearing).** `loadAllSkills` resolves its skills directory
 * relative to `process.cwd()` when the caller passes none, and `parseSkill` returns a
 * `process.cwd()`-relative `path` that the dashboard RENDERS. A caller not guaranteed
 * to run from the repo root must pass an explicit directory. Making the root a
 * required parameter would change that rendered field — see the named assumption and
 * its revisit trigger in the plan’s §4.
 *
 * @module scripts/lib/skills-index
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

/**
 * Load a single SKILL.md file and parse its frontmatter into a structured
 * record. Returns null if no frontmatter is present or the file is unreadable
 * (so the caller can skip it gracefully rather than aborting the whole scan).
 */
export function parseSkill(skillFile) {
  let raw;
  try { raw = fs.readFileSync(skillFile, 'utf-8'); }
  catch { return null; }

  // Normalise CRLF → LF before matching so the same regex works whether the
  // file was authored on Windows or Unix.
  raw = raw.replace(/\r\n/g, '\n').replace(/^﻿/, '');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;

  let fm;
  try { fm = yaml.parse(m[1]); }
  catch { return null; }

  // `name` must be a STRING, not merely truthy. YAML happily produces a number
  // (`name: 123`), boolean (`name: true`) or map (`name: {value: foo}`), and a
  // truthy-only check let those through — then loadAllSkills' sort threw
  // `a.name.localeCompare is not a function`, aborting the WHOLE scan. That
  // contradicts this function's own contract two lines up ("so the caller can
  // skip it gracefully rather than aborting the whole scan"), and in the
  // dashboard it surfaced as an empty skills section, not an error.
  if (!fm || typeof fm.name !== 'string' || !fm.name || typeof fm.description !== 'string') return null;

  // Extract structured pieces from the description text. Frontmatter
  // descriptions in this repo follow a stable shape:
  //   <one or two summary sentences>
  //   Triggers on: "x", "y", "z"
  //   Usage: /name <args>      — what it does
  //          /name <other>     — what else
  const desc = fm.description.trim();
  const lines = desc.split('\n').map(l => l.trim());

  // First non-empty line up to first "Triggers on:"/"Usage:" is the one-liner
  const summaryLines = [];
  for (const line of lines) {
    if (/^triggers? on:/i.test(line) || /^usage:/i.test(line)) break;
    if (line.length > 0) summaryLines.push(line);
  }
  const oneLiner = summaryLines.join(' ').replace(/\s+/g, ' ').trim();
  // First sentence only (everything up to the first period followed by space-or-end)
  const firstSentence = oneLiner.split(/\.\s|\.$/)[0].trim() + (oneLiner.includes('.') ? '.' : '');

  // Triggers: the line(s) starting with "Triggers on:"
  const triggers = [];
  const triggerLineRe = /^triggers? on:\s*(.*)$/i;
  let inTriggers = false;
  for (const line of lines) {
    const m2 = line.match(triggerLineRe);
    if (m2) { inTriggers = true; triggers.push(m2[1]); continue; }
    if (inTriggers) {
      if (/^usage:/i.test(line)) { inTriggers = false; continue; }
      if (line.length === 0) { inTriggers = false; continue; }
      // A trigger continuation line is a quoted-comma list. A line with no
      // quote (e.g. "IMPORTANT: …" boilerplate) is NOT a trigger — stop
      // capture so it doesn't become a giant malformed trigger chip.
      if (!line.includes('"')) { inTriggers = false; continue; }
      triggers.push(line);
    }
  }
  // Flatten quoted-comma trigger lists: '"x", "y", "z"' → ['x', 'y', 'z']
  const flatTriggers = triggers
    .join(' ')
    .replace(/^"|"$/g, '')
    .split(/"\s*,\s*"/)
    .map(t => t.replace(/^["\s]+|["\s.]+$/g, ''))
    .filter(Boolean);

  // Usage lines: capture everything after "Usage:" up to next blank/section
  const usage = [];
  let inUsage = false;
  for (const line of lines) {
    if (/^usage:/i.test(line)) {
      inUsage = true;
      const tail = line.replace(/^usage:\s*/i, '').trim();
      if (tail) usage.push(tail);
      continue;
    }
    if (inUsage) {
      if (line.length === 0) { inUsage = false; continue; }
      // Stop on a new top-level field cue — "Examples:" or "Triggers on:"
      // (a Usage block before the triggers must not swallow them).
      if (/^examples?:/i.test(line)) { inUsage = false; continue; }
      if (/^triggers? on:/i.test(line)) { inUsage = false; continue; }
      usage.push(line);
    }
  }

  // Fallback: skills whose Usage/Examples were relocated out of the (≤1024-char
  // Copilot-capped) frontmatter description into a `## Usage` body section
  // (2026-07-21). Scan the markdown body after the frontmatter for that
  // section's fenced block. Skip fences and any stray "Triggers on:" line the
  // relocated tail may carry (triggers already parsed from the description).
  if (usage.length === 0) {
    const body = raw.slice(m[0].length);
    const section = body.match(/^##\s+Usage\b[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
    if (section) {
      // Prefer the fenced block so trailing prose after the fence isn't captured;
      // fall back to the raw section for a non-fenced `## Usage`.
      const fence = section[1].match(/```[^\n]*\n([\s\S]*?)```/);
      const src = fence ? fence[1] : section[1];
      let inTrig = false;
      for (const rawLine of src.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('```')) continue;
        if (/^triggers? on:/i.test(line)) { inTrig = true; continue; }
        if (inTrig) { if (!line.includes('"')) inTrig = false; else continue; }
        usage.push(line.replace(/^usage:\s*/i, ''));
      }
    }
  }

  return {
    name: fm.name,
    oneLiner: firstSentence || (lines[0] || '').slice(0, 200),
    fullDescription: desc,
    triggers: flatTriggers,
    usage,
    disableModelInvocation: fm['disable-model-invocation'] === true,
    path: path.relative(process.cwd(), skillFile).replace(/\\/g, '/'),
  };
}

/**
 * Scan all skills/* directories for SKILL.md files. Returns sorted by name.
 * Excludes the .claude/skills/ mirror (regenerated, not authoritative).
 */
export function loadAllSkills(skillsRoot = 'skills') {
  const root = path.resolve(skillsRoot);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const parsed = parseSkill(skillFile);
    if (parsed) out.push(parsed);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
