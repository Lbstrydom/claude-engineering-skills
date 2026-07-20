#!/usr/bin/env node
/**
 * @fileoverview Pre-push gate wrapper around `db-test-container.mjs suites`.
 *
 * Runs the destructive DB integration suites against an ephemeral local
 * Postgres as part of `npm run check`, so the DB seam is covered by the same
 * gate as everything else.
 *
 * Why this exists. The DB suites are `assertDisposableDbUrl`-gated, so without
 * a disposable DSN they do not run — and node's test runner reports a suite
 * that never ran as a clean 0-test pass. `npm run check` therefore read GREEN
 * over the entire DB seam. The documented fallback was
 * `.github/workflows/postgres-parity.yml`, but on 2026-07-20 that workflow was
 * found to have failed 20 consecutive runs since 2026-07-18: its schema-diff
 * step aborts the job BEFORE any test step, so the suites had not executed
 * anywhere — local or CI — for two days. A fix landing that day was verified
 * only because someone spun a container by hand.
 *
 * Lives in `check` (not the pre-push hook body) deliberately: `check` runs
 * inside the prepush sandbox worktree, at the commit being pushed. Running
 * this from the hook would test the WORKING TREE instead, which is the exact
 * false-pass/false-block problem `prepush-check.mjs` exists to eliminate.
 *
 * Deliberately UNSCOPED — it runs on every check rather than only when a
 * path list says the DB seam changed. A stale path list that silently stops
 * matching is the failure mode this repo has hit twice; ~10s is cheaper than
 * that risk.
 *
 * Exit-code policy (the whole point of this wrapper). `db-test-container.mjs`
 * distinguishes a real failure from an environmental one, and only the former
 * may block a push:
 *
 *   0        → suites passed.
 *   1        → a suite or the schema-diff FAILED. Blocks. This is the signal.
 *   2        → docker/port problem (daemon down, port taken, image pull).
 *   3        → another invocation owns the container (concurrent session).
 *
 * 2 and 3 are environment, not evidence of a defect, so they degrade to a loud
 * advisory. Per the AGENTS.md sandbox-honesty rule a tolerated skip needs a
 * strictness flag, so `AUDIT_LOOP_DB_TESTS_REQUIRED=1` promotes every skip
 * (including a missing docker binary) to a hard failure — set it in any
 * environment where DB coverage must be real rather than best-effort.
 *
 * @module scripts/db-suites-gate
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ArgvError, assertKnownFlags } from './lib/cli-io.mjs';

/** Every flag this CLI accepts. Enforced below — see `cli:flags:gate`. */
const KNOWN_FLAGS = Object.freeze(['--selfcheck-relocation']);

/** Resolve repo root from this file's location (survives the sandbox worktree). */
export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Decide the gate's outcome. PURE — every effect (probing docker, spawning the
 * runner, writing output) is injected, so all six paths are testable without a
 * Docker daemon.
 *
 * That injectability is not gold-plating: the paths that MUST be exercised are
 * precisely the ones a normal machine cannot reach (no daemon, port taken,
 * concurrent owner), and they are the paths where a mistake reads GREEN. An
 * earlier draft of this file called `spawnSync` directly and ran
 * `process.exit(main())` at module scope, which made it unimportable and left
 * its own degradation paths unverifiable — the same "cannot fail visibly"
 * shape it exists to remove.
 *
 * @param {object} io
 * @param {() => boolean} io.dockerAvailable  probe for a reachable daemon
 * @param {() => {status: number|null, error?: Error}} io.runSuites  run the suites
 * @param {(s: string) => void} io.write  stderr sink
 * @param {Record<string, string|undefined>} io.env
 * @returns {number} process exit code
 */
export function decide({ dockerAvailable, runSuites, write, env }) {
  const required = env.AUDIT_LOOP_DB_TESTS_REQUIRED === '1';
  const optedOut = env.AUDIT_LOOP_DB_TESTS_SKIP === '1';

  // Honest by construction: always states the suites did NOT run, never
  // implies coverage, and names the flag that makes it fatal.
  const skip = (reason) => {
    write(
      `db-suites-gate: ${required ? 'FAIL' : 'SKIPPED'} — ${reason}\n` +
      '  The destructive DB suites did NOT run; the DB seam is UNVERIFIED by this check.\n' +
      '  Run them locally with: npm run db:local\n' +
      (required
        ? '  AUDIT_LOOP_DB_TESTS_REQUIRED=1 is set, so this is a hard failure.\n'
        : '  Set AUDIT_LOOP_DB_TESTS_REQUIRED=1 to make this a hard failure.\n'),
    );
    return required ? 1 : 0;
  };

  // REQUIRED beats the opt-out — otherwise the escape hatch would silently
  // defeat the strictness flag, and "required" would not mean required.
  if (optedOut && !required) return skip('AUDIT_LOOP_DB_TESTS_SKIP=1 (operator opt-out)');

  if (!dockerAvailable()) return skip('no reachable Docker daemon (`docker info` failed)');

  const res = runSuites();
  if (res.error) return skip(`could not spawn db-test-container.mjs (${res.error.message})`);

  switch (res.status) {
    case 0:
      return 0;
    case 2:
      return skip('docker/port problem starting the test container (exit 2)');
    case 3:
      return skip('another invocation owns the test container (exit 3) — concurrent session');
    default:
      // Includes 1 (suite/schema-diff failure) and any unmapped code. Fails
      // CLOSED: an exit code we do not recognise is not evidence of success.
      write(
        `db-suites-gate: DB suites FAILED (exit ${res.status}) — push blocked.\n` +
        '  This is a real failure, not an environment problem. Reproduce with: npm run db:local\n',
      );
      return 1;
  }
}

/**
 * `docker info`, not `docker --version`: the CLI is routinely installed while
 * the daemon is down (the common Windows case), and reporting "docker present"
 * then failing to run is a lying diagnostic.
 */
function realDockerAvailable() {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20000 });
  return r.status === 0;
}

function realRunSuites() {
  const root = repoRoot();
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'db-test-container.mjs'), 'suites'],
    { stdio: 'inherit', cwd: root },
  );
}

function main() {
  // Before the selfcheck branch: a typo'd flag must be refused, not silently
  // dropped into a full suite run the operator did not ask for.
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'db-suites-gate' });
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  return decide({
    dockerAvailable: realDockerAvailable,
    runSuites: realRunSuites,
    write: (s) => process.stderr.write(s),
    env: process.env,
  });
}

// Only self-execute as a CLI, so the module stays importable by its tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(main());
  } catch (err) {
    // A usage mistake is not a crash. Print the diagnostic alone and exit 2,
    // matching the other guarded CLIs — burying "unknown flag" under a stack
    // trace is how an operator concludes the tool is broken and retries
    // WITHOUT the flag, which here would silently skip the DB gate.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`db-suites-gate: fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  }
}
