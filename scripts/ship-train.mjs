#!/usr/bin/env node
/**
 * @fileoverview Ship trains — the machinery behind `/ship --train`.
 *
 * One human `/ship --train` lands several already-audited PRs: one status.md
 * entry, per-PR provenance written into each squash commit, one combined test
 * run (fleet), one consumer sync. Plan: docs/plans/ship-trains.md.
 *
 * Stateless (plan §2.8): ship-train persists nothing of its own. Every verb
 * recomputes from owned state — fleet's train manifest, GitHub, git and the
 * audit store — so there is no ship-train record to go stale or race.
 *
 * Verbs in this cluster (none of them merges anything):
 *   plan     read-only: per ship-ready PR, its impact tier, the audit run bound
 *            to it by CONTENT, the planned AI-Gate or the refusal, and whether
 *            a train is due.
 *   message  read-only: the squash message one PR would land with right now.
 *   verify   after landing: proves each merged PR is the source the train
 *            tested, checks that every AI-* claim on its squash commit is TRUE,
 *            and reports the final merge OID, interleaved commits and the
 *            publication verdict. `--write-note` files the actual gates and
 *            deviations for the next status entry.
 *
 * Exit codes: 0 ok · 1 error · 2 argv · 3 refused (fleet's convention).
 *
 * Every git/gh/store/fleet call goes through an injectable context, so the
 * verbs (scripts/lib/ship-train/commands.mjs) are tested with fakes; `main()`
 * wires the real ones. Only this CLI imports fleet modules — the library takes
 * them through the context, so it adds no edge into fleet.
 *
 * @module scripts/ship-train
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgvError, assertKnownFlags, emit, finishAndExit } from './lib/cli-io.mjs';
import { sanitizeGitEnv } from './lib/git-env-sanitize.mjs';
import {
  TrainRefusal, parsePrList, flagValue, hasOption, githubSlugFromUrl, runPlan, runMessage, runVerify,
} from './lib/ship-train/commands.mjs';

const VERBS = ['plan', 'message', 'verify'];
const KNOWN_FLAGS = [
  '--json', '--pr', '--waive', '--allow-unaudited', '--end-of-day', '--composer', '--train', '--write-note', '--selfcheck-relocation',
];
const EXIT_REFUSED = 3;

// ── real context ────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * gh's environment minus the variables that silently re-point it at another
 * repository or host (round-1 code M5): every gh call here names its repo with
 * -R, and the repo itself is resolved from THIS checkout, never from GH_REPO.
 */
function ghEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GH_(REPO|HOST)$/i.test(k)) delete env[k];
  return env;
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    env: cmd === 'git' ? sanitizeGitEnv(cwd) : ghEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function realContext(cwd) {
  const { getSyncClosure } = await import('./lib/sync-inventory.mjs');
  const store = await import('./lib/store/train-provenance.mjs');
  const { writePendingNote, resolveMainCheckout } = await import('./lib/worktree-preflight.mjs');
  const { fleetDir, readTrain } = await import('./lib/fleet/registry.mjs');
  const { classifyUpdatedHead } = await import('./lib/fleet/serial.mjs');
  const { defaultDeps } = await import('./lib/fleet/train.mjs');
  const git = (args) => run('git', args, cwd);
  const fleetDeps = defaultDeps();
  let repoSlug = null;
  return {
    cwd,
    git,
    gh: (args) => run('gh', args, cwd),
    // The repo is the one `origin` fetches from — never gh's own default-repo
    // setting, which can point elsewhere.
    repo: () => (repoSlug ??= githubSlugFromUrl(git(['remote', 'get-url', 'origin']))),
    fleetStatus: () => run(process.execPath, [path.join(SCRIPT_DIR, 'fleet.mjs'), 'status', '--json'], cwd),
    readTrain: (id) => readTrain(fleetDir(cwd), id),
    // Fleet's own oracle for "is head h serial's clean base-only update of priorHead".
    classifyUpdate: ({ trainId, remote, base, pr, h, priorHead }) => classifyUpdatedHead({
      deps: fleetDeps, cwd, s: { prNumber: pr }, run: { trainId, remote, base }, h, priorHead,
    }),
    closure: () => new Set(getSyncClosure().files.map((f) => f.split(path.sep).join('/'))),
    store,
    writePendingNote: (sha, text) => writePendingNote(resolveMainCheckout((c, a) => run(c, a, cwd)), sha, text),
    now: () => new Date(),
  };
}

// ── main ────────────────────────────────────────────────────────────────────

function renderText(env) {
  if (env.verb === 'plan') {
    const out = [`ship train plan — ${env.repo} → ${env.destination.ref} @ ${env.destination.expectedOid.slice(0, 12)}`,
      `base pinning: ${env.basePinning.verdict} (${env.basePinning.evidence})`, `store: ${env.storeState}`];
    for (const p of env.prs) {
      const gate = p.decision ? `${p.decision.gate}${p.decision.runId ? ` run ${p.decision.runId.slice(0, 8)}` : ''}` : `REFUSED ${p.refusal.code}${p.refusal.override ? ` (override: ${p.refusal.override} ${p.pr})` : ''}`;
      out.push(`  #${p.pr} ${p.tier.padEnd(10)} ${gate.padEnd(28)} ${p.blockers.length ? `BLOCKED: ${p.blockers.join('; ')}` : 'fleet-ready'}  ${p.title}`);
      if (p.refusal) out.push(`      ${p.refusal.message}`);
    }
    out.push(env.due.due ? `due: yes (${env.due.triggers.join(', ')})` : `due: no — ${env.due.missing.join('; ')}`);
    out.push(env.trainReady ? 'train ready: yes — next: write the train log, then fleet land' : 'train ready: no');
    return out.join('\n');
  }
  if (env.verb === 'verify') {
    const out = [`ship train verify — ${env.trainId} (store: ${env.storeState})`,
      `final merge: ${env.finalMergeOid ?? 'none'}`,
      `actual gates: ${Object.entries(env.actualGates).map(([pr, g]) => `#${pr} ${g}`).join(', ') || 'none'}`];
    for (const d of env.deviations) out.push(`  ! ${d}`);
    for (const n of env.notes) out.push(`  · ${n}`);
    out.push(env.clearance.clear ? 'publication: clear'
      : `publication: BLOCKED — ${env.clearance.blocks.map((b) => `${b.reason}${b.flag ? ` [${b.flag}]` : ' [no override]'}`).join('; ')}`);
    if (env.pendingNote) out.push(`pending-note: ${env.pendingNote}`);
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
    // Declared, not evidenced: the model running /ship --train names itself. No
    // silent default — an omitted flag would publish a guess as a participant.
    const composer = flagValue(argv, '--composer');
    if (['plan', 'message'].includes(verb) && !composer) {
      throw new ArgvError('--composer <model-line> is required: the model composing the squash messages (e.g. --composer claude)');
    }
    if (composer && !/^[a-z][a-z0-9.-]*$/.test(composer)) throw new ArgvError(`--composer "${composer}" is not a model-line token`);
    const train = flagValue(argv, '--train');
    if (train !== null && !/^t-\d{14}-[0-9a-f]{4}$/.test(train)) throw new ArgvError(`--train "${train}" is not a fleet train id (t-<14 digits>-<4 hex>)`);
    const opts = {
      prs: parsePrList(argv, '--pr'),
      train,
      writeNote: hasOption(argv, '--write-note'),
      composer,
      overrides: { waive: parsePrList(argv, '--waive'), allowUnaudited: parsePrList(argv, '--allow-unaudited'), endOfDay: hasOption(argv, '--end-of-day') },
    };
    const ctx = await realContext(process.cwd());
    const fn = { plan: runPlan, message: runMessage, verify: runVerify }[verb];
    const env = await fn(ctx, opts);
    if (hasOption(argv, '--json')) emit(env); else process.stdout.write(`${renderText(env)}\n`);
    return finishAndExit(0);
  } catch (err) {
    if (err instanceof ArgvError) {
      process.stderr.write(`${err.message}\n`);
      return finishAndExit(2);
    }
    if (err instanceof TrainRefusal) {
      process.exitCode = EXIT_REFUSED;
      emit({ ok: false, verb, refused: true, message: err.message, ...(err.details ?? {}) });
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
