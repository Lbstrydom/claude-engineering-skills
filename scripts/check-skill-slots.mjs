#!/usr/bin/env node
/**
 * @fileoverview Upstream half of block holds: lint every `skills/<name>/SKILL.md`
 * for `<!-- sync-slot:<name> -->` markers (exact form, column 0, outside
 * frontmatter and fenced code, once per name).
 *
 * A consumer that declares a block for a slot finds out at ITS sync when the
 * marker is malformed, duplicated or misplaced: the file stops updating and
 * its target fails. This moves that failure to upstream's push. The grammar
 * itself lives once, in `lib/sync-slots.mjs` (`lintSlotMarkers`), the same
 * module the sync splices with.
 *
 * Fails CLOSED on its input: a missing or unreadable root, a read error, or
 * zero SKILL.md files is exit 2, never a pass, and a green run prints what it
 * counted so it states what it measured.
 *
 * Usage:
 *   node scripts/check-skill-slots.mjs [--root skills] [--json]
 *
 * Exit: 0 clean, 1 marker problems, 2 could not check.
 * Plan: docs/plans/sync-skill-block-holds.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { lintSlotMarkers, findSlotMarkers } from './lib/sync-slots.mjs';

const KNOWN_FLAGS = ['--root', '--json', '--help', '-h', '--selfcheck-relocation'];
const USAGE = 'Usage: node scripts/check-skill-slots.mjs [--root skills] [--json]\n'
  + 'Lints <!-- sync-slot:<name> --> markers in every <root>/<name>/SKILL.md. Exit 0 clean, 1 problems, 2 could not check.\n';

/**
 * Lint a skills root. PURE apart from reads; every failure to read is a result, never a skip.
 *
 * @param {string} root
 * @returns {{status: 'ok'|'problems'|'unreadable'|'no-skills', files: number, markers: number,
 *   problems: Array<{file: string, line: number, code: string, message: string}>, error?: string}}
 */
export function lintSkillSlots(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (err) {
    return { status: 'unreadable', files: 0, markers: 0, problems: [], error: err.message };
  }
  const problems = [];
  let files = 0;
  let markers = 0;
  for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(root, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch (err) {
      return { status: 'unreadable', files, markers, problems, error: `${file}: ${err.message}` };
    }
    files++;
    markers += findSlotMarkers(text.replace(/\r\n/g, '\n')).length;
    const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
    for (const p of lintSlotMarkers(text)) problems.push({ file: rel, ...p });
  }
  if (files === 0) return { status: 'no-skills', files, markers, problems };
  return { status: problems.length ? 'problems' : 'ok', files, markers, problems };
}

async function main(argv) {
  if (argv.includes('--selfcheck-relocation')) { process.stdout.write('OK\n'); return finishAndExit(0); }
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); return finishAndExit(0); }
  let root;
  try {
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'check-skill-slots', from: 0 });
    const i = argv.indexOf('--root');
    const v = i === -1 ? 'skills' : argv[i + 1];
    if (!v || v.startsWith('--')) throw new ArgvError('--root requires a value');
    root = path.resolve(v);
  } catch (err) {
    if (!(err instanceof ArgvError)) throw err;
    process.stderr.write(`${err.message}\n${USAGE}`);
    return finishAndExit(2);
  }
  const r = lintSkillSlots(root);
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else if (r.status === 'unreadable') {
    process.stderr.write(`skill-slots: cannot read ${root}: ${r.error}\n`);
  } else if (r.status === 'no-skills') {
    process.stderr.write(`skill-slots: no <name>/SKILL.md under ${root} — refusing to report clean having checked nothing\n`);
  } else if (r.status === 'problems') {
    process.stderr.write(`skill-slots: FAILED — ${r.problems.length} slot-marker problem(s)\n`);
    for (const p of r.problems) process.stderr.write(`  ✗ ${p.file}:${p.line} [${p.code}] ${p.message}\n`);
    process.stderr.write('A consumer block declared for a broken slot stops its file updating; fix the marker here.\n');
  } else {
    process.stdout.write(`skill-slots: OK — ${r.files} SKILL.md read, ${r.markers} slot marker(s), all well-formed\n`);
  }
  const code = r.status === 'ok' ? 0 : r.status === 'problems' ? 1 : 2;
  return finishAndExit(code);
}

if (isInvokedAsScript(import.meta.url)) await main(process.argv.slice(2));
