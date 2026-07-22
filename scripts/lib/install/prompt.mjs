/**
 * @fileoverview Shared interactive-prompt factory for the two top-level setup
 * wizards (install.mjs, setup.mjs) — both independently built an identical
 * `readline` interface + `ask()` promise wrapper (flagged by
 * `arch:duplicates`). A factory (not a bare singleton) because each script is
 * its own process with its own stdin/stdout lifecycle — they are never run
 * together, but each needs its own interface instance and its own `rl.close()`.
 *
 * @module scripts/lib/install/prompt
 */

import readline from 'readline';

/**
 * Create a fresh readline interface bound to process stdin/stdout, plus an
 * `ask(question)` promise wrapper over it.
 * @returns {{rl: import('readline').Interface, ask: (q: string) => Promise<string>}}
 */
export function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  return { rl, ask };
}
