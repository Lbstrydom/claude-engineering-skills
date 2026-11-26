// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: one test never settles (a live interval keeps the
// event loop up, so node cannot detect it). With HANG_PID_FILE set it first spawns a grandchild and records both pids, so
// the control can check the tree kill and the orphan sweep reached it. Not in the default globs.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('before hang', () => {});

test('hangs forever', async () => {
  if (process.env.HANG_PID_FILE) {
    const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.HANG_PID_FILE, JSON.stringify({ test: process.pid, grandchild: gc.pid }));
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});

test('after hang', () => {});
