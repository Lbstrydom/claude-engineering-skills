/**
 * @fileoverview The load-timeout retry in tests/helpers/fleet-cli-harness.mjs. It exists so a train build that
 * failed on the CLI's own git bound under machine load is rebuilt rather than read as a regression - which makes
 * the negative controls the point: a failure that does NOT name a timeout must surface at once, unretried.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { greenTrainOf, isLoadTimeout, retryOnLoadTimeout } from './helpers/fleet-cli-harness.mjs';

describe('retryOnLoadTimeout', () => {
  it('rebuilds after a failure that names a timeout, and returns the build that worked', () => {
    let calls = 0;
    const out = retryOnLoadTimeout(() => {
      calls += 1;
      if (calls < 3) throw new Error('claim feat-a: git status timed out after 15000ms');
      return 'built';
    });
    assert.equal(out, 'built');
    assert.equal(calls, 3);
  });

  it('control: a failure that does not name a timeout is thrown on the FIRST attempt, never retried', () => {
    let calls = 0;
    assert.throws(() => retryOnLoadTimeout(() => { calls += 1; throw new Error('land did not build a green train (status 3): base moved'); }), /base moved/);
    assert.equal(calls, 1);
  });

  it('control: a persistent timeout is rethrown after the attempt budget, not retried forever', () => {
    let calls = 0;
    assert.throws(() => retryOnLoadTimeout(() => { calls += 1; throw new Error('git fetch timed out after 30000ms'); }, { attempts: 2 }), /timed out after 30000ms/);
    assert.equal(calls, 2);
  });
});

describe('greenTrainOf', () => {
  it('returns the train of a green land result', () => {
    const train = { trainId: 't1', result: 'green' };
    assert.equal(greenTrainOf({ status: 0, json: { train } }), train);
  });

  it('a null envelope fails with the CLI output (not a bare TypeError), and a timeout in it is retryable', () => {
    let err;
    try { greenTrainOf({ status: 1, json: null, stdout: '', stderr: 'fleet: git worktree add timed out after 15000ms' }); } catch (e) { err = e; }
    assert.match(err.message, /land did not build a green train \(status 1\)/);
    assert.ok(isLoadTimeout(err));
  });

  it('control: a red train is a verdict, so it is not retried - even when its reason says "timed out after"', () => {
    for (const reason of ['tier default failed', 'tier default timed out after 15000ms']) {
      let err;
      try { greenTrainOf({ status: 3, json: { train: { result: 'red', reason } } }); } catch (e) { err = e; }
      assert.ok(err, 'a red train must throw');
      assert.equal(isLoadTimeout(err), false, reason);
    }
  });
});
