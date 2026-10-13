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
 * minus PREFLIGHT_SKIPPED_FILES; NOT the gate — see below) · `node scripts/run-tests.mjs
 * --tier-skip <envelope.json>` (the default set minus the heavy files a `test-tier/v1`
 * envelope skips; the pre-push sandbox's branch tier, NOT the full suite — see below).
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

import { argOption, assertKnownFlags, hasFlag, toShellExitCode } from './lib/cli-io.mjs';
import { GUARD_REPORT_VERSION } from './lib/test-guard-reporter.mjs';
import { TEST_TIER_VERSION, parseHeavyList, parseTierEnvelope, validateEnvelopeAgainstList } from './lib/test-tier.mjs';
import { TIMING_REPORT_ENV, ranFiles, ranFilesUnavailableReason, summariseTiming } from './lib/test-timing-report.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

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
 * The protocol this runner speaks to `prepush-check.mjs`. The sandbox decides whether the tiered path exists by reading
 * THIS declaration from the pushed head's file text (docs/plans/gate-cost-slice-2.md D7b), so a head that predates it
 * runs the legacy `npm run check` and is never handed a flag it does not know.
 */
export const TIER_PROTOCOL = TEST_TIER_VERSION;

const HEAVY_LIST_PATH = path.join(import.meta.dirname, '..', '.test-tiers.json');
let preflightListError = null;

/** The heavy list (`.test-tiers.json`), read and validated, or an Error naming why it cannot be used. */
function loadHeavyList() {
  let text;
  try { text = fs.readFileSync(HEAVY_LIST_PATH, 'utf-8'); } catch (e) { throw new Error(`cannot read .test-tiers.json (${e.code ?? e.message})`); }
  const parsed = parseHeavyList(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.list;
}

/**
 * Files `npm run test:preflight` leaves out, in ONE place: every heavy file in `.test-tiers.json` (the 48-file fleet and
 * archive-lane family, 57% of the suite's test time), each with the reason beside it. This used to be a one-entry list
 * (`tests/fleet-cli.test.mjs`) that, after #214 split that file, saved about 3% (docs/plans/gate-cost-slice-2.md F5);
 * there is now ONE place a slow file is named, shared with the tier oracle, so the two cannot drift.
 * Preflight is for catching a late guard-test failure cheaply BEFORE the first push; the gate
 * still runs everything.
 */
export const PREFLIGHT_SKIPPED_FILES = (() => {
  // A broken `.test-tiers.json` must never take the FULL suite down with it: `npm test` does not use the list at all.
  // The error is kept and surfaces where the list IS used (a preflight, or a tier envelope check).
  try { return Object.freeze(loadHeavyList().heavy.map((h) => Object.freeze({ file: h.file, why: h.why }))); } catch (e) {
    preflightListError = e.message;
    return Object.freeze([]);
  }
})();

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
  if (skipped === PREFLIGHT_SKIPPED_FILES && preflightListError) throw new Error(`the heavy list is unusable (${preflightListError}), so the preflight has nothing to skip; run npm test`);

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
  // Forwarded through toShellExitCode: a status whose low byte is 0 (256, 512…)
  // would read as a PASS to the bash/git one hop up (cli-io.mjs, runbook §8).
  if (status === null) return { exitCode: 1, message: null };
  if (status !== 0) return { exitCode: toShellExitCode(status), message: null };

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
 * The same check serves the branch TIER (`tier`: the heavy files a `test-tier/v1` envelope skipped): a tiered run that
 * may have run the wrong files, or whose evidence cannot be read, fails closed exactly like a preflight, and says
 * plainly it was not the full suite (docs/plans/gate-cost-slice-2.md section 2.4 items 1-3).
 *
 * @param {{status: number|null, reportText: string|null, timingText?: string|null,
 *          preflight?: {skipped: Array<{file: string, why: string}>, expected: Set<string>}|null,
 *          tier?: {skipped: Array<{file: string, why: string}>, expected: Set<string>}|null}} input
 * @returns {{exitCode: number, lines: string[]}}
 */
export function finishRun({ status, reportText, timingText = null, preflight = null, tier = null }) {
  const verdict = adjudicateRun({ status, reportText });
  const lines = [];
  if (verdict.message) lines.push(verdict.message);
  lines.push(...summariseTiming(timingText).lines);

  let exitCode = verdict.exitCode;
  const selection = preflight ?? tier;
  if (selection) {
    const label = preflight ? 'Preflight' : 'Branch tier';
    const ran = ranFiles(timingText);
    if (ran === null) {
      if (exitCode === 0) exitCode = 1;
      lines.push(`${label}: selection UNVERIFIED (${ranFilesUnavailableReason(timingText)}), so it cannot be confirmed that the right files ran. Failing rather than reporting a pass; re-run, or use npm test.`);
    } else {
      const skippedSet = new Set(selection.skipped.map((x) => x.file));
      const ranSkipped = [...ran].filter((x) => skippedSet.has(x)).sort();
      const missing = [...selection.expected].filter((x) => !ran.has(x)).sort();
      // Equality, both directions: a file that ran and was neither expected nor declared skipped is a selection that
      // does not mean what it says (audit M9).
      const unexpected = [...ran].filter((x) => !selection.expected.has(x) && !skippedSet.has(x)).sort();
      if (ranSkipped.length || missing.length || unexpected.length) {
        if (exitCode === 0) exitCode = 1;
        lines.push(`${label}: the files that ran are not the files that were selected.`);
        if (ranSkipped.length) lines.push(`  ran although declared skipped: ${ranSkipped.join(', ')}`);
        if (unexpected.length) lines.push(`  ran but were not selected: ${unexpected.slice(0, 10).join(', ')}${unexpected.length > 10 ? ` (+${unexpected.length - 10} more)` : ''}`);
        if (missing.length) lines.push(`  expected but did not run: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`);
      }
    }
    if (preflight) {
      lines.push(
        'PREFLIGHT — this was NOT the gate. Skipped: ' + preflight.skipped.map((x) => `${x.file} (${x.why})`).join('; ') + '.',
        'A pass here means the files it ran passed. The pre-push gate runs everything.',
      );
    } else {
      lines.push(
        `BRANCH TIER — this was NOT the full suite. Skipped ${tier.skipped.length} heavy file(s): ${tier.skipped.map((x) => x.file).join(', ') || 'none'}.`,
        'A pass here means the files it ran passed. A merge candidate needs a full verdict (test-tier/v1 full <sha>).',
      );
    }
  }
  return { exitCode, lines };
}

/**
 * Read a `test-tier/v1` envelope file for `--tier-skip` and turn it into the skip list. Every check is a hard error
 * (the caller exits 2): an envelope that is unreadable, unparseable, of the wrong version, skips a file that is not on
 * the heavy list, skips a file the diff reaches, or would leave nothing to run, is never "skip as last time" and never
 * "skip nothing silently" (docs/plans/gate-cost-slice-2.md section 2.4 items 1 and 4).
 *
 * @param {string} file
 * @param {{readFile?: (p: string) => string, list?: ReturnType<typeof loadHeavyList>}} [io]
 * @returns {{skipped: Array<{file: string, why: string}>, envelope: object}}
 */
export function readTierSkip(file, { readFile = (p) => fs.readFileSync(p, 'utf-8'), list = loadHeavyList() } = {}) {
  let text;
  try { text = readFile(file); } catch (e) { throw new Error(`cannot read the tier envelope ${file} (${e.code ?? e.message})`); }
  const parsed = parseTierEnvelope(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  const valid = validateEnvelopeAgainstList(parsed.envelope, list);
  if (!valid.ok) throw new Error(valid.reason);
  const why = new Map(list.heavy.map((h) => [h.file, h.why]));
  return { envelope: parsed.envelope, skipped: parsed.envelope.skipped.map((f) => ({ file: f, why: why.get(f) })) };
}

function main() {
  const forwarded = process.argv.slice(2);
  // This CLI forwards every other flag to `node --test`, which rejects what it does not know,
  // so only the flag THIS file owns is validated here: `--preflight` and anything spelled like
  // it (a typo such as `--preflite` would otherwise be handed to node and rejected there, but
  // `--preflight=false` must mean OFF, not "accepted and inert", which `hasFlag` honours).
  // Only the part before a `--` terminator is ours to read; after it, everything is node's.
  const { head, tail } = partitionArgs(forwarded);
  const ours = head.filter((a) => a.startsWith('--preflight') || a.startsWith('--tier-skip'));
  try {
    assertKnownFlags(ours, ['--preflight', '--tier-skip'], { cli: 'run-tests', from: 0 });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const preflight = ours.some((a) => a.startsWith('--preflight')) && hasFlag('preflight');
  // `--tier-skip <file>`: its VALUE is ours too, so it is stripped with the flag (a bare path is not a file to run).
  const tierSkipFile = ours.some((a) => a.startsWith('--tier-skip')) ? argOption('tier-skip') : null;
  if (ours.some((a) => a.startsWith('--tier-skip')) && !tierSkipFile) {
    process.stderr.write('run-tests: --tier-skip needs the path of a test-tier/v1 envelope file.\n');
    process.exit(2);
  }
  const rest = [];
  for (let i = 0; i < head.length; i += 1) {
    const a = head[i];
    if (a.startsWith('--preflight')) continue;
    if (a === '--tier-skip') { i += 1; continue; }
    if (a.startsWith('--tier-skip=')) continue;
    rest.push(a);
  }
  rest.push(...tail);
  if ((preflight || tierSkipFile) && rest.length > 0) {
    process.stderr.write(`${preflight ? 'test:preflight' : '--tier-skip'} takes no other arguments (got: ${rest.join(' ')}). It runs the default set minus the files it skips.\n`);
    process.exit(2);
  }
  if (preflight && tierSkipFile) {
    process.stderr.write('run-tests: --preflight and --tier-skip are two different selections; pass one.\n');
    process.exit(2);
  }

  let tierSkip = null;
  if (tierSkipFile) {
    try { tierSkip = readTierSkip(tierSkipFile); } catch (err) {
      process.stderr.write(`run-tests: ${err.message}\n  Refusing to guess a selection: run the full suite (npm test) instead.\n`);
      process.exit(2);
    }
  }
  let selection;
  try {
    selection = tierSkip ? selectTestArgs({ preflight: true, skipped: tierSkip.skipped }) : selectTestArgs({ preflight });
  } catch (err) {
    process.stderr.write(`${tierSkip ? '--tier-skip' : 'test:preflight'}: ${err.message}\n`);
    process.exit(2);
  }
  // `rest` is what node sees: our own flag (in any spelling, including an explicit =false) is never forwarded.
  // The caller's reporter flags are re-emitted as balanced pairs (extractReporterFlags), so the runner's own
  // reporters never leave node with more reporters than destinations. A forward that was ONLY reporter flags
  // names no files, so it gets the default set.
  const split = partitionArgs(rest);
  const caller = extractReporterFlags(split.head);
  const userArgs = [...caller.others, ...split.tail];
  const args = (preflight || tierSkip) ? selection.args : (userArgs.length > 0 ? userArgs : selection.args);
  if (preflight) {
    process.stderr.write(`PREFLIGHT — this is NOT the gate. Skipping: ${selection.skipped.map((x) => x.file).join(', ')}. The pre-push gate runs them.\n`);
  }
  if (tierSkip) {
    process.stderr.write(`BRANCH TIER — not the full suite. Skipped ${selection.skipped.length} heavy file(s): ${selection.skipped.map((x) => x.file.replace(/^tests\//, '')).join(', ') || 'none'}.\n`);
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
    tier: tierSkip ? { skipped: selection.skipped, expected: expectedPreflightFiles({ skipped: selection.skipped }) } : null,
  });
  if (keepNote) lines.push(keepNote);
  if (lines.length) process.stderr.write(`\n${lines.join('\n')}\n`);
  process.exit(exitCode);
}

// Import-safe: tests import { scrubRoutingEnv } without spawning anything.
if (isInvokedAsScript(import.meta.url)) {
  main();
}
