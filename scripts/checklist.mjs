#!/usr/bin/env node
/**
 * @fileoverview Diff-triggered checklist: print the repo tripwires a change triggers (verification-lessons plan, section 2.5).
 *
 * Usage:
 *   node scripts/checklist.mjs --files <csv of the paths you will touch>      (BEFORE editing: paths + symbols)
 *   node scripts/checklist.mjs --diff <base>                                   (BEFORE calling it done: also patterns)
 *   node scripts/checklist.mjs --diff-file <unified-diff-file>                  (a diff you already hold: the audit's --diff, a replayed PR)
 *     [--json] [--purpose operational|control|replay|test] [--checklist <file>] [--log <file>] [--no-record]
 *
 * `--files` matches `paths` and, against the current on-disk content of those files, `symbols`; it never uses `patterns`
 * (there is no diff yet), so a pattern-only tripwire can only fire at the `--diff` step. `--diff <base>` reads
 * `git diff <base>` (staged + unstaged, renames detected) plus untracked files. Every evaluation, zero-match ones included,
 * is appended to .audit/checklist-fires.jsonl. An absent .audit-loop/checklist.json is an empty checklist (the state of every
 * consumer: the file is consumer-owned and the sync never ships this repo's rules).
 *
 * Exit codes: 0 evaluated (fired or not) | 2 usage error, unresolvable base, unreadable diff, or an invalid checklist
 *
 * @module scripts/checklist
 */
import './lib/help-guard-run.mjs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { loadChecklist, CHECKLIST_PATH, FIRE_PURPOSES } from './lib/checklist/schema.mjs';
import { matchChecklist } from './lib/checklist/match.mjs';

const KNOWN_FLAGS = ['--files', '--diff', '--diff-file', '--json', '--purpose', '--checklist', '--log', '--no-record', '--help', '-h', '--selfcheck-relocation'];

function value(argv, name) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === name) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new ArgvError(`checklist: ${name} requires a value`);
      return v;
    }
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

function human(result, entries, absent) {
  const lines = [];
  const head = result.mode === 'files' ? `pre-edit (${result.inputFiles} path(s); patterns need --diff)` : `post-edit diff (${result.inputFiles} file(s))`;
  if (absent) lines.push('checklist: no .audit-loop/checklist.json - an empty checklist, nothing to fire.');
  lines.push(`checklist ${head}: ${result.fired.length} of ${result.evaluated} entries fired`);
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const f of result.fired) {
    const e = byId.get(f.id);
    lines.push('', `[${f.id}] (${f.via.join('+')}: ${f.evidence.join(' | ')})`, `  check:    ${e.check}`, `  incident: ${e.incident}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const argv = process.argv;
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }
  let opts;
  try {
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'checklist' });
    const filesCsv = value(argv, '--files');
    const base = value(argv, '--diff');
    const diffFile = value(argv, '--diff-file');
    if ([filesCsv, base, diffFile].filter((v) => v !== null).length !== 1) throw new ArgvError('checklist: pass exactly one of --files <csv>, --diff <base> or --diff-file <file>');
    const purpose = value(argv, '--purpose') ?? 'operational';
    if (!FIRE_PURPOSES.includes(purpose)) throw new ArgvError(`checklist: --purpose must be one of ${FIRE_PURPOSES.join('|')}`);
    opts = {
      files: filesCsv === null ? undefined : filesCsv.split(',').map((s) => s.trim()).filter(Boolean),
      base: base ?? undefined,
      diffPath: diffFile ?? undefined,
      purpose,
      checklist: value(argv, '--checklist') ?? CHECKLIST_PATH,
      logPath: value(argv, '--log') ?? undefined,
      record: !argv.includes('--no-record'),
      json: argv.includes('--json'),
    };
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }

  const cwd = process.cwd();
  const loaded = loadChecklist({ repoRoot: cwd, file: opts.checklist });
  if (!loaded.ok) { process.stderr.write(`checklist: ${loaded.error}\n`); await finishAndExit(2); return; }

  const result = matchChecklist({
    entries: loaded.entries, files: opts.files, base: opts.base, diffPath: opts.diffPath, purpose: opts.purpose, cwd,
    logPath: opts.logPath ? path.resolve(cwd, opts.logPath) : undefined, record: opts.record,
  });
  if (!result.ok) {
    process.stderr.write(`checklist: ${result.code}: ${result.message}\n`);
    await finishAndExit(2);
    return;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: result.mode, absent: loaded.absent, evaluated: result.evaluated, inputFiles: result.inputFiles, recorded: result.recorded, patternsSkipped: result.patternsSkipped, fired: result.fired.map((f) => ({ ...f, check: loaded.entries.find((e) => e.id === f.id).check, incident: loaded.entries.find((e) => e.id === f.id).incident })) })}\n`);
  } else {
    process.stdout.write(human(result, loaded.entries, loaded.absent));
  }
  await finishAndExit(0);
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch(async (err) => {
    process.stderr.write(`checklist: ${err?.stack ?? err}\n`);
    await finishAndExit(2);
  });
}
