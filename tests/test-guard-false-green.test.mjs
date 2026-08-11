/**
 * @fileoverview Pins for the false-green guard (scripts/lib/test-guard-reporter.mjs
 * + the adjudication in scripts/run-tests.mjs).
 *
 * The class: node's test runner reports a suite that throws at CONSTRUCTION
 * time as `not ok` in its output, but counts it in neither `# fail` nor the
 * process exit code. Measured on Node 22.19 — the historical bug
 * (`tests/gate-evidence-tree-identity.test.mjs` at dd83e1f8, three suites
 * calling an unimported `test`) reported exactly:
 *
 *     # tests 15   # suites 7   # pass 15   # fail 0     ← exit 0
 *
 * so `npm run check` was green while nine subtests never ran.
 *
 * Success-path adversarialism (the pattern this repo's hermeticity suite
 * established): the suite proves BOTH directions — that the hazard is real and
 * still present in the underlying runner (`MIRROR`), and that the guard closes
 * it. A guard test without the hazard mirror would keep passing if node ever
 * fixed the accounting, quietly testing nothing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  GUARD_REPORT_VERSION,
  isExitCodeWorthyFailure,
  summariseFailure,
} from '../scripts/lib/test-guard-reporter.mjs';
import { buildReporterArgs, adjudicateRun, scrubChildEnv } from '../scripts/run-tests.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'test-guard');
const fixture = (name) => path.join(FIXTURES, `${name}.fixture.mjs`);

/**
 * Env for every child spawned here, with `NODE_TEST_CONTEXT` removed.
 *
 * node sets `NODE_TEST_CONTEXT=child-v8` in each test child process. This suite
 * runs INSIDE that, so an inherited copy makes the grandchild believe it is
 * already in a test context — it prints "run() is being called recursively"
 * and **skips running files entirely**. That silently empties every end-to-end
 * assertion below (it initially made one of them pass for the wrong reason:
 * the guard's fail-closed "no report" message also matches /test-guard:/).
 */
const CHILD_ENV = (() => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
})();

/** Run a fixture through the real runner. Returns the exit status + stderr. */
function runViaRunner(name) {
  const res = spawnSync(process.execPath, ['scripts/run-tests.mjs', fixture(name)], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: CHILD_ENV,
    timeout: 120000,
  });
  return { status: res.status, stderr: res.stderr ?? '' };
}

// ── The hazard is real, and the guard closes it (both directions) ───────────

describe('the false-green hazard and the guard that closes it', () => {
  test('MIRROR (the hazard): plain `node --test` exits 0 on a suite that died at construction', () => {
    // Without this direction the guard test below could pass vacuously — if
    // node ever starts counting construction failures in its exit code, the
    // guard becomes redundant and we should find out from here, not from a
    // silent behaviour change.
    const res = spawnSync(process.execPath, ['--test', fixture('construction-failure')], {
      cwd: ROOT, encoding: 'utf-8', env: CHILD_ENV, timeout: 120000,
    });
    assert.equal(res.status, 0,
      'the underlying runner must still exit 0 here, or this whole guard tests nothing');
    assert.match(res.stdout, /not ok/,
      'and it must still REPORT the failure it is not carrying into the exit code');
  });

  test('the guard: the same fixture through run-tests.mjs FAILS', () => {
    const { status, stderr } = runViaRunner('construction-failure');
    assert.notEqual(status, 0, 'a run with an unexecuted suite must not read as a pass');
    assert.match(stderr, /test-guard:/);
  });

  test('the guard names every dead suite, not just the first', () => {
    // The fixture carries two distinct construction failures (an undefined
    // identifier and a plain throw); reporting one would leave the other to be
    // discovered only after the first is fixed.
    const { stderr } = runViaRunner('construction-failure');
    assert.match(stderr, /undefined identifier at construction/);
    assert.match(stderr, /a plain throw at construction/);
    assert.match(stderr, /reported 2 failure\(s\)/);
  });

  test('the message says the tests never RAN — not merely that something failed', () => {
    // The whole trap is that this looks like a pass. A message that reads like
    // an ordinary assertion failure would send the reader hunting the wrong bug.
    const { stderr } = runViaRunner('construction-failure');
    assert.match(stderr, /died at construction — its tests never ran/);
  });
});

// ── Not always-refuse ──────────────────────────────────────────────────────

describe('the guard licenses genuinely-clean runs', () => {
  test('NEGATIVE CONTROL: a wholly healthy fixture still exits 0', () => {
    const { status } = runViaRunner('healthy');
    assert.equal(status, 0, 'a clean run must stay clean — a guard that fails everything is worthless');
  });

  test('a FAILING todo test does not trip the guard', () => {
    // node reports test:fail and exits 0 here on purpose; gating on it would
    // make todo markers unusable repo-wide.
    const { status } = runViaRunner('failing-todo');
    assert.equal(status, 0, 'a failing todo is a legitimate exit-0 failure event');
  });
});

// ── The pure predicate ─────────────────────────────────────────────────────

describe('isExitCodeWorthyFailure — the todo carve-out is the ONLY carve-out', () => {
  test('an ordinary failure is exit-code worthy', () => {
    assert.equal(isExitCodeWorthyFailure({ name: 'x', details: { type: 'test' } }), true);
  });

  test('a suite construction failure is exit-code worthy', () => {
    assert.equal(isExitCodeWorthyFailure({ name: 'x', details: { type: 'suite' } }), true);
  });

  test('a todo failure is NOT', () => {
    assert.equal(isExitCodeWorthyFailure({ name: 'x', todo: true }), false);
  });

  test('a todo carrying a reason string (not `true`) is still exempt', () => {
    assert.equal(isExitCodeWorthyFailure({ name: 'x', todo: 'not implemented yet' }), false);
  });
});

describe('summariseFailure — degrades without throwing', () => {
  test('carries name, type, location and message', () => {
    const out = summariseFailure({
      name: 'dead suite', file: '/a/b.test.mjs', line: 12,
      details: { type: 'suite', error: { message: 'test is not defined' } },
    });
    assert.deepEqual(out, {
      name: 'dead suite', type: 'suite', file: '/a/b.test.mjs', line: 12,
      error: 'test is not defined',
    });
  });

  test('a bare event does not throw — a crashing reporter would hide the failure it is reporting', () => {
    const out = summariseFailure({});
    assert.equal(out.name, '<unnamed>');
    assert.equal(out.error, null);
  });
});

// ── Adjudication: every branch, without spawning ───────────────────────────

const clean = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [] });
const dirty = JSON.stringify({
  version: GUARD_REPORT_VERSION,
  failures: [{ name: 'dead', type: 'suite', file: '/a.mjs', line: 3, error: 'boom' }],
});

describe('adjudicateRun — the exit-code contract', () => {
  test('clean report + exit 0 → pass', () => {
    assert.deepEqual(adjudicateRun({ status: 0, reportText: clean }), { exitCode: 0, message: null });
  });

  test('failures + exit 0 → FAIL (the whole point)', () => {
    const out = adjudicateRun({ status: 0, reportText: dirty });
    assert.equal(out.exitCode, 1);
    assert.match(out.message, /exited 0, but reported 1 failure/);
  });

  test('a non-zero child status is mirrored exactly', () => {
    // The guard only closes the green-when-failed direction; it must not
    // rewrite an ordinary failure's exit code.
    assert.deepEqual(adjudicateRun({ status: 7, reportText: clean }), { exitCode: 7, message: null });
  });

  test('a signal-kill (null status) is a failure', () => {
    assert.equal(adjudicateRun({ status: null, reportText: null }).exitCode, 1);
  });
});

describe('adjudicateRun — fails CLOSED when the guard itself did not report', () => {
  // The repo rule: a check that can go green having checked nothing is not a
  // check. Each of these is a way the guard could silently stop working.
  test('a MISSING report on an exit-0 run is refused, not assumed clean', () => {
    const out = adjudicateRun({ status: 0, reportText: null });
    assert.equal(out.exitCode, 1);
    assert.match(out.message, /produced no report/);
  });

  test('an unparseable report is refused', () => {
    const out = adjudicateRun({ status: 0, reportText: 'not json at all' });
    assert.equal(out.exitCode, 1);
    assert.match(out.message, /unparseable/);
  });

  test('a report from a DIFFERENT guard version is refused', () => {
    const out = adjudicateRun({ status: 0, reportText: JSON.stringify({ version: 'test-guard/v0', failures: [] }) });
    assert.equal(out.exitCode, 1);
    assert.match(out.message, /drifted/);
  });

  test('a report with no `failures` array is refused rather than read as clean', () => {
    // A missing key must not coerce to "zero failures" — that would be the
    // very false green this guard exists to stop, reintroduced in the reader.
    const out = adjudicateRun({ status: 0, reportText: JSON.stringify({ version: GUARD_REPORT_VERSION }) });
    assert.equal(out.exitCode, 1);
    assert.match(out.message, /no `failures` array/);
  });
});

// ── Reporter wiring ────────────────────────────────────────────────────────

describe('buildReporterArgs — the guard cannot be dropped by invocation style', () => {
  test('the guard reporter is always present', () => {
    for (const forwarded of [[], ['tests/x.test.mjs'], ['--test-reporter=spec']]) {
      const args = buildReporterArgs(forwarded, { isTTY: false, reportPath: '/r.json' });
      assert.ok(args.some((a) => a.includes('test-guard-reporter.mjs')),
        `guard reporter missing for ${JSON.stringify(forwarded)}`);
      assert.ok(args.includes('/r.json'));
    }
  });

  test('restates node\'s own default when the caller named no reporter', () => {
    // Naming any reporter replaces node's implicit default, so the runner has
    // to put it back or the guard would silently change everyone's output.
    assert.ok(buildReporterArgs([], { isTTY: false, reportPath: '/r.json' }).includes('tap'));
    assert.ok(buildReporterArgs([], { isTTY: true, reportPath: '/r.json' }).includes('spec'));
  });

  test('does NOT impose a default when the caller named their own reporter', () => {
    const args = buildReporterArgs(['--test-reporter=dot'], { isTTY: false, reportPath: '/r.json' });
    assert.equal(args.includes('tap'), false, 'the caller\'s choice must win');
    assert.equal(args.includes('spec'), false);
  });

  test('the guard\'s reporter/destination pair is contiguous and last', () => {
    // node pairs reporters with destinations POSITIONALLY; splitting the pair
    // would silently mis-route the report to the caller's destination.
    const args = buildReporterArgs(['--test-reporter=dot'], { isTTY: false, reportPath: '/r.json' });
    assert.deepEqual(args.slice(-4), [
      '--test-reporter', args.at(-3), '--test-reporter-destination', '/r.json',
    ]);
    assert.match(args.at(-3), /test-guard-reporter\.mjs$/);
  });

  test('the reporter is referenced by absolute file URL, not a cwd-relative path', () => {
    // A relative specifier resolves against cwd, so the runner would break when
    // invoked from anywhere but the repo root.
    const args = buildReporterArgs([], { isTTY: false, reportPath: '/r.json' });
    const spec = args.find((a) => a.includes('test-guard-reporter.mjs'));
    assert.match(spec, /^file:\/\//);
  });
});

// ── The skip-everything false green ────────────────────────────────────────

describe('an ambient NODE_TEST_CONTEXT cannot empty the run', () => {
  test('MIRROR (the hazard): it makes plain `node --test` skip every file and exit 0', () => {
    // Strictly worse than the construction-failure bug: zero tests execute and
    // the run still reads green. Pinned so the runner-side scrub below is
    // demonstrably load-bearing.
    const res = spawnSync(process.execPath, ['--test', fixture('healthy')], {
      cwd: ROOT,
      env: { ...CHILD_ENV, NODE_TEST_CONTEXT: 'child-v8' },
      encoding: 'utf-8',
      timeout: 120000,
    });
    assert.equal(res.status, 0, 'the hazard: exit 0...');
    assert.match(res.stderr, /skipping running files/, '...having run nothing at all');
  });

  test('the runner scrubs it, so the same env really executes the tests', () => {
    const res = spawnSync(process.execPath, ['scripts/run-tests.mjs', fixture('healthy')], {
      cwd: ROOT,
      env: { ...CHILD_ENV, NODE_TEST_CONTEXT: 'child-v8' },
      encoding: 'utf-8',
      timeout: 120000,
    });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stderr, /skipping running files/, 'the child must not inherit the context');
  });

  test('and the guard still fires under that env — it is scrubbed, not bypassed', () => {
    const res = spawnSync(process.execPath, ['scripts/run-tests.mjs', fixture('construction-failure')], {
      cwd: ROOT,
      env: { ...CHILD_ENV, NODE_TEST_CONTEXT: 'child-v8' },
      encoding: 'utf-8',
      timeout: 120000,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /died at construction/);
  });

  test('scrubChildEnv removes runner state AND routing selectors', () => {
    const out = scrubChildEnv({ NODE_TEST_CONTEXT: 'child-v8', AZURE_OPENAI_ENDPOINT: 'https://x', PATH: '/usr/bin' });
    assert.deepEqual(out, { PATH: '/usr/bin' });
  });

  test('scrubChildEnv is pure — the input is not mutated', () => {
    const input = { NODE_TEST_CONTEXT: 'child-v8' };
    scrubChildEnv(input);
    assert.equal(input.NODE_TEST_CONTEXT, 'child-v8');
  });
});

// ── The runner still works from another cwd ────────────────────────────────

describe('the runner is cwd-independent', () => {
  test('invoking it by absolute path from a different cwd still guards', () => {
    // Pins the file-URL fix above end-to-end: with a relative reporter
    // specifier this run dies on module resolution instead of guarding.
    const res = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'run-tests.mjs'), fixture('construction-failure'),
    ], { cwd: path.join(ROOT, 'tests'), encoding: 'utf-8', env: CHILD_ENV, timeout: 120000 });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /test-guard:/, 'the guard must fire, not fail to load');
  });
});

// ── The historical bug, replayed ───────────────────────────────────────────

describe('REGRESSION: the bug this guard was built for', () => {
  test('the dd83e1f8 shape — three suites calling an unimported `test` — is caught', () => {
    // Reconstructed from git rather than hand-copied, so it cannot drift from
    // what actually shipped. Skips (rather than fails) if the object is gone,
    // e.g. in a shallow clone — a missing commit is not a guard regression.
    let historical;
    try {
      historical = execFileSync('git', ['show', 'dd83e1f8:tests/gate-evidence-tree-identity.test.mjs'],
        { cwd: ROOT, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return;   // object unavailable — nothing to assert
    }
    assert.match(historical, /^import \{ describe, it \} from 'node:test';$/m,
      'sanity: the historical file must be the pre-fix version, or this replay proves nothing');

    // Written into tests/ (NOT tests/fixtures/) so the historical file's own
    // relative specifiers — '../scripts/...' and './helpers/fixtures.mjs' —
    // resolve unchanged. `.fixture.mjs` keeps it out of the `*.test.mjs` glob.
    const tmp = path.join(ROOT, 'tests', 'historical-replay.fixture.mjs');
    fs.writeFileSync(tmp, historical);
    try {
      const res = spawnSync(process.execPath, ['scripts/run-tests.mjs', tmp], {
        cwd: ROOT, encoding: 'utf-8', env: CHILD_ENV, timeout: 180000,
      });
      assert.notEqual(res.status, 0, 'the original bug must be caught by the guard');
      assert.match(res.stderr, /reported 3 failure\(s\)/, 'all three dead suites, not just the first');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
