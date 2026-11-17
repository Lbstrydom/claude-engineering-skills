/**
 * @fileoverview Debt f4d57e36c0e2 — a prompt that never settles.
 *
 * The shared-cloud prompt resolved only inside `rl.question`'s callback. EOF /
 * Ctrl-D / a closed stdin never runs it, the promise stays pending, and with no
 * handle left Node exits 0 mid-run. Closing without an answer must DECLINE.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';

import { createConfirmPrompt } from '../scripts/lib/sync-prompt.mjs';

const harness = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => { written += d; });
  return { input, output, text: () => written };
};
const settlesWithin = (p, ms) => Promise.race([
  p.then((v) => ({ settled: true, v })),
  new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
]);

describe('createConfirmPrompt', () => {
  for (const [typed, want] of [['y\n', true], ['YES\n', true], ['\n', true], ['n\n', false], ['no\n', false], ['maybe\n', false]]) {
    it(`answers ${JSON.stringify(typed)} -> ${want}`, async () => {
      const h = harness();
      const p = createConfirmPrompt({ input: h.input, output: h.output })('go? ');
      h.input.write(typed);
      assert.equal(await p, want);
    });
  }

  it('EOF with no answer DECLINES within a bounded time (red: the parent logic never settles)', async () => {
    // The parent: resolve only in the question callback.
    const parent = (input, output) => new Promise((resolve) => {
      const rl = readline.createInterface({ input, output });
      rl.question('go? ', (a) => { rl.close(); resolve(a.trim() === '' || a === 'y'); });
    });
    const h1 = harness();
    const parentRun = parent(h1.input, h1.output);
    h1.input.end();
    assert.equal((await settlesWithin(parentRun, 300)).settled, false, 'red evidence: the parent promise is still pending after EOF');

    const h2 = harness();
    const run = createConfirmPrompt({ input: h2.input, output: h2.output })('go? ');
    h2.input.end();
    const r = await settlesWithin(run, 1000);
    assert.equal(r.settled, true, 'the prompt must settle on EOF');
    assert.equal(r.v, false, 'EOF declines');
    assert.match(h2.text(), /no input — declined/);
  });

  it('an answer followed by close settles exactly once with the answer (no late decline)', async () => {
    const h = harness();
    const p = createConfirmPrompt({ input: h.input, output: h.output })('go? ');
    h.input.write('y\n');
    h.input.end();
    assert.equal(await p, true);
    assert.doesNotMatch(h.text(), /declined/);
  });

  it('a stream error declines instead of hanging', async () => {
    const h = harness();
    const p = createConfirmPrompt({ input: h.input, output: h.output })('go? ');
    h.input.destroy(new Error('boom'));
    const r = await settlesWithin(p, 1000);
    assert.deepEqual([r.settled, r.v], [true, false]);
  });
});
