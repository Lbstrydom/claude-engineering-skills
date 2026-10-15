/**
 * @fileoverview The lease journal, the waiter list and the announce refusal (plan docs/plans/fleet-lease-turns-and-journal.md
 * D2, D3, D3b). Hermetic: an injected clock and pid probe, no files. The 08:06Z race itself is in
 * `fleet-lease-interleaving.test.mjs`; these are the per-rule cases.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, LeaseSchema, appendJournal, decideAcquire, decideAnnounce, decideClearWindow, decideRelease, decideWait,
  emptyLease, measureSlotWaits, renderLog, renderStatus, summarise, nextLines,
} from '../scripts/lib/fleet/lease.mjs';
import { LeaseSchemaV1 } from './fixtures/fleet-lease-v1-schema.mjs';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const MIN = 60_000;
const at = (min) => new Date(NOW.getTime() + min * MIN);
const SCOPE = 'win32:box';
const alive = new Set();
const probe = { scope: SCOPE, isPidAlive: (p) => alive.has(p) };
const A = { repoKey: 'aaaaaaaaaaaa', holder: 'main' };
const B = { repoKey: 'bbbbbbbbbbbb', holder: 'coord' };
const B2 = { repoKey: 'bbbbbbbbbbbb', holder: 'worker' };
const repoOf = (id) => (id.repoKey.startsWith('a') ? 'o/a' : 'o/b');

const acq = (lease, id, extra = {}, when = NOW) => decideAcquire(lease, { identity: id, repo: repoOf(id), newToken: '1111111111111111', ...extra }, when, probe);
const ann = (lease, id, extra = {}, when = NOW) => decideAnnounce(lease, { identity: id, repo: repoOf(id), kind: 'ci', until: '+30m', newId: 'abcd', ...extra }, when, probe);
const rel = (lease, id, extra = {}, when = NOW) => decideRelease(lease, { identity: id, repo: repoOf(id), ...extra }, when, probe);
const wait = (lease, id, extra = {}, when = NOW) => decideWait(lease, { identity: id, repo: repoOf(id), ...extra }, when);
const ok = (d) => { assert.equal(d.ok, true, JSON.stringify(d)); return d.lease; };
const journalKinds = (l) => (l.journal ?? []).map((e) => e.kind);

/** A lease where A holds the slot for `min` minutes from NOW (with a pid, so an expired slot is verifiable). */
const heldByA = (min = 40, extra = {}) => ok(acq(emptyLease(), A, { forMin: min, pid: 4242, ...extra }));

describe('announce refuses a window over a slot another repo holds (D2, finding 9eaa)', () => {
  it('refuses, names the holder and its expiry, and records the refusal without touching the slot or the windows', () => {
    const lease = heldByA(40);
    const d = ann(lease, B, { from: '+1m', until: '+60m' }, at(1));
    assert.equal(d.ok, false);
    assert.equal(d.code, 'held');
    assert.match(d.reason, /held by main \(o\/a\) for gate until 08:40Z/);
    assert.match(d.reason, /--over-held/);
    assert.deepEqual(d.lease.heavy, lease.heavy);
    assert.deepEqual(d.lease.windows, lease.windows);
    assert.equal(d.lease.journal.at(-1).kind, 'refused');
    assert.deepEqual(d.lease.journal.at(-1).refusal, { op: 'announce', code: 'held' });
  });
  it('allows a window that starts at the slot expiry, the holder repo own window, and a window over a dead holder', () => {
    const lease = heldByA(40);
    assert.equal(ann(lease, B, { from: '2026-10-14T08:40:00.000Z', until: '+90m' }).ok, true, 'adjacent: [08:40, ...) does not overlap [.., 08:40)');
    assert.equal(ann(lease, A, { until: '+30m' }).ok, true, 'a repo may announce over its OWN slot');
    const expiredDead = ann(lease, B, { from: '+50m', until: '+90m' }, at(50));
    assert.equal(expiredDead.ok, true, 'expired with a dead pid: the job is gone');
  });
  it('treats an expired slot whose job may still run as still held (pid alive, or unverifiable)', () => {
    alive.add(4242);
    const lease = heldByA(10);
    const live = ann(lease, B, { from: '+20m', until: '+60m' }, at(20));
    assert.equal(live.ok, false);
    assert.match(live.reason, /may still run/);
    alive.clear();
    const noPid = ok(acq(emptyLease(), A, { forMin: 10 }));
    assert.equal(ann(noPid, B, { from: '+20m', until: '+60m' }, at(20)).code, 'held', 'no pid recorded: nothing shows the job stopped');
  });
  it('--over-held records the window with an acknowledgement naming the holder, and the journal says so', () => {
    const lease = heldByA(40);
    const d = ann(lease, B, { from: '+1m', until: '+60m', overHeld: true }, at(1));
    assert.equal(d.ok, true);
    assert.equal(d.window.overHeld.holder, 'main');
    assert.equal(d.window.overHeld.repoKey, A.repoKey);
    assert.equal(d.window.overHeld.until, '2026-10-14T08:40:00.000Z');
    const e = d.lease.journal.at(-1);
    assert.equal(e.kind, 'announced');
    assert.equal(e.overHeld.repo, 'o/a');
  });
});

describe('the journal records every transition, with kind as the transition only (D3, audit R1 H3)', () => {
  it('acquire, renew, rotate, release, announce and clears each append their entry; job.kind and window.kind survive beside kind', () => {
    let l = ok(acq(emptyLease(), A, { kind: 'test', forMin: 30, pid: 1 }));
    const first = l.journal.at(-1);
    assert.equal(first.kind, 'acquired');
    assert.equal(first.mode, 'granted');
    assert.equal(first.job.kind, 'test', 'the heavy-job kind is nested, not overwriting the transition');
    l = ok(acq(l, A, { token: '1111111111111111', forMin: 30 }, at(5)));
    assert.equal(l.journal.at(-1).mode, 'renewed');
    l = ok(acq(l, A, { forMin: 30 }, at(6)));
    assert.equal(l.journal.at(-1).mode, 'rotated');
    l = ok(rel(l, A, {}, at(7)));
    assert.equal(l.journal.at(-1).kind, 'released');
    assert.equal(l.journal.at(-1).forced, false);
    l = ok(ann(l, A, { kind: 'quiet' }, at(8)));
    const a = l.journal.at(-1);
    assert.equal(a.kind, 'announced');
    assert.equal(a.window.kind, 'quiet', 'the window kind is nested, not overwriting the transition');
    assert.equal(a.window.repo, 'o/a');
  });
  it('a forced release journals as forced and still writes the events ring older checkouts read', () => {
    const lease = ok(acq(emptyLease(), A, { forMin: 5 }));
    const d = rel(lease, B, { force: true, reason: 'job is gone' }, at(20));
    assert.equal(d.ok, true);
    assert.equal(d.lease.events.at(-1).kind, 'forced-release');
    assert.equal(d.lease.journal.at(-1).forced, true);
  });
  it('clears: a same-repo clear is journalled (the events ring never saw it), an other-repo clear is both', () => {
    const l0 = ok(ann(emptyLease(), A));
    const id = l0.windows[0].id;
    const own = decideClearWindow(l0, { identity: A, repo: 'o/a', id }, NOW);
    assert.equal(own.ok, true);
    assert.equal(own.lease.events.length, 0, 'unchanged: the events ring still records only other-repo clears');
    assert.equal(own.lease.journal.at(-1).kind, 'window-cleared');
    assert.equal(own.lease.journal.at(-1).ownRepo, true);
    const other = decideClearWindow(l0, { identity: B, repo: 'o/b', id }, NOW);
    assert.equal(other.lease.events.at(-1).kind, 'window-cleared');
    assert.equal(other.lease.journal.at(-1).ownRepo, false);
  });
  it('is a ring: the 201st entry drops the oldest, so a write is never refused for lack of room', () => {
    let l = emptyLease();
    for (let i = 0; i < LIMITS.maxJournal + 1; i += 1) l = appendJournal(l, { at: at(i).toISOString(), kind: 'x', by: 'a@b' });
    assert.equal(l.journal.length, LIMITS.maxJournal);
    assert.equal(l.journal[0].at, at(1).toISOString());
  });
  it('a lease with a journal, waiters and an acknowledged window still parses under the FROZEN #243 schema', () => {
    let l = heldByA(40);
    l = ok(ann(l, B, { from: '+1m', until: '+60m', overHeld: true }, at(1)));
    l = acq(l, B2, { forMin: 10 }, at(2)).lease;
    assert.ok(l.waiters?.length, 'the refused acquire queued the repo');
    const old = LeaseSchemaV1.safeParse(l);
    assert.equal(old.success, true, 'an older checkout must not call the shared file corrupt');
    assert.deepEqual(old.data.journal, l.journal, 'and it must carry the journal through a rewrite, not strip it');
    assert.deepEqual(old.data.waiters, l.waiters, 'and the waiters');
    assert.deepEqual(old.data.windows[0].overHeld, l.windows[0].overHeld, 'and a window\'s acknowledgement');
    assert.equal(LeaseSchema.safeParse(l).success, true);
    const withFuture = { ...l, journal: [...l.journal, { at: at(3).toISOString(), kind: 'a-kind-from-a-newer-checkout', by: 'x@y', anything: [1] }] };
    assert.equal(LeaseSchema.safeParse(withFuture).success, true, 'a still-newer journal kind is tolerated, never "corrupt"');
  });
  it('the negative control: the frozen schema CAN fail - a new kind written into events[] is rejected by it', () => {
    const l = { ...emptyLease(), events: [{ at: NOW.toISOString(), kind: 'acquired', by: 'x@y', reason: 'z' }] };
    assert.equal(LeaseSchemaV1.safeParse(l).success, false);
  });
});

describe('wait episodes and the waiter list (D3b, audit R1 M1 and M2)', () => {
  it('a refused acquire opens ONE episode; ten more refusals bump the count and add no journal entry', () => {
    const lease = heldByA(60);
    let l = lease;
    const first = acq(l, B, { forMin: 20 }, at(1));
    assert.equal(first.ok, false);
    assert.equal(first.queued, true);
    l = first.lease;
    const since = l.waiters[0].since;
    for (let i = 0; i < 10; i += 1) l = acq(l, B2, { forMin: 20 }, at(2 + i)).lease;
    assert.equal(l.waiters.length, 1, 'one entry per REPO, however many of its sessions ask');
    assert.equal(l.waiters[0].refusals, 11);
    assert.equal(l.waiters[0].since, since, 'since is kept');
    assert.equal(l.waiters[0].forMin, 20);
    assert.deepEqual(journalKinds(l).filter((k) => k === 'waiting'), ['waiting']);
    assert.equal(l.journal.filter((e) => e.kind === 'refused').length, 0);
  });
  it('is served when the repo is granted the slot: wait-ended(served) with the episode id on the acquired entry', () => {
    let l = acq(heldByA(10), B, { forMin: 20 }, at(1)).lease;
    const ep = l.journal.find((e) => e.kind === 'waiting').episode;
    l = ok(rel(l, A, {}, at(5)));
    l = ok(acq(l, B, { forMin: 20 }, at(20))); // after A's between-jobs gap: the batch is over and B (the head) goes
    assert.equal(l.waiters.length, 0);
    const ended = l.journal.find((e) => e.kind === 'wait-ended');
    assert.equal(ended.reason, 'served');
    assert.equal(ended.episode, ep);
    assert.equal(l.journal.at(-1).kind, 'acquired');
    assert.equal(l.journal.at(-1).episode, ep);
  });
  it('is served when the repo announces a window starting now, but not one starting later', () => {
    const l0 = acq(heldByA(60), B, { forMin: 20 }, at(1)).lease;
    const later = ok(ann(l0, B, { from: '+120m', until: '+150m' }, at(2)));
    assert.equal(later.waiters.length, 1, 'a window further ahead does not serve the wait');
    const now = ok(ann(l0, B, { until: '+30m' }, at(60)));
    assert.equal(now.waiters.length, 0);
    assert.equal(now.journal.find((e) => e.kind === 'wait-ended').reason, 'served');
  });
  it('cancel ends the episode; the next refusal opens a NEW one (episodes are delimited)', () => {
    let l = acq(heldByA(90), B, { forMin: 20 }, at(1)).lease;
    const first = l.journal.find((e) => e.kind === 'waiting').episode;
    const c = wait(l, B, { cancel: true }, at(10));
    assert.equal(c.cancelled, true);
    l = c.lease;
    assert.equal(l.journal.find((e) => e.kind === 'wait-ended').reason, 'cancelled');
    l = acq(l, B, { forMin: 20 }, at(70)).lease;
    const episodes = l.journal.filter((e) => e.kind === 'waiting').map((e) => e.episode);
    assert.equal(episodes.length, 2);
    assert.notEqual(episodes[0], episodes[1]);
    assert.equal(episodes[0], first);
    assert.equal(wait(emptyLease(), B, { cancel: true }).cancelled, false, 'cancelling when not waiting is a harmless no-op');
  });
  it('a waiter older than 12 hours expires on the next decision, and that settlement is persisted even when the call is refused', () => {
    const l = acq(heldByA(60), B, { forMin: 20 }, at(1)).lease;
    const later = new Date(NOW.getTime() + 13 * 60 * MIN);
    const refused = rel(l, B, {}, later); // B does not hold the slot: not-holder
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'not-holder');
    assert.equal(refused.lease.waiters.length, 0, 'the expiry rides on the refusal');
    assert.equal(refused.lease.journal.find((e) => e.kind === 'wait-ended').reason, 'expired');
  });
  it('capacity: the 21st repo is told it was NOT queued and nothing is evicted; a repo already queued is never refused for room', () => {
    const repoN = (i) => ({ repoKey: i.toString(16).padStart(12, '0'), holder: 'main' });
    let l = heldByA(120);
    for (let i = 1; i <= LIMITS.maxWaiters; i += 1) {
      const d = decideAcquire(l, { identity: repoN(i), repo: `o/r${i}`, forMin: 10 }, at(1), probe);
      assert.equal(d.queued, true, `repo ${i}`);
      l = d.lease;
    }
    assert.equal(l.waiters.length, LIMITS.maxWaiters);
    const over = decideAcquire(l, { identity: repoN(99), repo: 'o/r99', forMin: 10 }, at(2), probe);
    assert.equal(over.ok, false);
    assert.equal(over.queued, false);
    assert.equal(over.queueFull, true);
    assert.equal(over.lease.waiters.length, LIMITS.maxWaiters);
    assert.equal(over.lease.journal.at(-1).kind, 'refused');
    const again = decideAcquire(l, { identity: repoN(3), repo: 'o/r3', forMin: 10 }, at(3), probe);
    assert.equal(again.queued, true, 'already queued: bumps the count');
    const w = wait(l, repoN(99), {}, at(2));
    assert.equal(w.ok, false);
    assert.equal(w.code, 'limit');
    // An expired entry is reclaimed before the capacity check.
    const later = new Date(NOW.getTime() + 13 * 60 * MIN);
    const fresh = decideAcquire(l, { identity: repoN(99), repo: 'o/r99', forMin: 10 }, later, probe);
    assert.equal(fresh.queued === true || fresh.ok === true, true, 'room was reclaimed from expired waiters');
  });
  it('a stale-token refusal is not a wait, and a bad request writes nothing at all', () => {
    const lease = heldByA(30);
    const stale = acq(lease, A, { token: 'ffffffffffffffff' });
    assert.equal(stale.code, 'stale-token');
    assert.equal(stale.queued, undefined);
    assert.equal(stale.lease, undefined, 'nothing to persist');
    const bad = decideAcquire(lease, { identity: B, repo: 'o/b', forMin: 9999 }, NOW, probe);
    assert.equal(bad.code, 'bad-request');
    assert.equal(bad.lease, undefined);
    assert.equal(wait(lease, B, { forMin: 0 }).code, 'bad-request');
  });
  it('wait records the repo explicitly and keeps since on repeat; from here the queue is binding (turns, plan D6)', () => {
    const l0 = ok(wait(emptyLease(), B, { forMin: 45 }));
    assert.equal(l0.waiters[0].forMin, 45);
    assert.equal(l0.waiters[0].refusals, 0);
    const l1 = ok(wait(l0, B2, {}, at(5)));
    assert.equal(l1.waiters[0].since, l0.waiters[0].since);
    const other = acq(l1, A, { forMin: 10 }, at(6));
    assert.equal(other.code, 'turn', 'B has waited longer and the slot is free: it is B\'s turn, a free slot is not a turn');
  });
});

describe('measureSlotWaits (for doctor\'s fit check)', () => {
  const J = (kind, min, extra) => ({ at: at(min).toISOString(), kind, by: 'main@o/b', repoKey: B.repoKey, ...extra });
  it('is unmeasured on an empty or absent journal - never "no waits"', () => {
    assert.equal(measureSlotWaits([], NOW).measured, false);
    assert.equal(measureSlotWaits(undefined, NOW).measured, false);
  });
  it('pairs by episode and keeps cancelled, expired, open and truncated episodes separate', () => {
    const j = [
      J('waiting', 0, { episode: 'e1' }), J('wait-ended', 20, { episode: 'e1', reason: 'served', refusals: 3 }),
      J('waiting', 30, { episode: 'e2' }), J('wait-ended', 35, { episode: 'e2', reason: 'cancelled', refusals: 1 }),
      J('wait-ended', 40, { episode: 'e0', reason: 'served', refusals: 2 }), // its waiting fell off the ring
      J('waiting', 50, { episode: 'e3' }),
    ];
    const m = measureSlotWaits(j, at(60));
    assert.equal(m.measured, true);
    assert.equal(m.coverageFrom, at(0).toISOString());
    const by = Object.fromEntries(m.waits.map((w) => [w.episode, w]));
    assert.equal(by.e1.waitedMs, 20 * MIN);
    assert.equal(by.e1.reason, 'served');
    assert.equal(by.e2.reason, 'cancelled');
    assert.equal(by.e0.truncated, true);
    assert.equal(by.e0.waitedMs, undefined, 'a truncated episode is never paired with an unrelated acquire');
    assert.equal(by.e3.open, true);
    assert.equal(by.e3.waitedMs, 10 * MIN);
  });
});

describe('what the operator sees', () => {
  it('status shows who is waiting and how big the journal is; the log lists entries oldest first in words', () => {
    let l = acq(heldByA(60), B, { forMin: 20 }, at(1)).lease;
    l = ok(ann(l, A, { kind: 'quiet' }, at(2)));
    const s = summarise({ state: 'ok', lease: l }, at(3), probe);
    const text = renderStatus(s, { dir: '/m', now: at(3), cmd: 'fleet' }).join('\n');
    assert.match(text, /waiting: o\/b since 08:01Z \(1 refusal, wants 20m\)/);
    assert.match(text, /journal: \d+ entries since 08:00Z \(`fleet lease log`\)/);
    const log = renderLog(l.journal).join('\n');
    assert.match(log, /main@o\/a {2}acquired the slot \(granted(, no-waiters)?\)/);
    assert.match(log, /started waiting \(refusal, held, wants 20m\)/);
    assert.match(log, /announced quiet window/);
    assert.match(renderLog([]).join('\n'), /journal: empty/);
    assert.match(nextLines({ state: 'ok', lease: l }, at(3), { probe }).join(' '), /o\/b waiting for the slot since 08:01Z/);
  });
});

describe('regression: found by the interleaving test (seed 11)', () => {
  it('two wait episodes opened in the same instant get different ids, so a closed episode never reads as the open one', () => {
    let l = acq(heldByA(90), B, { forMin: 20 }, at(1)).lease;
    const first = l.waiters[0].episode;
    l = ok(wait(l, B, { cancel: true }, at(1)));
    l = acq(l, B, { forMin: 20 }, at(1)).lease; // the clock has not advanced
    const second = l.waiters[0].episode;
    assert.notEqual(second, first);
    assert.equal(l.journal.filter((e) => e.episode === second && e.kind === 'wait-ended').length, 0, 'the new episode is not already ended');
  });
});

describe('audit-code round 1 fixes', () => {
  it('H1: an already-over window does not serve a wait; a running one does; the boundary instant is over', () => {
    const waiting = ok(wait(emptyLease(), B, { forMin: 20 }, at(30)));
    const over = ok(ann(waiting, B, { from: '2026-10-14T08:00:00.000Z', until: '2026-10-14T08:20:00.000Z' }, at(30)));
    assert.equal(over.waiters.length, 1, 'a window that ended before now serves nothing');
    const edge = ok(ann(waiting, B, { from: '2026-10-14T08:00:00.000Z', until: '2026-10-14T08:30:00.000Z' }, at(30)));
    assert.equal(edge.waiters.length, 1, 'until == now: the window is over');
    const running = ok(ann(waiting, B, { until: '+10m' }, at(30)));
    assert.equal(running.waiters.length, 0);
  });
  it('M3: refusals coalesce per repo identity - the same display name in two repos stays two entries', () => {
    const X = { repoKey: 'aaaaaaaaaaaa', holder: 'main' };
    const Y = { repoKey: 'bbbbbbbbbbbb', holder: 'main' };
    const lease = heldByA(60);
    const refuse = (l, id) => decideAnnounce(l, { identity: id, repo: 'o/same', kind: 'ci', until: '+30m' }, NOW, probe);
    const lx = refuse({ ...lease, heavy: { ...lease.heavy, repoKey: 'cccccccccccc' } }, X);
    const ly = refuse(lx.lease, Y);
    assert.equal(ly.lease.journal.filter((e) => e.kind === 'refused').length, 2, 'same by-string, different repoKey: not coalesced');
    const lx2 = refuse(lx.lease, X);
    assert.equal(lx2.lease.journal.filter((e) => e.kind === 'refused').length, 1);
    assert.equal(lx2.lease.journal.at(-1).n, 2, 'the same identity IS coalesced');
  });
  it('M4: a known journal kind missing its payload makes the file invalid (a controlled error), an unknown kind does not', () => {
    const e = (extra) => ({ ...emptyLease(), journal: [{ at: NOW.toISOString(), by: 'x@y', ...extra }] });
    for (const bad of [
      { kind: 'acquired', mode: 'granted' }, { kind: 'released', forced: false }, { kind: 'announced' }, { kind: 'window-cleared', ownRepo: true },
      { kind: 'refused', refusal: {} }, { kind: 'waiting', opener: 'wait' }, { kind: 'wait-ended', episode: 'e', reason: 'served' },
    ]) assert.equal(LeaseSchema.safeParse(e(bad)).success, false, `${bad.kind} without its payload`);
    assert.equal(LeaseSchema.safeParse(e({ kind: 'from-the-future' })).success, true);
    for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      assert.equal(LeaseSchema.safeParse(e({ kind: k })).success, true, `"${k}" is an unknown kind, never a prototype lookup`);
    }
    // and a well-formed entry of every known kind written by the code itself is accepted
    let l = ok(acq(emptyLease(), A, { forMin: 10, pid: 1 }));
    l = ok(ann(l, A, { kind: 'quiet' }));
    l = acq(l, B, { forMin: 5 }).lease;
    l = ok(wait(l, B, { cancel: true }));
    l = ok(rel(l, A));
    assert.equal(LeaseSchema.safeParse(l).success, true);
  });
});
