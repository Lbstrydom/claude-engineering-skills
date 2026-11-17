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
export function createConfirmPrompt({ input = process.stdin, output = process.stderr, createInterface = readline.createInterface } = {}) {
  return (question) => new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    // One named handler, removed on EVERY settlement path: repeated prompts on a shared stdin must not accumulate listeners.
    const onInputError = () => { settle(false); rl.close(); };
    const settle = (value) => {
      // Owned through the stream's own lifecycle. A DESTROYED stream may still have its error queued (`destroyed`/`closed`
      // flip before the events are emitted, and an async _destroy emits them later), so its handler stays until `close`,
      // with a bounded timer as the backstop for a stream that already closed or never emits it; otherwise it goes now.
      const release = () => input.removeListener?.('error', onInputError);
      if (input.destroyed && input.once) { input.once('close', release); setTimeout(release, 1000).unref(); } else release();
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
