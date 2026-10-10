/**
 * @fileoverview fleet telemetry, capture side: one small event per CLI
 * invocation, appended to a local spool beside the shared registry
 * (`<git-common-dir>/fleet-telemetry/`, a SIBLING of `fleet/`, so recording usage
 * never creates or changes the registry itself). No network, no
 * store import, nothing on stdout: fleet's own latency and output never change.
 *
 * Why a spool. fleet runs interactively and is polled; a direct store write on
 * every `status` would add a connection (and a timeout when the store is down)
 * to the hot path. The spool write is one small file. A detached
 * `cross-skill.mjs fleet-telemetry flush` drains it to `fleet_events`
 * (lib/fleet/telemetry-drain.mjs), idempotently by `eventId`.
 *
 * What is recorded: the verb and its mode, the outcome and exit code, wall time,
 * a HASH of the fleet session id (session ids are usually branch names; the hash
 * still groups a session's events), a normalised reason class (ids, shas, paths and numbers
 * stripped so reasons aggregate), and COUNTS — array lengths, booleans, a few
 * enum strings. Never free text, file paths or branch names.
 *
 * Off switch: `FLEET_TELEMETRY=off` (or `LEARNING_DISABLE=1`, the bundle-wide
 * telemetry kill switch). Under `node --test` the spool is still written (into
 * the test repo) but no drain is ever spawned, so tests cannot reach a store.
 *
 * Plan: docs/plans/fleet-telemetry.md.
 *
 * @module scripts/lib/fleet/telemetry
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TELEMETRY_VERSION = 1;
/** Spool cap: past this many pending events a new one is counted as dropped, not written. */
export const MAX_SPOOL_FILES = 5000;
/** A drain lock older than this is stale (the drainer died) and may be taken over. */
export const DRAIN_LOCK_STALE_MS = 10 * 60 * 1000;
/** Spawn at most one drainer per this interval; events in between wait in the spool. */
export const DRAIN_SPAWN_INTERVAL_MS = 60 * 1000;

const OFF = new Set(['0', 'off', 'false', 'no']);

/** @param {NodeJS.ProcessEnv} env */
export function telemetryEnabled(env) {
  if (OFF.has(String(env.FLEET_TELEMETRY ?? '').trim().toLowerCase())) return false;
  return env.LEARNING_DISABLE !== '1';
}

/** The spool sits beside the registry, never inside it: `status` must not create `fleet/`. */
export const spoolDir = (fleetDirPath) => path.join(path.dirname(fleetDirPath), 'fleet-telemetry');

/**
 * Is `dir` the spool of the repository whose registry is `fleetDirPath`? Both
 * sides are realpath'd (a symlinked path names the same directory); case folds
 * only where the filesystem does (Windows, macOS default) — on a case-sensitive
 * one, /work/Repo and /work/repo are different repositories. The drain deletes
 * the files it sends and scopes rows to the cwd's repo, so a spool that is not
 * this repo's own must never be accepted.
 */
export function isOwnSpool(fleetDirPath, dir) {
  const canon = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const key = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? canon(p).toLowerCase() : canon(p));
  return key(spoolDir(fleetDirPath)) === key(dir);
}
const droppedFile = (dir) => path.join(dir, 'dropped');
const lockFile = (dir) => path.join(dir, 'drain.lock');
const spawnMarker = (dir) => path.join(dir, 'drain.requested');

/** Which form of a verb ran — `land --approve` and `land --dry-run` are different operations. */
export function modeOf(verb, flags = {}, positionals = []) {
  const has = (f) => flags[f] !== undefined && flags[f] !== false;
  switch (verb) {
    case 'land':
      for (const f of ['--approve', '--confirm', '--reconcile', '--resume', '--abandon']) {
        if (has(f)) return `${f.slice(2)}${has('--serial') ? '-serial' : ''}`;
      }
      return has('--dry-run') ? 'dry-run' : 'build';
    case 'directive':
      if (has('--list')) return 'list';
      if (has('--ack')) return 'ack';
      return has('--to') ? 'to' : null;
    case 'hold': return positionals[0] === 'on' || positionals[0] === 'off' ? positionals[0] : null;
    case 'release': return has('--abandoned') ? 'abandoned' : 'done';
    case 'restack': return has('--replace') ? 'replace' : 'candidate';
    case 'status': return has('--fetch') ? 'fetch' : null;
    default: return null;
  }
}

/**
 * Strip what makes a refusal reason unique (shas, quoted text, paths, numbers,
 * PR refs) so the same refusal from two sessions aggregates as one class.
 * @param {unknown} reason
 * @returns {string|null}
 */
export function reasonClass(reason, ids = []) {
  if (typeof reason !== 'string' || !reason.trim()) return null;
  // Names this invocation carried (session / train / branch ids, positionals) are
  // replaced first: an id without a slash or digits would survive every pattern below.
  let text = reason;
  for (const id of [...new Set(ids)].filter((x) => typeof x === 'string' && x.length >= 2).sort((a, b) => b.length - a.length)) {
    text = text.split(id).join('<id>');
  }
  return text
    // A flag name is the useful part of a mis-invocation and is never sensitive: keep it.
    .replace(/["'`](--[a-z][a-z0-9-]*)["'`]/g, ' $1 ')
    .replace(/`[^`]*`/g, '`…`')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/(?:[A-Za-z]:)?[\w.@~-]*[/\\][\w.@~/\\-]*/g, '<path>')
    .replace(/#\d+/g, '#N')
    .replace(/\d+(?:\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** String fields kept verbatim: closed vocabularies only. */
const ENUM_KEYS = new Set(['verdict', 'mode', 'reconciled', 'state', 'kind', 'verification', 'outcome', 'decision']);
/** Never recorded, whatever their type: identity, location and prose. */
const SKIP_KEYS = new Set(['text', 'reason', 'id', 'trainId', 'ok', 'code', 'next', 'cmd', 'command']);
const ENUM_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** One level of counts from an object: numbers, booleans, array lengths, enum strings. */
function countsOf(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEYS.has(k)) continue;
    if (Array.isArray(v)) out[`${k}Count`] = v.length;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && ENUM_KEYS.has(k) && ENUM_RE.test(v)) out[k] = v;
  }
  return out;
}

/**
 * The structured part of an event: counts from the verb's result, plus the
 * status board's shape (item states, hidden, trains, hold) for `status`.
 * Bounded: at most 40 keys.
 */
export function summarize(verb, result) {
  if (!result || typeof result !== 'object') return {};
  const detail = countsOf(result);
  if (Array.isArray(result.next)) detail.obligationsCount = result.next.length;
  const st = result.status;
  if (verb === 'status' && st && typeof st === 'object') {
    const items = Array.isArray(st.items) ? st.items : [];
    detail.items = items.length;
    const byState = {};
    for (const it of items) {
      const s = typeof it?.state === 'string' && ENUM_RE.test(it.state) ? it.state : 'other';
      byState[s] = (byState[s] ?? 0) + 1;
    }
    detail.itemsByState = byState;
    detail.hidden = Number.isFinite(st.hidden?.count) ? st.hidden.count : 0;
    detail.trains = Array.isArray(st.trains) ? st.trains.length : 0;
    detail.cycles = Array.isArray(st.cycles) ? st.cycles.length : 0;
    detail.duplicates = Array.isArray(st.duplicates) ? st.duplicates.length : 0;
    detail.registryInvalid = Array.isArray(st.registry?.invalid) ? st.registry.invalid.length : 0;
    detail.held = st.hold?.held === true;
    detail.prsComplete = st.sources?.prs?.complete === true;
  }
  for (const k of ['archive', 'run', 'train', 'plan']) {
    const sub = result[k];
    if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
      for (const [ck, cv] of Object.entries(countsOf(sub))) detail[`${k}.${ck}`] = cv;
    }
  }
  return Object.fromEntries(Object.entries(detail).slice(0, 40));
}

/** Map a verb's result code / a thrown error to the event outcome. */
export function outcomeOf(result, error) {
  if (error) return error.name === 'ArgvError' ? 'argv' : 'error';
  const c = result?.code;
  return c === 'ok' || c === 'refused' || c === 'pending' || c === 'error' ? c : 'error';
}

/**
 * The tool version, when fleet runs from a consumer's synced bundle: the source
 * commit recorded by the sync manifest. null in the source repo (its manifest
 * describes the last sync, not the code running) and when unreadable.
 */
export function toolShaFor(scriptsDir) {
  if (path.basename(scriptsDir) !== '.claude-skills') return null;
  try {
    const fd = fs.openSync(path.join(scriptsDir, '..', '.sync-manifest.json'), 'r');
    try {
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = buf.toString('utf8', 0, n).match(/"commitSha"\s*:\s*"([0-9a-f]{7,40})"/);
      return m ? m[1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** Every string id this invocation named: flag values, positionals, and the ids its result carries. */
function namedIds(flags, positionals, result) {
  const out = [];
  for (const v of Object.values(flags ?? {})) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === 'string'));
  }
  out.push(...(positionals ?? []).filter((x) => typeof x === 'string'));
  for (const k of ['id', 'trainId', 'branch', 'to']) if (typeof result?.[k] === 'string') out.push(result[k]);
  return out;
}

/** A stable, non-reversible handle for a session id: groups its events without naming the branch. */
export function sessionHandle(id) {
  return typeof id === 'string' && id ? createHash('sha256').update(id).digest('hex').slice(0, 16) : null;
}

/**
 * Build one event. Pure given its inputs.
 * @returns {object}
 */
export function buildEvent({ verb, flags = {}, positionals = [], result = null, error = null, exitCode, startedMs, endedMs, toolSha = null, eventId = randomUUID() }) {
  const sessionId = typeof flags['--id'] === 'string' ? flags['--id'] : (typeof result?.id === 'string' ? result.id : null);
  const detail = summarize(verb, result);
  if (error) detail.errorKind = /^[A-Za-z]{1,40}$/.test(error.name ?? '') ? error.name : 'Error';
  return {
    v: TELEMETRY_VERSION,
    eventId,
    occurredAt: new Date(endedMs).toISOString(),
    verb,
    mode: modeOf(verb, flags, positionals),
    outcome: outcomeOf(result, error),
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    durationMs: Math.max(0, Math.round(endedMs - startedMs)),
    sessionId: sessionHandle(sessionId),
    reasonClass: reasonClass(error ? error.message : result?.reason, namedIds(flags, positionals, result)),
    toolSha,
    detail,
  };
}

/**
 * Append one event to the spool (temp file + rename, so a drainer never reads a
 * half-written event). Past MAX_SPOOL_FILES the event is not written and the
 * `dropped` counter is bumped instead, which the drainer reports.
 * @returns {{written: boolean, reason?: string}}
 */
export function writeSpool(dir, event, { maxFiles = MAX_SPOOL_FILES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let pending = 0;
  try { pending = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length; } catch { /* counted as empty */ }
  if (pending >= maxFiles) {
    let n = 0;
    try { n = Number.parseInt(fs.readFileSync(droppedFile(dir), 'utf8'), 10) || 0; } catch { /* first drop */ }
    fs.writeFileSync(droppedFile(dir), String(n + 1));
    return { written: false, reason: 'spool-full' };
  }
  const name = `${Date.parse(event.occurredAt)}-${event.eventId}.json`;
  const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(event));
  fs.renameSync(tmp, path.join(dir, name));
  return { written: true };
}

const ageMs = (file, nowMs) => {
  try { return nowMs - fs.statSync(file).mtimeMs; } catch { return Infinity; }
};

/**
 * Should this invocation start a drainer? Never under the test runner (it would
 * reach whatever store the machine is configured for), never while a live drain
 * holds the lock, and at most once per DRAIN_SPAWN_INTERVAL_MS.
 */
export function shouldSpawnDrain({ env, dir, nowMs }) {
  if (env.NODE_TEST_CONTEXT) return false;
  if (ageMs(lockFile(dir), nowMs) < DRAIN_LOCK_STALE_MS) return false;
  return ageMs(spawnMarker(dir), nowMs) >= DRAIN_SPAWN_INTERVAL_MS;
}

/** Start the detached drainer. Its output goes nowhere; the spool is its record. */
export function spawnDrain({ dir, cwd, scriptsDir, env, nowMs }) {
  const cli = path.join(scriptsDir, 'cross-skill.mjs');
  if (!fs.existsSync(cli)) return false;
  fs.writeFileSync(spawnMarker(dir), String(nowMs));
  const child = spawn(process.execPath, [cli, 'fleet-telemetry', 'flush', '--spool', dir], {
    cwd, env, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', () => { /* best effort: the event stays spooled for the next drain */ });
  child.unref();
  return true;
}

/**
 * Record one invocation. Never throws and never writes to stdout: a telemetry
 * fault costs at most one stderr line, and the verb's outcome is untouched.
 */
export function recordInvocation({ fleetDirPath, cwd, env, scriptsDir, ...eventInput }) {
  try {
    if (!fleetDirPath || !telemetryEnabled(env)) return;
    const dir = spoolDir(fleetDirPath);
    const event = buildEvent({ ...eventInput, toolSha: toolShaFor(scriptsDir) });
    writeSpool(dir, event);
    const nowMs = Date.now();
    if (shouldSpawnDrain({ env, dir, nowMs })) spawnDrain({ dir, cwd, scriptsDir, env, nowMs });
  } catch (err) {
    process.stderr.write(`fleet: telemetry not recorded (${err?.message ?? err}); set FLEET_TELEMETRY=off to silence\n`);
  }
}
