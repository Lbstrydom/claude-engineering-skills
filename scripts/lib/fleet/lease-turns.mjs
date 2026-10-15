/**
 * @fileoverview Turns when several repos wait for the machine lease (plan docs/plans/fleet-lease-turns-and-journal.md D6,
 * the user's 2026-10-14 policy: ~60-minute batched turns, the longest-waiting repo next, a repo's own CI windows count
 * as its time). Pure over an injected clock and pid probe; the CLI and the decisions in `lease.mjs` call it.
 *
 * Call graph (acyclic by design, audit R2 H1): a decision calls `settleQueue` first, then `admissionCheck` (the
 * side-effect-free non-turn question, in `lease-model.mjs`), then `turnRule`. `settleQueue` and `turnRule` ask
 * `admissionCheck`; `admissionCheck` imports nothing that settles.
 *
 * COOPERATIVE: nothing here enforces anything. Waiting is recorded by a refused `acquire` (or `lease wait`), and a
 * repo that asks out of turn is told whose turn it is, not stopped.
 *
 * @module scripts/lib/fleet/lease-turns
 */
import {
  LIMITS, admissionCheck, appendJournal, defaultProbe, hhmmOf, ms, uniqueEpisode, waitEndedEntry,
} from './lease-model.mjs';

export const turnMinOf = (lease) => lease.turnMin ?? LIMITS.defaultTurnMin;

/** Is `repoKey`'s turn active at `now`? Between jobs it stays active for `batchGapMs`, and it never outlives `endsAt`. */
export function turnActive(lease, repoKey, now) {
  const t = lease.turn;
  if (!t || t.repoKey !== repoKey) return false;
  if (now.getTime() >= ms(t.endsAt)) return false;
  if (t.lastReleasedAt && now.getTime() - ms(t.lastReleasedAt) > LIMITS.batchGapMs) return false;
  return true;
}

const bySince = (a, b) => ms(a.since) - ms(b.since) || (a.repoKey < b.repoKey ? -1 : 1);
const turnEntry = (kind, t, now, extra = {}) => ({ at: now.toISOString(), kind, by: 'settle', repoKey: t.repoKey, turn: { repo: t.repo, startedAt: t.startedAt, endsAt: t.endsAt }, ...extra });

/** End the turn (journal why) - `reason`: expiry | idle | yield | handover. */
export function endTurn(lease, reason, now, by = 'settle') {
  if (!lease.turn) return lease;
  const { turn, ...rest } = lease;
  return appendJournal(rest, { ...turnEntry('turn-ended', turn, now, { reason }), by });
}

/** Start `req`'s repo's turn (ending another repo's first: a handover). */
export function startTurn(lease, req, now) {
  let next = lease;
  if (next.turn && next.turn.repoKey !== req.identity.repoKey) next = endTurn(next, 'handover', now, `${req.identity.holder}@${req.repo}`);
  const turn = { repoKey: req.identity.repoKey, repo: req.repo, startedAt: now.toISOString(), endsAt: new Date(now.getTime() + turnMinOf(lease) * 60_000).toISOString() };
  return appendJournal({ ...next, turn }, { ...turnEntry('turn-started', turn, now), by: `${req.identity.holder}@${req.repo}` });
}

/** The head of the queue: the repo that has waited longest (ties by repoKey, so the order is total). */
export const queueHead = (lease) => [...(lease.waiters ?? [])].sort(bySince)[0];

const wouldFit = (lease, w, now, probe) => admissionCheck(lease, { repoKey: w.repoKey, holder: '-' }, w.forMin, now, probe).ok;

function settleTurn(lease, now) {
  const t = lease.turn;
  if (!t) return lease;
  let cur = lease;
  let turn = t;
  // The turn's repo has no live job and nobody recorded a release (a crashed or forced job): the job ended when its
  // lease did, so the between-jobs clock starts there. Deterministic, and needs no pid probe.
  if (!turn.lastReleasedAt) {
    const h = cur.heavy;
    const live = h && h.repoKey === turn.repoKey && now.getTime() < ms(h.expiresAt);
    if (!live) {
      const at = h && h.repoKey === turn.repoKey ? h.expiresAt : (cur.slotFreedAt && ms(cur.slotFreedAt) >= ms(turn.startedAt) ? cur.slotFreedAt : turn.startedAt);
      turn = { ...turn, lastReleasedAt: at };
      cur = { ...cur, turn };
    }
  }
  if (now.getTime() >= ms(turn.endsAt)) return endTurn(cur, 'expiry', now);
  if (turn.lastReleasedAt && now.getTime() - ms(turn.lastReleasedAt) > LIMITS.batchGapMs) return endTurn(cur, 'idle', now);
  return cur;
}

/** Offer the head the slot (or take the offer back), and lapse a head that has been continuously able and has not come. */
function settleOffers(lease, now, probe, depth = 0) {
  const head = queueHead(lease);
  if (!head) return lease;
  const stamp0 = now.toISOString();
  const incumbent = lease.turn && lease.turn.repoKey !== head.repoKey && turnActive(lease, lease.turn.repoKey, now);
  const eligible = !incumbent && wouldFit(lease, head, now, probe);
  const set = (w) => ({ ...lease, waiters: lease.waiters.map((x) => (x.repoKey === head.repoKey ? w : x)) });
  if (!eligible) {
    if (head.offeredAt === undefined) return lease;
    const { offeredAt, ...w } = head;
    return set(w);
  }
  if (head.offeredAt === undefined) {
    const next = appendJournal(set({ ...head, offeredAt: stamp0 }), { at: stamp0, kind: 'offered', by: 'settle', repoKey: head.repoKey, episode: head.episode ?? `${head.repoKey}@${head.since}` });
    return next;
  }
  // Continuity: the offer holds only if the slot was not used and freed since, and no other repo's window (outside the
  // gaps granted to it) overlapped the time since - otherwise the head could not have gone, and the clock restarts.
  const offered = ms(head.offeredAt);
  const slotUsed = lease.slotFreedAt && ms(lease.slotFreedAt) > offered;
  const blocked = lease.windows.some((w) => w.repoKey !== head.repoKey && ms(w.from) < now.getTime() && ms(w.until) > offered
    && !(w.gaps ?? []).some((g) => (!g.toRepoKey || g.toRepoKey === head.repoKey) && ms(g.from) <= offered && ms(g.until) >= now.getTime()));
  if (slotUsed || blocked) return set({ ...head, offeredAt: stamp0 });
  if (now.getTime() - offered < LIMITS.claimMs || depth > 0) return lease;
  // Lapse: to the back, with a fresh waiting clock and a NEW episode.
  const episode = uniqueEpisode(lease, head.repoKey, stamp0);
  const back = { ...head, since: stamp0, episode, refusals: 0, forMin: head.forMin };
  delete back.offeredAt; delete back.lastRefusal;
  let next = appendJournal(set(back), waitEndedEntry(head, 'lapsed', now, 'settle'));
  next = appendJournal(next, { at: stamp0, kind: 'waiting', by: head.by, repoKey: head.repoKey, episode, opener: 'lapse', job: { forMin: head.forMin } });
  return settleOffers(next, now, probe, depth + 1);
}

/**
 * The time-driven transitions, applied FIRST in every mutating decision (after the request validates, before it is
 * evaluated) and persisted even when the operation is then refused, because they are facts about time:
 * a waiter older than `maxWaitMs` expires; the turn ends on expiry or after `batchGapMs` between jobs; the head is
 * offered the slot or, after `claimMs` of continuous ability to take it, lapses to the back. Touches `waiters`, `turn`
 * and `journal` only - never the slot or the windows - and returns the SAME object when nothing changed.
 */
export function settleQueue(lease, now, probe = defaultProbe()) {
  let next = lease;
  const stale = (next.waiters ?? []).filter((w) => now.getTime() - ms(w.since) > LIMITS.maxWaitMs);
  if (stale.length) {
    next = { ...next, waiters: next.waiters.filter((w) => !stale.includes(w)) };
    for (const w of stale) next = appendJournal(next, waitEndedEntry(w, 'expired', now, 'settle'));
  }
  next = settleTurn(next, now);
  next = settleOffers(next, now, probe);
  return next;
}

/**
 * The admission rule for a FRESH grant of the slot (a renewal of the running job is not a new job and skips it).
 * Order: a gap named for the repo; its own active turn; another repo's active turn (the incumbent has precedence over
 * the head); nobody else waiting; then the queue - the repo goes if it is the head, or if every repo that has waited
 * longer cannot take the slot right now (backfill), and is told whose turn it is otherwise.
 * @returns {{ok: true, basis: string} | {ok: false, reason: string, first: string}}
 */
export function turnRule(lease, req, now, probe, { namedGap = false } = {}) {
  const repoKey = req.identity.repoKey;
  const waiters = lease.waiters ?? [];
  if (namedGap) return { ok: true, basis: 'gap' };
  if (turnActive(lease, repoKey, now)) return { ok: true, basis: 'in-turn' };
  const t = lease.turn;
  if (t && t.repoKey !== repoKey && waiters.length > 0 && turnActive(lease, t.repoKey, now)) {
    const between = t.lastReleasedAt ? ` (between jobs since ${hhmmOf(new Date(t.lastReleasedAt))}; it keeps the slot for a ${Math.round(LIMITS.batchGapMs / 60_000)}-minute gap, then the queue moves)` : '';
    return { ok: false, first: t.repo, reason: `it is ${t.repo}'s turn until ${hhmmOf(new Date(t.endsAt))}${between}` };
  }
  const others = waiters.filter((w) => w.repoKey !== repoKey);
  if (!others.length) return { ok: true, basis: 'no-waiters' };
  const mine = waiters.find((w) => w.repoKey === repoKey);
  const mySince = mine ? ms(mine.since) : now.getTime();
  // A repo that is not waiting yet joins the BACK of the queue: everyone already waiting is ahead of it, even on a clock tick it
  // shares (a pinned test clock), so the tie-break by repoKey applies only between two repos that are both queued.
  const earlier = others.filter((w) => !mine || ms(w.since) < mySince || (ms(w.since) === mySince && w.repoKey < repoKey)).sort(bySince);
  if (!earlier.length) return { ok: true, basis: 'head' };
  const first = earlier.find((w) => wouldFit(lease, w, now, probe));
  if (first) return { ok: false, first: first.repo, reason: `${first.repo} has waited since ${hhmmOf(new Date(first.since))} and goes first` };
  return { ok: true, basis: 'backfill' };
}
