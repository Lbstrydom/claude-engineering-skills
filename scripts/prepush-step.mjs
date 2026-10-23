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
 *   prepush-step.mjs capabilities
 *       Prints the subcommands this runner has. The hook asks before relying on one: a source checkout older than the hook lacks them.
 *   prepush-step.mjs audit-outcome --exit <n> --report <envelope.json> [--out <capture-file>]
 *       Classifies the code-audit step (lib/prepush-audit-gate.mjs): exit 0 = the push may continue, 1 = refuse. An audit that did not
 *       run to a verdict (crash, auth/config failure, INCOMPLETE exit 3, no envelope) REFUSES unless AUDIT_PREPUSH_ALLOW_UNMEASURED=1.
 *   prepush-step.mjs audit-reuse
 *       `reuse <runId> <round> <tree12>` when a CONVERGED audit run recorded for exactly the pushed commit's tree exists, else
 *       `none <reason>`. Tree identity only; anything unverifiable is `none` (the audit runs).
 *   prepush-step.mjs audit-budget [--files <a,b,...>]
 *       `<seconds> <basis>`: the code-audit budget scaled to the pushed diff (floor 600s, capped).
 *
 * @module scripts/prepush-step
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, finishAndExit, toShellExitCode } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { resolvePushRange, branchOwnedChangedFiles } from './lib/push-range.mjs';
import { runStep } from './lib/prepush-step.mjs';
import {
  classifyAuditOutcome, decideAuditGate, decideAuditReuse, auditBudgetSec, parseNumstatZ,
} from './lib/prepush-audit-gate.mjs';

/** Signals that mean "stop": a terminal interrupt, a termination request, a hangup, and Ctrl+Break on Windows. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
const KNOWN_FLAGS = [
  '--step', '--budget-sec', '--progress-sec', '--out', '--default-ref', '--selfcheck-relocation',
  '--exit', '--report', '--files', '--cwd',
];
/** What this runner can do. The hook asks before relying on a subcommand, because an older source checkout lacks the newer ones. */
export const CAPABILITIES = Object.freeze(['run', 'own-files', 'audit-outcome', 'audit-reuse', 'audit-budget']);
/** A store lookup that outlives this is "unverifiable", i.e. a re-run - a reuse check must never be able to hang the hook. */
const REUSE_LOOKUP_MS = 20_000;

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

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });

/** A `run(args)` for resolvePushRange that reads the repo at `cwd` (its default reads the process cwd) and answers null on failure. */
const runIn = (cwd, gitFn) => (args) => { try { return gitFn(cwd, args).trim() || null; } catch { return null; } };

/** Last `n` non-empty lines of a captured output file, for a human to read. Display only - nothing is decided from it. */
function tailOf(file, n = 6) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').slice(-n); } catch { return []; }
}

/**
 * `audit-outcome`: classify the audit step's exit + `--out` envelope, print the verdict for the operator, and return the hook's
 * exit (0 = let the push continue, 1 = refuse). A failure of THIS function is a refusal too - it can never turn into a pass.
 * @returns {number}
 */
export function auditOutcomeExit({ exitArg, reportFile, captureFile, env = process.env, write = (l) => process.stderr.write(`${l}\n`) }) {
  const exitCode = exitArg === null || exitArg === '' || !Number.isInteger(Number(exitArg)) ? null : Number(exitArg);
  let report = null;
  if (reportFile) { try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { report = null; } }
  const outcome = classifyAuditOutcome({ exitCode, report });
  const decision = decideAuditGate({ outcome, env });
  if (outcome.kind === 'unmeasured' && captureFile) {
    const tail = tailOf(captureFile);
    if (tail.length > 0) { write('[prepush-hook] the audit\'s last output lines:'); for (const l of tail) write(`   | ${l}`); }
  }
  for (const l of decision.lines) write(l);
  return decision.allow ? 0 : 1;
}

/** `audit-budget`: one integer (seconds). The size is the pushed range, narrowed to the branch's own files when the hook scoped it. */
export function auditBudgetLine({ env = process.env, cwd = process.cwd(), files = null, gitFn = git } = {}) {
  let size = { files: null, lines: null };
  try {
    const range = resolvePushRange({ env, run: runIn(cwd, gitFn) });
    if (range.ok && range.trusted) {
      const paths = files ? files.split(',').filter(Boolean) : [];
      size = parseNumstatZ(gitFn(cwd, ['diff', '--numstat', '-z', `${range.base}..${range.head}`, ...(paths.length ? ['--', ...paths] : [])]));
    }
  } catch { /* size stays unknown -> the old floor, which is the conservative budget */ }
  const { budgetSec, basis } = auditBudgetSec(size);
  return `${budgetSec} ${basis}`;
}

async function defaultConvergence(runId) {
  // The store reads its own DSN (shared ~/.audit-loop.env layer included) - resolved here inside the CLI, never via the shell.
  await import('./lib/load-env.mjs');
  const { isCloudEnabled } = await import('./lib/store/repo.mjs');
  if (!(await isCloudEnabled())) return { convergence: null, why: 'cloud store is off' };
  const { getAuditRunConvergence } = await import('./lib/store/runs-findings.mjs');
  const row = await getAuditRunConvergence(runId);
  return row ? { convergence: row, why: null } : { convergence: null, why: 'no audit_runs row for that run, or the query failed' };
}

/**
 * `audit-reuse`: `reuse <runId> <round> <tree12>` or `none <reason>`. Every failure to establish reuse is `none` - the audit runs.
 * @returns {Promise<string>}
 */
export async function auditReuseLine({
  env = process.env, cwd = process.cwd(), gitFn = git, readConvergence = defaultConvergence, lookupMs = REUSE_LOOKUP_MS,
} = {}) {
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(cwd, '.audit', 'last-audit-run.json'), 'utf8')); } catch { marker = null; }
  // Only a range git itself handed the hook may name the pushed commit; an inferred one is a guess.
  const range = resolvePushRange({ env, run: runIn(cwd, gitFn) });
  let pushedTree = null;
  if (range.ok && range.trusted) { try { pushedTree = gitFn(cwd, ['rev-parse', '--verify', '--quiet', `${range.head}^{tree}`]).trim() || null; } catch { pushedTree = null; } }
  let conv = { convergence: null, why: 'not looked up' };
  // The store is only worth a round trip when the tree already matches: a different tree can never be reused.
  if (marker?.runId && pushedTree && marker.auditedTree === pushedTree) {
    let timer;
    try {
      conv = await Promise.race([
        readConvergence(marker.runId),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ convergence: null, why: `store lookup exceeded ${Math.round(lookupMs / 1000)}s` }), lookupMs); }),
      ]);
    } catch (e) { conv = { convergence: null, why: `store lookup failed (${e?.code || e?.message || 'error'})` }; } finally { clearTimeout(timer); }
  }
  const d = decideAuditReuse({ marker, pushedTree, convergence: conv.convergence, convergenceWhy: conv.why });
  return d.reuse ? `reuse ${d.runId} ${d.round} ${d.auditedTree.slice(0, 12)}` : `none ${d.reason}`;
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
  if (sub === 'capabilities') {
    process.stdout.write(`${CAPABILITIES.join(' ')}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub === 'audit-outcome') {
    const code = auditOutcomeExit({ exitArg: flagValue(head, '--exit'), reportFile: flagValue(head, '--report'), captureFile: flagValue(head, '--out') });
    await finishAndExit(code);
    return;
  }
  if (sub === 'audit-budget') {
    process.stdout.write(`${auditBudgetLine({ files: flagValue(head, '--files') })}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub === 'audit-reuse') {
    process.stdout.write(`${await auditReuseLine()}\n`);
    await finishAndExit(0);
    return;
  }
  if (sub !== 'run') throw new ArgvError('prepush-step.mjs: expected `run`, `own-files`, `audit-outcome`, `audit-reuse`, `audit-budget` or `capabilities`');

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
