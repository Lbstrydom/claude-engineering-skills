/**
 * @fileoverview "N merged PRs unrecorded" — the ship record catch-up's nudge in `fleet status`, `fleet next` and after
 * `fleet land` (docs/plans/ship-record-catchup.md §2.7).
 *
 * Coordinators land PRs without /ship, so the session log goes stale with nobody noticing (storyline's sat untouched for
 * 325 commits). This puts the count where the coordinator already looks.
 *
 * **fleet never imports the ship domain** (`allowedDeps`: fleet → shared-lib only). `status` runs the SIBLING CLI
 * `ship-record.mjs status --json` as a bounded child — located next to this module's own tree, so it resolves in the source
 * layout (`scripts/`) and in a consumer's synced `scripts/.claude-skills/` alike — and writes a cache; `next` reads only the
 * cache (the upstream-count split). ONE renderer serves every surface, and the next command it prints is the CLI's own
 * `remedy`, never re-derived here, so the two cannot disagree.
 *
 * **Unmeasured is never zero.** A missing script, a failed child, a malformed envelope, a state that is not measured: each
 * renders as what it is. `measuredAt` moves only on a measurement; `attemptedAt` always does.
 *
 * @module scripts/lib/fleet/record-count
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { withFileLockSync } from '../file-lock.mjs';

export const RECORD_CACHE_FILE = 'record-count.json';
export const RECORD_CACHE_SCHEMA_VERSION = 1;
export const RECORD_STALE_MS = 24 * 60 * 60 * 1000;
/** The child lists merged PRs from GitHub; a wedged gh must not stall `status` for long. */
export const RECORD_RUN_TIMEOUT_MS = 60_000;
export const RECORD_STATES = Object.freeze(['measured', 'partial', 'unmeasured', 'no-floor', 'ambiguous-floor', 'no-marker']);

const CacheSchema = z.object({
  schemaVersion: z.literal(RECORD_CACHE_SCHEMA_VERSION),
  state: z.enum(RECORD_STATES),
  unrecorded: z.number().int().nonnegative().nullable(),
  unknown: z.number().int().nonnegative().nullable(),
  floorThrough: z.string().nullable(),
  reason: z.string().nullable(),
  remedy: z.string().nullable(),
  measuredAt: z.string().nullable(),
  attemptedAt: z.string(),
}).strict().superRefine((r, ctx) => {
  // One invariant for every state, enforced where the cache is written AND read (C-R1-M2).
  const counted = r.state === 'measured' || r.state === 'partial';
  if (counted && (r.unrecorded === null || r.unknown === null)) ctx.addIssue({ code: 'custom', message: `${r.state} needs both counts` });
  if (!counted && (r.unrecorded !== null || r.unknown !== null)) ctx.addIssue({ code: 'custom', message: `${r.state} carries no counts` });
  if (r.state === 'measured' && r.unknown !== 0) ctx.addIssue({ code: 'custom', message: 'measured means nothing undeterminable' });
});

const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now());
const iso = (now) => new Date(toMs(now)).toISOString();

/** The sibling CLI: `<this tree>/ship-record.mjs` (lib/fleet/ is two levels below it in both layouts). */
export function recordScript(here = path.dirname(fileURLToPath(import.meta.url))) {
  return path.resolve(here, '..', '..', 'ship-record.mjs');
}

/**
 * Interpret `ship-record status --json`. Pure; NO coercion (Number(null) is 0, which would read as a measured zero).
 * @returns {{state: string, unrecorded: number|null, unknown: number|null, floorThrough: string|null, reason: string|null, remedy: string|null}}
 */
export function interpretRecordStatus(env) {
  const bad = (reason) => ({ state: 'unmeasured', unrecorded: null, unknown: null, floorThrough: null, reason, remedy: null });
  if (!env || typeof env !== 'object' || env.verb !== 'status') return bad('the reader printed no status envelope');
  if (env.ok !== true) return bad(`the reader reported failure${typeof env.reason === 'string' ? ` (${env.reason})` : ''}`); // C-R1-H2
  if (!RECORD_STATES.includes(env.state)) return bad(`the reader reported an unknown state ${JSON.stringify(env.state)}`);
  const isCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const measured = env.state === 'measured' || env.state === 'partial';
  const c = env.counts ?? {};
  if (measured && (!isCount(c.unrecorded) || !isCount(c.unknown))) return bad('the reader\'s envelope was malformed (a counter was missing or not a whole number)');
  // A "measured" claim with undeterminable PRs is not complete (C-R1-H1/M2): it reads partial, never clean.
  const state = env.state === 'measured' && c.unknown > 0 ? 'partial' : env.state;
  return {
    state,
    unrecorded: measured ? c.unrecorded : null,
    unknown: measured ? c.unknown : null,
    floorThrough: typeof env.floor?.mergedThrough === 'string' ? env.floor.mergedThrough : null,
    reason: typeof env.reason === 'string' ? env.reason : null,
    remedy: typeof env.remedy === 'string' ? env.remedy : null,
  };
}

/** Run the reader once. Never throws: a failure is an `unmeasured` measurement with its reason. */
export function runRecordStatus(script, cwd, { spawn = spawnSync } = {}) {
  const bad = (reason) => ({ state: 'unmeasured', unrecorded: null, unknown: null, floorThrough: null, reason, remedy: null });
  if (!script || !fs.existsSync(script)) return bad('ship-record.mjs not found beside fleet — re-sync the tooling');
  let r;
  try { r = spawn(process.execPath, [script, 'status', '--json'], { cwd, encoding: 'utf8', timeout: RECORD_RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { return bad(`could not run the reader (${e.message})`); }
  if (!r || r.error) return bad(`could not run the reader (${r?.error?.code ?? r?.error?.message ?? 'no result'})`);
  if (r.status !== 0) return bad(`the reader exited ${r.status}`);
  const text = String(r.stdout ?? '');
  const start = text.indexOf('{');
  if (start < 0) return bad('the reader printed no JSON');
  try { return interpretRecordStatus(JSON.parse(text.slice(start))); } catch { return bad('the reader\'s output was not valid JSON'); }
}

/** Read the cache: `{state:'missing'|'unreadable'|'ok', record?, reason?}`. Never throws. */
export function readRecordCache(dir) {
  if (!dir) return { state: 'unreadable', reason: 'the git common dir could not be resolved' };
  let text;
  try { text = fs.readFileSync(path.join(dir, RECORD_CACHE_FILE), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', reason: e.code ?? e.message };
  }
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? { state: 'ok', record: parsed.data } : { state: 'unreadable', reason: 'schema mismatch' };
  } catch (e) { return { state: 'unreadable', reason: e.message }; }
}

/** The next cache record. Pure. `measuredAt` moves only when the reader answered (any state but unmeasured). */
export function nextRecordCache(m, previous, now) {
  const at = iso(now);
  const answered = m.state !== 'unmeasured';
  return {
    schemaVersion: RECORD_CACHE_SCHEMA_VERSION, state: m.state, unrecorded: m.unrecorded ?? null, unknown: m.unknown ?? null,
    floorThrough: m.floorThrough ?? null, reason: m.reason ?? null, remedy: m.remedy ?? null,
    measuredAt: answered ? at : (previous?.measuredAt ?? null), attemptedAt: at,
  };
}

/** `status`'s refresh: run the reader, write the cache. Never throws. */
export function refreshRecordCache({ cacheDir, cwd, now, run = runRecordStatus, script = recordScript() }) {
  const prev = readRecordCache(cacheDir);
  const startedAt = now ?? new Date(); // stamped at the START, before the child runs (C-R2-H1: never at write time)
  const record = nextRecordCache(run(script, cwd), prev.state === 'ok' ? prev.record : null, startedAt);
  try {
    CacheSchema.parse(record);
    if (!cacheDir) return { record, written: false, warning: 'record-count cache not written (the git common dir could not be resolved)' };
    fs.mkdirSync(cacheDir, { recursive: true });
    // Two overlapping `status` runs: the one that STARTED later wins (C-R1-M3), and the compare and the write happen under
    // one lock so an older run cannot slip in between them (C-R2-H1).
    const held = withFileLockSync(path.join(cacheDir, `${RECORD_CACHE_FILE}.lock`), { attempts: 20 }, () => {
      const latest = readRecordCache(cacheDir);
      if (latest.state === 'ok' && Date.parse(latest.record.attemptedAt) > Date.parse(record.attemptedAt)) return { record: latest.record, written: false };
      atomicWriteFileSync(path.join(cacheDir, RECORD_CACHE_FILE), `${JSON.stringify(record, null, 2)}\n`);
      return { record, written: true };
    });
    return held.ok ? held.value : { record, written: false, warning: 'record-count cache not written (another status run held its lock)' };
  } catch (e) { return { record, written: false, warning: `record-count cache not written (${e.message})` }; }
}

const ageText = (ms) => (ms < 90 * 60 * 1000 ? `${Math.max(1, Math.round(ms / 60000))}m` : `${Math.round(ms / 3600000)}h`);

/** The ONE line `status`, `next` and the checkpoint footer print. `read` is readRecordCache's result (or `{state:'ok', record}`). */
export function renderRecordLine(read, now, cmd = 'fleet') {
  if (!read || read.state === 'missing') return `records: not measured yet — run \`${cmd} status\` (a missing measurement is not zero)`;
  if (read.state !== 'ok') return `records: UNMEASURED (cache ${read.reason ?? read.state}) — run \`${cmd} status\``;
  const r = read.record;
  const when = Date.parse(r.measuredAt ?? r.attemptedAt);
  const stale = toMs(now) - when > RECORD_STALE_MS ? ` — stale, measured ${ageText(toMs(now) - when)} ago: run \`${cmd} status\`` : '';
  const next = r.remedy ? ` — ${r.remedy}` : '';
  if (r.state === 'measured' || r.state === 'partial') {
    const floor = r.floorThrough ? ` since the floor (${r.floorThrough})` : '';
    const unk = r.unknown ? `; ${r.unknown} not yet determinable` : '';
    if (r.unrecorded === 0 && r.state === 'measured' && r.unknown === 0) return `records: every merged PR is recorded${floor}${stale}`;
    const n = r.state === 'partial' ? `≥${r.unrecorded}` : String(r.unrecorded);
    return `records: ${n} merged PR(s) unrecorded${floor}${unk}${next} (coordinator)${stale}`;
  }
  if (r.state === 'no-floor' || r.state === 'no-marker') return `records: not initialised${next}${stale}`;
  if (r.state === 'ambiguous-floor') return `records: AMBIGUOUS (${r.reason ?? 'more than one floor'})${next}${stale}`;
  return `records: UNMEASURED (${r.reason ?? 'unknown'})${stale}`;
}

/** Nothing worth a checkpoint line: measured, fresh, and none unrecorded. */
export function recordQuiet(read, now) {
  return Boolean(read && read.state === 'ok' && read.record.state === 'measured' && read.record.unrecorded === 0 && read.record.unknown === 0
    && toMs(now) - Date.parse(read.record.measuredAt ?? read.record.attemptedAt) <= RECORD_STALE_MS);
}

/** The sibling ship-record command for a fleet command (`node scripts/fleet.mjs` → `node scripts/ship-record.mjs`). */
export const recordCommandFor = (fleetCmd) => String(fleetCmd ?? 'node scripts/fleet.mjs').replace(/fleet\.mjs("?)$/, 'ship-record.mjs$1');

/** The line `fleet land` prints after a merge: the count is stale the moment a PR lands, so it names the action, not a number. */
export const LAND_RECORD_NUDGE = (recordCmd, fleetCmd) => `records: this landing merged PR(s) without /ship — record them: \`${recordCmd} catchup --write\` (coordinator); \`${fleetCmd} status\` re-measures`;
