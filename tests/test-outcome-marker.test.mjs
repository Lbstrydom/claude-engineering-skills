import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_OUTCOME_MARKER, classifyAttemptLog, classifyOutcome, outcomeFromRun, outcomeLine, parseOutcomePayload,
} from '../scripts/lib/test-outcome-marker.mjs';
import { adjudicateRun, finishRun } from '../scripts/run-tests.mjs';
import { GUARD_REPORT_VERSION } from '../scripts/lib/test-guard-reporter.mjs';

const report = (failures) => JSON.stringify({ version: GUARD_REPORT_VERSION, failures });
const policy = { id: 'slow-test-budget', kind: 'policy' };

describe('test-outcome/v1 grammar', () => {
  it('round-trips a line through parse', () => {
    const o = { testsFailed: 0, guards: [policy] };
    const line = outcomeLine(o);
    assert.ok(line.startsWith(`${TEST_OUTCOME_MARKER} `));
    assert.deepEqual(parseOutcomePayload(line.slice(TEST_OUTCOME_MARKER.length + 1)), o);
  });
  for (const [label, payload] of [
    ['not JSON', 'nope'], ['an array', '[]'], ['an extra key', '{"testsFailed":0,"guards":[],"x":1}'],
    ['a negative count', '{"testsFailed":-1,"guards":[]}'], ['a fractional count', '{"testsFailed":0.5,"guards":[]}'],
    ['an unknown guard kind', '{"testsFailed":0,"guards":[{"id":"a","kind":"warn"}]}'],
    ['a bad guard id', '{"testsFailed":0,"guards":[{"id":"A B","kind":"policy"}]}'],
  ]) it(`refuses ${label}`, () => assert.equal(parseOutcomePayload(payload), null));
});

describe('classifyOutcome — the one reader', () => {
  const rows = [
    [null, 'unclassified'],
    [{ testsFailed: null, guards: [policy] }, 'unclassified'],
    [{ testsFailed: 2, guards: [policy] }, 'test-failure'],
    [{ testsFailed: 0, guards: [policy, { id: 'per-test-limit', kind: 'timeout' }] }, 'timeout'],
    [{ testsFailed: 0, guards: [policy, { id: 'hang-guard', kind: 'instrument' }] }, 'instrument'],
    [{ testsFailed: 0, guards: [policy] }, 'guard'],
    [{ testsFailed: 0, guards: [] }, 'unclassified'],
  ];
  for (const [o, kind] of rows) it(`${JSON.stringify(o)} → ${kind}`, () => assert.equal(classifyOutcome(o), kind));
});

describe('classifyAttemptLog', () => {
  it('reads exactly one marker, prefix allowed', () => {
    const r = classifyAttemptLog(`ok 1 - a\n2026-11-27T10:00:00Z ${outcomeLine({ testsFailed: 0, guards: [policy] })}\n`);
    assert.equal(r.kind, 'guard');
  });
  it('no marker → unclassified, with why', () => {
    const r = classifyAttemptLog('FAILED tests/x.py::t\n');
    assert.equal(r.kind, 'unclassified');
    assert.match(r.why, /no test-outcome/);
  });
  it('two markers (a forged one from test output) → unclassified, never guard', () => {
    const forged = outcomeLine({ testsFailed: 0, guards: [policy] });
    const real = outcomeLine({ testsFailed: 3, guards: [] });
    const r = classifyAttemptLog(`${forged}\n${real}\n`);
    assert.equal(r.kind, 'unclassified');
    assert.match(r.why, /2 test-outcome/);
  });
});

describe('run-tests emits the outcome without moving the verdict', () => {
  const marker = (lines) => lines.filter((l) => l.startsWith(`${TEST_OUTCOME_MARKER} `));
  it('a run with recorded failures says testsFailed', () => {
    const out = finishRun({ status: 1, reportText: report([{ name: 't', file: `${process.cwd()}/tests/a.test.mjs` }]) });
    assert.equal(out.exitCode, 1);
    const [line] = marker(out.lines);
    assert.deepEqual(parseOutcomePayload(line.slice(TEST_OUTCOME_MARKER.length + 1)), { testsFailed: 1, guards: [] });
  });
  it('a missing guard report is an instrument failure, never a count', () => {
    assert.deepEqual(outcomeFromRun({ reportText: null, guardReportVersion: GUARD_REPORT_VERSION }),
      { testsFailed: null, guards: [{ id: 'guard-report', kind: 'instrument' }] });
  });
  it('the watchdog and the per-test limit are timeouts; lost progress is an instrument failure', () => {
    const o = outcomeFromRun({ reportText: report([]), guardReportVersion: GUARD_REPORT_VERSION, watchdog: { idleForMs: 1, idleMs: 1 }, hang: { stallLines: ['x'], gapFiles: ['y'] } });
    assert.deepEqual(o.guards.map((g) => g.kind), ['timeout', 'timeout', 'instrument']);
    assert.equal(classifyOutcome(o), 'timeout');
  });
  it('a selection failure on a clean run is named test-selection/instrument', () => {
    const o = outcomeFromRun({ reportText: report([]), guardReportVersion: GUARD_REPORT_VERSION, selectionFailed: true });
    assert.deepEqual(o, { testsFailed: 0, guards: [{ id: 'test-selection', kind: 'instrument' }] });
  });
  it('a green run prints no outcome line, and exit codes match adjudicateRun for every input', () => {
    assert.equal(marker(finishRun({ status: 0, reportText: report([]) }).lines).length, 0);
    for (const input of [{ status: 0, reportText: report([]) }, { status: 1, reportText: report([]) }, { status: 0, reportText: null },
      { status: 0, reportText: report([{ name: 't' }]) }, { status: 0, reportText: report([]), watchdog: { idleForMs: 1, idleMs: 1 } }]) {
      assert.equal(finishRun(input).exitCode, adjudicateRun(input).exitCode);
    }
  });
});
