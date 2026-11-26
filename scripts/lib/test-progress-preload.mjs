/**
 * @fileoverview The `--import` preload `npm test` gives every per-file test child (scripts/run-tests.mjs). It writes one
 * `test-progress/v1` line when the file loads, one each time a test instance starts or ends, and one on exit, to the file
 * named in TEST_PROGRESS_FILE. That file is how the runner times each test, how its idle watchdog sees progress, and the only
 * way to name a test that hung: node delivers a file's own events to the runner only after the file ends, and none at all from
 * a file stuck in a busy loop. Plan: docs/plans/test-runner-hang-guard.md, sections 1.2 and 2.2.
 *
 * - Writes are SYNCHRONOUS (`appendFileSync`), so the start line of a test that then busy-loops is already on disk, and the
 *   `exit` line lands from `process.on('exit')`.
 * - Each instance gets a unique `id` in `beforeEach`, and a late `t.after()` writes its end with that id, so concurrent and
 *   same-named tests pair exactly. `seq` counts this process's lines, so the
 *   runner can see a lost one. `proc` is a random nonce, so a reused pid cannot merge two processes.
 * - Every write is in a try/catch: instrumentation must never fail a test.
 * - It does nothing unless the runner set TEST_PROGRESS_FILE, node set NODE_TEST_CONTEXT (this is a test child), and the entry
 *   script matches node's own default test-file patterns or is a file the caller named (TEST_PROGRESS_EXTRA_FILES), so a plain
 *   script a test spawns with `process.execArgv` records nothing. `load` carries `ppid`, and the runner ignores any record whose
 *   parent is not itself (a helper named like a test file).
 *
 * @module scripts/lib/test-progress-preload
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach } from 'node:test';

import { PROGRESS_EXTRA_FILES_ENV, PROGRESS_FILE_ENV, PROGRESS_VERSION, isNodeTestFileName } from './test-hang-guard.mjs';

const target = process.env[PROGRESS_FILE_ENV];
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
// The runner's manifest of files the caller named that match no default pattern (a file, not an env string: a glob can select
// more paths than one variable holds). Unreadable → empty; the runner's end-of-run check then reports the missing record.
const named = (() => {
  const manifest = process.env[PROGRESS_EXTRA_FILES_ENV];
  if (!manifest) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(manifest, 'utf8')).map((p) => fold(path.resolve(p)))); } catch { return new Set(); }
})();

if (target && process.env.NODE_TEST_CONTEXT && (isNodeTestFileName(entry) || named.has(fold(entry)))) {
  const proc = randomBytes(6).toString('hex');
  let seq = 0;
  let nextId = 0;
  const ends = new WeakMap();
  const write = (fields) => {
    seq += 1;
    try { fs.appendFileSync(target, `${JSON.stringify({ v: PROGRESS_VERSION, proc, seq, file: entry, at: Date.now(), ...fields })}\n`); } catch { /* never fail a test */ }
  };
  write({ ev: 'load', pid: process.pid, ppid: process.ppid });
  process.on('exit', () => write({ ev: 'exit' }));
  // Root-level hooks run for every test instance in the file, at any nesting depth, including `t.test` subtests.
  // The END is a `t.after()` hook registered as LATE as possible, so it runs after the body AND after the test's own after
  // hooks (node runs a root afterEach first, then t.after hooks in registration order; probed on v22.23.2). It is registered
  // from afterEach, or, for a test that calls `t.skip()` at run time (node then skips afterEach), from that call: t.after still
  // runs once the body finishes, so a body that skips and then hangs stays timed.
  // A hook the test registers AFTER the end hook (after a t.skip, or from a user afterEach) would still run later, so the end
  // hook counts registrations and, if any arrived since it was armed, re-registers itself behind them instead of writing.
  beforeEach((t) => {
    nextId += 1;
    const id = nextId;
    const name = t.fullName ?? t.name;
    write({ ev: 'start', id, name });
    if (typeof t.after !== 'function') return;
    const after = t.after.bind(t);
    let registered = 0;
    let seen = -1;
    t.after = (...a) => { registered += 1; return after(...a); };
    const endHook = () => {
      if (registered > seen) { seen = registered; after(endHook); return; }
      write({ ev: 'end', id, name });
    };
    const arm = () => { if (seen >= 0) return; seen = registered; after(endHook); };
    ends.set(t, arm);
    if (typeof t.skip === 'function') { const skip = t.skip.bind(t); t.skip = (...a) => { arm(); return skip(...a); }; }
  });
  afterEach((t) => ends.get(t)?.());
}
