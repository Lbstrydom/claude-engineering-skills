/**
 * @fileoverview Granted gaps (D5) and turns when several repos wait (D6) of docs/plans/fleet-lease-turns-and-journal.md.
 * Hermetic: an injected clock and pid probe, no files. The incident they answer (2026-10-14): workers took a FREE slot
 * out of turn twice, and a repo that granted another repo a gap had to clear its whole window because its own window
 * then refused the repo it had granted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../scripts/lib/fleet/lease.mjs';

const { LIMITS, LeaseSchema, decideAcquire, decideAnnounce, decideRelease, decideWait, emptyLease, settleQueue, summarise, renderStatus, nextLines } = L;

const day = '2026-10-14';
const T = (hm) => new Date(`${day}T${hm.length === 5 ? `${hm}:00` : hm}.000Z`);
const SCOPE = 'win32:box';
const probe = { scope: SCOPE, isPidAlive: () => false };
const A = { repoKey: 'aaaaaaaaaaaa', holder: 'main' };
const B = { repoKey: 'bbbbbbbbbbbb', holder: 'main' };
const C = { repoKey: 'cccccccccccc', holder: 'main' };
const D = { repoKey: 'dddddddddddd', holder: 'main' };
const repoOf = (id) => ({ a: 'o/a', b: 'o/b', c: 'o/c', d: 'o/d' }[id.repoKey[0]]);
const q = (id, extra = {}) => ({ identity: id, repo: repoOf(id), ...extra });

const acq = (lease, id, extra, when) => decideAcquire(lease, q(id, { newToken: '1111111111111111', pid: 1, ...extra }), T(when), probe);
const rel = (lease, id, extra, when) => decideRelease(lease, q(id, extra), T(when), probe);
const ann = (lease, id, extra, when) => decideAnnounce(lease, q(id, { kind: 'ci', newId: 'abcd', ...extra }), T(when), probe);
const wait = (lease, id, extra, when) => decideWait(lease, q(id, extra), T(when), probe);
const grant = (lease, id, extra, when) => L.decideGrant(lease, q(id, extra), T(when), probe);
const ok = (d) => { assert.equal(d.ok, true, JSON.stringify({ code: d.code, reason: d.reason })); return d.lease; };
const lastAcquired = (l) => [...l.journal].reverse().find((e) => e.kind === 'acquired');
const kinds = (l) => l.journal.map((e) => e.kind);
const turnEnded = (l) => l.journal.filter((e) => e.kind === 'turn-ended').map((e) => e.reason);

describe('granted gaps (D5, finding b921)', () => {
  /** A announces a window 08:00-10:00; B has used the lease (so it is a known repo) and is refused a slot inside it. */
  const world = () => {
    let l = ok(ann(emptyLease(), A, { kind: 'quiet', until: '2026-10-14T10:00:00.000Z' }, '08:00'));
    const refused = acq(l, B, { forMin: 20 }, '08:01');
    assert.equal(refused.code, 'window');
    l = refused.lease;
    return { l, id: l.windows[0].id };
  };
  it('the owner grants a gap to a named repo, and the window it granted no longer refuses that repo', () => {
    const { l, id } = world();
    const g = grant(l, A, { id, from: '2026-10-14T08:00:00.000Z', until: '2026-10-14T09:00:00.000Z', to: 'o/b' }, '08:02');
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.window.gaps[0].toRepoKey, B.repoKey);
    assert.equal(g.window.gaps[0].toRepo, 'o/b');
    assert.ok(kinds(g.lease).includes('gap-granted'));
    const got = acq(g.lease, B, { forMin: 20 }, '08:03');
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(lastAcquired(got.lease).basis, 'gap');
    assert.equal(LeaseSchema.safeParse(got.lease).success, true);
  });
  it('a request that runs past the gap end is still refused, and says when the gap ends', () => {
    const { l, id } = world();
    const g = ok(grant(l, A, { id, from: '2026-10-14T08:00:00.000Z', until: '2026-10-14T08:30:00.000Z', to: 'o/b' }, '08:02'));
    const past = acq(g, B, { forMin: 60 }, '08:03');
    assert.equal(past.ok, false);
    assert.equal(past.code, 'window');
    assert.match(past.reason, /gap/i);
    assert.match(past.reason, /08:30Z/);
  });
  it('another repo is not covered by a gap named for B; an open gap (no --to) covers everyone', () => {
    const { l, id } = world();
    const named = ok(grant(l, A, { id, from: '2026-10-14T08:00:00.000Z', until: '2026-10-14T09:00:00.000Z', to: 'o/b' }, '08:02'));
    assert.equal(acq(named, C, { forMin: 20 }, '08:03').code, 'window');
    const open = ok(grant(l, A, { id, from: '2026-10-14T08:00:00.000Z', until: '2026-10-14T09:00:00.000Z' }, '08:02'));
    // The window no longer refuses C; B (who has waited since 08:01 and fits the gap) still goes first - an open gap is
    // not a turn.
    const c = acq(open, C, { forMin: 20 }, '08:03');
    assert.equal(c.code, 'turn');
    assert.match(c.reason, /o\/b/);
  });
  it('only the window owner grants; the gap must lie inside the window; at most 5; bad times are argument errors', () => {
    const { l, id } = world();
    assert.equal(grant(l, B, { id, from: '2026-10-14T08:00:00.000Z', until: '2026-10-14T09:00:00.000Z' }, '08:02').code, 'not-owner');
    assert.equal(grant(l, A, { id: 'w-nope', from: '+1m', until: '+10m' }, '08:02').code, 'no-such-window');
    assert.equal(grant(l, A, { id, from: '2026-10-14T07:00:00.000Z', until: '2026-10-14T09:00:00.000Z' }, '08:02').code, 'outside-window');
    assert.equal(grant(l, A, { id, from: '2026-10-14T09:00:00.000Z', until: '2026-10-14T11:00:00.000Z' }, '08:02').code, 'outside-window');
    assert.equal(grant(l, A, { id, from: '+30m', until: '+10m' }, '08:02').code, 'bad-request');
    let g = l;
    for (let i = 0; i < LIMITS.maxGapsPerWindow; i += 1) g = ok(grant(g, A, { id, from: `+${i + 1}m`, until: `+${i + 2}m` }, '08:02'));
    assert.equal(grant(g, A, { id, from: '+20m', until: '+21m' }, '08:02').code, 'limit');
  });
  it('--to resolves a label to a repoKey from repos the lease has seen: none and ambiguous are refused', () => {
    const { l, id } = world();
    const none = grant(l, A, { id, from: '+1m', until: '+10m', to: 'o/never-seen' }, '08:02');
    assert.equal(none.code, 'no-such-repo');
    assert.match(none.reason, /lease wait/);
    // Two clones with the same label are two repoKeys: refuse rather than guess.
    const twin = ok(wait(l, { repoKey: 'eeeeeeeeeeee', holder: 'main' }, { repo: 'o/b' }, '08:02'));
    const dup = L.decideGrant(twin, { identity: A, repo: 'o/a', id, from: T('08:03').toISOString(), until: T('08:20').toISOString(), to: 'o/b' }, T('08:02'), probe);
    assert.equal(dup.code, 'ambiguous-repo');
  });
});

describe('turns when several repos wait (D6, finding a3b9)', () => {
  it('with nobody waiting a repo is granted the slot, its turn starts, and the journal says why', () => {
    const l = ok(acq(emptyLease(), A, { forMin: 30 }, '08:00'));
    assert.equal(lastAcquired(l).basis, 'no-waiters');
    assert.equal(l.turn.repoKey, A.repoKey);
    assert.equal(l.turn.endsAt, '2026-10-14T09:00:00.000Z');
    assert.ok(kinds(l).includes('turn-started'));
  });

  it('THE INCIDENT: a FREE slot is not a turn - a repo that waited longer goes first, and the one who asked early is queued', () => {
    const l0 = ok(wait(emptyLease(), A, { forMin: 30 }, '07:00'));
    const early = acq(l0, B, { forMin: 20 }, '08:00');
    assert.equal(early.ok, false);
    assert.equal(early.code, 'turn');
    assert.match(early.reason, /o\/a/);
    assert.equal(early.queued, true);
    const got = acq(early.lease, A, { forMin: 30 }, '08:01');
    assert.equal(got.ok, true);
    assert.equal(lastAcquired(got.lease).basis, 'head');
    assert.equal(got.lease.turn.repoKey, A.repoKey);
    assert.deepEqual(got.lease.waiters.map((w) => w.repo), ['o/b'], 'A was served, B still waits');
  });

  describe('the incumbent keeps precedence over the head while its turn is active', () => {
    const betweenJobs = () => {
      let l = ok(acq(emptyLease(), A, { forMin: 30 }, '08:00'));
      l = acq(l, B, { forMin: 20 }, '08:05').lease; // refused held: B is queued
      return ok(rel(l, A, {}, '08:10'));
    };
    it('B (the head) asks first and is refused; A then continues its batch', () => {
      const l = betweenJobs();
      const b = acq(l, B, { forMin: 20 }, '08:11');
      assert.equal(b.code, 'turn');
      assert.match(b.reason, /o\/a/);
      const a = acq(b.lease, A, { forMin: 20 }, '08:12');
      assert.equal(a.ok, true);
      assert.equal(lastAcquired(a.lease).basis, 'in-turn');
      assert.equal(a.lease.turn.repoKey, A.repoKey);
      assert.equal(a.lease.turn.lastReleasedAt, undefined, 'continuing the batch clears the between-jobs mark');
    });
    it('A asks first and is granted; the order of the two requests does not change the outcome', () => {
      const a = acq(betweenJobs(), A, { forMin: 20 }, '08:11');
      assert.equal(a.ok, true);
      assert.equal(lastAcquired(a.lease).basis, 'in-turn');
      assert.equal(acq(a.lease, B, { forMin: 20 }, '08:12').code, 'held');
    });
    it('after the idle gap the batch is over and the head goes next; the old turn is journalled as idle', () => {
      const b = acq(betweenJobs(), B, { forMin: 20 }, '08:21');
      assert.equal(b.ok, true, JSON.stringify(b));
      assert.equal(lastAcquired(b.lease).basis, 'no-waiters', 'B is the only repo waiting: nobody else to go before');
      assert.deepEqual(turnEnded(b.lease), ['idle']);
      assert.equal(b.lease.turn.repoKey, B.repoKey);
    });
    it('release --end-turn hands the slot over at once', () => {
      let l = ok(acq(emptyLease(), A, { forMin: 30 }, '08:00'));
      l = acq(l, B, { forMin: 20 }, '08:05').lease;
      l = ok(rel(l, A, { endTurn: true }, '08:10'));
      assert.deepEqual(turnEnded(l), ['yield']);
      assert.equal(l.turn, undefined);
      const b = acq(l, B, { forMin: 20 }, '08:11');
      assert.equal(b.ok, true);
      assert.equal(lastAcquired(b.lease).basis, 'no-waiters');
    });
  });

  it('expiry: a turn that ended while its job still runs is persisted even when the same call is refused, and the job is not cut', () => {
    let l = ok(acq(emptyLease(), A, { forMin: 120 }, '08:00')); // turn 08:00-09:00, job to 10:00
    const b = acq(l, B, { forMin: 20 }, '09:10');
    assert.equal(b.code, 'held');
    assert.deepEqual(turnEnded(b.lease), ['expiry'], 'settlement rides on the refusal');
    assert.equal(b.lease.turn, undefined);
    assert.equal(b.lease.heavy.holder, 'main', 'the job was not cut');
    l = ok(rel(b.lease, A, {}, '09:20'));
    const got = acq(l, B, { forMin: 20 }, '09:21');
    assert.equal(got.ok, true);
    assert.equal(lastAcquired(got.lease).basis, 'no-waiters');
  });

  it('a holder renewing past its turn end keeps its job and does not start a new turn', () => {
    let l = ok(decideAnnounce(emptyLease(), q(A, { kind: 'quiet', until: '+1m' }), T('07:00'), probe));
    l = ok(L.decideTurnConfig(l, { minutes: 15 }, T('07:00')));
    l = ok(acq(l, A, { forMin: 30 }, '08:00')); // turn 08:00-08:15
    const tok = l.heavy.token;
    l = acq(l, B, { forMin: 10 }, '08:05').lease;
    const renewed = acq(l, A, { forMin: 30, token: tok }, '08:20');
    assert.equal(renewed.ok, true, JSON.stringify(renewed));
    assert.equal(renewed.renewed, true);
    assert.equal(renewed.lease.turn, undefined, 'renewal is the same job, not a new turn');
  });

  it('a named gap lets the grantee in WITHOUT touching the incumbent turn', () => {
    let l = ok(ann(emptyLease(), D, { kind: 'quiet', from: '2026-10-14T08:12:00.000Z', until: '2026-10-14T10:00:00.000Z' }, '08:00'));
    l = ok(acq(l, A, { forMin: 11 }, '08:00'));
    l = ok(rel(l, A, {}, '08:11'));
    l = ok(wait(l, B, { forMin: 20 }, '08:11'));
    l = ok(grant(l, D, { id: l.windows[0].id, from: '2026-10-14T08:12:00.000Z', until: '2026-10-14T09:00:00.000Z', to: 'o/b' }, '08:11'));
    const b = acq(l, B, { forMin: 20 }, '08:13');
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(lastAcquired(b.lease).basis, 'gap');
    assert.equal(b.lease.turn.repoKey, A.repoKey, "A's turn is not ended and B's does not start");
  });

  describe('eligibility, backfill, offers and lapse (audit R1 H2)', () => {
    /** C's window 08:30-09:30 is already on record when anyone starts waiting. */
    const withWindow = () => ok(ann(emptyLease(), C, { kind: 'quiet', from: '2026-10-14T08:30:00.000Z', until: '2026-10-14T09:30:00.000Z' }, '08:00'));
    it('backfill: a head that cannot fit before an imminent window does not block a shorter job that can, and keeps its place', () => {
      let l = ok(wait(withWindow(), A, { forMin: 60 }, '08:01'));
      l = ok(wait(l, B, { forMin: 10 }, '08:02'));
      const b = acq(l, B, { forMin: 10 }, '08:10');
      assert.equal(b.ok, true, JSON.stringify(b));
      assert.equal(lastAcquired(b.lease).basis, 'backfill');
      assert.equal(b.lease.waiters.find((w) => w.repo === 'o/a').since, T('08:01').toISOString(), 'the head keeps its place');
    });
    it('control: when the head COULD fit, the shorter job behind it is refused', () => {
      let l = ok(wait(withWindow(), A, { forMin: 15 }, '08:01'));
      l = ok(wait(l, B, { forMin: 10 }, '08:02'));
      const b = acq(l, B, { forMin: 10 }, '08:10');
      assert.equal(b.code, 'turn');
      assert.match(b.reason, /o\/a/);
    });
    it('a head continuously eligible for 15 minutes lapses to the back, with a new episode, and the next waiter goes', () => {
      let l = ok(wait(emptyLease(), A, { forMin: 20 }, '08:00'));
      assert.equal(l.waiters[0].offeredAt, T('08:00').toISOString(), 'eligible at once: offered');
      l = ok(wait(l, B, { forMin: 20 }, '08:00:30'.slice(0, 5)));
      const early = acq(l, B, { forMin: 20 }, '08:14');
      assert.equal(early.code, 'turn', 'not yet lapsed at 14 minutes');
      const late = acq(l, B, { forMin: 20 }, '08:17');
      assert.equal(late.ok, true, JSON.stringify(late));
      assert.equal(lastAcquired(late.lease).basis, 'head');
      const lapsed = late.lease.journal.find((e) => e.kind === 'wait-ended' && e.reason === 'lapsed');
      assert.ok(lapsed, 'journalled as lapsed');
      const a = late.lease.waiters.find((w) => w.repo === 'o/a');
      assert.equal(a.since, T('08:17').toISOString(), "its waiting clock restarts");
      assert.notEqual(a.episode, lapsed.episode, 'and it is a NEW episode');
    });
    it('an offer is cleared when a window appears over the head, so it cannot lapse for a time it could not have gone', () => {
      let l = ok(L.decideTurnConfig(emptyLease(), { minutes: 15 }, T('07:59')));
      l = ok(wait(l, A, { forMin: 30 }, '08:00'));
      assert.ok(l.waiters[0].offeredAt);
      l = ok(ann(l, C, { kind: 'quiet', from: '2026-10-14T08:20:00.000Z', until: '2026-10-14T09:00:00.000Z' }, '08:05'));
      assert.equal(l.waiters[0].offeredAt, undefined, 'the window made the head ineligible');
      l = ok(wait(l, D, { forMin: 10 }, '08:17'));
      assert.equal(l.journal.some((e) => e.reason === 'lapsed'), false);
    });
  });

  describe('announce under the turn rule', () => {
    it('refused when another repo waits and the announcer is neither in turn nor head; --over-turn records it with who it overrode', () => {
      const l = ok(wait(emptyLease(), A, { forMin: 30 }, '08:00'));
      const b = ann(l, B, { kind: 'ci', until: '+30m' }, '08:05');
      assert.equal(b.ok, false);
      assert.equal(b.code, 'turn');
      assert.match(b.reason, /--over-turn/);
      const forced = ann(l, B, { kind: 'ci', until: '+30m', overTurn: true }, '08:05');
      assert.equal(forced.ok, true);
      const e = forced.lease.journal.find((x) => x.kind === 'announced');
      assert.equal(e.overTurn.repo, 'o/a');
    });
    it('--over-turn records the running window but starts no turn for the overrider and does not end the incumbent\'s (Gemini G1)', () => {
      let l = ok(acq(emptyLease(), A, { forMin: 10 }, '08:00'));
      l = ok(rel(l, A, {}, '08:10')); // A's turn is active, between jobs
      l = ok(wait(l, C, { forMin: 20 }, '08:11'));
      const forced = ann(l, B, { kind: 'ci', until: '+30m', overTurn: true }, '08:12');
      assert.equal(forced.ok, true, JSON.stringify(forced));
      assert.equal(forced.lease.turn.repoKey, A.repoKey, "A's turn is untouched");
      assert.equal(turnEnded(forced.lease).length, 0);
      assert.equal(forced.lease.journal.filter((e) => e.kind === 'turn-started' && e.repoKey === B.repoKey).length, 0);
    });
    it('a window starting further ahead than the turn length is a commitment, not turn-checked; nobody waiting means no check', () => {
      const l = ok(wait(emptyLease(), A, { forMin: 30 }, '08:00'));
      assert.equal(ann(l, B, { kind: 'ci', from: '+90m', until: '+120m' }, '08:05').ok, true);
      assert.equal(ann(emptyLease(), B, { kind: 'ci', until: '+30m' }, '08:05').ok, true);
    });
  });

  it('turnMin is per machine, 15 to 240 minutes, and --clear restores the default', () => {
    assert.equal(L.decideTurnConfig(emptyLease(), { minutes: 14 }, T('08:00')).code, 'bad-request');
    assert.equal(L.decideTurnConfig(emptyLease(), { minutes: 241 }, T('08:00')).code, 'bad-request');
    const l = ok(L.decideTurnConfig(emptyLease(), { minutes: 90 }, T('08:00')));
    assert.equal(l.turnMin, 90);
    assert.equal(ok(acq(l, A, { forMin: 30 }, '08:00')).turn.endsAt, '2026-10-14T09:30:00.000Z');
    assert.equal(ok(L.decideTurnConfig(l, { clear: true }, T('08:00'))).turnMin, undefined);
  });

  it('admissionCheck is side-effect free: it answers the non-turn question, leaves its input untouched and never settles', () => {
    const lease = ok(acq(emptyLease(), A, { forMin: 30 }, '08:00'));
    const before = JSON.stringify(lease);
    const verdict = L.admissionCheck(lease, B, 20, T('08:05'), probe);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'held');
    assert.equal(JSON.stringify(lease), before);
    assert.equal(L.admissionCheck(emptyLease(), B, 20, T('08:05'), probe).ok, true);
    // A waiter far past its 12 hours is NOT expired by asking the question: only a decision settles.
    const stale = ok(wait(emptyLease(), A, {}, '08:00'));
    L.admissionCheck(stale, B, 20, new Date(T('08:00').getTime() + 13 * 3_600_000), probe);
    assert.equal(stale.waiters.length, 1);
  });

  it('status and next show the turn and the head of the queue', () => {
    let l = ok(acq(emptyLease(), A, { forMin: 30 }, '08:00'));
    l = acq(l, B, { forMin: 20 }, '08:05').lease;
    l = ok(rel(l, A, {}, '08:10'));
    const s = summarise({ state: 'ok', lease: settleQueue(l, T('08:11'), probe) }, T('08:11'), probe);
    const text = renderStatus(s, { dir: '/m', now: T('08:11'), cmd: 'fleet' }).join('\n');
    assert.match(text, /turn: o\/a until 09:00Z \(between jobs since 08:10Z\)/);
    assert.match(text, /waiting: o\/b since 08:05Z/);
    assert.match(nextLines({ state: 'ok', lease: l }, T('08:11'), { probe }).join(' '), /turn: o\/a/);
  });
});

describe('audit-code round 1 fixes (PR 2)', () => {
  const aliveProbe = { scope: SCOPE, isPidAlive: () => true };

  it('H1/M6: a label is never read from ANOTHER repo clearing a window (the journal entry key is the actor)', () => {
    let l = ok(ann(emptyLease(), A, { kind: 'quiet', until: '+30m' }, '08:00'));
    const aWindow = l.windows[0].id;
    l = ok(L.decideClearWindow(l, q(B, { id: aWindow }), T('08:01'), probe)); // B clears o/a's window: entry key = B, window.repo = o/a
    l = ok(ann(l, D, { kind: 'quiet', until: '+60m', newId: 'dddd' }, '08:02'));
    const g = grant(l, D, { id: l.windows[0].id, from: '+0m', until: '+10m', to: 'o/a' }, '08:03');
    // o/a announced its own window, so the name is known - and it must resolve to o/a's key only. Reading the cleared-by-B
    // entry as "B's key is called o/a" made it two keys, i.e. ambiguous.
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.gap.toRepoKey, A.repoKey);
    // And with no announce of its own, the owner of a cleared window is not a known repo at all.
    let only = ok(ann(emptyLease(), A, { kind: 'quiet', until: '+30m' }, '08:00'));
    only = ok(L.decideClearWindow({ ...only, journal: only.journal.filter((e) => e.kind !== 'announced') }, q(B, { id: only.windows[0].id }), T('08:01'), probe));
    only = ok(ann(only, D, { kind: 'quiet', until: '+60m', newId: 'dddd' }, '08:02'));
    assert.equal(grant(only, D, { id: only.windows[0].id, from: '+0m', until: '+10m', to: 'o/a' }, '08:03').code, 'no-such-repo');
  });

  it('H2: an older waiter blocked by a window does not hold the queue - the first one that could go is offered, and lapses if it never comes', () => {
    let l = ok(ann(emptyLease(), C, { kind: 'quiet', from: '2026-10-14T08:30:00.000Z', until: '2026-10-14T09:30:00.000Z' }, '08:00'));
    l = ok(wait(l, A, { forMin: 60 }, '08:01')); // oldest, but its 60 minutes cannot fit before 08:30
    l = ok(wait(l, B, { forMin: 10 }, '08:02')); // could go now, and is a ghost
    const early = acq(l, D, { forMin: 10 }, '08:03');
    assert.equal(early.code, 'turn');
    assert.match(early.reason, /o\/b/, 'D is told B goes first, not the blocked A');
    assert.ok(early.lease.waiters.find((w) => w.repo === 'o/b').offeredAt, 'B is the one offered');
    assert.equal(early.lease.waiters.find((w) => w.repo === 'o/a').offeredAt, undefined);
    const late = acq(early.lease, D, { forMin: 10 }, '08:20');
    assert.equal(late.ok, true, JSON.stringify(late));
    assert.ok(late.lease.journal.some((e) => e.kind === 'wait-ended' && e.reason === 'lapsed'), 'the ghost lapsed instead of blocking D for 12 hours');
  });

  it('H3: while a repo\'s OWN window runs it is busy and keeps its turn; the between-jobs clock restarts when the window ends', () => {
    let l = ok(L.decideTurnConfig(emptyLease(), { minutes: 120 }, T('07:59')));
    l = ok(acq(l, A, { forMin: 10 }, '08:00'));
    l = ok(ann(l, A, { kind: 'ci', until: '2026-10-14T08:50:00.000Z' }, '08:01'));
    l = ok(wait(l, B, { forMin: 20 }, '08:02'));
    l = ok(rel(l, A, {}, '08:10'));
    assert.ok(settleQueue(l, T('08:30'), probe).turn, 'released at 08:10 but its CI window runs to 08:50: still its time');
    assert.ok(settleQueue(l, T('08:55'), probe).turn, 'inside the 10-minute gap after the window ended');
    const ended = settleQueue(l, T('09:02'), probe);
    assert.equal(ended.turn, undefined);
    assert.deepEqual(turnEnded(ended), ['idle']);
  });

  it('M2/M9: an EXPIRED slot is not proof the job stopped - only a dead recorded pid starts the between-jobs clock', () => {
    const l = ok(acq(emptyLease(), A, { forMin: 10 }, '08:00')); // lease expires 08:10, pid 1 recorded, never released
    assert.ok(settleQueue(l, T('08:40'), aliveProbe).turn, 'pid alive: the job may still run, the turn is not idle-ended');
    const dead = settleQueue(l, T('08:40'), probe);
    assert.equal(dead.turn, undefined);
    assert.deepEqual(turnEnded(dead), ['idle']);
  });

  it('M3: persisted gaps keep the invariants decideGrant enforces: ordered, inside the window, recipient named completely', () => {
    const l0 = ok(ann(emptyLease(), A, { kind: 'quiet', until: '+60m' }, '08:00'));
    const w = l0.windows[0];
    const withGap = (gap) => ({ ...l0, windows: [{ ...w, gaps: [{ grantedAt: T('08:00').toISOString(), by: 'x@y', ...gap }] }] });
    const good = { from: T('08:10').toISOString(), until: T('08:20').toISOString() };
    assert.equal(LeaseSchema.safeParse(withGap(good)).success, true);
    assert.equal(LeaseSchema.safeParse(withGap({ from: good.until, until: good.from })).success, false, 'reversed');
    assert.equal(LeaseSchema.safeParse(withGap({ from: T('07:00').toISOString(), until: good.until })).success, false, 'starts before the window');
    assert.equal(LeaseSchema.safeParse(withGap({ from: good.from, until: T('10:00').toISOString() })).success, false, 'ends after the window');
    assert.equal(LeaseSchema.safeParse(withGap({ ...good, toRepoKey: 'bbbbbbbbbbbb' })).success, false, 'key without label');
    assert.equal(LeaseSchema.safeParse(withGap({ ...good, toRepo: 'o/b' })).success, false, 'label without key');
    assert.equal(LeaseSchema.safeParse(withGap({ ...good, toRepoKey: 'bbbbbbbbbbbb', toRepo: 'o/b' })).success, true);
  });

  it('M5: a grant refused AFTER a time-driven transition came due still persists that transition', () => {
    const l = ok(wait(emptyLease(), A, {}, '08:00'));
    const g = L.decideGrant(l, q(B, { id: 'w-nope', from: '+0m', until: '+10m' }), new Date('2026-10-14T21:00:00.000Z'), probe);
    assert.equal(g.code, 'no-such-window');
    assert.equal(g.lease.waiters.length, 0, 'the 12-hour expiry rides on the refusal, as in acquire, release and clear');
  });

  it('M4: the offer is judged by the SAME window policy over the whole offer interval', () => {
    /** C's window 08:20-08:30 was announced before anyone waited; A (a 5-minute job) waits at 07:55 and is offered at once. */
    const base = (gap) => {
      let l = ok(ann(emptyLease(), C, { kind: 'quiet', from: '2026-10-14T08:20:00.000Z', until: '2026-10-14T08:30:00.000Z' }, '07:50'));
      l = ok(wait(l, A, { forMin: 5 }, '07:55'));
      assert.equal(l.waiters[0].offeredAt, T('07:55').toISOString());
      if (gap) l = ok(grant(l, C, { id: l.windows[0].id, from: gap[0], until: gap[1] }, '07:56'));
      return l;
    };
    // Nobody observed the head between 08:20 and 08:30, yet a window blocked it then: not continuously able to go, so the
    // clock restarts at the next observation instead of lapsing.
    const plain = acq(base(), D, { forMin: 5 }, '08:31');
    assert.equal(plain.code, 'turn');
    assert.equal(plain.lease.journal.some((e) => e.reason === 'lapsed'), false);
    assert.equal(plain.lease.waiters.find((w) => w.repo === 'o/a').offeredAt, T('08:31').toISOString());
    // A gap covering only PART of the offer interval is still a block.
    const partial = acq(base(['2026-10-14T08:20:00.000Z', '2026-10-14T08:25:00.000Z']), D, { forMin: 5 }, '08:31');
    assert.equal(partial.lease.journal.some((e) => e.reason === 'lapsed'), false);
    // A gap covering the whole interval since the offer means it could have gone all along: it lapses.
    let whole = ok(ann(emptyLease(), C, { kind: 'quiet', from: '2026-10-14T07:50:00.000Z', until: '2026-10-14T09:00:00.000Z' }, '07:50'));
    whole = ok(wait(whole, A, { forMin: 5 }, '07:55'));
    assert.equal(whole.waiters[0].offeredAt, undefined, 'blocked by the window: not offered yet');
    whole = ok(grant(whole, C, { id: whole.windows[0].id, from: '2026-10-14T07:50:00.000Z', until: '2026-10-14T09:00:00.000Z' }, '07:56'));
    assert.equal(whole.waiters[0].offeredAt, T('07:56').toISOString());
    assert.equal(acq(whole, D, { forMin: 5 }, '08:20').lease.journal.some((e) => e.reason === 'lapsed'), true);
  });
});
