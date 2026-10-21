/**
 * @fileoverview The machine-wide lease (`fleet lease`): ONE record, shared by every repo's fleet on this machine, of
 * the heavy slot (rule 14: one full gate or test suite at a time), the quiet/CI windows repos announce, and the
 * peak-cost hours. It replaces asking a person "is the slot free" with reading a file.
 *
 * COOPERATIVE, like the rest of fleet: nothing here enforces anything; sessions read it and honour it. The pre-push
 * hook does not consult it.
 *
 * The policy is pure over an injected clock and an injected process probe, so every rule is tested without a
 * process or a real home directory. The store is `lease.json` + `lease.lock` in {@link machineDir}.
 *
 * Load-bearing rules (plan: docs/plans/fleet-machine-lease.md):
 *  - Identity is the PAIR `(repoKey, holder)`; a bare branch name collides across repos.
 *  - An expired lease is NOT proof the process stopped. A takeover needs evidence (a recorded pid, in the SAME
 *    process scope, that is dead); anything else is refused as unverifiable, and the only way past it is a
 *    recorded human decision (`release --force --reason`).
 *  - The CLI's own pid is never recorded (it exits at once and would read dead).
 *  - A write over a limit is refused, never trimmed silently; `events` is the one ring.
 *  - Unknown keys are tolerated and preserved within a `schemaVersion`; a NEWER version is read-only here.
 *  - Unreadable is never rendered as free: it is `unmeasured` with its reason.
 *
 * @module scripts/lib/fleet/lease
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  KINDS, LIMITS, MIN, WINDOW_KINDS, admissionCheck, appendEvent, appendJournal, badIdentity, byOf, checkNote, classifyHeavy, clip, defaultProbe, emptyLease, endWait, episodeOf, hex, hhmm, hhmmOf, iso, jentry, journalRefusal, leasePaths, ms, name, note, openWait, parseWhen, pruneWindows, refuse, resolveRepoLabel, sameIdentity, usesNamedGap,
} from './lease-model.mjs';
import { endTurn, settleQueue, startTurn, turnActive, turnMinOf, turnRule } from './lease-turns.mjs';

// The public surface is unchanged by the split: everything `lease.mjs` exported before still comes from here.
export {
  LEASE_SCHEMA_VERSION, LEASE_FILE, LEASE_LOCK, KINDS, WINDOW_KINDS, EVENT_KINDS, LIMITS, LeaseConfigError, machineDir, repoKeyOf, repoLabel, currentScope, LeaseSchema, emptyLease, leasePaths, readLease, writeLease, transactLease, parseWhen, classifyHeavy, defaultProbe, appendEvent, appendJournal, pruneWindows, conflictingWindows, admissionCheck, usesNamedGap,
} from './lease-model.mjs';
export { settleQueue } from './lease-turns.mjs';

/**
 * Decide an `acquire`. Order: bad request, window conflict, then the slot rules (plan D4).
 * @param {object} lease
 * @param {{identity: {repoKey: string, holder: string}, repo: string, kind?: string, forMin?: number, pid?: number, token?: string, note?: string, newToken?: string}} req
 * @returns {{ok: true, lease: object, heavy: object, renewed: boolean, rotated: boolean, event?: object} | {ok: false, code: string, reason: string}}
 */
export function decideAcquire(lease, req, now, probe = defaultProbe()) {
  const bad = badIdentity(req);
  if (bad) return bad;
  const kind = req.kind ?? 'gate';
  const forMin = req.forMin ?? LIMITS.defaultForMin;
  if (!KINDS.includes(kind)) return refuse('bad-request', `--kind must be one of ${KINDS.join(', ')}`);
  if (!Number.isInteger(forMin) || forMin < 1 || forMin > LIMITS.maxForMin) return refuse('bad-request', `--for must be a whole number of minutes from 1 to ${LIMITS.maxForMin}`);
  if (req.pid !== undefined && (!Number.isInteger(req.pid) || req.pid <= 0)) return refuse('bad-request', '--pid must be a positive whole number');
  if (!checkNote(req.note)) return refuse('bad-request', `--note must be at most ${LIMITS.noteMax} characters with no control characters`);
  const end = new Date(now.getTime() + forMin * MIN);
  // Validated; now settle time-driven state, then evaluate against the settled lease (plan D3b, three stages).
  const base = settleQueue(lease, now, probe);
  const keep = (r) => (base === lease ? r : { ...r, lease: base });
  /** A refusal that means "someone else has the slot": this repo is now waiting, unless the list is full. */
  const waitRefusal = (code, reason) => {
    const o = openWait(base, req, { forMin, opener: 'refusal', refusal: { op: 'acquire', code }, now });
    if (!o.queued) return { ...refuse(code, reason), queued: false, queueFull: true, lease: journalRefusal(base, req, 'acquire', code, now, { job: { kind, forMin } }) };
    return { ...refuse(code, reason), queued: true, lease: o.lease };
  };
  const cur = base.heavy;
  const cls = classifyHeavy(cur, now, probe);
  // A RUN must be the only run (plan D7, audit R1 H3): two `sync:pr` runs for one consumer share the holder `sync-pr`, so a
  // plain acquire would rotate the first's token and let both go. `exclusive` refuses a slot this identity already holds
  // while its job may still run, and treats an expired one with a dead pid as a takeover; a direct acquire is unchanged.
  if (req.exclusive && cur && sameIdentity(cur, req.identity)) {
    if (cls.state === 'held') return keep(refuse('held', `this session (${cur.holder}) already holds the slot until ${cur.expiresAt}: another run is in progress`));
    if (cls.verdict === 'pid-alive') return keep(refuse('expired-pid-alive', `this session's previous lease expired at ${cur.expiresAt}, but ${cls.reason}; it cannot be granted`));
    if (cls.verdict === 'unverifiable') return keep(refuse('unverifiable', `this session's previous lease expired at ${cur.expiresAt} but ${cls.reason}; if a person has confirmed the job is gone: release --force --reason "<why>"`));
  }
  const mine = cur && sameIdentity(cur, req.identity) && !req.exclusive;
  // D12 (finding 8182): identity is (repo, holder), so two sessions of one checkout that share the derived name are the SAME identity.
  // A token-less acquire of a LIVE slot the identity holds would "rotate" the first session's token and hand it the other's job
  // (storyline 2026-10-15 18:45Z: a worker's acquire replaced the coordinator's CI hold; its release then freed the slot mid-CI).
  // Extending a live lease needs its token; an EXPIRED own slot can still be taken back without one (#243's rotation).
  if (mine && req.token === undefined && cls.state === 'held') {
    return keep(refuse('held', `this holder (${cur.holder}) already holds the slot until ${hhmmOf(new Date(cur.expiresAt))}; to extend it pass --token (the one acquire printed); if another session uses the same name, give it its own --id`));
  }

  // Stage 1 of the decision proper: the non-turn question (windows with their granted gaps, then the slot).
  const adm = admissionCheck(base, req.identity, forMin, now, probe);
  if (!adm.ok) return waitRefusal(adm.code, adm.reason);

  let event;
  if (cur && mine) {
    if (req.token !== undefined && req.token !== cur.token) return keep(refuse('stale-token', 'the supplied token is not the current one for this slot (a stale fence)'));
  } else if (cur) {
    event = { at: now.toISOString(), kind: 'taken-over', by: `${req.identity.holder}@${req.repo}`, reason: clip(`${cur.holder} (${cur.repo}) expired at ${cur.expiresAt}; ${cls.reason}`) };
  }

  // Stage 2: the turn rule decides a FRESH grant. A renewal or rotation is the same running job, never a new one.
  let basis = 'same-job';
  if (!(cur && mine)) {
    const tr = turnRule(base, req, now, probe, { namedGap: usesNamedGap(base, req.identity.repoKey, now, end) });
    if (!tr.ok) return waitRefusal('turn', tr.reason);
    basis = tr.basis;
  } else {
    // D11 (finding 20ec): a renewal or rotation is the same running job, so it never starts a turn (the budget counts from the
    // turn's FIRST grant) - but it must not outlive the repo's turn while another repo waits. It is judged by the same rule as a fresh
    // grant, on a projection of the settled lease in which only THIS job's own occupancy is removed: on the real lease every
    // competing waiter fails admission on the very slot being renewed, so backfill would grant the renewal forever.
    const tr = turnRule({ ...base, heavy: null }, req, now, probe, { namedGap: usesNamedGap(base, req.identity.repoKey, now, end) });
    if (!tr.ok) {
      const stays = cls.state === 'held' ? ` (the slot stays yours until ${hhmmOf(new Date(cur.expiresAt))})` : '';
      return waitRefusal('turn', `${tr.reason}; this lease is not extended - finish and \`lease release\`${stays}`);
    }
  }
  const renewed = Boolean(cur && mine && req.token !== undefined);
  const rotated = Boolean(cur && mine && req.token === undefined);
  const fresh = {
    holder: req.identity.holder, repoKey: req.identity.repoKey, repo: req.repo, kind,
    ...(req.note !== undefined ? { note: req.note } : {}),
    scope: probe.scope, ...(req.pid !== undefined ? { pid: req.pid } : {}),
    token: req.newToken ?? crypto.randomBytes(8).toString('hex'),
    startedAt: now.toISOString(), expiresAt: end.toISOString(),
  };
  // A renewal UPDATES the record it renews (audit H1): the attached pid and scope, the kind, the note and any field a
  // newer checkout added all survive; only what the caller restates changes. A rotation or a new holder starts fresh.
  const heavy = renewed
    ? {
      ...cur, expiresAt: end.toISOString(), ...(req.repo !== undefined ? { repo: req.repo } : {}),
      ...(req.kind !== undefined ? { kind } : {}), ...(req.note !== undefined ? { note: req.note } : {}),
      ...(req.pid !== undefined ? { pid: req.pid, scope: probe.scope } : {}),
    }
    : fresh;
  let next = pruneWindows({ ...base, heavy }, now);
  if (event) next = appendEvent(next, event);
  const served = (base.waiters ?? []).find((w) => w.repoKey === req.identity.repoKey);
  // Only a FRESH grant serves the repo's wait: a renewal or rotation grants nothing new, so a sibling job's wait stays open (D11).
  if (served && basis !== 'same-job') next = endWait(next, served.repoKey, 'served', now, byOf(req));
  if (basis !== 'same-job' && basis !== 'gap') {
    if (turnActive(base, req.identity.repoKey, now)) { const { lastReleasedAt, ...t } = next.turn; next = { ...next, turn: t }; } else next = startTurn(next, req, now);
  }
  next = appendJournal(next, jentry(now, 'acquired', req, {
    mode: event ? 'taken-over' : renewed ? 'renewed' : rotated ? 'rotated' : 'granted', basis,
    job: { kind: heavy.kind, forMin, until: heavy.expiresAt }, ...(served ? { episode: episodeOf(served) } : {}),
  }));
  next = settleQueue(next, now, probe);
  return { ok: true, lease: next, heavy, renewed, rotated, basis, ...(event ? { event } : {}) };
}

/** `attach --pid`: the holder records the long-lived job's pid after launching it. */
export function decideAttach(lease, req, now, probe = defaultProbe()) {
  if (!Number.isInteger(req.pid) || req.pid <= 0) return refuse('bad-request', '--pid must be a positive whole number');
  const cur = lease.heavy;
  if (!cur) return refuse('free', 'nothing is held, so there is nothing to attach a pid to');
  if (!sameIdentity(cur, req.identity)) return refuse('not-holder', `the slot is held by ${cur.holder} (${cur.repo}), not by this session`);
  if (req.token !== undefined && req.token !== cur.token) return refuse('stale-token', 'the supplied token is not the current one for this slot (a stale fence)');
  if (classifyHeavy(cur, now, probe).state !== 'held') return refuse('expired', 'the lease has expired; acquire it again before attaching a pid');
  return { ok: true, lease: { ...lease, heavy: { ...cur, pid: req.pid, scope: probe.scope } }, heavy: { ...cur, pid: req.pid, scope: probe.scope } };
}

/** The one sentence every surface (CLI, `lease run`, sync:pr) prints when `--end-turn` was downgraded (D9). */
export const turnKeptText = (turnKept, repo, cmdName = 'fleet') => `--end-turn not applied: ${repo} has a job waiting since ${hhmmOf(new Date(turnKept.since))}, so the turn stays with ${repo} for the between-jobs gap; to hand it over anyway, run \`${cmdName} lease wait --cancel\` first`;

/** `release`: the holder frees the slot; `--force --reason` frees an EXPIRED slot a person has judged gone. */
export function decideRelease(lease, req, now, probe = defaultProbe()) {
  const badId = badIdentity(req);
  if (badId) return badId;
  const base = settleQueue(lease, now, probe);
  const keep = (r) => (base === lease ? r : { ...r, lease: base });
  const cur = base.heavy;
  if (req.force && (typeof req.reason !== 'string' || req.reason.trim() === '' || !checkNote(req.reason))) {
    return refuse('bad-request', `--force needs --reason (at most ${LIMITS.noteMax} characters, no control characters)`);
  }
  // D9: `--end-turn` is a statement about the CALLER ("I have nothing further ready"), but it acts on the REPO's turn. When the
  // releasing repo has its own waiter entry in the SETTLED lease, another job of the repo asked after the releaser's grant and is
  // waiting, so the turn is kept (a plain release) and the result says so. Never a refusal: a refused release would strand the slot.
  const ownTurn = base.turn && base.turn.repoKey === req.identity.repoKey;
  const sameRepoWaiter = ownTurn && req.endTurn && !req.force ? (base.waiters ?? []).find((w) => w.repoKey === req.identity.repoKey) : undefined;
  const turnKept = sameRepoWaiter ? { reason: 'same-repo-waiting', since: sameRepoWaiter.since } : undefined;
  if (!cur) {
    // A FREE slot does not make `--end-turn` a no-op: the repo's turn is between jobs, and yielding it is the only way a waiting
    // repo gets in before the turn times out (2026-10-19: a free slot kept another repo refused for ~55 minutes).
    if (req.endTurn && !req.force && ownTurn && !turnKept) {
      return { ok: true, lease: settleQueue(endTurn(base, 'yield', now, byOf(req)), now, probe), released: null, already: true, turnYielded: true };
    }
    return { ok: true, lease: base, released: null, already: true, ...(turnKept ? { turnKept } : {}) };
  }
  const mine = sameIdentity(cur, req.identity);
  const releasedEntry = (forced) => jentry(now, 'released', req, { forced, job: { kind: cur.kind, until: cur.expiresAt }, ...(req.endTurn ? { endTurn: true } : {}), ...(turnKept ? { turnKept: turnKept.reason } : {}) });
  const freed = { heavy: null, slotFreedAt: now.toISOString() };
  if (mine) {
    if (req.token !== undefined && req.token !== cur.token) return keep(refuse('stale-token', 'the supplied token is not the current one for this slot (a stale fence)'));
    let next = appendJournal({ ...base, ...freed }, releasedEntry(false));
    // The repo's turn survives the release for the between-jobs gap (its batch), unless it yields the turn outright.
    if (next.turn && next.turn.repoKey === req.identity.repoKey) {
      next = req.endTurn && !turnKept ? endTurn(next, 'yield', now, byOf(req)) : { ...next, turn: { ...next.turn, lastReleasedAt: now.toISOString() } };
    }
    return { ok: true, lease: settleQueue(next, now, probe), released: cur, ...(turnKept ? { turnKept } : {}) };
  }
  if (!req.force) return keep(refuse('not-holder', `the slot is held by ${cur.holder} (${cur.repo}); only the holder releases it (or --force --reason once it has expired)`));
  const cls = classifyHeavy(cur, now, probe);
  if (cls.state === 'held') return keep(refuse('live', `the lease of ${cur.holder} (${cur.repo}) has not expired (until ${cur.expiresAt}); a live lease is never forced`));
  const ev = { at: now.toISOString(), kind: 'forced-release', by: `${req.identity.holder}@${req.repo}`, reason: clip(`${req.reason.trim()} [${cls.verdict}: ${cls.reason}]`) };
  return { ok: true, lease: settleQueue(appendJournal(appendEvent({ ...base, ...freed }, ev), releasedEntry(true)), now, probe), released: cur, event: ev };
}

/**
 * `release` that hands the slot to a CI window in ONE write (plan D7): the holder frees the slot and the consumer's PR CI is
 * recorded as its window `[now, now + ciWindowMin)`, so nothing can interleave between "CI covered" and "slot freed". Token and
 * identity rules are `decideRelease`'s. The window is announced as reality: when the repo's turn is no longer active and another
 * repo waits it carries `overTurn` naming that repo (and, like every override, starts no turn). A full window table never
 * blocks the release: the slot is freed and `windowRefused` says why there is no window.
 */
export function decideReleaseToCiWindow(lease, req, now, probe = defaultProbe()) {
  const minutes = req.ciWindowMin;
  const maxMin = Math.floor(LIMITS.maxWindowMs / MIN);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxMin) return refuse('bad-request', `--ci-window must be a whole number of minutes from 1 to ${maxMin}`);
  if (!checkNote(req.note)) return refuse('bad-request', `--note must be at most ${LIMITS.noteMax} characters with no control characters`);
  // D13: the window may belong to another repo than the one releasing (sync:pr leases as the SOURCE repo, but the CI it starts runs
  // on the TARGET's runner). The owner is explicit; by default it is the releasing repo, as before.
  const owner = req.windowRepo ?? { repoKey: req.identity.repoKey, repo: req.repo };
  if (req.windowRepo !== undefined && !(typeof owner.repoKey === 'string' && /^[0-9a-f]{12}$/.test(owner.repoKey) && typeof owner.repo === 'string' && owner.repo.length >= 1 && owner.repo.length <= 80)) {
    return refuse('bad-request', 'windowRepo must be {repoKey: 12 lowercase hex characters, repo: a label of 1 to 80 characters}');
  }
  const before = settleQueue(lease, now, probe);
  const rel = decideRelease(lease, { ...req, force: false }, now, probe);
  if (!rel.ok || rel.already) return rel.ok ? { ...rel, window: null } : rel;
  const pruned = pruneWindows(rel.lease, now);
  const repoKey = req.identity.repoKey;
  const done = (extra = {}) => ({ ok: true, released: rel.released, window: null, ...(rel.turnKept ? { turnKept: rel.turnKept } : {}), ...extra, lease: settleQueue(extra.lease ?? rel.lease, now, probe) });
  if (pruned.windows.length >= LIMITS.maxWindows) return done({ windowRefused: `there are already ${LIMITS.maxWindows} windows on this machine` });
  if (pruned.windows.filter((w) => w.repoKey === owner.repoKey).length >= LIMITS.maxWindowsPerRepo) return done({ windowRefused: `this repo already has ${LIMITS.maxWindowsPerRepo} windows` });
  const id = allocWindowId(pruned.windows, now, req.newId);
  if (id === null) return done({ windowRefused: 'could not allocate a unique window id' });
  const waiting = (before.waiters ?? []).filter((w) => w.repoKey !== repoKey).sort((a, b) => ms(a.since) - ms(b.since))[0];
  const overTurn = waiting && !turnActive(before, repoKey, now) ? { repo: waiting.repo } : undefined;
  const window = {
    id, repoKey: owner.repoKey, repo: owner.repo, kind: 'ci', from: now.toISOString(), until: new Date(now.getTime() + minutes * MIN).toISOString(),
    ...(req.note !== undefined ? { note: req.note } : {}),
  };
  const next = appendJournal({ ...pruned, windows: [...pruned.windows, window] }, jentry(now, 'announced', req, { window: { id, kind: 'ci', repo: owner.repo, from: window.from, until: window.until }, releasedJob: true, ...(overTurn ? { overTurn } : {}) }));
  return done({ lease: next, window, ...(overTurn ? { overTurn } : {}) });
}

// ── Windows ─────────────────────────────────────────────────────────────────

const stamp = (d) => d.toISOString().replace(/\D/g, '').slice(0, 14);

/** A window id unused in `windows`: `w-<stamp>-<4 hex>`, `preferred` first (tests pin it). Null after 16 collisions. */
function allocWindowId(windows, now, preferred) {
  const taken = new Set(windows.map((x) => x.id));
  for (let i = 0; i < 16; i += 1) {
    const cand = `w-${stamp(now)}-${(i === 0 && preferred ? preferred : crypto.randomBytes(2).toString('hex'))}`;
    if (!taken.has(cand)) return cand;
  }
  return null;
}

/** `announce`: record a quiet/CI window for THIS repo. */
export function decideAnnounce(lease, req, now, probe = defaultProbe()) {
  const badId = badIdentity(req);
  if (badId) return badId;
  if (!WINDOW_KINDS.includes(req.kind)) return refuse('bad-request', `--kind must be one of ${WINDOW_KINDS.join(', ')}`);
  if (!checkNote(req.note)) return refuse('bad-request', `--note must be at most ${LIMITS.noteMax} characters with no control characters`);
  const from = req.from === undefined ? now : parseWhen(req.from, now);
  const until = parseWhen(req.until, now);
  if (!from) return refuse('bad-request', '--from must be an ISO UTC time ending in Z, or +<N>m');
  if (!until) return refuse('bad-request', '--until must be an ISO UTC time ending in Z, or +<N>m');
  if (from.getTime() >= until.getTime()) return refuse('bad-request', '--from must be before --until');
  if (until.getTime() - from.getTime() > LIMITS.maxWindowMs) return refuse('limit', 'a window is at most 24 hours long');
  if (until.getTime() - now.getTime() > LIMITS.maxHorizonMs) return refuse('limit', 'a window must end within 14 days');
  const base = settleQueue(lease, now, probe);
  const refusedWith = (code, reason) => ({ ...refuse(code, reason), lease: journalRefusal(base, req, 'announce', code, now, { window: { kind: req.kind, from: from.toISOString(), until: until.toISOString() } }) });
  const pruned = pruneWindows(base, now);
  if (pruned.windows.length >= LIMITS.maxWindows) return refusedWith('limit', `there are already ${LIMITS.maxWindows} windows on this machine`);
  if (pruned.windows.filter((w) => w.repoKey === req.identity.repoKey).length >= LIMITS.maxWindowsPerRepo) {
    return refusedWith('limit', `this repo already has ${LIMITS.maxWindowsPerRepo} windows`);
  }
  // A window over a slot ANOTHER repo holds is the 2026-10-14 08:06Z race: acquire refuses a slot into a window, so announce
  // must refuse a window over a slot. An expired slot whose job may still run (pid alive or unverifiable) still counts, with
  // no end. `--over-held` records a window that is ALREADY running (a dispatched CI cannot be un-dispatched), acknowledged.
  const h = pruned.heavy;
  let overHeld;
  if (h && h.repoKey !== req.identity.repoKey) {
    const cls = classifyHeavy(h, now, probe);
    const open = cls.state === 'expired' && cls.verdict !== 'pid-dead';
    if (cls.state === 'held' || open) {
      const slotEnd = open ? Infinity : ms(h.expiresAt);
      if (from.getTime() < slotEnd && until.getTime() > ms(h.startedAt)) {
        if (!req.overHeld) {
          const ends = open ? `expired at ${hhmmOf(new Date(h.expiresAt))} but its job may still run (${cls.reason})` : `until ${hhmmOf(new Date(h.expiresAt))}`;
          return refusedWith('held', `the heavy slot is held by ${h.holder} (${h.repo}) for ${h.kind} ${ends}; announce --from ${h.expiresAt} to start after it, or pass --over-held to record a window that is already running over it`);
        }
        overHeld = { holder: h.holder, repoKey: h.repoKey, repo: h.repo, until: h.expiresAt };
      }
    }
  }
  // The turn rule: a window starting within the turn length is heavy time the repo is claiming NOW, so it answers to the same
  // queue as an acquire. A window further ahead is a commitment made before the waiters existed and is not checked.
  const waitingNow = (pruned.waiters ?? []).length > 0;
  const withinTurn = waitingNow && from.getTime() < now.getTime() + turnMinOf(pruned) * MIN && until.getTime() > now.getTime();
  let overTurn;
  if (withinTurn) {
    const tr = turnRule(pruned, req, now, probe);
    if (!tr.ok) {
      if (!req.overTurn) return refusedWith('turn', `${tr.reason}; announce --from a later time, or pass --over-turn to record a window that is already running`);
      overTurn = { repo: tr.first };
    }
  }
  const id = allocWindowId(pruned.windows, now, req.newId);
  if (id === null) return refuse('limit', 'could not allocate a unique window id; retry');
  const win = {
    id,
    repoKey: req.identity.repoKey, repo: req.repo, kind: req.kind, from: from.toISOString(), until: until.toISOString(),
    ...(req.note !== undefined ? { note: req.note } : {}),
    ...(overHeld ? { overHeld } : {}),
  };
  let next = { ...pruned, windows: [...pruned.windows, win] };
  // --over-turn records a window that is ALREADY running; it is an acknowledged overrun, not a new entitlement, so it neither
  // starts the overrider's turn nor ends the incumbent's (Gemini G1).
  if (withinTurn && !overTurn && !turnActive(pruned, req.identity.repoKey, now)) next = startTurn(next, req, now);
  // A window that starts now is the repo's own use of the machine: its wait (if any) is served.
  if (from.getTime() <= now.getTime() && now.getTime() < until.getTime()) next = endWait(next, req.identity.repoKey, 'served', now, byOf(req));
  next = appendJournal(next, jentry(now, 'announced', req, { window: { id, kind: req.kind, repo: req.repo, from: win.from, until: win.until }, ...(overHeld ? { overHeld } : {}), ...(overTurn ? { overTurn } : {}) }));
  return { ok: true, lease: settleQueue(next, now, probe), window: win, ...(overHeld ? { overHeld } : {}), ...(overTurn ? { overTurn } : {}) };
}

/** `announce --clear-window`: any session may clear any window (a coordinator who must proceed); other repos' are recorded. */
export function decideClearWindow(lease, req, now, probe = defaultProbe()) {
  const badId = badIdentity(req);
  if (badId) return badId;
  const base = settleQueue(lease, now, probe);
  const w = base.windows.find((x) => x.id === req.id);
  if (!w) {
    const r = refuse('no-such-window', `no window ${JSON.stringify(req.id)}`);
    return base === lease ? r : { ...r, lease: base };
  }
  let next = { ...base, windows: base.windows.filter((x) => x !== w) };
  const ownRepo = w.repoKey === req.identity.repoKey;
  let event;
  // The `events` ring still records only other-repo clears (what older checkouts read); the journal records every clear.
  if (!ownRepo) {
    event = { at: now.toISOString(), kind: 'window-cleared', by: `${req.identity.holder}@${req.repo}`, reason: clip(`cleared ${w.id} (${w.kind}, ${w.repo}, ${w.from} to ${w.until})`) };
    next = appendEvent(next, event);
  }
  next = appendJournal(next, jentry(now, 'window-cleared', req, { window: { id: w.id, kind: w.kind, repo: w.repo, from: w.from, until: w.until }, ownRepo }));
  return { ok: true, lease: settleQueue(next, now, probe), window: w, ...(event ? { event } : {}) };
}

// ── Waiting (plan D3b) ──────────────────────────────────────────────────────

/**
 * `wait`: this repo says it wants the slot (a refused acquire says it too, implicitly). Recorded and visible; in this
 * release it has no effect on who is granted the slot. `--cancel` withdraws THIS repo's entry only.
 */
export function decideWait(lease, req, now, probe = defaultProbe()) {
  const bad = badIdentity(req);
  if (bad) return bad;
  const forMin = req.forMin ?? LIMITS.defaultWaitMin;
  if (!Number.isInteger(forMin) || forMin < 1 || forMin > LIMITS.maxForMin) return refuse('bad-request', `--for must be a whole number of minutes from 1 to ${LIMITS.maxForMin}`);
  if (!checkNote(req.note)) return refuse('bad-request', `--note must be at most ${LIMITS.noteMax} characters with no control characters`);
  const base = settleQueue(lease, now, probe);
  const cur = (base.waiters ?? []).find((w) => w.repoKey === req.identity.repoKey);
  if (req.cancel) {
    if (!cur) return { ok: true, lease: base, cancelled: false };
    return { ok: true, lease: settleQueue(endWait(base, req.identity.repoKey, 'cancelled', now, byOf(req)), now, probe), cancelled: true, waiter: cur };
  }
  const o = openWait(base, req, { forMin, opener: 'wait', now });
  if (!o.queued) {
    return { ...refuse('limit', `${LIMITS.maxWaiters} repos are already waiting; this one was not queued`), lease: journalRefusal(base, req, 'wait', 'limit', now) };
  }
  return { ok: true, lease: settleQueue(o.lease, now, probe), waiter: settleQueue(o.lease, now, probe).waiters.find((w) => w.repoKey === req.identity.repoKey), opened: o.opened };
}

// ── Granted gaps and the turn length (plan D5, D6) ──────────────────────────

/**
 * `grant`: the owner of a window lets a named repo (or anyone, with no `--to`) take the slot inside it, so the window it
 * announced does not refuse the repo it granted. Only the owner may; the gap must lie inside the window; at most
 * `maxGapsPerWindow`. A label resolves to a repoKey among repos the lease has seen - none and ambiguous are refused.
 */
export function decideGrant(lease, req, now, probe = defaultProbe()) {
  const badId = badIdentity(req);
  if (badId) return badId;
  const from = parseWhen(req.from, now);
  const until = parseWhen(req.until, now);
  if (!from) return refuse('bad-request', '--from must be an ISO UTC time ending in Z, or +<N>m');
  if (!until) return refuse('bad-request', '--until must be an ISO UTC time ending in Z, or +<N>m');
  if (from.getTime() >= until.getTime()) return refuse('bad-request', '--from must be before --until');
  if (req.to !== undefined && !(typeof req.to === 'string' && req.to.length >= 1 && req.to.length <= 80)) return refuse('bad-request', '--to must be a repo label of 1 to 80 characters');
  const base = settleQueue(lease, now, probe);
  const keep = (r) => (base === lease ? r : { ...r, lease: base });
  const w = base.windows.find((x) => x.id === req.id);
  if (!w) return keep(refuse('no-such-window', `no window ${JSON.stringify(req.id)}`));
  if (w.repoKey !== req.identity.repoKey) return keep(refuse('not-owner', `window ${w.id} belongs to ${w.repo}; only its owner grants a gap in it (any session may still clear it)`));
  if (from.getTime() < ms(w.from) || until.getTime() > ms(w.until)) return keep(refuse('outside-window', `a gap must lie inside its window (${w.from} to ${w.until})`));
  if ((w.gaps ?? []).length >= LIMITS.maxGapsPerWindow) return keep(refuse('limit', `window ${w.id} already has ${LIMITS.maxGapsPerWindow} gaps`));
  let target;
  if (req.to !== undefined) {
    const r = resolveRepoLabel(base, req.to);
    if (r.error === 'none') return keep(refuse('no-such-repo', `${JSON.stringify(req.to)} has not used the lease on this machine, so it cannot be named; it can \`lease wait\` first, or grant an open gap (no --to)`));
    if (r.error === 'ambiguous') return keep(refuse('ambiguous-repo', `more than one repo on this machine is labelled ${JSON.stringify(req.to)}; a label is display-only, so grant an open gap or ask the other repo to \`lease wait\` under a distinct checkout name`));
    target = r;
  }
  const gap = { from: from.toISOString(), until: until.toISOString(), ...(target ? { toRepoKey: target.key, toRepo: target.repo } : {}), grantedAt: now.toISOString(), by: byOf(req) };
  const window = { ...w, gaps: [...(w.gaps ?? []), gap] };
  let next = { ...base, windows: base.windows.map((x) => (x === w ? window : x)) };
  next = appendJournal(next, jentry(now, 'gap-granted', req, { window: { id: w.id, kind: w.kind, repo: w.repo }, gap }));
  return { ok: true, lease: settleQueue(next, now, probe), window, gap };
}

/** `turn --minutes <15-240>` sets this machine's turn length; `--clear` restores the default. Machine config, not journalled (like `peak`). */
export function decideTurnConfig(lease, req) {
  if (req.clear) { const { turnMin, ...rest } = lease; return { ok: true, lease: rest }; }
  const m = req.minutes;
  if (!Number.isInteger(m) || m < LIMITS.minTurnMin || m > LIMITS.maxTurnMin) return refuse('bad-request', `--minutes must be a whole number from ${LIMITS.minTurnMin} to ${LIMITS.maxTurnMin}`);
  return { ok: true, lease: { ...lease, turnMin: m } };
}

/**
 * Slot-wait time from the journal, for doctor's fit check. Episodes pair a `waiting` with its `wait-ended` by id; an
 * episode still open is `open`, one whose `waiting` fell off the ring is `truncated` (never paired with an unrelated
 * acquire), and cancelled / expired / lapsed episodes keep their reason instead of reading as served. An empty journal
 * is `measured:false`: nothing was recorded, which is not the same as nobody waiting.
 * @returns {{measured: boolean, coverageFrom?: string, waits: object[]}}
 */
export function measureSlotWaits(journal, now) {
  const j = journal ?? [];
  if (!j.length) return { measured: false, waits: [] };
  const opened = new Map();
  const waits = [];
  for (const e of j) {
    if (e.kind === 'waiting') opened.set(e.episode, e);
    else if (e.kind === 'wait-ended') {
      const o = opened.get(e.episode);
      if (o) {
        opened.delete(e.episode);
        waits.push({ episode: e.episode, repoKey: o.repoKey, repo: o.by.split('@').slice(1).join('@'), from: o.at, until: e.at, waitedMs: ms(e.at) - ms(o.at), reason: e.reason, refusals: e.refusals });
      } else {
        waits.push({ episode: e.episode, repoKey: e.repoKey, until: e.at, reason: e.reason, refusals: e.refusals, truncated: true });
      }
    }
  }
  for (const o of opened.values()) waits.push({ episode: o.episode, repoKey: o.repoKey, repo: o.by.split('@').slice(1).join('@'), from: o.at, open: true, waitedMs: now.getTime() - ms(o.at) });
  return { measured: true, coverageFrom: j[0].at, waits };
}

// ── Peak hours ──────────────────────────────────────────────────────────────

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** A range with no `days` is a WEEKDAY range: the user's expensive-token window does not run at weekends. */
export const DEFAULT_PEAK_DAYS = Object.freeze([1, 2, 3, 4, 5]);
const daysOf = (r) => (Array.isArray(r.days) && r.days.length ? r.days : DEFAULT_PEAK_DAYS);

/** `"mon-fri"`, `"sat+sun"`, `"mon-wed+fri"`, `"daily"` → sorted day numbers (0 = Sunday), or null when a token is not a day. */
function parseDays(text) {
  if (text === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  const set = new Set();
  for (const tok of text.split('+')) {
    const m = /^([a-z]{3})(?:-([a-z]{3}))?$/.exec(tok);
    if (!m) return null;
    const a = DAY_NAMES.indexOf(m[1]);
    const b = m[2] === undefined ? a : DAY_NAMES.indexOf(m[2]);
    if (a < 0 || b < 0) return null;
    for (let d = a; ; d = (d + 1) % 7) { set.add(d); if (d === b) break; } // a range may wrap the week: fri-mon
  }
  return [...set].sort((x, y) => x - y);
}

/**
 * The day set as parse accepts it back: a run of consecutive days is `mon-fri`, otherwise `mon+wed`; all seven is `daily`.
 * The week reads Monday first (`sat+sun`, never `sun+sat`), so a run never wraps the week end.
 */
export function formatPeakDays(days) {
  const pos = (d) => (d + 6) % 7; // Monday = 0 ... Sunday = 6
  const ds = [...new Set(days)].sort((x, y) => pos(x) - pos(y));
  if (ds.length === 7) return 'daily';
  const runs = [];
  for (const d of ds) {
    const last = runs[runs.length - 1];
    if (last && pos(d) === pos(last[1]) + 1) last[1] = d; else runs.push([d, d]);
  }
  return runs.map(([a, b]) => (a === b ? DAY_NAMES[a] : pos(b) === pos(a) + 1 ? `${DAY_NAMES[a]}+${DAY_NAMES[b]}` : `${DAY_NAMES[a]}-${DAY_NAMES[b]}`)).join('+');
}

/** One range as `HH:MM-HH:MM@days`, the `lease peak --hours` spelling. */
export const formatPeakRange = (r) => `${r.from}-${r.to}@${formatPeakDays(daysOf(r))}`;

/**
 * `"09:00-12:00,14:00-17:00@mon-fri"` → `[{from,to,days?}]`; `from > to` means across midnight. `@days` is optional and the
 * range then runs Monday to Friday (`days` is left off the record, so a range stored before days existed reads the same way).
 * A range that crosses midnight belongs to the day it STARTS on. Errors name the bad part.
 */
export function parsePeakHours(text) {
  const parts = String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, reason: '--hours needs at least one HH:MM-HH:MM range' };
  if (parts.length > LIMITS.maxPeak) return { ok: false, reason: `at most ${LIMITS.maxPeak} peak ranges` };
  const out = [];
  for (const p of parts) {
    const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})(?:@(.+))?$/.exec(p);
    if (!m || !hhmm.safeParse(m[1]).success || !hhmm.safeParse(m[2]).success || m[1] === m[2]) return { ok: false, reason: `${JSON.stringify(p)} is not a range of two different HH:MM times (optionally @mon-fri, @sat+sun or @daily)` };
    const days = m[3] === undefined ? undefined : parseDays(m[3].toLowerCase());
    if (m[3] !== undefined && !days) return { ok: false, reason: `${JSON.stringify(p)} has days ${JSON.stringify(m[3])}: use three-letter day names like mon-fri, sat+sun, mon+wed+fri, or daily` };
    out.push({ from: m[1], to: m[2], ...(days && formatPeakDays(days) !== formatPeakDays(DEFAULT_PEAK_DAYS) ? { days } : {}) });
  }
  return { ok: true, peakHours: out };
}

const minutesOf = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

/** Is `now` (machine-local time) inside a peak range on one of its days, and which range starts next? */
export function peakState(peakHours, now) {
  const cur = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const inRange = (r) => {
    const a = minutesOf(r.from); const b = minutesOf(r.to); const days = daysOf(r);
    if (a < b) return cur >= a && cur < b && days.includes(today);
    if (cur >= a) return days.includes(today); // the evening part: the range's own day
    return cur < b && days.includes((today + 6) % 7); // the part after midnight: it started yesterday
  };
  const active = peakHours.find(inRange);
  if (active) return { now: true, range: active };
  // Minutes until a range next starts: today's start if still ahead, else the nearest of the next 7 days it runs on.
  const untilStart = (r) => {
    const a = minutesOf(r.from); const days = daysOf(r);
    for (let k = 0; k <= 7; k++) {
      const wait = k * 1440 + a - cur;
      if (wait > 0 && days.includes((today + k) % 7)) return wait;
    }
    return Infinity;
  };
  const upcoming = [...peakHours].sort((x, y) => untilStart(x) - untilStart(y))[0];
  return { now: false, ...(upcoming && untilStart(upcoming) !== Infinity ? { next: upcoming } : {}) };
}

// ── Recovery of an unreadable file ──────────────────────────────────────────

/**
 * Recover a MALFORMED lease: copy its bytes aside first (a failed copy aborts and leaves the original), then publish
 * a fresh valid record over it in one atomic rename, so an unlocked reader sees the corrupt file or the fresh one,
 * never none. A `newer-version` file and a symbolic link are NOT recovered.
 */
export function recoverUnreadable(dir, read, { by, reason, now }) {
  if (read.state !== 'unreadable' || read.raw === undefined) {
    return refuse('not-recoverable', read.state === 'newer-version' ? 'the file was written by a newer fleet; update this checkout instead' : (read.reason ?? 'nothing to recover'));
  }
  const { file } = leasePaths(dir);
  const aside = `${file}.corrupt-${stamp(now)}`;
  try { fs.copyFileSync(file, aside, fs.constants.COPYFILE_EXCL); } catch (e) { return refuse('recover-failed', `could not keep a copy of the unreadable file (${e.message}); it was left untouched`); }
  const ev = { at: now.toISOString(), kind: 'corrupt-recovered', by, reason: clip(`${reason}; ${read.reason}; a copy is at ${path.basename(aside)}`) };
  return { ok: true, lease: appendEvent(emptyLease(), ev), aside, event: ev };
}

// ── Reading it back ─────────────────────────────────────────────────────────

/** Structured view for `status`/`next`/`--json`. Windows already ended are left out. */
export function summarise(read, now, probe = defaultProbe()) {
  if (read.state === 'unreadable' || read.state === 'newer-version') return { state: read.state, measured: false, reason: read.reason };
  const lease = settleQueue(read.lease, now, probe); // the settled view, read-only: an ended turn is not shown as live
  const heavy = classifyHeavy(lease.heavy, now, probe);
  return {
    state: read.state, measured: true, heavy, holder: lease.heavy,
    windows: lease.windows.filter((w) => ms(w.until) > now.getTime()),
    peak: peakState(lease.peakHours, now), peakHours: lease.peakHours,
    events: lease.events, waiters: lease.waiters ?? [], journal: lease.journal ?? [], turn: lease.turn ?? null, turnMin: lease.turnMin ?? null,
  };
}

const inMin = (iso0, now) => { const m = Math.round((ms(iso0) - now.getTime()) / MIN); return m >= 0 ? `in ${m}m` : `${-m}m ago`; };

const heavyLine = (s, now, mineKey) => {
  const h = s.holder;
  const who = h ? `${h.holder} (${h.repo})${mineKey && h.repoKey === mineKey ? ' [this repo]' : ''}` : '';
  if (s.heavy.state === 'free') return 'heavy slot: FREE';
  if (s.heavy.state === 'held') return `heavy slot: HELD by ${who} for ${h.kind} until ${hhmmOf(new Date(h.expiresAt))} (${inMin(h.expiresAt, now)})${h.note ? ` — ${h.note}` : ''}`;
  return `heavy slot: EXPIRED at ${hhmmOf(new Date(h.expiresAt))} (${inMin(h.expiresAt, now)}), held by ${who} — ${s.heavy.verdict}: ${s.heavy.reason}`;
};

const describeEntry = (e) => {
  const t = (iso) => hhmmOf(new Date(iso));
  const job = e.job ? ` ${e.job.kind ?? ''}${e.job.forMin ? ` ${e.job.forMin}m` : ''}${e.job.until ? ` until ${t(e.job.until)}` : ''}`.replace(/ +/g, ' ') : '';
  switch (e.kind) {
    case 'acquired': return `acquired the slot (${e.mode}${e.basis && e.basis !== 'same-job' ? `, ${e.basis}` : ''})${job}`;
    case 'released': return `released the slot${e.forced ? ' (forced)' : ''}${job}`;
    case 'announced': return `announced ${e.window.kind} window ${e.window.id} ${t(e.window.from)}-${t(e.window.until)}${e.overHeld ? ` OVER the slot held by ${e.overHeld.holder} (${e.overHeld.repo})` : ''}`;
    case 'window-cleared': return `cleared window ${e.window.id} of ${e.window.repo}${e.ownRepo ? '' : ' (another repo)'}`;
    case 'refused': return `was refused ${e.refusal?.op} (${e.refusal?.code})${e.n > 1 ? ` ${e.n} times, last ${t(e.lastAt)}` : ''}`;
    case 'waiting': return `started waiting (${e.opener}${e.refusal ? `, ${e.refusal.code}` : ''}, wants ${e.job?.forMin}m)`;
    case 'offered': return 'was offered the slot';
    case 'gap-granted': return `granted a gap ${t(e.gap.from)}-${t(e.gap.until)} in window ${e.window.id} to ${e.gap.toRepo ?? 'anyone'}`;
    case 'turn-started': return `turn started until ${t(e.turn.endsAt)}`;
    case 'turn-ended': return `turn of ${e.turn.repo} ended (${e.reason})`;
    case 'wait-ended': return `stopped waiting: ${e.reason} after ${e.refusals} refusal${e.refusals === 1 ? '' : 's'}`;
    default: return e.kind;
  }
};

/** The lines of `fleet lease log`: the journal oldest first, newest `limit` entries. */
export function renderLog(journal, { limit = 50 } = {}) {
  const j = journal ?? [];
  if (!j.length) return ['journal: empty (nothing recorded yet; leases written before the journal existed have no history)'];
  const shown = j.slice(-limit);
  return [`journal (${shown.length} of ${j.length}):`, ...shown.map((e) => `  ${e.at.slice(0, 19)}Z  ${e.by}  ${describeEntry(e)}`)];
}

/** The lines of `fleet lease status`. */
export function renderStatus(s, { dir, now, repoKey, cmd = 'fleet' }) {
  const head = `machine lease (${dir}):`;
  if (!s.measured) return [head, `  UNMEASURED: ${s.reason}`];
  const lines = [head, `  ${heavyLine(s, now, repoKey)}`];
  if (s.windows.length) {
    for (const w of s.windows) lines.push(`  window ${w.id}: ${w.kind} for ${w.repo}, ${hhmmOf(new Date(w.from))} to ${hhmmOf(new Date(w.until))}${w.note ? ` — ${w.note}` : ''}`);
  } else lines.push('  windows: none announced');
  if (s.turn) lines.push(`  turn: ${s.turn.repo} until ${hhmmOf(new Date(s.turn.endsAt))}${s.turn.lastReleasedAt ? ` (between jobs since ${hhmmOf(new Date(s.turn.lastReleasedAt))})` : ''}`);
  if (s.turnMin) lines.push(`  turn length: ${s.turnMin}m (set for this machine)`);
  for (const w of s.waiters) lines.push(`  waiting: ${w.repo} since ${hhmmOf(new Date(w.since))} (${w.refusals} refusal${w.refusals === 1 ? '' : 's'}, wants ${w.forMin}m)`);
  if (s.peakHours.length) {
    const r = formatPeakRange;
    lines.push(`  peak hours (machine-local): ${s.peakHours.map(r).join(', ')} — ${s.peak.now ? `PEAK NOW (${r(s.peak.range)})` : s.peak.next ? `next ${r(s.peak.next)}` : 'none upcoming'}`);
  } else lines.push('  peak hours: none set');
  if (s.journal.length) lines.push(`  journal: ${s.journal.length} entries since ${hhmmOf(new Date(s.journal[0].at))} (\`${cmd} lease log\`)`);
  return lines;
}

/**
 * The FYI lines `fleet next` adds. Silent when MEASURED and quiet (slot free, nothing announced within 4 hours,
 * not peak); an unreadable file is `unmeasured`, never free.
 */
export function nextLines(read, now, { cmd = 'fleet', repoKey, probe = defaultProbe() } = {}) {
  const s = summarise(read, now, probe);
  const tag = 'FYI for the user/coordinator, not an action for this session:';
  const status = `\`${cmd} lease status\``;
  if (!s.measured) return [`${tag} machine lease unmeasured (${s.reason}) — ${status}`];
  const parts = [];
  if (s.heavy.state !== 'free') parts.push(heavyLine(s, now, repoKey));
  const soon = s.windows.filter((w) => ms(w.from) < now.getTime() + LIMITS.nextHorizonMs);
  for (const w of soon) parts.push(`${w.kind} window for ${w.repo} ${ms(w.from) <= now.getTime() ? 'active' : 'from'} ${hhmmOf(new Date(w.from))} to ${hhmmOf(new Date(w.until))}`);
  if (s.turn && s.waiters.length) parts.push(`turn: ${s.turn.repo} until ${hhmmOf(new Date(s.turn.endsAt))}`);
  for (const w of s.waiters) parts.push(`${w.repo} waiting for the slot since ${hhmmOf(new Date(w.since))}`);
  if (s.peak.now) parts.push('peak-cost hours now');
  return parts.length ? [`${tag} machine lease: ${parts.join('; ')} — ${status}`] : [];
}
