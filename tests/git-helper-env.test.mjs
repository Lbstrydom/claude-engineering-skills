/**
 * The shared fixture git runner (`tests/helpers/git.mjs`) can only touch the repo it is pointed at: an inherited GIT_DIR (a
 * pre-push hook exports one) must not retarget it. docs/plans/verification-lessons.md 2.1a (Cluster A audit, R1 H7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, fixtureGitEnv } from './helpers/git.mjs';

test('an inherited GIT_DIR / GIT_WORK_TREE does not retarget the fixture git runner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-helper-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const a = path.join(root, 'a');
  const decoy = path.join(root, 'decoy');
  fs.mkdirSync(a); fs.mkdirSync(decoy);
  execFileSync('git', ['init', '-q', a]);
  execFileSync('git', ['init', '-q', decoy]);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.GIT_DIR = path.join(decoy, '.git');
  process.env.GIT_WORK_TREE = decoy;
  const top = git(['rev-parse', '--show-toplevel'], a);
  assert.equal(fs.realpathSync(top), fs.realpathSync(a));
  // negative control: the raw env DOES retarget, so the assertion above can fail
  const raw = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: a, encoding: 'utf8', env: process.env }).trim();
  assert.equal(fs.realpathSync(raw), fs.realpathSync(decoy));
});

test('a caller that passes a selection variable deliberately keeps it', () => {
  assert.equal(fixtureGitEnv({ GIT_DIR: '/x' }).GIT_DIR, '/x');
  process.env.git_dir = '/inherited-lowercase';
  try { assert.equal(Object.keys(fixtureGitEnv()).some((k) => k.toUpperCase() === 'GIT_DIR'), false); } finally { delete process.env.git_dir; }
});
