#!/usr/bin/env node
/**
 * @fileoverview CLI lint over the SKILL.md `description` — the surface that
 * decides whether a skill is ever selected. Two checks:
 *   - the 1024-char Copilot budget AGENTS.md already claimed was enforced;
 *   - no two skills advertising the same literal trigger phrase (a shared
 *     phrase is a coin-flip at selection time the author never observes).
 *
 * Scope, rationale and the MEASURED limits are in
 * `scripts/lib/skill-description-lint.mjs` — read that before extending this to
 * fuzzy phrase matching (it was measured and rejected: 47 noise pairs).
 *
 * Takes no flags, so `cli:flags:gate` has nothing to guard.
 *
 * Third check (scripts/lib/skill-reserved-names.mjs): no skill may carry a
 * name the host reserves for a built-in (`ship`, `ship-local`, `steward`):
 * Claude Code 2.1.330 does not load it, and `steward` would land at the path
 * the built-in watch reads as instructions. `ship` is a declared exception.
 *
 * Usage:
 *   node scripts/check-skill-descriptions.mjs
 *
 * Exit codes:
 *   0 = every description within budget and no literal collisions
 *   1 = a description over budget or unparseable, OR a phrase claimed by two
 *       or more skills, OR a skill declares `Triggers on:` but no phrase parsed
 *       (parser regression — refusing to report clean beats reporting clean
 *       having compared nothing)
 *   2 = no skills found / bad CLI input
 *
 * @module scripts/check-skill-descriptions
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import {
  findTriggerCollisions, checkDescriptionBudget, DESCRIPTION_MAX_CHARS,
} from './lib/skill-description-lint.mjs';
import { findReservedNameCollisions } from './lib/skill-reserved-names.mjs';

const KNOWN_FLAGS = ['--selfcheck-relocation'];

const SKILLS_DIR = path.resolve('skills');
const G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m', B = '\x1b[1m';

function main(argv) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'check-skill-descriptions', from: 0 });
  } catch (err) {
    if (!(err instanceof ArgvError)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  if (argv.length > 0) {
    process.stderr.write('check-skill-descriptions takes no positional arguments\n');
    process.exit(2);
  }
  if (!fs.existsSync(SKILLS_DIR)) {
    process.stderr.write(`no skills directory at ${SKILLS_DIR}\n`);
    process.exit(2);
  }

  const names = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md')))
    .sort();

  if (names.length === 0) {
    process.stderr.write('no skills found\n');
    process.exit(2);
  }

  const byName = {};
  for (const n of names) {
    byName[n] = fs.readFileSync(path.join(SKILLS_DIR, n, 'SKILL.md'), 'utf-8');
  }

  const { collisions, counts, emptyDeclared } = findTriggerCollisions(byName);
  const { over, missing } = checkDescriptionBudget(byName);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (missing.length > 0) {
    process.stderr.write(`${R}skill-descriptions: FAILED${X} — no parseable description block\n`);
    for (const s of missing) {
      process.stderr.write(`  [${s}] frontmatter has no \`description: |\` block\n`);
    }
    process.exit(1);
  }

  if (over.length > 0) {
    process.stderr.write(`${R}skill-descriptions: FAILED${X} — over the ${DESCRIPTION_MAX_CHARS}-char budget\n`);
    for (const o of over) {
      process.stderr.write(`  [${o.skill}] ${o.length} chars (+${o.length - DESCRIPTION_MAX_CHARS})\n`);
    }
    process.stderr.write(
      '\n  Copilot rejects an over-length description, so the skill silently\n'
      + '  stops being selectable. Keep the trigger phrases; move Usage and\n'
      + '  Examples syntax down into the SKILL.md body.\n',
    );
    process.exit(1);
  }

  if (emptyDeclared.length > 0) {
    process.stderr.write(`${R}skill-descriptions: FAILED${X} — triggers declared but unparseable\n`);
    for (const s of emptyDeclared) {
      process.stderr.write(`  [${s}] has a "Triggers on:" run but no phrase parsed — parser regression\n`);
    }
    process.exit(1);
  }

  if (collisions.length > 0) {
    process.stderr.write(`${R}skill-descriptions: FAILED${X} — trigger collision\n`);
    for (const c of collisions) {
      process.stderr.write(`  ${B}"${c.phrase}"${X} claimed by: ${c.skills.join(', ')}\n`);
    }
    process.stderr.write(
      '\n  Two skills advertising one phrase is a coin-flip at selection time.\n'
      + '  Give the phrase to ONE skill and state the discriminator in both\n'
      + '  descriptions, so a reader can tell which to reach for.\n',
    );
    process.exit(1);
  }

  const reservedNames = findReservedNameCollisions(byName);
  if (reservedNames.violations.length > 0 || reservedNames.staleExceptions.length > 0
      || reservedNames.unreadable.length > 0) {
    process.stderr.write(`${R}skill-descriptions: FAILED${X} — host-reserved skill name\n`);
    for (const u of reservedNames.unreadable) {
      process.stderr.write(`  [${u.skill}] name could not be read (${u.error}) — refusing to report it clean\n`);
    }
    for (const v of reservedNames.violations) {
      process.stderr.write(`  [${v.skill}] uses "${v.name}", reserved by Claude Code's built-in /ship and /steward\n`);
    }
    for (const k of reservedNames.staleExceptions) {
      process.stderr.write(`  KNOWN_RESERVED_COLLISIONS has "${k}" but no skill uses it — delete the stale exception\n`);
    }
    process.stderr.write(
      '\n  Claude Code 2.1.330+ does not load a skill with this name, and a skill\n'
      + "  named steward would be read as the watch's instructions. Pick another\n"
      + '  name. See docs/reference/skill-surface-ownership.md §Host-reserved names.\n',
    );
    process.exit(1);
  }
  for (const t of reservedNames.tolerated) {
    process.stderr.write(`  note: [${t.skill}] "${t.name}" is a declared host-reserved collision — ${t.reason}\n`);
  }

  process.stdout.write(
    `${G}skill-descriptions: clean${X} — ${names.length} skill(s), all within `
    + `${DESCRIPTION_MAX_CHARS} chars; ${total} trigger phrase(s), 0 shared\n`,
  );
  process.exit(0);
}

main(process.argv.slice(2));
