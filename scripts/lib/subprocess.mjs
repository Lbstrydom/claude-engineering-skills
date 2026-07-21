/**
 * @fileoverview Async streaming subprocess runner — launch a child,
 * stream stdout line-by-line, parse each line as JSON, await structured
 * completion. Sibling to scripts/lib/vcs.mjs.
 *
 * Why this exists: scripts/symbol-index/refresh.mjs::runJsonLines used
 * `spawnSync` (blocking) to drive a multi-minute extract → summarise →
 * embed pipeline. While spawnSync blocked, the `runWithHeartbeat`
 * `setInterval` could not fire — the refresh row's `heartbeat_at` went
 * silent for the entire pipeline duration. Any future tool that decided
 * staleness by heartbeat age would misclassify an honest in-flight refresh.
 * This module replaces the helper with an async streaming runner so
 * heartbeats fire between bursts of stdout.
 *
 * Plan: docs/plans/liveness-and-canonical-paths.md WS-LIVE.
 *
 * @module scripts/lib/subprocess
 */
import { spawn } from 'node:child_process';

/**
 * @typedef {'EXIT_NONZERO' | 'SPAWN_FAILED' | 'KILLED_BY_SIGNAL' | 'PARSE_FAILED_HARD'} SubprocErrorCode
 */

// Closed enum — every code that runJsonLinesAsyncStrict may throw with.
// Adding a new code is one line in the union above + one branch in the
// strict wrapper's classification. Closed set per #6 Open/Closed.
export const SUBPROC_ERROR_CODES = Object.freeze({
  EXIT_NONZERO:       'EXIT_NONZERO',
  SPAWN_FAILED:       'SPAWN_FAILED',
  KILLED_BY_SIGNAL:   'KILLED_BY_SIGNAL',
  PARSE_FAILED_HARD:  'PARSE_FAILED_HARD',
});

/**
 * Run a child process asynchronously. Streams stdout line-by-line and
 * parses each line as JSON. Records every line; parse failures are
 * surfaced via the `parseErrors` array, NOT silently dropped. Stderr is
 * forwarded to the parent's stderr verbatim so the operator sees child
 * progress in real time.
 *
 * ALWAYS resolves — the caller switches on `exitCode`/`signal`. Use
 * `runJsonLinesAsyncStrict` if you want exception-based control flow.
 *
 * `timeoutMs` (optional, default OFF) is an ABSOLUTE-duration kill: SIGTERM
 * after that long, then SIGKILL after `killGraceMs`. `idleTimeoutMs` (optional,
 * default OFF) is an INACTIVITY kill: the timer resets on every stdout chunk and
 * fires only after that long with NO output. Either, both, or neither may be
 * set; the first to fire wins and its reason is recorded. Both default-off so
 * every existing call site is byte-identical in behaviour (#20 Backward Compat).
 *
 * Prefer `idleTimeoutMs` for a child that STREAMS progress (like `extract.mjs`,
 * which emits a record per file): a healthy-but-slow run keeps resetting the
 * idle timer and is never killed for total duration, while a genuinely wedged
 * run (no output for the threshold) still is. An absolute `timeoutMs` bounds
 * total wall-time regardless of progress — correct only for a child whose
 * silence is not a reliable wedge signal.
 *
 * This works only because the timer runs in the PARENT. A child doing
 * substantial synchronous work blocks its own event loop, so no in-child
 * timer could ever fire — a process boundary is the only thing that actually
 * interrupts it, and callers like `refresh.mjs` already have one. (The idle
 * timer is parent-side too, so it observes silence correctly even while the
 * child is blocked in synchronous work.)
 *
 * LIMITATION — kills the direct child only, not its descendants. The child is
 * not spawned detached into its own process group, so a grandchild it spawned
 * can outlive the kill. Every current caller runs a leaf process (`extract.mjs`
 * calls dep-cruiser in-process as a library, `summarise`/`embed` make network
 * calls), so no descendant exists to orphan today. If you add a caller whose
 * child spawns its OWN subprocesses, this needs a process-group kill first
 * (`detached: true` + `process.kill(-pid)` on POSIX, `taskkill /T /F` on
 * Windows) — do not assume the timeout cleans up a process tree.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, env?: Record<string,string>, stage?: string,
 *          timeoutMs?: number, idleTimeoutMs?: number, killGraceMs?: number}} [opts]
 * @returns {Promise<{
 *   records: object[],
 *   parseErrors: {lineNo: number, line: string, message: string}[],
 *   exitCode: number | null,
 *   signal: string | null,
 *   spawnError: Error | null,
 *   timedOut: boolean,
 *   killReason: 'absolute' | 'idle' | null,
 * }>}
 */
/**
 * Pure timeout state machine for {@link runJsonLinesAsync}, split out so the
 * absolute/idle/close/error interleaving is testable WITHOUT a real subprocess
 * (inject `setTimeoutFn`/`clearTimeoutFn`). Owns exactly one kill decision:
 *
 *   - `onTimeout(reason)` is the ONLY path that initiates a kill. It is
 *     idempotent (a second timer expiry after the first is a no-op), records the
 *     FIRST reason, clears the OTHER timeout timer, calls `sendTerm()` once, and
 *     arms the single grace timer that calls `sendKill()`.
 *   - `onData()` resets the idle deadline (only while still active).
 *   - `dispose()` clears every timer. The caller invokes it from BOTH `close`
 *     and `error` — neither of which is a kill. `runJsonLinesAsync` ALWAYS
 *     resolves (never rejects): a natural close resolves with the exit result,
 *     and a spawn/process `error` is recorded as `spawnError` on the resolved
 *     result (the strict wrapper then maps it to a `SPAWN_FAILED` throw). Only
 *     `onTimeout` ever sets `timedOut`.
 *
 * @param {{timeoutMs?: number, idleTimeoutMs?: number, killGraceMs?: number,
 *          sendTerm: () => void, sendKill: () => void,
 *          setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout}} cfg
 */
export function makeTimeoutController(cfg) {
  const setT = cfg.setTimeoutFn || setTimeout;
  const clearT = cfg.clearTimeoutFn || clearTimeout;
  const absMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : 0;
  const idleMs = Number.isFinite(cfg.idleTimeoutMs) && cfg.idleTimeoutMs > 0 ? cfg.idleTimeoutMs : 0;
  const graceMs = Number.isFinite(cfg.killGraceMs) && cfg.killGraceMs >= 0 ? cfg.killGraceMs : 5000;

  let state = 'active';           // 'active' | 'terminating' | 'disposed'
  let killReason = null;          // 'absolute' | 'idle' | null — first wins
  let absTimer = null;
  let idleTimer = null;
  let graceTimer = null;

  const armIdle = () => {
    if (idleMs <= 0) return;
    idleTimer = setT(() => onTimeout('idle'), idleMs);
    idleTimer?.unref?.();
  };

  function onTimeout(reason) {
    if (state !== 'active') return;   // idempotent — first expiry wins
    state = 'terminating';
    killReason = reason;
    // Clear BOTH timeout timers so the other one cannot also fire.
    if (absTimer) { clearT(absTimer); absTimer = null; }
    if (idleTimer) { clearT(idleTimer); idleTimer = null; }
    cfg.sendTerm();
    // SIGTERM is a request; a child wedged in synchronous work may never
    // service it, so escalate to SIGKILL after the grace window.
    graceTimer = setT(() => cfg.sendKill(), graceMs);
    graceTimer?.unref?.();
  }

  return {
    /** Arm the absolute + idle timers. Call once after spawn. */
    arm() {
      if (state !== 'active') return;
      if (absMs > 0) { absTimer = setT(() => onTimeout('absolute'), absMs); absTimer?.unref?.(); }
      armIdle();
    },
    /** Reset the idle deadline on child output (only while active). */
    onData() {
      if (state !== 'active' || idleMs <= 0) return;
      if (idleTimer) { clearT(idleTimer); idleTimer = null; }
      armIdle();
    },
    /** Clear every timer. Called from close AND error — never initiates a kill. */
    dispose() {
      state = 'disposed';
      if (absTimer) { clearT(absTimer); absTimer = null; }
      if (idleTimer) { clearT(idleTimer); idleTimer = null; }
      if (graceTimer) { clearT(graceTimer); graceTimer = null; }
    },
    get timedOut() { return killReason !== null; },
    get killReason() { return killReason; },
    get _state() { return state; },
  };
}

export function runJsonLinesAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'inherit'],   // inherit stderr — verbatim forward
      env: { ...process.env, ...(opts.env || {}) },
      // shell: false (default) — safer; we never construct shell-strings here
    });

    const records = [];
    const parseErrors = [];
    let lineNo = 0;
    let stdoutBuf = '';
    let spawnError = null;
    let settled = false;

    // Absolute + idle timeouts, close/error settling, and the SIGTERM→SIGKILL
    // escalation all live in one state machine so they can't interleave (a
    // natural close and a timeout kill can never both "win"). `dispose()` from
    // close/error clears every timer; only `onTimeout` sets timedOut.
    const timeouts = makeTimeoutController({
      timeoutMs: opts.timeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      killGraceMs: opts.killGraceMs,
      sendTerm: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
      sendKill: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
    });
    timeouts.arm();

    function flushLine(line) {
      lineNo++;
      if (line.length === 0) return; // skip empties — matches sync filter(Boolean)
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        // Bounded preview to avoid leaking huge payloads into the error.
        parseErrors.push({
          lineNo,
          line: line.length > 200 ? line.slice(0, 200) + '…' : line,
          message: err.message,
        });
      }
    }

    // Gemini-G1: if the child exits early (e.g. embed.mjs crashes at
    // startup) while Node is still flushing input to the pipe, the
    // stdin stream will emit `EPIPE` / `ECONNRESET`. Unhandled stream
    // errors crash the parent process, bypassing this Promise's catch.
    // The actual child failure still surfaces through `close` (exitCode
    // / signal); we just need to swallow the stdin write-side error so
    // the orchestrator can report the real failure cleanly.
    child.stdin.on('error', () => { /* see G1 comment above */ });

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      // Any output is progress — reset the idle deadline BEFORE parsing, so a
      // partial-line write still counts as liveness.
      timeouts.onData();
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        flushLine(stdoutBuf.slice(0, nl));
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
    });

    child.on('error', (err) => {
      // ENOENT / EACCES / etc. — child never ran. close/exit may also fire,
      // but we record the error here so the caller can distinguish
      // "spawn failed" from "ran and exited non-zero". NOT a kill: dispose the
      // timers and let close/this path settle via the spawnError branch.
      spawnError = err;
      timeouts.dispose();
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      timeouts.dispose();
      // Flush any trailing line without a final \n.
      if (stdoutBuf.length > 0) flushLine(stdoutBuf);
      resolve({ records, parseErrors, exitCode, signal, spawnError,
                timedOut: timeouts.timedOut, killReason: timeouts.killReason });
    });

    if (opts.input !== undefined) {
      // String input only; the existing sync helper accepted strings.
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Strict wrapper around `runJsonLinesAsync`. Throws a tagged Error
 * (`err.code` = one of `SUBPROC_ERROR_CODES`) when the child:
 *   - failed to spawn (`SPAWN_FAILED`, cause = the spawn error)
 *   - died on signal (`KILLED_BY_SIGNAL`)
 *   - exited non-zero (`EXIT_NONZERO`)
 *   - produced more parse errors than `opts.maxParseErrors` allows
 *     (`PARSE_FAILED_HARD`; default 0 — strict by default; pass
 *     `Infinity` to opt back into the legacy tolerant behaviour)
 *
 * Error carries `.cause = the full async result` so the catch can read
 * `cause.exitCode`, `cause.parseErrors`, `cause.signal`, `.stage` (if
 * `opts.stage` was set — surfaces which pipeline stage failed at a glance).
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, env?: Record<string,string>, stage?: string, maxParseErrors?: number}} [opts]
 * @returns {Promise<object[]>}  records on success
 */
export async function runJsonLinesAsyncStrict(cmd, args, opts = {}) {
  const maxParseErrors = opts.maxParseErrors ?? 0;
  const stage = opts.stage;
  const result = await runJsonLinesAsync(cmd, args, opts);

  // Spawn failure: child never ran. ENOENT, EACCES, etc.
  if (result.spawnError) {
    const stageTag = stage ? `stage=${stage} ` : '';
    const err = new Error(
      `subprocess failed to spawn: ${stageTag}cmd=${cmd} — ${result.spawnError.message}`
    );
    err.code = SUBPROC_ERROR_CODES.SPAWN_FAILED;
    err.stage = stage ?? null;
    err.cause = result;
    throw err;
  }

  // Timed out — classified BEFORE the signal check on purpose. A child killed
  // by the timeout does not reliably report a signal on every platform
  // (Windows commonly surfaces an exit code instead), and a timeout that
  // silently downgraded to EXIT_NONZERO there would be indistinguishable from
  // an ordinary crash — so the caller could not synthesise `extraction_timeout`.
  // Surfaced as a THROW with `cause.timedOut`, never as a flag on the success
  // return: this wrapper returns only `records` on success, so a result flag
  // would be unreachable by construction.
  if (result.timedOut) {
    const stageTag = stage ? `stage=${stage} ` : '';
    // Report the reason + the threshold that actually fired — an idle kill has
    // no `opts.timeoutMs`, so the old message would have printed `undefined`.
    const reason = result.killReason || 'timeout';
    const thresholdMs = result.killReason === 'idle' ? opts.idleTimeoutMs : opts.timeoutMs;
    const err = new Error(
      `subprocess ${reason === 'idle' ? 'went idle' : 'timed out'} after ${thresholdMs}ms `
      + `(${reason}): ${stageTag}cmd=${cmd}`
      + `${result.signal ? ` signal=${result.signal}` : ''}`
    );
    err.code = SUBPROC_ERROR_CODES.KILLED_BY_SIGNAL;
    err.stage = stage ?? null;
    err.signal = result.signal;
    err.timedOut = true;
    err.killReason = result.killReason ?? null;
    err.cause = result;   // carries cause.timedOut === true + cause.killReason
    throw err;
  }

  // Killed by signal (SIGTERM, SIGKILL, …).
  if (result.signal) {
    const stageTag = stage ? `stage=${stage} ` : '';
    const err = new Error(
      `subprocess killed by signal: ${stageTag}cmd=${cmd} signal=${result.signal}`
    );
    err.code = SUBPROC_ERROR_CODES.KILLED_BY_SIGNAL;
    err.stage = stage ?? null;
    err.signal = result.signal;
    err.cause = result;
    throw err;
  }

  // Non-zero exit.
  if (result.exitCode !== 0) {
    const stageTag = stage ? `stage=${stage} ` : '';
    const err = new Error(
      `subprocess exited non-zero: ${stageTag}cmd=${cmd} exit=${result.exitCode}`
    );
    err.code = SUBPROC_ERROR_CODES.EXIT_NONZERO;
    err.stage = stage ?? null;
    err.exitCode = result.exitCode;
    err.cause = result;
    throw err;
  }

  // Parse errors over budget — the silent-data-loss invariant violation.
  if (result.parseErrors.length > maxParseErrors) {
    const preview = result.parseErrors.slice(0, 3).map(p => `L${p.lineNo}: ${p.message}`).join('; ');
    const stageTag = stage ? `stage=${stage} ` : '';
    const err = new Error(
      `subprocess emitted ${result.parseErrors.length} malformed JSON line(s) ` +
      `(maxParseErrors=${maxParseErrors}): ${stageTag}cmd=${cmd} — ${preview}`
    );
    err.code = SUBPROC_ERROR_CODES.PARSE_FAILED_HARD;
    err.stage = stage ?? null;
    err.parseErrors = result.parseErrors;
    err.cause = result;
    throw err;
  }

  return result.records;
}
