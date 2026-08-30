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
import { pathToFileURL } from 'node:url';
import { ArgvError } from './lib/cli-io.mjs';
import { loadAllSkills, resolveSkillsRoot, SKILL_ROOT_CANDIDATES } from './lib/skills-index.mjs';
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

function renderCompactMd(skills, root = resolveSkillsRoot()) {
  if (skills.length === 0) {
    // Name the root ACTUALLY searched, and distinguish "looked and found
    // nothing" from "there was nowhere to look". The old text hardcoded
    // `skills/`, so a wrong-place read rendered as an empty repo — in a
    // consumer, which carries only `.claude/skills/`, that was 67 tracked
    // skill files reported as none (upstream report 5b67f273).
    if (root.origin === 'none') {
      const looked = SKILL_ROOT_CANDIDATES.map((c) => `\`${c}/\``).join(' and ');
      return `_No skills directory here — looked for ${looked}._\n`;
    }
    const searched = root.origin === 'authoring' ? SKILL_ROOT_CANDIDATES[0] : SKILL_ROOT_CANDIDATES[1];
    return `_No skills found in \`${searched}/\`._\n`;
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
