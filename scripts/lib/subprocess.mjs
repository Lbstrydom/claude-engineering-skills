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
 * `timeoutMs` (optional, default OFF) kills the child after that long:
 * SIGTERM, then SIGKILL after `killGraceMs`. It is default-off so every
 * existing call site is byte-identical in behaviour (#20 Backward Compat).
 *
 * This works only because the timer runs in the PARENT. A child doing
 * substantial synchronous work blocks its own event loop, so no in-child
 * timer could ever fire — a process boundary is the only thing that actually
 * interrupts it, and callers like `refresh.mjs` already have one.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, env?: Record<string,string>, stage?: string,
 *          timeoutMs?: number, killGraceMs?: number}} [opts]
 * @returns {Promise<{
 *   records: object[],
 *   parseErrors: {lineNo: number, line: string, message: string}[],
 *   exitCode: number | null,
 *   signal: string | null,
 *   spawnError: Error | null,
 *   timedOut: boolean,
 * }>}
 */
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
    let timedOut = false;
    let termTimer = null;
    let killTimer = null;

    if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      const graceMs = Number.isFinite(opts.killGraceMs) && opts.killGraceMs >= 0
        ? opts.killGraceMs : 5000;
      termTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        // SIGTERM is a request. A child wedged in synchronous work may never
        // service it, so escalate — otherwise the "timeout" would hand back a
        // verdict while leaving a live process behind.
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, graceMs);
        killTimer.unref?.();
      }, opts.timeoutMs);
      termTimer.unref?.();
    }

    const clearTimers = () => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
    };

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
      // "spawn failed" from "ran and exited non-zero".
      spawnError = err;
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Flush any trailing line without a final \n.
      if (stdoutBuf.length > 0) flushLine(stdoutBuf);
      resolve({ records, parseErrors, exitCode, signal, spawnError, timedOut });
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
    const err = new Error(
      `subprocess timed out after ${opts.timeoutMs}ms: ${stageTag}cmd=${cmd}`
      + `${result.signal ? ` signal=${result.signal}` : ''}`
    );
    err.code = SUBPROC_ERROR_CODES.KILLED_BY_SIGNAL;
    err.stage = stage ?? null;
    err.signal = result.signal;
    err.timedOut = true;
    err.cause = result;   // carries cause.timedOut === true
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
