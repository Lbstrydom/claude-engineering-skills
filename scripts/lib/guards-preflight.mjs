/**
 * @fileoverview Pure planning for `npm run guards:preflight`: which of the
 * push gate's checks a session can run in a couple of minutes BEFORE it asks
 * for a gate slot (a full gate is 12-20 min on a shared machine).
 *
 * **Why it exists.** 2026-10-12/13: at least four full gate runs failed ONLY on a
 * whole-suite guard (`rmsync-retry-guard` x3, `dashboard-cli`'s CLI catalogue,
 * `check-status-log-integrity`, `prepush-sandbox-honesty`) after green targeted runs
 * (docs/plans/gate-cost-slice-2.md §1.4). Those guards' subject is repo CONTENT, read
 * by enumeration, so a targeted run of the changed files cannot see them.
 *
 * **It runs the REAL checks, never copies.** The static half is DERIVED from the
 * `check` script in package.json (every `npm run <gate>` step before the final
 * `npm test`), so a gate added to `check` joins the preflight with no edit here, and
 * the preflight can never run a weaker variant of a gate: it runs the same npm script.
 * The test half is a declared list handed to `scripts/run-tests.mjs` (the same runner,
 * the same false-green guard). What it omits is declared with a reason and a measured
 * cost, and each omission is checked against the chain so a stale entry fails loudly.
 *
 * **It never substitutes for the full gate**: the verdict line says so, and a check that
 * could not be measured is reported as NOT MEASURED, never as a pass.
 *
 * @module scripts/lib/guards-preflight
 */
import { expandedCheckScript } from './check-chain.mjs';


/**
 * Whole-suite guard tests: tests whose subject is repo content (a scan of every test or
 * script file, the CLI catalogue, the status log, a ratchet baseline). Each names the
 * failure that earned it a place. Add a guard here when a full gate fails on one that a
 * targeted run did not reach; `tests/guards-preflight.test.mjs` checks that every entry
 * exists and that the whole list stays within the declared budget.
 */
export const GUARD_TESTS = Object.freeze([
  Object.freeze({ file: 'tests/rmsync-retry-guard.test.mjs', why: 'scans every test/script file for a bare fs.rmSync (4 late gate failures, 2026-10-12/13)' }),
  Object.freeze({ file: 'tests/dashboard-cli.test.mjs', why: 'CLI catalogue must describe every package.json script (#224)' }),
  Object.freeze({ file: 'tests/prepush-sandbox-honesty.test.mjs', why: 'reads runner source for sandbox-honesty invariants (#212)' }),
  Object.freeze({ file: 'tests/check-status-log-integrity.test.mjs', why: 'status log conservation (#204)' }),
  Object.freeze({ file: 'tests/dashboard-home-status-entries.test.mjs', why: 'reads status.md (#212)' }),
  Object.freeze({ file: 'tests/relocation-guard.test.mjs', why: 'every CLI_SMOKE_SET script keeps its --selfcheck-relocation handler' }),
  Object.freeze({ file: 'tests/cross-skill-cli-integrity.test.mjs', why: 'cross-skill CLI registry vs SKILL.md consumers' }),
  Object.freeze({ file: 'tests/cross-skill-registry-ratchet.test.mjs', why: 'cross-skill command registry ratchet' }),
  Object.freeze({ file: 'tests/no-raw-nul-in-source.test.mjs', why: 'no literal NUL bytes in source' }),
  Object.freeze({ file: 'tests/atomic-write-adoption-guard.test.mjs', why: 'atomic-write adoption across scripts' }),
  Object.freeze({ file: 'tests/arm-vocabulary-layering.test.mjs', why: 'domain layering re-derived over the whole repo' }),
  Object.freeze({ file: 'tests/skill-census.test.mjs', why: 'skill roster census' }),
  Object.freeze({ file: 'tests/anthropic-client-migration.test.mjs', why: 'call sites use the createAnthropicClient factory' }),
  Object.freeze({ file: 'tests/runner-leak-guard.test.mjs', why: 'runner env-leak guard' }),
  Object.freeze({ file: 'tests/test-guard-false-green.test.mjs', why: 'the runner refuses a green it did not earn' }),
  Object.freeze({ file: 'tests/env-loading-single-oracle.test.mjs', why: 'one env-loading oracle across scripts' }),
  Object.freeze({ file: 'tests/domain-map-subsystem-coverage.test.mjs', why: 'every domain in the map is documented' }),
  Object.freeze({ file: 'tests/git-hooks-wiring.test.mjs', why: 'hook wiring' }),
  Object.freeze({ file: 'tests/worktree-guard-args-dedup.test.mjs', why: 'no test re-implements the guard-args helper' }),
  Object.freeze({ file: 'tests/upstream-single-writer-census.test.mjs', why: 'upstream log has a single writer' }),
  Object.freeze({ file: 'tests/upstream-disposition-ratchet.test.mjs', why: 'upstream disposition ratchet' }),
  Object.freeze({ file: 'tests/gate-contract-ratchet.test.mjs', why: 'gate-contract ratchet' }),
  Object.freeze({ file: 'tests/file-size-ratchet.test.mjs', why: 'oversized files may not grow' }),
  Object.freeze({ file: 'tests/knip-gate.test.mjs', why: 'knip baseline ratchet' }),
]);

/**
 * Static gates the preflight leaves out, each with its measured cost. Each must name a
 * step that really is in the `check` chain (checked), so a rename cannot leave a stale
 * exemption that silently hides a gate.
 */
export const DECLARED_SLOW_GATES = Object.freeze([
  Object.freeze({ script: 'db:suites:gate', measuredS: 72, measuredAt: '2026-10-13', why: 'spawns the DB suites; too slow for a "minute or two" preflight' }),
  Object.freeze({ script: 'gates:poison', measuredS: 64, measuredAt: '2026-10-13', why: 'negative-control mutation run over every gate' }),
]);

/** The one gate that needs a base to mean anything (see {@link gateExtraArgs}). */
export const STATUS_GATE = 'status:integrity:gate';

/**
 * Split package.json's `check` into its static gate scripts.
 * Every `&&` step must be `npm run <name>`, except the final bare `npm test`; anything
 * else throws, because a step this parser skipped would be a gate the preflight silently
 * does not run.
 *
 * @param {string} checkScript
 * @returns {string[]} gate script names, in order
 */
export function staticGatesFromCheck(checkScript) {
  if (typeof checkScript !== 'string' || !checkScript.trim()) {
    throw new Error('package.json has no "check" script to derive the static gates from');
  }
  const steps = checkScript.split('&&').map((s) => s.trim());
  const gates = [];
  steps.forEach((step, i) => {
    const m = /^npm run ([\w:.-]+)$/.exec(step);
    if (m) { gates.push(m[1]); return; }
    if (i === steps.length - 1 && step === 'npm test') return;
    throw new Error(`cannot derive a gate from check step "${step}": expected "npm run <script>" (or a final "npm test")`);
  });
  if (gates.length === 0) throw new Error('the "check" script yields no static gates');
  return gates;
}

/**
 * Plan a preflight from package.json and the file system.
 *
 * @param {{pkg: {scripts?: Record<string,string>}, exists: (p: string) => boolean,
 *   tests?: ReadonlyArray<{file: string}>, slow?: ReadonlyArray<{script: string}>}} opts
 * @returns {{gates: string[], omittedGates: Array<{script: string, why: string, measuredS: number}>, testFiles: string[]}}
 * @throws {Error} on a stale or missing entry, or an empty selection
 */
export function planPreflight({ pkg, exists, tests = GUARD_TESTS, slow = DECLARED_SLOW_GATES }) {
  // `check` is `check:static` then the suite (docs/plans/gate-cost-slice-2.md D7); the gates are the expanded chain.
  const chain = staticGatesFromCheck(expandedCheckScript(pkg?.scripts));
  for (const entry of slow) {
    const { script, measuredS, measuredAt, why } = entry;
    if (!chain.includes(script)) throw new Error(`DECLARED_SLOW_GATES entry "${script}" is not a step of "check"; remove or fix it`);
    // An omission is a claim about cost, so it carries its evidence: a bare name would hide a gate with no reason.
    if (!Number.isFinite(measuredS) || measuredS <= 0) throw new Error(`DECLARED_SLOW_GATES entry "${script}" needs a finite positive measuredS`);
    if (typeof measuredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(measuredAt) || Number.isNaN(Date.parse(measuredAt))) {
      throw new Error(`DECLARED_SLOW_GATES entry "${script}" needs a measuredAt date (YYYY-MM-DD)`);
    }
    if (typeof why !== 'string' || why.trim().length < 10) throw new Error(`DECLARED_SLOW_GATES entry "${script}" needs a reason (at least 10 characters)`);
  }
  for (const { file } of tests) {
    if (!exists(file)) throw new Error(`GUARD_TESTS entry "${file}" does not exist; remove or fix it`);
  }
  const skip = new Set(slow.map((s) => s.script));
  const gates = chain.filter((g) => !skip.has(g));
  if (gates.length === 0 || tests.length === 0) throw new Error('the preflight selection is empty: it would pass having checked nothing');
  return {
    gates,
    omittedGates: slow.map((s) => ({ script: s.script, why: s.why, measuredS: s.measuredS })),
    testFiles: tests.map((t) => t.file),
  };
}

/**
 * Extra npm args for a gate. The status-log gate compares a committed base against HEAD
 * and fails closed when they are the same commit, which is exactly the state of a branch
 * with nothing committed yet; there it cannot be measured, and that is reported as such.
 *
 * @param {string} script
 * @param {{mergeBase: string|null, head: string|null}} git
 * @returns {{args: string[]}|{unmeasured: string}}
 */
export function gateExtraArgs(script, { mergeBase, head }) {
  if (script !== STATUS_GATE) return { args: [] };
  if (!mergeBase || !head) return { unmeasured: 'no merge-base with origin/main (fetch it, or run from a full clone)' };
  if (mergeBase === head) return { unmeasured: 'no commits ahead of origin/main yet, so there is no history to compare; commit, then re-run' };
  return { args: ['--', '--base', mergeBase] };
}

/**
 * @typedef {{name: string, status: 'pass'|'fail'|'unmeasured', note?: string}} StepResult
 */

/**
 * One verdict from the step results. `incomplete` is never spelled like a pass.
 *
 * @param {StepResult[]} results
 * @param {{omittedGates: Array<{script: string}>, testFileCount: number}} plan
 * @returns {{verdict: 'PASS'|'FAIL'|'INCOMPLETE', exitCode: 0|1|3, line: string}}
 */
export function summarise(results, { omittedGates, testFileCount }) {
  const failed = results.filter((r) => r.status === 'fail');
  const unmeasured = results.filter((r) => r.status === 'unmeasured');
  const passed = results.filter((r) => r.status === 'pass').length;
  const tail = `omitted: ${omittedGates.map((g) => g.script).join(', ') || 'none'}. NOT the full gate.`;
  if (failed.length > 0) {
    return { verdict: 'FAIL', exitCode: 1, line: `guards:preflight FAIL: ${failed.map((r) => r.name).join(', ')} (${passed} passed, ${unmeasured.length} not measured; ${tail})` };
  }
  if (unmeasured.length > 0) {
    return { verdict: 'INCOMPLETE', exitCode: 3, line: `guards:preflight INCOMPLETE: not measured: ${unmeasured.map((r) => r.name).join(', ')} (${passed} passed, none failed; ${tail})` };
  }
  return { verdict: 'PASS', exitCode: 0, line: `guards:preflight PASS: ${passed} steps passed (static gates plus the ${testFileCount} guard test files); ${tail}` };
}

/** Exit status when the preflight could not plan or run at all (a setup fault, never a pass). */
export const EXIT_CANNOT_RUN = 2;

/**
 * Run a plan: each static gate through npm, then the guard test files through the repo's own
 * test runner. Spawning is injected so the invocation sequence is testable without running a gate.
 *
 * @param {{gates: string[], testFiles: string[], omittedGates: Array<{script: string}>}} plan
 * @param {{mergeBase: string|null, head: string|null}} git
 * @param {{spawn: (cmd: string, args: string[]) => {status: number|null, stdout?: string, stderr?: string, error?: Error},
 *   npm: string, node: string, runner: string, log: (s: string) => void}} io
 * @returns {{verdict: 'PASS'|'FAIL'|'INCOMPLETE', exitCode: 0|1|3, line: string, results: StepResult[]}}
 */
export function executePreflight(plan, git, { spawn, npm, node, runner, log }) {
  /** @type {StepResult[]} */
  const results = [];
  for (const gate of plan.gates) {
    const extra = gateExtraArgs(gate, git);
    if ('unmeasured' in extra) {
      log(`  ${gate}: NOT MEASURED (${extra.unmeasured})
`);
      results.push({ name: gate, status: 'unmeasured', note: extra.unmeasured });
      continue;
    }
    const r = spawn(npm, ['run', gate, ...extra.args]);
    // A spawn error (ENOENT, buffer overflow) is the wrapper failing, not the gate passing or failing on its merits.
    const ok = r.status === 0 && !r.error;
    log(`  ${gate}: ${ok ? 'ok' : 'FAIL'}
`);
    if (!ok) log(`${r.error ? `${gate}: could not be run to completion (${r.error.message})
` : ''}${r.stdout ?? ''}${r.stderr ?? ''}`);
    results.push({ name: gate, status: ok ? 'pass' : 'fail' });
  }
  const t = spawn(node, [runner, '--', ...plan.testFiles]);
  results.push({ name: 'guard tests', status: t.status === 0 && !t.error ? 'pass' : 'fail' });
  return { ...summarise(results, { omittedGates: plan.omittedGates, testFileCount: plan.testFiles.length }), results };
}
