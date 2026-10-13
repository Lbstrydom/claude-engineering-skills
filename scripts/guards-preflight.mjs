#!/usr/bin/env node
/**
 * @fileoverview `npm run guards:preflight` — the push gate's whole-suite guards, in a
 * couple of minutes, BEFORE you ask for a gate slot. Runs every static gate of `check`
 * (derived from package.json) except the declared slow ones, then the declared guard test
 * files through `scripts/run-tests.mjs`. It runs the real checks, never copies, and it
 * never substitutes for the full gate. Rationale and the list: `scripts/lib/guards-preflight.mjs`.
 *
 * Exit codes: 0 every step passed · 1 a step failed · 2 the preflight itself could not plan or run
 * (a stale list entry, an unreadable package.json; never a pass) · 3 nothing failed but a step could not
 * be measured (never reported as a pass).
 *
 * Usage: node scripts/guards-preflight.mjs [--list]
 *
 * @module scripts/guards-preflight
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, finishAndExit, hasFlag } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { EXIT_CANNOT_RUN, executePreflight, planPreflight } from './lib/guards-preflight.mjs';

const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string[]} args @returns {string|null} */
function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  assertKnownFlags(process.argv, ['--list', '--selfcheck-relocation'], { cli: 'guards-preflight' });
  if (hasFlag('selfcheck-relocation')) { console.log('OK'); return 0; }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const plan = planPreflight({ pkg, exists: (p) => fs.existsSync(path.join(ROOT, p)) });
  if (hasFlag('list')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}
`);
    return 0;
  }

  process.stderr.write(`guards:preflight: ${plan.gates.length} static gates + ${plan.testFiles.length} guard test files; `
    + `omitted ${plan.omittedGates.map((g) => `${g.script} (~${g.measuredS}s)`).join(', ')}. NOT the full gate.
`);

  const s = executePreflight(plan, { head: gitOut(['rev-parse', 'HEAD']), mergeBase: gitOut(['merge-base', 'HEAD', 'origin/main']) }, {
    // 64 MiB: a verbose gate must be judged on its own exit code, not killed by the wrapper's default 1 MiB buffer.
    spawn: (cmd, args) => (cmd === NPM
      ? spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: IS_WIN, maxBuffer: 64 * 1024 * 1024 })
      : spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' })),
    npm: NPM,
    node: process.execPath,
    runner: path.join(ROOT, 'scripts/run-tests.mjs'),
    log: (m) => process.stderr.write(m),
  });
  process.stderr.write(`${s.line}
`);
  return s.exitCode;
}

// Direct-run guard (lib/cli-entry.mjs): a symlinked or junctioned path must not turn this into a silent no-op, and an
// import (the tests load the library module, not this file) must not start a run.
if (isInvokedAsScript(import.meta.url)) {
  main().then((code) => finishAndExit(code), (err) => {
    process.stderr.write(`guards:preflight: cannot run: ${err.message}
`);
    return finishAndExit(EXIT_CANNOT_RUN);
  });
}
