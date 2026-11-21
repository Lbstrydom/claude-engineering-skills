/**
 * @fileoverview A bounded retry for READS of a remote (fleet feedback #6: one flaky `git ls-remote` failed a whole `land`).
 *
 * The rule, and why it stops where it does: a network READ may be retried, because asking again changes nothing; a test
 * RERUN may not, because a flaky test retried until green hides a real defect. So this wraps `ls-remote` style reads only and
 * never a mutation, a push, a merge or a test tier. It retries only a read that could not be ASKED (`ok:false`); a reachable
 * remote answering "ref absent" is an answer and is returned at once. A read that TIMED OUT is not retried either: the remote
 * is hung, and tripling a 60 s wait is not a flake cure. Three attempts, 400 ms then 1200 ms apart: at most ~1.6 s of delay.
 *
 * @module scripts/lib/fleet/remote-read
 */

export const REMOTE_READ_ATTEMPTS = 3;
const BACKOFF_MS = Object.freeze([400, 1200]);

/** A synchronous sleep (the fleet CLI is synchronous end to end). */
export const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Did this failed read time out (the remote is hung, not flaky)? */
export const isTimeoutFailure = (r) => /timed out after/.test(String(r?.reason ?? ''));

/** A failure no retry can fix (credentials, a wrong remote): retrying only delays the real message. Everything else could be a flake. `runGit` and an injected `deps.git` return a structured `{ok, reason}` and never throw - the contract this reads. */
export const isPermanentFailure = (r) => /Authentication failed|could not read Username|Permission denied|Repository not found|does not appear to be a git repository|not a valid repository name/i.test(String(r?.reason ?? ''));

/**
 * @param {() => {ok: boolean, reason?: string}} read one attempt at the read
 * @param {{attempts?: number, sleep?: (ms: number) => void}} [opts]
 * @returns the last attempt's result, with `attempts` (how many were made) when more than one was
 */
export function retryRemoteRead(read, { attempts = REMOTE_READ_ATTEMPTS, sleep = sleepSync } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = read();
    if (last.ok || isTimeoutFailure(last) || isPermanentFailure(last)) return i === 0 ? last : { ...last, attempts: i + 1 };
    if (i < attempts - 1) sleep(BACKOFF_MS[i] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
  }
  return { ...last, attempts };
}

/** `git ls-remote <args>` through an injected `git` dep, retried as above. */
export const lsRemote = (git, args, cwd, opts, retry) => retryRemoteRead(() => git(['ls-remote', ...args], cwd, opts), retry);
