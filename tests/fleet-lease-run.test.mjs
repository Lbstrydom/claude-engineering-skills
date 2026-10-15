/**
 * @fileoverview `lease run` and what it stands on (plan docs/plans/fleet-lease-turns-and-journal.md D7): the exclusive acquire,
 * the atomic release-to-CI-window, and `runUnderLease` - acquire, bounded wait in the queue, attach, run, release on every
 * catchable exit. Hermetic: a real lease directory in a temp folder, a fake clock, fake sleep, fake pid probe and a fake
 * signal registrar - no processes. The incidents it answers: a wrapper that ignored a REFUSED acquire (2026-10-14 12:30Z) and
 * a `timeout` wrapper that SIGTERMed the push it protected (2026-10-15 00:13Z).
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from '../scripts/lib/fleet/lease.mjs';
import * as R from '../scripts/lib/fleet/lease-run.mjs';

const { LeaseSchema, decideAcquire, decideRelease, emptyLease, readLease, transactLease } = L;

const SCOPE = 'win32:box';
const probe = { scope: SCOPE, isPidAlive: () => false };
const aliveProbe = { scope: SCOPE, isPidAlive: () => true };
const A = { repoKey: 'aaaaaaaaaaaa', holder: 'sync-pr' };
const B = { repoKey: 'bbbbbbbbbbbb', holder: 'main' };
const repoOf = (id) => (id.repoKey.startsWith('a') ? 'o/a' : 'o/b');
const T = (hm) => new Date(`2026-10-15T${hm}:00.000Z`);
const q = (id, extra = {}) => ({ identity: id, repo: repoOf(id), ...extra });
const ok = (d) => { assert.equal(d.ok, true, JSON.stringify({ code: d.code, reason: d.reason })); return d.lease; };
const acq = (lease, id, extra, when) => decideAcquire(lease, q(id, { newToken: '1111111111111111', pid: 1, ...extra }), T(when), probe);

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-lease-run-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

const fileLease = () => readLease(dir).lease;
const seed = (lease) => fs.writeFileSync(path.join(dir, 'lease.json'), JSON.stringify(lease, null, 2));

/** A mutable fake clock; `sleep` advances it and runs an optional hook (another repo acting between polls). */
function world(startHm = '08:00') {
  const w = { t: T(startHm), sleeps: 0, hook: null };
  w.now = () => w.t;
  w.sleep = async (ms) => { w.sleeps += 1; w.t = new Date(w.t.getTime() + ms); if (w.hook) w.hook(w.sleeps); };
  return w;
}
/** A fake signal registrar: `fire(sig)` calls the installed handler; `installed` says whether one is live. */
function fakeSignals() {
  const s = { handler: null, installs: 0, removes: 0 };
  s.install = (h) => { s.handler = h; s.installs += 1; return () => { s.handler = null; s.removes += 1; }; };
  s.fire = (sig) => s.handler?.(sig);
  return s;
}
const base = (w, id, extra = {}) => ({ dir, identity: id, repo: repoOf(id), kind: 'gate', forMin: 30, pid: 4242, now: w.now, sleep: w.sleep, probe, signals: fakeSignals(), log: () => {}, ...extra });
const journalKinds = (l) => (l.journal ?? []).map((e) => e.kind);

describe('exclusive acquire (D7, audit R1 H3)', () => {
  it('refuses a second run under the SAME identity while the first holds a live slot, where a plain acquire renews it', () => {
    const l0 = ok(acq(emptyLease(), A, { forMin: 30 }, '08:00'));
    const second = decideAcquire(l0, q(A, { exclusive: true, forMin: 30 }), T('08:05'), probe);
    assert.equal(second.ok, false);
    assert.equal(second.code, 'held');
    assert.match(second.reason, /already holds the slot/);
    assert.equal(second.queued, undefined, 'the same repo does not queue behind itself');
    const plain = decideAcquire(l0, q(A, { forMin: 30 }), T('08:05'), probe);
    assert.equal(plain.ok, true, 'a direct acquire keeps its renewal / rotation behaviour');
    assert.equal(plain.rotated, true);
  });
  it('after the first run\'s lease expired: refused while its pid is alive or unverifiable, granted (a takeover) when the pid is dead', () => {
    const l0 = ok(acq(emptyLease(), A, { forMin: 10 }, '08:00')); // expires 08:10, pid 1
    const alive = decideAcquire(l0, q(A, { exclusive: true }), T('08:30'), aliveProbe);
    assert.equal(alive.code, 'expired-pid-alive');
    const noPid = ok(decideAcquire(emptyLease(), { ...q(A, { forMin: 10 }), newToken: '2222222222222222' }, T('08:00'), probe));
    assert.equal(decideAcquire(noPid, q(A, { exclusive: true }), T('08:30'), probe).code, 'unverifiable');
    const dead = decideAcquire(l0, q(A, { exclusive: true, forMin: 20 }), T('08:30'), probe);
    assert.equal(dead.ok, true, JSON.stringify(dead));
    assert.equal(dead.event.kind, 'taken-over');
    assert.equal(dead.renewed, false);
  });
});

describe('decideReleaseToCiWindow (D7: the slot becomes a CI window in ONE write)', () => {
  const held = () => ok(acq(emptyLease(), A, { forMin: 60 }, '08:00'));
  const handoff = (lease, extra, when = '08:30') => L.decideReleaseToCiWindow(lease, q(A, { token: lease.heavy?.token, ciWindowMin: 20, ...extra }), T(when), probe);
  it('frees the slot and records a ci window for the consumer, with the release and the announce in the journal', () => {
    const l = held();
    const d = handoff(l);
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.lease.heavy, null);
    assert.equal(d.window.kind, 'ci');
    assert.equal(d.window.repoKey, A.repoKey);
    assert.equal(d.window.from, T('08:30').toISOString());
    assert.equal(d.window.until, T('08:50').toISOString());
    assert.deepEqual(journalKinds(d.lease).filter((k) => k === 'released' || k === 'announced'), ['released', 'announced']);
    assert.equal(LeaseSchema.safeParse(d.lease).success, true);
  });
  it('refuses a stale token and a non-holder, changing nothing', () => {
    const l = held();
    assert.equal(handoff(l, { token: 'ffffffffffffffff' }).code, 'stale-token');
    const other = L.decideReleaseToCiWindow(l, q(B, { token: l.heavy.token, ciWindowMin: 20 }), T('08:30'), probe);
    assert.equal(other.ok, false);
    assert.equal(other.code, 'not-holder');
  });
  it('--end-turn yields the turn in the same transaction', () => {
    const l = held();
    assert.ok(l.turn);
    const d = handoff(l, { endTurn: true });
    assert.equal(d.lease.turn, undefined);
    assert.ok(d.lease.journal.some((e) => e.kind === 'turn-ended' && e.reason === 'yield'));
  });
  it('records the window as reality when the consumer\'s turn ended while another repo waits: overTurn names who, and no turn starts', () => {
    let l = ok(L.decideTurnConfig(emptyLease(), { minutes: 15 }));
    l = ok(acq(l, A, { forMin: 60 }, '08:00')); // turn 08:00-08:15
    l = ok(L.decideWait(l, q(B, { forMin: 20 }), T('08:05'), probe));
    const d = handoff(l, {}, '08:40');
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.overTurn.repo, 'o/b');
    assert.equal(d.lease.journal.filter((e) => e.kind === 'turn-started').length, 1, 'only the acquire started a turn');
  });
  it('the handoff window obeys the announced-window contract: an over-long note is a bad request', () => {
    const l = held();
    assert.equal(handoff(l, { note: 'x'.repeat(L.LIMITS.noteMax + 1) }).code, 'bad-request');
    assert.equal(handoff(l, { note: 'ok' }).ok, true);
  });
  it('a full window table never blocks the release: the slot is freed and the missing window is reported', () => {
    let l = held();
    for (let i = 0; i < L.LIMITS.maxWindowsPerRepo; i += 1) l = ok(L.decideAnnounce(l, q(A, { kind: 'quiet', from: `+${100 + i * 30}m`, until: `+${120 + i * 30}m`, newId: `a${String(i).padStart(3, '0')}` }), T('08:10'), probe));
    const d = handoff(l);
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.lease.heavy, null);
    assert.equal(d.window, null);
    assert.match(d.windowRefused, /already has/);
  });
});

describe('runUnderLease', () => {
  it('granted: the job runs holding the slot with the runner\'s pid, and the slot is released afterwards', async () => {
    const w = world();
    let seen;
    const res = await R.runUnderLease(base(w, A), async ({ token }) => {
      const h = fileLease().heavy;
      seen = { holder: h.holder, pid: h.pid, token: h.token === token };
      return { fine: true };
    });
    assert.equal(res.ran, true);
    assert.equal(res.outcome, 'ran');
    assert.deepEqual(res.result, { fine: true });
    assert.deepEqual(seen, { holder: 'sync-pr', pid: 4242, token: true });
    assert.equal(fileLease().heavy, null);
    assert.deepEqual(journalKinds(fileLease()).filter((k) => k === 'acquired' || k === 'released'), ['acquired', 'released']);
  });

  it('REFUSED with no wait: the job is never called, the result says it did not run, and the repo is queued', async () => {
    const w = world();
    seed(ok(acq(emptyLease(), B, { forMin: 60 }, '08:00')));
    let called = false;
    const res = await R.runUnderLease(base(w, A), async () => { called = true; });
    assert.equal(called, false, 'the incident of 2026-10-14 12:30Z: a refused acquire must never run the command');
    assert.equal(res.ran, false);
    assert.equal(res.outcome, 'not-granted');
    assert.equal(res.code, 'held');
    assert.equal(res.queued, true);
    assert.equal(fileLease().waiters[0].repo, 'o/a');
    assert.equal(fileLease().heavy.holder, 'main', 'the other repo\'s slot is untouched');
  });

  it('waits in the queue: refused, refused, then granted when the holder releases between polls; the wait is served', async () => {
    const w = world();
    seed(ok(acq(emptyLease(), B, { forMin: 60 }, '08:00')));
    w.hook = (n) => { if (n === 3) transactLease(dir, (r) => ({ value: 1, write: ok(decideRelease(r.lease, q(B, { endTurn: true }), w.t, probe)) })); };
    let ran = false;
    const res = await R.runUnderLease(base(w, A, { waitMin: 10, pollMs: 30_000, jitter: 0 }), async () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(res.outcome, 'ran');
    assert.equal(w.sleeps, 3);
    assert.ok(fileLease().journal.some((e) => e.kind === 'wait-ended' && e.reason === 'served'));
  });

  it('gives up at the wait deadline without running, and says how long it waited', async () => {
    const w = world();
    seed(ok(acq(emptyLease(), B, { forMin: 180 }, '08:00')));
    let called = false;
    const res = await R.runUnderLease(base(w, A, { waitMin: 2, pollMs: 30_000, jitter: 0 }), async () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.outcome, 'not-granted');
    assert.ok(w.sleeps >= 3 && w.sleeps <= 5, `polled ${w.sleeps} times in a 2 minute wait`);
    assert.ok(w.t.getTime() - T('08:00').getTime() <= 2 * 60_000 + 30_000, 'it did not wait past the deadline');
    assert.equal(fileLease().waiters.length, 1, 'one queue entry however many polls');
  });

  it('a lease that cannot be read: the job never runs and the result carries the reason', async () => {
    const w = world();
    fs.writeFileSync(path.join(dir, 'lease.json'), '{ not json');
    let called = false;
    const res = await R.runUnderLease(base(w, A), async () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.ran, false);
    assert.equal(res.outcome, 'lease-error');
    assert.match(res.reason, /unreadable|malformed/);
  });

  it('the job throws: the lease is still released, then the error propagates', async () => {
    const w = world();
    await assert.rejects(R.runUnderLease(base(w, A), async () => { throw new Error('boom'); }), /boom/);
    assert.equal(fileLease().heavy, null);
    assert.ok(journalKinds(fileLease()).includes('released'));
  });

  it('a job that rejects with a FALSY value still rejects (null, 0 and "" are rejections), and the slot is released first', async () => {
    for (const value of [null, 0, '', undefined, false]) {
      const w = world();
      let outcome = 'resolved';
      let caught = 'unset';
      try { await R.runUnderLease(base(w, A), async () => { throw value; }); } catch (e) { outcome = 'rejected'; caught = e; }
      assert.equal(outcome, 'rejected', `throw ${String(value)}`);
      assert.equal(caught, value, 'the original rejection value is preserved');
      assert.equal(fileLease().heavy, null);
      fs.rmSync(path.join(dir, 'lease.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('the stop-signal handlers stay installed THROUGH the release, so a signal during it cannot skip it (audit R1 M3)', async () => {
    const w = world();
    const sig = fakeSignals();
    let calls = 0; let handlerDuringRelease = null;
    const watching = (d, fn) => { calls += 1; if (calls === 2) handlerDuringRelease = sig.handler !== null; return transactLease(d, fn); };
    await R.runUnderLease(base(w, A, { signals: sig, transact: watching }), async () => {});
    assert.equal(handlerDuringRelease, true);
    assert.equal(sig.handler, null, 'and removed afterwards');
  });

  it('a full window table never blocks the release: the slot is freed, no window is made, and the log says how to record the CI by hand', async () => {
    const w = world();
    let l = ok(acq(emptyLease(), B, { forMin: 5 }, '07:00'));
    l = ok(L.decideRelease(l, q(B, { endTurn: true }), T('07:01'), probe));
    for (let i = 0; i < L.LIMITS.maxWindowsPerRepo; i += 1) l = ok(L.decideAnnounce(l, q(A, { kind: 'quiet', from: `+${200 + i * 30}m`, until: `+${220 + i * 30}m`, newId: `c${String(i).padStart(3, '0')}` }), T('07:02'), probe));
    seed(l);
    const logs = [];
    const res = await R.runUnderLease(base(w, A, { releaseToCiWindow: 20, log: (m) => logs.push(m) }), async () => ({ remoteReached: 'yes' }));
    assert.equal(res.released.ok, true);
    assert.equal(res.released.mode, 'plain', 'no window was recorded, and the result says so');
    assert.equal(fileLease().heavy, null);
    assert.ok(logs.some((m) => /no CI window was recorded/.test(m) && /lease announce --kind ci/.test(m)), logs.join('|'));
  });

  it('attach replaces the recorded pid with the job\'s, so a child that outlives a killed runner still reads as alive', async () => {
    const w = world();
    let pidDuring;
    await R.runUnderLease(base(w, A), async ({ attach }) => { assert.equal(await attach(31337), true); pidDuring = fileLease().heavy.pid; });
    assert.equal(pidDuring, 31337);
  });

  it('exclusive: while one run holds the slot a second run of the SAME holder is refused and never runs', async () => {
    const w = world();
    let second;
    await R.runUnderLease(base(w, A), async () => {
      let called = false;
      second = await R.runUnderLease(base(w, A, { pid: 5555 }), async () => { called = true; });
      assert.equal(called, false);
    });
    assert.equal(second.outcome, 'not-granted');
    assert.equal(second.code, 'held');
    assert.equal(fileLease().heavy, null, 'the first run released its own slot; the second never touched it');
  });

  it('a caught signal fires the job\'s AbortSignal, the lease is released after the job stops, and the result names the signal', async () => {
    const w = world();
    const sig = fakeSignals();
    let aborted = false;
    const res = await R.runUnderLease(base(w, A, { signals: sig }), async ({ signal }) => {
      assert.equal(sig.installs, 1);
      sig.fire('SIGTERM');
      aborted = signal.aborted;
      return { stopped: true };
    });
    assert.equal(aborted, true);
    assert.equal(res.signalled, 'SIGTERM');
    assert.equal(res.ran, true);
    assert.equal(fileLease().heavy, null);
    assert.equal(sig.removes, 1, 'the handlers are removed again - they never outlive the job');
  });

  it('a second signal during the stop asks to exit at once', async () => {
    const w = world();
    const sig = fakeSignals();
    let forced = null;
    await R.runUnderLease(base(w, A, { signals: sig, forceExit: (code) => { forced = code; } }), async () => { sig.fire('SIGINT'); sig.fire('SIGINT'); });
    assert.equal(forced, 130);
  });

  it('endTurn: the release yields the turn', async () => {
    const w = world();
    await R.runUnderLease(base(w, A, { endTurn: true }), async () => {});
    assert.ok(fileLease().journal.some((e) => e.kind === 'turn-ended' && e.reason === 'yield'));
    assert.equal(fileLease().turn, undefined);
  });

  it('endTurn while the same repo has a job waiting (D9): the turn is kept, released.turnKept is returned and the reason is logged', async () => {
    const w = world();
    const logs = [];
    const sibling = { repoKey: A.repoKey, holder: 'chip-2' };
    const res = await R.runUnderLease(base(w, A, { endTurn: true, log: (m) => logs.push(m) }), async () => {
      // while the job runs, another job of the SAME repo asks for the slot and queues the repo
      transactLease(dir, (r) => ({ value: 1, write: decideAcquire(r.lease, q(sibling, { forMin: 20 }), w.t, probe).lease }));
    });
    assert.equal(res.released.ok, true);
    assert.equal(res.released.turnKept.reason, 'same-repo-waiting');
    assert.ok(logs.some((m) => /--end-turn not applied: o\/a has a job waiting since \d\d:\d\dZ/.test(m) && /lease wait --cancel/.test(m)), logs.join('|'));
    assert.equal(fileLease().turn.repoKey, A.repoKey, 'the turn stays with the repo');
    assert.ok(!fileLease().journal.some((e) => e.kind === 'turn-ended' && e.reason === 'yield'));
  });
  it('endTurn with the release going to a CI window also keeps the turn and returns turnKept', async () => {
    const w = world();
    const sibling = { repoKey: A.repoKey, holder: 'chip-2' };
    const res = await R.runUnderLease(base(w, A, { endTurn: true, releaseToCiWindow: 20 }), async () => {
      transactLease(dir, (r) => ({ value: 1, write: decideAcquire(r.lease, q(sibling, { forMin: 20 }), w.t, probe).lease }));
      return { remoteReached: 'yes' };
    });
    assert.equal(res.released.mode, 'ci-window');
    assert.equal(res.released.turnKept.reason, 'same-repo-waiting');
    assert.equal(fileLease().turn.repoKey, A.repoKey);
  });

  describe('releaseToCiWindow (R1 H2: what reached the remote decides)', () => {
    const run = async (remoteReached, extra = {}) => {
      const w = world();
      const res = await R.runUnderLease(base(w, A, { releaseToCiWindow: 20, ...extra }), async () => ({ remoteReached }));
      return { res, l: fileLease() };
    };
    it('yes, unknown, and a missing answer hand the slot to a CI window in ONE write', async () => {
      for (const answer of ['yes', 'unknown', undefined]) {
        const { res, l } = await run(answer);
        assert.equal(res.released.mode, 'ci-window', String(answer));
        assert.equal(l.heavy, null);
        assert.equal(l.windows.length, 1);
        assert.equal(l.windows[0].kind, 'ci');
        fs.rmSync(path.join(dir, 'lease.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
    it('no: a plain release, no window', async () => {
      const { res, l } = await run('no');
      assert.equal(res.released.mode, 'plain');
      assert.equal(l.windows.length, 0);
      assert.equal(l.heavy, null);
    });
    it('a job that throws after the remote may have been reached still gets its window', async () => {
      const w = world();
      await assert.rejects(R.runUnderLease(base(w, A, { releaseToCiWindow: 20 }), async () => { const e = new Error('late'); e.remoteReached = 'yes'; throw e; }), /late/);
      assert.equal(fileLease().windows.length, 1);
    });
  });

  it('a release that fails is reported with the by-hand command and never changes the job\'s result', async () => {
    const w = world();
    const logs = [];
    let calls = 0;
    const flaky = (d, fn) => { calls += 1; return calls >= 2 ? { ok: false, reason: 'lock-contention' } : transactLease(d, fn); };
    const res = await R.runUnderLease(base(w, A, { transact: flaky, log: (m) => logs.push(m) }), async () => ({ answer: 42 }));
    assert.deepEqual(res.result, { answer: 42 });
    assert.equal(res.released.ok, false);
    assert.ok(logs.some((m) => /release/.test(m) && /fleet lease release/.test(m)), logs.join('|'));
    assert.ok(fileLease().heavy, 'the slot stays until its lease expires, as designed');
  });
});
