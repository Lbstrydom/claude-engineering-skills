/**
 * @fileoverview /fleet train — a failed `git merge` is a CONFLICT only when `diff --diff-filter=U` lists a file
 * (field report 4: a transient Windows `spawnSync git ENOENT` was recorded as `reason: 'merge conflict', files: []`).
 *
 * Pinned: a non-conflict failure names its real reason (and status/stderr); an empty or FAILED conflict list is never
 * presented as a conflict; a spawn failure (git never ran) is retried once; a timeout/lock retries only when HEAD is
 * unchanged; the append-only path still resolves.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applySources } from '../scripts/lib/fleet/train.mjs';

const ENOENT = { ok: false, status: null, stdout: '', stderr: '', reason: 'git merge failed to run: spawnSync git ENOENT' };
const OK = (stdout = '') => ({ ok: true, status: 0, stdout, stderr: '', reason: null });
const SRC = [{ id: 's1', oid: '1'.repeat(40) }];

/** A scripted wgit: `script[sub]` is a queue of results (the last one repeats); HEAD advances only on a successful commit/merge. */
function fakeGit(script) {
  const calls = [];
  const q = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  let head = 'b'.repeat(40);
  const wgit = (args) => {
    const sub = args[0];
    calls.push(args);
    if (sub === 'rev-parse') return OK(`${head}\n`);
    const list = q[sub] ?? [OK()];
    const r = list.length > 1 ? list.shift() : list[0];
    if (r.ok && (sub === 'merge' || sub === 'commit')) head = 'c'.repeat(40);
    return r;
  };
  return { wgit, calls };
}
const run = (script, over = {}) => {
  const g = fakeGit(script);
  const sleeps = [];
  const res = applySources({ wgit: g.wgit, dir: '.', sources: SRC, mergeMethod: 'direct-merge', trainId: 't', sleep: (ms) => sleeps.push(ms), ...over });
  return { ...res, ...g, sleeps };
};

describe('applySources — what a failed merge is called', () => {
  it('spawn ENOENT twice + an empty diff is NOT "merge conflict" and carries the reason', () => {
    const { conflict, sleeps } = run({ merge: [ENOENT], diff: [OK('')] });
    assert.doesNotMatch(conflict.reason, /^merge conflict/);
    assert.match(conflict.reason, /^merge failed \(not a conflict\):.*spawnSync git ENOENT/);
    assert.deepEqual(conflict.files, []);
    assert.equal(sleeps.length, 1, 'retried exactly once');
  });
  it('negative control: a diff that lists a file still reads "merge conflict"', () => {
    const { conflict } = run({ merge: [{ ok: false, status: 1, stdout: '', stderr: 'CONFLICT (content)', reason: 'git merge exited 1: CONFLICT' }], diff: [OK('src/a.js\n')] });
    assert.equal(conflict.reason, 'merge conflict');
    assert.deepEqual(conflict.files, ['src/a.js']);
  });
  it('a failing diff call says "conflict list unavailable", never a bare empty conflict', () => {
    const { conflict } = run({
      merge: [{ ok: false, status: 1, stdout: '', stderr: 'boom', reason: 'git merge exited 1: boom' }],
      diff: [{ ok: false, status: null, stdout: '', stderr: '', reason: 'git diff failed to run: spawnSync git ENOENT' }],
    });
    assert.match(conflict.reason, /^conflict list unavailable: git diff failed to run/);
    assert.deepEqual(conflict.files, []);
  });
  it('a non-conflict failure keeps the exit status and a bounded stderr slice', () => {
    const { conflict } = run({ merge: [{ ok: false, status: 128, stdout: '', stderr: 'x'.repeat(5000), reason: 'git merge exited 128: x' }], diff: [OK('')] });
    assert.match(conflict.reason, /^merge failed \(not a conflict\)/);
    assert.equal(conflict.status, 128);
    assert.ok(conflict.stderr.length > 0 && conflict.stderr.length <= 600);
  });
});

describe('applySources — the one bounded retry', () => {
  it('a spawn failure once, then success: the train lands (no conflict)', () => {
    const { conflict, sleeps } = run({ merge: [ENOENT, OK()] });
    assert.equal(conflict, null);
    assert.equal(sleeps.length, 1);
  });
  it('a lock error retries only when HEAD is unchanged; a moved HEAD is not retried', () => {
    const lock = { ok: false, status: 128, stdout: '', stderr: "fatal: Unable to create '.git/index.lock': File exists.", reason: 'git merge exited 128: fatal' };
    const ok = run({ merge: [lock, OK()], status: [OK('')] });
    assert.equal(ok.conflict, null, 'HEAD unchanged and tree clean: one retry lands');
    const moved = run({ merge: [lock, OK()], status: [OK(' M f\n')], diff: [OK('')] });
    assert.match(moved.conflict.reason, /^merge failed \(not a conflict\)/, 'a dirty tree is not retried');
  });
  it('a plain non-zero exit (no lock) is never retried', () => {
    const { conflict, sleeps } = run({ merge: [{ ok: false, status: 1, stdout: '', stderr: 'x', reason: 'git merge exited 1: x' }], diff: [OK('')] });
    assert.equal(sleeps.length, 0);
    assert.match(conflict.reason, /^merge failed \(not a conflict\)/);
  });
});

describe('applySources — append-only path unchanged', () => {
  it('pr mode: an append-only-only conflict keeps the restack remedy', () => {
    const { conflict } = run({
      merge: [{ ok: false, status: 1, stdout: '', stderr: 'c', reason: 'git merge exited 1: c' }],
      diff: [OK('docs/log.md\n')],
    }, { mergeMethod: 'pr', appendOnlyGlobs: ['docs/**'] });
    assert.match(conflict.reason, /^append-only conflict — GitHub would refuse it too/);
    assert.deepEqual(conflict.files, ['docs/log.md']);
  });
});
