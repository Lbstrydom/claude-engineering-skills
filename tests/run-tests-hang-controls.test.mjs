/**
 * POSITIVE CONTROLS for `npm test`'s hang protection (docs/plans/test-runner-hang-guard.md section 2.4). Each spawns the
 * REAL runner against tests/fixtures/run-tests-hang/, which the default globs never reach, and checks that a hang, a busy
 * loop and a hidden concurrent hang each fail ONE named test while the other file passes, that a caller's --test-timeout
 * stays node's own, and that the idle watchdog kills the whole tree, grandchild included. Every control has its own deadline
 * and stops whatever it started in `finally`, so a broken guard fails here instead of hanging the suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { stopTree } from '../scripts/lib/fleet/lease-spawn.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');
const FIX = 'tests/fixtures/run-tests-hang';
const DEADLINE_MS = 60_000;

/** Run the real runner with its own deadline. Resolves with its exit code, output and elapsed time; never hangs. */
function runRunner(args, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [RUNNER, ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { stopTree(child.pid, { force: true }); }, DEADLINE_MS);
    let settled = false;
    const done = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - t0 }); };
    child.on('close', (code) => done(code));
    // A broken guard can leave the supervisor's own detached child holding the pipes, so 'close' may never come: settle on
    // 'exit' after a short grace for the last output.
    child.on('exit', (code) => { setTimeout(() => done(code), 2_000).unref(); });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * A pid file for the hang fixture, plus a cleanup that stops what it recorded only while it is still running. A pid the
 * assertions already saw dead is never signalled: by then it may belong to an unrelated process.
 */
function pidFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hang-control-'));
  const file = path.join(dir, 'pids.json');
  const seenDead = new Set();
  return {
    file,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    dead: (pid) => { const gone = !alive(pid); if (gone) seenDead.add(pid); return gone; },
    cleanup: () => {
      try {
        for (const pid of Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))) if (!seenDead.has(pid) && alive(pid)) stopTree(pid, { force: true });
      } catch { /* nothing recorded */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// 8 s, not less: under a loaded machine a healthy file's import alone has taken seconds, and the import is timed as 'outside any
// test'. The real profiles are 300 s (CI) and 1800 s (local).
const STALL = { TEST_STALL_TIMEOUT_MS: '8000' };

describe('hang protection, real runner', { concurrency: true, timeout: DEADLINE_MS * 2 }, () => {
  it('a hung test is stopped at the per-test limit and named; the other file passes; its grandchild goes too', { timeout: DEADLINE_MS + 15_000 }, async () => {
    const pids = pidFile();
    try {
      const r = await runRunner(['--test-reporter=spec', `${FIX}/ok.test.mjs`, `${FIX}/hang.test.mjs`], { ...STALL, HANG_PID_FILE: pids.file });
      assert.equal(r.code, 1, r.stderr);
      assert.ok(r.ms < DEADLINE_MS, `finished in ${r.ms}ms`);
      assert.match(r.stderr, /PER-TEST LIMIT — a test ran past the limit:\s+tests\/fixtures\/run-tests-hang\/hang\.test\.mjs \(pid \d+\), over the 8s per-test limit:\s+- hangs forever/);
      assert.match(r.stderr, /its process was stopped/);
      assert.match(r.stdout, /✔ ok one/);
      assert.match(r.stdout, /✔ ok two/);
      const { test, grandchild } = pids.read();
      assert.equal(pids.dead(test), true, 'the hung test process is gone');
      assert.equal(pids.dead(grandchild), true, 'the grandchild it spawned is gone too');
    } finally { pids.cleanup(); }
  });

  it('a file that hangs while importing, before any test exists, is stopped at the limit and named outside any test', { timeout: DEADLINE_MS + 15_000 }, async () => {
    const r = await runRunner(['--test-reporter=spec', `${FIX}/ok.test.mjs`, `${FIX}/import-hang.test.mjs`], STALL);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /import-hang\.test\.mjs \(pid \d+\), over the 8s per-test limit:\s+- outside any test \(loading, or in a hook\)/);
    assert.match(r.stdout, /✔ ok one/);
  });

  it('a test file the caller names outside node\'s default patterns is instrumented by name', { timeout: DEADLINE_MS + 15_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'tests', 'fixtures', 'run-tests-hang', 'tmp-'));
    try {
      const odd = path.join(dir, 'oddly-named.mjs');
      fs.copyFileSync(path.join(ROOT, FIX, 'hang.test.mjs'), odd);
      const r = await runRunner(['--test-reporter=spec', path.relative(ROOT, odd)], STALL);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /oddly-named\.mjs \(pid \d+\), over the 8s per-test limit:\s+- hangs forever/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a busy loop is stopped at the per-test limit and named; the other file passes', { timeout: DEADLINE_MS + 15_000 }, async () => {
    const r = await runRunner(['--test-reporter=spec', `${FIX}/ok.test.mjs`, `${FIX}/busy.test.mjs`], STALL);
    assert.equal(r.code, 1, r.stderr);
    assert.ok(r.ms < DEADLINE_MS, `finished in ${r.ms}ms`);
    assert.match(r.stderr, /busy\.test\.mjs \(pid \d+\), over the 8s per-test limit:\s+- busy loop/);
    assert.doesNotMatch(r.stderr, /- (before|after) busy/);
    assert.match(r.stdout, /✔ ok one/);
  });

  // End to end only: a concurrent hang beside a same-named test that finished first is found and named once. WHICH instance
  // survived cannot be seen here (both print alike); the id pairing itself is pinned by the tracker's unit test.
  it('a hang hidden by a same-named concurrent test that finished first is still found, once', { timeout: DEADLINE_MS + 15_000 }, async () => {
    const r = await runRunner(['--test-reporter=spec', `${FIX}/concurrent.test.mjs`], STALL);
    assert.equal(r.code, 1, r.stderr);
    const named = r.stderr.match(/^\s+- pair > same \(running/gm) ?? [];
    assert.equal(named.length, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /- pair > other/);
  });

  it('a caller\'s --test-timeout stays node\'s own: it fires first, untouched, and the record still names the test', { timeout: DEADLINE_MS + 15_000 }, async () => {
    const r = await runRunner(['--test-timeout=4000', '--test-reporter=spec', `${FIX}/hang.test.mjs`], { TEST_STALL_TIMEOUT_MS: '600000' });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /per-test limit 600s \(env\), idle watchdog \d+s \((ci|local)\), node file timeout 4s \(caller\)/);
    assert.match(r.stdout + r.stderr, /test timed out after 4000ms/);
    assert.match(r.stderr, /what was still running when the run ended:\s+tests that started and never finished:\s+- hangs forever/);
    assert.doesNotMatch(r.stderr, /PER-TEST LIMIT/);
  });

  it('the idle watchdog kills the whole tree, names the test, and fails closed', { timeout: DEADLINE_MS + 15_000 }, async () => {
    const pids = pidFile();
    try {
      const r = await runRunner([`${FIX}/hang.test.mjs`], { HANG_PID_FILE: pids.file, TEST_STALL_TIMEOUT_MS: '600000', TEST_IDLE_WATCHDOG_MS: '6000' });
      assert.equal(r.code, 1, r.stderr);
      assert.ok(r.ms < 30_000, `the watchdog, not the 600 s per-test limit, ended it (${r.ms}ms)`);
      assert.match(r.stderr, /IDLE WATCHDOG — no test started or finished for \d+s \(limit 6s\)/);
      assert.match(r.stderr, /- hangs forever\s+in tests\/fixtures\/run-tests-hang\/hang\.test\.mjs/);
      const { test, grandchild } = pids.read();
      assert.equal(pids.dead(test), true, 'the hung test process is gone');
      assert.equal(pids.dead(grandchild), true, 'the grandchild it spawned is gone too');
    } finally { pids.cleanup(); }
  });

  it('the preload is inert in a plain script a test spawns with process.execArgv: its stdout is untouched, nothing recorded', { timeout: DEADLINE_MS }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hang-preload-'));
    try {
      const progress = path.join(dir, 'progress.jsonl');
      fs.writeFileSync(progress, '');
      const script = path.join(dir, 'emit.mjs');
      fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ ok: true }));\n");
      const preload = new URL('../scripts/lib/test-progress-preload.mjs', import.meta.url).href;
      const out = await new Promise((resolve) => {
        const c = spawn(process.execPath, ['--import', preload, script], {
          env: { ...process.env, TEST_PROGRESS_FILE: progress, NODE_TEST_CONTEXT: 'child-v8' }, stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000, killSignal: 'SIGKILL',
        });
        let s = '';
        c.stdout.on('data', (d) => { s += d; });
        c.stderr.resume();
        c.on('close', (code) => resolve({ code, s }));
      });
      assert.deepEqual(out, { code: 0, s: '{"ok":true}' });
      assert.equal(fs.readFileSync(progress, 'utf8'), '');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an override that is not a positive integer, before running anything', { timeout: DEADLINE_MS }, async () => {
    const r = await runRunner([`${FIX}/ok.test.mjs`], { TEST_IDLE_WATCHDOG_MS: 'off' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /must be a positive integer/);
  });
});
