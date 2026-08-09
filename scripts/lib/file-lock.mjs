/**
 * @fileoverview Sentinel-file lock with bounded acquisition + stale recovery.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §11.E + §16.C.
 *
 * Domain-neutral primitive — lives at lib/ root, NOT under a feature
 * directory. It was originally written under lib/brainstorm/ for
 * session-store, but has five consumers across brainstorm, friction,
 * requirements, outcome-sync, and maintenance-checks. While it sat in
 * lib/brainstorm/, the architecture-intent domain tagger attributed it to
 * the `brainstorm` domain, so every consumer manufactured a false
 * `<domain> → brainstorm` edge — `requirements → brainstorm` claimed the
 * requirements ledger depends on brainstorming, when it only needs a lock.
 * Keep general-purpose utilities out of feature directories: the tagger
 * reads location as ownership.
 *
 * Atomic acquire via `fs.writeFileSync(path, payload, {flag:'wx'})` —
 * single syscall opens with O_EXCL AND writes the PID payload, so a peer
 * reading the lock file always sees valid JSON (no partial-write race
 * window).
 *
 * Stale-lock detection: lock file mtime > STALE_LOCK_MS old AND owning
 * PID is not alive → force-unlink with stderr warning.
 *
 * ## Known limitation — stale recovery is check-then-unlink, not atomic
 *
 * Stated here rather than left implied, because it has been re-raised by
 * three independent audit passes and each reader has had to re-derive it.
 *
 * `forceRelease` verifies the lock's owner and mtime and then calls
 * `fs.unlinkSync(path)`. Those are two operations, so a contender can replace
 * the lock in between and lose a lock it legitimately holds. **Node exposes no
 * `flock`** (verified: `fs.flockSync` and `fs.constants.LOCK_EX` are both
 * `undefined`), so there is no atomic compare-and-unlink to reach for.
 *
 * Rename-to-claim was evaluated and REJECTED as a fix: only one process can
 * win `renameSync` of a given path, but the moment it wins, the lock path is
 * free for a legitimate acquirer — and a "turns out it was live" rollback
 * would have to rename back into a possibly-occupied path, which on POSIX
 * silently overwrites. That converts a narrow race into a worse one.
 *
 * What bounds the damage:
 *  - Recovery requires BOTH a dead owning PID AND an mtime older than
 *    STALE_LOCK_MS, so a healthy holder is never a candidate.
 *  - The re-check compares owner (pid + token) AND mtime against values
 *    observed at inspection time, and fails CLOSED when either is
 *    unobservable — see `shouldAbortForceRelease`.
 *  - `safeRelease` verifies its own token before unlinking, so a process
 *    whose lock file was wrongly removed cannot go on to delete someone
 *    else's. The blast radius is a window of non-exclusion, not a cascade.
 *
 * Closing it entirely means changing the locking substrate (an advisory-lock
 * native addon, or a lock server) — a different design, not a patch to this
 * one. Do not "fix" this by narrowing the window further and calling it
 * closed; that is the move this note exists to stop.
 *
 * @module scripts/lib/file-lock
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const STALE_LOCK_MS = 60_000;          // 60s — covers any reasonable healthy critical section
const DEFAULT_MAX_WAIT_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 50;
const DEFAULT_RETRY_JITTER_MS = 30;

class LockTimeoutError extends Error {
  constructor(lockPath, heldBy) {
    super(`lock timeout for ${lockPath}; held by ${heldBy ?? 'unknown'}`);
    this.code = 'LOCK_TIMEOUT';
    this.lockPath = lockPath;
    this.heldBy = heldBy;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Returns true if a process with the given pid is alive on this host.
 * Uses signal 0 (no-op signal that throws ESRCH if the pid doesn't exist).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) {
    if (err.code === 'EPERM') return true;   // exists but we can't signal it
    return false;                             // ESRCH = no such process
  }
}

/**
 * Single-attempt atomic acquire. Returns the unique token on success,
 * null on EEXIST. Throws on any other error.
 *
 * Audit R1-H6: returned token is written into the file and must be
 * verified at release time so a lock-file recreated by another process
 * during the critical section cannot get accidentally unlinked by us.
 */
function tryAcquireLock(lockPath) {
  const token = crypto.randomBytes(8).toString('hex');
  const payload = JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() });
  try {
    fs.writeFileSync(lockPath, payload, { flag: 'wx' });
    return token;
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
}

/**
 * Returns parsed lock contents with provenance:
 *   { state: 'owned', owner: {pid, token, acquiredAt} }
 *   { state: 'unreadable', error: 'ENOENT'|'EACCES'|... }
 *   { state: 'corrupted', raw: <string> }
 *
 * Audit R1-H5: separate "transient I/O failure" from "lock genuinely
 * abandoned" — the caller decides what to do with each rather than
 * collapsing both to `null` (which previously triggered force-release).
 */
function inspectLock(lockPath) {
  let raw;
  try { raw = fs.readFileSync(lockPath, 'utf-8'); }
  catch (err) {
    if (err.code === 'ENOENT') return { state: 'unreadable', error: 'ENOENT' };
    return { state: 'unreadable', error: err.code || err.message };
  }
  try {
    const obj = JSON.parse(raw);
    if (typeof obj.pid !== 'number' || typeof obj.token !== 'string') {
      return { state: 'corrupted', raw };
    }
    return { state: 'owned', owner: obj };
  } catch {
    return { state: 'corrupted', raw };
  }
}

/**
 * Force-release a stale lock — but ONLY if the on-disk lock still matches
 * the corruption/staleness condition we observed at inspection time.
 * Audit R1-H2 (R2 round): a TOCTOU window between inspection and unlink
 * could let another process acquire the lock; without re-checking, we'd
 * delete its valid lock.
 *
 * Strategy: re-inspect just before unlink. Force-release ONLY when the
 * current state is still corrupted OR matches the (dead-pid) snapshot.
 */
/**
 * Returns true iff the file was actually unlinked (so the caller can
 * tell whether to consume its stale-recovery attempt). Audit R4-M4.
 */
function forceRelease(lockPath, reason, expectedSnapshot = null) {
  const fresh = inspectLock(lockPath);
  // Captured HERE, at inspection time, because the TOCTOU re-check below
  // needs two observations separated by the critical section. Reading it
  // twice at re-check time (which is what the previous code did) compares a
  // value against itself and can only ever report "unchanged".
  const freshMtimeMs = statMtimeMsOrNull(lockPath);
  if (fresh.state === 'unreadable' && fresh.error === 'ENOENT') {
    return true;  // already gone — recovery effectively succeeded
  }
  // Only delete if state is still bad. Audit R3-M7: verify the FULL
  // owner tuple (pid + token) — a same-pid coincidence would otherwise
  // pass the previous looser check.
  let stillStale = false;
  if (fresh.state === 'corrupted') {
    // Audit Gemini-G2-H1: a 0-byte / unparseable file might be a brand-new
    // lock whose creator has been preempted between fs.openSync and
    // payload write. Apply the stale-age check before treating it as
    // orphaned.
    try {
      const mtime = fs.statSync(lockPath).mtimeMs;
      stillStale = (Date.now() - mtime > STALE_LOCK_MS);
    } catch { stillStale = false; }
  } else if (fresh.state === 'owned' && !isPidAlive(fresh.owner.pid)) {
    if (expectedSnapshot === null) {
      stillStale = true;
    } else {
      stillStale = (
        expectedSnapshot.pid === fresh.owner.pid &&
        expectedSnapshot.token === fresh.owner.token
      );
    }
    // Re-apply stale-age check at release time (TOCTOU-safe)
    if (stillStale) {
      try {
        const mtime = fs.statSync(lockPath).mtimeMs;
        if (Date.now() - mtime <= STALE_LOCK_MS) stillStale = false;
      } catch { stillStale = false; }
    }
  }
  if (!stillStale) {
    process.stderr.write(`  [file-lock] WARN: aborting force-release of ${lockPath} — state/owner changed since inspection (${fresh.state})\n`);
    return false;  // R4-M4: caller should NOT burn its recovery attempt
  }
  // Audit Gemini-G3-H1: narrow the OS-level TOCTOU window. Between
  // inspectLock and unlinkSync another process could have unlinked +
  // re-acquired the lock under a new pid/token. We can't fully eliminate
  // this without OS-level flock (not exposed by Node), but we can
  // re-check just before the unlink that the file's mtime hasn't been
  // touched since our inspection.
  try {
    const decision = shouldAbortForceRelease({
      fresh,
      freshMtimeMs,
      verifyOwner: readLockOwnerRaw(lockPath),
      verifyMtimeMs: fs.statSync(lockPath).mtimeMs,
    });
    if (decision.abort) {
      process.stderr.write(`  [file-lock] WARN: aborting force-release of ${lockPath} — ${decision.why} between inspection and unlink (TOCTOU narrowed)\n`);
      return false;
    }
  } catch (err) {
    if (err.code === 'ENOENT') return true;  // already gone
    // Stat or read failed — be safe, abort the unlink
    process.stderr.write(`  [file-lock] WARN: aborting force-release of ${lockPath} — re-check failed: ${err.code || err.message}\n`);
    return false;
  }
  try { fs.unlinkSync(lockPath); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  process.stderr.write(`  [file-lock] force-released stale lock ${lockPath}: ${reason}\n`);
  return true;
}

/**
 * Decide whether a pending force-release must be aborted because the lock
 * file changed between inspection and unlink.
 *
 * Pure, and separated from `forceRelease` deliberately: the interleaving this
 * defends against happens INSIDE one synchronous function, so no same-process
 * test can stage it against the real filesystem. Extracting the decision is
 * what makes the guard testable at all — the alternative was a test-only hook
 * threaded through production code.
 *
 * Two independent signals, because neither alone is sufficient:
 *  - **owner changed** — a different pid/token holds it now. Catches a normal
 *    unlink+re-acquire.
 *  - **mtime changed** — catches what the owner check cannot: a replacement
 *    that is corrupted or unreadable, where `verifyOwner` is null and an
 *    owner-only check would short-circuit to "unchanged" and unlink it.
 *
 * An unobservable mtime on either side is NOT evidence of stability, so it
 * aborts. Failing closed here costs one recovery attempt; failing open
 * deletes a live lock.
 *
 * @param {{fresh: object, freshMtimeMs: number|null, verifyOwner: {pid:number,token:string}|null, verifyMtimeMs: number|null}} obs
 * @returns {{abort: boolean, why: string}}
 */
function shouldAbortForceRelease({ fresh, freshMtimeMs, verifyOwner, verifyMtimeMs }) {
  if (verifyOwner && fresh.state === 'owned'
      && (verifyOwner.pid !== fresh.owner.pid || verifyOwner.token !== fresh.owner.token)) {
    return { abort: true, why: 'owner changed' };
  }
  if (freshMtimeMs === null || verifyMtimeMs === null) {
    return { abort: true, why: 'mtime unobservable' };
  }
  if (verifyMtimeMs !== freshMtimeMs) {
    return { abort: true, why: 'mtime changed' };
  }
  return { abort: false, why: '' };
}

/** Lock-file mtime in ms, or null when it cannot be observed. */
function statMtimeMsOrNull(lockPath) {
  try { return fs.statSync(lockPath).mtimeMs; } catch { return null; }
}

/** Raw lock-file read returning {pid, token} or null. Used by the TOCTOU re-check. */
function readLockOwnerRaw(lockPath) {
  try {
    const obj = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (typeof obj?.pid === 'number' && typeof obj?.token === 'string') return obj;
  } catch { /* fall through */ }
  return null;
}

/**
 * Audit R1-H6: ownership-verifying release. Read the on-disk lock file;
 * unlink only if its token matches our acquired token. If the token
 * doesn't match, another process now holds the lock — silently skip
 * the unlink (better to leak the file than to delete someone else's lock).
 */
function safeRelease(lockPath, ourToken) {
  const inspection = inspectLock(lockPath);
  if (inspection.state === 'unreadable' && inspection.error === 'ENOENT') {
    return;  // already gone
  }
  if (inspection.state === 'owned' && inspection.owner.token === ourToken) {
    try { fs.unlinkSync(lockPath); }
    catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(`  [file-lock] WARN: release of ${lockPath} failed: ${err.message}\n`);
      }
    }
    return;
  }
  // Token mismatch OR corrupted/unreadable lock — we don't own it any more.
  // Surfacing a warning so operators can see the ownership-loss event.
  process.stderr.write(`  [file-lock] WARN: skipping release of ${lockPath} — no longer owned (state=${inspection.state})\n`);
}

/**
 * Acquire a lock, run `fn()`, release the lock. Uses bounded retry with
 * exponential backoff + jitter. On EEXIST + stale-lock criteria, force
 * release ONCE and retry from scratch.
 *
 * @param {string} lockPath - absolute or cwd-relative path to the lock file
 * @param {{maxWaitMs?: number, retryBaseMs?: number, retryJitterMs?: number}} opts
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withFileLock(lockPath, opts, fn) {
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryBaseMs = opts?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryJitterMs = opts?.retryJitterMs ?? DEFAULT_RETRY_JITTER_MS;
  const startedAt = Date.now();
  let attempt = 0;
  let staleRecoveryUsed = false;
  let ourToken = null;

  while (true) {
    ourToken = tryAcquireLock(lockPath);
    if (ourToken) break;

    // EEXIST — inspect the lock state explicitly (R1-H5)
    const inspection = inspectLock(lockPath);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(lockPath).mtimeMs; } catch { /* lock vanished — race; retry */ }

    // Stale ONLY when:
    //   - state='owned' AND mtime > STALE_LOCK_MS old AND owning PID is dead
    //   - state='corrupted' (the lock file is unparseable — treat as orphaned ONCE)
    // 'unreadable' (transient I/O) is NOT stale; we back off and retry.
    let isStale = false;
    let staleReason = '';
    if (inspection.state === 'owned'
        && Date.now() - mtimeMs > STALE_LOCK_MS
        && !isPidAlive(inspection.owner.pid)) {
      isStale = true;
      staleReason = `pid ${inspection.owner.pid} dead`;
    } else if (inspection.state === 'corrupted'
               && Date.now() - mtimeMs > STALE_LOCK_MS) {
      // Audit Gemini-G2-H1: corrupted-looking files can be brand-new
      // half-written locks; require stale-age before treating as orphaned.
      isStale = true;
      staleReason = 'malformed lock file (older than stale threshold)';
    }

    if (isStale && !staleRecoveryUsed) {
      // Pass full owner snapshot (pid + token) so forceRelease can
      // verify both before unlink (TOCTOU + same-pid coincidence guard
      // — R2-H2 + R3-M7). R4-M4: only burn the recovery attempt when
      // forceRelease ACTUALLY unlinked; if it aborted due to ownership
      // change, fall through to normal contention backoff.
      const snapshot = inspection.state === 'owned'
        ? { pid: inspection.owner.pid, token: inspection.owner.token }
        : null;
      const released = forceRelease(lockPath, staleReason, snapshot);
      if (released) {
        staleRecoveryUsed = true;
        continue;  // retry immediately, no backoff
      }
      // forceRelease declined — treat as healthy contention from here on
    }

    // Healthy contention — back off
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      throw new LockTimeoutError(lockPath, inspection.state === 'owned' ? inspection.owner.pid : null);
    }
    const backoff = Math.min(
      retryBaseMs * Math.pow(2, attempt),
      maxWaitMs - elapsed,
    ) + Math.random() * retryJitterMs;
    await sleep(Math.max(1, Math.floor(backoff)));
    attempt++;
  }

  try {
    return await fn();
  } finally {
    safeRelease(lockPath, ourToken);
  }
}

const DEFAULT_SYNC_ATTEMPTS = 3;

/**
 * Synchronous, non-blocking lock. Runs `fn` under the lock and returns
 * `{ok:true, value}`; when the lock cannot be acquired within a small bounded
 * number of attempts, returns `{ok:false, reason:'lock-contention'}` WITHOUT
 * running `fn`.
 *
 * **Why a sync variant exists at all.** Its one consumer, `appendQuarantine`
 * in the brainstorm session store, is reached from `loadSession`, which stays
 * synchronous — making it async ripples through four call sites for what is a
 * diagnostic file. See docs/plans/learning-persona-quickfix-honest-failure.md
 * §2 items 5+6.
 *
 * **Why it declines instead of waiting.** There is no way to sleep on a sync
 * path without burning CPU, and a spin loop under contention is worse than
 * declining. So the contract is bounded attempts then a typed refusal — which
 * is also the only shape compatible with a never-throw caller that must not
 * lie about having recorded anything. Retrying is the CALLER's decision,
 * made with the caller's knowledge of whether the write matters.
 *
 * Contention is not an error: it neither throws nor disturbs the holder's
 * lock file. A stale lock (dead owner, older than the stale threshold) is
 * still recovered, once, exactly as the async path does.
 *
 * @param {string} lockPath
 * @param {{attempts?: number}} [opts]
 * @param {() => any} fn - the critical section
 * @returns {{ok: true, value: any} | {ok: false, reason: 'lock-contention'}}
 */
export function withFileLockSync(lockPath, opts, fn) {
  const attempts = Math.max(1, opts?.attempts ?? DEFAULT_SYNC_ATTEMPTS);
  let ourToken = null;
  let staleRecoveryUsed = false;

  for (let i = 0; i < attempts && ourToken === null; i += 1) {
    ourToken = tryAcquireLock(lockPath);
    if (ourToken) break;

    // EEXIST. Recover only a genuinely abandoned lock, and only once — the
    // same three-way discrimination the async path makes (owned / corrupted /
    // unreadable), so the two cannot drift apart in what "stale" means.
    if (staleRecoveryUsed) continue;
    const inspection = inspectLock(lockPath);
    const mtimeMs = statMtimeMsOrNull(lockPath);
    if (mtimeMs === null) continue;           // vanished or unreadable — just retry
    const agedOut = Date.now() - mtimeMs > STALE_LOCK_MS;
    let staleReason = '';
    if (inspection.state === 'owned' && agedOut && !isPidAlive(inspection.owner.pid)) {
      staleReason = `pid ${inspection.owner.pid} dead`;
    } else if (inspection.state === 'corrupted' && agedOut) {
      staleReason = 'malformed lock file (older than stale threshold)';
    }
    if (!staleReason) continue;               // healthy contention — no recovery

    const snapshot = inspection.state === 'owned'
      ? { pid: inspection.owner.pid, token: inspection.owner.token }
      : null;
    if (forceRelease(lockPath, staleReason, snapshot)) staleRecoveryUsed = true;
  }

  if (ourToken === null) return { ok: false, reason: 'lock-contention' };

  try {
    return { ok: true, value: fn() };
  } finally {
    safeRelease(lockPath, ourToken);
  }
}

export { LockTimeoutError, isPidAlive };

// Test-only surface — mirrors the `_internals` convention in file-io.mjs and
// shared.mjs. forceRelease's TOCTOU guard has no reachable production caller
// that can stage the interleaving it defends against, so it needs direct
// coverage (gate finding G6).
export const _internals = Object.freeze({
  forceRelease,
  shouldAbortForceRelease,
  inspectLock,
  tryAcquireLock,
  safeRelease,
  STALE_LOCK_MS,
});
