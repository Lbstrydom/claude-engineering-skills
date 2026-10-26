/**
 * @fileoverview Local spool for the own-model ledger
 * (docs/plans/own-model-decision-ledger.md decisions 6, 9, 10): the outage-safe
 * hand-off between a producer and the store, shaped like the fleet telemetry spool.
 *
 * - One file per PREPARED event, `<event_id>.json` (UUIDv7, so name order is
 *   capture order), written to a temp name and atomically renamed.
 * - `flushSpool` takes a lock file (stale takeover), reads in batches, and deletes
 *   a file ONLY after its event was persisted, a duplicate, or refused; a corrupt
 *   file is moved to `quarantine/` and never blocks the batch.
 * - A small `state.json` caches the last-seen purge generation and per-repo
 *   eligibility flags (24 h) so a cloud-off producer can still shape correctly;
 *   past that window the flag reads `'unknown'` and content is dropped.
 * - Everything here is local files; nothing imports the store.
 *
 * @module scripts/lib/ledger/spool
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parsePersisted } from './schemas.mjs';

export const BATCH_SIZE = 200;
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const ELIGIBILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SPOOL_FILES = 5000;
export const MAX_HOOK_ERROR_LINES = 200;

const OFF = new Set(['0', 'off', 'false', 'no']);

/** Capture disabled? `OWN_MODEL_LEDGER=off` or the bundle-wide `LEARNING_DISABLE=1`. */
export function ledgerEnabled(env = process.env) {
  if (OFF.has(String(env.OWN_MODEL_LEDGER ?? '').trim().toLowerCase())) return false;
  return env.LEARNING_DISABLE !== '1';
}

/** `<git-common-dir>/own-model-ledger` for the repo at cwd (shared by every worktree). */
export function ledgerDir(cwd = process.cwd()) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return path.join(common, 'own-model-ledger');
}

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });

/**
 * Atomically publish a prepared event. Returns `spooled`, or `failed-permanent`
 * when the file cannot be written, or `failed-retryable` past the spool cap.
 * @returns {{state: 'spooled'|'failed-permanent'|'failed-retryable', file?: string, error?: string}}
 */
export function writeSpool(dir, event, { maxFiles = MAX_SPOOL_FILES } = {}) {
  try {
    ensure(dir);
    if (listSpool(dir).length >= maxFiles) return { state: 'failed-retryable', error: 'spool-full' };
    const final = path.join(dir, `${event.event_id}.json`);
    const tmp = path.join(dir, `.${event.event_id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(event));
    fs.renameSync(tmp, final);
    return { state: 'spooled', file: final };
  } catch (err) {
    return { state: 'failed-permanent', error: String(err?.message ?? err) };
  }
}

/** Spool files in capture (event_id) order. Temp files and sidecars are excluded. */
export function listSpool(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).sort();
  } catch { return []; }
}

// ── state cache: purge generation + per-repo eligibility ────────────────────
const statePath = (dir) => path.join(dir, 'state.json');

export function readState(dir) {
  try { return JSON.parse(fs.readFileSync(statePath(dir), 'utf8')); } catch { return { generation: 0, repos: {} }; }
}

/** Merge fresh observations into the cache (called on every successful store contact). */
export function writeState(dir, { generation, repo = null, sweepCursor }, nowMs = Date.now()) {
  let lock = null;
  try {
    ensure(dir);
    // Read-merge-write under a lock file: an atomic rename prevents a torn file but not two processes reading the same
    // generation and one overwriting the other's newer value. The generation is also max-merged, so a stale writer cannot
    // lower it even if the lock is ever bypassed. If the lock cannot be taken the write is skipped: this is a cache.
    lock = acquireStateLock(dir, nowMs);
    if (!lock) return;
    const s = readState(dir);
    if (Number.isFinite(generation)) s.generation = Math.max(s.generation ?? 0, generation);
    if (repo?.name) s.repos = { ...(s.repos ?? {}), [repo.name]: { flag: repo.flag, at: nowMs, id: repo.id ?? null } };
    if (sweepCursor !== undefined) s.sweepCursor = sweepCursor;
    const tmp = `${statePath(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, statePath(dir));
  } catch { /* the cache is an optimisation; failure degrades to 'unknown', never to a wrong flag */ }
  finally { if (lock) fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

const STATE_LOCK_STALE_MS = 10_000;
/** Take `state.lock` (exclusive create), retrying briefly; a lock older than 10 s is a dead holder's and is replaced. */
function acquireStateLock(dir, nowMs) {
  const lock = path.join(dir, 'state.lock');
  for (let i = 0; i < 10; i++) {
    try { fs.writeFileSync(lock, String(nowMs), { flag: 'wx' }); return lock; } catch { /* held */ }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > STATE_LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch { /* vanished */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return null;
}

/**
 * The cached flag, or `'unknown'` when absent or older than the TTL. A cached
 * `null` (undecided) is a real observation, distinct from `'unknown'`.
 */
export function cachedFlag(state, repoName, nowMs = Date.now()) {
  const r = state?.repos?.[repoName];
  if (!r || nowMs - r.at > ELIGIBILITY_TTL_MS) return { id: r?.id ?? null, flag: 'unknown' };
  return { id: r.id ?? null, flag: r.flag };
}

// ── flush ───────────────────────────────────────────────────────────────────
function acquireLock(dir, nowMs) {
  const lock = path.join(dir, 'flush.lock');
  try {
    fs.writeFileSync(lock, String(nowMs), { flag: 'wx' });
    return lock;
  } catch {
    try {
      const age = nowMs - Number(fs.readFileSync(lock, 'utf8'));
      if (Number.isFinite(age) && age > LOCK_STALE_MS) { fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return acquireLock(dir, nowMs + 1); }
    } catch { /* lock vanished: the holder finished */ }
    return null;
  }
}

/**
 * Drain the spool through `write(events) -> {ok, receipts, generation}`.
 * @param {{dir: string, write: (events: object[]) => Promise<{ok: boolean, reason?: string, receipts: Array<{event_id: string, state: string}>, generation?: number}>, nowMs?: number}} a
 * @returns {Promise<{locked: boolean, persisted: number, duplicate: number, refused: number, quarantined: number, remaining: number, error?: string}>}
 */
export async function flushSpool({ dir, write, nowMs = Date.now() }) {
  const out = { locked: false, persisted: 0, duplicate: 0, refused: 0, quarantined: 0, remaining: 0 };
  ensure(dir);
  const lock = acquireLock(dir, nowMs);
  if (!lock) return { ...out, locked: true, remaining: listSpool(dir).length };
  try {
    const files = listSpool(dir);
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = [];
      for (const f of files.slice(i, i + BATCH_SIZE)) {
        const p = path.join(dir, f);
        // Quarantine on the PERSISTED CONTRACT, not on JSON syntax: a UUID-named file holding `null` (or any valid-JSON
        // non-event) must never reach the writer as an event.
        let event = null;
        try { const parsed = parsePersisted(JSON.parse(fs.readFileSync(p, 'utf8'))); event = parsed.ok ? parsed.event : null; } catch { event = null; }
        if (event) batch.push({ f, p, event });
        else {
          ensure(path.join(dir, 'quarantine'));
          try { fs.renameSync(p, path.join(dir, 'quarantine', f)); } catch { /* already gone */ }
          out.quarantined++;
        }
      }
      if (batch.length === 0) continue;
      let res;
      try { res = await write(batch.map((b) => b.event)); } catch (err) { return { ...out, remaining: listSpool(dir).length, error: String(err?.message ?? err) }; }
      if (!res.ok) return { ...out, remaining: listSpool(dir).length, error: res.reason ?? 'write-failed' };
      if (Number.isFinite(res.generation)) writeState(dir, { generation: res.generation }, nowMs);
      const settled = new Set();
      for (const r of res.receipts) {
        if (r.state === 'persisted') out.persisted++; else if (r.state === 'duplicate') out.duplicate++; else out.refused++;
        settled.add(r.event_id);
      }
      for (const b of batch) {
        if (!settled.has(b.event.event_id)) continue;   // unsettled stays for the next flush
        fs.rmSync(b.p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    }
    out.remaining = listSpool(dir).length;
    return out;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

// ── purge, status, hook errors ──────────────────────────────────────────────
/**
 * Remove local copies (spool + quarantine) matching a purge scope.
 * @returns {number} files removed
 */
export function purgeLocal(dir, { workItem = null, repo = null }, nowMs = Date.now()) {
  let n = 0;
  const rm = (p) => { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); n++; };
  for (const sub of ['', 'quarantine']) {
    const d = sub ? path.join(dir, sub) : dir;
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const f of names) {
      const p = path.join(d, f);
      const isEvent = /^[0-9a-f-]{36}\.json$/.test(f);
      // A crash between write and rename leaves `.<id>.<pid>.tmp` holding a full event body. Anything older than a minute
      // is orphaned (a live write is milliseconds), and it can carry purged content, so a purge removes it.
      if (!sub && /^\..*\.tmp$/.test(f)) { try { if (nowMs - fs.statSync(p).mtimeMs > 60_000) rm(p); } catch { /* gone */ } continue; }
      if (!isEvent) continue;
      try {
        const e = JSON.parse(fs.readFileSync(p, 'utf8'));
        if ((workItem && e?.work_item_id === workItem) || (repo && (e?.repo_name === repo || e?.repo_id === repo))) rm(p);
        // Flush quarantines on the persisted CONTRACT, so a quarantined file can be valid JSON that is not an event. Such a
        // file has no trustworthy scope either, and is just as unusable: a purge clears it too.
        else if (sub === 'quarantine' && !parsePersisted(e).ok) rm(p);
      } catch {
        // Unparseable: its scope cannot be known, and a quarantined file is unusable by definition, so a purge clears it
        // rather than leaving possibly-purged content behind. An unparseable file in the live spool is left (never guessed at).
        if (sub === 'quarantine') rm(p);
      }
    }
  }
  return n;
}

const hookLog = (dir) => path.join(dir, 'hook-errors.log');

/** Append a bounded hook failure line (observability for a hook that must never change exit codes). */
export function appendHookError(dir, message, nowMs = Date.now()) {
  try {
    ensure(dir);
    const line = `${new Date(nowMs).toISOString()} ${String(message).replace(/\s+/g, ' ').slice(0, 300)}`;
    let lines = [];
    try { lines = fs.readFileSync(hookLog(dir), 'utf8').split('\n').filter(Boolean); } catch { /* first error */ }
    lines.push(line);
    fs.writeFileSync(hookLog(dir), `${lines.slice(-MAX_HOOK_ERROR_LINES).join('\n')}\n`);
  } catch { /* nothing more can be done from inside a failing hook */ }
}

/** Local backlog health. `null` counts mean UNMEASURED (the directory does not exist), never zero. */
export function spoolStatus(dir) {
  if (!fs.existsSync(dir)) return { spooled: null, quarantined: null, hookErrors: null, generation: null };
  let q = 0;
  try { q = fs.readdirSync(path.join(dir, 'quarantine')).length; } catch { /* none */ }
  let h = 0;
  try { h = fs.readFileSync(hookLog(dir), 'utf8').split('\n').filter(Boolean).length; } catch { /* none */ }
  return { spooled: listSpool(dir).length, quarantined: q, hookErrors: h, generation: readState(dir).generation ?? 0 };
}
