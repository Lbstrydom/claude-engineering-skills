import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withCaseTree } from '../scripts/lib/model-eval/case-tree.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'case-tree-'));
  sh(r, 'init', '-q');
  fs.writeFileSync(path.join(r, 'a.js'), 'one\n');
  sh(r, 'add', '.'); sh(r, 'commit', '-q', '-m', 'c1');
  const sha = sh(r, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r, 'a.js'), 'two\n'); sh(r, 'commit', '-q', '-am', 'c2');
  return { r, sha };
}
const registered = (r) => sh(r, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

describe('withCaseTree', () => {
  test('hands fn a checkout of the commit, and removes it and its registration after', async () => {
    const { r, sha } = repo();
    try {
      let dir;
      const out = await withCaseTree({ repoRoot: r, sha }, async (d) => { dir = d; return fs.readFileSync(path.join(d, 'a.js'), 'utf8'); });
      assert.equal(out, 'one\n', 'the case commit, not the checkout (which says two)');
      assert.equal(fs.existsSync(dir), false);
      assert.equal(registered(r), 1);
    } finally { rm(r); }
  });

  test('a repository post-checkout hook cannot rewrite the audited tree', async () => {
    const { r, sha } = repo();
    try {
      const hook = path.join(r, '.git', 'hooks', 'post-checkout');
      fs.writeFileSync(hook, '#!/bin/sh\necho tampered > a.js\n', { mode: 0o755 });
      const out = await withCaseTree({ repoRoot: r, sha }, async (d) => fs.readFileSync(path.join(d, 'a.js'), 'utf8'));
      assert.equal(out, 'one\n');
    } finally { rm(r); }
  });

  test('NEGATIVE CONTROL: the same hook DOES rewrite a tree made with hooks enabled, so the test above can fail', () => {
    const { r, sha } = repo();
    const dir = path.join(os.tmpdir(), `case-tree-ctl-${process.pid}`);
    try {
      fs.writeFileSync(path.join(r, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho tampered > a.js\n', { mode: 0o755 });
      sh(r, 'worktree', 'add', '--detach', dir, sha);
      assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').trim(), 'tampered', 'the probe sees a hook when hooks are enabled');
    } finally { try { sh(r, 'worktree', 'remove', '--force', dir); } catch { /* */ } rm(dir); rm(r); }
  });

  test('inherited repository-selection variables (a git hook sets them) do not redirect it to another repository', async () => {
    const { r, sha } = repo();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'case-tree-other-'));
    sh(other, 'init', '-q');
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other, '.git'); process.env.GIT_WORK_TREE = other;
    try {
      const out = await withCaseTree({ repoRoot: r, sha }, async (d) => fs.readFileSync(path.join(d, 'a.js'), 'utf8'));
      assert.equal(out, 'one\n');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rm(r); rm(other);
    }
  });

  test('an unsafe revision is refused before anything is created', async () => {
    await assert.rejects(() => withCaseTree({ repoRoot: os.tmpdir(), sha: '--upload-pack=x y' }, async () => 1), /not a safe git revision/);
  });

  test('fn\'s own error propagates unchanged and the tree is still removed', async () => {
    const { r, sha } = repo();
    try {
      let dir;
      await assert.rejects(() => withCaseTree({ repoRoot: r, sha }, async (d) => { dir = d; throw new Error('boom'); }), (e) => e.message === 'boom' && e.cleanupErrors === undefined);
      assert.equal(fs.existsSync(dir), false);
      assert.equal(registered(r), 1);
    } finally { rm(r); }
  });

  test('a LOCKED worktree is still removed, with no registration left behind', async () => {
    const { r, sha } = repo();
    try {
      let dir;
      await withCaseTree({ repoRoot: r, sha }, async (d) => { dir = d; sh(r, 'worktree', 'lock', d); });
      assert.equal(fs.existsSync(dir), false);
      assert.equal(registered(r), 1, 'the locked registration is gone too');
    } finally { rm(r); }
  });

  const realGit = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: ENV });
  const failingRemove = (root, args) => { if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('simulated: cannot remove'); return realGit(root, args); };

  test('a removal that fails is REPORTED: the call throws, naming the leftover path and the recovery command, and the tree is left intact', async () => {
    const { r, sha } = repo();
    try {
      let dir;
      await assert.rejects(() => withCaseTree({ repoRoot: r, sha }, async (d) => { dir = d; return 1; }, { _git: failingRemove }),
        (e) => /could not be removed and was left at/.test(e.message) && e.message.includes(dir) && /worktree remove -f -f/.test(e.message) && /simulated: cannot remove/.test(e.message));
      assert.equal(fs.existsSync(path.join(dir, 'a.js')), true, 'left intact, not half-deleted');
      assert.equal(registered(r), 2, 'and still registered, so the recovery command works');
    } finally { try { sh(r, 'worktree', 'remove', '-f', '-f', path.join(os.tmpdir())); } catch { /* */ } try { sh(r, 'worktree', 'prune'); } catch { /* */ } rm(r); }
  });

  test('when fn threw, its error is rethrown unchanged (even frozen, even a primitive) and the cleanup failure is warned, not lost', async () => {
    const { r, sha } = repo();
    const warns = [];
    const frozen = Object.freeze(new Error('primary'));
    try {
      await assert.rejects(() => withCaseTree({ repoRoot: r, sha }, async () => { throw frozen; }, { _git: failingRemove, _warn: (m) => warns.push(m) }), (e) => e === frozen);
      await assert.rejects(() => withCaseTree({ repoRoot: r, sha }, async () => { throw 'boom'; }, { _git: failingRemove, _warn: (m) => warns.push(m) }), (e) => e === 'boom');
      assert.equal(warns.length, 2);
      assert.ok(warns.every((m) => /could not be removed and was left at/.test(m)));
    } finally { try { sh(r, 'worktree', 'prune'); } catch { /* */ } rm(r); }
  });

  test('a falsy thrown value is still a failure and is rethrown as thrown', async () => {
    const { r, sha } = repo();
    try {
      await assert.rejects(() => withCaseTree({ repoRoot: r, sha }, async () => { throw 0; }), (e) => e === 0);
      assert.equal(registered(r), 1);
    } finally { rm(r); }
  });

  test('a git that registers the worktree and then fails leaves no registration behind', async () => {
    const { r, sha } = repo();
    const realGit = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: ENV });
    const addThenDie = (root, args) => { const out = realGit(root, args); if (args[0] === 'worktree' && args[1] === 'add') throw new Error('killed mid-checkout'); return out; };
    try {
      await assert.rejects(() => withCaseTree({ repoRoot: r, sha }, async () => 1, { _git: addThenDie }), /killed mid-checkout/);
      assert.equal(registered(r), 1, 'the half-made registration was removed');
    } finally { rm(r); }
  });

  test('a failed removal never touches another worktree, including one that merely looks missing', async () => {
    const { r, sha } = repo();
    const other = path.join(os.tmpdir(), `case-tree-unrelated-${process.pid}`);
    try {
      sh(r, 'worktree', 'add', '--detach', other, sha);
      rm(other); // looks missing (an unavailable mount, say); a prune would unregister it
      await assert.rejects(() => withCaseTree({ repoRoot: r, sha }, async () => 1, { _git: failingRemove }), /could not be removed/);
      assert.ok(sh(r, 'worktree', 'list', '--porcelain').includes(other.split(path.sep).join('/')), 'the unrelated registration is untouched');
    } finally { try { sh(r, 'worktree', 'prune'); } catch { /* */ } rm(other); rm(r); }
  });
});
