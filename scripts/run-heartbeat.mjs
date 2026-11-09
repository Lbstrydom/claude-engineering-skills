#!/usr/bin/env node
/**
 * @fileoverview Heartbeat journals for long-running background runs, and the
 * stale-watch that wakes the session that launched them.
 *
 *   node scripts/run-heartbeat.mjs run   --run-id <id> --stale-after <sec> [--note "..."] -- <cmd> [args...]
 *   node scripts/run-heartbeat.mjs start --run-id <id> --stale-after <sec> [--note "..."]
 *   node scripts/run-heartbeat.mjs beat  --run-id <id> [--note "..."]
 *   node scripts/run-heartbeat.mjs end   --run-id <id> --exit <code> [--signal <sig>]
 *   node scripts/run-heartbeat.mjs check --run-id <id> [--json]
 *   node scripts/run-heartbeat.mjs watch --run-id <id> [--poll <sec>] [--grace <sec>]
 *   node scripts/run-heartbeat.mjs list  [--json]
 *
 * `run` is the launch convention for a command that does not beat itself: it
 * reserves the journal BEFORE spawning (a taken id spawns nothing), records the
 * child pid, beats on child output (at most one per 5 s), forwards SIGINT/SIGTERM,
 * and writes `end` with the child's exit code, which it also exits with. A wrapper
 * killed uncatchably writes no `end` and its child may survive — the journal then
 * reads STALE and `check` reports whether the child pid is still alive.
 *
 * `watch` prints one line per state change and EXITS on a terminal state
 * (ENDED_OK, ENDED_FAILED, STALE, UNKNOWN). Arm it with Claude Code's Monitor (or
 * Bash run_in_background) so a stale run wakes the launching session. It is not a
 * daemon: when the Monitor expires nothing is watching, and that is not a verdict.
 *
 * Exit codes (check / watch): 0 RUNNING or ENDED_OK · 1 ENDED_FAILED ·
 * 3 STALE or UNKNOWN (not evidence of health) · 2 usage / bad input.
 *
 * `--dir <path>` overrides the runs dir (tests). Plan: docs/plans/test-campaign-controls.md §2.1.
 */
import { spawn } from 'node:child_process';
import { assertKnownFlags, ArgvError, argOption, hasFlag, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import {
  resolveRunsDir, startRun, appendRun, appendOwnRun, checkRun, listRuns, validateRunId, BEAT_THROTTLE_MS,
} from './lib/run-heartbeat.mjs';

const KNOWN = ['--run-id', '--stale-after', '--note', '--exit', '--signal', '--json', '--poll', '--grace', '--dir', '--help'];

export function exitCodeFor(state) {
  if (state === 'RUNNING' || state === 'ENDED_OK') return 0;
  if (state === 'ENDED_FAILED') return 1;
  return 3;
}

function usage(msg) { throw new ArgvError(`run-heartbeat: ${msg}`); }

function requireRunId() {
  const runId = argOption('run-id');
  const v = validateRunId(runId);
  if (!v.ok) usage(v.reason);
  return runId;
}

function numberOption(name, { required = false, dflt = null } = {}) {
  const raw = argOption(name.replace(/^--/, ''));
  if (raw === null || raw === undefined) {
    if (required) usage(`${name} is required`);
    return dflt;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) usage(`${name} must be a positive number, got "${raw}"`);
  return n;
}

function describe(v) {
  const extra = v.state === 'STALE' && v.childPid ? ` [child pid ${v.childPid} alive: ${v.childAlive}]` : '';
  return `run ${v.runId ?? '?'}: ${v.state} — ${v.reason}${extra}`;
}

/** The wrapper. Resolves to the exit code to use. */
async function runWrapped(dir, runId, staleAfterSec, note, cmd) {
  if (cmd.length === 0) usage('run needs a command after --');
  const journal = startRun(dir, { runId, staleAfterSec, note });
  process.stderr.write(`[run-heartbeat] journal ${journal}\n`);
  return new Promise((resolve) => {
    let child;
    let ended = false;
    let lastBeat = 0;
    let untracked = null;
    const finish = (rawExit, signal) => {
      if (ended) return;
      ended = true;
      const exitCode = untracked && rawExit === 0 ? 1 : rawExit;
      const code = Number.isInteger(exitCode) ? exitCode : 1;
      try { appendOwnRun(journal, { runId, kind: 'end', exitCode, signal, ...(untracked ? { note: `child pid not recorded: ${untracked}` } : {}) }); } catch (err) {
        // A run whose end is not durable reads STALE, never ENDED_OK — so the wrapper must not report success either.
        process.stderr.write(`[run-heartbeat] could not write end record (${err.message}) — exiting non-zero\n`);
        resolve(code === 0 ? 1 : code);
        return;
      }
      resolve(code);
    };
    try {
      child = spawn(cmd[0], cmd.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
    } catch (err) {
      process.stderr.write(`[run-heartbeat] spawn failed: ${err.message}\n`);
      finish(127, null);
      return;
    }
    child.on('error', (err) => {
      process.stderr.write(`[run-heartbeat] spawn failed: ${err.message}\n`);
      finish(127, null);
    });
    child.on('spawn', () => {
      try { appendOwnRun(journal, { runId, kind: 'beat', childPid: child.pid, note: 'spawned' }); lastBeat = Date.now(); } catch (err) {
        // No untracked child: if its pid cannot be recorded, it does not run — and the run is a failure whatever
        // the child exits with (a child that handles SIGTERM and exits 0 must not read as success).
        untracked = err.message;
        process.stderr.write(`[run-heartbeat] could not record child pid (${err.message}) — stopping the child\n`);
        child.kill('SIGTERM');
        setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 5000).unref();
      }
    });
    // Output is a LIVENESS signal (the child is producing something), not proof of progress — a job that should
    // prove progress beats explicitly. pipe() carries backpressure; the data listener only stamps the beat.
    const onOutput = () => {
      const t = Date.now();
      if (!ended && t - lastBeat >= BEAT_THROTTLE_MS) {
        lastBeat = t;
        try { appendOwnRun(journal, { runId, kind: 'beat' }); } catch (err) {
          process.stderr.write(`[run-heartbeat] beat not written: ${err.message}\n`);
        }
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => { if (child && !ended) child.kill(sig); });
    }
    child.on('close', (code, signal) => finish(signal ? null : code, signal || undefined));
  });
}

async function watch(dir, runId, pollSec, graceSec) {
  const startedAt = Date.now();
  let prev = null;
  for (;;) {
    const v = checkRun(dir, runId);
    // Grace covers a journal not yet created AND one caught between its exclusive create and its first line.
    const starting = v.reason === 'no journal' || (v.reason === 'no start record' && !v.malformedLines);
    const inGrace = v.state === 'UNKNOWN' && starting && Date.now() - startedAt < graceSec * 1000;
    if (!inGrace) {
      const key = `${v.state}`;
      if (key !== prev) { process.stdout.write(`${describe(v)}\n`); prev = key; }
      if (v.state !== 'RUNNING') return exitCodeFor(v.state);
    }
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

// Reads process.argv only: argOption/hasFlag (cli-io.mjs) read it ambiently, so an argv parameter would be half-honoured.
export async function main() {
  const argv = process.argv;
  // Only the wrapper's own flags (before `--`): a child command's argv must never trigger the wrapper's self-check.
  const ownArgs = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  if (ownArgs.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(argv, KNOWN, { cli: 'run-heartbeat' });
  const sub = argv[2];
  if (!sub || sub === '--help' || hasFlag('help')) {
    process.stdout.write('usage: run-heartbeat <run|start|beat|end|check|watch|list> --run-id <id> ... (see the file header)\n');
    return sub ? 0 : 2;
  }
  const dirOpt = argOption('dir');
  const dir = dirOpt || resolveRunsDir(process.cwd()).dir;
  const json = hasFlag('json');
  const note = argOption('note') || undefined;
  switch (sub) {
    case 'start': {
      const p = startRun(dir, { runId: requireRunId(), staleAfterSec: numberOption('--stale-after', { required: true }), note });
      process.stdout.write(`${p}\n`);
      return 0;
    }
    case 'beat':
      appendRun(dir, { runId: requireRunId(), kind: 'beat', note });
      return 0;
    case 'end': {
      const runId = requireRunId();
      const raw = argOption('exit');
      if (raw === null || !/^-?\d+$/.test(String(raw))) usage('end needs --exit <integer>');
      appendRun(dir, { runId, kind: 'end', exitCode: Number(raw), signal: argOption('signal') || undefined });
      return 0;
    }
    case 'run': {
      const sep = argv.indexOf('--');
      return runWrapped(dir, requireRunId(), numberOption('--stale-after', { required: true }), note, sep >= 0 ? argv.slice(sep + 1) : []);
    }
    case 'check': {
      const v = checkRun(dir, requireRunId());
      process.stdout.write(json ? `${JSON.stringify(v, null, 2)}\n` : `${describe(v)}\n`);
      return exitCodeFor(v.state);
    }
    case 'watch':
      return watch(dir, requireRunId(), numberOption('--poll', { dflt: 30 }), numberOption('--grace', { dflt: 60 }));
    case 'list': {
      const listing = listRuns(dir);
      if (json) process.stdout.write(`${JSON.stringify({ dir, ...listing }, null, 2)}\n`);
      else if (!listing.measured) process.stdout.write(`runs: UNMEASURED (${listing.reason})\n`);
      else if (listing.runs.length === 0) process.stdout.write(`no runs in ${dir}\n`);
      else for (const v of listing.runs) process.stdout.write(`${describe(v)}\n`);
      return listing.measured ? 0 : 3;
    }
    default:
      usage(`unknown subcommand "${sub}"`);
  }
  return 2;
}

if (isInvokedAsScript(import.meta.url)) {
  let code;
  try {
    code = await main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    code = err instanceof ArgvError || err?.code === 'ARGV_ERROR' ? 2 : 1;
  }
  await finishAndExit(code);
}
