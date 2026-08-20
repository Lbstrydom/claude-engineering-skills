/**
 * @fileoverview `initLearningStore`'s "no pool configured" branch must clear
 * any previously-recorded init failure, not leave it standing.
 *
 * THE DEFECT THIS LOCKS (audit finding d5d1ccd9). `_recordInitFailure(err)` is
 * how a real connectivity/probe failure is fed to the advisory cloud-state
 * classifier (`client-state.mjs`'s `getCloudState()`), so the dispatcher can
 * tell "cloud deliberately off" apart from "cloud configured but unreachable"
 * (client-state.mjs's own module doc). `initLearningStore()` has three exit
 * paths — `getPool()` throws, `getPool()` returns null (not configured), and
 * the connectivity probe fails — and only two of the three touched
 * `_initFailure`: the throw path records a failure, the probe-failure path
 * records a failure, the success path clears it via `_clearInitFailure()` —
 * but the "not configured" (`!pool`) path did neither. Within one process
 * `initLearningStore()` is called exactly once by the real dispatcher
 * (scripts/lib/cross-skill/dispatch.mjs), so `_initFailure` starts null each
 * call in production — but the module-level singleton is not reset between
 * multiple in-process calls (a batch script iterating repos/env states can
 * do this), so a stale failure from an earlier call could outlive a later
 * "not configured" result and make `getCloudState()` report `'unreachable'`
 * for a store nobody is even trying to reach.
 *
 * Run as a SUBPROCESS with an isolated cwd/HOME and no DSN env vars — never
 * in-process — because `lib/load-env.mjs` loads the CWD `.env` layer as an
 * unconditional import side effect (not gated by `AUDIT_LOOP_DISABLE_SHARED`,
 * which only disables the ~/.audit-loop.env layer), and this repo's own
 * gitignored `.env` carries a real production `AUDIT_DB_URL`. Deleting the
 * var from `process.env` before an in-process dynamic import does not help:
 * the import itself repopulates it from that file. A fresh tmp cwd/HOME has
 * neither file, so no real DSN is ever in scope.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_MJS_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/store/repo.mjs')).href;
const CLIENT_STATE_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/store/client-state.mjs')).href;

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-failure-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('initLearningStore: the "not configured" path resets stale init-failure state', () => {
  it('a prior recorded failure does not survive a later no-DSN call', () => {
    const script = `
      const { initLearningStore } = await import(${JSON.stringify(REPO_MJS_URL)});
      const { _recordInitFailure, getCloudState, getCloudInitFailure } = await import(${JSON.stringify(CLIENT_STATE_URL)});

      // Simulate an EARLIER in-process call that hit a real connectivity
      // error (what initLearningStore's catch/probe-failure branches do).
      _recordInitFailure(new Error('simulated stale connectivity failure'));
      if (getCloudInitFailure() !== 'simulated stale connectivity failure') {
        throw new Error('precondition failed: failure was not recorded');
      }

      // No DSN anywhere in scope (fresh cwd + HOME, no env var) → getPool()
      // returns null with no throw and no network attempt — the "not
      // configured" branch, exercised for real, not mocked.
      const enabled = await initLearningStore();
      if (enabled !== false) throw new Error('expected not-configured (false), got ' + enabled);

      const failureAfter = getCloudInitFailure();
      if (failureAfter !== null) throw new Error('stale failure was not cleared: ' + JSON.stringify(failureAfter));

      const state = getCloudState();
      if (state !== 'off') throw new Error('expected cloud state "off", got ' + JSON.stringify(state));

      console.log('OK');
    `;
    const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
    const env = {
      PATH: process.env.PATH,
      HOME: dir, USERPROFILE: dir,       // no ~/.audit-loop.env reachable
      AUDIT_LOOP_DISABLE_SHARED: '1',    // belt-and-suspenders on the shared layer
    };
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env, cwd: dir, timeout: 30_000,
    });
    assert.equal(r.status, 0, `subprocess failed (status ${r.status}):\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.match(r.stdout, /OK/);
  });
});
