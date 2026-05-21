#!/usr/bin/env node
/**
 * @fileoverview Skill quick-reference aggregator — reads `skills/*​/SKILL.md`
 * frontmatter and renders a compact reference, full per-skill detail, or a
 * search-filtered listing. Used by:
 *   - `/skills` skill (chat-rendered output via the helper's --md mode)
 *   - `npm run skills:index` (regenerates docs/SKILLS-INDEX.md)
 *   - direct CLI from a terminal
 *
 * Pure aggregator. No LLM calls, no writes by default (only with --out).
 *
 * Usage:
 *   node scripts/skills-help.mjs                      → compact list (markdown)
 *   node scripts/skills-help.mjs <skill>              → detail for one skill
 *   node scripts/skills-help.mjs --search "<term>"    → filter name+description
 *   node scripts/skills-help.mjs --json               → structured JSON
 *   node scripts/skills-help.mjs --out <path>         → write to file
 *
 * @module scripts/skills-help
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'yaml';
import { ArgvError } from './lib/cli-io.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';

const HELP_TEXT = `skills-help — quick reference for all available skills

USAGE
  node scripts/skills-help.mjs                  Compact list of all skills
  node scripts/skills-help.mjs <skill>          Full detail for one skill
  node scripts/skills-help.mjs --search <term>  Filter by name/description match
  node scripts/skills-help.mjs --json           Structured JSON
  node scripts/skills-help.mjs --md             Markdown output (default)
  node scripts/skills-help.mjs --out <path>     Write to file (e.g. for SKILLS-INDEX.md)

OUTPUT FORMATS
  Default: compact markdown table — one line per skill: /name + first sentence
  Detail (with <skill>): full description block + triggers + usage examples + path to SKILL.md
  JSON: { skills: [{name, oneLiner, triggers, usage, disableModelInvocation, path}] }

DISCOVERY
  Reads skills/*​/SKILL.md frontmatter (the canonical source). Skills mirrored
  to .claude/skills/ are ignored — that's the generated copy.
`;


function parseArgs(argv) {
  const args = { skill: null, search: null, format: 'md', out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new ArgvError(`Flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--search': args.search = next(); break;
      case '--json': args.format = 'json'; break;
      case '--md': args.format = 'md'; break;
      case '--out': args.out = next(); break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        if (a.startsWith('--')) throw new ArgvError(`Unknown flag: ${a}`);
        if (args.skill) throw new ArgvError(`Multiple skill names given (got "${args.skill}" then "${a}")`);
        args.skill = a;
    }
  }
  return args;
}

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

  if (!fm || !fm.name || typeof fm.description !== 'string') return null;

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

/**
 * Filter skills by a search term (case-insensitive substring match against
 * name + oneLiner + triggers).
 */
export function filterBySearch(skills, term) {
  if (!term) return skills;
  const needle = term.toLowerCase();
  return skills.filter(s => {
    if (s.name.toLowerCase().includes(needle)) return true;
    if (s.oneLiner.toLowerCase().includes(needle)) return true;
    if (s.triggers.some(t => t.toLowerCase().includes(needle))) return true;
    if (s.usage.some(u => u.toLowerCase().includes(needle))) return true;
    return false;
  });
}

// ── Renderers ───────────────────────────────────────────────────────────

function renderCompactMd(skills) {
  if (skills.length === 0) {
    return '_No skills found in `skills/`._\n';
  }
  const lines = [
    `# Available skills (${skills.length} total)`,
    '',
    'Run `node scripts/skills-help.mjs <name>` for detail on one skill,',
    'or `/skills <name>` from inside Claude.',
    '',
    '| Skill | One-liner |',
    '|---|---|',
  ];
  for (const s of skills) {
    const flag = s.disableModelInvocation ? ' 🔒' : '';
    lines.push(`| \`/${s.name}\`${flag} | ${escapePipe(s.oneLiner)} |`);
  }
  lines.push('');
  lines.push('🔒 = `disable-model-invocation: true` — skill must be invoked explicitly via `/<name>` (Claude will not auto-trigger it).');
  lines.push('');
  return lines.join('\n');
}

function renderDetailMd(skill) {
  const lines = [
    `# /${skill.name}${skill.disableModelInvocation ? ' 🔒' : ''}`,
    '',
    skill.oneLiner,
    '',
  ];
  if (skill.triggers.length > 0) {
    lines.push('**Triggers on:**');
    for (const t of skill.triggers) lines.push(`- ${t}`);
    lines.push('');
  }
  if (skill.usage.length > 0) {
    lines.push('**Usage:**');
    lines.push('```');
    for (const u of skill.usage) lines.push(u);
    lines.push('```');
    lines.push('');
  }
  if (skill.disableModelInvocation) {
    lines.push('🔒 **Manual invocation only** — Claude will not auto-trigger this skill; you must type `/' + skill.name + '` explicitly.');
    lines.push('');
  }
  lines.push(`**Full SKILL.md:** \`${skill.path}\``);
  lines.push('');
  return lines.join('\n');
}

function escapePipe(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderJson(skillsOrSkill) {
  if (Array.isArray(skillsOrSkill)) return JSON.stringify({ skills: skillsOrSkill }, null, 2);
  return JSON.stringify(skillsOrSkill, null, 2);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  assertRepoRoot(import.meta.url);
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) {
    if (err.code === 'ARGV_ERROR') {
      process.stderr.write(`Error: ${err.message}\n\n${HELP_TEXT}`);
      process.exit(1);
    }
    throw err;
  }
  if (args.help) { process.stdout.write(HELP_TEXT); process.exit(0); }

  const all = loadAllSkills();

  let output;
  if (args.skill) {
    // Detail mode
    const found = all.find(s => s.name === args.skill);
    if (!found) {
      const candidates = all.map(s => s.name).filter(n => n.includes(args.skill)).slice(0, 5);
      process.stderr.write(`Error: skill "${args.skill}" not found.\n`);
      if (candidates.length > 0) process.stderr.write(`Did you mean: ${candidates.map(c => `/${c}`).join(', ')}?\n`);
      process.exit(1);
    }
    output = args.format === 'json' ? renderJson(found) : renderDetailMd(found);
  } else if (args.search) {
    const filtered = filterBySearch(all, args.search);
    output = args.format === 'json'
      ? renderJson(filtered)
      : `_Filtered by search: "${args.search}" — ${filtered.length} of ${all.length} skills_\n\n${renderCompactMd(filtered)}`;
  } else {
    output = args.format === 'json' ? renderJson(all) : renderCompactMd(all);
  }

  if (args.out) {
    fs.writeFileSync(args.out, output);
    process.stderr.write(`  [skills-help] Wrote ${args.out}\n`);
  } else {
    process.stdout.write(output);
    if (!output.endsWith('\n')) process.stdout.write('\n');
  }
  process.exit(0);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  main().catch(err => {
    process.stderr.write(`  [skills-help] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}

// Internal exports for tests
export const __test__ = { parseArgs, renderCompactMd, renderDetailMd, renderJson, escapePipe };
// Suppress unused-import warning in some toolchains
void fileURLToPath;
