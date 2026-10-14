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

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Every limit is an inclusive maximum. */
export const LIMITS = Object.freeze({
  defaultForMin: 30, maxForMin: 180, noteMax: 200,
  maxWindows: 50, maxWindowsPerRepo: 10, maxHorizonMs: 14 * 24 * HOUR, maxWindowMs: 24 * HOUR,
  maxPeak: 8, maxEvents: 20, pruneAfterMs: HOUR,
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
const note = z.string().max(LIMITS.noteMax).regex(NO_CONTROL, 'must not contain control characters');
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'must be an ISO UTC time ending in Z')
  .refine((s) => Number.isFinite(Date.parse(s)), 'must be a real time');
const hex = (n) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`), `must be ${n} lowercase hex characters`);
const name = z.string().min(1).max(200).regex(NO_CONTROL, 'must not contain control characters');
/** A holder or repo label: at most 80, so `holder@repo` (161) always fits an event's 200-character `by`. */
const label = z.string().min(1).max(80).regex(NO_CONTROL, 'must not contain control characters');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

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
const EventSchema = z.object({ at: iso, kind: z.enum(EVENT_KINDS), by: name, reason: note }).passthrough();
export const LeaseSchema = z.object({
  schemaVersion: z.literal(LEASE_SCHEMA_VERSION),
  heavy: HeavySchema.nullable(), windows: z.array(WindowSchema), peakHours: z.array(PeakSchema), events: z.array(EventSchema),
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

const ms = (s) => Date.parse(s);
const hhmmOf = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

// ── Heavy slot ──────────────────────────────────────────────────────────────

const sameIdentity = (h, id) => h.repoKey === id.repoKey && h.holder === id.holder;

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

const refuse = (code, reason) => ({ ok: false, code, reason });
/** Every generated event text goes through here: it can never exceed the schema's limit and turn a decision into a write error. */
const clip = (s) => String(s).slice(0, LIMITS.noteMax);
const labelOk = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 80 && NO_CONTROL.test(s);
/** The identity strings a request carries must fit the record (audit H2). */
const badIdentity = (req) => (labelOk(req.identity?.holder) && (req.repo === undefined || labelOk(req.repo)) ? null
  : refuse('bad-request', 'the session id (--id or the branch name) and the repo label must each be 1 to 80 characters with no control characters'));
const checkNote = (n) => (n === undefined || (typeof n === 'string' && n.length <= LIMITS.noteMax && NO_CONTROL.test(n)));

/** Append an event to the ring: the newest `maxEvents` are kept. */
export function appendEvent(lease, ev) {
  return { ...lease, events: [...lease.events, ev].slice(-LIMITS.maxEvents) };
}

/** Drop windows that ended more than `pruneAfterMs` ago. */
export const pruneWindows = (lease, now) => ({ ...lease, windows: lease.windows.filter((w) => now.getTime() - ms(w.until) <= LIMITS.pruneAfterMs) });

/** The announced windows of OTHER repos that overlap `[now, end)`. */
export function conflictingWindows(lease, repoKey, now, end) {
  return lease.windows.filter((w) => w.repoKey !== repoKey && ms(w.from) < end.getTime() && ms(w.until) > now.getTime());
}

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
  const cur = lease.heavy;
  const cls = classifyHeavy(cur, now, probe);
  const mine = cur && sameIdentity(cur, req.identity);

  const blocking = conflictingWindows(lease, req.identity.repoKey, now, end);
  if (blocking.length) {
    const w = blocking[0];
    return refuse('window', `another repo announced a ${w.kind} window (${w.repo}, ${w.from} to ${w.until}${w.note ? `: ${w.note}` : ''}) that overlaps the requested ${forMin} minutes; shorten --for to end before ${w.from}, or wait`);
  }

  let event;
  if (cur && mine) {
    if (req.token !== undefined && req.token !== cur.token) return refuse('stale-token', 'the supplied token is not the current one for this slot (a stale fence)');
  } else if (cur) {
    if (cls.state === 'held') return refuse('held', `held by ${cur.holder} (${cur.repo}) for ${cur.kind} until ${cur.expiresAt}`);
    if (cls.verdict === 'pid-alive') return refuse('expired-pid-alive', `the lease of ${cur.holder} (${cur.repo}) expired at ${cur.expiresAt}, but ${cls.reason}; it cannot be granted`);
    if (cls.verdict === 'unverifiable') return refuse('unverifiable', `the lease of ${cur.holder} (${cur.repo}) expired at ${cur.expiresAt} but ${cls.reason}; if a person has confirmed the job is gone: release --force --reason "<why>"`);
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
  let next = pruneWindows({ ...lease, heavy }, now);
  if (event) next = appendEvent(next, event);
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
  const cur = lease.heavy;
  if (req.force && (typeof req.reason !== 'string' || req.reason.trim() === '' || !checkNote(req.reason))) {
    return refuse('bad-request', `--force needs --reason (at most ${LIMITS.noteMax} characters, no control characters)`);
  }
  if (!cur) return { ok: true, lease, released: null, already: true };
  const mine = sameIdentity(cur, req.identity);
  if (mine) {
    if (req.token !== undefined && req.token !== cur.token) return refuse('stale-token', 'the supplied token is not the current one for this slot (a stale fence)');
    return { ok: true, lease: { ...lease, heavy: null }, released: cur };
  }
  if (!req.force) return refuse('not-holder', `the slot is held by ${cur.holder} (${cur.repo}); only the holder releases it (or --force --reason once it has expired)`);
  const cls = classifyHeavy(cur, now, probe);
  if (cls.state === 'held') return refuse('live', `the lease of ${cur.holder} (${cur.repo}) has not expired (until ${cur.expiresAt}); a live lease is never forced`);
  const ev = { at: now.toISOString(), kind: 'forced-release', by: `${req.identity.holder}@${req.repo}`, reason: clip(`${req.reason.trim()} [${cls.verdict}: ${cls.reason}]`) };
  return { ok: true, lease: appendEvent({ ...lease, heavy: null }, ev), released: cur, event: ev };
}

// ── Windows ─────────────────────────────────────────────────────────────────

const stamp = (d) => d.toISOString().replace(/\D/g, '').slice(0, 14);

/** `announce`: record a quiet/CI window for THIS repo. */
export function decideAnnounce(lease, req, now) {
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
  const pruned = pruneWindows(lease, now);
  if (pruned.windows.length >= LIMITS.maxWindows) return refuse('limit', `there are already ${LIMITS.maxWindows} windows on this machine`);
  if (pruned.windows.filter((w) => w.repoKey === req.identity.repoKey).length >= LIMITS.maxWindowsPerRepo) {
    return refuse('limit', `this repo already has ${LIMITS.maxWindowsPerRepo} windows`);
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
  };
  return { ok: true, lease: { ...pruned, windows: [...pruned.windows, win] }, window: win };
}

/** `announce --clear-window`: any session may clear any window (a coordinator who must proceed); other repos' are recorded. */
export function decideClearWindow(lease, req, now) {
  const badId = badIdentity(req);
  if (badId) return badId;
  const w = lease.windows.find((x) => x.id === req.id);
  if (!w) return refuse('no-such-window', `no window ${JSON.stringify(req.id)}`);
  let next = { ...lease, windows: lease.windows.filter((x) => x !== w) };
  let event;
  if (w.repoKey !== req.identity.repoKey) {
    event = { at: now.toISOString(), kind: 'window-cleared', by: `${req.identity.holder}@${req.repo}`, reason: clip(`cleared ${w.id} (${w.kind}, ${w.repo}, ${w.from} to ${w.until})`) };
    next = appendEvent(next, event);
  }
  return { ok: true, lease: next, window: w, ...(event ? { event } : {}) };
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
    events: lease.events,
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

/** The lines of `fleet lease status`. */
export function renderStatus(s, { dir, now, repoKey }) {
  const head = `machine lease (${dir}):`;
  if (!s.measured) return [head, `  UNMEASURED: ${s.reason}`];
  const lines = [head, `  ${heavyLine(s, now, repoKey)}`];
  if (s.windows.length) {
    for (const w of s.windows) lines.push(`  window ${w.id}: ${w.kind} for ${w.repo}, ${hhmmOf(new Date(w.from))} to ${hhmmOf(new Date(w.until))}${w.note ? ` — ${w.note}` : ''}`);
  } else lines.push('  windows: none announced');
  if (s.peakHours.length) {
    const r = (x) => `${x.from}-${x.to}`;
    lines.push(`  peak hours (machine-local): ${s.peakHours.map(r).join(', ')} — ${s.peak.now ? `PEAK NOW (${r(s.peak.range)})` : s.peak.next ? `next ${r(s.peak.next)}` : 'none upcoming'}`);
  } else lines.push('  peak hours: none set');
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
  if (s.peak.now) parts.push('peak-cost hours now');
  return parts.length ? [`${tag} machine lease: ${parts.join('; ')} — ${status}`] : [];
}
