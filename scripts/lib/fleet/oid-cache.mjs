/**
 * @fileoverview A persistent cache for git answers that are PURE FUNCTIONS OF
 * COMMIT IDS — merge-bases, the files a branch changed since its merge-base, its
 * patch-id, first-parent counts, ancestry, the squash patch-id window of a base
 * commit. Git objects are immutable, so an answer keyed by full object ids can
 * never go stale; only a key that names a ref (which moves) would.
 *
 * Why: `fleet status` re-derived these for every branch on every run — on this
 * repo 62 branches × (merge-base, diff, patch-id, count) ≈ 250 git processes per
 * status, nearly all for branches whose tips had not moved since the last run
 * (measured 2026-10-10: 18 s with 338 subprocesses). With the cache, a re-run
 * pays only for branches or bases that actually moved.
 *
 * Rules:
 *  - A key is accepted only when EVERY input is a full object id (`isOid`); a ref
 *    name, a short sha or anything else bypasses the cache and computes live.
 *  - Ids pin the objects but not the GRAPH a traversal sees: a shallow boundary,
 *    `info/grafts` or `refs/replace/*` can change a merge-base or a count for the
 *    same ids. In a repository with any of them the cache is not used at all
 *    (`topologyStable`) — they are rare, and every answer there is computed live.
 *  - A hit is VALIDATED by the caller's shape check before it is used; a value
 *    that fails it (a hand-edited or foreign file) is recomputed, never trusted.
 *  - Only a successful answer is stored; a failure is never cached.
 *  - The file lives BESIDE the registry (`<git-common-dir>/fleet-cache/`), so
 *    reading status still never creates `fleet/`.
 *  - It is a cache: an unreadable, corrupt or foreign-version file is ignored (and
 *    replaced on the next write); a lost race between two writers loses entries,
 *    never correctness. Bounded at MAX_ENTRIES, least-recently-used dropped.
 *  - `FLEET_CACHE=off` disables it (tests that COUNT git processes set it).
 *
 * @module scripts/lib/fleet/oid-cache
 */
import fs from 'node:fs';
import path from 'node:path';
import { isOid } from './contracts.mjs';

export const CACHE_VERSION = 1;
export const MAX_ENTRIES = 20_000;
const OFF = new Set(['0', 'off', 'false', 'no']);

export const cacheEnabled = (env = process.env) => !OFF.has(String(env.FLEET_CACHE ?? '').trim().toLowerCase());
export const cacheFile = (commonDir) => path.join(commonDir, 'fleet-cache', 'oid-results.json');

/**
 * Is the commit graph a pure function of object ids here? No when the repository
 * is shallow, has grafts, or has replace refs (loose or packed) — cheap fs checks,
 * no git process.
 */
export function topologyStable(commonDir) {
  try {
    if (fs.existsSync(path.join(commonDir, 'shallow'))) return false;
    if (fs.existsSync(path.join(commonDir, 'info', 'grafts'))) return false;
    const replaceDir = path.join(commonDir, 'refs', 'replace');
    if (fs.existsSync(replaceDir) && fs.readdirSync(replaceDir).length > 0) return false;
    const packed = path.join(commonDir, 'packed-refs');
    if (fs.existsSync(packed) && fs.readFileSync(packed, 'utf8').includes(' refs/replace/')) return false;
    return true;
  } catch {
    return false; // cannot tell: do not cache
  }
}

/**
 * One cache over one file. `get`/`put` are in memory; `flush` writes once.
 * @param {string} file
 * @param {{now?: () => number, maxEntries?: number}} [opts]
 */
export function createOidCache(file, { now = Date.now, maxEntries = MAX_ENTRIES } = {}) {
  let entries = null; // Map key -> {v, t}
  let dirty = false;
  // The cap holds IN MEMORY too: past it, the least recently used entries are dropped.
  const evict = () => {
    if (entries.size <= maxEntries) return;
    const drop = [...entries.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, entries.size - maxEntries);
    for (const [k] of drop) entries.delete(k);
  };
  const load = () => {
    if (entries) return;
    entries = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.version === CACHE_VERSION && raw.entries && typeof raw.entries === 'object') {
        for (const [k, e] of Object.entries(raw.entries)) if (e && 'v' in e) entries.set(k, { v: e.v, t: Number(e.t) || 0 });
      }
    } catch { /* absent or unreadable: start empty */ }
    evict();
  };
  return {
    get(key) {
      load();
      const e = entries.get(key);
      if (!e) return undefined;
      e.t = now(); dirty = true;
      return e.v;
    },
    put(key, value) {
      load();
      entries.set(key, { v: value, t: now() }); dirty = true;
      evict();
    },
    delete(key) { load(); if (entries.delete(key)) dirty = true; },
    get size() { load(); return entries.size; },
    flush() {
      if (!dirty || !entries) return { written: false };
      const kept = [...entries.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, maxEntries);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(kept) }));
        fs.renameSync(tmp, file);
        dirty = false;
        return { written: true, entries: kept.length };
      } catch (err) {
        return { written: false, reason: err.message };
      }
    },
  };
}

const caches = new Map(); // commonDir -> cache
const stable = new Map(); // commonDir -> topologyStable (once per process)
let exitHooked = false;

/** The process-wide cache for a repository's common dir; flushed at exit as a backstop. */
export function cacheFor(commonDir) {
  let c = caches.get(commonDir);
  if (!c) {
    c = createOidCache(cacheFile(commonDir));
    caches.set(commonDir, c);
    if (!exitHooked) {
      exitHooked = true;
      process.on('exit', flushAllCaches);
    }
  }
  return c;
}

export function flushAllCaches() {
  for (const c of caches.values()) c.flush();
}

/** Test hook. */
export function _resetOidCaches() { caches.clear(); stable.clear(); }

/** Shape checks for cached values, one per operation. */
export const VALID = Object.freeze({
  oids: (v) => Array.isArray(v) && v.every(isOid),
  oid: (v) => isOid(v),
  files: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  patchId: (v) => v === null || isOid(v),
  count: (v) => Number.isInteger(v) && v >= 0,
  bool: (v) => typeof v === 'boolean',
  squash: (v) => Boolean(v) && typeof v.complete === 'boolean' && Array.isArray(v.pairs)
    && v.pairs.every((p) => Array.isArray(p) && p.length === 2 && isOid(p[0]) && isOid(p[1])),
});

/**
 * Memoise a pure git answer. `oids` must ALL be full object ids or the call is
 * computed live, uncached. `compute()` returns `{ok, value}`; only `ok` answers
 * are stored.
 * @template T
 * @param {{commonDir: string|null, op: string, oids: string[], compute: () => {ok: boolean, value?: T},
 *   valid?: (v: unknown) => boolean, env?: NodeJS.ProcessEnv}} a - `valid` checks a HIT's shape
 * @returns {{ok: boolean, value?: T, cached: boolean}}
 */
export function memoPure({ commonDir, op, oids, compute, valid = () => true, env = process.env }) {
  if (!commonDir || !cacheEnabled(env) || !oids.length || !oids.every(isOid)) return { ...compute(), cached: false };
  if (!stable.has(commonDir)) stable.set(commonDir, topologyStable(commonDir));
  if (!stable.get(commonDir)) return { ...compute(), cached: false };
  const cache = cacheFor(commonDir);
  const key = `${op}:${oids.join(':')}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    if (valid(hit)) return { ok: true, value: hit, cached: true };
    cache.delete(key); // malformed (hand-edited, foreign): recompute
  }
  const r = compute();
  if (r.ok) cache.put(key, r.value);
  return { ...r, cached: false };
}
