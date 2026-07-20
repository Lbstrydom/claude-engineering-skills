/**
 * @fileoverview Validated, TTL'd JSON disk cache shared by the arch-memory
 * consultation path.
 *
 * WHY THIS EXISTS: `normalize-intent.mjs` grew its own `loadCache`/`getCached`/
 * `putCached` trio that the duplication wave flagged as a 0.88-similarity
 * near-duplicate of the trio already in `neighbourhood-query.mjs`. Rather than
 * justify the duplicate, the shared responsibility is extracted here — which
 * also fixes the two cache findings in one place instead of two:
 *
 *   - LOAD VALIDATION. The original `loadCache()` accepted any syntactically
 *     valid JSON. `[]`, `null`, `{}` or a legacy shape all parsed fine and then
 *     blew up (or silently misbehaved) on the later `cache.entries[key]`
 *     dereference. A structurally invalid cache is now a recoverable MISS, not
 *     a latent crash on the prompt-submit hook path.
 *   - BOUNDED GROWTH. Neither cache pruned. That mattered more after the
 *     normalization provenance entered the key (plan §2.1 C2), because each
 *     intent can now occupy several entries (one per normalizer/prompt/mode
 *     combination). Entries past their TTL are dropped on write, and the file
 *     is capped.
 *
 * Deliberately NOT interprocess-locked. Concurrent hook processes can still
 * lose an update — but the loss is a cache miss and a re-embed, never
 * corruption (the write is atomic). Interprocess locking on a best-effort
 * cache would cost more than the miss it prevents; recorded as accepted debt
 * rather than silently ignored.
 *
 * @module scripts/lib/arch-memory/json-cache
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';

/** Cap on retained entries. Beyond this, the oldest are dropped on write. */
export const MAX_ENTRIES = 2000;

/**
 * Structural validation. Anything that is not `{entries: <plain object>}` is
 * treated as an empty cache rather than trusted.
 * @returns {{entries: Record<string, {savedAt:number, value:unknown}>}}
 */
export function normaliseCacheShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { entries: {} };
  const e = parsed.entries;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { entries: {} };
  return { entries: e };
}

/** A single entry is usable only if it carries a finite timestamp and a value. */
export function isUsableEntry(entry, ttlMs, now = Date.now()) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (!Number.isFinite(entry.savedAt)) return false;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  if (now - entry.savedAt > ttlMs) return false;
  return entry.value !== undefined && entry.value !== null;
}

/** Drop expired entries, then cap to the newest MAX_ENTRIES. Pure. */
export function pruneEntries(entries, ttlMs, now = Date.now(), max = MAX_ENTRIES) {
  const live = Object.entries(entries).filter(([, v]) => isUsableEntry(v, ttlMs, now));
  if (live.length <= max) return Object.fromEntries(live);
  live.sort((a, b) => b[1].savedAt - a[1].savedAt);
  return Object.fromEntries(live.slice(0, max));
}

export function loadCache(file) {
  if (!fs.existsSync(file)) return { entries: {} };
  try {
    return normaliseCacheShape(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    // Unreadable or malformed → recoverable miss, never a throw into the
    // consultation path.
    return { entries: {} };
  }
}

export function getCached(file, key, ttlMs, now = Date.now()) {
  const entry = loadCache(file).entries[key];
  return isUsableEntry(entry, ttlMs, now) ? entry.value : null;
}

export function putCached(file, key, value, ttlMs, now = Date.now()) {
  const cache = loadCache(file);
  cache.entries[key] = { value, savedAt: now };
  cache.entries = pruneEntries(cache.entries, ttlMs, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(cache, null, 2));
}
