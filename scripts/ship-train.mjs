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
 * Verbs:
 *   plan     read-only: per ship-ready PR, its impact tier, the audit run bound
 *            to it by CONTENT, the planned AI-Gate or the refusal, and whether
 *            a train is due.
 *   message  read-only: the squash message one PR would land with right now.
 *   land     MERGES. Drives fleet's serial landing of a built, approvable train;
 *            fleet calls back at merge time and each squash commit gets the
 *            message decided on the exact head being merged. A stop is resumable
 *            with --resume. Only ever on the user's go-ahead (`/ship --train`).
 *   verify   after landing: proves each merged PR is the source the train
 *            tested, checks that every AI-* claim on its squash commit is TRUE,
 *            and reports the final merge OID, interleaved commits and the
 *            publication verdict. `--write-note` files the actual gates and
 *            deviations for the next status entry.
 *   sync     re-verifies in the same invocation, then publishes the final merge
 *            to consumers from a clean detached worktree. Re-runnable.
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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgvError, assertKnownFlags, emit, finishAndExit } from './lib/cli-io.mjs';
import { sanitizeGitEnv } from './lib/git-env-sanitize.mjs';
import { withFileLock, LockTimeoutError } from './lib/file-lock.mjs';
import {
  TrainRefusal, parsePrList, flagValue, hasOption, githubSlugFromUrl, messageChildArgv,
  runPlan, runMessage, runVerify, runLand, runSync,
} from './lib/ship-train/commands.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

const VERBS = ['plan', 'message', 'land', 'verify', 'sync'];
const KNOWN_FLAGS = [
  '--json', '--pr', '--waive', '--allow-unaudited', '--end-of-day', '--composer', '--train', '--write-note',
  '--resume', '--accept-rerun', '--accept-interleaved', '--accept-provenance-mismatch', '--selfcheck-relocation',
];
/** The verbs that decide a squash message, and so need the composing model named. */
const NEEDS_COMPOSER = ['plan', 'message', 'land'];
const EXIT_REFUSED = 3;
/**
 * Deadlines for the two kinds of child. The message child runs INSIDE fleet's serial lease, so a hang
 * there would hold it; publication runs the consumer sync tools, which touch every consumer and open PRs.
 */
const MESSAGE_CHILD_TIMEOUT_MS = 5 * 60 * 1000;
const PUBLISH_CHILD_TIMEOUT_MS = 30 * 60 * 1000;

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
  const { classifyUpdatedHead, approveSerial, resumeSerial } = await import('./lib/fleet/serial.mjs');
  const { resolveConfig } = await import('./lib/fleet/config.mjs');
  const { defaultDeps } = await import('./lib/fleet/train.mjs');
  const pinned = await import('./lib/pinned-worktree/manage.mjs');
  const pinnedPaths = await import('./lib/pinned-worktree/paths.mjs');
  const git = (args) => run('git', args, cwd);
  const fleetDeps = defaultDeps();
  let repoSlug = null;
  // .fleet.json's requiredChecks, exactly as `fleet land` reads it: a config that fails to load is
  // carried as an ERROR (the inventory then reads unknown), never as "nothing declared".
  const fleetLandOptions = () => {
    try {
      const cfg = resolveConfig(cwd, { env: process.env });
      return { requiredChecks: cfg.requiredChecks, timeoutMs: cfg.serialTimeoutMs };
    } catch (e) { return { requiredChecksError: e.message }; }
  };
  const nodeChild = (childCwd, args, timeout) => spawnSync(process.execPath, args, {
    cwd: childCwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: ghEnv(), timeout,
  });
  const timedOut = (r) => r.error?.code === 'ETIMEDOUT';
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
    // Fleet's serial landing, with the squash-message callback (plan §2.4).
    serial: {
      approve: ({ trainId, acceptRerun, messageFor }) => approveSerial({ cwd, trainId, acceptRerun, deps: fleetDeps, messageFor, ...fleetLandOptions() }),
      resume: ({ trainId, messageFor }) => resumeSerial({ cwd, trainId, deps: fleetDeps, messageFor, ...fleetLandOptions() }),
    },
    // The SAME `message` verb a human previews with, as a child: fleet's serial loop is synchronous.
    messageSync: ({ pr, composer, overrides }) => {
      const r = nodeChild(cwd, [path.join(SCRIPT_DIR, 'ship-train.mjs'), ...messageChildArgv({ pr, composer, overrides })], MESSAGE_CHILD_TIMEOUT_MS);
      if (timedOut(r)) throw new Error(`the message child timed out after ${MESSAGE_CHILD_TIMEOUT_MS / 1000}s; --resume once the store and GitHub respond`);
      if (r.error) throw r.error;
      if (r.status !== 0 && r.status !== 3) throw new Error(`the message child exited ${r.status}: ${String(r.stderr ?? '').slice(-500)}`);
      try { return JSON.parse(r.stdout); } catch { throw new Error(`the message child printed unparseable output: ${String(r.stdout ?? '').slice(0, 200)}`); }
    },
    gitIn: (dir, args) => run('git', args, dir),
    runNode: (dir, args) => {
      const r = nodeChild(dir, args, PUBLISH_CHILD_TIMEOUT_MS);
      const why = timedOut(r) ? `timed out after ${PUBLISH_CHILD_TIMEOUT_MS / 1000}s` : (r.error ? String(r.error) : '');
      return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${why}` };
    },
    // One publication per train. Refuses at once rather than waiting: the holder is mid-publication.
    lease: async (train, fn) => {
      const root = pinnedPaths.defaultFixtureRoot(pinnedPaths.resolveMainRoot(cwd));
      fs.mkdirSync(root, { recursive: true });
      try {
        return await withFileLock(path.join(root, `ship-train-${train}.lock`), { maxWaitMs: 0 }, fn);
      } catch (err) {
        if (err instanceof LockTimeoutError) throw new TrainRefusal(`another ship-train sync of ${train} is running (its lock is held); wait for it, then re-run`, { trainId: train });
        throw err;
      }
    },
    // The publication worktree: a clean, detached checkout at an exact revision. A leftover from an
    // interrupted sync is cleared first (removal is idempotent), because the fixture refuses to reuse one.
    fixture: {
      create: ({ name, rev }) => {
        const dir = pinnedPaths.fixturePath(pinnedPaths.defaultFixtureRoot(pinnedPaths.resolveMainRoot(cwd)), name);
        pinned.removeFixture({ dir, cwd });
        return pinned.createFixture({ name, rev, cwd });
      },
      verify: ({ dir, expectedSha }) => pinned.verifyFixture({ dir, expectedSha }),
      remove: ({ dir }) => pinned.removeFixture({ dir, cwd }),
    },
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
  if (env.verb === 'land') {
    return [`ship train land — ${env.trainId}: landed`,
      ...env.merges.map((m) => `  #${m.pr} merged at ${String(m.mergedHead).slice(0, 12)} → ${String(m.mergeCommit).slice(0, 12)}`),
      `next: ${env.next}`].join('\n');
  }
  if (env.verb === 'sync') {
    return [`ship train sync — ${env.trainId}: published ${env.finalMergeOid.slice(0, 12)}`,
      ...env.steps.map((s) => `  ${s.name}: exit ${s.status}`),
      `  not part of this publication: ${env.newerOnDestination} newer commit(s) on the destination`,
      ...env.acknowledged.map((a) => `  acknowledged: ${a}`),
      `  ${env.cleanup}`, `pending-note: ${env.pendingNote}`].join('\n');
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
    if (NEEDS_COMPOSER.includes(verb) && !composer) {
      throw new ArgvError('--composer <model-line> is required: the model composing the squash messages (e.g. --composer claude)');
    }
    if (composer && !/^[a-z][a-z0-9.-]*$/.test(composer)) throw new ArgvError(`--composer "${composer}" is not a model-line token`);
    const train = flagValue(argv, '--train');
    if (train !== null && !/^t-\d{14}-[0-9a-f]{4}$/.test(train)) throw new ArgvError(`--train "${train}" is not a fleet train id (t-<14 digits>-<4 hex>)`);
    const opts = {
      prs: parsePrList(argv, '--pr'),
      train,
      writeNote: hasOption(argv, '--write-note'),
      resume: hasOption(argv, '--resume'),
      acceptRerun: hasOption(argv, '--accept-rerun'),
      // Acknowledgements are read only from THIS invocation, never from anything stored.
      acks: { acceptInterleaved: hasOption(argv, '--accept-interleaved'), acceptProvenanceMismatch: hasOption(argv, '--accept-provenance-mismatch') },
      composer,
      overrides: { waive: parsePrList(argv, '--waive'), allowUnaudited: parsePrList(argv, '--allow-unaudited'), endOfDay: hasOption(argv, '--end-of-day') },
    };
    const ctx = await realContext(process.cwd());
    const fn = { plan: runPlan, message: runMessage, land: runLand, verify: runVerify, sync: runSync }[verb];
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

// Direct-run guard, both sides canonicalised (lib/cli-entry.mjs): a symlinked or
// differently-cased entry path must never turn a command into a silent no-op.
// --selfcheck-relocation stays the first statement of main().
if (isInvokedAsScript(import.meta.url)) await main();
