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
 * - `node --test --import <scrub>` was recorded here as NOT propagating the preload
 *   to the per-file child processes (probed on Node 22.19). Re-probed 2026-10-12 on
 *   v22.23.2 it is the other way round: the preload runs in every per-file child and
 *   NOT in the runner process (`--disable-warning` is inherited by both). That does not
 *   reopen the choice — a preload still cannot scrub the routing env of the process that
 *   spawns the children, and the other reason stands.
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
 * (forwarded verbatim to `node --test`) · `npm run test:preflight` (the default set
 * minus PREFLIGHT_SKIPPED_FILES; NOT the gate — see below).
 *
 * **Per-file cost is printed at the end of every run** (stderr), from a second reporter
 * (scripts/lib/test-timing-reporter.mjs) that is deliberately independent of the guard:
 * it can only ever add lines, never change the verdict. Plan: docs/plans/gate-cost-slice-1.md.
 *
 * @module scripts/run-tests
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertKnownFlags, hasFlag } from './lib/cli-io.mjs';
import { GUARD_REPORT_VERSION } from './lib/test-guard-reporter.mjs';
import { TIMING_REPORT_ENV, ranFiles, ranFilesUnavailableReason, summariseTiming } from './lib/test-timing-report.mjs';

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
 *
 * `TEST_TIMING_KEEP` is an instruction to THIS runner (copy the timing report here). A
 * test that spawns the runner would otherwise inherit it and a nested run would write
 * to the operator's path: observed 2026-10-12, a nested runner clobbered a measurement
 * file mid-run. The runner reads it from its own env before scrubbing.
 */
export const SCRUBBED_RUNNER_ENV = Object.freeze(['NODE_TEST_CONTEXT', 'TEST_TIMING_KEEP']);

/** Pure: the full child env — routing selectors AND runner state removed. */
export function scrubChildEnv(env) {
  const out = scrubRoutingEnv(env);
  for (const k of SCRUBBED_RUNNER_ENV) delete out[k];
  return out;
}

/** The default file set — kept byte-identical to the pre-runner npm script. */
const DEFAULT_DIRS = Object.freeze(['tests', 'tests/claudemd', 'tests/install']);
const DEFAULT_ARGS = DEFAULT_DIRS.map((d) => `${d}/*.test.mjs`);

/**
 * Files `npm run test:preflight` leaves out, in ONE place. Each entry is a repo-relative
 * path directly inside one of DEFAULT_DIRS, with the reason beside it.
 *
 * `tests/fleet-cli.test.mjs`: before #214 it was 132 cases, 96% of one measured run's wall time
 * but 13% of its summed test time (node runs a file's tests serially, so a file is a floor on wall
 * time). #214 split it into 10 files; the original now holds 36 of the 132 tests and is still the
 * largest of the family, which is all that is claimed here: the post-split tree has NOT been
 * re-measured. Re-measure with the command in docs/runbooks/gate-cost.md and, if this file is no
 * longer among the slowest, replace it with whatever is (the list must stay non-empty).
 * Preflight is for catching a late guard-test failure cheaply BEFORE the first push; the gate
 * still runs everything.
 */
export const PREFLIGHT_SKIPPED_FILES = Object.freeze([
  Object.freeze({
    file: 'tests/fleet-cli.test.mjs',
    why: 'the largest remaining part of the fleet-cli family after #214 (36 of its 132 tests); not re-measured',
  }),
]);

// A third reporter (tap + timing + guard) crosses node's default listener ceiling of 10 and printed
// "MaxListenersExceededWarning" on every run. The ceiling is raised in the runner process only, by the
// timing reporter importing scripts/lib/test-runner-listener-ceiling.mjs; no node flag is used, because
// every flag is inherited by the test files' processes (where it hid a real leak) or, for `--import`,
// does not reach the runner at all. tests/run-tests-timing.test.mjs pins all three facts.

const SKIP_NAME_RE = /^[\w.-]+\.test\.mjs$/;

/**
 * Decide the file arguments for `node --test`.
 *
 * Preflight uses NEGATED GLOBS, not a file list: the default set is 927 files and 34,209
 * characters joined, over the 32,767-character limit on a Windows command line, so a list
 * cannot even be launched here. `<dir>/!(a|b).test.mjs` is an observed capability of
 * node's glob engine (measured on v22.23.2), not a documented one, so the runner checks
 * the selection AFTER the run (finishRun) rather than trusting it.
 *
 * @param {{preflight?: boolean, exists?: (p: string) => boolean, skipped?: ReadonlyArray<{file: string, why: string}>}} [opts]
 * @returns {{args: string[], skipped: Array<{file: string, why: string}>}}
 * @throws {Error} on a malformed or missing skip-list entry, or a skip list that would empty a run
 */
export function selectTestArgs({ preflight = false, exists = fs.existsSync, skipped = PREFLIGHT_SKIPPED_FILES } = {}) {
  if (!preflight) return { args: [...DEFAULT_ARGS], skipped: [] };

  /** @type {Map<string, string[]>} dir -> basenames without the .test.mjs suffix */
  const byDir = new Map();
  for (const { file } of skipped) {
    const dir = path.posix.dirname(file);
    const base = path.posix.basename(file);
    if (!DEFAULT_DIRS.includes(dir) || !SKIP_NAME_RE.test(base)) {
      throw new Error(`PREFLIGHT_SKIPPED_FILES entry "${file}" must be directly inside one of ${DEFAULT_DIRS.join(', ')} and match ${SKIP_NAME_RE}`);
    }
    if (!exists(file)) throw new Error(`PREFLIGHT_SKIPPED_FILES entry "${file}" does not exist; remove or fix it`);
    byDir.set(dir, [...(byDir.get(dir) ?? []), base.slice(0, -'.test.mjs'.length)]);
  }
  const args = DEFAULT_DIRS.map((d) => (byDir.has(d) ? `${d}/!(${byDir.get(d).join('|')}).test.mjs` : `${d}/*.test.mjs`));
  return { args, skipped: skipped.map((x) => ({ ...x })) };
}

/**
 * The files a preflight is EXPECTED to run: every default-set file minus the declared ones.
 * Compared with what the run reports having executed.
 */
export function expectedPreflightFiles({ readdir = fs.readdirSync, skipped = PREFLIGHT_SKIPPED_FILES } = {}) {
  const skip = new Set(skipped.map((x) => x.file));
  const out = new Set();
  for (const d of DEFAULT_DIRS) {
    for (const name of readdir(d)) {
      const rel = `${d}/${name}`;
      if (name.endsWith('.test.mjs') && !skip.has(rel)) out.add(rel);
    }
  }
  // A skip list that removes everything would "pass" having run nothing.
  if (out.size === 0) throw new Error('the preflight selection is empty: PREFLIGHT_SKIPPED_FILES removes every default test file');
  return out;
}

/**
 * Split argv at the POSIX `--` terminator: options are looked for only before it, and the
 * terminator and everything after it are forwarded to node untouched.
 *
 * @param {string[]} argv
 * @returns {{head: string[], tail: string[]}}
 */
export function partitionArgs(argv) {
  const i = argv.indexOf('--');
  return i < 0 ? { head: [...argv], tail: [] } : { head: argv.slice(0, i), tail: argv.slice(i) };
}

const REPORTER_FLAG = '--test-reporter';
const DESTINATION_FLAG = '--test-reporter-destination';

/**
 * Take the caller's reporter and destination flags out of `argv` and return them as BALANCED
 * pairs, plus everything else in order.
 *
 * Node pairs the i-th `--test-reporter` with the i-th `--test-reporter-destination` across the
 * whole argv and REFUSES a run where the counts differ (ERR_INVALID_ARG_VALUE, measured on
 * v22.23.2); only a single reporter with no destination is accepted. The runner adds a
 * reporter of its own on top of the caller's, so a caller who names a reporter without a
 * destination (`npm test -- --test-reporter=dot`, the common spelling) used to hit that error.
 * A reporter with no destination gets `stdout`, node's own default for the one-reporter case.
 * A destination with no reporter is left unmatched so node reports the caller's mistake.
 *
 * AMBIGUITY IS LEFT TO NODE. Whether a bare dash option takes a value is node's arity table, and
 * this function does not copy it (a second copy of node's CLI, per version, is the thing not to
 * build). A reporter-looking token right after a bare dash option is either a new option (after a
 * boolean flag) or a mistake node refuses (`--test-name-pattern --test-reporter=dot`: node says
 * "--test-name-pattern requires an argument"). We cannot tell which, and guessing wrong in the
 * second case turned node's refusal into a run that selected nothing and PASSED (code audit round 4,
 * H1: the extracted token left `--test-name-pattern` to swallow the file name). So such a token is
 * left where it is, the argv reaches node as written, and node decides. The cost is that
 * `--test-only --test-reporter=dot` is also left alone and node then refuses the unbalanced
 * reporters, loudly, as it did before this function existed; put the reporter first, or give it a
 * destination. A later token that is not preceded by a bare dash option is extracted as usual.
 *
 * @param {string[]} argv
 * @returns {{pairs: string[], others: string[]}}
 */
export function extractReporterFlags(argv) {
  const reporters = [];
  const destinations = [];
  const others = [];
  // The last token left in `others`, or undefined when the previous token was consumed here. A dash
  // option with no `=` may own the next token as its value, so the next token is not ours to read.
  let prev;
  const mayOwnNext = (t) => t !== undefined && t.startsWith('-') && !t.includes('=');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!mayOwnNext(prev)) {
      if (a === REPORTER_FLAG && i + 1 < argv.length) { reporters.push(argv[++i]); prev = undefined; continue; }
      if (a.startsWith(`${REPORTER_FLAG}=`)) { reporters.push(a.slice(REPORTER_FLAG.length + 1)); prev = undefined; continue; }
      if (a === DESTINATION_FLAG && i + 1 < argv.length) { destinations.push(argv[++i]); prev = undefined; continue; }
      if (a.startsWith(`${DESTINATION_FLAG}=`)) { destinations.push(a.slice(DESTINATION_FLAG.length + 1)); prev = undefined; continue; }
    }
    others.push(a);
    prev = a;
  }
  const pairs = reporters.flatMap((r, i) => [REPORTER_FLAG, r, DESTINATION_FLAG, destinations[i] ?? 'stdout']);
  for (const extra of destinations.slice(reporters.length)) pairs.push(DESTINATION_FLAG, extra);
  return { pairs, others };
}

/** The guard reporter, as a file URL resolved from THIS file's location — node
 *  resolves a RELATIVE reporter specifier against cwd, which would break the
 *  runner when invoked from anywhere but the repo root. */
const GUARD_REPORTER = pathToFileURL(path.join(import.meta.dirname, 'lib', 'test-guard-reporter.mjs')).href;
const TIMING_REPORTER = pathToFileURL(path.join(import.meta.dirname, 'lib', 'test-timing-reporter.mjs')).href;

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
 * @param {{isTTY: boolean, reportPath: string, timingEnabled?: boolean}} opts
 * @returns {string[]} argv fragment to splice in ahead of the file globs.
 */
export function buildReporterArgs(forwarded, { isTTY, reportPath, timingEnabled = false }) {
  const callerNamedReporter = forwarded.some((a) => a.startsWith('--test-reporter'));
  const base = callerNamedReporter
    ? []
    : ['--test-reporter', isTTY ? 'spec' : 'tap', '--test-reporter-destination', 'stdout'];
  // The timing reporter yields nothing and writes its own file (TIMING_REPORT_ENV), so the
  // destination it is paired with is only there to keep node's positional pairing intact.
  // It goes BEFORE the guard pair: the guard stays contiguous and last in this fragment, and
  // the whole fragment precedes any forwarded flag, so a caller's later reporter without a
  // destination pairs with nothing and defaults to stdout instead of stealing ours.
  const timing = timingEnabled ? ['--test-reporter', TIMING_REPORTER, '--test-reporter-destination', 'stdout'] : [];
  return [...base, ...timing, '--test-reporter', GUARD_REPORTER, '--test-reporter-destination', reportPath];
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

/**
 * Everything the runner prints and exits with after the child has finished. Pure.
 *
 * The exit code is `adjudicateRun`'s, computed from the SAME inputs it always was: the
 * timing report is read only for lines to print, so no timing input — absent, garbage,
 * wrong version, partial, valid — can move the verdict of an ordinary run. The exception is
 * a PREFLIGHT, where the timing report is also the only evidence of WHICH files ran: if its
 * selection is positively wrong (it ran a declared-skipped file, or missed an expected one),
 * OR cannot be verified at all (no usable report, or a partial one), it fails. A preflight
 * that may have run the wrong files and still says "pass" is the vacuous pass this repo's
 * honesty rule exists to refuse (audit round 1, H3); the cost of failing closed is one
 * re-run, and the message says which.
 *
 * @param {{status: number|null, reportText: string|null, timingText?: string|null,
 *          preflight?: {skipped: Array<{file: string, why: string}>, expected: Set<string>}|null}} input
 * @returns {{exitCode: number, lines: string[]}}
 */
export function finishRun({ status, reportText, timingText = null, preflight = null }) {
  const verdict = adjudicateRun({ status, reportText });
  const lines = [];
  if (verdict.message) lines.push(verdict.message);
  lines.push(...summariseTiming(timingText).lines);

  let exitCode = verdict.exitCode;
  if (preflight) {
    const ran = ranFiles(timingText);
    if (ran === null) {
      if (exitCode === 0) exitCode = 1;
      lines.push(`Preflight: selection UNVERIFIED (${ranFilesUnavailableReason(timingText)}), so it cannot be confirmed that the right files ran. Failing rather than reporting a pass; re-run, or use npm test.`);
    } else {
      const skippedSet = new Set(preflight.skipped.map((x) => x.file));
      const ranSkipped = [...ran].filter((x) => skippedSet.has(x)).sort();
      const missing = [...preflight.expected].filter((x) => !ran.has(x)).sort();
      if (ranSkipped.length || missing.length) {
        if (exitCode === 0) exitCode = 1;
        lines.push('Preflight: the files that ran are not the files that were selected.');
        if (ranSkipped.length) lines.push(`  ran although declared skipped: ${ranSkipped.join(', ')}`);
        if (missing.length) lines.push(`  expected but did not run: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`);
      }
    }
    lines.push(
      'PREFLIGHT — this was NOT the gate. Skipped: ' + preflight.skipped.map((x) => `${x.file} (${x.why})`).join('; ') + '.',
      'A pass here means the files it ran passed. The pre-push gate runs everything.',
    );
  }
  return { exitCode, lines };
}

function main() {
  const forwarded = process.argv.slice(2);
  // This CLI forwards every other flag to `node --test`, which rejects what it does not know,
  // so only the flag THIS file owns is validated here: `--preflight` and anything spelled like
  // it (a typo such as `--preflite` would otherwise be handed to node and rejected there, but
  // `--preflight=false` must mean OFF, not "accepted and inert", which `hasFlag` honours).
  // Only the part before a `--` terminator is ours to read; after it, everything is node's.
  const { head, tail } = partitionArgs(forwarded);
  const ours = head.filter((a) => a.startsWith('--preflight'));
  try {
    assertKnownFlags(ours, ['--preflight'], { cli: 'run-tests', from: 0 });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const preflight = ours.length > 0 && hasFlag('preflight');
  const rest = [...head.filter((a) => !a.startsWith('--preflight')), ...tail];
  if (preflight && rest.length > 0) {
    process.stderr.write(`test:preflight takes no other arguments (got: ${rest.join(' ')}). It runs the default set minus PREFLIGHT_SKIPPED_FILES.\n`);
    process.exit(2);
  }

  let selection;
  try {
    selection = selectTestArgs({ preflight });
  } catch (err) {
    process.stderr.write(`test:preflight: ${err.message}\n`);
    process.exit(2);
  }
  // `rest` is what node sees: our own flag (in any spelling, including an explicit =false) is never forwarded.
  // The caller's reporter flags are re-emitted as balanced pairs (extractReporterFlags), so the runner's own
  // reporters never leave node with more reporters than destinations. A forward that was ONLY reporter flags
  // names no files, so it gets the default set.
  const split = partitionArgs(rest);
  const caller = extractReporterFlags(split.head);
  const userArgs = [...caller.others, ...split.tail];
  const args = preflight ? selection.args : (userArgs.length > 0 ? userArgs : selection.args);
  if (preflight) {
    process.stderr.write(`PREFLIGHT — this is NOT the gate. Skipping: ${selection.skipped.map((x) => x.file).join(', ')}. The pre-push gate runs them.\n`);
  }

  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-guard-'));
  const reportPath = path.join(reportDir, 'report.json');
  const timingPath = path.join(reportDir, 'timing.json');

  // NOTE: no try/finally around the exit — `process.exit()` does not run
  // `finally` blocks, so cleanup happens explicitly before exiting.
  const reporterArgs = buildReporterArgs(caller.pairs, {
    isTTY: Boolean(process.stdout.isTTY),
    reportPath,
    timingEnabled: true,
  });
  const res = spawnSync(process.execPath, ['--test', ...reporterArgs, ...caller.pairs, ...args], {
    stdio: 'inherit',
    env: { ...scrubChildEnv(process.env), [TIMING_REPORT_ENV]: timingPath },
  });

  const readOrNull = (p) => {
    try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }   // adjudicateRun fails closed on a missing guard report
  };
  const reportText = readOrNull(reportPath);
  const timingText = readOrNull(timingPath);
  // TEST_TIMING_KEEP=<file> keeps the full per-file report (the printed table is only the top 8,
  // and a family's share needs every row). Best-effort: a failed copy is a note, never a verdict.
  const keep = process.env.TEST_TIMING_KEEP;
  let keepNote = null;
  if (keep && timingText !== null) {
    try { fs.writeFileSync(keep, timingText); } catch (err) { keepNote = `TEST_TIMING_KEEP: could not write ${keep} (${err.code ?? 'error'})`; }
  }
  fs.rmSync(reportDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  const { exitCode, lines } = finishRun({
    status: res.status,
    reportText,
    timingText,
    preflight: preflight ? { skipped: selection.skipped, expected: expectedPreflightFiles() } : null,
  });
  if (keepNote) lines.push(keepNote);
  if (lines.length) process.stderr.write(`\n${lines.join('\n')}\n`);
  process.exit(exitCode);
}

// Import-safe: tests import { scrubRoutingEnv } without spawning anything.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main();
}
