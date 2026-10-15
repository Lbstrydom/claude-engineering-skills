/**
 * @fileoverview `remoteReachedOf`: what `sync:pr` tells the machine lease about the remote (plan
 * docs/plans/fleet-lease-turns-and-journal.md D7, audit R1 H2). A failed `git push` does not prove nothing reached the
 * remote, so after one the remote is ASKED; a question that could not be asked is `unknown`, which is treated like `yes`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { remoteReachedOf } from '../scripts/lib/sync-pr-lease.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BRANCH = 'chore/sync-abc1234';
/** A runner answering `rev-parse` and `ls-remote` from a script; records the commands. */
const runner = ({ local = { status: 0, stdout: `${SHA}\n` }, remote = { status: 0, stdout: '' } } = {}) => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('rev-parse')) return { stderr: '', ...local };
    if (args.includes('ls-remote')) return { stderr: '', ...remote };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
};
const failed = (step, extra = {}) => ({ ok: false, step, branch: BRANCH, ...extra });

describe('remoteReachedOf', () => {
  it('a finished run, and any failure AFTER the push, reached the remote', () => {
    const { run, calls } = runner();
    assert.equal(remoteReachedOf({ ok: true }, { run, repoRoot: '/r' }), 'yes');
    assert.equal(remoteReachedOf(failed('gh pr create'), { run, repoRoot: '/r' }), 'yes');
    assert.equal(calls.length, 0, 'nothing to ask when the push is known to have succeeded');
  });

  it('a failure before the push reached nothing, and asks nothing', () => {
    const { run, calls } = runner();
    for (const step of ['switch -c', 'add', 'commit']) assert.equal(remoteReachedOf(failed(step), { run, repoRoot: '/r' }), 'no', step);
    assert.equal(calls.length, 0);
  });

  it('a cancellation reached the remote only if the push had already succeeded', () => {
    const { run } = runner();
    assert.equal(remoteReachedOf(failed('aborted', { pushed: false }), { run, repoRoot: '/r' }), 'no');
    assert.equal(remoteReachedOf(failed('aborted', { pushed: true }), { run, repoRoot: '/r' }), 'yes');
  });

  describe('after a FAILED push the remote is asked', () => {
    it('the branch is not there: it did not land', () => {
      const { run, calls } = runner({ remote: { status: 0, stdout: '' } });
      assert.equal(remoteReachedOf(failed('push'), { run, repoRoot: '/r' }), 'no');
      assert.deepEqual(calls.at(-1).slice(-3), ['ls-remote', 'origin', `refs/heads/${BRANCH}`]);
    });
    it('the branch is there at OUR commit: it landed although the client saw a failure (the connection dropped after the remote accepted it)', () => {
      const { run } = runner({ remote: { status: 0, stdout: `${SHA}\trefs/heads/${BRANCH}\n` } });
      assert.equal(remoteReachedOf(failed('push'), { run, repoRoot: '/r' }), 'yes');
    });
    it('the branch is there at a DIFFERENT commit (an older push of the same name): ours did not land', () => {
      const { run } = runner({ remote: { status: 0, stdout: `${OTHER}\trefs/heads/${BRANCH}\n` } });
      assert.equal(remoteReachedOf(failed('push'), { run, repoRoot: '/r' }), 'no');
    });
    it('a question that could not be asked is unknown, never "no"', () => {
      assert.equal(remoteReachedOf(failed('push'), { run: runner({ remote: { status: 128, stdout: '' } }).run, repoRoot: '/r' }), 'unknown', 'ls-remote failed');
      assert.equal(remoteReachedOf(failed('push'), { run: runner({ local: { status: 128, stdout: '' } }).run, repoRoot: '/r' }), 'unknown', 'no local commit to compare');
      const withError = (cmd, args) => (args.includes('ls-remote') ? { status: 0, stdout: '', stderr: '', error: new Error('spawn failed') } : { status: 0, stdout: `${SHA}\n`, stderr: '' });
      assert.equal(remoteReachedOf(failed('push'), { run: withError, repoRoot: '/r' }), 'unknown', 'a spawn error is a failure even with status 0');
    });
  });
});
