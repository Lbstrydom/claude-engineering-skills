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
function randomOp(rnd) {
  const repo = pick(rnd, REPOS);
  const holder = pick(rnd, HOLDERS);
  const base = { repo, holder };
  const roll = rnd();
  if (roll < 0.30) return { ...base, op: 'acquire', forMin: int(rnd, 1, 60), pid: 4242 };
  if (roll < 0.45) return { ...base, op: 'release' };
  if (roll < 0.70) {
    return { ...base, op: 'announce', kind: pick(rnd, ['quiet', 'ci']), fromMin: pick(rnd, [0, 0, int(rnd, 1, 90)]), durMin: int(rnd, 5, 120), overHeld: rnd() < 0.25 };
  }
  if (roll < 0.78) return { ...base, op: 'clear', pick: rnd() };
  if (roll < 0.85) return { ...base, op: 'wait', forMin: int(rnd, 1, 60), cancel: rnd() < 0.4 };
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
    case 'release': d = decideRelease(lease, { ...common }, now, probe); break;
    case 'announce': {
      const from = new Date(now.getTime() + op.fromMin * MIN);
      const until = new Date(from.getTime() + op.durMin * MIN);
      d = decideAnnounce(lease, { ...common, kind: op.kind, from: from.toISOString(), until: until.toISOString(), overHeld: op.overHeld }, now);
      break;
    }
    case 'clear': {
      const w = lease.windows[Math.floor(op.pick * lease.windows.length)];
      d = w ? decideClearWindow(lease, { ...common, id: w.id }, now) : { ok: false, code: 'no-such-window', reason: 'none' };
      break;
    }
    case 'wait': d = decideWait(lease, { ...common, forMin: op.forMin, cancel: op.cancel }, now); break;
    case 'advance': return { lease, now: new Date(now.getTime() + op.min * MIN), result: { ok: true, noop: true } };
    default: throw new Error(`unknown op ${op.op}`);
  }
  if (d.code === 'bad-request') return { lease, now, result: d };
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
  if (r.ok && need && lease.journal?.at(-1)?.kind !== need) return `I4: a successful ${op.op} left the journal ending in ${lease.journal?.at(-1)?.kind}, not ${need}`;
  const ended = new Map();
  for (const e of lease.journal ?? []) if (e.kind === 'wait-ended') ended.set(e.episode, (ended.get(e.episode) ?? 0) + 1);
  for (const [ep, n] of ended) if (n > 1) return `I4: wait episode ${ep} ended ${n} times`;
  for (const w of lease.waiters ?? []) {
    if (ended.has(w.episode)) return `I4: ${w.repo} is still waiting in an episode the journal says ended`;
  }
  return null;
}

const T0 = new Date('2026-10-14T06:00:00.000Z');
/** What the random search actually exercised, so a green run cannot be a run that never reached the interesting states. */
const stats = { granted: 0, announceRefusedHeld: 0, announceOverHeld: 0, queued: 0, served: 0, cancelled: 0, clears: 0 };
function tally(op, r) {
  if (op.op === 'acquire' && r.ok) stats.granted += 1;
  if (op.op === 'acquire' && r.queued) stats.queued += 1;
  if (op.op === 'announce' && r.code === 'held') stats.announceRefusedHeld += 1;
  if (op.op === 'announce' && r.ok && r.window?.overHeld) stats.announceOverHeld += 1;
  if (op.op === 'wait' && r.cancelled) stats.cancelled += 1;
  if (op.op === 'clear' && r.ok) stats.clears += 1;
  if (r.ok && (r.lease?.journal ?? []).some((e, i, a) => i === a.length - 2 && e.kind === 'wait-ended' && e.reason === 'served')) stats.served += 1;
}

describe('lease interleavings (property test, seeded)', () => {
  it('the 08:06Z race: an announce over a slot another repo acquired seconds earlier is not an unacknowledged overlap', () => {
    const ces = { repoKey: 'aaaaaaaaaaaa', holder: 'skill-size-ratchet' };
    const sto = { repoKey: 'bbbbbbbbbbbb', holder: 'coordinator' };
    const at = (hms) => new Date(`2026-10-14T${hms}Z`);
    let lease = emptyLease();
    const got = decideAcquire(lease, { identity: ces, repo: 'o/ces', forMin: 40, pid: 4242 }, at('08:06:00.000'), probe);
    assert.equal(got.ok, true);
    lease = got.lease;
    const win = decideAnnounce(lease, { identity: sto, repo: 'o/sto', kind: 'ci', from: '2026-10-14T08:06:29.000Z', until: '2026-10-14T09:00:00.000Z' }, at('08:06:29.000'));
    assert.equal(win.ok, false, 'announce must not silently record a window over a live slot (it printed OK on 2026-10-14)');
    assert.equal(win.code, 'held');
    assert.match(win.reason, /08:46/);
    // The explicit acknowledgement is the only way through, and it is recorded.
    const over = decideAnnounce(lease, { identity: sto, repo: 'o/sto', kind: 'ci', from: '2026-10-14T08:06:29.000Z', until: '2026-10-14T09:00:00.000Z', overHeld: true }, at('08:06:29.000'));
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
        const op = randomOp(rnd);
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
    for (const [k, min] of Object.entries({ granted: 200, announceRefusedHeld: 50, announceOverHeld: 20, queued: 200, served: 20, cancelled: 20, clears: 50 })) {
      assert.ok(stats[k] >= min, `the random search barely exercised ${k} (${stats[k]} < ${min}): a green run proves nothing about it`);
    }
  });
});
