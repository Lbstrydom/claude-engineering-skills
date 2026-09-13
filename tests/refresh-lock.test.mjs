/**
 * @fileoverview Tier-1 tests for `scripts/symbol-index/refresh-lock.mjs` —
 * extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md
 * Phase 4).
 *
 * `classifyLockOpenError` and `classifyHolderLiveness` are the pure surfaces.
 * The retry SEQUENCE (`findHolder`/`abort`/re-`open`, in that order, with
 * which reason) is covered through `acquireRefreshLock`'s injectable `store`
 * seam -- added 2026-09-13 with the heartbeat-staleness reclaim, the same
 * shape as `runWithHeartbeat`'s `beatFn`. Before that seam existed the
 * sequence was covered only operationally (a real `--force` run), because
 * plain named ESM exports offer no call-observation point in this codebase.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyLockOpenError, resolveWalkStartCommit } from '../scripts/symbol-index/refresh-lock.mjs';
import { gitInit, commit } from './helpers/fixtures.mjs';
import {
  acquireRefreshLock,
  classifyHolderLiveness,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_AFTER_MS,
} from '../scripts/symbol-index/refresh-lock.mjs';
import { RefreshInFlightError, LockAbortError } from '../scripts/symbol-index/refresh-errors.mjs';

describe('classifyLockOpenError', () => {
  it('REFRESH_IN_FLIGHT + force:false → exit-in-flight', () => {
    assert.deepEqual(classifyLockOpenError({ code: 'REFRESH_IN_FLIGHT' }, { force: false }), { action: 'exit-in-flight' });
  });

  it('REFRESH_IN_FLIGHT + force:true → retry-with-abort', () => {
    assert.deepEqual(classifyLockOpenError({ code: 'REFRESH_IN_FLIGHT' }, { force: true }), { action: 'retry-with-abort' });
  });

  it('any other error code → rethrow, regardless of force', () => {
    assert.deepEqual(classifyLockOpenError({ code: 'SOMETHING_ELSE' }, { force: false }), { action: 'rethrow' });
    assert.deepEqual(classifyLockOpenError({ code: 'SOMETHING_ELSE' }, { force: true }), { action: 'rethrow' });
  });

  it('an error with no code at all → rethrow', () => {
    assert.deepEqual(classifyLockOpenError(new Error('boom'), { force: true }), { action: 'rethrow' });
  });
});

describe('resolveWalkStartCommit', () => {
  it('returns the current HEAD sha for a real repo with at least one commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lock-walkstart-'));
    try {
      gitInit(dir);
      const sha = commit(dir, 'a.txt', 'hello\n', 'init');
      assert.equal(resolveWalkStartCommit(dir), sha);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns null (not a throw) for a brand-new repo with no commits yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lock-walkstart-empty-'));
    try {
      gitInit(dir);
      assert.equal(resolveWalkStartCommit(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns null (not a throw) for a directory that is not a git repo at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lock-walkstart-norepo-'));
    try {
      assert.equal(resolveWalkStartCommit(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ── Heartbeat-staleness reclaim (upstream report c048c9dc, 2026-09-13) ──────
//
// The per-repo lock is the partial-unique index on (repo_id, status='running'),
// and only the worker's own publish/abort ever moves a row off `running`. A
// worker killed before either left the lock held forever, and every later
// refresh exited 2 with "already in flight" until a human passed --force --
// which also kills a LIVE worker. The heartbeat now decides which case it is.


const NOW = new Date('2026-09-13T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

describe('classifyHolderLiveness', () => {
  it('a heartbeat inside the budget is live; one past it is stale', () => {
    const live = classifyHolderLiveness({ last_heartbeat_at: ago(HEARTBEAT_INTERVAL_MS * 2) }, { now: NOW });
    assert.equal(live.verdict, 'live');
    assert.equal(live.signal, 'heartbeat');
    const stale = classifyHolderLiveness({ last_heartbeat_at: ago(HEARTBEAT_STALE_AFTER_MS + 1) }, { now: NOW });
    assert.equal(stale.verdict, 'stale');
  });

  it('the boundary is exclusive: exactly at the budget is still live', () => {
    const v = classifyHolderLiveness({ last_heartbeat_at: ago(HEARTBEAT_STALE_AFTER_MS) }, { now: NOW });
    assert.equal(v.verdict, 'live');
  });

  it('the budget is many heartbeat intervals -- a live worker cannot trip it by one slow tick', () => {
    // runWithHeartbeat self-aborts after 3 consecutive failed ticks (~45s),
    // so anything a live worker produces is far inside the budget.
    assert.ok(HEARTBEAT_STALE_AFTER_MS >= 10 * HEARTBEAT_INTERVAL_MS);
  });

  it('falls back to started_at when there is no heartbeat, and says so', () => {
    const v = classifyHolderLiveness({ last_heartbeat_at: null, started_at: ago(HEARTBEAT_STALE_AFTER_MS * 3) }, { now: NOW });
    assert.equal(v.verdict, 'stale');
    assert.equal(v.signal, 'started_at');
  });

  it('a row with no timestamps at all cannot be shown alive -- the tie goes to reclaiming', () => {
    const v = classifyHolderLiveness({ id: 'x' }, { now: NOW });
    assert.equal(v.verdict, 'stale');
    assert.equal(v.signal, 'none');
    assert.equal(v.ageMs, null);
  });

  it('a garbage timestamp is treated as absent, never as "fresh"', () => {
    const v = classifyHolderLiveness({ last_heartbeat_at: 'not-a-date', started_at: 'also-not' }, { now: NOW });
    assert.equal(v.verdict, 'stale');
  });

  it('no holder at all is absent (the lock cleared between insert and lookup)', () => {
    assert.equal(classifyHolderLiveness(null, { now: NOW }).verdict, 'absent');
  });
});

/** A fake store whose first open() conflicts and whose second succeeds. */
function fakeStore({ holder, secondOpenConflicts = false, abortResult = { aborted: true } }) {
  const calls = [];
  let opens = 0;
  const conflict = () => { const e = new Error('A refresh is already in flight for this repo. Pass --force to abort.'); e.code = 'REFRESH_IN_FLIGHT'; return e; };
  return {
    calls,
    store: {
      async open(args) {
        opens += 1;
        calls.push(['open', args]);
        if (opens === 1 || secondOpenConflicts) throw conflict();
        return { refreshId: 'new-run' };
      },
      async findHolder(repoId) { calls.push(['findHolder', repoId]); return holder; },
      async abort(args) { calls.push(['abort', args]); return abortResult; },
    },
  };
}

const base = { repoId: 'repo-1', mode: 'incremental', walkStartCommit: 'abc', ownershipRuleEpoch: 'e1', now: () => NOW };

describe('acquireRefreshLock -- crashed holder is reclaimed without --force', () => {
  it('a stale heartbeat aborts the holder with a reason naming the age, then re-opens', async () => {
    const holder = { id: 'dead-run', last_heartbeat_at: ago(30 * 60_000), started_at: ago(31 * 60_000) };
    const { store, calls } = fakeStore({ holder });
    const log = [];
    const r = await acquireRefreshLock({ ...base, force: false, logOk: (s) => log.push(s), store });
    assert.equal(r.refreshId, 'new-run');
    assert.deepEqual(calls.map((c) => c[0]), ['open', 'findHolder', 'abort', 'open']);
    const abort = calls[2][1];
    assert.equal(abort.refreshId, 'dead-run');
    assert.equal(abort.repoId, 'repo-1');
    assert.match(abort.reason, /heartbeat stale/);
    assert.match(abort.reason, /30min ago/);
    assert.doesNotMatch(abort.reason, /--force/, 'this was a reclaim, not an operator override');
    assert.ok(log.some((l) => /reclaiming the per-repo lock/.test(l)));
    // The retry is the SAME construction as the first attempt (the epoch bug).
    assert.deepEqual(calls[3][1], calls[0][1]);
  });

  it('a LIVE holder without --force is still refused, and the message carries its heartbeat age', async () => {
    const holder = { id: 'live-run', last_heartbeat_at: ago(10_000), started_at: ago(60_000) };
    const { store, calls } = fakeStore({ holder });
    await assert.rejects(
      acquireRefreshLock({ ...base, force: false, logOk: () => {}, store }),
      (err) => err instanceof RefreshInFlightError && /live-run/.test(err.message) && /10s ago/.test(err.message) && /--force/.test(err.message),
    );
    assert.ok(!calls.some((c) => c[0] === 'abort'), 'a live worker must never be aborted without --force');
    assert.equal(calls.filter((c) => c[0] === 'open').length, 1);
  });

  it('NEGATIVE CONTROL: the same live holder WITH --force is aborted, reason names --force', async () => {
    const holder = { id: 'live-run', last_heartbeat_at: ago(10_000) };
    const { store, calls } = fakeStore({ holder });
    const log = [];
    const r = await acquireRefreshLock({ ...base, force: true, logOk: (s) => log.push(s), store });
    assert.equal(r.refreshId, 'new-run');
    assert.match(calls[2][1].reason, /--force/);
    assert.ok(log.some((l) => /--force: aborting/.test(l) && /10s ago/.test(l)), 'killing a live worker is logged as a known act');
  });

  it('holder gone between insert and lookup: retries the open once, aborts nothing', async () => {
    const { store, calls } = fakeStore({ holder: null });
    const r = await acquireRefreshLock({ ...base, force: false, logOk: () => {}, store });
    assert.equal(r.refreshId, 'new-run');
    assert.deepEqual(calls.map((c) => c[0]), ['open', 'findHolder', 'open']);
  });

  it('a second conflict on the retry is a live in-flight, not an infinite reclaim loop', async () => {
    const holder = { id: 'dead-run', last_heartbeat_at: ago(60 * 60_000) };
    const { store, calls } = fakeStore({ holder, secondOpenConflicts: true });
    await assert.rejects(
      acquireRefreshLock({ ...base, force: false, logOk: () => {}, store }),
      (err) => err instanceof RefreshInFlightError && /took the lock/.test(err.message),
    );
    assert.equal(calls.filter((c) => c[0] === 'open').length, 2, 'exactly one retry');
  });

  it('a failing holder lookup is a LockAbortError, never a silent exit-in-flight', async () => {
    const store = {
      async open() { const e = new Error('in flight'); e.code = 'REFRESH_IN_FLIGHT'; throw e; },
      async findHolder() { throw new Error('connection reset'); },
      async abort() { throw new Error('unreachable'); },
    };
    await assert.rejects(
      acquireRefreshLock({ ...base, force: false, logOk: () => {}, store }),
      (err) => err instanceof LockAbortError && /connection reset/.test(err.message),
    );
  });

  it('a non-conflict open error is rethrown untouched, with no lookup', async () => {
    const calls = [];
    const store = {
      async open() { throw new Error('schema fault'); },
      async findHolder() { calls.push('findHolder'); return null; },
      async abort() {},
    };
    await assert.rejects(acquireRefreshLock({ ...base, force: false, logOk: () => {}, store }), /schema fault/);
    assert.deepEqual(calls, []);
  });
});
