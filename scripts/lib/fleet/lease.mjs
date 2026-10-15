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
  KINDS, LIMITS, MIN, WINDOW_KINDS, appendEvent, appendJournal, badIdentity, byOf, checkNote, classifyHeavy, clip, conflictingWindows, defaultProbe, emptyLease, endWait, episodeOf, hex, hhmm, hhmmOf, iso, jentry, journalRefusal, leasePaths, ms, name, note, openWait, parseWhen, pruneWindows, refuse, sameIdentity, settleQueue,
} from './lease-model.mjs';

// The public surface is unchanged by the split: everything `lease.mjs` exported before still comes from here.
export {
  LEASE_SCHEMA_VERSION, LEASE_FILE, LEASE_LOCK, KINDS, WINDOW_KINDS, EVENT_KINDS, LIMITS, LeaseConfigError, machineDir, repoKeyOf, repoLabel, currentScope, LeaseSchema, emptyLease, leasePaths, readLease, writeLease, transactLease, parseWhen, classifyHeavy, defaultProbe, appendEvent, appendJournal, settleQueue, pruneWindows, conflictingWindows,
} from './lease-model.mjs';

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
  const base = settleQueue(lease, now);
  const keep = (r) => (base === lease ? r : { ...r, lease: base });
  /** A refusal that means "someone else has the slot": this repo is now waiting, unless the list is full. */
  const waitRefusal = (code, reason) => {
    const o = openWait(base, req, { forMin, opener: 'refusal', refusal: { op: 'acquire', code }, now });
    if (!o.queued) return { ...refuse(code, reason), queued: false, queueFull: true, lease: journalRefusal(base, req, 'acquire', code, now, { job: { kind, forMin } }) };
    return { ...refuse(code, reason), queued: true, lease: o.lease };
  };
  const cur = base.heavy;
  const cls = classifyHeavy(cur, now, probe);
  const mine = cur && sameIdentity(cur, req.identity);

  const blocking = conflictingWindows(base, req.identity.repoKey, now, end);
  if (blocking.length) {
    const w = blocking[0];
    return waitRefusal('window', `another repo announced a ${w.kind} window (${w.repo}, ${w.from} to ${w.until}${w.note ? `: ${w.note}` : ''}) that overlaps the requested ${forMin} minutes; shorten --for to end before ${w.from}, or wait`);
  }

  let event;
  if (cur && mine) {
    if (req.token !== undefined && req.token !== cur.token) return keep(refuse('stale-token', 'the supplied token is not the current one for this slot (a stale fence)'));
  } else if (cur) {
    if (cls.state === 'held') return waitRefusal('held', `held by ${cur.holder} (${cur.repo}) for ${cur.kind} until ${cur.expiresAt}`);
    if (cls.verdict === 'pid-alive') return waitRefusal('expired-pid-alive', `the lease of ${cur.holder} (${cur.repo}) expired at ${cur.expiresAt}, but ${cls.reason}; it cannot be granted`);
    if (cls.verdict === 'unverifiable') return waitRefusal('unverifiable', `the lease of ${cur.holder} (${cur.repo}) expired at ${cur.expiresAt} but ${cls.reason}; if a person has confirmed the job is gone: release --force --reason "<why>"`);
    event = { at: now.toISOString(), kind: 'taken-over', by: `${req.identity.holder}@${req.repo}`, reason: clip(`${cur.holder} (${cur.repo}) expired at ${cur.expiresAt}; ${cls.reason}`) };
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
  if (served) next = endWait(next, served.repoKey, 'served', now, byOf(req));
  next = appendJournal(next, jentry(now, 'acquired', req, {
    mode: event ? 'taken-over' : renewed ? 'renewed' : rotated ? 'rotated' : 'granted',
    job: { kind: heavy.kind, forMin, until: heavy.expiresAt }, ...(served ? { episode: episodeOf(served) } : {}),
  }));
  return { ok: true, lease: next, heavy, renewed, rotated, ...(event ? { event } : {}) };
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

/** `release`: the holder frees the slot; `--force --reason` frees an EXPIRED slot a person has judged gone. */
export function decideRelease(lease, req, now, probe = defaultProbe()) {
  const badId = badIdentity(req);
  if (badId) return badId;
  const base = settleQueue(lease, now);
  const keep = (r) => (base === lease ? r : { ...r, lease: base });
  const cur = base.heavy;
  if (req.force && (typeof req.reason !== 'string' || req.reason.trim() === '' || !checkNote(req.reason))) {
    return refuse('bad-request', `--force needs --reason (at most ${LIMITS.noteMax} characters, no control characters)`);
  }
  if (!cur) return { ok: true, lease: base, released: null, already: true };
  const mine = sameIdentity(cur, req.identity);
  const releasedEntry = (forced) => jentry(now, 'released', req, { forced, job: { kind: cur.kind, until: cur.expiresAt } });
  if (mine) {
    if (req.token !== undefined && req.token !== cur.token) return keep(refuse('stale-token', 'the supplied token is not the current one for this slot (a stale fence)'));
    return { ok: true, lease: appendJournal({ ...base, heavy: null }, releasedEntry(false)), released: cur };
  }
  if (!req.force) return keep(refuse('not-holder', `the slot is held by ${cur.holder} (${cur.repo}); only the holder releases it (or --force --reason once it has expired)`));
  const cls = classifyHeavy(cur, now, probe);
  if (cls.state === 'held') return keep(refuse('live', `the lease of ${cur.holder} (${cur.repo}) has not expired (until ${cur.expiresAt}); a live lease is never forced`));
  const ev = { at: now.toISOString(), kind: 'forced-release', by: `${req.identity.holder}@${req.repo}`, reason: clip(`${req.reason.trim()} [${cls.verdict}: ${cls.reason}]`) };
  return { ok: true, lease: appendJournal(appendEvent({ ...base, heavy: null }, ev), releasedEntry(true)), released: cur, event: ev };
}

// ── Windows ─────────────────────────────────────────────────────────────────

const stamp = (d) => d.toISOString().replace(/\D/g, '').slice(0, 14);

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
  const base = settleQueue(lease, now);
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
  const taken = new Set(pruned.windows.map((x) => x.id));
  let id = null;
  for (let i = 0; i < 16 && id === null; i += 1) {
    const cand = `w-${stamp(now)}-${(i === 0 && req.newId ? req.newId : crypto.randomBytes(2).toString('hex'))}`;
    if (!taken.has(cand)) id = cand;
  }
  if (id === null) return refuse('limit', 'could not allocate a unique window id; retry');
  const win = {
    id,
    repoKey: req.identity.repoKey, repo: req.repo, kind: req.kind, from: from.toISOString(), until: until.toISOString(),
    ...(req.note !== undefined ? { note: req.note } : {}),
    ...(overHeld ? { overHeld } : {}),
  };
  let next = { ...pruned, windows: [...pruned.windows, win] };
  // A window that starts now is the repo's own use of the machine: its wait (if any) is served.
  if (from.getTime() <= now.getTime() && now.getTime() < until.getTime()) next = endWait(next, req.identity.repoKey, 'served', now, byOf(req));
  next = appendJournal(next, jentry(now, 'announced', req, { window: { id, kind: req.kind, repo: req.repo, from: win.from, until: win.until }, ...(overHeld ? { overHeld } : {}) }));
  return { ok: true, lease: next, window: win, ...(overHeld ? { overHeld } : {}) };
}

/** `announce --clear-window`: any session may clear any window (a coordinator who must proceed); other repos' are recorded. */
export function decideClearWindow(lease, req, now) {
  const badId = badIdentity(req);
  if (badId) return badId;
  const base = settleQueue(lease, now);
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
  return { ok: true, lease: next, window: w, ...(event ? { event } : {}) };
}

// ── Waiting (plan D3b) ──────────────────────────────────────────────────────

/**
 * `wait`: this repo says it wants the slot (a refused acquire says it too, implicitly). Recorded and visible; in this
 * release it has no effect on who is granted the slot. `--cancel` withdraws THIS repo's entry only.
 */
export function decideWait(lease, req, now) {
  const bad = badIdentity(req);
  if (bad) return bad;
  const forMin = req.forMin ?? LIMITS.defaultWaitMin;
  if (!Number.isInteger(forMin) || forMin < 1 || forMin > LIMITS.maxForMin) return refuse('bad-request', `--for must be a whole number of minutes from 1 to ${LIMITS.maxForMin}`);
  if (!checkNote(req.note)) return refuse('bad-request', `--note must be at most ${LIMITS.noteMax} characters with no control characters`);
  const base = settleQueue(lease, now);
  const cur = (base.waiters ?? []).find((w) => w.repoKey === req.identity.repoKey);
  if (req.cancel) {
    if (!cur) return { ok: true, lease: base, cancelled: false };
    return { ok: true, lease: endWait(base, req.identity.repoKey, 'cancelled', now, byOf(req)), cancelled: true, waiter: cur };
  }
  const o = openWait(base, req, { forMin, opener: 'wait', now });
  if (!o.queued) {
    return { ...refuse('limit', `${LIMITS.maxWaiters} repos are already waiting; this one was not queued`), lease: journalRefusal(base, req, 'wait', 'limit', now) };
  }
  return { ok: true, lease: o.lease, waiter: o.waiter, opened: o.opened };
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

/** `"09:00-12:00,14:00-17:00"` → `[{from,to}]`; `from > to` means across midnight. Errors name the bad part. */
export function parsePeakHours(text) {
  const parts = String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, reason: '--hours needs at least one HH:MM-HH:MM range' };
  if (parts.length > LIMITS.maxPeak) return { ok: false, reason: `at most ${LIMITS.maxPeak} peak ranges` };
  const out = [];
  for (const p of parts) {
    const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(p);
    if (!m || !hhmm.safeParse(m[1]).success || !hhmm.safeParse(m[2]).success || m[1] === m[2]) return { ok: false, reason: `${JSON.stringify(p)} is not a range of two different HH:MM times` };
    out.push({ from: m[1], to: m[2] });
  }
  return { ok: true, peakHours: out };
}

const minutesOf = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

/** Is `now` (machine-local time) inside a peak range, and when is the next one? */
export function peakState(peakHours, now) {
  const cur = now.getHours() * 60 + now.getMinutes();
  const inRange = (r) => { const a = minutesOf(r.from); const b = minutesOf(r.to); return a < b ? cur >= a && cur < b : cur >= a || cur < b; };
  const active = peakHours.find(inRange);
  if (active) return { now: true, range: active };
  const upcoming = [...peakHours].sort((x, y) => ((minutesOf(x.from) - cur + 1440) % 1440) - ((minutesOf(y.from) - cur + 1440) % 1440))[0];
  return { now: false, ...(upcoming ? { next: upcoming } : {}) };
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
  const lease = read.lease;
  const heavy = classifyHeavy(lease.heavy, now, probe);
  return {
    state: read.state, measured: true, heavy, holder: lease.heavy,
    windows: lease.windows.filter((w) => ms(w.until) > now.getTime()),
    peak: peakState(lease.peakHours, now), peakHours: lease.peakHours,
    events: lease.events, waiters: lease.waiters ?? [], journal: lease.journal ?? [],
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
    case 'acquired': return `acquired the slot (${e.mode})${job}`;
    case 'released': return `released the slot${e.forced ? ' (forced)' : ''}${job}`;
    case 'announced': return `announced ${e.window.kind} window ${e.window.id} ${t(e.window.from)}-${t(e.window.until)}${e.overHeld ? ` OVER the slot held by ${e.overHeld.holder} (${e.overHeld.repo})` : ''}`;
    case 'window-cleared': return `cleared window ${e.window.id} of ${e.window.repo}${e.ownRepo ? '' : ' (another repo)'}`;
    case 'refused': return `was refused ${e.refusal?.op} (${e.refusal?.code})${e.n > 1 ? ` ${e.n} times, last ${t(e.lastAt)}` : ''}`;
    case 'waiting': return `started waiting (${e.opener}${e.refusal ? `, ${e.refusal.code}` : ''}, wants ${e.job?.forMin}m)`;
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
  for (const w of s.waiters) lines.push(`  waiting: ${w.repo} since ${hhmmOf(new Date(w.since))} (${w.refusals} refusal${w.refusals === 1 ? '' : 's'}, wants ${w.forMin}m)`);
  if (s.peakHours.length) {
    const r = (x) => `${x.from}-${x.to}`;
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
  for (const w of s.waiters) parts.push(`${w.repo} waiting for the slot since ${hhmmOf(new Date(w.since))}`);
  if (s.peak.now) parts.push('peak-cost hours now');
  return parts.length ? [`${tag} machine lease: ${parts.join('; ')} — ${status}`] : [];
}
