/**
 * @fileoverview /fleet's registry — one JSON record per session, the hold flag
 * and the train manifests, under `$(git rev-parse --git-common-dir)/fleet/`.
 *
 * Invariants (plan §2):
 *  - **Storage key** = readable prefix (<= 40 chars) + `-` + sha256(id)[0:12].
 *    The digest is over the EXACT id, so `feat/a` vs `feat-a` and case-only
 *    differences never share a file. The id stored inside the record is
 *    re-hashed on EVERY read; a mismatch is `invalid`, not trusted.
 *  - **Never silently skip**: `readSessions` returns `{sessions, invalid,
 *    complete}`; `complete:false` whenever any file failed to read, parse,
 *    validate or hash-check. Admission refuses on `!complete`.
 *  - **Every mutation is a transaction**: `transact` takes `fleet/.lock`,
 *    re-reads inside, and a write must STRICTLY INCREASE `rev` over what is on
 *    disk, so a stale writer can never overwrite a newer record. A lock that
 *    cannot be acquired is a refusal, never a proceed-without.
 *  - **Confinement**: train ids are validated before any path is built and every
 *    managed path is checked to resolve inside `fleet/`.
 *  - Nothing is ever deleted automatically; `quarantine` moves, never removes.
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2, §7 (Phase 3).
 *
 * @module scripts/lib/fleet/registry
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { withFileLockSync } from '../file-lock.mjs';
import { gitCommonDir } from './git-facts.mjs';
import { MERGE_METHODS, OID_RE, TierSchema, isInside } from './contracts.mjs';

// ── Schemas ────────────────────────────────────────────────────────────────

export const TRAIN_ID_RE = /^t-[0-9]{14}-[0-9a-f]{4}$/;
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;
const MAX_ID = 200;

export const SESSION_STATES = Object.freeze(['working', 'ready', 'blocked', 'done', 'abandoned']);
export const WAIT_KINDS = Object.freeze(['session', 'human', 'ci', 'train', 'external']);

const IdSchema = z.string().min(1).max(MAX_ID).regex(NO_CONTROL, 'id must not contain control characters');
const IsoSchema = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'must be an ISO timestamp');
const OidSchema = z.string().regex(OID_RE, 'must be a full commit oid (exactly 40 or 64 hex chars)');
const nullable = (s) => s.nullable();

export const WaitingOnSchema = z.strictObject({
  kind: z.enum(WAIT_KINDS),
  ref: z.string().min(1).max(MAX_ID).regex(NO_CONTROL, 'ref must not contain control characters'),
  note: z.string().max(500).nullable().optional(),
  since: IsoSchema,
}).superRefine((w, ctx) => {
  if (w.kind === 'train' && !TRAIN_ID_RE.test(w.ref)) {
    ctx.addIssue({ code: 'custom', path: ['ref'], message: 'train ref must be a train id (t-<14 digits>-<4 hex>)' });
  }
});

export const SessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rev: z.number().int().min(1),
  id: IdSchema,
  source: z.strictObject({
    kind: z.enum(['branch', 'pr']),
    branch: nullable(z.string()),
    repo: nullable(z.string()),
    prNumber: nullable(z.number().int().positive()),
    headRepo: nullable(z.string()),
    headRef: nullable(z.string()),
    baseRef: nullable(z.string()),
  }),
  worktree: nullable(z.string()),
  intent: z.string(),
  paths: z.array(z.string()),
  state: z.enum(SESSION_STATES),
  gen: z.number().int().min(1),
  startOid: nullable(OidSchema),
  waitingOn: z.array(WaitingOnSchema),
  ready: nullable(z.strictObject({ oid: OidSchema, at: IsoSchema })),
  knownOverlaps: z.array(z.strictObject({
    with: IdSchema, by: z.string(), at: IsoSchema, note: z.string().max(500).nullable().optional(),
  })),
  leaseExpiresAt: IsoSchema,
  updatedAt: IsoSchema,
  createdAt: IsoSchema,
});

export const HoldSchema = z.strictObject({
  held: z.boolean(), by: nullable(z.string()), reason: nullable(z.string()), at: nullable(IsoSchema),
});

const RESULTS = ['green', 'green-after-rerun', 'red', 'dirty', 'none'];
export const TRAIN_PHASES = Object.freeze([
  'snapshot', 'applying', 'conflict', 'tested', 'approved', 'awaiting-merge', 'push-pending', 'landed', 'diverged', 'abandoned',
]);

export const TrainSchema = z.strictObject({
  schemaVersion: z.literal(1),
  trainId: z.string().regex(TRAIN_ID_RE),
  createdAt: IsoSchema,
  updatedAt: IsoSchema.optional(),
  phase: z.enum(TRAIN_PHASES),
  baseOid: OidSchema,
  sources: z.array(z.strictObject({
    id: IdSchema, gen: z.number().int().min(1), rev: z.number().int().min(1), oid: OidSchema, kind: z.enum(['branch', 'pr']),
    repo: nullable(z.string()).optional(), prNumber: nullable(z.number().int()).optional(), headRepo: nullable(z.string()).optional(),
    baseRef: nullable(z.string()).optional(), baseRefOid: nullable(z.string()).optional(),
  })),
  mergeMethod: z.enum(MERGE_METHODS),
  destination: z.strictObject({
    remote: z.string(), fetchUrl: z.string(), pushUrl: z.string(), ref: z.string(), expectedOid: nullable(z.string()),
  }),
  testCommand: z.array(TierSchema),
  candidate: nullable(z.strictObject({ oid: OidSchema, tree: OidSchema })).optional(),
  depsChanged: z.boolean().nullable().optional(),
  result: z.enum(RESULTS).nullable().optional(),
  tierResults: z.array(z.looseObject({ name: z.string(), result: z.enum(RESULTS) })).optional(),
  deferredTiers: z.array(TierSchema).optional(),
  checkResults: z.array(z.looseObject({ name: z.string() })).optional(),
  worktree: z.string().nullable().optional(),
  conflict: z.looseObject({}).nullable().optional(),
  reconciledFrom: z.string().nullable().optional(),
  outcome: z.looseObject({}).nullable().optional(),
  notes: z.array(z.string()).optional(),
});

/** Fields that legitimately change after first write (phase-like). Everything else is write-once. */
const MUTABLE_TRAIN_FIELDS = new Set(['phase', 'updatedAt', 'result', 'reconciledFrom', 'outcome', 'notes']);
const APPEND_ONLY_TRAIN_FIELDS = new Set(['tierResults']);

export class RegistryError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message, { repairFile } = {}) {
    super(message); this.name = 'RegistryError'; this.code = code;
    if (repairFile) this.repairFile = repairFile;
  }
}

// ── Keys and paths ─────────────────────────────────────────────────────────

/** @param {string} id @returns {string} filename stem (no extension) */
export function storageKey(id) {
  if (typeof id !== 'string' || id === '') throw new RegistryError('BAD_ID', 'session id must be a non-empty string');
  const prefix = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '') || 'session';
  return `${prefix}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
}

/** The registry directory for the repo containing `cwd`. Throws when not in a git repo. */
export function fleetDir(cwd) {
  const r = gitCommonDir(cwd);
  if (!r.ok) throw new RegistryError('NOT_A_REPO', `cannot locate the git common dir: ${r.reason}`);
  return path.join(r.dir, 'fleet');
}

/** realpath of the nearest EXISTING ancestor of `p`, with the not-yet-existing tail re-appended. */
function realWithTail(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Throw unless `p` resolves strictly inside `dir` — lexically AND after
 * resolving symlinks/junctions on the nearest existing ancestor, so a link at
 * `fleet/trains` pointing elsewhere cannot carry a write out of the registry.
 * @returns {string} the resolved (lexical) path
 */
export function assertManaged(dir, p) {
  const abs = path.resolve(p);
  const escapes = () => new RegistryError('ESCAPES_REGISTRY', `path escapes the fleet registry: ${p}`);
  if (!isInside(abs, dir, { strict: true })) throw escapes();
  if (!isInside(realWithTail(abs), realWithTail(dir), { strict: true })) throw escapes();
  return abs;
}

const sessionsDir = (dir) => path.join(dir, 'sessions');
const trainsDir = (dir) => path.join(dir, 'trains');
const sessionPath = (dir, id) => assertManaged(dir, path.join(sessionsDir(dir), `${storageKey(id)}.json`));

/** A fresh train id: `t-<yyyymmddhhmmss>-<4 hex>` (UTC). */
export function newTrainId(now = new Date()) {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `t-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Validate before ANY path is built from it. */
export function assertTrainId(id) {
  if (typeof id !== 'string' || !TRAIN_ID_RE.test(id)) {
    throw new RegistryError('BAD_TRAIN_ID', `invalid train id ${JSON.stringify(String(id).slice(0, 80))} (expected t-<14 digits>-<4 hex>)`);
  }
  return id;
}

export function trainPath(dir, id) {
  assertTrainId(id);
  return assertManaged(dir, path.join(trainsDir(dir), `${id}.json`));
}

// ── Reading ────────────────────────────────────────────────────────────────

function parseSessionFile(file, text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { reason: `malformed JSON: ${e.message}` }; }
  const parsed = SessionSchema.safeParse(raw);
  if (!parsed.success) return { reason: `schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` };
  const expected = `${storageKey(parsed.data.id)}.json`;
  if (expected !== file) return { reason: `embedded id does not hash to this filename (expected ${expected})` };
  return { record: parsed.data };
}

/**
 * Read every session record. Never skips silently.
 * @param {string} dir - the fleet dir
 * @returns {{sessions: object[], invalid: Array<{file: string, reason: string}>, complete: boolean}}
 */
export function readSessions(dir) {
  const sdir = sessionsDir(dir);
  let names;
  try { names = fs.readdirSync(sdir); } catch (e) {
    if (e.code === 'ENOENT') return { sessions: [], invalid: [], complete: true };
    return { sessions: [], invalid: [{ file: 'sessions/', reason: `unreadable directory: ${e.message}` }], complete: false };
  }
  const sessions = []; const invalid = [];
  for (const file of names.sort()) {
    if (file.startsWith('.tmp-')) continue; // an in-flight or abandoned atomic-write temp
    if (!file.endsWith('.json')) { invalid.push({ file, reason: 'unexpected file in sessions/' }); continue; }
    let text;
    try { text = fs.readFileSync(path.join(sdir, file), 'utf-8'); } catch (e) { invalid.push({ file, reason: `unreadable: ${e.message}` }); continue; }
    const r = parseSessionFile(file, text);
    if (r.record) sessions.push(r.record); else invalid.push({ file, reason: r.reason });
  }
  sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { sessions, invalid, complete: invalid.length === 0 };
}

// ── Writing ────────────────────────────────────────────────────────────────

const writeJson = (file, value) => atomicWriteFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Write one session record. CALLER HOLDS `fleet/.lock` (use `transact`). The
 * record's `rev` must strictly exceed what is on disk (new record: >= 1); an
 * unreadable file at the target is never overwritten — quarantine it first.
 * @returns {object} the validated record
 */
export function writeSession(dir, record) {
  const rec = SessionSchema.parse(record);
  const target = sessionPath(dir, rec.id);
  if (fs.existsSync(target)) {
    const cur = parseSessionFile(path.basename(target), fs.readFileSync(target, 'utf-8'));
    // The library cannot know how the operator invokes the CLI (`node scripts/fleet.mjs`, a synced
    // path, ...), so it names the file and the CLI entry point renders the exact repair command.
    if (!cur.record) throw new RegistryError('TARGET_INVALID', `refusing to overwrite an invalid record (${cur.reason})`, { repairFile: path.basename(target) });
    if (rec.rev <= cur.record.rev) {
      throw new RegistryError('REV_STALE', `stale write for ${rec.id}: rev ${rec.rev} does not exceed on-disk rev ${cur.record.rev}`);
    }
  }
  writeJson(target, rec);
  return rec;
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Run `fn` as a registry transaction under `fleet/.lock`. `fn` receives a fresh
 * read taken INSIDE the lock plus write helpers; gather slow git/gh facts
 * BEFORE calling this. A thrown error releases the lock and propagates.
 *
 * @template T
 * @param {string} dir
 * @param {(ctx: {dir: string, sessions: object[], invalid: object[], complete: boolean,
 *   writeSession: (r: object) => object, readHold: () => object, writeHold: (h: object) => object}) => T} fn
 * @param {{maxWaitMs?: number}} [opts]
 * @returns {{ok: true, value: T} | {ok: false, reason: 'lock-contention'}}
 */
export function transact(dir, fn, { maxWaitMs = 10_000 } = {}) {
  fs.mkdirSync(sessionsDir(dir), { recursive: true });
  const lockPath = path.join(dir, '.lock');
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const res = withFileLockSync(lockPath, { attempts: 3 }, () => {
      const read = readSessions(dir);
      const ctx = {
        dir, ...read,
        writeSession: (r) => {
          const written = writeSession(dir, r);
          ctx.sessions = [...ctx.sessions.filter((s) => s.id !== written.id), written];
          return written;
        },
        readHold: () => readHold(dir),
        writeHold: (h) => writeHold(dir, h),
      };
      return fn(ctx);
    });
    if (res.ok) return res;
    if (Date.now() >= deadline) return { ok: false, reason: 'lock-contention' };
    sleepMs(15 + Math.floor(Math.random() * 35));
  }
}

/**
 * Move ONE invalid session file aside. Human-run; nothing is ever deleted.
 * @param {string} dir
 * @param {string} file - basename inside `sessions/`
 * @returns {{ok: boolean, to?: string, reason?: string}}
 */
export function quarantine(dir, file) {
  if (typeof file !== 'string' || file !== path.basename(file) || file === '' || file.startsWith('.')) {
    return { ok: false, reason: 'quarantine takes a bare filename from sessions/' };
  }
  const from = assertManaged(dir, path.join(sessionsDir(dir), file));
  if (!fs.existsSync(from)) return { ok: false, reason: `no such file in sessions/: ${file}` };
  const qdir = path.join(dir, 'quarantine');
  fs.mkdirSync(qdir, { recursive: true });
  const to = assertManaged(dir, path.join(qdir, `${file}.${Date.now()}`));
  fs.renameSync(from, to);
  return { ok: true, to };
}

// ── Hold ───────────────────────────────────────────────────────────────────

const holdPath = (dir) => path.join(dir, 'hold.json');

/** @returns {{held: boolean, by: string|null, reason: string|null, at: string|null, invalid?: string}} */
export function readHold(dir) {
  const none = { held: false, by: null, reason: null, at: null };
  let text;
  try { text = fs.readFileSync(holdPath(dir), 'utf-8'); } catch (e) {
    return e.code === 'ENOENT' ? none : { ...none, invalid: `unreadable: ${e.message}` };
  }
  try {
    const r = HoldSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : { ...none, invalid: 'hold.json failed schema validation' };
  } catch (e) { return { ...none, invalid: `malformed JSON: ${e.message}` }; }
}

export function writeHold(dir, hold) {
  const h = HoldSchema.parse(hold);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(holdPath(dir), h);
  return h;
}

// ── Trains ─────────────────────────────────────────────────────────────────

/** @returns {{ok: true, train: object} | {ok: false, reason: string}} */
export function readTrain(dir, id) {
  const file = trainPath(dir, id);
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? 'no such train' : `unreadable: ${e.message}` }; }
  try {
    const r = TrainSchema.safeParse(JSON.parse(text));
    if (!r.success) return { ok: false, reason: `schema: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
    if (r.data.trainId !== id) return { ok: false, reason: 'embedded trainId does not match filename' };
    return { ok: true, train: r.data };
  } catch (e) { return { ok: false, reason: `malformed JSON: ${e.message}` }; }
}

const populated = (v) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

/**
 * Write a train manifest. A second write to a POPULATED write-once field is
 * refused (`TRAIN_IMMUTABLE`); phase-like fields may change, `tierResults` may
 * only grow. Callers serialise via `trains/.lock` (Cluster B).
 */
export function writeTrain(dir, train) {
  const next = TrainSchema.parse(train);
  const file = trainPath(dir, next.trainId);
  if (fs.existsSync(file)) {
    const cur = readTrain(dir, next.trainId);
    if (!cur.ok) throw new RegistryError('TRAIN_INVALID', `existing train is unreadable (${cur.reason}); not overwriting`);
    for (const [k, was] of Object.entries(cur.train)) {
      if (MUTABLE_TRAIN_FIELDS.has(k) || !populated(was)) continue;
      const now = next[k];
      if (APPEND_ONLY_TRAIN_FIELDS.has(k)) {
        if (!Array.isArray(now) || !isDeepStrictEqual(now.slice(0, was.length), was)) {
          throw new RegistryError('TRAIN_IMMUTABLE', `refusing to rewrite already-recorded entries of ${k} on ${next.trainId}`);
        }
      } else if (!isDeepStrictEqual(now, was)) {
        throw new RegistryError('TRAIN_IMMUTABLE', `refusing to overwrite populated manifest field "${k}" on ${next.trainId}; build a new train`);
      }
    }
  }
  fs.mkdirSync(trainsDir(dir), { recursive: true });
  writeJson(file, next);
  return next;
}

/** @returns {{trains: object[], invalid: Array<{file: string, reason: string}>, complete: boolean}} */
export function listTrains(dir) {
  let names;
  try { names = fs.readdirSync(trainsDir(dir)); } catch (e) {
    if (e.code === 'ENOENT') return { trains: [], invalid: [], complete: true };
    return { trains: [], invalid: [{ file: 'trains/', reason: `unreadable directory: ${e.message}` }], complete: false };
  }
  const trains = []; const invalid = [];
  for (const file of names.sort()) {
    if (file.startsWith('.')) continue; // .lock, .tmp-*
    const id = file.replace(/\.json$/, '');
    if (!file.endsWith('.json') || !TRAIN_ID_RE.test(id)) { invalid.push({ file, reason: 'unexpected file in trains/' }); continue; }
    const r = readTrain(dir, id);
    if (r.ok) trains.push(r.train); else invalid.push({ file, reason: r.reason });
  }
  return { trains, invalid, complete: invalid.length === 0 };
}
