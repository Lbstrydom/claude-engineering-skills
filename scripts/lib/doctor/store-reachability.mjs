/**
 * @fileoverview The doctor's store-reachability verdict, and the org-provided
 * setup pointer shown when the store is not reachable.
 *
 * WHY A VERDICT OF ITS OWN. A consumer whose store is unreachable silently runs
 * local-only: the audit tooling degrades gracefully by design, so the first sign
 * of a missing store is missing cross-session history, weeks later. The connect
 * path logs the failure, but `doctor` did not own it as a check. Three states,
 * never collapsed:
 *
 *   reachable                  a connection was made and a probe query answered
 *   configured-but-unreachable a DSN is configured and the store did not answer
 *   unconfigured (local-only)  no DSN anywhere — a supported mode, but said aloud
 *
 * THE POINTER. How to get set up on a private store is organisation-specific
 * (access approval, a cloud CLI, a tunnel). Upstream stays free of all of it: a
 * consumer may commit `.audit-loop/store-setup.json` — `{"check": "<command>",
 * "docs": "<path or url>"}` — and the doctor PRINTS it when the verdict is not
 * `reachable`. It is never executed: `check` is text for a human to run.
 *
 * Pure except `readStoreSetupPointer` (one fs read, injectable) and
 * `probeStoreReachability` (one connection, injectable).
 *
 * @module scripts/lib/doctor/store-reachability
 */
import fs from 'node:fs';
import path from 'node:path';

export const STORE_VERDICT = Object.freeze({
  REACHABLE: 'reachable',
  UNREACHABLE: 'configured-but-unreachable',
  UNCONFIGURED: 'unconfigured (local-only)',
});

/** Repo-relative path of the optional, committed, org-provided pointer. */
export const STORE_SETUP_POINTER_PATH = '.audit-loop/store-setup.json';

const MAX_POINTER_FIELD = 300;
// Printed to a terminal: no control characters (ANSI escapes, newlines that would
// forge extra report lines).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * @param {{configured: boolean, ok?: boolean}} connect
 * @returns {string} one of STORE_VERDICT
 */
export function classifyStoreReachability(connect) {
  if (!connect?.configured) return STORE_VERDICT.UNCONFIGURED;
  return connect.ok === true ? STORE_VERDICT.REACHABLE : STORE_VERDICT.UNREACHABLE;
}

function cleanField(name, v, problems) {
  if (v === undefined) return null;
  if (typeof v !== 'string' || !v.trim()) { problems.push(`"${name}" must be a non-empty string`); return null; }
  const s = v.trim();
  if (s.length > MAX_POINTER_FIELD) { problems.push(`"${name}" is longer than ${MAX_POINTER_FIELD} characters`); return null; }
  if (CONTROL_CHARS.test(s)) { problems.push(`"${name}" contains control characters`); return null; }
  return s;
}

/**
 * Read the consumer's committed setup pointer.
 *
 * Three outcomes, never collapsed: absent (`present:false`), valid, and present
 * but unusable (`present:true` with `problems`) — a malformed pointer is reported
 * as malformed, never as "no pointer".
 *
 * @param {string} subjectRoot
 * @param {{readFileSync: Function}} [fsImpl]
 * @returns {{present: false} | {present: true, check: string|null, docs: string|null, problems: string[]}}
 */
export function readStoreSetupPointer(subjectRoot, fsImpl = fs) {
  const file = path.join(subjectRoot, STORE_SETUP_POINTER_PATH);
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { present: false };
    return { present: true, check: null, docs: null, problems: [`${STORE_SETUP_POINTER_PATH} could not be read (${err?.code || 'error'})`] };
  }
  let doc;
  try { doc = JSON.parse(raw); } catch {
    return { present: true, check: null, docs: null, problems: [`${STORE_SETUP_POINTER_PATH} is not valid JSON`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { present: true, check: null, docs: null, problems: [`${STORE_SETUP_POINTER_PATH} must be a JSON object`] };
  }
  const problems = [];
  const check = cleanField('check', doc.check, problems);
  const docs = cleanField('docs', doc.docs, problems);
  if (check === null && docs === null && problems.length === 0) problems.push('has neither "check" nor "docs"');
  return { present: true, check, docs, problems };
}

/**
 * The one-line detail for the doctor report. Credential- and host-free by
 * construction: it carries the verdict, a classified cause and the pointer, never
 * a DSN.
 *
 * @param {string} verdict
 * @param {ReturnType<typeof readStoreSetupPointer>} pointer
 * @param {{cause?: string, hint?: string}} [failure]
 * @returns {string}
 */
export function renderStoreDetail(verdict, pointer, failure = {}) {
  const parts = [`store: ${verdict}`];
  if (verdict === STORE_VERDICT.UNREACHABLE && failure.cause) parts.push(`cause: ${failure.cause}`);
  if (verdict === STORE_VERDICT.UNCONFIGURED) parts.push('the tooling runs local-only; cross-session history is not recorded');
  if (verdict !== STORE_VERDICT.REACHABLE) {
    if (pointer.present && pointer.check) parts.push(`setup check (run it yourself): ${pointer.check}`);
    if (pointer.present && pointer.docs) parts.push(`setup docs: ${pointer.docs}`);
    if (pointer.present && pointer.problems.length > 0) parts.push(`${STORE_SETUP_POINTER_PATH} ignored in part: ${pointer.problems.join('; ')}`);
    if (!pointer.present) parts.push(`no ${STORE_SETUP_POINTER_PATH} in this repo — a team can commit one to tell new developers how to get a store`);
  }
  return parts.join(' | ');
}

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Make ONE bounded attempt to reach the store this repo is configured for.
 *
 * `injectResolvedDbEnv` copies the DSN + TLS mode out of the repo's own `.env`
 * (kept out of `process.env` for isolation); the tunnel TLS pair is copied the
 * same way here, or a tunnelled store would read unreachable from the doctor
 * while every other CLI reached it.
 *
 * @param {{subjectRoot: string, loadEnv: Function, injectResolvedDbEnv: Function,
 *          importClient?: () => Promise<object>, timeoutMs?: number}} deps
 * @returns {Promise<{configured: boolean, ok?: boolean, cause?: string, hint?: string}>}
 */
export async function probeStoreReachability({ subjectRoot, loadEnv, injectResolvedDbEnv, importClient, timeoutMs = CONNECT_TIMEOUT_MS }) {
  const env = loadEnv(subjectRoot);
  injectResolvedDbEnv(env, subjectRoot);
  for (const key of ['AUDIT_DB_SSL_SERVERNAME', 'AUDIT_DB_SSL_CA']) {
    const v = env?.[key];
    if (v != null && v !== '' && process.env[key] === undefined) process.env[key] = v;
  }
  const client = await (importClient ?? (() => import('../db/client.mjs')))();
  let timer;
  try {
    const attempt = (async () => {
      const pool = await client.getPool();
      if (!pool) return { configured: false };
      await pool.query('SELECT 1');
      return { configured: true, ok: true };
    })();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('connection attempt timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    });
    return await Promise.race([attempt, deadline]);
  } catch (err) {
    const { cause, hint } = client.classifyDbConnectionError(err);
    return { configured: true, ok: false, cause, hint };
  } finally {
    clearTimeout(timer);
  }
}
