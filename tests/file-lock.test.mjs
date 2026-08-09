import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { withFileLockSync, _internals } from '../scripts/lib/file-lock.mjs';

// `withFileLock` (async) had no dedicated suite before this file — only
// incidental coverage in tests/maintenance-checks.test.mjs. Phase 3 of
// docs/plans/learning-persona-quickfix-honest-failure.md adds the SYNC
// variant, whose whole reason to exist is that `appendQuarantine` must stay
// synchronous (making loadSession async ripples through 4 call sites for a
// diagnostic file). A sync lock cannot sleep-loop, so its contention contract
// is "bounded attempts, then decline" rather than "wait" — and that
// difference is exactly what these tests pin.

const MODULE_PATH = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'file-lock.mjs',
);

let tmpDir;
let lockPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-'));
  lockPath = path.join(tmpDir, 'resource.lock');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch { /* best effort */ }
});

describe('file-lock / withFileLockSync — acquire, run, release', () => {
  it('runs the callback and returns its value', () => {
    const result = withFileLockSync(lockPath, {}, () => 'payload');
    assert.equal(result.ok, true);
    assert.equal(result.value, 'payload');
  });

  it('releases the lock even when the callback throws, and propagates the throw', () => {
    assert.throws(
      () => withFileLockSync(lockPath, {}, () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.equal(
      fs.existsSync(lockPath), false,
      'the lock file must be released in a finally, or one throwing caller wedges the resource',
    );
  });

  it('holds the lock for the duration of the critical section', () => {
    let observedDuringSection = null;
    withFileLockSync(lockPath, {}, () => {
      observedDuringSection = fs.existsSync(lockPath);
    });
    assert.equal(observedDuringSection, true, 'the lock must exist while fn runs');
    assert.equal(fs.existsSync(lockPath), false, 'and must be gone after');
  });

  it('is re-acquirable after a clean release', () => {
    assert.equal(withFileLockSync(lockPath, {}, () => 1).ok, true);
    assert.equal(withFileLockSync(lockPath, {}, () => 2).ok, true);
  });
});

describe('file-lock / withFileLockSync — contention declines, never blocks or throws', () => {
  it('returns {ok:false, reason:"lock-contention"} when the lock is held', () => {
    // Simulate a live holder: a lock file owned by a PID that IS alive (our
    // own), so the stale-recovery path cannot fire and this is genuine
    // contention rather than an abandoned lock.
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, token: 'someone-elses-token', acquiredAt: new Date().toISOString(),
    }));

    let ran = false;
    const result = withFileLockSync(lockPath, {}, () => { ran = true; });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lock-contention');
    assert.equal(ran, false, 'the critical section must NOT run without the lock');
  });

  it('does not throw on contention — the caller contract is never-throw', () => {
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, token: 't', acquiredAt: new Date().toISOString(),
    }));
    assert.doesNotThrow(() => withFileLockSync(lockPath, {}, () => {}));
  });

  it('leaves a contended lock file byte-intact', () => {
    const payload = JSON.stringify({
      pid: process.pid, token: 'held', acquiredAt: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(lockPath, payload);
    withFileLockSync(lockPath, {}, () => {});
    assert.equal(
      fs.readFileSync(lockPath, 'utf-8'), payload,
      'declining must not disturb the holder\'s lock file',
    );
  });

  it('bounds its attempts — it does not spin (no sleep loop on a sync path)', () => {
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, token: 't', acquiredAt: new Date().toISOString(),
    }));
    const startedAt = Date.now();
    withFileLockSync(lockPath, { attempts: 3 }, () => {});
    assert.ok(
      Date.now() - startedAt < 1000,
      'a sync lock must decline promptly rather than busy-wait',
    );
  });
});

describe('file-lock / withFileLockSync — stale lock recovery', () => {
  it('recovers a lock owned by a dead PID that is older than the stale threshold', () => {
    // PID 0x7FFFFFFE is not a live process on any platform we run on.
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 2147483646, token: 'abandoned', acquiredAt: '2020-01-01T00:00:00.000Z',
    }));
    // Backdate well past STALE_LOCK_MS so the age gate opens.
    const old = Date.now() - (10 * 60_000);
    fs.utimesSync(lockPath, new Date(old), new Date(old));

    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    let result;
    try {
      result = withFileLockSync(lockPath, {}, () => 'recovered');
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(result.ok, true, 'an abandoned lock must not block the resource forever');
    assert.equal(result.value, 'recovered');
  });

  it('does NOT recover a fresh lock owned by a dead PID (age gate)', () => {
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 2147483646, token: 'young', acquiredAt: new Date().toISOString(),
    }));
    const result = withFileLockSync(lockPath, {}, () => 'should-not-run');
    assert.equal(
      result.ok, false,
      'a dead PID with a fresh mtime may be a lock whose creator was preempted mid-write',
    );
  });
});

// Gate finding G6 — the dead TOCTOU guard.
//
// forceRelease's mtime comparison read statSync twice, microseconds apart,
// with nothing in between: `verifyStat.mtimeMs !== fs.statSync(path).mtimeMs`.
// That compares a value against itself, so it was effectively always false,
// and the result was then discarded outright with `void`. It read as a TOCTOU
// protection and provided none.
//
// In scope by impact, not authorship: this plan adds a SYNCHRONOUS acquisition
// path to this module, and a sync caller meeting a stale lock lands in exactly
// this recovery code — appendQuarantine's never-throw contract rides on it.
describe('file-lock / forceRelease TOCTOU guard is live (G6)', () => {
  it('the mtime observation is captured at inspection time, not re-read at compare time', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf-8');
    assert.ok(
      !/void mtimeMovedForward/.test(src),
      'the discarded-guard pattern must be gone, not merely renamed',
    );
    assert.ok(
      !/verifyStat\.mtimeMs !== \(fs\.statSync\(lockPath\)\.mtimeMs\)/.test(src),
      'comparing statSync against a second statSync of the same file can only report "unchanged"',
    );
  });

  const OWNED = { state: 'owned', owner: { pid: 2147483646, token: 'stale' } };

  it('aborts when a different owner holds the lock at re-check time', () => {
    const d = _internals.shouldAbortForceRelease({
      fresh: OWNED, freshMtimeMs: 1000,
      verifyOwner: { pid: 4242, token: 'someone-else' }, verifyMtimeMs: 1000,
    });
    assert.equal(d.abort, true);
    assert.equal(d.why, 'owner changed');
  });

  // The case the DEAD comparison could never catch, and the reason mtime is
  // still carried alongside the owner check: the replacement is unreadable,
  // so verifyOwner is null and an owner-only guard short-circuits to
  // "unchanged" and unlinks a live lock.
  it('aborts when the file changed into something unreadable (owner check blind, mtime catches it)', () => {
    const d = _internals.shouldAbortForceRelease({
      fresh: OWNED, freshMtimeMs: 1000,
      verifyOwner: null, verifyMtimeMs: 2000,
    });
    assert.equal(d.abort, true);
    assert.equal(d.why, 'mtime changed');
  });

  it('aborts when the mtime cannot be observed on either side (fails closed)', () => {
    for (const [freshMtimeMs, verifyMtimeMs] of [[null, 1000], [1000, null], [null, null]]) {
      const d = _internals.shouldAbortForceRelease({
        fresh: OWNED, freshMtimeMs, verifyOwner: null, verifyMtimeMs,
      });
      assert.equal(d.abort, true, `unobservable mtime (${freshMtimeMs}, ${verifyMtimeMs}) must fail closed`);
      assert.equal(d.why, 'mtime unobservable');
    }
  });

  // Vacuous-pass guard: the decision function must be able to return the
  // OTHER answer, or every assertion above passes for the wrong reason.
  it('does NOT abort when owner and mtime are both unchanged (negative control)', () => {
    const d = _internals.shouldAbortForceRelease({
      fresh: OWNED, freshMtimeMs: 1000,
      verifyOwner: { pid: 2147483646, token: 'stale' }, verifyMtimeMs: 1000,
    });
    assert.equal(d.abort, false, 'an untouched stale lock must still be recoverable');
  });

  // End-to-end: the wired path still recovers a genuinely abandoned lock.
  it('force-releases an untouched stale lock end-to-end', () => {
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 2147483646, token: 'stale', acquiredAt: '2020-01-01T00:00:00.000Z',
    }));
    const old = Date.now() - (10 * 60_000);
    fs.utimesSync(lockPath, new Date(old), new Date(old));

    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    let released;
    try {
      released = _internals.forceRelease(lockPath, 'test', { pid: 2147483646, token: 'stale' });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(released, true);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

// Real cross-process mutual exclusion. A same-process test cannot interleave
// inside a synchronous critical section, so it would pass against a broken
// design and is not evidence (R1-H1).
describe('file-lock / withFileLockSync — cross-process exclusion', () => {
  it('two child processes never hold the lock at the same time', () => {
    const witness = path.join(tmpDir, 'witness.log');
    const worker = path.join(tmpDir, 'worker.mjs');
    fs.writeFileSync(worker, `
import fs from 'node:fs';
import { withFileLockSync } from ${JSON.stringify(url.pathToFileURL(MODULE_PATH).href)};
const [lockPath, witness, tag] = process.argv.slice(2);
for (let i = 0; i < 40; i++) {
  const r = withFileLockSync(lockPath, {}, () => {
    // Mark entry and exit. If exclusion holds, no other tag can appear
    // between a matching ENTER/EXIT pair.
    fs.appendFileSync(witness, 'ENTER:' + tag + '\\n');
    for (let s = 0; s < 200000; s++) { /* burn, widening the window */ }
    fs.appendFileSync(witness, 'EXIT:' + tag + '\\n');
  });
  if (!r.ok) { /* contention — retry at the caller, per the contract */ }
}
`);
    fs.writeFileSync(witness, '');

    const runs = ['a', 'b'].map(tag => spawnSync(
      process.execPath, [worker, lockPath, witness, tag],
      { encoding: 'utf-8', timeout: 60_000 },
    ));
    for (const r of runs) assert.equal(r.status, 0, r.stderr);

    const lines = fs.readFileSync(witness, 'utf-8').split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'vacuous-pass guard: the workers must have entered at least once');

    let inside = null;
    for (const line of lines) {
      const [kind, tag] = line.split(':');
      if (kind === 'ENTER') {
        assert.equal(inside, null, `overlapping critical sections: ${tag} entered while ${inside} held the lock`);
        inside = tag;
      } else {
        assert.equal(inside, tag, `mismatched exit: saw EXIT:${tag} while inside=${inside}`);
        inside = null;
      }
    }
  });
});
