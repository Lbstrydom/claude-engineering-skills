/**
 * A passing test that does what a real leak does: adds more listeners than the default
 * ceiling allows to one emitter. Used by tests/run-tests-timing.test.mjs to prove the runner
 * does not hide that warning from a test file (it must reach the developer exactly as under
 * plain `node --test`). Not a test file by name, so the suite's own glob never runs it.
 */
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

test('adds 11 listeners to one emitter', () => {
  const emitter = new EventEmitter();
  for (let i = 0; i < 11; i++) emitter.on('x', () => {});
});
