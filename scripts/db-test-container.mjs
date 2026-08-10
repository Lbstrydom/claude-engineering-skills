#!/usr/bin/env node
/**
 * @fileoverview Ephemeral local Docker Postgres (pgvector/pg16) test
 * container — makes the destructive DB integration suites and
 * `tests/fixtures/expected-schema.json` regeneration runnable locally,
 * mirroring `.github/workflows/postgres-parity.yml`'s `db-suite` job.
 *
 * Root cause this exists: after the 2026-07-14 production wipe (INC-002),
 * `assertDisposableDbUrl` (scripts/lib/db/client.mjs) refuses to run the
 * destructive suites against anything but a genuinely disposable DSN — so
 * in practice they only ran in CI, where a throwaway service container
 * exists. This CLI provisions the local equivalent without weakening or
 * bypassing that guard.
 *
 * Env discipline mirrors CI exactly (the load-bearing subtlety): steps 1/2/5
 * get `AUDIT_DB_URL`; steps 3/4 (destructive `AUDIT_DB_TEST_URL` consumers)
 * get `AUDIT_DB_URL` DELETED from the inherited env, not merely "not set" —
 * an operator-exported `AUDIT_DB_URL` would otherwise leak in and, if it
 * happened to equal the container DSN, false-positive the guard's equality
 * check. See `buildStepEnv`.
 *
 * Plan: docs/plans/local-db-test-container.md.
 *
 * Usage:
 *   node scripts/db-test-container.mjs [suites|regen-schema|up|down]
 *     [--keep] [--port <n>] [--selfcheck-relocation]
 *
 * @module scripts/db-test-container
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import { assertRepoRoot, findRepoRootFromScript } from './lib/assert-repo-root.mjs';

// ── CI-parity constants (single source; guarded by tests/db-test-container.test.mjs) ──

export const DB_TEST_IMAGE = 'pgvector/pgvector:pg16';
export const CONTAINER_NAME = 'ces-db-test';
export const DEFAULT_PORT = 5433;

export const DESTRUCTIVE_SUITE_FILES = Object.freeze([
  'tests/db-date-parser.test.mjs',
  'tests/db-withtx.test.mjs',
  'tests/db-setup.test.mjs',
]);
// Suites that need the migrated schema INTACT, so they must run BEFORE the
// destructive step (db-setup.test.mjs does DROP SCHEMA PUBLIC CASCADE). Their
// own step, never appended to a shared invocation: `node --test a b` sorts
// files ALPHABETICALLY, so argument order is not execution order (found
// 2026-07-15). `--test-concurrency=1` because all three share one Postgres.
//
// Kept in lockstep with the identical list in
// .github/workflows/postgres-parity.yml — a file registered here but not there
// (or vice versa) runs in one environment only, which is how
// regression-spec-multi-finding-lock.test.mjs came to be committed and then
// never executed by the DB job at all.
export const ISOLATED_SUITE_FILES = Object.freeze([
  // campaign-adjudication's LIVE half needs the campaign spine migrated and
  // intact; its pure half runs everywhere and is a no-op here.
  'tests/campaign-adjudication.test.mjs',
  'tests/db-schema-realization-live.test.mjs',
  'tests/regression-spec-multi-finding-lock.test.mjs',
  'tests/symbol-index-drift-justification.test.mjs',
]);
export const CONTRACT_SUITE_FILES = Object.freeze([
  'tests/learning-store-contract.test.mjs',
]);

// Subset of the CI workflow's `paths:` filter — the diff-scope matcher for
// the pre-push DB-seam advisory. Kept here (not in the hook) so one place
// owns the list; the hook script sources it via a small inline copy that
// the unit test asserts stays in lockstep (see tests/db-test-container.test.mjs).
export const DB_SEAM_PREFIXES = Object.freeze([
  'scripts/lib/db/',
  'scripts/lib/store/',
  'supabase/migrations/',
  'tests/db-',
  'scripts/setup-postgres.mjs',
  'tests/fixtures/expected-schema.json',
]);

const RUNNING_CONFLICT_MESSAGE =
  `container ${CONTAINER_NAME} is already running — another invocation may own it; ` +
  `run \`npm run db:local down\` if it's yours and idle`;

// ── Pure helpers (exported for hermetic unit tests) ─────────────────────────

/** @param {number} port */
export function buildDsn(port) {
  return `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
}

// Steps that consume AUDIT_DB_TEST_URL (the destructive guard) — every one
// of them gets AUDIT_DB_URL actively deleted from the inherited env, not
// merely omitted (Gemini-G2: the rule follows the variable, applies to
// EVERY such step, not just the historically-first one).
const DESTRUCTIVE_GUARD_STEPS = new Set(['drift-justification', 'destructive-suites']);

/**
 * Pure env-assembly for one workload step. `parentEnv` defaults to
 * `process.env` but is overridable so the unit test can assert the
 * deletion behaviour against a deliberately polluted fake env.
 *
 * @param {'migrate'|'schema-diff'|'drift-justification'|'destructive-suites'|'contract'} stepName
 * @param {string} dsn
 * @param {NodeJS.ProcessEnv} [parentEnv]
 */
export function buildStepEnv(stepName, dsn, parentEnv = process.env) {
  const env = { ...parentEnv };
  if (DESTRUCTIVE_GUARD_STEPS.has(stepName)) {
    delete env.AUDIT_DB_URL;
    env.AUDIT_DB_TEST_URL = dsn;
  } else {
    env.AUDIT_DB_URL = dsn;
  }
  env.AUDIT_DB_SSL_MODE = 'disable';
  return env;
}

const KNOWN_FLAGS = new Set(['--port', '--keep', '--selfcheck-relocation']);
const KNOWN_MODES = ['suites', 'regen-schema', 'up', 'down'];

/** @param {string[]} argv */
export function parseArgs(argv) {
  let mode = null;
  let keep = false;
  let portArg = String(DEFAULT_PORT);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { portArg = argv[i + 1]; i++; continue; }
    if (a === '--keep') { keep = true; continue; }
    if (a === '--selfcheck-relocation') continue; // handled earlier in main(); harmless here
    if (a.startsWith('--')) {
      if (!KNOWN_FLAGS.has(a)) throw new Error(`Unknown flag "${a}" — expected one of: ${[...KNOWN_FLAGS].join(', ')}`);
      continue;
    }
    if (mode !== null) throw new Error(`Unexpected extra argument "${a}" — mode was already set to "${mode}"`);
    mode = a; // first non-flag token is the mode
  }
  mode = mode || 'suites';
  if (!KNOWN_MODES.includes(mode)) {
    throw new Error(`Unknown mode "${mode}" — expected ${KNOWN_MODES.join('|')}`);
  }
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be a valid TCP port (1-65535), got "${portArg}"`);
  }
  return { mode, keep, port };
}

/**
 * Classify a failed `docker run`'s stderr (Gemini-G1) — a name conflict
 * (lost the create-race, or a genuinely running prior container) is
 * exit 3; anything else, including a port/bind conflict, is exit 2 with
 * the real stderr surfaced (never masked as a concurrency race).
 *
 * @param {string} stderrText
 * @param {number} port
 */
export function classifyRunFailure(stderrText, port) {
  const text = stderrText || '';
  if (/is already in use by container/i.test(text)) {
    return { exitCode: 3, message: RUNNING_CONFLICT_MESSAGE };
  }
  if (/(bind|address already in use|port is already allocated|failed to set up container networking)/i.test(text)) {
    return {
      exitCode: 2,
      message: `docker run failed — port ${port} appears unavailable:\n${text}\nTry a different port: --port <other-port>`,
    };
  }
  return { exitCode: 2, message: `docker run failed:\n${text}` };
}

// ── Real (non-injected) primitives ──────────────────────────────────────────

/** Tracks the most recently spawned inherited-stdio child, for signal cleanup. */
let _activeChild = null;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeoutMs?: number, capture?: boolean, env?: NodeJS.ProcessEnv, cwd?: string}} [opts]
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
function realExec(cmd, args, opts = {}) {
  const { timeoutMs = 0, capture = true, env = process.env, cwd = process.cwd() } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (!capture) _activeChild = child;
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
    }
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (_activeChild === child) _activeChild = null;
      resolve({ code: null, signal: null, stdout, stderr: stderr || String(err.message), timedOut: false });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (_activeChild === child) _activeChild = null;
      resolve({ code: timedOut ? null : code, signal: timedOut ? 'SIGKILL' : signal, stdout, stderr, timedOut });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Readiness = a real host-side TCP connect via the `pg` client, not
 * `docker exec pg_isready` (which can see the image's *temporary*
 * initdb server) and not a fixed sleep. Bounded: 500ms interval, 60s cap.
 *
 * @param {number} port
 * @param {{intervalMs?: number, timeoutMs?: number}} [opts]
 */
async function defaultWaitForReady(port, { intervalMs = 500, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const client = new pg.Client({
      host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres',
      connectionTimeoutMillis: Math.min(intervalMs * 2, 2000),
    });
    try {
      await client.connect();
      await client.end();
      return { ok: true };
    } catch (err) {
      lastError = err;
      try { await client.end(); } catch { /* not connected */ }
      await sleep(intervalMs);
    }
  }
  return { ok: false, error: lastError };
}

// ── Lifecycle state machine (injectable `exec`/`waitForReady` for tests) ────

/**
 * @param {{exec?: Function, waitForReady?: Function, stderr?: NodeJS.WritableStream, repoRoot?: string}} [deps]
 */
export function createLifecycle(deps = {}) {
  const exec = deps.exec || realExec;
  const waitForReady = deps.waitForReady || defaultWaitForReady;
  const stderr = deps.stderr || process.stderr;
  const repoRoot = deps.repoRoot || findRepoRootFromScript(import.meta.url) || process.cwd();

  let ownedContainerId = null;
  let tornDown = false;
  let runTmpDir = null;

  /** Idempotent — safe to call from both the run() epilogue and a signal handler. */
  async function teardown() {
    if (tornDown) return { ok: true, skipped: true };
    tornDown = true;
    let ok = true;
    if (ownedContainerId) {
      const res = await exec('docker', ['rm', '-f', '-v', ownedContainerId], { timeoutMs: 10000, capture: true });
      if (res.code !== 0) {
        ok = false;
        stderr.write(
          `[db-test-container] teardown failed (docker rm -f -v ${ownedContainerId}): ${res.stderr || res.code}\n` +
          `  container may still be running — check \`docker ps\` / \`npm run db:local down\`\n`,
        );
      }
    }
    if (runTmpDir) {
      try { fs.rmSync(runTmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
    }
    return { ok };
  }

  /**
   * Announce a scratch dir that `--keep` deliberately leaves on disk.
   *
   * `--keep` skips teardown() — which is where the scratch dir is removed —
   * so its live-schema.json survives for debugging. That retention is
   * intentional; its SILENCE was not. An unannounced survivor is
   * indistinguishable from a leak, which is exactly how 23 husks accumulated
   * unnoticed (2026-08-01). If we choose to leave something behind, say so
   * and name the path.
   */
  function writeKeptScratchNotice() {
    if (runTmpDir) stderr.write(`  scratch artifacts kept: ${runTmpDir}\n`);
  }

  /** Best-effort kill of the active inherited-stdio child, then teardown. Used by signal handling. */
  async function abort() {
    if (_activeChild) { try { _activeChild.kill('SIGTERM'); } catch { /* already dead */ } }
    return teardown();
  }

  async function runStep(name, cmd, args, env) {
    stderr.write(`[db-test-container] step "${name}": ${cmd} ${args.join(' ')}\n`);
    const res = await exec(cmd, args, { env, capture: false, cwd: repoRoot });
    if (res.code !== 0) {
      stderr.write(`[db-test-container] step "${name}" failed (exit ${res.code}${res.timedOut ? ', timed out' : ''})\n`);
      return false;
    }
    return true;
  }

  async function runSchemaDiffStep(dsn, outPath) {
    const env = buildStepEnv('schema-diff', dsn);
    const ok = await runStep(
      'schema-diff',
      'node',
      ['scripts/postgres-parity/generate-expected-schema.mjs', '--out', outPath],
      env,
    );
    if (!ok) return false;
    if (outPath === path.join(repoRoot, 'tests', 'fixtures', 'expected-schema.json')) {
      // regen-schema mode writes directly to the committed fixture — nothing to diff against.
      return true;
    }
    try {
      const { _internals: setup } = await import('./setup-postgres.mjs');
      const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/expected-schema.json'), 'utf-8'));
      const live = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
      const diff = setup.diffSchemas(expected, live);
      if (diff.length > 0) {
        stderr.write(`[db-test-container] schema drift detected:\n${JSON.stringify(diff, null, 2)}\n`);
        return false;
      }
      return true;
    } catch (err) {
      stderr.write(`[db-test-container] schema-diff comparison failed: ${err.message}\n`);
      return false;
    }
  }

  /**
   * @param {'suites'|'regen-schema'|'up'|'down'} mode
   * @param {{port?: number, keep?: boolean}} [opts]
   * @returns {Promise<number>} exit code
   */
  async function run(mode, opts = {}) {
    const port = opts.port || DEFAULT_PORT;

    // ── preflight ──
    const v = await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10000, capture: true });
    if (v.code !== 0) {
      stderr.write(
        `[db-test-container] Docker preflight failed — is Docker Desktop running?\n` +
        `  ${v.stderr || 'docker version returned exit ' + v.code}\n` +
        `  If Docker/WSL is wedged, see the 2026-07-16 recovery note in project memory ` +
        `(taskkill wsl.exe zombies, cycle WSLService, restart com.docker.service).\n`,
      );
      return 2;
    }

    // ── down mode: explicit, by-name, idempotent teardown ──
    if (mode === 'down') {
      const insp = await exec('docker', ['inspect', CONTAINER_NAME, '--format', '{{.State.Running}}'], { timeoutMs: 10000, capture: true });
      if (insp.code !== 0) return 0; // absent — idempotent
      const rm = await exec('docker', ['rm', '-f', '-v', CONTAINER_NAME], { timeoutMs: 10000, capture: true });
      if (rm.code !== 0) {
        stderr.write(`[db-test-container] down failed: ${rm.stderr || rm.code}\n`);
        return 1;
      }
      return 0;
    }

    // ── pull (visible progress; kept separate from `run` so a slow first
    //    pull doesn't eat into `run`'s bounded timeout) ──
    const pull = await exec('docker', ['pull', DB_TEST_IMAGE], { timeoutMs: 600000, capture: false });
    if (pull.code !== 0) {
      stderr.write(`[db-test-container] failed to pull ${DB_TEST_IMAGE} (exit ${pull.code})\n`);
      return 2;
    }

    // ── state-aware reconcile: remove only a STOPPED stale container; a
    //    RUNNING one is a conflict, never implicitly removed ──
    const insp = await exec('docker', ['inspect', CONTAINER_NAME, '--format', '{{.State.Running}}'], { timeoutMs: 10000, capture: true });
    if (insp.code === 0) {
      if (insp.stdout.trim() === 'true') {
        stderr.write(`[db-test-container] ${RUNNING_CONFLICT_MESSAGE}\n`);
        return 3;
      }
      const rmStale = await exec('docker', ['rm', '-f', '-v', CONTAINER_NAME], { timeoutMs: 10000, capture: true });
      if (rmStale.code !== 0) {
        stderr.write(`[db-test-container] failed to remove stale container: ${rmStale.stderr || rmStale.code}\n`);
        return 2;
      }
    }
    // insp.code !== 0 → absent, nothing to reconcile.

    // ── start (ownership = the container ID THIS invocation's run printed) ──
    const runRes = await exec('docker', [
      'run', '-d', '--name', CONTAINER_NAME,
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=postgres',
      '-p', `127.0.0.1:${port}:5432`,
      DB_TEST_IMAGE,
    ], { timeoutMs: 120000, capture: true });
    if (runRes.code !== 0) {
      const classified = classifyRunFailure(runRes.stderr, port);
      stderr.write(`[db-test-container] ${classified.message}\n`);
      return classified.exitCode; // no container owned — nothing to tear down
    }
    ownedContainerId = runRes.stdout.trim();

    const dsn = buildDsn(port);

    // ── readiness ──
    const ready = await waitForReady(port, { intervalMs: 500, timeoutMs: 60000 });
    if (!ready.ok) {
      stderr.write(`[db-test-container] readiness poll timed out after 60s: ${ready.error?.message || 'unknown error'}\n`);
      await teardown();
      return 2;
    }

    // ── workload ──
    // NOTE: the scratch dir is created LAZILY, inside the one branch that
    // writes to it (see 'suites' below). It used to be created here, for every
    // mode — but only 'suites' ever uses it, and 'up' returns without calling
    // teardown() by design, so every `db:local up` left an EMPTY
    // ces-db-test-* directory in %TEMP% forever. Measured 2026-08-01: 23 husks
    // spanning Jul 16 – Aug 1, 22 of them empty. Don't hoist this back up.
    let workloadOk = true;

    if (mode === 'up') {
      workloadOk = await runStep('migrate', 'node', ['scripts/setup-postgres.mjs', '--migrate'], buildStepEnv('migrate', dsn));
      if (workloadOk) {
        stderr.write(
          `[db-test-container] up — container ${ownedContainerId.slice(0, 12)} ready.\n` +
          `  AUDIT_DB_URL=${dsn}\n  AUDIT_DB_TEST_URL=${dsn}\n` +
          `  Tear down with: npm run db:local down\n`,
        );
      }
      // 'up' never tears down (that's the point) — always "keep".
      return workloadOk ? 0 : 1;
    }

    if (mode === 'regen-schema') {
      workloadOk = await runStep('migrate', 'node', ['scripts/setup-postgres.mjs', '--migrate'], buildStepEnv('migrate', dsn));
      if (workloadOk) {
        workloadOk = await runSchemaDiffStep(dsn, path.join(repoRoot, 'tests', 'fixtures', 'expected-schema.json'));
      }
    } else {
      // mode === 'suites' — the only mode that writes a scratch artifact
      // (live-schema.json), so the only one that needs a temp dir at all.
      runTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-db-test-'));
      workloadOk = await runStep('migrate', 'node', ['scripts/setup-postgres.mjs', '--migrate'], buildStepEnv('migrate', dsn));
      if (workloadOk) {
        workloadOk = await runSchemaDiffStep(dsn, path.join(runTmpDir, 'live-schema.json'));
      }
      if (workloadOk) {
        workloadOk = await runStep(
          'drift-justification', 'node', ['--test', '--test-concurrency=1', ...ISOLATED_SUITE_FILES],
          buildStepEnv('drift-justification', dsn),
        );
      }
      if (workloadOk) {
        workloadOk = await runStep(
          'destructive-suites', 'node', ['--test', '--test-concurrency=1', ...DESTRUCTIVE_SUITE_FILES],
          buildStepEnv('destructive-suites', dsn),
        );
      }
      if (workloadOk) {
        workloadOk = await runStep('contract', 'node', ['--test', ...CONTRACT_SUITE_FILES], buildStepEnv('contract', dsn));
      }
    }

    // ── teardown / exit-code precedence ──
    // A workload failure always wins: exit 1 regardless of teardown outcome
    // (the failing suite is the operator's signal; a leftover container is
    // cleaned up by the next invocation's reconcile or `down`).
    if (!workloadOk) {
      if (opts.keep) {
        stderr.write('[db-test-container] --keep set — leaving container up despite workload failure.\n');
        writeKeptScratchNotice();
      } else {
        await teardown();
      }
      return 1;
    }
    if (opts.keep) {
      stderr.write(`[db-test-container] --keep set — container ${ownedContainerId.slice(0, 12)} left running. Tear down with: npm run db:local down\n`);
      writeKeptScratchNotice();
      return 0;
    }
    const td = await teardown();
    return td.ok ? 0 : 4; // teardown-only failure after a green workload
  }

  return { run, teardown, abort };
}

// ── CLI entry point ──────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertRepoRoot(import.meta.url);

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  const lifecycle = createLifecycle({ exec: realExec, waitForReady: defaultWaitForReady });

  let exiting = false;
  const onSignal = (sig) => {
    if (exiting) return;
    exiting = true;
    process.stderr.write(`\n[db-test-container] received ${sig} — cleaning up...\n`);
    lifecycle.abort().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const code = await lifecycle.run(opts.mode, opts);
  process.exit(code);
}

// Direct-execution guard (R2-M3): importing this module for its constants/
// helpers in the hermetic unit test must never trigger Docker preflight or
// container startup.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}

export const _internals = Object.freeze({ createLifecycle, realExec, defaultWaitForReady, RUNNING_CONFLICT_MESSAGE });
