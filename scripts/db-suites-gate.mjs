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
 * UNSCOPED by default, PATH-SCOPED only for a branch-tier push (gate census L-2, approved by Louis 2026-11-22). `npm run
 * check`, `/ship`, every push to the default branch and the `full` tier still run this gate in full. Only the pre-push
 * sandbox sets `AUDIT_PREPUSH_GATE_SCOPE=path`, and only when the tier ORACLE itself chose the branch tier for a push that
 * does not update the default branch (`scopeFromOracle`: a stale heavy list or a changed selector makes it full, and an
 * inherited value is cleared). Then the gate runs only when the explicit push range (`push-range.mjs`, never inferred)
 * touches something it reads. The earlier version of this paragraph rejected a path list because "a stale path list that
 * silently stops matching is the failure mode this repo has hit twice"; what changed is that the list is no longer a list:
 * `dbSuitesTriggers` DERIVES it from the import closure of the enrolled suites on every run, so enrolling a suite or
 * adding an import widens it by itself. Every uncertainty (unresolved range, git or tree unreadable, an import the closure
 * cannot resolve, a computed dynamic import nobody has acknowledged below) runs the gate, and a skip prints
 * `SKIPPED (path-scoped)` with its reason. Known limits, stated rather than hidden: the closure follows literal paths from
 * tests and from the container driver to anything, and from libraries to data files only (library prose names too many
 * scripts: following them reached 1,100 of 1,700 files); an acknowledged computed dynamic import is not followed; and the
 * sandbox's own checks of `.githooks/**` run before this gate. Backstops: the full run on every push to main and the CI
 * `postgres-parity` job.
 *
 * **Cost — `measured` 2026-08-11, and it SCALES, so do not read it as a
 * constant.** ~`22.2s` total on a 32-core Windows box (mean of 2 runs),
 * decomposed by the runner's own per-step output — run
 * `npm run db:suites:gate` and read it off, which is the point:
 *
 *   ~15.2s  the serial `ISOLATED_SUITE_FILES` block  ← the driver
 *    ~3.2s  docker preflight + image probe + container create + ready + teardown
 *    ~1.8s  `migrate`
 *    ~1.6s  the serial `DESTRUCTIVE_SUITE_FILES` block
 *    ~0.2s  `schema-diff`, ~0.2s the contract suite
 *
 * Add ~1.9s when the image is refreshed (`AUDIT_LOOP_DB_IMAGE_PULL=always`, or
 * a local image older than a week) — `decideImagePull` in db-test-container.mjs
 * explains why that is a weekly cost and not a per-push one.
 *
 * **The driver is the ENROLLED FILE COUNT, not the assertions.** That block runs
 * under `--test-concurrency=1` (those suites share one database and several
 * mutate schema, so serial is load-bearing, not incidental), and each file costs
 * ~513ms of fixed overhead — node startup plus a Postgres connection and its
 * fixtures — against only ~5.1s of actual test bodies across all twenty. So the
 * gate's cost is roughly `files x 0.5s + 7s`, and **enrolling a suite adds ~0.5s
 * whatever it asserts**.
 *
 * **Why this paragraph is written this way.** It previously read "~10s is
 * cheaper than that risk" — a bare figure with no date, no method and no driver.
 * It was accurate when written (`3b143bf6`, 2026-07-20), when the serial list
 * held ONE file; `e7e182ea` took it to twenty on 2026-08-11 and the number
 * silently became 2.4x wrong, in the sentence justifying the design. Per
 * AGENTS.md a figure carries its label and its command — and the more durable
 * fix is that `db-test-container.mjs` now reports every step's elapsed time, so
 * the live decomposition is read off a run rather than trusted from this
 * comment. If these numbers and a run disagree, **the run is right**.
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
import { fileURLToPath } from 'node:url';

import { ArgvError, assertKnownFlags, fmtMs } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { decideGateScope, importClosure, scopeLine } from './lib/gate-path-scope.mjs';
import { CONTRACT_SUITE_FILES, DESTRUCTIVE_SUITE_FILES, ISOLATED_SUITE_FILES } from './db-test-container.mjs';

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
 * @param {() => (boolean|{state: 'up'|'absent'|'unresponsive', detail?: string, timeoutMs?: number, attempts?: number})} io.dockerAvailable
 *   probe for a reachable daemon. A bare boolean is `up`/`absent`; the object form
 *   adds `unresponsive` — the daemon exists but did not answer in time — which is
 *   NOT the same finding as a daemon that is absent (see `probeDocker`).
 * @param {() => {status: number|null, error?: Error}} io.runSuites  run the suites
 * @param {(s: string) => void} io.write  stderr sink
 * @param {Record<string, string|undefined>} io.env
 * @param {() => number} [io.now]  clock, injected so the elapsed-time line is
 *   assertable without making a test wait for real seconds to pass
 * @returns {number} process exit code
 */
export function decide({ dockerAvailable, runSuites, write, env, now = Date.now }) {
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

  const probe = normaliseProbe(dockerAvailable());
  if (probe.state === 'unresponsive') {
    return skip(
      `Docker daemon did not answer \`docker info\` within ${fmtMs(probe.timeoutMs)}` +
      `${probe.attempts > 1 ? ` (${probe.attempts} attempts)` : ''} — busy or wedged, not known to be absent`,
    );
  }
  if (probe.state !== 'up') {
    return skip(`no reachable Docker daemon (\`docker info\` failed${probe.detail ? `: ${probe.detail}` : ''})`);
  }

  const startedAt = now();
  const res = runSuites();
  if (res.error) return skip(`could not spawn db-test-container.mjs (${res.error.message})`);

  switch (res.status) {
    case 0:
      // Report the total. This is the second-largest item in the `check` chain
      // and it used to say nothing about its own cost, so the only figure anyone
      // had was a comment — which is exactly how that comment came to be 2.4x
      // wrong for three weeks. A gate that states its cost cannot drift silently.
      write(`db-suites-gate: DB suites passed in ${fmtMs(now() - startedAt)}.\n`);
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
 * Per-attempt budget for `docker info`. **`measured` 2026-10-02: 46s** against a
 * daemon busy tearing down another session's container — more than twice the
 * 20s this probe used to allow, so a live daemon was reported as absent and the
 * whole DB seam skipped. 60s clears that with margin; a daemon that is genuinely
 * down fails in well under a second, so a generous budget costs nothing there.
 */
export const DOCKER_PROBE_TIMEOUT_MS = 60_000;
/** Attempts, retried ONLY after a timeout — a fast failure is an answer, not noise. */
export const DOCKER_PROBE_ATTEMPTS = 2;

/** @param {boolean|object} v @returns {{state: string, detail?: string, timeoutMs?: number, attempts?: number}} */
function normaliseProbe(v) {
  if (v && typeof v === 'object') return v;
  return { state: v ? 'up' : 'absent' };
}

/**
 * `docker info`, not `docker --version`: the CLI is routinely installed while
 * the daemon is down (the common Windows case), and reporting "docker present"
 * then failing to run is a lying diagnostic.
 *
 * Three outcomes, not two. `spawnSync` reports a timeout as `status: null` with
 * `error.code === 'ETIMEDOUT'`; collapsing that into "no daemon" is a probe that
 * went quiet when it could not tell — the same defect the gate exists to remove,
 * one layer down. A timeout is retried and, if it persists, reported as
 * `unresponsive` with its own reason. Any non-timeout failure is `absent`.
 *
 * @param {{spawn?: Function, timeoutMs?: number, attempts?: number}} [o]
 */
export function probeDocker({ spawn = spawnSync, timeoutMs = DOCKER_PROBE_TIMEOUT_MS, attempts = DOCKER_PROBE_ATTEMPTS } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const r = spawn('docker', ['info'], { stdio: 'ignore', timeout: timeoutMs });
    if (r.status === 0) return { state: 'up' };
    if (r.error?.code !== 'ETIMEDOUT') {
      const detail = r.error?.code || (r.status == null ? undefined : `exit ${r.status}`);
      return { state: 'absent', detail };
    }
  }
  return { state: 'unresponsive', timeoutMs, attempts };
}

function realRunSuites() {
  const root = repoRoot();
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'db-test-container.mjs'), 'suites'],
    { stdio: 'inherit', cwd: root },
  );
}

/**
 * What this gate reads, DERIVED from the pushed tree: the import closure (plus literally named repo paths) of every file
 * it executes: the enrolled suites, the container driver and the scoping code itself. Plus the two things that are data
 * rather than code: the migrations directory `setup-postgres.mjs --migrate` applies (a literal directory, so a prefix).
 * What every test shares and the tier selector's own files are added by `decideGateScope` for every scoped gate. The expected-schema fixture is named by a literal
 * in the driver, so the closure already holds it. The stale hand list `DB_SEAM_PREFIXES` is deliberately not consulted.
 */
export function dbSuitesTriggers(tree) {
  const roots = [
    ...ISOLATED_SUITE_FILES, ...DESTRUCTIVE_SUITE_FILES, ...CONTRACT_SUITE_FILES,
    'scripts/db-test-container.mjs', 'scripts/db-suites-gate.mjs', 'scripts/lib/gate-path-scope.mjs',
  ];
  const { files, uncertain, blind } = importClosure({
    roots,
    literalFrom: ['scripts/db-test-container.mjs'],
    skipLiteral: (lit) => /^tests\/[^/]+\.test\.mjs$/.test(lit),
    acknowledgedComputed: ACKNOWLEDGED_COMPUTED_IMPORTS,
    tree,
  });
  // `tests/fixtures/` as a prefix: a suite may enumerate a fixture DIRECTORY, which no literal path names.
  return { files, prefixes: ['supabase/migrations/', 'tests/fixtures/'], uncertain, blind };
}

/**
 * Computed a dynamic import edges inside the closure that were READ and judged unable to reach the DB suites, each with the
 * reason. A NEW computed import in the closure is not on this list, so it is `uncertain` and the gate runs in full until a
 * person reads it and adds it here (tests/gate-path-scope.test.mjs fails when an entry no longer matches a live one).
 */
export const ACKNOWLEDGED_COMPUTED_IMPORTS = Object.freeze({
  'scripts/lib/test-tier.mjs': { calls: 1, reason: 'the text a dynamic import in comments and messages, no dynamic import call' },
  'scripts/ux-lock-run.mjs': { calls: 1, reason: 'the word in an error message (alias imports), no dynamic import call' },
  'scripts/lib/anthropic-client.mjs': { calls: 1, reason: 'optional provider SDK packages (bare specifiers, so package.json is the input, and it is one)' },
  'scripts/learning/replay.mjs': { calls: 1, reason: 'imports an operator-supplied policy module path (a CLI argument); no DB suite runs it' },
  'scripts/lib/sync-isolation-verify.mjs': { calls: 1, reason: 'imports the consumer-sync verification target; a sync tool the DB suites never execute' },
  'tests/helpers/audit-capture-oldschema-child.mjs': { calls: 4, reason: 'its targets are named as literal `new URL(\'scripts/...\')` paths, which the literal scan follows (and the test that spawns it names the helper)' },
});

function main() {
  // Before the selfcheck branch: a typo'd flag must be refused, not silently
  // dropped into a full suite run the operator did not ask for.
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'db-suites-gate' });
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  // Path-scoping (gate census L-2): only ever active for a branch-tier push from the pre-push sandbox; every uncertainty
  // runs the gate. A skip is printed, never silent.
  const scope = decideGateScope({ gate: 'db-suites-gate', env: process.env, cwd: repoRoot(), triggers: dbSuitesTriggers });
  process.stderr.write(scopeLine('db-suites-gate', scope));
  if (!scope.run) return 0;
  return decide({
    dockerAvailable: () => probeDocker(),
    runSuites: realRunSuites,
    write: (s) => process.stderr.write(s),
    env: process.env,
  });
}

// Only self-execute as a CLI, so the module stays importable by its tests.
if (isInvokedAsScript(import.meta.url)) {
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
