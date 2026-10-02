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
 * **Spawned is not overlapping: workers wait on a start barrier.** Under the
 * full parallel suite one child's Node startup can outlast the other child's
 * entire run, so the two loops never overlap and the unlocked control kept
 * every line — failing as "the race was not exercised" with nothing wrong
 * (2 of 60 runs at 12-way parallelism, 2026-10-02). Each worker prints
 * `READY` and blocks on stdin; `runRacing` releases them together only once
 * all are ready.
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

/**
 * Worker prelude, interpolated into BOTH workers: announce readiness, then
 * block until the parent writes the start signal. Shared on purpose — the
 * control only vouches for the positive test while both run one harness.
 */
const START_BARRIER = [
  "process.stdout.write('READY\\n');",
  'await new Promise((resolve) => process.stdin.once(\'data\', resolve));',
  'process.stdin.pause();',
].join('\n');

/**
 * Spawn `worker` once per tag, release all of them together once every one
 * has printed READY, and resolve with each worker's stdout after all exit
 * (rejecting on any non-zero code).
 */
async function runRacing(worker, tags, argsFor) {
  const children = tags.map((tag) => {
    const child = spawn(process.execPath, [worker, ...argsFor(tag)], { timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.includes('READY\n')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`worker exited ${code} before READY: ${stderr}`)));
    });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`worker exited ${code}: ${stderr}`));
      });
    });
    return { child, ready, done };
  });
  await Promise.all(children.map((c) => c.ready));
  for (const { child } of children) child.stdin.end('go\n');
  return Promise.all(children.map((c) => c.done));
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
${START_BARRIER}
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
    await runRacing(worker, ['a', 'b'], (tag) => [logPath, tag, String(COUNT)]);

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
    //
    // The unlocked race surfaces in one of TWO ways, both the defect the lock
    // prevents. POSIX rename always replaces, so it shows as a silently lost
    // update. Windows' MoveFileEx refuses to replace a file another process
    // has open — EPERM/EBUSY that can outlast atomicWriteFileSync's own
    // retries under load — so it shows as a REFUSED write. Letting that crash
    // the worker made this control flake under the parallel pre-push suite
    // (3 blocked pushes, 2026-10-02); the worker counts it instead.
    const worker = path.join(tmpDir, 'worker-unlocked.mjs');
    fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from ${JSON.stringify(url.pathToFileURL(FILE_IO_MODULE).href)};
const [logPath, tag, countStr] = process.argv.slice(2);
const count = Number(countStr);
const CONTENTION = new Set(['EPERM', 'EBUSY', 'EACCES']);
let refused = 0;
${START_BARRIER}
for (let i = 0; i < count; i++) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const prior = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    // Widen the read-then-write window deliberately, same technique as the
    // locked worker above — without it the two processes rarely land in the
    // same instant and the race is not exercised.
    for (let s = 0; s < 50000; s++) { /* burn */ }
    atomicWriteFileSync(logPath, prior + JSON.stringify({ tag, i }) + '\\n');
  } catch (err) {
    if (!CONTENTION.has(err.code)) throw err;
    refused += 1;
  }
}
process.stdout.write('REFUSED ' + refused + '\\n');
`);
    const COUNT = 25;
    const outputs = await runRacing(worker, ['a', 'b'], (tag) => [logPath, tag, String(COUNT)]);

    const refused = outputs.reduce((sum, out) => {
      const m = /^REFUSED (\d+)$/m.exec(out);
      assert.ok(m, `worker did not report its refused-write count; stdout: ${out}`);
      return sum + Number(m[1]);
    }, 0);
    const lines = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
      : [];
    const lost = COUNT * 2 - lines.length;
    // A refused write never reaches the file, so each one is a missing line;
    // more refusals than missing lines means the accounting itself is wrong.
    assert.ok(refused <= lost,
      `${refused} refused writes but only ${lost} lines missing — refusal accounting is broken`);
    assert.ok(lost >= 1,
      `expected the unlocked race to lose or refuse at least one of ${COUNT * 2} lines, but all survived — `
      + 'this platform/timing did not exercise the race; strengthen the control rather than trust the positive test alone');
  });
});
