#!/usr/bin/env node
/**
 * @fileoverview `test-evidence` -- may an earlier test run's result be reused, or must the tests rerun?
 * (docs/plans/copilot-feedback-item4.md Cluster C; usage: docs/runbooks/test-evidence.md.) A thin shell over
 * `lib/test-evidence.mjs`: it parses argv, calls the library, writes ONE JSON envelope to stdout and a summary line to
 * stderr, and exits. It never skips a test and nothing consults it automatically.
 *
 *   node scripts/test-evidence.mjs record [--ignore <glob>]... [--toolchain "<probe>"]... [--junit <report.xml>] -- <command…>
 *   node scripts/test-evidence.mjs check  [--ignore <glob>]... [--toolchain "<probe>"]... -- <command…>
 *
 * Exit codes. `check`: 0 reusable, 1 invalidated, 3 unknown (not measured: rerun). `record`: the child's own code when it
 * ran (so an orchestration still sees a failing suite), 1 when it was killed by a signal, 2 when it could not start,
 * 3 when it ran green but nothing was recorded (or its identity could not be computed, in which case it did not run).
 * 2 is also a usage error. The child's stdout and stderr both go to this process's STDERR, so stdout is exactly one
 * JSON value.
 *
 * @module scripts/test-evidence
 */
import { ArgvError, assertKnownFlags, emit, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { checkRun, recordRun } from './lib/test-evidence.mjs';

// Only OUR flags (before the POSIX "--") count: a child command that itself takes --selfcheck-relocation must still run.
const ownArgs = process.argv.includes('--') ? process.argv.slice(0, process.argv.indexOf('--')) : process.argv;
if (ownArgs.includes('--selfcheck-relocation') && isInvokedAsScript(import.meta.url)) { console.log('OK'); process.exit(0); }

const KNOWN_FLAGS = ['--ignore', '--toolchain', '--junit', '--selfcheck-relocation'];
const REPEATABLE = new Set(['--ignore', '--toolchain']);

/**
 * @param {string[]} args argv after the script name
 * @returns {{verb: 'record'|'check', ignore: string[], toolchain: string[], junit: string|null, command: string[]}}
 * @throws {ArgvError}
 */
export function parseArgs(args) {
  const stop = args.indexOf('--');
  const head = stop < 0 ? args : args.slice(0, stop);
  const command = stop < 0 ? [] : args.slice(stop + 1);
  const out = { verb: null, ignore: [], toolchain: [], junit: null, command };
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (!a.startsWith('--')) {
      if (out.verb) throw new ArgvError(`test-evidence: unexpected argument ${JSON.stringify(a)}; the command goes after "--"`);
      out.verb = a;
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a : a.slice(0, eq);
    if (name === '--selfcheck-relocation') continue;
    let value;
    if (eq >= 0) value = a.slice(eq + 1);
    else {
      value = head[++i];
      if (value === undefined || value.startsWith('--')) throw new ArgvError(`test-evidence: ${name} requires a value`);
    }
    if (REPEATABLE.has(name)) out[name.slice(2)].push(value);
    else if (name === '--junit') out.junit = value;
  }
  if (out.verb !== 'record' && out.verb !== 'check') {
    throw new ArgvError(`test-evidence: the first argument must be "record" or "check" (got ${JSON.stringify(out.verb)})`);
  }
  if (command.length === 0) throw new ArgvError(`test-evidence ${out.verb}: a command is required after "--"`);
  if (out.verb === 'check' && out.junit) throw new ArgvError('test-evidence check: --junit belongs to "record" (it reads the report the run produced)');
  return out;
}

/** @returns {Promise<{exitCode: number, envelope: object}>} */
export async function run(argv = process.argv, env = process.env) {
  try {
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'test-evidence' });
    const p = parseArgs(argv.slice(2));
    const opts = { argv: p.command, cwd: process.cwd(), ignore: p.ignore, toolchain: p.toolchain, env };
    return p.verb === 'record' ? await recordRun({ ...opts, junit: p.junit }) : await checkRun(opts);
  } catch (err) {
    // A usage error still honours the one-envelope contract: a caller parsing stdout must not get an empty string.
    return { exitCode: 2, envelope: { ok: false, error: err.message, summary: `test-evidence: ${err.message}` } };
  }
}

if (isInvokedAsScript(import.meta.url)) {
  const { exitCode, envelope } = await run();
  emit(envelope);
  process.stderr.write(`${envelope.summary}\n`);
  if (envelope.limit) process.stderr.write(`${envelope.limit}\n`);
  if (envelope.message) process.stderr.write(`  ${envelope.message}\n`);
  await finishAndExit(exitCode);
}
