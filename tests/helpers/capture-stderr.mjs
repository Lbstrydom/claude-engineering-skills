/**
 * @fileoverview Capture everything a callback writes to `process.stderr`.
 *
 * THE one helper (audit-code R1 M8 / R2 M2): this function had been written once per test file,
 * and the duplicate detector flagged each new copy against the one in
 * `persist-kept-embeddings.test.mjs` at 0.90 similarity. That file now imports this too, so
 * there is one definition. Restores the original writer even when `fn` throws, and returns what
 * was written — so a test can assert on a stage's diagnostics, including the ABSENCE of one.
 */

/**
 * @param {() => unknown | Promise<unknown>} fn
 * @returns {Promise<{result: unknown, lines: string[], text: string}>} `result` is what `fn`
 *   returned; `lines` is each stderr write; `text` is them joined.
 */
export async function captureStderr(fn) {
  const original = process.stderr.write;
  const lines = [];
  // Honour both `write(chunk, callback)` and `write(chunk, encoding, callback)`: code under test
  // may pass a completion callback and wait on it, and a stand-in that drops it would hang that code.
  process.stderr.write = (chunk, encoding, callback) => {
    lines.push(String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') process.nextTick(done);
    return true;
  };
  try {
    const result = await fn();
    return { result, lines, text: lines.join('') };
  } finally {
    process.stderr.write = original;
  }
}
