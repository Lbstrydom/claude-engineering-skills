/**
 * @fileoverview A y/N prompt that ALWAYS settles (debt f4d57e36c0e2).
 *
 * The sync's shared-cloud-config prompt resolved only inside `rl.question`'s
 * callback. On Ctrl-D, a closed stdin or a piped-and-exhausted input the callback
 * never runs, the promise never settles, and with no handle left Node exits with
 * status **0** in the middle of the run — a half-finished sync reported as
 * success. Closing without an answer is an answer: decline.
 *
 * @module scripts/lib/sync-prompt
 */

import readline from 'node:readline';

/**
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, createInterface?: typeof readline.createInterface}} [opts]
 * @returns {(question: string) => Promise<boolean>}  resolves true only for an empty answer (default Y), `y` or `yes`
 */
/** Destroyed inputs that already carry the shared no-op error guard (one per stream, however many prompts). */
const guarded = new WeakSet();

export function createConfirmPrompt({ input = process.stdin, output = process.stderr, createInterface = readline.createInterface } = {}) {
  return (question) => new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    // One named handler, removed on EVERY settlement path: repeated prompts on a shared stdin must not accumulate listeners.
    const onInputError = () => { settle(false); rl.close(); };
    const settle = (value) => {
      // A DESTROYED stream may still have its error queued however long its _destroy takes (`destroyed`/`closed` flip
      // before the events are emitted), and no elapsed-time cutoff is right for every stream. So it gets ONE shared,
      // permanent no-op guard (never one per prompt), and this prompt's own handler goes either way: repeated prompts
      // neither accumulate listeners nor let a late error escape.
      if (input.destroyed && !guarded.has(input)) { guarded.add(input); input.on?.('error', () => {}); }
      input.removeListener?.('error', onInputError);
      if (!settled) { settled = true; resolve(value); }
    };
    // Close with no answer (EOF) or a stream error is a DECLINE, never a hang.
    rl.once('close', () => {
      if (!settled) output.write('\n  no input — declined\n');
      settle(false);
    });
    // Node forwards an input stream's error to the Interface, where an unhandled one would throw.
    rl.on('error', () => { settle(false); rl.close(); });
    input.once?.('error', onInputError); // older Nodes do not forward it to the Interface
    // A stream that ENDED before the prompt was created never emits `end` to this Interface: decline now, do not wait.
    if (input.readableEnded || input.destroyed) { output.write('\n  no input — declined\n'); settle(false); rl.close(); return; }
    rl.question(question, (answer) => {
      const a = String(answer).trim().toLowerCase();
      settle(a === '' || a === 'y' || a === 'yes');
      rl.close();
    });
  });
}
