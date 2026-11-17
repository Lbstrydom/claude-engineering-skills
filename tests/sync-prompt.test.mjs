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
import { spawnSync } from 'node:child_process';

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

  it('input that ENDED before the prompt was created declines instead of waiting for an `end` it already missed (audit R1 H8)', async () => {
    const h = harness();
    h.input.end();
    h.input.resume();
    await new Promise((r) => setTimeout(r, 30)); // let `end` fire BEFORE any prompt exists
    assert.equal(h.input.readableEnded, true, 'precondition: the stream already ended');
    const r = await settlesWithin(createConfirmPrompt({ input: h.input, output: h.output })('go? '), 1000);
    assert.deepEqual([r.settled, r.v], [true, false]);
    // and a second prompt against the same exhausted stream behaves the same
    const r2 = await settlesWithin(createConfirmPrompt({ input: h.input, output: h.output })('again? '), 1000);
    assert.deepEqual([r2.settled, r2.v], [true, false]);
  });

  it('repeated prompts on one shared input do not accumulate error listeners (audit R2 M2/M3)', async () => {
    const h = harness();
    const baseline = h.input.listenerCount('error');
    for (const typed of ['y\n', 'n\n', '\n']) {
      const p = createConfirmPrompt({ input: h.input, output: h.output })('go? ');
      h.input.write(typed);
      await p;
    }
    await new Promise((r) => setImmediate(r)); // the listener is removed one turn after settling (see the destroyed-input test)
    assert.equal(h.input.listenerCount('error'), baseline, 'every settlement path must remove its listener');
    const h2 = harness();
    const b2 = h2.input.listenerCount('error');
    const eof = createConfirmPrompt({ input: h2.input, output: h2.output })('go? ');
    h2.input.end();
    await eof;
    await new Promise((r) => setImmediate(r));
    assert.equal(h2.input.listenerCount('error'), b2, 'the EOF path too');
  });

  it('a stream destroyed WITH AN ERROR immediately before the prompt declines cleanly: no uncaught exception (audit R3)', () => {
    // In a subprocess: an escaped stream error is a process-level uncaught exception, which would take the test runner down.
    const modUrl = new URL('../scripts/lib/sync-prompt.mjs', import.meta.url).href;
    const script = `import { PassThrough } from 'node:stream';
      import { createConfirmPrompt } from '${modUrl}';
      const input = new PassThrough(); const output = new PassThrough();
      input.destroy(new Error('boom'));
      const answer = await createConfirmPrompt({ input, output })('go? ');
      await new Promise((r) => setTimeout(r, 50));
      console.log('ANSWER=' + answer);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, `uncaught error escaped:
${r.stderr}`);
    assert.match(r.stdout, /ANSWER=false/);
  });

  it('a stream whose _destroy completes ASYNCHRONOUSLY, LATER than any cutoff (1.3s), still declines cleanly (audit R4/R5)', () => {
    const modUrl = new URL('../scripts/lib/sync-prompt.mjs', import.meta.url).href;
    const script = `import { Readable, PassThrough } from 'node:stream';
      import { createConfirmPrompt } from '${modUrl}';
      const input = new Readable({ read() {}, destroy(err, cb) { setTimeout(() => cb(err), 1300); } });
      const output = new PassThrough();
      input.destroy(new Error('late boom'));
      const answer = await createConfirmPrompt({ input, output })('go? ');
      await new Promise((r) => setTimeout(r, 1700));
      console.log('ANSWER=' + answer);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, `uncaught error escaped:
${r.stderr}`);
    assert.match(r.stdout, /ANSWER=false/);
  });

  it('many prompts on one already-DESTROYED input do not accumulate listeners (audit R6)', async () => {
    const h = harness();
    h.input.destroy();
    await new Promise((r) => setTimeout(r, 30));
    const baseline = h.input.listenerCount('error');
    for (let i = 0; i < 15; i++) assert.equal(await createConfirmPrompt({ input: h.input, output: h.output })('go? '), false);
    assert.ok(h.input.listenerCount('error') <= baseline + 1, `one shared guard at most, got ${h.input.listenerCount('error') - baseline} extra`);
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
