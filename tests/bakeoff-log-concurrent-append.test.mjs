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
 * **The interleaving is FORCED, not hoped for.** The negative control used to
 * widen the read→write window with a CPU burn and assert that *some* line was
 * lost. That is a bet on the scheduler, and it lost: 2026-10-02 it read "all
 * survived" in the pre-push sandbox and in 1 of 3 local Windows runs, blocking
 * an unrelated push. The worker now carries a cross-process barrier seam
 * between its read and its write (marker files, one per racer per round):
 * each racer reads, announces it has read, and waits until its peer has read
 * too before writing. Both therefore write `prior + own line` over the SAME
 * prior, so exactly one line per round survives — `COUNT` lines, every run,
 * on every platform. A second barrier after the write keeps rounds in
 * lock-step so the count is exact rather than merely "fewer".
 *
 * The barrier is also what makes the control FALSIFIABLE: run the identical
 * barrier harness with the lock applied and the first racer into the critical
 * section can never see its peer arrive (the peer is outside, refused the
 * lock), so its bounded wait expires, it writes alone, and nothing is lost.
 * The third test pins that: same harness + lock ⇒ every line survives, so
 * the control's predicate genuinely fails when the race is closed.
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

/** Rounds per racer. */
const COUNT = 25;
/**
 * Rounds for the lock-applied barrier run. Each round costs one full
 * LOCKED_BARRIER_MS wait while the refused peer spins on sync lock
 * contention, and one refused rendezvous already proves the point; 8 keeps
 * the evidence repeated without dominating the file's runtime.
 */
const LOCKED_BARRIER_COUNT = 8;
/**
 * Read-barrier wait when the race is open. Only a peer that cannot reach its
 * own read in this long misses, so a miss means a starved host, never a
 * timing coin-flip — and a miss FAILS the control (it is counted and
 * asserted zero), never passes it.
 */
const OPEN_RACE_BARRIER_MS = 15_000;
/**
 * Read-barrier wait under the lock. The peer cannot arrive here by
 * construction (it is refused the lock), so this is pure cost per round;
 * keep it short.
 */
const LOCKED_BARRIER_MS = 40;

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
 * Write the racer worker. One read-modify-write helper, deliberately the SAME
 * shape as the fixed call site in bakeoff-collect.mjs — mkdirSync(dirname) ->
 * read prior (if any) -> atomicWriteFileSync(prior + line) — optionally
 * wrapped in withFileLockSync. The worker's fidelity to the real call site is
 * what makes this evidence. `afterRead` is the injected interleaving seam:
 * a no-op without a barrier dir, the cross-process barrier with one.
 *
 * argv: logPath tag peer count locked(0|1) barrierDir|- readBarrierMs
 * stdout (last line): {"barrierMisses": n}
 */
function writeWorker() {
  const worker = path.join(tmpDir, 'worker.mjs');
  fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from ${JSON.stringify(url.pathToFileURL(FILE_LOCK_MODULE).href)};
import { atomicWriteFileSync } from ${JSON.stringify(url.pathToFileURL(FILE_IO_MODULE).href)};
const [logPath, tag, peer, countStr, lockedStr, barrierDir, readBarrierMsStr] = process.argv.slice(2);
const count = Number(countStr);
const locked = lockedStr === '1';
const readBarrierMs = Number(readBarrierMsStr);
const WRITE_BARRIER_MS = 30000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
let barrierMisses = 0;

// Announce this racer reached \`phase\` of round \`i\`, then wait (bounded)
// for the peer to announce the same. Returns false on timeout.
function barrier(phase, i, waitMs) {
  fs.writeFileSync(path.join(barrierDir, \`\${phase}-\${i}-\${tag}\`), '');
  const peerMarker = path.join(barrierDir, \`\${phase}-\${i}-\${peer}\`);
  const deadline = Date.now() + waitMs;
  while (!fs.existsSync(peerMarker)) {
    if (Date.now() >= deadline) return false;
    Atomics.wait(sleepCell, 0, 0, 2);
  }
  return true;
}

function readModifyWrite(line, afterRead) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const prior = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
  afterRead();
  atomicWriteFileSync(logPath, prior + line);
}

const useBarrier = barrierDir !== '-';
for (let i = 0; i < count; i++) {
  const line = JSON.stringify({ tag, i }) + '\\n';
  const afterRead = useBarrier
    ? () => { if (!barrier('read', i, readBarrierMs)) barrierMisses += 1; }
    : () => { for (let s = 0; s < 50000; s++) { /* widen the window */ } };
  if (locked) {
    const r = withFileLockSync(\`\${logPath}.lock\`, { attempts: 40 }, () => readModifyWrite(line, afterRead));
    if (!r.ok) {
      process.stderr.write('LOCK_CONTENTION ' + tag + ' ' + i + '\\n');
      i -= 1; // retry this entry, mirroring "re-run to retry" at the real call site
      continue;
    }
  } else {
    readModifyWrite(line, afterRead);
  }
  // Keep rounds in lock-step so the next round's reads see BOTH of this
  // round's writes settled. Outside any lock, so it cannot deadlock; a miss
  // here is a hung peer, which is fatal rather than a quiet pass.
  if (useBarrier && !barrier('wrote', i, WRITE_BARRIER_MS)) {
    process.stderr.write('WRITE_BARRIER_TIMEOUT ' + tag + ' ' + i + '\\n');
    process.exit(2);
  }
}
process.stdout.write(JSON.stringify({ barrierMisses }) + '\\n');
`);
  return worker;
}

/** Spawn `worker args...`; resolve with its stdout, rejecting on a non-zero code. */
function runAsync(worker, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, ...args], { timeout: 120_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
}

/** Race racers 'a' and 'b'; return the surviving log lines and total barrier misses. */
async function race({ locked, barrier, readBarrierMs = 0, count = COUNT }) {
  const worker = writeWorker();
  let barrierDir = '-';
  if (barrier) {
    barrierDir = path.join(tmpDir, 'barrier');
    fs.mkdirSync(barrierDir);
  }
  const outs = await Promise.all([['a', 'b'], ['b', 'a']].map(([tag, peer]) =>
    runAsync(worker, [logPath, tag, peer, String(count), locked ? '1' : '0', barrierDir, String(readBarrierMs)])));
  const barrierMisses = outs
    .map((o) => JSON.parse(o.trim().split('\n').pop()).barrierMisses)
    .reduce((a, b) => a + b, 0);
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  return { lines, barrierMisses };
}

function assertNoLostUpdate(lines, count = COUNT) {
  const entries = lines.map((l) => JSON.parse(l));
  for (const tag of ['a', 'b']) {
    const seen = new Set(entries.filter((e) => e.tag === tag).map((e) => e.i));
    assert.equal(seen.size, count, `tag ${tag}: expected ${count} distinct entries, got ${seen.size} — a lost update`);
    for (let i = 0; i < count; i++) assert.ok(seen.has(i), `tag ${tag}: entry ${i} is missing — lost update`);
  }
}

describe('bakeoff-collect.mjs LOG_PATH append — locked, no lost updates under concurrency', () => {
  it('two racing collectors append N lines each and every line survives', async () => {
    const { lines } = await race({ locked: true, barrier: false });
    assertNoLostUpdate(lines);
  });

  it('NEGATIVE CONTROL: the same read-modify-write WITHOUT the lock loses updates — deterministically', async () => {
    // Proves the harness is a real positive control, not a vacuous pass: the
    // identical shape, minus withFileLockSync, with the read→write
    // interleaving FORCED by the barrier, loses exactly one line per round.
    const { lines, barrierMisses } = await race({ locked: false, barrier: true, readBarrierMs: OPEN_RACE_BARRIER_MS });
    assert.equal(barrierMisses, 0,
      `the read barrier timed out ${barrierMisses} time(s) with the race open — the host starved a racer for `
      + `${OPEN_RACE_BARRIER_MS}ms, so the interleaving was not forced. This is an instrument failure, not evidence.`);
    assert.equal(lines.length, COUNT,
      `expected the forced unlocked race to keep exactly ${COUNT} of ${COUNT * 2} lines (one lost per round), `
      + `got ${lines.length}`);
  });

  it('FALSIFIABILITY: the negative control\'s forced-interleaving harness WITH the lock loses nothing', async () => {
    // The barrier cannot complete inside a held lock — the peer is refused
    // entry — so every round exactly one racer's read barrier times out and it
    // writes alone. That proves (a) the control's "exactly COUNT lines"
    // predicate fails once the race is closed, and (b) the lock holds under
    // maximal, deliberately-staged contention, not just whatever the
    // scheduler happened to produce in the first test.
    const count = LOCKED_BARRIER_COUNT;
    const { lines, barrierMisses } = await race({ locked: true, barrier: true, readBarrierMs: LOCKED_BARRIER_MS, count });
    assert.equal(barrierMisses, count,
      `expected one refused rendezvous per round (${count}), got ${barrierMisses} — if this is 0 the lock did not `
      + 'exclude the peer from the critical section');
    assert.equal(lines.length, count * 2);
    assertNoLostUpdate(lines, count);
  });
});
