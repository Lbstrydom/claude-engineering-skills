#!/usr/bin/env node
/**
 * @fileoverview Reproduce the checklist pilot's figures (verification-lessons plan, Phase 5) from a pinned tip.
 *
 * Usage:
 *   node scripts/checklist-pilot.mjs --replay --tip <sha> [--skip <n>] [--count <n>] [--checklist <file>] [--out-dir <dir>] [--json]
 *   node scripts/checklist-pilot.mjs --incidents [--checklist <file>] [--out-dir <dir>] [--json]
 *   node scripts/checklist-pilot.mjs --kernel [--checklist <file>] [--json]
 *   node scripts/checklist-pilot.mjs --controls [--checklist <file>] [--json]   (per-entry control/negative verdicts)
 *   node scripts/checklist-pilot.mjs --verify-frozen                            (sha256 of checklist, matcher and scoring code vs the pinned constants)
 *   add --confirmation to --replay: refuses to run unless the instrument is the frozen one
 *
 * `--skip 30` is the held-out window (the 30 PRs before the pilot window). Writes patches and a throwaway fires log under
 * `--out-dir` (default a temp dir), never the repo's `.audit/` log. Source-repo-only; read-only on the repo.
 *
 * Exit codes: 0 ok | 1 --verify-frozen found a mismatch | 2 usage error, unusable input, or a refused --confirmation
 *
 * @module scripts/checklist-pilot
 */
import './lib/help-guard-run.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { replayWindow, incidentReplay, kernelEstimate, controlRows } from './lib/checklist/pilot.mjs';
import { verifyFrozen } from './lib/checklist/frozen.mjs';

const FLAGS = ['--replay', '--incidents', '--kernel', '--controls', '--verify-frozen', '--confirmation', '--tip', '--skip', '--count', '--checklist', '--out-dir', '--json', '--help', '-h', '--selfcheck-relocation'];

function value(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new ArgvError(`checklist-pilot: ${name} requires a value`);
  return v;
}

async function main() {
  const argv = process.argv;
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }
  let out;
  let exitCode = 0;
  try {
    assertKnownFlags(argv, FLAGS, { cli: 'checklist-pilot' });
    const modes = ['--replay', '--incidents', '--kernel', '--controls', '--verify-frozen'].filter((m) => argv.includes(m));
    if (modes.length !== 1) throw new ArgvError('checklist-pilot: pass exactly one of --replay, --incidents, --kernel, --controls, --verify-frozen');
    const repoRoot = process.cwd();
    const checklistFile = value(argv, '--checklist') ?? undefined;
    const outDir = path.resolve(value(argv, '--out-dir') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-pilot-')));
    if (argv.includes('--confirmation')) {
      if (modes[0] !== '--replay') throw new ArgvError('checklist-pilot: --confirmation only applies to --replay');
      // A confirmation run is only a confirmation if the instrument is the frozen one, INCLUDING the checklist actually passed in.
      const v = verifyFrozen(repoRoot, { checklistFile });
      if (!v.ok) throw new Error(`--confirmation refused: the instrument is not the frozen one (${v.mismatches.map((m) => m.name).join(', ')} differ; run --verify-frozen)`);
    }
    if (modes[0] === '--verify-frozen') {
      out = verifyFrozen(repoRoot, { checklistFile });
      exitCode = out.ok ? 0 : 1;
    } else if (modes[0] === '--replay') {
      const tip = value(argv, '--tip');
      if (!tip) throw new ArgvError('checklist-pilot: --replay needs --tip <sha> (the window is defined from a pinned commit)');
      const { _replay, _git, ...rest } = replayWindow({ repoRoot, tip, skip: Number(value(argv, '--skip') ?? 0), count: Number(value(argv, '--count') ?? 30), checklistFile, outDir });
      out = rest;
    } else if (modes[0] === '--incidents') {
      out = incidentReplay({ repoRoot, outDir, checklistFile });
    } else if (modes[0] === '--controls') {
      out = controlRows({ repoRoot, checklistFile });
    } else {
      out = kernelEstimate({ repoRoot, checklistFile });
    }
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    process.stderr.write(`checklist-pilot: ${err.message}\n`);
    await finishAndExit(2);
    return;
  }
  process.stdout.write(`${JSON.stringify(out, null, argv.includes('--json') ? 0 : 2)}\n`);
  await finishAndExit(exitCode);
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch(async (err) => { process.stderr.write(`checklist-pilot: ${err?.stack ?? err}\n`); await finishAndExit(2); });
}
