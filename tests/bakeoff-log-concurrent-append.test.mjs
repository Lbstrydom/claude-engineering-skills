/**
 * @fileoverview Cross-process regression guard for `bakeoff-collect.mjs`'s
 * `LOG_PATH` append (audit finding aa5a919c, HIGH): two collector processes
 * racing the same read-modify-write used to be able to both read the same
 * `prior` content and then both call `atomicWriteFileSync` — the second
 * rename wins outright, and the first process's whole new line is silently
 * LOST (not byte-interleaved corruption; `atomicWriteFileSync` already rules
 * that out — a clean lost UPDATE instead).
 *
 * **Must use async `spawn()` + `Promise.all`, not `spawnSync` inside
 * `.map()`.** `spawnSync` blocks the CALLER until the child exits, so
 * `['a','b'].map(tag => spawnSync(...))` runs worker 'a' to completion
 * before worker 'b' ever starts — verified empirically (two 500ms children
 * took ~1.1s total, not ~0.5s). That shape can never race, so a lock-removal
 * regression would pass it silently — the same class of vacuous pass this
 * repo's own R1-H1 rule exists to catch, one layer further in: not "a
 * same-process test cannot interleave a synchronous critical section" but "a
 * sequential-spawnSync test cannot interleave two processes at all."
 * `spawn()` returns immediately, so both children are genuinely running
 * before this file awaits their exits.
 *
 * @module tests/bakeoff-log-concurrent-append
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const FILE_LOCK_MODULE = path.join(REPO_ROOT, 'scripts', 'lib', 'file-lock.mjs');
const FILE_IO_MODULE = path.join(REPO_ROOT, 'scripts', 'lib', 'file-io.mjs');

let tmpDir;
let logPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bakeoff-log-concurrent-'));
  logPath = path.join(tmpDir, 'bakeoff-log.jsonl');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { /* best effort */ }
});

/** Spawn `worker args...` and resolve when it exits, rejecting on a non-zero code. */
function runAsync(worker, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, ...args], { timeout: 60_000 });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
}

describe('bakeoff-collect.mjs LOG_PATH append — locked, no lost updates under concurrency', () => {
  it('two racing collectors append N lines each and every line survives', async () => {
    const worker = path.join(tmpDir, 'worker.mjs');
    // Deliberately the SAME shape as the fixed call site in bakeoff-collect.mjs:
    // mkdirSync(dirname) -> read prior (if any) -> atomicWriteFileSync(prior + line),
    // the whole thing wrapped in withFileLockSync. If the wiring in
    // bakeoff-collect.mjs regresses back to an unlocked read-modify-write,
    // this same pattern run unlocked would lose lines under this test too —
    // the worker's fidelity to the real call site is what makes this evidence.
    fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from ${JSON.stringify(url.pathToFileURL(FILE_LOCK_MODULE).href)};
import { atomicWriteFileSync } from ${JSON.stringify(url.pathToFileURL(FILE_IO_MODULE).href)};
const [logPath, tag, countStr] = process.argv.slice(2);
const count = Number(countStr);
for (let i = 0; i < count; i++) {
  const r = withFileLockSync(\`\${logPath}.lock\`, { attempts: 40 }, () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const prior = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    for (let s = 0; s < 50000; s++) { /* widen the window inside the lock too */ }
    atomicWriteFileSync(logPath, prior + JSON.stringify({ tag, i }) + '\\n');
  });
  if (!r.ok) {
    process.stderr.write('LOCK_CONTENTION ' + tag + ' ' + i + '\\n');
    i -= 1; // retry this entry, mirroring "re-run to retry" at the real call site
  }
}
`);

    const COUNT = 25;
    await Promise.all(['a', 'b'].map((tag) => runAsync(worker, [logPath, tag, String(COUNT)])));

    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l));
    for (const tag of ['a', 'b']) {
      const seen = new Set(entries.filter((e) => e.tag === tag).map((e) => e.i));
      assert.equal(seen.size, COUNT, `tag ${tag}: expected ${COUNT} distinct entries, got ${seen.size} — a lost update`);
      for (let i = 0; i < COUNT; i++) assert.ok(seen.has(i), `tag ${tag}: entry ${i} is missing — lost update`);
    }
  });

  it('NEGATIVE CONTROL: the same read-modify-write WITHOUT the lock loses updates', async () => {
    // Proves the test itself is a real positive control, not a vacuous pass:
    // the identical shape, minus withFileLockSync, must demonstrably lose
    // lines under this exact harness.
    const worker = path.join(tmpDir, 'worker-unlocked.mjs');
    fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from ${JSON.stringify(url.pathToFileURL(FILE_IO_MODULE).href)};
const [logPath, tag, countStr] = process.argv.slice(2);
const count = Number(countStr);
for (let i = 0; i < count; i++) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const prior = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
  // Widen the read-then-write window deliberately, same technique as the
  // locked worker above — without it the two processes rarely land in the
  // same instant and the race is not exercised.
  for (let s = 0; s < 50000; s++) { /* burn */ }
  atomicWriteFileSync(logPath, prior + JSON.stringify({ tag, i }) + '\\n');
}
`);
    const COUNT = 25;
    await Promise.all(['a', 'b'].map((tag) => runAsync(worker, [logPath, tag, String(COUNT)])));

    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    assert.ok(lines.length < COUNT * 2,
      `expected the unlocked race to lose at least one of ${COUNT * 2} lines, but all survived — `
      + 'this platform/timing did not exercise the race; strengthen the control rather than trust the positive test alone');
  });
});
