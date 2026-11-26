/**
 * @fileoverview The `--import` preload `npm test` gives every per-file test child (scripts/run-tests.mjs). It writes one
 * `test-progress/v1` line when the file loads, one each time a test instance starts or ends, and one on exit, to the file
 * named in TEST_PROGRESS_FILE. That file is how the runner times each test, how its idle watchdog sees progress, and the only
 * way to name a test that hung: node delivers a file's own events to the runner only after the file ends, and none at all from
 * a file stuck in a busy loop. Plan: docs/plans/test-runner-hang-guard.md, sections 1.2 and 2.2.
 *
 * - Writes are SYNCHRONOUS (`appendFileSync`), so the start line of a test that then busy-loops is already on disk, and the
 *   `exit` line lands from `process.on('exit')`.
 * - Each instance gets a unique `id` from a WeakMap on node's test context (node passes the same context object to
 *   `beforeEach` and `afterEach`), so concurrent and same-named tests pair exactly. `seq` counts this process's lines, so the
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
import { beforeEach, afterEach } from 'node:test';

import { PROGRESS_EXTRA_FILES_ENV, PROGRESS_FILE_ENV, PROGRESS_VERSION, isNodeTestFileName } from './test-hang-guard.mjs';

const target = process.env[PROGRESS_FILE_ENV];
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const named = (() => { try { return new Set(JSON.parse(process.env[PROGRESS_EXTRA_FILES_ENV] || '[]').map((p) => fold(path.resolve(p)))); } catch { return new Set(); } })();

if (target && process.env.NODE_TEST_CONTEXT && (isNodeTestFileName(entry) || named.has(fold(entry)))) {
  const proc = randomBytes(6).toString('hex');
  let seq = 0;
  let nextId = 0;
  const ids = new WeakMap();
  const write = (fields) => {
    seq += 1;
    try { fs.appendFileSync(target, `${JSON.stringify({ v: PROGRESS_VERSION, proc, seq, file: entry, at: Date.now(), ...fields })}\n`); } catch { /* never fail a test */ }
  };
  write({ ev: 'load', pid: process.pid, ppid: process.ppid });
  process.on('exit', () => write({ ev: 'exit' }));
  // Root-level hooks run for every test instance in the file, at any nesting depth, including `t.test` subtests.
  beforeEach((t) => { nextId += 1; ids.set(t, nextId); write({ ev: 'start', id: nextId, name: t.fullName ?? t.name }); });
  afterEach((t) => write({ ev: 'end', id: ids.get(t) ?? -1, name: t.fullName ?? t.name }));
}
