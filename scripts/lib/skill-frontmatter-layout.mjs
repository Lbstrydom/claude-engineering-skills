/**
 * @fileoverview SKILL.md frontmatter LAYOUT lint — a known top-level key that is
 * indented under a block scalar is not a key. It is description TEXT.
 *
 * WHY THIS EXISTS (measured 2026-09-03 in a consumer). A `SKILL.md` carried
 * `  disable-model-invocation: true` two spaces deep, inside `description: |`.
 * YAML parsed it as the last line of the description, so the skill declared it
 * must never be self-invoked while remaining fully model-invocable. The host's
 * skill listing showed the literal string trailing the description; the three
 * skills whose flag sat at column 0 were absent from that listing — the flag
 * working. The broken and fixed forms differ only by leading whitespace, and
 * the broken form does not error: it just quietly stops applying.
 *
 * Silent by construction, in BOTH directions:
 *   - `disable-model-invocation` — a self-invoked /ship "cites its own execution
 *     as consent" (ship/SKILL.md). Blast radius spans hosts: VS Code Copilot
 *     reads `.claude/skills/` and honours this exact key.
 *   - `allowed-tools`, `model`, `argument-hint`, `user-invocable`, `license` —
 *     the same shape, the same silence.
 *
 * TWO INSTRUMENTS, CROSS-CHECKED. A lexical scan finds an indented known key;
 * a real YAML parse (`yaml`) confirms the parser did NOT surface it at the top
 * level. A column-0 known key the parser does not surface is reported as
 * `instrument-disagreement` (fail closed — the lexer and the parser cannot both
 * be right, and a lint that trusts one of them silently is the defect it hunts).
 * A flag key whose parsed value is not a boolean (`"true"`, `yes` under YAML
 * 1.2 core, `1`) is the same silent class and is reported as `non-boolean-flag`.
 *
 * Shared by three enforcement points, so it lives in `lib/`:
 *   1. `check-skill-frontmatter.mjs`   — source-repo gate in `skills:check`.
 *   2. `sync-to-repos.mjs`             — refuses to deploy a bundle carrying one.
 *   3. `sync-isolation-verify` gate 9  — consumer-side, continuous, via doctor.
 * (3) is SYNCED and may only import its own `lib/` siblings — the same reason
 * `skill-surface-identity.mjs` is a library (one rule, three call sites).
 *
 * @module scripts/lib/skill-frontmatter-layout
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

/**
 * Keys a host reads ONLY at the top level of SKILL.md frontmatter. `name` and
 * `description` are deliberately absent: they are required, and a missing one
 * is already loud (`skills-index.mjs` reports `invalid-frontmatter`;
 * `check-skill-descriptions.mjs` fails). The keys here are the OPTIONAL ones —
 * absent is a valid state, which is exactly what makes a misplaced one silent.
 */
export const KNOWN_TOP_LEVEL_KEYS = Object.freeze([
  'disable-model-invocation',
  'allowed-tools',
  'license',
  'model',
  'argument-hint',
  'user-invocable',
]);

/** Of those, the ones whose only meaningful value is a YAML boolean. */
export const BOOLEAN_FLAG_KEYS = Object.freeze(['disable-model-invocation', 'user-invocable']);

/** Finding kinds, closed. Every consumer switches on these strings. */
export const FINDING_KINDS = Object.freeze([
  'no-frontmatter',
  'unparseable-yaml',
  'indented-known-key',
  'non-boolean-flag',
  'instrument-disagreement',
]);

/**
 * The frontmatter block of a markdown file: the lines strictly between the
 * opening `---` (line 1) and the first closing `---` on its own line.
 *
 * CRLF is folded to LF and a BOM stripped first, so a file authored on Windows
 * lints the same as one authored on Unix — the same fold `skills-index.mjs`
 * applies before ITS regex.
 *
 * @param {string} raw
 * @returns {{lines: string[], firstLine: number}|null}
 *   `firstLine` is the 1-based FILE line number of `lines[0]`, so a finding can
 *   name the line an editor will jump to. Null when there is no frontmatter.
 */
export function extractFrontmatterLines(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const all = text.split('\n');
  if (all[0] !== '---') return null;
  for (let i = 1; i < all.length; i++) {
    if (/^---\s*$/.test(all[i])) return { lines: all.slice(1, i), firstLine: 2 };
  }
  return null;
}

const INDENTED_KEY_RE = /^(\s+)([A-Za-z][\w-]*)\s*:(?:\s|$)/;
const TOP_LEVEL_KEY_RE = /^([A-Za-z][\w-]*)\s*:(?:\s|$)/;

/**
 * Lint one SKILL.md's frontmatter layout.
 *
 * @param {string} raw full file text
 * @param {{file?: string, knownKeys?: readonly string[]}} [opts]
 * @returns {{
 *   ok: boolean,
 *   file: string,
 *   findings: Array<{kind: string, key: string|null, line: number|null, text: string|null, message: string}>,
 *   parsed: Record<string, unknown>|null,
 *   topLevelKnownKeys: string[],
 * }}
 *   `topLevelKnownKeys` is what the PARSER surfaced at the top level — the
 *   positive-control channel: a caller asserting a flag is live reads it from
 *   here, never from the raw text.
 */
export function lintSkillFrontmatterLayout(raw, { file = '<memory>', knownKeys = KNOWN_TOP_LEVEL_KEYS } = {}) {
  const known = new Set(knownKeys);
  const findings = [];
  const fm = extractFrontmatterLines(raw);
  if (!fm) {
    findings.push({
      kind: 'no-frontmatter', key: null, line: null, text: null,
      message: `${file}: no YAML frontmatter block — layout cannot be verified (a SKILL.md without one declares nothing)`,
    });
    return { ok: false, file, findings, parsed: null, topLevelKnownKeys: [] };
  }

  let parsed = null;
  try {
    const doc = yaml.parse(fm.lines.join('\n'));
    parsed = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch (err) {
    findings.push({
      kind: 'unparseable-yaml', key: null, line: null, text: null,
      message: `${file}: frontmatter is not parseable YAML — ${err.message}`,
    });
    return { ok: false, file, findings, parsed: null, topLevelKnownKeys: [] };
  }

  // Instrument 1 — lexical. A known key at column >0 is never a key.
  const lexicalTop = new Set();
  for (let i = 0; i < fm.lines.length; i++) {
    const line = fm.lines[i];
    const fileLine = fm.firstLine + i;
    const indented = INDENTED_KEY_RE.exec(line);
    if (indented && known.has(indented[2])) {
      const key = indented[2];
      findings.push({
        kind: 'indented-known-key', key, line: fileLine, text: line,
        message: `${file}:${fileLine} — \`${key}:\` is indented under a block scalar, so YAML parsed it as ` +
          `${'description' in parsed ? 'description TEXT' : 'text'}, not as a frontmatter key; ` +
          'the declaration is INERT. Dedent it to column 0.',
      });
      continue;
    }
    const top = TOP_LEVEL_KEY_RE.exec(line);
    if (top && known.has(top[1])) lexicalTop.add(top[1]);
  }

  // Instrument 2 — the parser. What it surfaced at the top level is the truth
  // a host acts on; the lexer's column-0 set must agree with it, or the lint
  // is reading a different document from the one the host reads.
  const topLevelKnownKeys = knownKeys.filter((k) => Object.prototype.hasOwnProperty.call(parsed, k));
  for (const key of lexicalTop) {
    if (!topLevelKnownKeys.includes(key)) {
      findings.push({
        kind: 'instrument-disagreement', key, line: null, text: null,
        message: `${file}: \`${key}:\` appears at column 0 but the YAML parser did not surface it as a top-level key — ` +
          'the lexical scan and the parser disagree; refusing to report clean',
      });
    }
  }
  for (const key of topLevelKnownKeys) {
    if (BOOLEAN_FLAG_KEYS.includes(key) && typeof parsed[key] !== 'boolean') {
      findings.push({
        kind: 'non-boolean-flag', key, line: null, text: null,
        message: `${file}: \`${key}:\` is at the top level but its value is ${JSON.stringify(parsed[key])} ` +
          `(${typeof parsed[key]}), not a YAML boolean — hosts compare against \`true\`, so this is INERT too`,
      });
    }
  }

  return { ok: findings.length === 0, file, findings, parsed, topLevelKnownKeys };
}

/**
 * Lint every `<root>/<name>/SKILL.md`.
 *
 * Zero skills is NOT ok: a tree with nothing in it has verified nothing, and a
 * caller that treats that as clean is the sandbox-honesty failure AGENTS.md
 * names. `reason: 'no-skills'` says so distinctly from "skills found, all clean".
 *
 * @param {string} root
 * @param {{knownKeys?: readonly string[]}} [opts]
 * @returns {{
 *   ok: boolean, root: string, reason: 'no-skills'|'unreadable'|null, error?: string,
 *   skills: Array<{name: string, file: string, result: ReturnType<typeof lintSkillFrontmatterLayout>}>,
 *   findings: Array<{name: string} & ReturnType<typeof lintSkillFrontmatterLayout>['findings'][number]>,
 * }}
 */
export function lintSkillTree(root, opts = {}) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return { ok: false, root, reason: 'unreadable', error: `${err.code || ''} ${err.message}`.trim(), skills: [], findings: [] };
  }
  const skills = [];
  const findings = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    const file = path.join(root, name, 'SKILL.md');
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); }
    catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue; // a directory that is not a skill
      const result = {
        ok: false, file, parsed: null, topLevelKnownKeys: [],
        findings: [{ kind: 'unparseable-yaml', key: null, line: null, text: null, message: `${file}: unreadable — ${err.message}` }],
      };
      skills.push({ name, file, result });
      for (const f of result.findings) findings.push({ name, ...f });
      continue;
    }
    const result = lintSkillFrontmatterLayout(raw, { file: path.relative(root, file).split(path.sep).join('/'), ...opts });
    skills.push({ name, file, result });
    for (const f of result.findings) findings.push({ name, ...f });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length === 0) return { ok: false, root, reason: 'no-skills', skills, findings };
  return { ok: findings.length === 0, root, reason: null, skills, findings };
}
