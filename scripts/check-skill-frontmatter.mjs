#!/usr/bin/env node
/**
 * @fileoverview CLI gate over SKILL.md frontmatter LAYOUT: every known
 * top-level key (`disable-model-invocation`, `allowed-tools`, `license`,
 * `model`, `argument-hint`, `user-invocable`) must sit at column 0. Indented
 * under `description: |` it is description TEXT — parsed, valid, and inert.
 *
 * The rule, the two cross-checked instruments and the incident that produced
 * them are in `scripts/lib/skill-frontmatter-layout.mjs` — this file is the
 * source-repo runner in `skills:check`. The same library backs
 * `sync-to-repos.mjs` (refuses to deploy a bundle carrying one) and
 * `sync-isolation-verify` gate 9 (consumer-side, continuous, via `doctor`).
 *
 * Usage:
 *   node scripts/check-skill-frontmatter.mjs                 # lint skills/
 *   node scripts/check-skill-frontmatter.mjs --root <dir>    # any <dir>/<name>/SKILL.md tree
 *   node scripts/check-skill-frontmatter.mjs --json
 *
 * Exit codes:
 *   0 = every skill's known keys are top-level and correctly typed
 *   1 = at least one inert declaration (or an unparseable/frontmatter-less
 *       SKILL.md, or the lexer and parser disagreeing — never reported clean)
 *   2 = no skills found under --root / bad CLI input
 *
 * @module scripts/check-skill-frontmatter
 */
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { lintSkillTree, KNOWN_TOP_LEVEL_KEYS } from './lib/skill-frontmatter-layout.mjs';

const KNOWN_FLAGS = ['--selfcheck-relocation', '--root', '--json'];
const G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';

function readOption(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new ArgvError(`${flag} requires a value`);
  return v;
}

function main(argv) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  let root;
  try {
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'check-skill-frontmatter', from: 0 });
    root = path.resolve(readOption(argv, '--root') ?? 'skills');
  } catch (err) {
    if (!(err instanceof ArgvError)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const json = argv.includes('--json');

  const tree = lintSkillTree(root);
  const rel = path.relative(process.cwd(), root).split(path.sep).join('/') || '.';

  if (tree.reason === 'unreadable') {
    process.stderr.write(`${R}skill-frontmatter: cannot read ${rel}: ${tree.error}${X}\n`);
    process.exit(2);
  }
  if (tree.reason === 'no-skills') {
    process.stderr.write(`${R}skill-frontmatter: no <name>/SKILL.md under ${rel} — refusing to report clean having checked nothing${X}\n`);
    process.exit(2);
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: tree.ok, root: rel, skills: tree.skills.length, knownKeys: KNOWN_TOP_LEVEL_KEYS,
      topLevel: Object.fromEntries(tree.skills.map((s) => [s.name, s.result.topLevelKnownKeys])),
      findings: tree.findings,
    }, null, 2) + '\n');
    process.exit(tree.ok ? 0 : 1);
  }

  if (!tree.ok) {
    process.stderr.write(`${R}skill-frontmatter: FAILED${X} — ${tree.findings.length} inert or unverifiable frontmatter declaration(s) in ${rel}/\n`);
    for (const f of tree.findings) process.stderr.write(`  ${R}✗${X} [${f.kind}] ${f.message}\n`);
    process.stderr.write(`${D}A known key indented under a block scalar is parsed as text. It does not error; it just stops applying. ` +
      `Keys checked: ${KNOWN_TOP_LEVEL_KEYS.join(', ')}.${X}\n`);
    process.exit(1);
  }

  const declared = tree.skills.filter((s) => s.result.topLevelKnownKeys.length > 0);
  process.stdout.write(`${G}skill-frontmatter: OK${X} — ${B}${tree.skills.length}${X} skills, known keys top-level everywhere; ` +
    `${declared.length} declare one (${declared.map((s) => `${s.name}: ${s.result.topLevelKnownKeys.join('+')}`).join(', ') || 'none'})\n`);
  process.exit(0);
}

main(process.argv.slice(2));
