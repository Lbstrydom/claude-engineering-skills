/**
 * @fileoverview The five standing-queue reads, extracted from
 * `scripts/backlog-snapshot.mjs` so the CLI and the dashboard Home card share ONE
 * definition of "what is a queue" (the failure `backlog-snapshot.mjs`'s header
 * documents: counting rows once reported 20 against 232).
 *
 * `gatherBacklogEnvelopes` returns BOTH shapes of the answer:
 *   - `envelopes` — the CLI's `null`-on-failure shape, so `renderBacklogSnapshot`
 *     and its `unmeasured` rendering are unchanged. A failed read is `null`,
 *     NEVER an empty envelope (an empty envelope would render as `0`).
 *   - `outcomes` — the failure KIND, preserved end to end instead of collapsed to
 *     `null`, so a dashboard can tell "store is down" (expected absence) from
 *     "the reader is broken" (a defect).
 *
 * **The classification is built from measurement, not guessed.** Readers that
 * cannot reach the store exit non-zero WITH a JSON envelope on stdout, so the exit
 * code alone cannot separate "store down" from "reader broke". The closed lists
 * below come from `tests/fixtures/dashboard-home/store-unreachable-envelopes.json`,
 * a real capture of each reader with the store unreachable (closed port) and with
 * the DSN empty (the air-gap signal). `store-unreachable` requires STRUCTURED
 * evidence — a recognised envelope code or a captured signature — never the mere
 * absence of output, so a crashing reader cannot masquerade as an unreachable store.
 *
 * Read-only: no store write. Plan: docs/plans/dashboard-home-summary.md §2.
 *
 * @module scripts/lib/store/backlog-gather
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSchemaFaultSqlstate } from '../db/errors.mjs';
import { isCompleteAnswer } from './backlog-snapshot.mjs';

/** The five reads. `script` is relative to the scripts directory (`here`). */
export const READERS = Object.freeze({
  q1: Object.freeze({ script: 'cross-skill.mjs', args: Object.freeze(['list-unlocked-fixes']) }),
  q2: Object.freeze({ script: 'cross-skill.mjs', args: Object.freeze(['list-unremediated-acceptances']) }),
  q3: Object.freeze({ script: 'cross-skill.mjs', args: Object.freeze(['final-review-pending', '--repo']) }),
  upstream: Object.freeze({ script: 'cross-skill.mjs', args: Object.freeze(['upstream', 'list']) }),
  debt: Object.freeze({ script: 'debt-reconcile.mjs', args: Object.freeze(['--json']) }),
});

/** `ok:false` codes that name the store as unreachable on their own (seen in the capture). */
export const STORE_UNREACHABLE_CODES = Object.freeze(['CLOUD_UNREACHABLE', 'REPO_RESOLVE_FAILED', 'LIST_FAILED']);

/**
 * Codes that are generic (`LIST_FAILED` also covers a bad query) and only mean
 * "unreachable" when the envelope ALSO carries connection-class evidence.
 */
const NEEDS_CONNECTION_EVIDENCE = new Set(['REPO_RESOLVE_FAILED', 'LIST_FAILED']);
const CONNECTION_EVIDENCE = /\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH)\b|store was unreachable/i;

/**
 * Envelope signatures (no `error.code`) the capture showed for an unreachable
 * store: `debt-reconcile --json` refuses with `reason: repo-identity-unresolved`
 * (it resolves the repo identity from the store, so no store = no identity).
 */
export const STORE_UNREACHABLE_REASONS = Object.freeze({
  debt: Object.freeze(['repo-identity-unresolved']),
});

/**
 * (reader, exit-code) signatures that fail WITHOUT an envelope when the store is
 * unreachable. The capture found none: every reader prints an envelope. So an
 * envelope-less non-zero exit is `process-failed`, always.
 */
export const STORE_UNREACHABLE_NO_ENVELOPE_SIGNATURES = Object.freeze([]);

/** Outcome kind → the dashboard's SourceStatus (schema.mjs `SourceStatusSchema`). */
export const KIND_TO_STATUS = Object.freeze({
  ok: 'ok',
  'store-off': 'missing-optional',
  'store-unreachable': 'missing-optional',
  timeout: 'missing-optional',
  'schema-fault': 'unexpected-error',
  'process-failed': 'unexpected-error',
  malformed: 'unexpected-error',
});

/** Last JSON object on stdout (the readers print one envelope; stderr carries progress). */
function lastEnvelope(stdout) {
  const line = String(stdout ?? '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** A code is only echoed when it is shaped like one — never free text, never a DSN. */
const safeCode = (c) => (typeof c === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(c) ? c : null);
const out = (kind, detail) => ({ kind, detail });

/** A SQLSTATE the envelope carries, if any. */
function sqlstateOf(env) {
  return [env.error?.sqlstate, env.sqlstate, env.error?.code].find((c) => typeof c === 'string' && isSchemaFaultSqlstate(c)) ?? null;
}

/**
 * Classify one reader's result. PURE. One decision tree, top to bottom, first
 * match wins, so the kinds are mutually exclusive (plan §2).
 *
 * @param {object} input
 * @param {number|null} input.exitCode
 * @param {string} input.stdout
 * @param {boolean} [input.aborted] - the deadline fired and the child was killed
 * @param {'q1'|'q2'|'q3'|'upstream'|'debt'} input.reader
 * @returns {{kind: keyof typeof KIND_TO_STATUS, detail: string}}
 */
export function classifyReaderResult({ exitCode, stdout, aborted = false, reader }) {
  if (aborted) return out('timeout', 'reader timed out and was stopped');
  const env = lastEnvelope(stdout);
  if (env) {
    if (env.cloud === false || (reader === 'q3' && env.state === 'disabled')
        || (env.measured === false && env.reason === 'cloud-off')) {
      return out('store-off', 'store not configured (cloud off)');
    }
    if (reader === 'q3' && env.state === 'unavailable') {
      if (env.diagnostic === 'CLOUD_UNREACHABLE') return out('store-unreachable', 'store unreachable (CLOUD_UNREACHABLE)');
      if (env.diagnostic === 'NOT_MIGRATED') return out('schema-fault', 'store schema not migrated (NOT_MIGRATED)');
      return out('process-failed', `reader reported unavailable (${safeCode(env.diagnostic) ?? 'no diagnostic'})`);
    }
    if (env.ok === false) {
      // Stronger structured evidence first: a typed SQLSTATE is a schema fault even when the envelope ALSO
      // carries a code or reason that, alone, would read as an unreachable store.
      const sqlstate = sqlstateOf(env);
      if (sqlstate) return out('schema-fault', `schema fault (SQLSTATE ${safeCode(sqlstate)})`);
      const code = safeCode(env.error?.code);
      const message = `${env.error?.message ?? ''} ${env.error?.error ?? ''}`;
      if (code && STORE_UNREACHABLE_CODES.includes(code)
          && (!NEEDS_CONNECTION_EVIDENCE.has(code) || CONNECTION_EVIDENCE.test(message))) {
        return out('store-unreachable', `store unreachable (${code})`);
      }
      const reason = safeCode(env.reason);
      if (!code && reason && STORE_UNREACHABLE_REASONS[reader]?.includes(reason)) {
        return out('store-unreachable', `store unreachable (${reason})`);
      }
      return out('process-failed', `reader reported failure (exit ${exitCode}, ${code ?? reason ?? 'no code'})`);
    }
    if (isCompleteAnswer(reader, env)) {
      // The CLI keeps an envelope only from an exit-0 run; a measured-looking answer from a failing run is not evidence.
      return exitCode === 0 ? out('ok', 'measured') : out('process-failed', `measured envelope but exit ${exitCode}`);
    }
    return out('process-failed', `reader answered without a complete measurement (${safeCode(env.reason) ?? 'no reason'})`);
  }
  if (exitCode === 0) return out('malformed', 'exit 0 but no JSON envelope on stdout');
  if (STORE_UNREACHABLE_NO_ENVELOPE_SIGNATURES.some((s) => s.reader === reader && s.exitCode === exitCode)) {
    return out('store-unreachable', `store unreachable (captured signature, exit ${exitCode})`);
  }
  return out('process-failed', `reader exited ${exitCode} with no JSON envelope`);
}

const MAX_BUFFER = 32 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const CLOSE_WAIT_MS = 5_000;

/**
 * Default child runner: `spawn` with a timeout and the caller's AbortSignal. Never rejects.
 *
 * On abort/timeout the child gets SIGTERM, then SIGKILL after a grace (a reader that traps
 * SIGTERM must not keep running), and the promise resolves only after the child's `close` —
 * bounded: if it has still not closed after grace + wait, it resolves with
 * `childExited:false` so the caller can say so instead of claiming the child was released.
 *
 * @returns {Promise<{exitCode: number|null, stdout: string, aborted: boolean, childExited: boolean}>}
 */
export function execReader({ script, args, cwd, timeoutMs, signal, graceMs = KILL_GRACE_MS, closeWaitMs = CLOSE_WAIT_MS, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(process.execPath, [script, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve({ exitCode: null, stdout: '', aborted: false, childExited: true }); return; }
    let stdout = ''; let bytes = 0; let aborted = false; let overflow = false; let done = false;
    const timers = [];
    const finish = (r) => { if (done) return; done = true; timers.forEach(clearTimeout); signal?.removeEventListener('abort', stop); resolve(r); };
    function stop() {
      if (aborted || done) return;
      aborted = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      timers.push(setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, graceMs));
      timers.push(setTimeout(() => finish({ exitCode: null, stdout, aborted: true, childExited: false }), graceMs + closeWaitMs));
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > MAX_BUFFER) { if (!overflow) { overflow = true; try { child.kill('SIGKILL'); } catch { /* gone */ } } return; }
      stdout += d;
    });
    child.stderr.resume();
    child.on('error', () => finish({ exitCode: null, stdout, aborted, childExited: true }));
    child.on('close', (code) => finish({ exitCode: aborted || overflow ? null : code, stdout, aborted, childExited: true }));
    if (timeoutMs) timers.push(setTimeout(stop, timeoutMs));
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
  });
}

// Siblings resolve relative to THIS FILE, never to a computed repo root: in a consumer
// the bundle lives at `scripts/.claude-skills/`, and this module sits two levels below it.
const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Run the five reads in parallel and return both the envelopes and the outcomes.
 *
 * @param {object} [opts]
 * @param {string} [opts.repo]       - `owner/repo` slug for Q3; empty ⇒ Q3 is not asked
 * @param {string} [opts.here]       - scripts directory holding the readers
 * @param {string} [opts.cwd]        - child cwd (the repo being reported on)
 * @param {Function} [opts.run]      - injectable `({script,args,cwd,timeoutMs,signal}) => Promise<{exitCode,stdout,aborted}>`
 * @param {number} [opts.timeoutMs]  - per-read cap
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{envelopes: Record<string, object|null>, outcomes: Record<string, {kind: string, detail: string}>}>}
 */
export async function gatherBacklogEnvelopes({
  repo = '', here = SCRIPTS_DIR, cwd = process.cwd(), run = execReader, timeoutMs = 120_000, signal,
} = {}) {
  const envelopes = {};
  const outcomes = {};
  await Promise.all(Object.entries(READERS).map(async ([key, def]) => {
    if (key === 'q3' && !repo) {
      envelopes[key] = null;
      outcomes[key] = out('store-off', 'no repository slug resolved, so the final-review queue was not asked');
      return;
    }
    const args = key === 'q3' ? [...def.args, repo] : [...def.args];
    let res;
    try {
      res = await run({ script: path.join(here, def.script), args, cwd, timeoutMs, signal });
    } catch {
      res = { exitCode: null, stdout: '', aborted: false };
    }
    let outcome = classifyReaderResult({ ...res, reader: key });
    // An aborted child that never closed was NOT released; say so rather than imply it was.
    if (res.aborted && res.childExited === false) outcome = out('timeout', 'reader timed out; child did not exit');
    outcomes[key] = outcome;
    // Byte-identical to the CLI's old readEnvelope: a non-zero exit or unparseable output is `null`.
    envelopes[key] = res.exitCode === 0 ? lastEnvelope(res.stdout) : null;
  }));
  return { envelopes, outcomes };
}
