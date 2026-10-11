#!/usr/bin/env node
/**
 * @fileoverview Ship trains — the machinery behind `/ship --train`.
 *
 * One human `/ship --train` lands several already-audited PRs: one status.md
 * entry, per-PR provenance written into each squash commit, one combined test
 * run (fleet), one consumer sync. Plan: docs/plans/ship-trains.md.
 *
 * Verbs in this cluster (none of them merges anything):
 *   plan     read-only: per ship-ready PR, its impact tier, the audit run bound
 *            to it by CONTENT, the planned AI-Gate or the refusal, and whether
 *            a train is due.
 *   prepare  re-runs plan and writes the operation receipt (the only handoff
 *            from planning to execution). `--op <id> --log-pr <n>` records the
 *            train's status.md log PR on an existing op.
 *   message  read-only: the squash message one PR would land with right now.
 *   verify   after landing: checks each merge commit's trailers against the
 *            decision persisted before it merged, records interleaved foreign
 *            commits and the final merge OID, blocks publication on a `passed`
 *            claim that does not hold.
 *   abandon  marks an op abandoned — refused once any PR has merged.
 *
 * Exit codes: 0 ok · 1 error · 2 argv · 3 refused (fleet's convention).
 *
 * Every git/gh/store call goes through an injectable context, so the run*
 * functions are tested with fakes; `main()` wires the real ones.
 *
 * @module scripts/ship-train
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgvError, assertKnownFlags, emit, finishAndExit } from './lib/cli-io.mjs';
import { sanitizeGitEnv } from './lib/git-env-sanitize.mjs';
import { ReceiptError } from './lib/ship-train/receipt.mjs';
import {
  TrainRefusal, parsePrList, flagValue, runPlan, runPrepare, runMessage, runVerify, runAbandon,
} from './lib/ship-train/commands.mjs';

const VERBS = ['plan', 'prepare', 'message', 'verify', 'abandon'];
const KNOWN_FLAGS = [
  '--json', '--pr', '--waive', '--allow-unaudited', '--end-of-day', '--composer', '--op', '--log-pr', '--selfcheck-relocation',
];
const EXIT_REFUSED = 3;

// ── real context ────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    env: cmd === 'git' ? sanitizeGitEnv(cwd) : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function realContext(cwd) {
  const { getSyncClosure } = await import('./lib/sync-inventory.mjs');
  const store = await import('./lib/store/train-provenance.mjs');
  const { writePendingNote, resolveMainCheckout } = await import('./lib/worktree-preflight.mjs');
  const git = (args) => run('git', args, cwd);
  let repoSlug = null;
  return {
    cwd,
    git,
    gh: (args) => run('gh', args, cwd),
    repo: () => (repoSlug ??= run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd).trim()),
    fleetStatus: () => run(process.execPath, [path.join(SCRIPT_DIR, 'fleet.mjs'), 'status', '--json'], cwd),
    closure: () => new Set(getSyncClosure().files.map((f) => f.split(path.sep).join('/'))),
    gitCommonDir: () => path.resolve(cwd, git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()),
    store,
    writePendingNote: (sha, text) => writePendingNote(resolveMainCheckout((c, a) => run(c, a, cwd)), sha, text),
    now: () => new Date(),
  };
}

// ── main ────────────────────────────────────────────────────────────────────

function renderText(env) {
  if (env.verb === 'plan' || (env.verb === 'prepare' && env.prs && !env.opId)) {
    const out = [`ship train plan — ${env.repo} → ${env.destination.ref} @ ${env.destination.expectedOid.slice(0, 12)}`,
      `base pinning: ${env.basePinning.verdict} (${env.basePinning.evidence})`, `store: ${env.storeState}`];
    for (const p of env.prs) {
      const gate = p.decision ? `${p.decision.gate}${p.decision.runId ? ` run ${p.decision.runId.slice(0, 8)}` : ''}` : `REFUSED ${p.refusal.code}${p.refusal.override ? ` (override: ${p.refusal.override} ${p.pr})` : ''}`;
      out.push(`  #${p.pr} ${p.tier.padEnd(10)} ${gate.padEnd(28)} ${p.blockers.length ? `BLOCKED: ${p.blockers.join('; ')}` : 'fleet-ready'}  ${p.title}`);
      if (p.refusal) out.push(`      ${p.refusal.message}`);
    }
    out.push(env.due.due ? `due: yes (${env.due.triggers.join(', ')})` : `due: no — ${env.due.missing.join('; ')}`);
    out.push(env.trainReady ? 'train ready: yes — next: prepare' : 'train ready: no');
    return out.join('\n');
  }
  return JSON.stringify(env, null, 2);
}

export async function main(argv = process.argv) {
  if (argv.includes('--selfcheck-relocation')) { process.stdout.write('OK\n'); return finishAndExit(0); }
  const verb = argv[2];
  try {
    if (!VERBS.includes(verb)) throw new ArgvError(`ship-train: unknown verb ${JSON.stringify(verb ?? '')}. Verbs: ${VERBS.join(', ')}`);
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'ship-train', from: 3 });
    const composer = flagValue(argv, '--composer') ?? 'claude';
    if (!/^[a-z][a-z0-9.-]*$/.test(composer)) throw new ArgvError(`--composer "${composer}" is not a model-line token`);
    const logPrRaw = flagValue(argv, '--log-pr');
    const opts = {
      prs: parsePrList(argv, '--pr'),
      op: flagValue(argv, '--op'),
      logPr: logPrRaw ? parsePrList(['--log-pr', logPrRaw], '--log-pr')[0] : null,
      composer,
      overrides: { waive: parsePrList(argv, '--waive'), allowUnaudited: parsePrList(argv, '--allow-unaudited'), endOfDay: argv.includes('--end-of-day') },
    };
    const ctx = await realContext(process.cwd());
    const fn = { plan: runPlan, prepare: runPrepare, message: runMessage, verify: runVerify, abandon: runAbandon }[verb];
    const env = await fn(ctx, opts);
    if (argv.includes('--json')) emit(env); else process.stdout.write(`${renderText(env)}\n`);
    return finishAndExit(0);
  } catch (err) {
    if (err instanceof ArgvError) {
      process.stderr.write(`${err.message}\n`);
      return finishAndExit(2);
    }
    if (err instanceof TrainRefusal || err instanceof ReceiptError) {
      process.exitCode = EXIT_REFUSED;
      emit({ ok: false, verb, refused: true, code: err.code ?? 'REFUSED', message: err.message, ...(err.details ?? {}) });
      return finishAndExit(EXIT_REFUSED);
    }
    process.stderr.write(`ship-train ${verb}: ${err?.stack || err}\n`);
    return finishAndExit(1);
  }
}

// Direct-run guard, both sides canonicalised (fleet.mjs's pattern): a symlinked or
// differently-cased entry path must never turn a command into a silent no-op.
// --selfcheck-relocation stays the first statement of main().
const canon = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const here = canon(fileURLToPath(import.meta.url));
if (process.argv[1] && here === canon(path.resolve(process.argv[1]))) await main();
