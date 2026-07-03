/**
 * @fileoverview Tests for the deterministic arm-eval capture trigger.
 * Hermetic — spawn + toggle are injected, so nothing spends or hits the network.
 * Guards the property the user cares about: toggle off → never fires (parity
 * with the audit shadow); toggle on → fires once, round-1 only, never throws.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maybeFireArmEvalCaptureDetached, _internals } from '../scripts/lib/arm-eval/capture-trigger.mjs';

function makeSpawn() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  };
  return { spawnFn, calls };
}
const toggleOn = () => ({ enabled: true, budgetEur: 300 });
const toggleOff = () => ({ enabled: false });

describe('maybeFireArmEvalCaptureDetached', () => {
  it('toggle OFF → no-op, never spawns (audit-shadow parity)', () => {
    const { spawnFn, calls } = makeSpawn();
    const r = maybeFireArmEvalCaptureDetached({
      experimentType: 'brainstorm', task: 'a real topic', round: 1,
      spawnFn, readToggleFn: toggleOff,
    });
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'toggle-off');
    assert.equal(calls.length, 0);
  });

  it('toggle ON + round 1 → spawns detached with the right argv', () => {
    const { spawnFn, calls } = makeSpawn();
    const r = maybeFireArmEvalCaptureDetached({
      experimentType: 'brainstorm', task: 'multi\nline "topic" text', round: 1,
      spawnFn, readToggleFn: toggleOn,
    });
    assert.equal(r.fired, true);
    assert.equal(calls.length, 1);
    const { args, opts } = calls[0];
    assert.equal(args[0], _internals.CROSS_SKILL_PATH);
    assert.equal(args[1], 'arm-eval-maybe-capture');
    assert.deepEqual(args.slice(2), ['--experiment', 'brainstorm', '--task', 'multi\nline "topic" text']);
    assert.equal(opts.detached, true);
    assert.equal(opts.stdio, 'ignore');
  });

  it('plan-authoring with no round gate → fires', () => {
    const { spawnFn, calls } = makeSpawn();
    const r = maybeFireArmEvalCaptureDetached({
      experimentType: 'plan-authoring', task: 'author a plan for X',
      spawnFn, readToggleFn: toggleOn,
    });
    assert.equal(r.fired, true);
    assert.equal(calls[0].args[3], 'plan-authoring');
  });

  it('round 2+ → does NOT fire (captures a session once)', () => {
    const { spawnFn, calls } = makeSpawn();
    for (const round of [0, 2, 3]) {
      const r = maybeFireArmEvalCaptureDetached({
        experimentType: 'brainstorm', task: 't', round, spawnFn, readToggleFn: toggleOn,
      });
      assert.equal(r.fired, false);
      assert.match(r.reason, /not-first/);
    }
    assert.equal(calls.length, 0);
  });

  it('empty/missing task → no-op', () => {
    const { spawnFn, calls } = makeSpawn();
    for (const task of ['', '   ', undefined, null]) {
      const r = maybeFireArmEvalCaptureDetached({ experimentType: 'brainstorm', task, spawnFn, readToggleFn: toggleOn });
      assert.equal(r.fired, false);
    }
    assert.equal(calls.length, 0);
  });

  it('never throws — a spawn failure is swallowed', () => {
    const throwingSpawn = () => { throw new Error('spawn boom'); };
    const r = maybeFireArmEvalCaptureDetached({
      experimentType: 'brainstorm', task: 't', round: 1,
      spawnFn: throwingSpawn, readToggleFn: toggleOn,
    });
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'spawn-failed');
  });
});
