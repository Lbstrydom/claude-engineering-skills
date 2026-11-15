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
  LIMITS, admissionCheck, appendJournal, classifyHeavy, conflictingWindows, defaultProbe, hhmmOf, ms, uniqueEpisode, waitEndedEntry,
} from './lease-model.mjs';

export const turnMinOf = (lease) => lease.turnMin ?? LIMITS.defaultTurnMin;

/**
 * When did the turn's repo last stop using the machine, and is it using it now? A release, and the end of any of the
 * repo's OWN windows (a CI run or a scheduled run counts as its heavy time), both restart the between-jobs clock; a
 * window still running means it is busy. `null` `lastBusy` means nothing has ended yet.
 */
function busyOf(lease, turn, now) {
  let lastBusy = turn.lastReleasedAt ? ms(turn.lastReleasedAt) : null;
  let busy = false;
  for (const w of lease.windows) {
    if (w.repoKey !== turn.repoKey || ms(w.from) > now.getTime()) continue;
    if (now.getTime() < ms(w.until)) busy = true;
    else lastBusy = Math.max(lastBusy ?? 0, ms(w.until));
  }
  return { busy, lastBusy };
}

/** Is `repoKey`'s turn active at `now`? It never outlives `endsAt`; between jobs it holds for `batchGapMs`, and never while the repo's own window runs. */
export function turnActive(lease, repoKey, now) {
  const t = lease.turn;
  if (!t || t.repoKey !== repoKey) return false;
  if (now.getTime() >= ms(t.endsAt)) return false;
  const { busy, lastBusy } = busyOf(lease, t, now);
  if (busy) return true;
  return lastBusy === null || now.getTime() - lastBusy <= LIMITS.batchGapMs;
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

const wouldFit = (lease, w, now, probe) => admissionCheck(lease, { repoKey: w.repoKey, holder: '-' }, w.forMin, now, probe).ok;

function settleTurn(lease, now, probe) {
  const t = lease.turn;
  if (!t) return lease;
  let cur = lease;
  let turn = t;
  // The turn's repo has no running job and nobody recorded a release (a crashed or forced job): start the between-jobs
  // clock. An EXPIRED lease is not proof the job stopped (#243 D4), so the slot's own classification decides: only a
  // dead recorded pid, or a slot nobody holds, counts. Expired-but-alive or unverifiable means the job may still run.
  if (!turn.lastReleasedAt) {
    const h = cur.heavy;
    let at = null;
    if (!h || h.repoKey !== turn.repoKey) at = cur.slotFreedAt && ms(cur.slotFreedAt) >= ms(turn.startedAt) ? cur.slotFreedAt : turn.startedAt;
    else if (classifyHeavy(h, now, probe).verdict === 'pid-dead') at = h.expiresAt;
    if (at !== null) {
      turn = { ...turn, lastReleasedAt: at };
      cur = { ...cur, turn };
    }
  }
  if (now.getTime() >= ms(turn.endsAt)) return endTurn(cur, 'expiry', now);
  const { busy, lastBusy } = busyOf(cur, turn, now);
  if (!busy && lastBusy !== null && now.getTime() - lastBusy > LIMITS.batchGapMs) return endTurn(cur, 'idle', now);
  return cur;
}

/**
 * Offer the slot to the first waiter that could take it NOW (the effective head: an older waiter blocked by a window does
 * not hold the queue), take every other offer back, and lapse an offered waiter that has been continuously able to go
 * and has not come. Eligibility is `admissionCheck`, and the history of it is `conflictingWindows` over the offer
 * interval - one scheduling policy asked about two intervals, not two policies.
 */
function settleOffers(lease, now, probe, depth = 0) {
  const waiters = lease.waiters ?? [];
  if (!waiters.length) return lease;
  const stamp0 = now.toISOString();
  const incumbent = (w) => lease.turn && lease.turn.repoKey !== w.repoKey && turnActive(lease, lease.turn.repoKey, now);
  const first = [...waiters].sort(bySince).find((w) => !incumbent(w) && wouldFit(lease, w, now, probe));
  let next = lease;
  const withdrawn = waiters.filter((w) => w !== first && w.offeredAt !== undefined);
  if (withdrawn.length) {
    next = { ...next, waiters: next.waiters.map((w) => { if (!withdrawn.includes(w)) return w; const { offeredAt, ...rest } = w; return rest; }) };
  }
  if (!first) return next;
  const set = (w) => ({ ...next, waiters: next.waiters.map((x) => (x.repoKey === first.repoKey ? w : x)) });
  if (first.offeredAt === undefined) {
    return appendJournal(set({ ...first, offeredAt: stamp0 }), { at: stamp0, kind: 'offered', by: 'settle', repoKey: first.repoKey, episode: first.episode ?? `${first.repoKey}@${first.since}` });
  }
  // Continuity: the offer holds only if the slot was not used and freed since, and no other repo's window (outside the gaps
  // granted to it) blocked it at any point since - otherwise it could not have gone, and the clock restarts.
  const offered = ms(first.offeredAt);
  const slotUsed = lease.slotFreedAt && ms(lease.slotFreedAt) > offered;
  const blocked = conflictingWindows(lease, first.repoKey, new Date(offered), now).length > 0;
  if (slotUsed || blocked) return set({ ...first, offeredAt: stamp0 });
  if (now.getTime() - offered < LIMITS.claimMs || depth > 0) return next;
  // Lapse: to the back, with a fresh waiting clock and a NEW episode.
  const episode = uniqueEpisode(lease, first.repoKey, stamp0);
  const back = { ...first, since: stamp0, episode, refusals: 0 };
  delete back.offeredAt; delete back.lastRefusal;
  let lapsed = appendJournal(set(back), waitEndedEntry(first, 'lapsed', now, 'settle'));
  lapsed = appendJournal(lapsed, { at: stamp0, kind: 'waiting', by: first.by, repoKey: first.repoKey, episode, opener: 'lapse', job: { forMin: first.forMin } });
  return settleOffers(lapsed, now, probe, depth + 1);
}

/**
 * The time-driven transitions, applied FIRST in every mutating decision (after the request validates, before it is
 * evaluated) and persisted even when the operation is then refused, because they are facts about time:
 * a waiter older than `maxWaitMs` expires; the turn ends on expiry or after `batchGapMs` between jobs; the first
 * waiter able to go is offered the slot or, after `claimMs` of continuous ability and not coming, lapses to the back.
 * Touches `waiters`, `turn` and `journal` only - never the slot or the windows - and returns the SAME object when
 * nothing changed.
 */
export function settleQueue(lease, now, probe = defaultProbe()) {
  let next = lease;
  const stale = (next.waiters ?? []).filter((w) => now.getTime() - ms(w.since) > LIMITS.maxWaitMs);
  if (stale.length) {
    next = { ...next, waiters: next.waiters.filter((w) => !stale.includes(w)) };
    for (const w of stale) next = appendJournal(next, waitEndedEntry(w, 'expired', now, 'settle'));
  }
  next = settleTurn(next, now, probe);
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
    const { busy, lastBusy } = busyOf(lease, t, now);
    const between = !busy && lastBusy !== null ? ` (between jobs since ${hhmmOf(new Date(lastBusy))}; it keeps the slot for a ${Math.round(LIMITS.batchGapMs / 60_000)}-minute gap, then the queue moves)` : '';
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
