/**
 * @fileoverview db-suites-gate decision policy — hermetic, no Docker.
 *
 * Covers the paths a developer machine cannot reach on demand (no daemon, port
 * taken, concurrent owner) and which are exactly where a mistake reads GREEN.
 *
 * The gate exists because `npm run check` reported green over the entire DB
 * seam: the suites are `assertDisposableDbUrl`-gated, and node reports a suite
 * that never ran as a clean 0-test pass. Its documented CI fallback had
 * meanwhile failed 20 consecutive runs. So the property under test is narrow
 * and load-bearing: a skip must never be silent, and must never be mistaken
 * for coverage.
 *
 * Plan: docs/plans/local-db-test-container.md
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../scripts/db-suites-gate.mjs';

/** A clock that returns each value in turn, so elapsed time is exact and instant. */
function stubClock(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** Harness: records output, defaults to the happy path. */
function run(overrides = {}) {
  const out = [];
  const code = decide({
    dockerAvailable: () => true,
    runSuites: () => ({ status: 0 }),
    write: (s) => out.push(s),
    env: {},
    ...overrides,
  });
  return { code, out: out.join('') };
}

describe('db-suites-gate — blocks only on real failure', () => {
  test('suites pass → exit 0, one line, and it states the cost', () => {
    // This asserted `out === ''` ("a passing gate must not add noise") until
    // 2026-08-11. The intent was no DETAIL dump, but the literal reading made
    // this gate the only one in the `check` chain that reports nothing on
    // success — every sibling prints a one-line summary — and that silence is
    // how its own docstring's cost figure drifted 2.4x (10s → 24s) unchallenged
    // for three weeks. The number nobody can see is the number nobody corrects.
    const { code, out } = run({ now: stubClock(0, 24_076) });
    assert.equal(code, 0);
    assert.equal(out.trimEnd().split('\n').length, 1, 'one line — the no-detail-dump intent is preserved');
    assert.match(out, /passed in 24\.1s/, 'the elapsed time is the point of the line');
  });

  test('the elapsed figure comes from the clock, not from a hardcoded string', () => {
    // A fabricated constant in a telemetry field reads exactly like a
    // measurement. Drive two different clocks and require the output to follow.
    assert.match(run({ now: stubClock(1_000, 3_500) }).out, /passed in 2\.5s/);
    assert.match(run({ now: stubClock(0, 188) }).out, /passed in 188ms/);
  });

  test('a FAILING or SKIPPED run does not claim a passing duration', () => {
    // The success line must be reachable only from the success branch.
    for (const o of [{ runSuites: () => ({ status: 1 }) }, { runSuites: () => ({ status: 2 }) },
      { dockerAvailable: () => false }]) {
      assert.doesNotMatch(run({ ...o, now: stubClock(0, 9_999) }).out, /passed in/);
    }
  });

  test('suite failure (exit 1) → blocks, and says it is NOT an environment problem', () => {
    const { code, out } = run({ runSuites: () => ({ status: 1 }) });
    assert.equal(code, 1);
    assert.match(out, /FAILED \(exit 1\)/);
    assert.match(out, /real failure, not an environment problem/);
  });

  test('an UNRECOGNISED exit code fails closed', () => {
    // The success path is the dangerous one: an unmapped code must never be
    // read as "fine". 137 = SIGKILL/OOM, a realistic container death.
    for (const status of [137, 4, -1, null]) {
      const { code } = run({ runSuites: () => ({ status }) });
      assert.equal(code, 1, `exit ${status} must block, not pass`);
    }
  });
});

describe('db-suites-gate — environment problems degrade, never silently', () => {
  const envCases = [
    ['no docker daemon', { dockerAvailable: () => false }, /no reachable Docker daemon/],
    ['docker/port problem (exit 2)', { runSuites: () => ({ status: 2 }) }, /docker\/port problem/],
    ['concurrent owner (exit 3)', { runSuites: () => ({ status: 3 }) }, /another invocation owns/],
    ['spawn failure', { runSuites: () => ({ status: null, error: new Error('ENOENT') }) }, /could not spawn/],
  ];

  for (const [name, override, pattern] of envCases) {
    test(`${name} → exit 0 but LOUD`, () => {
      const { code, out } = run(override);
      assert.equal(code, 0, 'environment trouble is not evidence of a defect');
      assert.match(out, pattern);
      assert.match(out, /did NOT run/, 'must state the suites did not run');
      assert.match(out, /UNVERIFIED/, 'must never imply coverage');
      assert.match(out, /AUDIT_LOOP_DB_TESTS_REQUIRED=1/, 'must name the strictness flag');
    });

    test(`${name} + REQUIRED → hard failure`, () => {
      const { code, out } = run({ ...override, env: { AUDIT_LOOP_DB_TESTS_REQUIRED: '1' } });
      assert.equal(code, 1, 'a tolerated skip must be promotable to a failure');
      assert.match(out, /FAIL/);
    });
  }
});

describe('db-suites-gate — the opt-out cannot defeat the strictness flag', () => {
  test('SKIP=1 alone → skips, loudly', () => {
    const { code, out } = run({ env: { AUDIT_LOOP_DB_TESTS_SKIP: '1' } });
    assert.equal(code, 0);
    assert.match(out, /operator opt-out/);
    assert.match(out, /UNVERIFIED/);
  });

  test('SKIP=1 + REQUIRED=1 → REQUIRED wins and the suites actually RUN', () => {
    // Not merely "fails" — REQUIRED means coverage must be real, so the
    // correct behaviour is to ignore the opt-out and execute. If this ever
    // regresses to short-circuiting, "required" stops meaning required.
    let ran = false;
    const code = decide({
      dockerAvailable: () => true,
      runSuites: () => { ran = true; return { status: 0 }; },
      write: () => {},
      env: { AUDIT_LOOP_DB_TESTS_SKIP: '1', AUDIT_LOOP_DB_TESTS_REQUIRED: '1' },
    });
    assert.equal(ran, true, 'REQUIRED must override the opt-out and run the suites');
    assert.equal(code, 0);
  });

  test('docker is probed only after the opt-out is resolved', () => {
    // Ordering guard: probing first would spend ~20s of daemon timeout on a
    // machine that opted out precisely because it has no daemon.
    let probed = false;
    decide({
      dockerAvailable: () => { probed = true; return true; },
      runSuites: () => ({ status: 0 }),
      write: () => {},
      env: { AUDIT_LOOP_DB_TESTS_SKIP: '1' },
    });
    assert.equal(probed, false, 'an opted-out run must not probe docker');
  });
});
