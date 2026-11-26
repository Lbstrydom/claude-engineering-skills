/**
 * @fileoverview Hang protection for `npm test` (scripts/run-tests.mjs): the limits and their two measured profiles, the
 * tracker for the progress file the child preload writes (scripts/lib/test-progress-preload.mjs), the per-test stall
 * decision, and the idle watchdog's clock. Pure: no filesystem, no processes; the runner owns every side effect.
 * Plan: docs/plans/test-runner-hang-guard.md (revision 2).
 *
 * WHY THE RUNNER, NOT NODE, ENFORCES THE PER-TEST LIMIT (measured on node v22.23.2, plan section 1.2). Under process isolation
 * node's `--test-timeout` bounds each FILE (the runner's file timer always beats the child's per-test copy), and node names only
 * the file. Under this machine's real load a healthy file took 23.7 min, so no per-file default is both safe locally and useful in
 * CI. The preload records every test instance's start and end synchronously from inside the child, so the runner can time each
 * instance itself, kill just that child (node then fails that file and the run goes on), and name the test.
 *
 * @module scripts/lib/test-hang-guard
 */

/**
 * The two measured profiles. `stallMs` ≥ 2x the slowest single test instance (parents included) measured in that environment;
 * `watchdogMs` = stall + gap. CI: slowest test 61.4 s (run 45872119612, 2026-11-26). Local: 857.5 s under real load
 * (`npm test` on 2026-11-26). The test in tests/run-tests-hang-guard.test.mjs pins both and their order against the CI cap.
 */
export const PROFILES = Object.freeze({
  ci: Object.freeze({ stallMs: 300_000, watchdogMs: 420_000, gapMs: 120_000 }),
  local: Object.freeze({ stallMs: 1_800_000, watchdogMs: 2_100_000, gapMs: 300_000 }),
});

/** Overrides (positive integer ms). There is deliberately no "off". */
export const STALL_TIMEOUT_ENV = 'TEST_STALL_TIMEOUT_MS';
export const IDLE_WATCHDOG_ENV = 'TEST_IDLE_WATCHDOG_MS';

/** The absolute path of the progress file, set by the runner for its children only. */
export const PROGRESS_FILE_ENV = 'TEST_PROGRESS_FILE';

/** A JSON array of absolute paths the caller named explicitly that match no default pattern; the preload instruments them too. */
export const PROGRESS_EXTRA_FILES_ENV = 'TEST_PROGRESS_EXTRA_FILES';

/** The progress line schema's version (`test-progress/v1`); a line of any other version is ignored. */
export const PROGRESS_VERSION = 1;

/** Slack when comparing a process's creation time with the child's own `load` clock (POSIX `etimes` has 1-s steps). */
export const IDENTITY_SLACK_MS = 2_000;

const TIMEOUT_FLAG = '--test-timeout';

/**
 * The caller's `--test-timeout`, read from node's OPTION region only: a token after the `--` terminator is a file argument.
 * @param {string[]} argv
 * @returns {{present: boolean, ms: number|null}} `ms` is null for a bare flag with no value (node refuses that itself)
 */
export function callerTestTimeout(argv) {
  // Node keeps the LAST occurrence of a repeated option, so this does too.
  let found = { present: false, ms: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith(`${TIMEOUT_FLAG}=`)) found = { present: true, ms: Number(a.slice(TIMEOUT_FLAG.length + 1)) };
    else if (a === TIMEOUT_FLAG) {
      const v = argv[i + 1];
      found = { present: true, ms: v === undefined || v === '--' ? null : Number(v) };
      if (v !== undefined && v !== '--') i += 1;
    }
  }
  return found;
}

function parsePositiveMs(name, raw) {
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a positive integer number of milliseconds (got ${JSON.stringify(raw)}); there is no "off".`);
  }
  return Number(raw);
}

/**
 * The limits in force. The profile is `ci` when GitHub Actions' `CI=true` is set, else `local`. A caller's `--test-timeout` is
 * node's own FILE option and is forwarded untouched; it does not change the stall limit, and a finite one raises the watchdog to
 * N + gap when that is higher, so the watchdog never preempts the caller's own bound. Explicit env overrides win. Throws on a
 * bad override (the runner exits 2).
 *
 * @param {{env: Record<string, string|undefined>, argv: string[]}} input
 * @returns {{profile: 'ci'|'local', stallMs: number, stallSource: string, watchdogMs: number, watchdogSource: string,
 *            fileTimeoutMs: number|null}}
 */
export function resolveLimits({ env, argv }) {
  const profile = env.CI === 'true' ? 'ci' : 'local';
  const p = PROFILES[profile];
  const stallEnv = parsePositiveMs(STALL_TIMEOUT_ENV, env[STALL_TIMEOUT_ENV]);
  const dogEnv = parsePositiveMs(IDLE_WATCHDOG_ENV, env[IDLE_WATCHDOG_ENV]);
  const caller = callerTestTimeout(argv);
  const fileTimeoutMs = caller.present ? caller.ms : null;
  let watchdogMs = p.watchdogMs;
  let watchdogSource = profile;
  if (dogEnv !== null) { watchdogMs = dogEnv; watchdogSource = 'env'; } else if (Number.isFinite(fileTimeoutMs) && fileTimeoutMs + p.gapMs > watchdogMs) {
    watchdogMs = fileTimeoutMs + p.gapMs;
    watchdogSource = 'caller --test-timeout';
  }
  return {
    profile, stallMs: stallEnv ?? p.stallMs, stallSource: stallEnv !== null ? 'env' : profile, watchdogMs, watchdogSource, fileTimeoutMs,
  };
}

/**
 * Whether node would run `file` as a test by its own default patterns (`*.test.{js,mjs,cjs}`, `*-test.*`, `*_test.*`, `test-*.*`,
 * `test.*`, anything under a `test/` directory). The preload instruments only such files, so a plain script a test spawns with
 * `process.execArgv` records nothing.
 * @param {string} file
 */
// @duplicate-justification: target=scripts/lib/fleet/shared-surface.mjs:isTestFile reason=that one is fleet's private, extension-agnostic reach classifier; this one is node's default test-file contract (.js/.mjs/.cjs plus a test/ directory), and shared-lib may not import fleet
export function isNodeTestFileName(file) {
  const parts = String(file).split(/[\\/]/);
  const base = parts.at(-1) ?? '';
  if (!/\.(c|m)?js$/.test(base)) return false;
  if (parts.slice(0, -1).includes('test')) return true;
  return /[.\-_]test\.(c|m)?js$/.test(base) || /^test-.+\.(c|m)?js$/.test(base) || /^test\.(c|m)?js$/.test(base);
}

/**
 * The progress-file tracker. Fed only NEW bytes (it carries a partial last line over), so a tick costs the growth since the last
 * one. Instances pair by (proc, id): the preload's id is unique per test instance, so same-named and concurrent tests never
 * cancel each other. `seq` is a per-process counter; a jump means a line was lost, and that proc is then never stall-killed.
 */
export function createProgressTracker() {
  const procs = new Map();
  let rest = '';
  let torn = 0;
  let lines = 0;
  let lastEventAt = null;
  const procOf = (e) => {
    let p = procs.get(e.proc);
    if (!p) {
      p = { proc: e.proc, file: e.file, pid: null, ppid: null, loadAt: null, lastAt: null, lastSeq: 0, gap: false, exited: false, superseded: false, active: new Map(), started: 0 };
      procs.set(e.proc, p);
    }
    return p;
  };
  const apply = (line) => {
    if (!line.trim()) return;
    lines += 1;
    let e;
    try { e = JSON.parse(line); } catch { torn += 1; return; }
    if (e?.v !== PROGRESS_VERSION || typeof e.proc !== 'string' || typeof e.file !== 'string' || !Number.isFinite(e.at)) { torn += 1; return; }
    const p = procOf(e);
    if (Number.isInteger(e.seq)) {
      if (e.seq !== p.lastSeq + 1) p.gap = true;
      p.lastSeq = Math.max(p.lastSeq, e.seq);
    }
    p.lastAt = Math.max(p.lastAt ?? e.at, e.at);
    lastEventAt = Math.max(lastEventAt ?? e.at, e.at);
    if (e.ev === 'load') {
      p.pid = Number.isInteger(e.pid) ? e.pid : null;
      p.ppid = Number.isInteger(e.ppid) ? e.ppid : null;
      p.loadAt = e.at;
      // A later process loading under the same pid proves the earlier one is gone: its record can never be a candidate again.
      if (p.pid !== null) for (const q of procs.values()) if (q !== p && q.pid === p.pid && !q.exited) q.superseded = true;
      return;
    }
    if (e.ev === 'exit') { p.exited = true; return; }
    if (e.ev === 'start' && Number.isInteger(e.id)) { p.active.set(e.id, { name: String(e.name ?? '<unnamed>'), startAt: e.at }); p.started += 1; return; }
    if (e.ev === 'end' && Number.isInteger(e.id)) { p.active.delete(e.id); return; }
    torn += 1;
  };
  let owner = null;
  return {
    /** The runner's pid: a record whose parent is anything else (a helper a test spawned with the preload) is ignored. */
    setOwner(pid) { owner = Number.isInteger(pid) ? pid : null; },
    /** The records of the runner's own test children; a record without a parent pid is kept (best effort, never dropped). */
    owned() { return [...procs.values()].filter((p) => owner === null || p.ppid === null || p.ppid === owner); },
    feed(chunk) {
      const text = rest + chunk;
      const parts = text.split('\n');
      rest = parts.pop();
      for (const l of parts) apply(l);
    },
    /** Flush a final unterminated line (the run is over). */
    end() { if (rest) { apply(rest); rest = ''; } },
    get procs() { return procs; },
    get torn() { return torn; },
    get lines() { return lines; },
    get lastEventAt() { return lastEventAt; },
  };
}

const deepestFirst = (a, b) => (b.name.split(' > ').length - a.name.split(' > ').length) || a.name.localeCompare(b.name);

/**
 * The procs that have stalled at `now`: not exited, not already stopped, no `seq` gap, and either an active instance older than
 * `stallMs` (timed from its own start, never reset) or no active instance and no event for `stallMs`. Every overdue instance is
 * listed, deepest full name first. Procs with a gap are returned separately: their records cannot prove a stall.
 *
 * @param {ReturnType<typeof createProgressTracker>} tracker
 * @param {{now: number, stallMs: number, stopped: Set<string>}} o
 * @returns {{stalls: Array<{proc: string, file: string, pid: number|null, loadAt: number|null,
 *            overdue: Array<{name: string, ageMs: number}>, quietMs: number}>, gaps: Array<{proc: string, file: string, pid: number|null}>}}
 */
export function findStalls(tracker, { now, stallMs, stopped }) {
  const stalls = [];
  const gaps = [];
  for (const p of tracker.owned()) {
    if (p.exited || p.superseded || stopped.has(p.proc)) continue;
    const overdue = [...p.active.values()].map((i) => ({ name: i.name, ageMs: now - i.startAt })).filter((i) => i.ageMs >= stallMs).sort(deepestFirst);
    const quietMs = now - (p.lastAt ?? now);
    const outside = p.active.size === 0 && quietMs >= stallMs;
    if (!overdue.length && !outside) continue;
    if (p.gap) { gaps.push({ proc: p.proc, file: p.file, pid: p.pid }); continue; }
    stalls.push({ proc: p.proc, file: p.file, pid: p.pid, loadAt: p.loadAt, overdue, quietMs });
  }
  return { stalls, gaps };
}

/**
 * Whether the process the OS reports for a pid is the one that wrote the progress record: its parent is THIS runner, and it was
 * created between the run's start and the record's `load` (with slack). A pid reused by a later process, even a later test child
 * of the same runner, was created after that `load`. An unreadable row is never a match (fail safe: never a blind kill).
 * @param {{row: {ppid: number, createdMs: number}|null, runnerPid: number, runStartMs: number, loadAt: number|null}} o
 */
export function identityMatches({ row, runnerPid, runStartMs, loadAt }) {
  if (!row || !Number.isInteger(row.ppid) || !Number.isFinite(row.createdMs) || !Number.isFinite(loadAt)) return false;
  return row.ppid === runnerPid && row.createdMs >= runStartMs - IDENTITY_SLACK_MS && row.createdMs <= loadAt + IDENTITY_SLACK_MS;
}

/**
 * End-of-run integrity check, for a run that would otherwise PASS: every eligible file that ran must have a `load` record, and
 * every one of the runner's own records must end in `exit` (or be superseded by a later process under the same pid). A child
 * whose appends failed can finish normally, so its lost `end`/`exit` lines would never trip the stall limit or the watchdog;
 * this is the check that makes that instrument failure fail the run instead of passing over an incomplete record.
 *
 * @param {ReturnType<typeof createProgressTracker>} tracker
 * @param {{ran: Iterable<string>, eligible: (absFile: string) => boolean, fold: (p: string) => string, show?: (f: string) => string}} o
 *   `ran` = absolute paths of the files node reports having run
 * @returns {string[]} one line per problem; empty when the record is complete
 */
export function reconcileRecord(tracker, { ran, eligible, fold, show = (f) => f }) {
  const problems = [];
  const owned = tracker.owned();
  const loaded = new Set(owned.map((p) => fold(p.file)));
  for (const f of [...ran].sort()) if (eligible(f) && !loaded.has(fold(f))) problems.push(`${show(f)}: ran, but no progress record (load) arrived`);
  for (const p of owned) if (!p.exited && !p.superseded) problems.push(`${show(p.file)}${p.pid ? ` (pid ${p.pid})` : ''}: no exit record, so its record is incomplete`);
  return problems;
}

/**
 * Files node failed with its own timeout, from the guard report (only possible when a caller passed `--test-timeout`).
 * @param {string|null} reportText
 * @returns {string[]}
 */
export function timedOutFiles(reportText) {
  let report;
  try { report = JSON.parse(reportText); } catch { return []; }
  if (!Array.isArray(report?.failures)) return [];
  return [...new Set(report.failures
    .filter((f) => typeof f?.error === 'string' && /^test timed out after \d+ms$/.test(f.error))
    .map((f) => f.file ?? f.name)
    .filter((f) => typeof f === 'string' && f))];
}

/**
 * The children whose orphans must be swept after the run: every child of a file node timed out, and every child that never
 * exited and was not already stopped by the runner (the runner stops a stalled child's tree while it is still intact).
 * @param {ReturnType<typeof createProgressTracker>} tracker
 * @param {{timedOut: string[], sameFile: (a: string, b: string) => boolean, stopped: Set<string>}} o
 * @returns {Array<{file: string, pid: number, at: number|null}>}
 */
export function childrenToSweep(tracker, { timedOut, sameFile, stopped }) {
  const out = new Map();
  for (const p of tracker.owned()) {
    if (!Number.isInteger(p.pid) || p.superseded || stopped.has(p.proc) || out.has(p.pid)) continue;
    if (!p.exited || timedOut.some((f) => sameFile(f, p.file))) out.set(p.pid, { file: p.file, pid: p.pid, at: p.loadAt });
  }
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Lines naming what was still running. Best effort, and says which kind it is.
 * @param {ReturnType<typeof createProgressTracker>} tracker
 * @param {{now: number, show?: (file: string) => string}} o
 * @returns {string[]}
 */
export function describeInFlight(tracker, { now, show = (f) => f }) {
  const lines = [];
  const running = [];
  const idle = [];
  for (const p of tracker.owned()) {
    if (p.exited || p.superseded) continue;
    if (p.active.size) for (const i of p.active.values()) running.push({ ...i, file: p.file, pid: p.pid });
    else if (p.started === 0) idle.push(p);
  }
  if (running.length) {
    lines.push('  tests that started and never finished:');
    for (const t of running.sort((a, b) => a.file.localeCompare(b.file) || deepestFirst(a, b))) {
      lines.push(`    - ${t.name}\n        in ${show(t.file)}${t.pid ? ` (pid ${t.pid})` : ''}, running ${Math.round((now - t.startAt) / 1000)}s`);
    }
  }
  if (idle.length) {
    lines.push('  files that loaded and never started a test (a hang while importing, or in a top-level hook):');
    for (const p of idle.sort((a, b) => a.file.localeCompare(b.file))) lines.push(`    - ${show(p.file)}${p.pid ? ` (pid ${p.pid})` : ''}`);
  }
  if (!lines.length) lines.push(tracker.lines === 0 ? '  no progress was recorded: no test file had loaded.' : '  no test was still running.');
  if (tracker.torn) lines.push(`  (${tracker.torn} progress line(s) could not be read and were skipped)`);
  return lines;
}

/**
 * Lines for the stalls the runner stopped (and the ones it could not), for `adjudicateRun`'s message.
 * @param {Array<{file: string, pid: number|null, overdue: Array<{name: string, ageMs: number}>, quietMs: number, stopped: boolean, why?: string}>} stalls
 * @param {{stallMs: number, show?: (file: string) => string}} o
 */
export function describeStalls(stalls, { stallMs, show = (f) => f }) {
  const s = (ms) => `${Math.round(ms / 1000)}s`;
  const lines = [];
  for (const x of stalls) {
    const what = x.overdue.length
      ? x.overdue.map((o) => `    - ${o.name} (running ${s(o.ageMs)})`).join('\n')
      : `    - outside any test (loading, or in a hook): no progress for ${s(x.quietMs)}`;
    lines.push(`  ${show(x.file)}${x.pid ? ` (pid ${x.pid})` : ''}, over the ${s(stallMs)} per-test limit:\n${what}`);
    lines.push(x.stopped ? '      its process was stopped; node fails the file and the run went on.' : `      NOT stopped: ${x.why}`);
  }
  return lines;
}

/**
 * The idle watchdog's clock. `probe()` returns a cheap measure of progress; a probe that throws counts as no growth. `onIdle` is
 * called at most once, after `idleMs` with no growth. `tick()` is called by the runner's single timer.
 *
 * @param {{idleMs: number, probe: () => unknown, onIdle: (idleForMs: number) => void, clock?: () => number}} o
 * @returns {{start: () => void, stop: () => void, tick: () => void, readonly fired: boolean}}
 */
export function createIdleWatchdog({ idleMs, probe, onIdle, clock = Date.now }) {
  let last;
  let lastChange = clock();
  let fired = false;
  let stopped = false;
  let started = false;
  const read = () => { try { return probe(); } catch { return last; } };
  return {
    start() { if (!started) { started = true; last = read(); lastChange = clock(); } },
    stop() { stopped = true; },
    tick() {
      if (!started || fired || stopped) return;
      const now = clock();
      const v = read();
      if (v !== last) { last = v; lastChange = now; return; }
      if (now - lastChange >= idleMs) { fired = true; onIdle(now - lastChange); }
    },
    get fired() { return fired; },
  };
}
