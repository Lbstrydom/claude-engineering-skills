/**
 * The pinned fixture reads the heartbeat of the run launched in it (run id = fixture name):
 * `verify` reports it (STALE fails), `remove` refuses while the run is RUNNING or STALE with a live child.
 * Real git repo, real CLI, real journal. Plan: docs/plans/test-campaign-controls.md follow-up (item 2).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, removeFixture } from '../scripts/lib/pinned-worktree/manage.mjs';
import { resolveRunsDir, startRun, appendRun, runBlocksRemoval } from '../scripts/lib/run-heartbeat.mjs';
import { git } from './helpers/git.mjs';

const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'scripts', 'pinned-worktree.mjs');
let ROOT; let REPO; let FIXTURES; let SHA;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pwt-hb-'));
  REPO = path.join(ROOT, 'repo');
  FIXTURES = path.join(ROOT, 'fixtures');
  fs.mkdirSync(path.join(REPO, 'node_modules', 'fakepkg'), { recursive: true });
  git(['init', '-b', 'main'], REPO);
  git(['config', 'user.email', 'test@example.invalid'], REPO);
  git(['config', 'user.name', 'test'], REPO);
  fs.writeFileSync(path.join(REPO, 'package.json'), '{"name":"pwt-hb","version":"1.0.0","dependencies":{}}');
  fs.writeFileSync(path.join(REPO, 'package-lock.json'), '{"name":"pwt-hb","lockfileVersion":3,"packages":{}}');
  fs.writeFileSync(path.join(REPO, '.gitignore'), 'node_modules/\n');
  git(['add', '-A'], REPO);
  git(['commit', '-m', 'init'], REPO);
  SHA = git(['rev-parse', 'HEAD'], REPO);
});
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } });

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--root', FIXTURES], { cwd: REPO, encoding: 'utf-8' });
const runsDirOf = (dir) => resolveRunsDir(dir).dir;

describe('runBlocksRemoval', () => {
  it('blocks RUNNING and STALE-with-a-live-child only', () => {
    assert.equal(runBlocksRemoval({ state: 'RUNNING', runId: 'r', reason: 'x' }).block, true);
    assert.equal(runBlocksRemoval({ state: 'STALE', runId: 'r', childPid: 1, childAlive: true }).block, true);
    for (const v of [{ state: 'STALE', childAlive: false }, { state: 'STALE', childAlive: 'unknown' }, { state: 'ENDED_OK' }, { state: 'ENDED_FAILED' }, { state: 'UNKNOWN' }, null]) {
      assert.equal(runBlocksRemoval(v).block, false, JSON.stringify(v));
    }
  });
});

describe('pinned-worktree CLI reads the fixture run heartbeat', () => {
  it('a fixture and its runs share one runs dir (the git common dir)', () => {
    const f = createFixture({ name: 'hb-shared', rev: SHA, root: FIXTURES, cwd: REPO });
    try { assert.equal(path.resolve(runsDirOf(f.dir)), path.resolve(runsDirOf(REPO))); } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
  });

  it('remove refuses while the run is RUNNING, and --force overrides', () => {
    const f = createFixture({ name: 'hb-running', rev: SHA, root: FIXTURES, cwd: REPO });
    startRun(runsDirOf(f.dir), { runId: 'hb-running', staleAfterSec: 900 });
    const refused = cli('remove', '--name', 'hb-running');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /RUNNING/);
    assert.equal(fs.existsSync(f.dir), true, 'the fixture is still there');
    const forced = cli('remove', '--name', 'hb-running', '--force');
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fs.existsSync(f.dir), false);
  });

  it('remove proceeds once the run has ended, and with no journal at all', () => {
    const f = createFixture({ name: 'hb-ended', rev: SHA, root: FIXTURES, cwd: REPO });
    startRun(runsDirOf(f.dir), { runId: 'hb-ended', staleAfterSec: 900 });
    appendRun(runsDirOf(f.dir), { runId: 'hb-ended', kind: 'end', exitCode: 0 });
    assert.equal(cli('remove', '--name', 'hb-ended').status, 0);
    createFixture({ name: 'hb-none', rev: SHA, root: FIXTURES, cwd: REPO });
    assert.equal(cli('remove', '--name', 'hb-none').status, 0);
  });

  it('verify reports the run, and a STALE run fails verify', () => {
    const f = createFixture({ name: 'hb-stale', rev: SHA, root: FIXTURES, cwd: REPO });
    try {
      const none = cli('verify', '--name', 'hb-stale');
      assert.match(none.stdout, /heartbeat\s+UNKNOWN/);
      startRun(runsDirOf(f.dir), { runId: 'hb-stale', staleAfterSec: 15, now: Date.now() - 600_000 });
      const stale = cli('verify', '--name', 'hb-stale');
      assert.match(stale.stdout, /FAIL heartbeat\s+STALE/);
      assert.equal(stale.status, 1);
    } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
  });
});
