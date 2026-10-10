/**
 * @fileoverview fleet telemetry, drain side: move spooled events
 * (lib/fleet/telemetry.mjs) into the store through an INJECTED writer, so this
 * module never imports the store and stays testable without one.
 *
 * Exactly one drainer runs per spool (an O_EXCL lock holding a token; a lock
 * older than DRAIN_LOCK_STALE_MS is a dead drainer and is taken over by an
 * atomic rename, so takeover can never delete a live lock). Writes are
 * idempotent on `eventId`, so a drainer that dies between the write and the
 * unlink only causes a no-op re-insert next time. A file that does not parse
 * as a v1 event is moved to `rejected/` (bounded) and counted — never retried
 * forever, never silently deleted.
 *
 * @module scripts/lib/fleet/telemetry-drain
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DRAIN_LOCK_STALE_MS, TELEMETRY_VERSION } from './telemetry.mjs';

export const BATCH_SIZE = 200;
const MAX_REJECTED = 100;
const OUTCOMES = ['ok', 'refused', 'pending', 'error', 'argv'];

const detailValue = z.union([z.number(), z.boolean(), z.string().max(64), z.record(z.string(), z.number())]);

export const SpooledEventSchema = z.object({
  v: z.literal(TELEMETRY_VERSION),
  eventId: z.string().uuid(),
  occurredAt: z.iso.datetime(),
  verb: z.string().regex(/^[a-z][a-z-]{0,31}$/),
  mode: z.string().max(32).nullable(),
  outcome: z.enum(OUTCOMES),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  sessionId: z.string().max(200).nullable(),
  reasonClass: z.string().max(160).nullable(),
  toolSha: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
  detail: z.record(z.string(), detailValue),
}).strict();

const LOCK = 'drain.lock';

/**
 * Take the drain lock. The lock file holds a random token; release removes it
 * only while it still holds OUR token. Stale takeover RENAMES the old lock to a
 * unique name first — rename is atomic, so of two drainers that both judged it
 * stale exactly one wins the rename, and neither can delete a lock the other
 * has just created.
 * @returns {(() => void) | null}
 */
export function acquireLock(dir, nowMs) {
  const lock = path.join(dir, LOCK);
  const token = `${process.pid}-${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      return () => {
        try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age;
      try { age = nowMs - fs.statSync(lock).mtimeMs; } catch { continue; } // released meanwhile: retry
      if (age < DRAIN_LOCK_STALE_MS) return null;
      let seen;
      try { seen = fs.readFileSync(lock, 'utf8'); } catch { continue; }
      const aside = path.join(dir, `${LOCK}.stale-${token}`);
      try { fs.renameSync(lock, aside); } catch { return null; } // another drainer won the takeover
      // If what we moved is not the stale lock we inspected, another drainer took
      // over in between and we moved ITS fresh lock: put it back and stand down.
      // (A residual double drain is still safe: writes are idempotent on eventId.)
      let moved = null;
      try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* vanished */ }
      if (moved !== seen) {
        try { fs.renameSync(aside, lock); } catch { /* the owner will recreate it */ }
        return null;
      }
      try { fs.unlinkSync(aside); } catch { /* best effort */ }
    }
  }
  return null;
}

function reject(dir, name) {
  const rdir = path.join(dir, 'rejected');
  fs.mkdirSync(rdir, { recursive: true });
  if (fs.readdirSync(rdir).length >= MAX_REJECTED) { fs.unlinkSync(path.join(dir, name)); return; }
  fs.renameSync(path.join(dir, name), path.join(rdir, name));
}

/**
 * Pending event files, oldest first (names start with the epoch ms). A spool
 * that does not exist yet is empty; any OTHER read failure throws — an
 * unreadable spool is a capture fault, not an empty one.
 */
export function pendingFiles(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Read a counter file: null when absent, a non-negative integer, or throw on garbage. */
function readCount(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (!/^\d+$/.test(raw)) throw new Error(`${path.basename(file)} holds ${JSON.stringify(raw.slice(0, 20))}, not a count`);
  return Number(raw);
}

const droppedSnapshots = (dir) => {
  try { return fs.readdirSync(dir).filter((n) => /^dropped-[0-9a-f-]{36}\.count$/.test(n)).sort(); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

/**
 * What the spool holds, for `stats`: a growing backlog is a drain that is
 * failing. A read failure is reported as `error` (and becomes a capture
 * finding), never as zeros.
 */
export function spoolHealth(dir) {
  try {
    const files = pendingFiles(dir);
    let dropped = readCount(path.join(dir, 'dropped')) ?? 0;
    for (const s of droppedSnapshots(dir)) dropped += readCount(path.join(dir, s)) ?? 0;
    const oldestMs = files.length ? Number.parseInt(files[0], 10) : null;
    let rejected = 0;
    try { rejected = fs.readdirSync(path.join(dir, 'rejected')).length; } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return {
      pending: files.length,
      oldestPendingAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
      dropped,
      rejected,
    };
  } catch (err) {
    return { pending: null, oldestPendingAt: null, dropped: null, rejected: null, error: `${err.code ?? 'ERR'}: ${err.message}` };
  }
}

/**
 * Turn the dropped counter into ordinary spooled events, idempotently:
 *   1. rename `dropped` → `dropped-<uuid>.count` (an atomic snapshot; drops
 *      counted afterwards start a fresh `dropped`);
 *   2. write a synthetic event whose eventId IS that uuid;
 *   3. delete the snapshot.
 * A crash between 2 and 3 rewrites an event with the same eventId, which the
 * store dedupes, so a count is reported exactly once.
 */
function spoolDroppedCounts(dir, nowMs) {
  const live = path.join(dir, 'dropped');
  if (fs.existsSync(live)) {
    try { fs.renameSync(live, path.join(dir, `dropped-${randomUUID()}.count`)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  let reported = 0;
  for (const snap of droppedSnapshots(dir)) {
    const id = snap.slice('dropped-'.length, -'.count'.length);
    const n = readCount(path.join(dir, snap));
    if (n) {
      const ev = {
        v: TELEMETRY_VERSION, eventId: id, occurredAt: new Date(nowMs).toISOString(),
        verb: 'telemetry', mode: 'spool-full', outcome: 'error', exitCode: null, durationMs: 0,
        sessionId: null, reasonClass: 'spool full: events dropped', toolSha: null, detail: { droppedEvents: n },
      };
      const name = `${nowMs}-${id}.json`;
      const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(ev));
      fs.renameSync(tmp, path.join(dir, name));
      reported += n;
    }
    fs.unlinkSync(path.join(dir, snap));
  }
  return reported;
}

/**
 * Drain the spool.
 *
 * @param {object} opts
 * @param {string} opts.dir spool directory
 * @param {(events: object[]) => Promise<{ok: boolean, written?: number, reason?: string, error?: string}>} opts.write
 * @param {number} [opts.nowMs]
 * @returns {Promise<{ok: boolean, drained: number, rejected: number, remaining: number|null, locked?: boolean, reason?: string, error?: string, droppedReported?: number}>}
 */
export async function drainSpool({ dir, write, nowMs = Date.now() }) {
  let release;
  try {
    if (!pendingFiles(dir).length && !fs.existsSync(path.join(dir, 'dropped')) && !droppedSnapshots(dir).length) {
      return { ok: true, drained: 0, rejected: 0, remaining: 0 };
    }
    release = acquireLock(dir, nowMs);
  } catch (err) {
    return { ok: false, drained: 0, rejected: 0, remaining: null, reason: 'spool-unreadable', error: `${err.code ?? 'ERR'}: ${err.message}` };
  }
  if (!release) return { ok: true, drained: 0, rejected: 0, remaining: pendingFiles(dir).length, locked: true };
  let drained = 0;
  let rejected = 0;
  try {
    const droppedReported = spoolDroppedCounts(dir, nowMs);
    const files = pendingFiles(dir);
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const events = [];
      const names = [];
      for (const name of files.slice(i, i + BATCH_SIZE)) {
        // A READ failure is a capture fault (it throws to the caller, the event is
        // kept); only content that was read and does not parse/validate is rejected.
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        let parsed;
        try { parsed = SpooledEventSchema.safeParse(JSON.parse(text)); } catch { parsed = { success: false }; }
        if (!parsed.success) { reject(dir, name); rejected += 1; continue; }
        events.push(parsed.data);
        names.push(name);
      }
      if (!events.length) continue;
      const res = await write(events);
      if (!res?.ok) {
        return { ok: false, drained, rejected, remaining: pendingFiles(dir).length, reason: res?.reason ?? 'write-failed', error: res?.error };
      }
      for (const name of names) { try { fs.unlinkSync(path.join(dir, name)); } catch { /* idempotent re-insert next time */ } }
      drained += names.length;
    }
    return { ok: true, drained, rejected, remaining: pendingFiles(dir).length, ...(droppedReported ? { droppedReported } : {}) };
  } catch (err) {
    return { ok: false, drained, rejected, remaining: null, reason: 'spool-unreadable', error: `${err.code ?? 'ERR'}: ${err.message}` };
  } finally {
    release();
  }
}
