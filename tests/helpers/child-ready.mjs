/**
 * @fileoverview Shared test helper — wait for a spawned child to PUBLISH its pid
 * before a deadline is allowed to kill it.
 *
 * A test that spawns `node child.mjs`, arms a short deadline, then reads the pid
 * file the child writes is racing node's startup against that deadline. Under CPU
 * load startup can exceed the deadline, the child is killed before it writes, and
 * the read throws `ENOENT` — a failure that says nothing about the code under test.
 * The fix is never a longer deadline (it only moves the race): the child signals
 * readiness by writing its pid, and the kill is delivered only once that signal exists.
 *
 * `waitForPidFile` is also the vacuous-pass guard: it resolves only with a pid that
 * was actually published, and throws a message naming the file when none was, so a
 * child that never started cannot make a "killed and reaped" assertion pass.
 *
 * @module tests/helpers/child-ready
 */
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Upper bound on the wait, generous because it only costs time on FAILURE. */
const READY_TIMEOUT_MS = 20_000;

/**
 * @param {number} pid
 * @returns {boolean} whether a process with this pid currently exists
 */
export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Poll for a pid file and return the pid it holds. An absent or still-empty file
 * (the child opened it but has not yet written) is "not ready", never an error.
 *
 * @param {string} file
 * @param {{timeoutMs?: number, pollMs?: number}} [opts]
 * @returns {Promise<number>} a positive integer pid
 * @throws {Error} when no pid was published within `timeoutMs`
 */
export async function waitForPidFile(file, { timeoutMs = READY_TIMEOUT_MS, pollMs = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8').trim(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (/^\d+$/.test(text) && Number(text) > 0) return Number(text);
    if (Date.now() - t0 >= timeoutMs) {
      throw new Error(`child never published its pid to ${file} within ${timeoutMs}ms (it did not start, or died first)`);
    }
    await sleep(pollMs);
  }
}
