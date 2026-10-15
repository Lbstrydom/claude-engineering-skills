/**
 * @fileoverview What `sync:pr` needs beyond `runConsumerPr` to run UNDER the machine lease (plan
 * docs/plans/fleet-lease-turns-and-journal.md D7): an observed answer to "did anything reach the remote?", which decides
 * whether the slot is handed to a CI window or simply released.
 *
 * A failed `git push` does not prove nothing landed: the connection can fail after the remote accepted the update and before
 * the client heard. So after a failed push we ASK the remote (`git ls-remote`), and a question we could not ask is `unknown`,
 * which is treated like `yes` - CI may be running, so it is recorded.
 *
 * @module scripts/lib/sync-pr-lease
 */

const succeeded = (r) => Boolean(r) && r.status === 0 && !r.error;

/**
 * @param {{ok: boolean, step?: string, branch?: string, pushed?: boolean}} result - a `runConsumerPr` result
 * @param {{run: (cmd: string, args: string[], opts?: object) => {status: number, stdout: string}, repoRoot: string}} ctx
 * @returns {'yes'|'no'|'unknown'}
 */
export function remoteReachedOf(result, { run, repoRoot }) {
  if (result.ok) return 'yes';
  switch (result.step) {
    case 'switch -c': case 'add': case 'commit': return 'no';
    case 'aborted': return result.pushed ? 'yes' : 'no';
    case 'push': {
      const local = run('git', ['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${result.branch}`]);
      const remote = run('git', ['-C', repoRoot, 'ls-remote', 'origin', `refs/heads/${result.branch}`]);
      if (!succeeded(local) || !succeeded(remote)) return 'unknown';
      const line = String(remote.stdout).trim();
      if (!line) return 'no';
      return line.split(/\s+/)[0] === String(local.stdout).trim() ? 'yes' : 'no';
    }
    default: return 'yes'; // the push succeeded and a later step failed: the branch is on the remote
  }
}
