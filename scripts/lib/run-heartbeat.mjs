/**
 * @fileoverview Run journals for long-running background jobs: append-only JSONL
 * heartbeats, and the ONE reader that turns a journal into a verdict.
 *
 * The verdict is RUNNING | STALE | ENDED_OK | ENDED_FAILED | UNKNOWN, and the
 * load-bearing rule is that absence is never health: a missing journal, a
 * journal with no `start`, no declared cadence, or a timestamp from the future
 * all read UNKNOWN — never RUNNING. (Same rule as `maintenance-heartbeat.mjs`,
 * where a missing or future timestamp is "never run".)
 *
 * STALE means "no progress observed within the run's own declared cadence", not
 * "stopped": a wrapper killed by SIGKILL writes no `end`, and its child may
 * survive. The verdict therefore carries `childAlive` from a pid probe so a hung
 * run and a dead one can be told apart.
 *
 * Journals live in `<git-common-dir>/audit-loop/runs/` so a run launched from a
 * pinned fixture worktree is visible from every checkout. Outside git only, the
 * dir is `.audit/runs/`. There is no in-git fallback: an unwritable common dir is
 * an error, because a worktree-local fallback would silently hide the run.
 *
 * Plan: docs/plans/test-campaign-controls.md §2.1.
 *
 * @module scripts/lib/run-heartbeat
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const JOURNAL_VERSION = 1;
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** A timestamp further than this into the future is not trusted. */
export const FUTURE_SKEW_MS = 60_000;
/** Ended journals older than this are left out of `list` (never deleted). */
export const LIST_ENDED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** The `run` wrapper beats at most once per this interval; a cadence shorter than 3x it would read a busy run STALE. */
export const BEAT_THROTTLE_MS = 5000;
export const MIN_STALE_AFTER_SEC = 15;
export const STATES = Object.freeze(['RUNNING', 'STALE', 'ENDED_OK', 'ENDED_FAILED', 'UNKNOWN']);

/** @returns {{ok:true}|{ok:false, reason:string}} */
export function validateRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) return { ok: false, reason: 'run id is required' };
  if (!RUN_ID_RE.test(runId)) return { ok: false, reason: `run id "${runId}" must match ${RUN_ID_RE} (letters, digits, . _ -; max 80)` };
  if (runId.includes('..')) return { ok: false, reason: `run id "${runId}" must not contain ".."` };
  return { ok: true };
}

/**
 * Where journals live for `cwd`. Inside git: the common dir (shared by every
 * worktree). Outside git: `.audit/runs`.
 * @returns {{dir: string, shared: boolean}}
 */
export function resolveRunsDir(cwd = process.cwd(), { git = gitCommonDir } = {}) {
  const common = git(cwd);
  if (common) return { dir: path.join(common, 'audit-loop', 'runs'), shared: true };
  return { dir: path.resolve(cwd, '.audit', 'runs'), shared: false };
}

function hasDotGitAncestor(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * The git common dir, or null ONLY when git definitely says "not a git repository". Any other failure (git
 * missing, a timeout, a dubious-ownership refusal) throws: reading it as "outside git" would silently pick a
 * worktree-local dir and hide the run from every other checkout.
 */
export function gitCommonDir(cwd, { exec = execFileSync } = {}) {
  let out;
  try {
    out = String(exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    })).trim();
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    // "not a git repository" is only "outside git" when no .git entry exists above cwd; with one (a linked worktree
    // whose gitdir is gone, a corrupt repo) the repo is BROKEN, and a local fallback would hide the run.
    if (err?.status === 128 && /not a git repository/i.test(stderr) && !hasDotGitAncestor(cwd)) return null;
    const first = stderr.trim().split('\n')[0];
    throw new Error(`cannot resolve the runs dir: git rev-parse failed (${err?.code || err?.status || err?.message}${first ? `: ${first}` : ''})`);
  }
  if (!out) throw new Error('cannot resolve the runs dir: git rev-parse printed nothing');
  return out;
}

/**
 * The journal path for a run id, contained in `dir`. Throws on an invalid id or
 * an escape — callers at every entry point go through here.
 */
export function journalPath(dir, runId) {
  const v = validateRunId(runId);
  if (!v.ok) throw new Error(v.reason);
  const base = path.resolve(dir);
  const p = path.resolve(base, `${runId}.jsonl`);
  if (path.dirname(p) !== base) throw new Error(`run id "${runId}" resolves outside the runs dir`);
  return p;
}

function refuseSymlink(p) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`journal ${p} is a symlink — refused`);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function line(entry, now) {
  return `${JSON.stringify({ v: JOURNAL_VERSION, ts: new Date(now).toISOString(), ...entry })}\n`;
}

/** Append one line; if a crash left a torn last line (no trailing newline), start a fresh line so the two never merge. */
function appendLine(p, text) {
  let prefix = '';
  const size = fs.statSync(p).size;
  if (size > 0) {
    const fd = fs.openSync(p, 'r');
    try {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      if (b[0] !== 0x0a) prefix = '\n';
    } finally { fs.closeSync(fd); }
  }
  fs.appendFileSync(p, prefix + text);
}

function buildEntry({ runId, kind, note, childPid, exitCode, signal }) {
  const entry = { runId, kind };
  if (note) entry.note = note;
  if (Number.isInteger(childPid)) entry.childPid = childPid;
  if (kind === 'end') {
    entry.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    if (signal) entry.signal = signal;
  }
  return entry;
}

/**
 * The append for a journal's OWN writer (the `run` wrapper, which created it and knows it has not ended): no
 * re-read per beat, so a long run's beats stay O(1) instead of re-parsing the whole journal every time.
 */
export function appendOwnRun(journal, { now = Date.now(), ...fields }) {
  appendLine(journal, line(buildEntry(fields), now));
}

/**
 * Create a journal with an exclusive create — a reused id (including two
 * concurrent launches) fails here, before anything is spawned.
 */
export function startRun(dir, { runId, staleAfterSec, pid = process.pid, note, now = Date.now() }) {
  if (!Number.isFinite(staleAfterSec) || staleAfterSec < MIN_STALE_AFTER_SEC) {
    throw new Error(`stale-after must be at least ${MIN_STALE_AFTER_SEC} seconds (3x the ${BEAT_THROTTLE_MS / 1000}s beat throttle), got ${staleAfterSec}`);
  }
  const p = journalPath(dir, runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  refuseSymlink(p);
  try {
    fs.writeFileSync(p, line({ runId, kind: 'start', staleAfterSec, pid, ...(note ? { note } : {}) }, now), { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`run id "${runId}" is already in use (${p}) — pick a new id`);
    throw err;
  }
  return p;
}

/**
 * Append a `beat` or `end`. Refuses a journal with no `start`, and one that has
 * already ended (`end` is terminal at the writer, so nothing legitimate follows it).
 */
export function appendRun(dir, { runId, kind, note, childPid, exitCode, signal, now = Date.now() }) {
  if (kind !== 'beat' && kind !== 'end') throw new Error(`kind must be beat or end, got ${kind}`);
  const p = journalPath(dir, runId);
  refuseSymlink(p);
  const parsed = readJournal(p);
  if (!parsed.exists || !parsed.start) throw new Error(`run "${runId}" has no start record — call start first`);
  if (parsed.end) throw new Error(`run "${runId}" has already ended — a journal is never appended after its end`);
  appendLine(p, line(buildEntry({ runId, kind, note, childPid, exitCode, signal }), now));
  return p;
}

/**
 * Parse a journal. The whole file is scanned (a tail window can lose the start or
 * the end record). The beat throttle bounds the GROWTH RATE (at most one line per 5 s,
 * about 2 MB per day of continuous output), not the total; there is no compaction in v1.
 * @returns {{exists:boolean, unreadable?:string, start:object|null, end:object|null,
 *   entries:object[], malformedLines:number, afterEnd:number}}
 */
export function readJournal(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false, start: null, end: null, entries: [], malformedLines: 0, afterEnd: 0 };
    return { exists: true, unreadable: err.code || err.message, start: null, end: null, entries: [], malformedLines: 0, afterEnd: 0 };
  }
  return parseJournalText(raw);
}

export function parseJournalText(raw) {
  const entries = [];
  let malformedLines = 0;
  let start = null;
  let end = null;
  let afterEnd = 0;
  for (const text of String(raw).split('\n')) {
    if (!text.trim()) continue;
    let e;
    try { e = JSON.parse(text); } catch { malformedLines++; continue; }
    if (!e || typeof e !== 'object' || typeof e.ts !== 'string' || !['start', 'beat', 'end'].includes(e.kind)) {
      malformedLines++;
      continue;
    }
    if (end) { afterEnd++; continue; }
    if (e.kind === 'start') {
      if (start) { malformedLines++; continue; } // a second start is not a restart
      start = e;
    } else if (!start) {
      malformedLines++;
      continue;
    } else if (e.kind === 'end') {
      end = e;
    }
    entries.push(e);
  }
  return { exists: true, start, end, entries, malformedLines, afterEnd };
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return true; } catch (err) {
    if (err?.code === 'ESRCH') return false;
    return 'unknown'; // EPERM: exists but not ours — cannot tell more
  }
}

/**
 * The verdict for one parsed journal.
 * @param {ReturnType<typeof parseJournalText>} parsed
 * @param {{now?: number, staleAfterSec?: number, pidAlive?: (pid:number)=>boolean|'unknown'}} [opts]
 */
export function assessJournal(parsed, { now = Date.now(), staleAfterSec, pidAlive = defaultPidAlive } = {}) {
  const base = { malformedLines: parsed?.malformedLines ?? 0, afterEnd: parsed?.afterEnd ?? 0 };
  const unknown = (reason, extra = {}) => ({ state: 'UNKNOWN', reason, ...base, ...extra });
  if (!parsed || !parsed.exists) return unknown('no journal');
  if (parsed.unreadable) return unknown(`journal unreadable (${parsed.unreadable})`);
  if (!parsed.start) return unknown(parsed.malformedLines > 0 ? 'no valid start record (only malformed lines)' : 'no start record');
  const runId = parsed.start.runId ?? null;
  const cadence = Number.isFinite(staleAfterSec) && staleAfterSec > 0 ? staleAfterSec : parsed.start.staleAfterSec;
  const times = parsed.entries.map((e) => Date.parse(e.ts));
  if (times.some((t) => Number.isNaN(t))) return unknown('unparseable timestamp', { runId });
  let lastTs = -Infinity;
  for (const t of times) if (t > lastTs) lastTs = t; // a loop, not Math.max(...times): a long journal exceeds the argument limit
  if (lastTs > now + FUTURE_SKEW_MS) return unknown('timestamp in the future — clock skew or a hand edit', { runId, lastTs: new Date(lastTs).toISOString() });
  const childPid = [...parsed.entries].reverse().find((e) => Number.isInteger(e.childPid))?.childPid ?? null;
  const common = { runId, lastTs: new Date(lastTs).toISOString(), ageSec: Math.max(0, Math.round((now - lastTs) / 1000)), childPid, ...base };
  if (parsed.end) {
    const okEnd = parsed.end.exitCode === 0 && !parsed.end.signal;
    return {
      state: okEnd ? 'ENDED_OK' : 'ENDED_FAILED',
      reason: okEnd ? 'ended with exit 0' : `ended with ${parsed.end.signal ? `signal ${parsed.end.signal}` : `exit ${parsed.end.exitCode}`}`,
      exitCode: parsed.end.exitCode ?? null, ...common,
    };
  }
  if (!Number.isFinite(cadence) || cadence <= 0) return unknown('no declared stale-after cadence', common);
  if (now - lastTs > cadence * 1000) {
    const childAlive = childPid ? pidAlive(childPid) : 'unknown';
    return { state: 'STALE', reason: `no heartbeat for ${common.ageSec}s (stale after ${cadence}s)`, staleAfterSec: cadence, childAlive, ...common };
  }
  return { state: 'RUNNING', reason: `last heartbeat ${common.ageSec}s ago`, staleAfterSec: cadence, ...common };
}

/** Read + assess one run by id. */
export function checkRun(dir, runId, opts = {}) {
  return assessJournal(readJournal(journalPath(dir, runId)), opts);
}

/**
 * Would deleting the place this run executes in pull the floor from under it? RUNNING, or STALE with its child
 * still alive (a hung or wrapper-orphaned run that may still be spending), blocks; everything else — ended, unknown,
 * stale with the child gone or unknowable — does not. Used by `pinned-worktree remove`.
 * @returns {{block: boolean, why: string}}
 */
export function runBlocksRemoval(verdict) {
  if (verdict?.state === 'RUNNING') return { block: true, why: `run ${verdict.runId} is RUNNING (${verdict.reason})` };
  if (verdict?.state === 'STALE' && verdict.childAlive === true) {
    return { block: true, why: `run ${verdict.runId} is STALE but its child pid ${verdict.childPid} is still alive — it may still be spending` };
  }
  return { block: false, why: `run ${verdict?.runId ?? '?'}: ${verdict?.state ?? 'UNKNOWN'}` };
}

/**
 * Every journal in `dir` with its verdict. Dir absent ⇒ `{measured:true, runs:[]}`
 * (nothing launched); dir unreadable ⇒ `{measured:false, reason}` — never an
 * empty list that reads as "no runs".
 */
export function listRuns(dir, { now = Date.now(), pidAlive = defaultPidAlive } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err?.code === 'ENOENT') return { measured: true, dirExists: false, runs: [] };
    return { measured: false, reason: `runs dir unreadable (${err.code || err.message})`, runs: [] };
  }
  const runs = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    const runId = name.slice(0, -'.jsonl'.length);
    if (!validateRunId(runId).ok) continue;
    const verdict = assessJournal(readJournal(path.join(dir, name)), { now, pidAlive });
    if (verdict.state.startsWith('ENDED') && Number.isFinite(Date.parse(verdict.lastTs))
      && now - Date.parse(verdict.lastTs) > LIST_ENDED_MAX_AGE_MS) continue;
    runs.push({ ...verdict, runId });
  }
  return { measured: true, dirExists: true, runs };
}

/**
 * The one-line `/fleet status` summary. `null` when there is nothing to say
 * (no runs dir, no recent runs); an unreadable dir is always said.
 */
export function summariseRuns(listing) {
  if (!listing) return null;
  if (!listing.measured) return `runs: UNMEASURED (${listing.reason})`;
  if (listing.runs.length === 0) return null;
  const by = (s) => listing.runs.filter((r) => r.state === s);
  const parts = [];
  const running = by('RUNNING').length;
  if (running) parts.push(`${running} running`);
  for (const r of by('STALE')) parts.push(`STALE ${r.runId} (last beat ${fmtAge(r.ageSec)} ago${r.childAlive === true ? ', child pid alive' : r.childAlive === false ? ', child gone' : ''})`);
  for (const r of by('UNKNOWN')) parts.push(`UNKNOWN ${r.runId} (${r.reason})`);
  const failed = by('ENDED_FAILED');
  for (const r of failed) parts.push(`FAILED ${r.runId} (${r.reason})`);
  const ok = by('ENDED_OK').length;
  if (ok) parts.push(`${ok} ended ok`);
  return `runs: ${parts.join(' · ')}`;
}

function fmtAge(sec) {
  if (!Number.isFinite(sec)) return '?';
  if (sec < 120) return `${sec}s`;
  if (sec < 7200) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
