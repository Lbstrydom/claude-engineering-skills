/**
 * @fileoverview The count of open, un-acked upstream issues, shown beside the findings queue in `fleet status` and `fleet next`.
 *
 * Why (finding p-20261015045126-5696): consumer reports never reach `fleet proposals`, so upstream 57bd3de9 sat untriaged
 * overnight while the coordinator's check-ins showed an empty queue. This puts the other queue where the coordinator already looks.
 *
 * **Source repo only.** Consumers FILE reports; this repo triages them, and the reader (`scripts/upstream-queues.mjs`) fans out
 * over every registered consumer's own store through a registry whose private half exists only here. In a consumer the line is
 * ABSENT, never `0`.
 *
 * **Unmeasured is never zero.** `status` is the only verb that runs the reader (up to 30 s; a bounded child process); it writes a
 * cache beside the unregistered-work cache, and `next` reads only that cache (the same split the unregistered-work footer uses).
 * The cache keeps measured / partial / unmeasured apart, with separate `measuredAt` and `attemptedAt`, so a failed refresh never
 * leaves yesterday's `0` standing as today's count: the last success is kept as labelled history, not as the current number.
 * ONE renderer (`renderUpstreamLine`) serves both verbs, so they cannot disagree.
 *
 * @module scripts/lib/fleet/upstream-count
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';

export const UPSTREAM_CACHE_FILE = 'upstream-count.json';
export const UPSTREAM_CACHE_SCHEMA_VERSION = 1;
/** A cache older than this is said to be stale, not silently trusted. */
export const UPSTREAM_STALE_MS = 24 * 60 * 60 * 1000;
/** The reader fans out over every store; a wedged store must not stall `status` for long. */
export const UPSTREAM_RUN_TIMEOUT_MS = 30_000;

const History = z.object({ totalOpen: z.number().int().nonnegative(), measuredAt: z.string() }).strict();
const CacheSchema = z.object({
  schemaVersion: z.literal(UPSTREAM_CACHE_SCHEMA_VERSION),
  state: z.enum(['measured', 'partial', 'unmeasured']),
  totalOpen: z.number().int().nonnegative().nullable(),
  storesQueried: z.number().int().nonnegative(),
  storesUnqueried: z.number().int().nonnegative(),
  reason: z.string().nullable(),
  measuredAt: z.string().nullable(),
  attemptedAt: z.string(),
  lastMeasured: History.nullable(),
}).strict();

const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now());
const iso = (now) => new Date(toMs(now)).toISOString();

/** The reader's script in the MAIN checkout (a linked worktree has no private registry), or null when this is not the source repo. */
export function upstreamScript(fleetDir) {
  if (!fleetDir) return null;
  const common = path.dirname(fleetDir);                       // <git-common-dir>
  const root = path.basename(common) === '.git' ? path.dirname(common) : null;
  if (!root) return null;
  const script = path.join(root, 'scripts', 'upstream-queues.mjs');
  return fs.existsSync(script) ? script : null;
}

/**
 * Interpret the reader's `--json` envelope. Pure.
 * `{storesQueried, storesUnqueried, totalOpen, unresolved}` -> a cache-shaped measurement, never a bare number.
 */
export function interpretQueues(env) {
  if (!env || typeof env !== 'object') return { state: 'unmeasured', reason: 'the reader printed no envelope' };
  const q = Number(env.storesQueried), u = Number(env.storesUnqueried), open = Number(env.totalOpen);
  if (![q, u, open].every(Number.isFinite)) return { state: 'unmeasured', reason: 'the reader\'s envelope was malformed' };
  const unresolved = Array.isArray(env.unresolved) ? env.unresolved.length : 0;
  if (q === 0) return { state: 'unmeasured', reason: 'no store answered (NOTHING WAS CHECKED)', storesQueried: 0, storesUnqueried: u + unresolved };
  const missing = u + unresolved;
  return { state: missing > 0 ? 'partial' : 'measured', totalOpen: open, storesQueried: q, storesUnqueried: missing, reason: missing > 0 ? `${missing} store(s) could not be queried` : null };
}

/**
 * Run the reader once. Never throws: a failure is an `unmeasured` measurement with its reason.
 * @param {string} script
 * @param {{spawn?: Function}} [o] injected for tests
 */
export function runUpstreamQueues(script, { spawn = spawnSync } = {}) {
  let r;
  try { r = spawn(process.execPath, [script, '--json'], { encoding: 'utf8', timeout: UPSTREAM_RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { return { state: 'unmeasured', reason: `could not run the reader (${e.message})` }; }
  if (!r || r.error) return { state: 'unmeasured', reason: `could not run the reader (${r?.error?.code ?? r?.error?.message ?? 'no result'})` };
  if (r.status !== 0) return { state: 'unmeasured', reason: `the reader exited ${r.status}` };
  const text = String(r.stdout ?? '');
  const start = text.indexOf('{');
  if (start < 0) return { state: 'unmeasured', reason: 'the reader printed no JSON' };
  try { return interpretQueues(JSON.parse(text.slice(start))); } catch { return { state: 'unmeasured', reason: 'the reader\'s output was not valid JSON' }; }
}

/** Read the cache: `{state:'missing'|'unreadable'|'ok', record?, reason?}`. Never throws. */
export function readUpstreamCache(dir) {
  if (!dir) return { state: 'unreadable', reason: 'the git common dir could not be resolved' };
  let text;
  try { text = fs.readFileSync(path.join(dir, UPSTREAM_CACHE_FILE), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', reason: e.code ?? e.message };
  }
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? { state: 'ok', record: parsed.data } : { state: 'unreadable', reason: 'schema mismatch' };
  } catch (e) { return { state: 'unreadable', reason: e.message }; }
}

/**
 * The next cache record from a measurement and the previous record. Pure.
 * `measuredAt` moves only on a SUCCESSFUL measurement; a failed one keeps the last success as `lastMeasured` (history),
 * and `attemptedAt` always moves.
 */
export function nextRecord(measurement, previous, now) {
  const at = iso(now);
  const ok = measurement.state === 'measured' || measurement.state === 'partial';
  const prevHistory = previous
    ? (previous.state === 'measured' && previous.measuredAt ? { totalOpen: previous.totalOpen, measuredAt: previous.measuredAt } : previous.lastMeasured)
    : null;
  return {
    schemaVersion: UPSTREAM_CACHE_SCHEMA_VERSION,
    state: measurement.state,
    totalOpen: ok ? measurement.totalOpen : null,
    storesQueried: measurement.storesQueried ?? 0,
    storesUnqueried: measurement.storesUnqueried ?? 0,
    reason: measurement.reason ?? null,
    measuredAt: ok ? at : (previous?.measuredAt ?? null),
    attemptedAt: at,
    lastMeasured: ok ? null : (prevHistory ?? null),
  };
}

/**
 * `status`'s refresh: run the reader, merge with the previous cache, write. Never throws.
 * @returns {{applicable: boolean, record?: object, written?: boolean, warning?: string}}
 */
export function refreshUpstreamCache({ fleetDir, now, run = runUpstreamQueues }) {
  const script = upstreamScript(fleetDir);
  if (!script) return { applicable: false };
  const prev = readUpstreamCache(fleetDir);
  const record = nextRecord(run(script), prev.state === 'ok' ? prev.record : null, now);
  try {
    CacheSchema.parse(record);
    fs.mkdirSync(fleetDir, { recursive: true });
    atomicWriteFileSync(path.join(fleetDir, UPSTREAM_CACHE_FILE), `${JSON.stringify(record, null, 2)}\n`);
    return { applicable: true, record, written: true };
  } catch (e) { return { applicable: true, record, written: false, warning: `upstream-count cache not written (${e.message})` }; }
}

const ageText = (ms) => (ms < 90 * 60 * 1000 ? `${Math.max(1, Math.round(ms / 60000))}m` : `${Math.round(ms / 3600000)}h`);

/**
 * The ONE line `status` and `next` print. `read` is `readUpstreamCache`'s result (or `{state:'ok', record}`).
 * Returns null when the line does not apply (not the source repo).
 */
export function renderUpstreamLine(read, now, cmd = 'fleet', { applicable = true } = {}) {
  if (!applicable) return null;
  if (!read || read.state === 'missing') return `upstream: not measured yet — run \`${cmd} status\` (a missing measurement is not zero)`;
  if (read.state !== 'ok') return `upstream: UNMEASURED (cache ${read.reason ?? read.state}) — run \`${cmd} status\``;
  const r = read.record;
  const stale = toMs(now) - Date.parse(r.measuredAt ?? r.attemptedAt) > UPSTREAM_STALE_MS ? ` — stale, measured ${ageText(toMs(now) - Date.parse(r.measuredAt ?? r.attemptedAt))} ago: run \`${cmd} status\`` : '';
  const n = r.totalOpen;
  const triage = n > 0 ? ' — triage: `npm run upstream:issues`' : '';
  if (r.state === 'measured') return `upstream: ${n === 0 ? 'none open' : `${n} open (un-acked)`} across ${r.storesQueried} store(s)${triage}${stale}`;
  if (r.state === 'partial') return `upstream: ≥${n} open (un-acked) across the ${r.storesQueried} store(s) that answered; ${r.storesUnqueried} unqueried${triage}${stale}`;
  const hist = r.lastMeasured ? `; last measured ${r.lastMeasured.totalOpen} at ${r.lastMeasured.measuredAt}` : '';
  return `upstream: UNMEASURED (${r.reason ?? 'unknown'}${hist})${stale}`;
}

/** Nothing worth a checkpoint line: measured, fresh, and none open. */
export function upstreamQuiet(read, now) {
  return Boolean(read && read.state === 'ok' && read.record.state === 'measured' && read.record.totalOpen === 0
    && toMs(now) - Date.parse(read.record.measuredAt ?? read.record.attemptedAt) <= UPSTREAM_STALE_MS);
}
