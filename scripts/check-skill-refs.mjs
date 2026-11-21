#!/usr/bin/env node
/**
 * @fileoverview CLI lint for skill reference-file discipline.
 *
 * For every skill under `skills/<name>/`:
 *   - If SKILL.md has a "## Reference files" section, parse it and enforce
 *     file existence + frontmatter summary exact-match.
 *   - If no section, ensure `references/` + `examples/` dirs are empty/absent.
 *   - Report orphan files not listed in the table.
 *
 * Usage:
 *   node scripts/check-skill-refs.mjs              # lint all skills
 *   node scripts/check-skill-refs.mjs <skill-name> # lint one skill
 *
 * Exit codes:
 *   0 = all skills lint clean
 *   1 = at least one skill has lint violations
 *   2 = no skills found / bad CLI input
 *
 * @module scripts/check-skill-refs
 */
import './lib/help-guard-run.mjs'; import fs from 'node:fs';
import path from 'node:path';
import { lintSkill } from './lib/skill-refs-parser.mjs';

const SKILLS_DIR = path.resolve('skills');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', X = '\x1b[0m', B = '\x1b[1m';

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function main() {
  const arg = process.argv[2];
  const skills = arg ? [arg] : listSkills();

  if (skills.length === 0) {
    process.stderr.write(`${R}No skills found in ${SKILLS_DIR}${X}\n`);
    process.exit(2);
  }

  let passed = 0, failed = 0;
  const failures = [];

  for (const name of skills) {
    const dir = path.join(SKILLS_DIR, name);
    if (!fs.existsSync(dir)) {
      process.stderr.write(`${R}Skill not found: ${name}${X}\n`);
      failed++;
      failures.push({ name, errors: ['skill directory does not exist'] });
      continue;
    }
    const result = lintSkill(dir);
    if (result.ok) {
      process.stdout.write(`${G}✓${X} ${name} ${result.entries.length ? `(${result.entries.length} refs)` : '(no refs)'}\n`);
      passed++;
    } else {
      process.stdout.write(`${R}✗${X} ${B}${name}${X}\n`);
      for (const err of result.errors) {
        process.stdout.write(`    ${Y}—${X} ${err.split('\n').join('\n      ')}\n`);
      }
      failed++;
      failures.push(result);
    }
  }

  process.stdout.write(`\n${B}check-skill-refs:${X} ${G}${passed} passed${X}, ${failed ? R : ''}${failed} failed${X}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
