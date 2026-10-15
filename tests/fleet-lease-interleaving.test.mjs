/**
 * @fileoverview Interleaving (property) test for the machine lease: random acquire / announce / release / clear
 * sequences across three repos must never leave a heavy slot overlapping another repo's window unless that overlap was
 * acknowledged (`overHeld`) or granted. Per-call unit tests cannot see the 2026-10-14 08:06Z race - it is a SEQUENCE:
 * WCA released 08:06:01, CES acquired ~08:06 (--for 40), storyline announced a window over it at 08:06:29 and got OK.
 * Plan: docs/plans/fleet-lease-turns-and-journal.md D4. A failure prints the seed and the operation prefix, so it replays.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LeaseSchema, classifyHeavy, decideAcquire, decideAnnounce, decideClearWindow, decideRelease, decideWait, emptyLease,
} from '../scripts/lib/fleet/lease.mjs';
import { LIMITS, admissionCheck, decideGrant, settleQueue, usesNamedGap } from '../scripts/lib/fleet/lease.mjs';
import { turnActive } from '../scripts/lib/fleet/lease-turns.mjs';
import { LeaseSchemaV1 } from './fixtures/fleet-lease-v1-schema.mjs';

const MIN = 60_000;
const SCOPE = 'win32:box';
/** Every pid is dead: an expired slot is always takeable, so a refusal is never a probe artefact. */
const probe = { scope: SCOPE, isPidAlive: () => false };

const REPOS = [
  { repoKey: 'aaaaaaaaaaaa', repo: 'o/a' },
  { repoKey: 'bbbbbbbbbbbb', repo: 'o/b' },
  { repoKey: 'cccccccccccc', repo: 'o/c' },
];
const HOLDERS = ['main', 'worker'];

/** mulberry32: a small seeded PRNG, so a failing sequence is reproduced by its seed alone. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];
const int = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/** One random operation (plain data, so the prefix is printable). */
/**
 * One random operation. Three mixes, because a uniform mix almost never reaches the states the invariants are about
 * (measured: 0 gap acquires and 0 lapses in 16,000 uniform steps): 'calm' leaves long idle stretches so a head can be
 * continuously eligible and lapse; 'gappy' announces windows, grants gaps starting at once and acquires small jobs.
 */
function randomOp(rnd, mix = 'uniform') {
  const repo = pick(rnd, REPOS);
  const holder = pick(rnd, HOLDERS);
  const base = { repo, holder };
  const roll = rnd();
  if (mix === 'calm') {
    if (roll < 0.30) return { ...base, op: 'wait', forMin: int(rnd, 1, 20), cancel: false };
    if (roll < 0.60) return { ...base, op: 'advance', min: int(rnd, 5, 40) };
    if (roll < 0.70) return { ...base, op: 'acquire', forMin: int(rnd, 1, 20), pid: 4242 };
    if (roll < 0.78) return { ...base, op: 'renew', forMin: int(rnd, 5, 40) };
    if (roll < 0.92) return { ...base, op: 'release', endTurn: rnd() < 0.2 };
    return { ...base, op: 'wait', forMin: int(rnd, 1, 20), cancel: true };
  }
  if (mix === 'gappy') {
    if (roll < 0.22) return { ...base, op: 'announce', kind: 'quiet', fromMin: 0, durMin: int(rnd, 30, 120), overHeld: false, overTurn: rnd() < 0.5 };
    if (roll < 0.52) return { ...base, op: 'grant', pick: rnd(), a: 0, b: int(rnd, 20, 90), to: pick(rnd, ['o/a', 'o/b', 'o/c']) };
    if (roll < 0.62) return { ...base, op: 'wait', forMin: int(rnd, 1, 20), cancel: false };
    if (roll < 0.78) return { ...base, op: 'acquire', forMin: int(rnd, 1, 10), pid: 4242 };
    if (roll < 0.86) return { ...base, op: 'renew', forMin: int(rnd, 5, 30) };
    if (roll < 0.94) return { ...base, op: 'release', endTurn: false };
    return { ...base, op: 'advance', min: int(rnd, 1, 10) };
  }
  if (roll < 0.22) return { ...base, op: 'acquire', forMin: int(rnd, 1, 60), pid: 4242 };
  if (roll < 0.30) return { ...base, op: 'renew', forMin: int(rnd, 5, 60) };
  if (roll < 0.42) return { ...base, op: 'release', endTurn: rnd() < 0.2 };
  if (roll < 0.60) {
    return { ...base, op: 'announce', kind: pick(rnd, ['quiet', 'ci']), fromMin: pick(rnd, [0, 0, int(rnd, 1, 90)]), durMin: int(rnd, 5, 120), overHeld: rnd() < 0.25, overTurn: rnd() < 0.25 };
  }
  if (roll < 0.66) return { ...base, op: 'clear', pick: rnd() };
  if (roll < 0.72) return { ...base, op: 'wait', forMin: int(rnd, 1, 60), cancel: rnd() < 0.4 };
  if (roll < 0.78) return { ...base, op: 'grant', pick: rnd(), a: int(rnd, 0, 30), b: int(rnd, 5, 90), to: pick(rnd, ['o/a', 'o/b', 'o/c', 'o/zzz', undefined, undefined]) };
  return { ...base, op: 'advance', min: int(rnd, 1, 45) };
}

/** Apply one operation to the lease; returns the next `{lease, now, result}`. A refusal that carries a lease is persisted. */
function apply(state, op) {
  const { lease, now } = state;
  const id = { repoKey: op.repo.repoKey, holder: op.holder };
  const common = { identity: id, repo: op.repo.repo };
  let d;
  switch (op.op) {
    case 'acquire': d = decideAcquire(lease, { ...common, forMin: op.forMin, pid: op.pid }, now, probe); break;
    case 'release': d = decideRelease(lease, { ...common, endTurn: op.endTurn }, now, probe); break;
    case 'renew': {
      // Only the holder can renew: it presents the CURRENT token. Anyone else has nothing to renew (a no-op, not an acquire).
      const h = lease.heavy;
      if (!h || h.repoKey !== id.repoKey || h.holder !== id.holder) return { lease, now, result: { ok: true, noop: true } };
      d = decideAcquire(lease, { ...common, forMin: op.forMin, token: h.token }, now, probe);
      break;
    }
    case 'grant': {
      const mine = lease.windows.filter((x) => x.repoKey === id.repoKey);
      const w = mine[Math.floor(op.pick * mine.length)];
      if (!w) { d = { ok: false, code: 'no-such-window', reason: 'none' }; break; }
      const from = new Date(Date.parse(w.from) + op.a * MIN);
      d = decideGrant(lease, { ...common, id: w.id, from: from.toISOString(), until: new Date(from.getTime() + op.b * MIN).toISOString(), to: op.to }, now, probe);
      break;
    }
    case 'announce': {
      const from = new Date(now.getTime() + op.fromMin * MIN);
      const until = new Date(from.getTime() + op.durMin * MIN);
      d = decideAnnounce(lease, { ...common, kind: op.kind, from: from.toISOString(), until: until.toISOString(), overHeld: op.overHeld, overTurn: op.overTurn }, now, probe);
      break;
    }
    case 'clear': {
      const w = lease.windows[Math.floor(op.pick * lease.windows.length)];
      d = w ? decideClearWindow(lease, { ...common, id: w.id }, now, probe) : { ok: false, code: 'no-such-window', reason: 'none' };
      break;
    }
    case 'wait': d = decideWait(lease, { ...common, forMin: op.forMin, cancel: op.cancel }, now, probe); break;
    case 'advance': return { lease, now: new Date(now.getTime() + op.min * MIN), result: { ok: true, noop: true } };
    default: throw new Error(`unknown op ${op.op}`);
  }
  return { lease: d.ok ? d.lease : (d.lease ?? lease), now, result: d };
}

const overlaps = (aFrom, aTo, bFrom, bTo) => Date.parse(aFrom) < Date.parse(bTo) && Date.parse(aTo) > Date.parse(bFrom);

/** The invariants that must hold after EVERY step. Returns a violation string or null. */
function violation(before, after, op) {
  const { lease, now } = after;
  const v1 = LeaseSchemaV1.safeParse(lease);
  if (!v1.success) return `I1: the lease no longer parses under the frozen v1 schema (an older checkout would call it corrupt): ${v1.error.issues[0].path.join('.')}: ${v1.error.issues[0].message}`;
  const cur = LeaseSchema.safeParse(lease);
  if (!cur.success) return `I1: the lease no longer parses under the current schema: ${cur.error.issues[0].message}`;
  const h = lease.heavy;
  if (h && classifyHeavy(h, now, probe).state === 'held') {
    for (const w of lease.windows) {
      if (w.repoKey === h.repoKey) continue;
      if (!overlaps(w.from, w.until, h.startedAt, h.expiresAt)) continue;
      const ack = w.overHeld && w.overHeld.repoKey === h.repoKey && w.overHeld.holder === h.holder;
      const gap = (w.gaps ?? []).some((g) => (!g.toRepoKey || g.toRepoKey === h.repoKey) && Date.parse(g.from) <= Date.parse(h.startedAt) && Date.parse(g.until) >= Date.parse(h.expiresAt));
      if (!ack && !gap) {
        return `I2: ${h.holder}@${h.repo} holds the slot ${h.startedAt}..${h.expiresAt} while ${w.repo}'s ${w.kind} window ${w.id} (${w.from}..${w.until}) overlaps it, unacknowledged`;
      }
    }
  }
  // I3: a refusal changes the journal and the waiter list only; a bad request changes nothing at all.
  const r = after.result;
  if (r.ok === false && !r.noop) {
    if (r.code === 'bad-request' && after.lease !== before.lease) return 'I3: a bad request wrote something';
    if (JSON.stringify(lease.heavy) !== JSON.stringify(before.lease.heavy)) return `I3: a refused ${op.op} (${r.code}) changed the slot`;
    if (JSON.stringify(lease.windows) !== JSON.stringify(before.lease.windows)) return `I3: a refused ${op.op} (${r.code}) changed the windows`;
    if (JSON.stringify(lease.peakHours) !== JSON.stringify(before.lease.peakHours)) return 'I3: a refusal changed the peak hours';
  }
  // I4: every successful mutation appends the journal entry its kind requires, so the history can always answer
  // "what happened"; and a wait episode ends at most once.
  const need = { acquire: 'acquired', announce: 'announced', clear: 'window-cleared' }[op.op] ?? (op.op === 'release' && r.ok && !r.already ? 'released' : null);
  // What THIS step added, by identity (an older entry of the same kind cannot satisfy it); housekeeping such as an offer may
  // sit beside it, so it is "among the new entries", not "the last one".
  const added = (lease.journal ?? []).filter((e) => !(before.lease.journal ?? []).includes(e));
  if (r.ok && need && !added.some((e) => e.kind === need && e.repoKey === op.repo.repoKey)) return `I4: a successful ${op.op} by ${op.repo.repo} added no ${need} entry of its own (added: ${added.map((e) => e.kind).join(',') || 'none'})`;
  const ended = new Map();
  for (const e of lease.journal ?? []) if (e.kind === 'wait-ended') ended.set(e.episode, (ended.get(e.episode) ?? 0) + 1);
  for (const [ep, n] of ended) if (n > 1) return `I4: wait episode ${ep} ended ${n} times`;
  for (const w of lease.waiters ?? []) {
    if (ended.has(w.episode)) return `I4: ${w.repo} is still waiting in an episode the journal says ended`;
  }
  return basisViolation(before, after, op) ?? endTurnViolation(before, after, op) ?? continuationViolation(before, after, op);
}

/**
 * I7 (D11) and I8 (D12). I7: a holder's renewal is granted iff a fresh grant would be on a FREE slot (the repo's turn is active, or
 * a named gap, or nobody else waits, or it is the head, or every longer-waiting repo could not go anyway), it is always same-job
 * (no turn started, no wait served), and a refusal for the turn means that condition was false. I8: a token-less acquire by the
 * identity that holds a LIVE slot never succeeds.
 */
function continuationViolation(before, after, op) {
  const r = after.result;
  const sb = settleQueue(before.lease, before.now, probe);
  const now = after.now;
  const h = sb.heavy;
  const R = op.repo.repoKey;
  const mineLive = h && h.repoKey === R && h.holder === op.holder && classifyHeavy(h, now, probe).state === 'held';
  if (op.op === 'acquire' && mineLive && r.ok) return 'I8: a token-less acquire succeeded on a live slot its own identity holds';
  if (op.op !== 'renew' || r.noop) return null;
  const proj = { ...sb, heavy: null };
  const waiters = sb.waiters ?? [];
  const others = waiters.filter((w) => w.repoKey !== R);
  const end = new Date(now.getTime() + op.forMin * MIN);
  const incumbent = sb.turn && sb.turn.repoKey !== R && turnActive(sb, sb.turn.repoKey, now) && waiters.length > 0;
  const mine = waiters.find((w) => w.repoKey === R);
  const mySince = mine ? Date.parse(mine.since) : now.getTime();
  const longer = mine ? others.filter((w) => Date.parse(w.since) < mySince || (Date.parse(w.since) === mySince && w.repoKey < R)) : others;
  const couldGo = (w) => admissionCheck(proj, { repoKey: w.repoKey, holder: '-' }, w.forMin, now, probe).ok;
  const fair = usesNamedGap(sb, R, now, end) || turnActive(sb, R, now) || (!incumbent && (!others.length || !longer.length || !longer.some(couldGo)));
  if (r.ok) {
    stats.renewGranted += 1;
    if (!fair) return 'I7: a renewal was granted although a fresh grant on a free slot would have been refused (another repo turn or an older waiter)';
    if (r.basis !== 'same-job') return 'I7: a renewal was not recorded as the same job';
    const added = (after.lease.journal ?? []).filter((e) => !(before.lease.journal ?? []).includes(e));
    if (added.some((e) => e.kind === 'turn-started')) return 'I7: a renewal started a turn (the budget must count from the first grant)';
    if (added.some((e) => e.kind === 'wait-ended' && e.reason === 'served' && e.repoKey === R)) return 'I7: a renewal served the repo own waiter';
  } else if (r.code === 'turn') {
    stats.renewRefusedTurn += 1;
    if (fair) return 'I7: a renewal was refused for the turn although a fresh grant on a free slot would have been granted';
  }
  return null;
}

/**
 * I6 (D9, plan audit R1 M1): a holder's `release --end-turn`. In scope: the SETTLED pre-state has a turn owned by the releasing repo.
 * There the turn ends (`yield`) iff the repo had no waiter entry of its own, and `turnKept` is recorded iff it was kept. Out of
 * scope (another repo's turn, e.g. a named-gap borrower, or no turn left after settlement) the release changes no turn and records
 * neither `yield` nor `turnKept`.
 */
function endTurnViolation(before, after, op) {
  const r = after.result;
  if (op.op !== 'release' || !op.endTurn || !r.ok || r.already) return null;
  const sb = settleQueue(before.lease, before.now, probe);
  const h = sb.heavy;
  if (!h || h.repoKey !== op.repo.repoKey || h.holder !== op.holder) return null; // not the holder's own release
  const R = op.repo.repoKey;
  const added = (after.lease.journal ?? []).filter((e) => !(before.lease.journal ?? []).includes(e));
  const yielded = added.some((e) => e.kind === 'turn-ended' && e.reason === 'yield');
  const keptEntry = added.find((e) => e.kind === 'released' && e.turnKept !== undefined);
  if (sb.turn && sb.turn.repoKey === R) {
    const own = (sb.waiters ?? []).find((w) => w.repoKey === R);
    if (own) {
      stats.endTurnKept += 1;
      if (yielded) return 'I6: --end-turn yielded the turn although the releasing repo had a waiter of its own';
      if (!r.turnKept || r.turnKept.since !== own.since) return 'I6: the turn was kept but the result does not say so (or names the wrong wait)';
      if (!keptEntry) return 'I6: the turn was kept but the released journal entry does not record turnKept';
      if (!after.lease.turn || after.lease.turn.repoKey !== R) return 'I6: the turn was kept but the lease no longer has it';
    } else {
      stats.endTurnYielded += 1;
      if (!yielded) return 'I6: --end-turn did not yield although the releasing repo had no waiter of its own';
      if (r.turnKept || keptEntry) return 'I6: the turn was yielded but turnKept was recorded';
    }
  } else {
    stats.endTurnOutOfScope += 1;
    if (yielded || r.turnKept || keptEntry) return 'I6: a release outside the releaser own turn yielded or kept a turn';
    if (JSON.stringify(after.lease.turn) !== JSON.stringify(sb.turn)) return 'I6: a release outside the releaser own turn changed the turn';
  }
  return null;
}

/** I5: the recorded reason for a grant is true of the lease the decision saw, and no waiter lapses unless it could have gone. */
function basisViolation(before, after, op) {
  const { now } = after;
  const r = after.result;
  const sb = settleQueue(before.lease, before.now, probe);
  for (const e of after.lease.journal ?? []) if (e.kind === 'offered' && !(before.lease.journal ?? []).includes(e)) stats.offered += 1;
  if (op.op === 'acquire' && r.ok && r.basis && r.basis !== 'same-job') {
    const R = op.repo.repoKey;
    const waiters = sb.waiters ?? [];
    const others = waiters.filter((w) => w.repoKey !== R);
    const incumbent = sb.turn && sb.turn.repoKey !== R && turnActive(sb, sb.turn.repoKey, now) && waiters.length > 0;
    const mine = waiters.find((w) => w.repoKey === R);
    const mySince = mine ? Date.parse(mine.since) : now.getTime();
    // A repo not yet waiting joins the BACK of the queue, so every waiter is ahead of it (see turnRule).
    const longer = mine ? others.filter((w) => Date.parse(w.since) < mySince || (Date.parse(w.since) === mySince && w.repoKey < R)) : others;
    const end = new Date(now.getTime() + (op.forMin ?? LIMITS.defaultForMin) * MIN);
    if (r.basis === 'in-turn' && !turnActive(sb, R, now)) return 'I5: granted in-turn but the repo had no active turn';
    if (r.basis === 'no-waiters' && (others.length > 0 || incumbent)) return 'I5: granted no-waiters while another repo waited or held the turn';
    if (r.basis === 'head' && (longer.length > 0 || incumbent)) return 'I5: granted head while a repo that waited longer was ahead';
    if (r.basis === 'backfill' && (!longer.length || longer.some((w) => admissionCheck(sb, { repoKey: w.repoKey, holder: '-' }, w.forMin, now, probe).ok))) return 'I5: granted backfill but a longer-waiting repo could have gone';
    if (r.basis === 'gap' && !usesNamedGap(sb, R, now, end)) return 'I5: granted gap but no gap named for the repo covered the request';
  }
  if (r.ok === false && r.code === 'turn' && !(sb.waiters ?? []).length) return 'I5: refused for turn with nobody waiting';
  for (const e of after.lease.journal ?? []) {
    if (e.kind !== 'wait-ended' || e.reason !== 'lapsed' || (before.lease.journal ?? []).includes(e)) continue; // only entries THIS step added
    const w = (before.lease.waiters ?? []).find((x) => x.episode === e.episode);
    if (!w || w.offeredAt === undefined || now.getTime() - Date.parse(w.offeredAt) < LIMITS.claimMs) return `I5: ${e.episode} lapsed without 15 continuous minutes of being offered the slot (waiter ${JSON.stringify(w)} now ${now.toISOString()} op ${op.op})`;
    stats.lapsed += 1;
  }
  return null;
}

const T0 = new Date('2026-10-14T06:00:00.000Z');
const mixOf = (seed) => ['uniform', 'calm', 'gappy'][seed % 3];
/** What the random search actually exercised, so a green run cannot be a run that never reached the interesting states. */
const stats = { granted: 0, announceRefusedHeld: 0, announceOverHeld: 0, queued: 0, served: 0, cancelled: 0, clears: 0, turnRefused: 0, inTurn: 0, backfill: 0, gapGrants: 0, gapAcquires: 0, lapsed: 0, endTurn: 0, overTurn: 0, offered: 0, endTurnKept: 0, endTurnYielded: 0, endTurnOutOfScope: 0, renewGranted: 0, renewRefusedTurn: 0 };
function tally(op, r) {
  if (op.op === 'acquire' && r.ok) stats.granted += 1;
  if (op.op === 'acquire' && r.queued) stats.queued += 1;
  if (op.op === 'announce' && r.code === 'held') stats.announceRefusedHeld += 1;
  if (op.op === 'announce' && r.ok && r.window?.overHeld) stats.announceOverHeld += 1;
  if (op.op === 'wait' && r.cancelled) stats.cancelled += 1;
  if (op.op === 'clear' && r.ok) stats.clears += 1;
  if (r.code === 'turn') stats.turnRefused += 1;
  if (op.op === 'acquire' && r.basis === 'in-turn') stats.inTurn += 1;
  if (op.op === 'acquire' && r.basis === 'backfill') stats.backfill += 1;
  if (op.op === 'acquire' && r.basis === 'gap') stats.gapAcquires += 1;
  if (op.op === 'grant' && r.ok) stats.gapGrants += 1;
  if (op.op === 'release' && op.endTurn && r.ok) stats.endTurn += 1;
  if (op.op === 'announce' && r.ok && r.overTurn) stats.overTurn += 1;

  if (r.ok && (r.lease?.journal ?? []).some((e, i, a) => i === a.length - 2 && e.kind === 'wait-ended' && e.reason === 'served')) stats.served += 1;
}

describe('lease interleavings (property test, seeded)', () => {
  it('the invariants can fail: a refusal that changed the windows, or a bad request that wrote, is reported', () => {
    const before = { lease: { ...emptyLease(), heavy: null }, now: T0 };
    const op = { op: 'announce', repo: REPOS[0], holder: 'main' };
    const mutated = { lease: { ...emptyLease(), windows: [{ id: 'w-20261014060000-abcd', repoKey: REPOS[1].repoKey, repo: 'o/b', kind: 'ci', from: T0.toISOString(), until: new Date(T0.getTime() + 60 * MIN).toISOString() }] }, now: T0, result: { ok: false, code: 'held' } };
    assert.match(violation(before, mutated, op), /I3: a refused announce \(held\) changed the windows/);
    const wrote = { lease: emptyLease(), now: T0, result: { ok: false, code: 'bad-request' } };
    assert.match(violation(before, wrote, op), /I3: a bad request wrote something/);
    const noJournal = { lease: emptyLease(), now: T0, result: { ok: true } };
        assert.match(violation(before, noJournal, { ...op, op: 'acquire' }), /I4: a successful acquire by o\/a added no acquired entry of its own/);
  });

  it('the 08:06Z race: an announce over a slot another repo acquired seconds earlier is not an unacknowledged overlap', () => {
    const ces = { repoKey: 'aaaaaaaaaaaa', holder: 'skill-size-ratchet' };
    const sto = { repoKey: 'bbbbbbbbbbbb', holder: 'coordinator' };
    const at = (hms) => new Date(`2026-10-14T${hms}Z`);
    let lease = emptyLease();
    const got = decideAcquire(lease, { identity: ces, repo: 'o/ces', forMin: 40, pid: 4242 }, at('08:06:00.000'), probe);
    assert.equal(got.ok, true);
    lease = got.lease;
    const win = decideAnnounce(lease, { identity: sto, repo: 'o/sto', kind: 'ci', from: '2026-10-14T08:06:29.000Z', until: '2026-10-14T09:00:00.000Z' }, at('08:06:29.000'), probe);
    assert.equal(win.ok, false, 'announce must not silently record a window over a live slot (it printed OK on 2026-10-14)');
    assert.equal(win.code, 'held');
    assert.match(win.reason, /08:46/);
    // The explicit acknowledgement is the only way through, and it is recorded.
    const over = decideAnnounce(lease, { identity: sto, repo: 'o/sto', kind: 'ci', from: '2026-10-14T08:06:29.000Z', until: '2026-10-14T09:00:00.000Z', overHeld: true }, at('08:06:29.000'), probe);
    assert.equal(over.ok, true);
    assert.equal(over.window.overHeld.repoKey, ces.repoKey);
    assert.equal(over.window.overHeld.holder, ces.holder);
  });

  it('400 random sequences of 40 operations over 3 repos never break an invariant', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const rnd = prng(seed);
      let state = { lease: emptyLease(), now: T0 };
      const prefix = [];
      for (let i = 0; i < 40; i += 1) {
        const op = randomOp(rnd, mixOf(seed));
        prefix.push(op);
        const next = apply(state, op);
        tally(op, next.result);
        const bad = violation(state, next, op);
        if (bad) {
          assert.fail(`${bad}\nseed ${seed}, step ${i + 1}; replay prefix:\n${prefix.map((o, n) => `  ${n + 1}. ${JSON.stringify({ ...o, repo: o.repo.repo })}`).join('\n')}`);
        }
        state = next;
      }
    }
    // Vacuous-pass guard: the invariants held AND the search reached the states they are about.
    for (const [k, min] of Object.entries({ granted: 200, announceRefusedHeld: 50, announceOverHeld: 10, queued: 200, served: 20, cancelled: 20, clears: 50, turnRefused: 100, inTurn: 20, backfill: 5, gapGrants: 20, gapAcquires: 5, endTurn: 10, overTurn: 10, lapsed: 3, endTurnKept: 3, endTurnYielded: 3, endTurnOutOfScope: 1, renewGranted: 20, renewRefusedTurn: 3 })) {
      assert.ok(stats[k] >= min, `the random search barely exercised ${k} (${stats[k]} < ${min}): a green run proves nothing about it. Reached: ${JSON.stringify(stats)}`);
    }
  });
});
