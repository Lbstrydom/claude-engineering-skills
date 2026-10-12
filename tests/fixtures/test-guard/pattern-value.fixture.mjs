/**
 * Two tests, one of them FAILING and named like a reporter flag. Used by
 * tests/run-tests-timing.test.mjs to prove the runner does not mistake the VALUE of
 * `--test-name-pattern` for a reporter flag: with `--test-name-pattern --test-reporter=dot`
 * node selects the failing test and the run must fail. Not a test file by name, so the
 * suite's own glob never runs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('other', () => {});

test('--test-reporter=dot', () => {
  assert.fail('selected by the pattern, so the run must fail');
});
