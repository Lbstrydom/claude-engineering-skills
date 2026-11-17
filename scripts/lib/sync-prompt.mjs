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
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    // Close with no answer (EOF) or a stream error is a DECLINE, never a hang.
    rl.once('close', () => {
      if (!settled) output.write('\n  no input — declined\n');
      settle(false);
    });
    // Node forwards an input stream's error to the Interface, where an unhandled one would throw.
    rl.on('error', () => { settle(false); rl.close(); });
    rl.question(question, (answer) => {
      const a = String(answer).trim().toLowerCase();
      settle(a === '' || a === 'y' || a === 'yes');
      rl.close();
    });
  });
}
