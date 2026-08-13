/**
 * @fileoverview Test runner shim — spawns `node --test` with the AMBIENT
 * provider-ROUTING env scrubbed, so the suite's verdict is a function of the
 * repo, never of the operator's shell.
 *
 * **Why a runner and not a per-suite scrub or a preload** (all three were
 * tried or probed before this shape was chosen, 2026-07-18):
 *
 * - Per-suite `beforeEach` scrubbing CANNOT work for Azure routing:
 *   `azureConfig` is a module-load-time snapshot (`buildAzureConfig(process.env)`
 *   in config.mjs), frozen before any test hook runs. The anthropic-client
 *   suite's beforeEach scrub works only because that client resolves env at
 *   CALL time — mirroring the pattern here would have been a fake fix that
 *   scrubs after the routing decision is already taken.
 * - `node --test --import <scrub>` does NOT propagate the preload to the test
 *   runner's per-file child processes (probed empirically on Node 22.19) —
 *   only the coordinator process would be scrubbed.
 * - Per-test-file "import the scrub first" is per-file discipline, and
 *   scrub-list-vs-resolution-list drift is this week's demonstrated failure
 *   mode (the anthropic hygiene block saved 3 of the 4 vars the factory
 *   resolves). One choke point beats N conventions.
 *
 * **The trust boundary this enforces**: the repo's own `.env` (loaded by
 * dotenv transitively via model-resolver → config) and `~/.audit-loop.env`
 * are TRUSTED config — dotenv loads them inside each child AFTER this scrub,
 * so their values survive. The ambient shell is NOT trusted: agent harnesses
 * inject provider vars into every shell they spawn (Claude Code desktop
 * injects `ANTHROPIC_BASE_URL`; found 2026-07-18 when 15 tests failed inside
 * the harness and passed outside it), and corporate machines carry work-profile
 * Azure vars. Empirically, before this runner: a hostile ambient
 * `AZURE_OPENAI_ENDPOINT` flipped 3 real test verdicts (the audit-plan/rebuttal
 * smoke tests inherit `{...process.env}` into their own children, and
 * model-ab-egress's public-path assertion consumes the load-time snapshot).
 *
 * **Scrub ROUTING SELECTORS only, never credentials.** CI and developers
 * legitimately inject API keys via env (that is how CI secrets work); a key
 * with no routing selector is inert for verdicts. Scrubbing keys would break
 * real workflows; scrubbing selectors converges every machine to the
 * CI-verified baseline.
 *
 * Usage: `npm test` (default globs) · `npm test -- tests/foo.test.mjs [args]`
 * (forwarded verbatim to `node --test`).
 *
 * @module scripts/run-tests
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GUARD_REPORT_VERSION } from './lib/test-guard-reporter.mjs';

/**
 * Ambient provider-ROUTING vars scrubbed from the child env. Enumerated from
 * the resolution sources, not guessed:
 * - config.mjs `buildAzureConfig(env)` — every `env.AZURE_*` it reads except
 *   the credential (`AZURE_OPENAI_API_KEY`, deliberately kept: credential,
 *   inert without a selector).
 * - anthropic-client.mjs — `ANTHROPIC_BASE_URL` (the harness-injected one),
 *   `CLAUDE_BACKEND` (transport selector; the repo's `.env` value resurrects
 *   via dotenv inside the child, so only shell-injected values die).
 * - the OpenAI SDK itself reads `OPENAI_BASE_URL` ambiently, which would
 *   flip every public-path baseURL assertion.
 */
export const SCRUBBED_ROUTING_ENV = Object.freeze([
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_AI_ENDPOINT',
  'AZURE_OPENAI_GPT_DEPLOYMENT',
  'AZURE_FOUNDRY_CLAUDE_DEPLOYMENT',
  'AZURE_FOUNDRY_SUMMARY_DEPLOYMENT',
  'AZURE_OPENAI_EMBED_DEPLOYMENT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_CLAUDE_API_SHAPE',
  'AZURE_FOUNDRY_API_PATH',
  'AZURE_CLAUDE_ROUTE',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'CLAUDE_BACKEND',
]);

/** Pure: a copy of `env` with the routing selectors removed. Exported so the
 *  hermeticity regression test asserts against THIS list, not a duplicate. */
export function scrubRoutingEnv(env) {
  const out = { ...env };
  for (const k of SCRUBBED_ROUTING_ENV) delete out[k];
  return out;
}

/**
 * Ambient TEST-RUNNER state that must not reach the child. A separate list from
 * the routing selectors above because it is a different hazard with a different
 * rationale — the two should not be conflated when either is edited.
 *
 * `NODE_TEST_CONTEXT` is set by node in every test child process. If it leaks
 * into a `node --test` invocation, the runner decides it is already inside a
 * test context, warns "run() is being called recursively", **skips running
 * files entirely — and exits 0**. That is a total false green: zero tests
 * executed, reported as a pass. It bites whenever the runner is invoked from
 * inside a test (which `tests/test-env-hermeticity.test.mjs` does deliberately).
 * Measured on Node 22.19, 2026-08-11.
 */
export const SCRUBBED_RUNNER_ENV = Object.freeze(['NODE_TEST_CONTEXT']);

/** Pure: the full child env — routing selectors AND runner state removed. */
export function scrubChildEnv(env) {
  const out = scrubRoutingEnv(env);
  for (const k of SCRUBBED_RUNNER_ENV) delete out[k];
  return out;
}

/** The default file set — kept byte-identical to the pre-runner npm script. */
const DEFAULT_ARGS = ['tests/*.test.mjs', 'tests/claudemd/*.test.mjs', 'tests/install/*.test.mjs'];

/** The guard reporter, as a file URL resolved from THIS file's location — node
 *  resolves a RELATIVE reporter specifier against cwd, which would break the
 *  runner when invoked from anywhere but the repo root. */
const GUARD_REPORTER = pathToFileURL(path.join(import.meta.dirname, 'lib', 'test-guard-reporter.mjs')).href;

/**
 * Build the `--test-reporter` argv pairs.
 *
 * The guard reporter is ALWAYS appended, so the false-green check cannot be
 * silently dropped by how the runner was invoked. Naming any reporter replaces
 * node's implicit default, so when the caller has not named one we restate
 * node's own rule (TTY → `spec`, else `tap`) explicitly — that keeps the
 * developer-visible output byte-identical to what it was before the guard.
 *
 * Node pairs reporters with destinations POSITIONALLY, so the guard's pair is
 * appended last as a unit and never interleaves with a caller's.
 *
 * @param {string[]} forwarded - argv the caller forwarded to `npm test`.
 * @param {{isTTY: boolean, reportPath: string}} opts
 * @returns {string[]} argv fragment to splice in ahead of the file globs.
 */
export function buildReporterArgs(forwarded, { isTTY, reportPath }) {
  const callerNamedReporter = forwarded.some((a) => a.startsWith('--test-reporter'));
  const base = callerNamedReporter
    ? []
    : ['--test-reporter', isTTY ? 'spec' : 'tap', '--test-reporter-destination', 'stdout'];
  return [...base, '--test-reporter', GUARD_REPORTER, '--test-reporter-destination', reportPath];
}

/**
 * Decide the runner's real verdict from the child's exit status plus the guard
 * report. Pure, so the suite can drive every branch without spawning anything.
 *
 * Fails CLOSED on a missing or unreadable report: a guard whose output is
 * absent has checked nothing, and "checked nothing" must never read as a pass
 * (the repo's sandbox-honesty rule). The reporter emits even in the
 * zero-failure case precisely so absence is unambiguous.
 *
 * @param {{status: number|null, reportText: string|null}} input
 * @returns {{exitCode: number, message: string|null}}
 */
export function adjudicateRun({ status, reportText }) {
  // Signal-kill, or the child already failed: the runner's own verdict stands.
  // The guard exists only to close the green-when-actually-failed direction, so
  // there is nothing to add here.
  if (status === null) return { exitCode: 1, message: null };
  if (status !== 0) return { exitCode: status, message: null };

  if (reportText === null) {
    return {
      exitCode: 1,
      message: 'test-guard: the guard reporter produced no report, so nothing verified that the '
        + 'exit code reflects the results. Refusing to report a pass on an unchecked run.',
    };
  }

  let report;
  try {
    report = JSON.parse(reportText);
  } catch {
    return { exitCode: 1, message: `test-guard: the guard report was unparseable — refusing to pass. Raw: ${reportText.slice(0, 200)}` };
  }

  if (report?.version !== GUARD_REPORT_VERSION) {
    return {
      exitCode: 1,
      message: `test-guard: report version ${JSON.stringify(report?.version)} is not the expected `
        + `${GUARD_REPORT_VERSION} — the reporter and the reader have drifted.`,
    };
  }

  if (!Array.isArray(report.failures)) {
    // Right version, wrong shape — the reporter is broken in a way that would
    // otherwise coerce to "zero failures", i.e. exactly the false green this
    // guard exists to stop. Refuse rather than default to clean.
    return { exitCode: 1, message: 'test-guard: the report carried no `failures` array — the reporter is malformed. Refusing to read that as a clean run.' };
  }

  const { failures } = report;
  if (failures.length === 0) return { exitCode: 0, message: null };

  // The whole point: node reported these and still exited 0.
  const lines = failures.map((f) => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '<unknown location>';
    const kind = f.type === 'suite' ? 'SUITE (died at construction — its tests never ran)' : 'test';
    return `  - ${kind}: ${f.name}\n      at ${where}\n      ${f.error ?? '<no message>'}`;
  });
  return {
    exitCode: 1,
    message: 'test-guard: the test runner exited 0, but reported '
      + `${failures.length} failure(s) it did not carry into its exit code:\n${lines.join('\n')}\n`
      + 'A suite that throws while being CONSTRUCTED is reported as `not ok` but counted in '
      + 'neither `# fail` nor the exit code, so the run reads green while those tests never ran. '
      + 'Fix the listed failure(s); do not suppress this guard.',
  };
}

function main() {
  const forwarded = process.argv.slice(2);
  const args = forwarded.length > 0 ? forwarded : DEFAULT_ARGS;

  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-guard-'));
  const reportPath = path.join(reportDir, 'report.json');

  // NOTE: no try/finally around the exit — `process.exit()` does not run
  // `finally` blocks, so cleanup happens explicitly before exiting.
  const reporterArgs = buildReporterArgs(forwarded, {
    isTTY: Boolean(process.stdout.isTTY),
    reportPath,
  });
  const res = spawnSync(process.execPath, ['--test', ...reporterArgs, ...args], {
    stdio: 'inherit',
    env: scrubChildEnv(process.env),
  });

  let reportText = null;
  try {
    reportText = fs.readFileSync(reportPath, 'utf-8');
  } catch {
    reportText = null;   // adjudicateRun fails closed on this.
  }
  fs.rmSync(reportDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  const { exitCode, message } = adjudicateRun({ status: res.status, reportText });
  if (message) process.stderr.write(`\n${message}\n`);
  process.exit(exitCode);
}

// Import-safe: tests import { scrubRoutingEnv } without spawning anything.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main();
}
