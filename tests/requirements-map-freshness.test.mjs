/**
 * `requirements:map:check` — the Category-B freshness gate for
 * `docs/requirements-map.md`, plus the determinism property that gate depends on.
 *
 * Why this exists: the map was committed but nothing verified it, so it had
 * drifted 26 requirements behind the ledger (189/24 vs 215/28) and carried the
 * title "clusterB" — a git WORKTREE directory name baked in, because the
 * renderer derived the repo name from `path.basename(cwd)`. A freshness gate
 * over a non-deterministic generator would have false-failed every checkout
 * whose folder is named differently, so the determinism fix is the load-bearing
 * half and is tested first.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { repoNameFor } from '../scripts/requirements.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = path.join(REPO, 'docs', 'requirements-map.md');

const runCheck = () => {
  try {
    execFileSync('node', ['scripts/requirements.mjs', 'render', '--check'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
};

describe('determinism — the property the gate rests on', () => {
  /**
   * Exercised in a temp directory whose NAME DIFFERS from the package name,
   * because that is the only place the bug is observable.
   *
   * An earlier version of this test asserted against the real repo and passed
   * with the fix reverted — this checkout's folder happens to be called
   * `claude-engineering-skills`, so both code paths returned the same string.
   * It was green by coincidence, in precisely the scenario the fix exists for.
   */
  test('repoNameFor reads COMMITTED package.json, not the directory name', async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'reqname-'));
    const dir = path.join(parent, 'clusterB'); // a worktree-style name
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'the-real-name' }));
      assert.equal(repoNameFor(dir), 'the-real-name');
      assert.notEqual(repoNameFor(dir), 'clusterB', 'must not fall back to the folder name');
    } finally {
      await fsp.rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('repoNameFor falls back to the directory name only when package.json is unusable', async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'reqname-'));
    const dir = path.join(parent, 'fallback-name');
    try {
      fs.mkdirSync(dir);
      assert.equal(repoNameFor(dir), 'fallback-name', 'no package.json → basename');
      fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
      assert.equal(repoNameFor(dir), 'fallback-name', 'unparseable package.json → basename');
    } finally {
      await fsp.rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('the committed map carries the package name as its title', () => {
    const pkgName = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).name;
    const title = fs.readFileSync(MAP, 'utf8').split('\n')[0];
    assert.equal(title, `# Requirements Map — ${pkgName}`);
  });

  test('rendering twice from the same source is byte-identical', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reqmap-'));
    try {
      const a = path.join(tmp, 'a.md');
      const b = path.join(tmp, 'b.md');
      const opts = { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
      execFileSync('node', ['scripts/requirements.mjs', 'render', '--out', path.relative(REPO, a)], opts);
      execFileSync('node', ['scripts/requirements.mjs', 'render', '--out', path.relative(REPO, b)], opts);
      assert.equal(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('the freshness gate itself', () => {
  test('passes when the committed map matches the ledger', () => {
    assert.equal(runCheck(), 0);
  });

  /**
   * The gate must FAIL on a stale map — a check that cannot go red is the
   * "green means it stopped looking" failure this repo keeps finding. Mutate,
   * assert red, restore, assert green.
   */
  test('fails (exit 1) when the map is stale, and recovers when restored', () => {
    const original = fs.readFileSync(MAP, 'utf8');
    try {
      fs.writeFileSync(MAP, original.replace(/^# Requirements Map.*$/m, '# Requirements Map — tampered'));
      assert.equal(runCheck(), 1, 'a stale map must fail the gate');
    } finally {
      fs.writeFileSync(MAP, original);
    }
    assert.equal(runCheck(), 0, 'restoring the map must clear the gate');
  });

  test('fails when the map is missing entirely, not silently passing', () => {
    const original = fs.readFileSync(MAP, 'utf8');
    try {
      fs.rmSync(MAP, { recursive: true, maxRetries: 3, retryDelay: 50 });
      assert.equal(runCheck(), 1);
    } finally {
      fs.writeFileSync(MAP, original);
    }
    assert.equal(runCheck(), 0);
  });

  test('--check never writes the file', () => {
    const before = fs.readFileSync(MAP, 'utf8');
    runCheck();
    assert.equal(fs.readFileSync(MAP, 'utf8'), before);
  });
});
