// Standalone fixture for the "t.after() runs even when the test fails"
// regression in receipt.test.mjs (5cf9d863). Run via `node --test` as a
// CHILD process — a failed it() cannot be observed from inside the same
// process, so the parent test spawns this file, lets it fail (expected),
// and checks from the OUTSIDE that the directory is gone.
//
// The case directory path is written to MARKER_FILE (a real file, not
// stdout) BEFORE the deliberate throw: node:test's TAP reporter escapes
// stray stdout writes from inside a test when embedding them as diagnostic
// comments (backslashes get doubled), which corrupts a Windows path if read
// back from captured stdout. A filesystem side-channel has no such mangling.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('deliberately fails after registering cleanup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-cleanup-case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  fs.writeFileSync(process.env.MARKER_FILE, dir);
  throw new Error('deliberate failure to prove t.after() still runs');
});
