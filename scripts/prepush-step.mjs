#!/usr/bin/env node
/**
 * @fileoverview Helpers the consumer pre-push hook calls so no step of it can hang silently (see lib/prepush-step.mjs).
 *
 *   prepush-step.mjs run --step <name> --budget-sec <n> [--progress-sec <n>] [--out <file>] -- <cmd> [args...]
 *       Runs the command with a wall-clock budget and a heartbeat on stderr. The command's stdout is this process's stdout (the
 *       hook captures `--select` that way). Exit: the command's status, 124 when it outlived the budget (the hook refuses the push).
 *   prepush-step.mjs own-files
 *       Reads the push range from AUDIT_PUSH_RANGE_BASE/_HEAD (the hook exports it from git's own stdin) and prints ONE line:
 *       `scoped:<comma-separated files>` when the range holds a merge of the default branch and the branch's own files are known
 *       (an empty list means the branch owns nothing in the range), else `unscoped`.
 *
 * @module scripts/prepush-step
 */
import fs from 'node:fs';
import { assertKnownFlags, ArgvError, finishAndExit, toShellExitCode } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { resolvePushRange, branchOwnedChangedFiles } from './lib/push-range.mjs';
import { runStep } from './lib/prepush-step.mjs';

/** Signals that mean "stop": a terminal interrupt, a termination request, a hangup, and Ctrl+Break on Windows. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
const KNOWN_FLAGS = ['--step', '--budget-sec', '--progress-sec', '--out', '--default-ref', '--selfcheck-relocation'];

const flagValue = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

/** @returns {string} the single protocol line `own-files` prints */
export function ownFilesLine({ env = process.env, defaultRef, resolve = resolvePushRange, owned = branchOwnedChangedFiles } = {}) {
  const range = resolve({ env });
  // Only a range git itself handed the hook (source 'explicit') may narrow what is audited: an inferred one may already be too small.
  if (!range.ok || !range.trusted) return 'unscoped';
  const r = owned(range, defaultRef ? { defaultRef } : {});
  // A path with a comma or a newline cannot ride a one-line comma-separated list: say "unscoped" (the whole diff) rather than split it.
  if (!r || !r.scoped || r.files.some((f) => /[,\r\n]/.test(f))) return 'unscoped';
  return `scoped:${r.files.join(',')}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf('--');
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  // Only OUR flags count: the hook runs `run -- node check-plan-status.mjs --selfcheck-relocation`, and answering OK for the wrapped
  // command's probe would report a checker runnable that never started.
  if (head.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }
  assertKnownFlags(['', '', ...head], KNOWN_FLAGS, { cli: 'prepush-step.mjs' });
  const sub = head[0];

  if (sub === 'own-files') {
    process.stdout.write(`${ownFilesLine({ defaultRef: flagValue(head, '--default-ref') ?? undefined })}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub !== 'run') throw new ArgvError('prepush-step.mjs: expected `run` or `own-files`');

  const step = flagValue(head, '--step');
  const budgetSec = Number(flagValue(head, '--budget-sec'));
  const progressSec = flagValue(head, '--progress-sec') === null ? 30 : Number(flagValue(head, '--progress-sec'));
  const cmdv = dd >= 0 ? argv.slice(dd + 1) : [];
  if (!step || !(budgetSec > 0) || !(progressSec >= 0) || cmdv.length === 0) {
    throw new ArgvError('prepush-step.mjs run: needs --step <name>, --budget-sec <n> > 0 and a command after `--`');
  }
  const outFile = flagValue(head, '--out');
  const fd = outFile ? fs.openSync(outFile, 'w') : null;
  const [cmd, ...args] = cmdv;
  // A stop request (the hook was interrupted) must reach the step's process tree, or the machine keeps burning after the push died.
  const abort = new AbortController();
  const stop = () => abort.abort();
  const wired = STOP_SIGNALS.filter((sig) => { try { process.on(sig, stop); return true; } catch { return false; } });
  let r;
  try {
    r = await runStep({
      signal: abort.signal, step, cmd: cmd === 'node' ? process.execPath : cmd, args, budgetMs: budgetSec * 1000, progressMs: progressSec * 1000,
      stdio: fd === null ? 'inherit' : ['ignore', fd, fd], log: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    for (const sig of wired) process.off(sig, stop);
    if (fd !== null) fs.closeSync(fd);
  }
  await finishAndExit(toShellExitCode(r.code)); // git reads a hook's status as `code & 0xff`: a step failing with 256 must not read as 0
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch(async (err) => {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      await finishAndExit(2);
      return;
    }
    process.stderr.write(`prepush-step.mjs: ${err?.stack ?? err}\n`);
    await finishAndExit(1);
  });
}
