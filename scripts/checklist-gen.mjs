#!/usr/bin/env node
/**
 * @fileoverview Regenerate (or verify) CES's own `.audit-loop/checklist.json` from `lib/checklist/gen.mjs` + the gate contracts.
 * Category B generated artifact: byte-identical on regeneration, so `--check` fails on any difference and nobody hand-edits it.
 *
 * Usage:
 *   node scripts/checklist-gen.mjs            write .audit-loop/checklist.json
 *   node scripts/checklist-gen.mjs --check    exit 1 when the committed file differs from the regeneration
 *
 * Source-repo-only (never synced): the entries are CES's own incident history.
 * Exit codes: 0 ok / written | 1 stale (--check) | 2 usage error
 *
 * @module scripts/checklist-gen
 */
import './lib/help-guard-run.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { buildChecklistText } from './lib/checklist/gen.mjs';
import { CHECKLIST_PATH } from './lib/checklist/schema.mjs';

async function main() {
  const argv = process.argv;
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }
  try { assertKnownFlags(argv, ['--check', '--help', '-h', '--selfcheck-relocation'], { cli: 'checklist-gen' }); } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const want = buildChecklistText(repoRoot);
  const file = path.join(repoRoot, CHECKLIST_PATH);
  if (argv.includes('--check')) {
    let have = null;
    try { have = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { /* absent = stale */ }
    if (have !== want) {
      process.stderr.write(`checklist-gen: ${CHECKLIST_PATH} is stale or hand-edited. Run \`npm run checklist:gen\` and commit the result.\n`);
      await finishAndExit(1);
      return;
    }
    process.stdout.write(`checklist-gen: ${CHECKLIST_PATH} is current\n`);
    await finishAndExit(0);
    return;
  }
  fs.writeFileSync(file, want);
  process.stdout.write(`checklist-gen: wrote ${CHECKLIST_PATH}\n`);
  await finishAndExit(0);
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch(async (err) => { process.stderr.write(`checklist-gen: ${err?.stack ?? err}\n`); await finishAndExit(2); });
}
