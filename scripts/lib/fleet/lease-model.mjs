/**
 * @fileoverview The machine lease's model: location, record schema, the store, time, heavy-slot classification, and the
 * building blocks of a decision (journal, waiter list, window conflicts). Pure except the store functions. The POLICY
 * (acquire, release, announce, ...) is in `lease.mjs`, which re-exports this module's public surface.
 *
 * Split out of `lease.mjs` when gaps and turns would have taken it past the 1000-line size ratchet (plan
 * docs/plans/fleet-lease-turns-and-journal.md). No behaviour changed in the split.
 *
 * @module scripts/lib/fleet/lease-model
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { isPidAlive, withFileLockSync } from '../file-lock.mjs';

export const LEASE_SCHEMA_VERSION = 1;
export const LEASE_FILE = 'lease.json';
export const LEASE_LOCK = 'lease.lock';
export const KINDS = Object.freeze(['gate', 'test', 'timing', 'maintenance']);
export const WINDOW_KINDS = Object.freeze(['quiet', 'ci']);
export const EVENT_KINDS = Object.freeze(['forced-release', 'taken-over', 'corrupt-recovered', 'window-cleared']);

export const MIN = 60_000;
const HOUR = 60 * MIN;
/** Every limit is an inclusive maximum. */
export const LIMITS = Object.freeze({
  defaultForMin: 30, maxForMin: 180, noteMax: 200,
  maxWindows: 50, maxWindowsPerRepo: 10, maxHorizonMs: 14 * 24 * HOUR, maxWindowMs: 24 * HOUR,
  maxPeak: 8, maxEvents: 20, pruneAfterMs: HOUR,
  /** The journal is a ring like `events`: the newest entries are kept, so a write is never refused for lack of room. */
  maxJournal: 200,
  /** One waiter per repo, at most this many repos; a waiter older than `maxWaitMs` is dropped as expired. */
  maxWaiters: 20, maxWaitMs: 12 * HOUR, defaultWaitMin: 30,
  /** `fleet next` mentions a window that is active or starts within this long. */
  nextHorizonMs: 4 * HOUR,
});

export class LeaseConfigError extends Error {
  constructor(message) { super(message); this.name = 'LeaseConfigError'; }
}

// ── Location ────────────────────────────────────────────────────────────────

/**
 * The directory every repo's fleet shares: `FLEET_MACHINE_DIR` (must be absolute), else `<home>/.claude-fleet`.
 * Two OS users, or WSL beside Windows, have different homes: they must set the variable to one shared path.
 */
export function machineDir(env = process.env, homedir = os.homedir()) {
  const raw = env.FLEET_MACHINE_DIR;
  if (raw === undefined) return path.join(homedir, '.claude-fleet');
  if (String(raw).trim() === '' || !path.isAbsolute(raw)) {
    throw new LeaseConfigError(`FLEET_MACHINE_DIR must be an absolute path (got ${JSON.stringify(raw)})`);
  }
  return path.resolve(raw);
}

/** Short stable key of a checkout's git common directory: two clones of one repo are two holders. */
export function repoKeyOf(commonDir) {
  // No fallback to the lexical path: a key derived from a different spelling than the other holder's would make one
  // repo two holders (audit H6). An unresolvable path throws, and the caller reports that it cannot identify the repo.
  let real = fs.realpathSync.native(path.resolve(commonDir));
  if (process.platform === 'win32') real = real.toLowerCase();
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 12);
}

/**
 * The display label for a repo (never compared): `owner/repo` from the origin URL, else the checkout's folder name, else
 * `unknown`. Always 1 to 80 characters with no control characters, so it can never fail the record's schema (audit G1: a
 * repo at a filesystem root has an empty folder name).
 */
export function repoLabel(remoteUrl, toplevel) {
  const m = remoteUrl ? /[/:]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(String(remoteUrl).trim()) : null;
  const raw = m ? m[1] : (toplevel ? path.basename(String(toplevel).trim()) : '');
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 80);
  return clean === '' ? 'unknown' : clean;
}

/** The pid namespace a recorded pid belongs to: Windows and WSL report different platforms. */
export const currentScope = () => `${os.platform()}:${os.hostname()}`;

// ── Schema ──────────────────────────────────────────────────────────────────

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
export const note = z.string().max(LIMITS.noteMax).regex(NO_CONTROL, 'must not contain control characters');
export const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'must be an ISO UTC time ending in Z')
  .refine((s) => Number.isFinite(Date.parse(s)), 'must be a real time');
export const hex = (n) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`), `must be ${n} lowercase hex characters`);
export const name = z.string().min(1).max(200).regex(NO_CONTROL, 'must not contain control characters');
/** A holder or repo label: at most 80, so `holder@repo` (161) always fits an event's 200-character `by`. */
const label = z.string().min(1).max(80).regex(NO_CONTROL, 'must not contain control characters');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

// `.passthrough()` everywhere: an additive field from a newer checkout must not make this one call the file corrupt.
const HeavySchema = z.object({
  holder: label, repoKey: hex(12), repo: label, kind: z.enum(KINDS), note: note.optional(),
  scope: name, pid: z.number().int().positive().optional(), token: hex(16), startedAt: iso, expiresAt: iso,
}).passthrough().refine((h) => Date.parse(h.startedAt) <= Date.parse(h.expiresAt), { message: 'startedAt is after expiresAt' });
const WindowSchema = z.object({
  id: z.string().regex(/^w-\d{14}-[0-9a-f]{4}$/), repoKey: hex(12), repo: label, kind: z.enum(WINDOW_KINDS),
  from: iso, until: iso, note: note.optional(),
}).passthrough().refine((w) => Date.parse(w.from) < Date.parse(w.until), { message: 'from is not before until' });
const PeakSchema = z.object({ from: hhmm, to: hhmm }).passthrough();
// ADDITIVE (plan fleet-lease-turns-and-journal D1): these keys are new top-level fields, never new `events` kinds - an older
// checkout's `EventSchema.kind` is an enum, so a new kind there would make the shared file read as corrupt to it. A journal
// `kind` is a free string so a still-newer checkout's kind never makes THIS one call the file corrupt either.
const obj = z.object({}).passthrough();
const JOURNAL_PAYLOAD = new Map(Object.entries({
  acquired: z.object({ mode: z.string(), job: obj }).passthrough(),
  released: z.object({ forced: z.boolean(), job: obj }).passthrough(),
  announced: z.object({ window: z.object({ id: z.string(), kind: z.string(), from: iso, until: iso }).passthrough() }).passthrough(),
  'window-cleared': z.object({ window: z.object({ id: z.string(), kind: z.string() }).passthrough(), ownRepo: z.boolean() }).passthrough(),
  refused: z.object({ refusal: z.object({ op: z.string(), code: z.string() }).passthrough() }).passthrough(),
  waiting: z.object({ episode: z.string(), opener: z.string() }).passthrough(),
  'wait-ended': z.object({ episode: z.string(), reason: z.string(), refusals: z.number().int().min(0) }).passthrough(),
}));
// A KNOWN kind must carry the payload the readers (`lease log`, `measureSlotWaits`) dereference; an unknown kind is tolerated.
const JournalSchema = z.object({ at: iso, kind: z.string().min(1).max(40), by: name, repoKey: hex(12).optional() }).passthrough().superRefine((e, ctx) => {
  const payload = JOURNAL_PAYLOAD.get(e.kind); // a Map: a kind named "constructor" or "toString" is an unknown kind, not a prototype hit
  if (!payload) return;
  const r = payload.safeParse(e);
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: i.path, message: `journal ${e.kind} entry: ${i.message}` });
});
const WaiterSchema = z.object({
  repoKey: hex(12), repo: label, by: name, since: iso, forMin: z.number().int().min(1).max(LIMITS.maxForMin),
  refusals: z.number().int().min(0), lastRefusal: iso.optional(), offeredAt: iso.optional(), note: note.optional(),
  episode: z.string().max(80).optional(),
}).passthrough();
const EventSchema = z.object({ at: iso, kind: z.enum(EVENT_KINDS), by: name, reason: note }).passthrough();
export const LeaseSchema = z.object({
  schemaVersion: z.literal(LEASE_SCHEMA_VERSION),
  heavy: HeavySchema.nullable(), windows: z.array(WindowSchema), peakHours: z.array(PeakSchema), events: z.array(EventSchema),
  journal: z.array(JournalSchema).optional(), waiters: z.array(WaiterSchema).optional(),
}).passthrough();

export const emptyLease = () => ({ schemaVersion: LEASE_SCHEMA_VERSION, heavy: null, windows: [], peakHours: [], events: [] });

// ── Store ───────────────────────────────────────────────────────────────────

export const leasePaths = (dir) => ({ file: path.join(dir, LEASE_FILE), lock: path.join(dir, LEASE_LOCK) });

/**
 * Read the lease. Never throws for a bad file: the state says what it is.
 *  - `absent`: no file (an empty lease, nothing announced)
 *  - `ok`: `lease` is valid
 *  - `newer-version`: written by a newer fleet; read-only here
 *  - `unreadable`: a symbolic link, malformed JSON or a wrong shape; `reason` says which
 * @returns {{state: 'absent'|'ok'|'newer-version'|'unreadable', lease?: object, reason?: string, raw?: string}}
 */
export function readLease(dir) {
  const { file } = leasePaths(dir);
  // Ask about the DIRECTORY first: Windows reports ENOENT (not ENOTDIR) for a path under a file, which would read as
  // "nothing announced" (audit H4). A missing directory is a fresh machine; anything else that is not a directory is a broken store.
  try {
    if (!fs.statSync(dir).isDirectory()) return { state: 'unreadable', reason: `${dir} is not a directory` };
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'absent', lease: emptyLease() };
    return { state: 'unreadable', reason: `cannot stat ${dir}: ${e.message}` };
  }
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    // Only a missing file is an absent lease. ENOTDIR means a path component is a FILE (FLEET_MACHINE_DIR points at one):
    // that is a broken store, never "nothing announced" (audit H4).
    if (e.code === 'ENOENT') return { state: 'absent', lease: emptyLease() };
    return { state: 'unreadable', reason: `cannot stat ${file}: ${e.code === 'ENOTDIR' ? 'a parent of it is not a directory' : e.message}` };
  }
  if (st.isSymbolicLink()) return { state: 'unreadable', reason: `${file} is a symbolic link; it is not followed` };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { state: 'unreadable', reason: `cannot read ${file}: ${e.message}` }; }
  let json;
  try { json = JSON.parse(raw); } catch (e) { return { state: 'unreadable', reason: `malformed JSON (${e.message})`, raw }; }
  if (json && typeof json === 'object' && Number.isInteger(json.schemaVersion) && json.schemaVersion > LEASE_SCHEMA_VERSION) {
    return { state: 'newer-version', reason: `schemaVersion ${json.schemaVersion} is newer than this checkout understands (${LEASE_SCHEMA_VERSION})` };
  }
  const parsed = LeaseSchema.safeParse(json);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { state: 'unreadable', reason: `invalid lease (${i.path.join('.') || '(root)'}: ${i.message})`, raw };
  }
  return { state: 'ok', lease: parsed.data };
}

/** Validate then publish by atomic rename. A symlink at the path is never replaced through. */
export function writeLease(dir, lease) {
  const checked = LeaseSchema.parse(lease);
  const { file } = leasePaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new LeaseConfigError(`${file} is a symbolic link; it is not written through`);
  } catch (e) { if (e instanceof LeaseConfigError) throw e; }
  atomicWriteFileSync(file, `${JSON.stringify(checked, null, 2)}\n`);
  return checked;
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * One read-decide-write under `lease.lock`. `fn(read)` returns `{value, write?}`; when `write` is a lease it is
 * validated and published. Returns `{ok:true,value}` or `{ok:false,reason:'lock-contention'}`.
 */
export function transactLease(dir, fn, { maxWaitMs = 10_000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const { lock } = leasePaths(dir);
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const res = withFileLockSync(lock, { attempts: 3 }, () => {
      const out = fn(readLease(dir));
      if (out.write) writeLease(dir, out.write);
      return out.value;
    });
    if (res.ok) return res;
    if (Date.now() >= deadline) return { ok: false, reason: 'lock-contention' };
    sleepMs(15 + Math.floor(Math.random() * 35));
  }
}

// ── Time ────────────────────────────────────────────────────────────────────

/** An ISO UTC time, or `+<N>m` relative to `now`. Null when it is neither. */
export function parseWhen(text, now) {
  const s = String(text ?? '').trim();
  const rel = /^\+(\d{1,6})m$/.exec(s);
  if (rel) return new Date(now.getTime() + Number(rel[1]) * MIN);
  if (iso.safeParse(s).success) return new Date(s);
  return null;
}

export const ms = (s) => Date.parse(s);
export const hhmmOf = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

// ── Heavy slot ──────────────────────────────────────────────────────────────

export const sameIdentity = (h, id) => h.repoKey === id.repoKey && h.holder === id.holder;

/**
 * What state is the slot in, and — when it has expired — can anyone prove its process is gone?
 * @param {object|null} heavy
 * @param {Date} now
 * @param {{scope: string, isPidAlive: (pid: number) => boolean}} probe
 * @returns {{state: 'free'}|{state: 'held', expiresAt: string}|{state: 'expired', verdict: 'pid-alive'|'pid-dead'|'unverifiable', reason: string}}
 */
export function classifyHeavy(heavy, now, probe) {
  if (!heavy) return { state: 'free' };
  if (now.getTime() < ms(heavy.expiresAt)) return { state: 'held', expiresAt: heavy.expiresAt };
  if (heavy.pid === undefined) return { state: 'expired', verdict: 'unverifiable', reason: 'no pid was recorded, so nothing can show the job stopped' };
  if (heavy.scope !== probe.scope) {
    return { state: 'expired', verdict: 'unverifiable', reason: `its pid ${heavy.pid} belongs to ${heavy.scope}, not this process scope (${probe.scope})` };
  }
  return probe.isPidAlive(heavy.pid)
    ? { state: 'expired', verdict: 'pid-alive', reason: `the recorded pid ${heavy.pid} is still running` }
    : { state: 'expired', verdict: 'pid-dead', reason: `the recorded pid ${heavy.pid} is no longer running` };
}

export const defaultProbe = () => ({ scope: currentScope(), isPidAlive });

export const refuse = (code, reason) => ({ ok: false, code, reason });
/** Every generated event text goes through here: it can never exceed the schema's limit and turn a decision into a write error. */
export const clip = (s) => String(s).slice(0, LIMITS.noteMax);
const labelOk = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 80 && NO_CONTROL.test(s);
/** The identity strings a request carries must fit the record (audit H2). */
export const badIdentity = (req) => (labelOk(req.identity?.holder) && (req.repo === undefined || labelOk(req.repo)) ? null
  : refuse('bad-request', 'the session id (--id or the branch name) and the repo label must each be 1 to 80 characters with no control characters'));
export const checkNote = (n) => (n === undefined || (typeof n === 'string' && n.length <= LIMITS.noteMax && NO_CONTROL.test(n)));

/** Append an event to the ring: the newest `maxEvents` are kept. */
export function appendEvent(lease, ev) {
  return { ...lease, events: [...lease.events, ev].slice(-LIMITS.maxEvents) };
}

// ── Journal and waiters (plan fleet-lease-turns-and-journal D3, D3b) ────────

/** Append to the journal ring: the newest `maxJournal` entries are kept. */
export function appendJournal(lease, entry) {
  return { ...lease, journal: [...(lease.journal ?? []), entry].slice(-LIMITS.maxJournal) };
}
export const byOf = (req) => `${req.identity.holder}@${req.repo}`;
export const jentry = (now, kind, req, extra = {}) => ({ at: now.toISOString(), kind, by: byOf(req), repoKey: req.identity.repoKey, ...extra });
/** The id of a wait episode: stored on the waiter (unique even for two episodes opened in the same instant). */
export const episodeOf = (w) => w.episode ?? `${w.repoKey}@${w.since}`;
const waitEndedEntry = (w, reason, now, by) => ({
  at: now.toISOString(), kind: 'wait-ended', by, repoKey: w.repoKey, episode: episodeOf(w), reason, refusals: w.refusals,
  ...(w.lastRefusal ? { lastRefusal: w.lastRefusal } : {}),
});

/** End a repo's wait episode (served, cancelled, expired): drop the entry and journal why. A no-op when it is not waiting. */
export function endWait(lease, repoKey, reason, now, by) {
  const w = (lease.waiters ?? []).find((x) => x.repoKey === repoKey);
  if (!w) return lease;
  return appendJournal({ ...lease, waiters: lease.waiters.filter((x) => x !== w) }, waitEndedEntry(w, reason, now, by));
}

/**
 * The time-driven transitions, applied FIRST in every mutating decision (after the request validates, before it is
 * evaluated): a waiter older than `maxWaitMs` expires. Persisted even when the operation is then refused, because
 * they are facts about time. Touches `waiters` and `journal` only; returns the SAME object when nothing changed.
 */
export function settleQueue(lease, now) {
  const stale = (lease.waiters ?? []).filter((w) => now.getTime() - ms(w.since) > LIMITS.maxWaitMs);
  if (!stale.length) return lease;
  let next = { ...lease, waiters: lease.waiters.filter((w) => !stale.includes(w)) };
  for (const w of stale) next = appendJournal(next, waitEndedEntry(w, 'expired', now, 'settle'));
  return next;
}

/**
 * Open (or join) this repo's wait episode. One entry per REPO, because turns are per repo; a refusal by any of its
 * sessions bumps the count and never grows the journal. When the list is full nothing is evicted: `queued:false`.
 */
export function openWait(lease, req, { forMin, opener, refusal, now }) {
  const waiters = lease.waiters ?? [];
  const cur = waiters.find((w) => w.repoKey === req.identity.repoKey);
  const stamp0 = now.toISOString();
  if (cur) {
    if (opener !== 'refusal') return { lease, queued: true, opened: false, waiter: cur };
    const w = { ...cur, refusals: cur.refusals + 1, lastRefusal: stamp0 };
    return { lease: { ...lease, waiters: waiters.map((x) => (x === cur ? w : x)) }, queued: true, opened: false, waiter: w };
  }
  if (waiters.length >= LIMITS.maxWaiters) return { lease, queued: false, full: true };
  // Unique per episode: a clock that has not advanced (a pinned test clock, two calls in one millisecond) must not give a new
  // episode the id of one the journal already closed - found by the interleaving test, seed 11.
  let episode = `${req.identity.repoKey}@${stamp0}`;
  for (let n = 2; (lease.journal ?? []).some((e) => e.episode === episode); n += 1) episode = `${req.identity.repoKey}@${stamp0}#${n}`;
  const w = {
    repoKey: req.identity.repoKey, repo: req.repo, by: byOf(req), since: stamp0, forMin, episode,
    refusals: opener === 'refusal' ? 1 : 0, ...(opener === 'refusal' ? { lastRefusal: stamp0 } : {}),
    ...(req.note !== undefined ? { note: req.note } : {}),
  };
  const entry = jentry(now, 'waiting', req, { episode: episodeOf(w), opener, ...(refusal ? { refusal } : {}), job: { forMin } });
  return { lease: appendJournal({ ...lease, waiters: [...waiters, w] }, entry), queued: true, opened: true, waiter: w };
}

/**
 * A refusal that is not absorbed by a wait episode (announce, a full queue): journalled, and consecutive identical
 * ones (same session, op, code) bump `n` and `lastAt` on the last entry instead of growing the ring.
 */
export function journalRefusal(lease, req, op, code, now, extra = {}) {
  const j = lease.journal ?? [];
  const last = j[j.length - 1];
  const by = byOf(req);
  if (last && last.kind === 'refused' && last.repoKey === req.identity.repoKey && last.by === by && last.refusal?.op === op && last.refusal?.code === code) {
    return { ...lease, journal: [...j.slice(0, -1), { ...last, n: (last.n ?? 1) + 1, lastAt: now.toISOString() }] };
  }
  return appendJournal(lease, jentry(now, 'refused', req, { refusal: { op, code }, ...extra }));
}

/** Drop windows that ended more than `pruneAfterMs` ago. */
export const pruneWindows = (lease, now) => ({ ...lease, windows: lease.windows.filter((w) => now.getTime() - ms(w.until) <= LIMITS.pruneAfterMs) });

/** The announced windows of OTHER repos that overlap `[now, end)`. */
export function conflictingWindows(lease, repoKey, now, end) {
  return lease.windows.filter((w) => w.repoKey !== repoKey && ms(w.from) < end.getTime() && ms(w.until) > now.getTime());
}
