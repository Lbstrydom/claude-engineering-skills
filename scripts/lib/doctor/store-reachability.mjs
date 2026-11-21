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
  // Validate the value AS WRITTEN, then trim for display: trimming first would
  // let a trailing newline (or whitespace padding past the cap) slip through.
  if (v.length > MAX_POINTER_FIELD) { problems.push(`"${name}" is longer than ${MAX_POINTER_FIELD} characters`); return null; }
  if (CONTROL_CHARS.test(v)) { problems.push(`"${name}" contains control characters`); return null; }
  return v.trim();
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
 * @returns {{present: false, policy: 'absent'} | {present: true, check: string|null, docs: string|null, upstreamReachable: boolean|null, policy: 'private'|'reachable'|'absent'|'undeterminable', problems: string[]}}
 */
export function readStoreSetupPointer(subjectRoot, fsImpl = fs) {
  const file = path.join(subjectRoot, STORE_SETUP_POINTER_PATH);
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return absentOrUnreadable(file, fsImpl);
    }
    return { present: true, check: null, docs: null, upstreamReachable: null, policy: 'undeterminable', problems: [`${STORE_SETUP_POINTER_PATH} could not be read (${err?.code || 'error'})`] };
  }
  let doc;
  try { doc = JSON.parse(raw); } catch {
    return { present: true, check: null, docs: null, upstreamReachable: null, policy: 'undeterminable', problems: [`${STORE_SETUP_POINTER_PATH} is not valid JSON`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { present: true, check: null, docs: null, upstreamReachable: null, policy: 'undeterminable', problems: [`${STORE_SETUP_POINTER_PATH} must be a JSON object`] };
  }
  const problems = [];
  const check = cleanField('check', doc.check, problems);
  const docs = cleanField('docs', doc.docs, problems);
  // A non-boolean is a problem, never coerced: "no" / 0 / "false" in a privacy
  // declaration must not be read as either answer.
  let upstreamReachable = null;
  if (doc.upstreamReachable !== undefined) {
    if (typeof doc.upstreamReachable === 'boolean') upstreamReachable = doc.upstreamReachable;
    else problems.push('"upstreamReachable" must be a boolean');
  }
  if (check === null && docs === null && upstreamReachable === null && problems.length === 0) {
    problems.push('has none of "check", "docs", "upstreamReachable"');
  }
  // An unknown key that LOOKS like the policy declaration (a typo such as "upstreamReachble") while the real key is
  // absent is a declaration we cannot read; any other unknown key is reported and changes nothing.
  let lookalike = false;
  for (const key of Object.keys(doc)) {
    if (key === 'check' || key === 'docs' || key === 'upstreamReachable') continue;
    const shown = JSON.stringify(key.slice(0, 40));
    if (doc.upstreamReachable === undefined && /upstream|reach/i.test(key)) {
      lookalike = true;
      problems.push(`unknown key ${shown} looks like a policy declaration — did you mean "upstreamReachable"?`);
    } else {
      problems.push(`unknown key ${shown} is ignored`);
    }
  }
  // JSON.parse keeps the LAST duplicate, so a second "upstreamReachable" silently overrides the first. Count the DECODED key
  // names in the raw text (an escaped spelling such as "upstream\\u0052eachable" is the same key); a key that cannot be
  // decoded is a declaration we cannot read.
  let duplicated = false;
  try {
    duplicated = decodedKeyNames(raw).filter((k) => k === 'upstreamReachable').length > 1;
    if (duplicated) problems.push('"upstreamReachable" appears more than once');
  } catch {
    duplicated = true;
    problems.push('a key could not be decoded');
  }
  // The one structured policy answer: discovery reads this, never a regex over problem strings.
  const policy = (lookalike || duplicated) ? 'undeterminable' : doc.upstreamReachable === undefined ? 'absent'
    : upstreamReachable === false ? 'private'
      : upstreamReachable === true ? 'reachable' : 'undeterminable';
  return { present: true, check, docs, upstreamReachable, policy, problems };
}

/**
 * Every TOP-LEVEL object key in `raw` (valid JSON, root object), decoded: scan the string tokens and keep those followed by
 * `:` at depth 1. Throws if a key does not decode.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function decodedKeyNames(raw) {
  const names = [];
  let i = 0;
  let depth = 0;
  while (i < raw.length) {
    if (raw[i] === '{' || raw[i] === '[') { depth += 1; i += 1; continue; }
    if (raw[i] === '}' || raw[i] === ']') { depth -= 1; i += 1; continue; }
    if (raw[i] !== '"') { i += 1; continue; }
    let j = i + 1;
    while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
    const token = raw.slice(i, j + 1);
    i = j + 1;
    let k = i;
    while (k < raw.length && /\s/.test(raw[k])) k += 1;
    // TOP-LEVEL keys only (depth 1, directly inside the root object): a nested object may legitimately reuse a name.
    if (raw[k] === ':') { const name = JSON.parse(token); if (depth === 1) names.push(name); }
  }
  return names;
}

/**
 * The read said ENOENT: is the pointer ABSENT, or unreadable behind a link? Only "no .audit-loop at all" and "directory
 * present (a real one, or a link to an EXISTING directory), file truly absent" are absent. A dangling link anywhere, an
 * existing-but-unreadable file, or ANY other lstat/stat failure is undeterminable. Without `lstatSync` (an injected fs
 * that only reads) there is nothing to check and the answer is absent.
 *
 * @param {string} file
 * @param {object} fsImpl
 */
function absentOrUnreadable(file, fsImpl) {
  const undeterminable = (why) => ({ present: true, check: null, docs: null, upstreamReachable: null, policy: 'undeterminable', problems: [`${STORE_SETUP_POINTER_PATH} ${why}`] });
  if (typeof fsImpl.lstatSync !== 'function') return { present: false, policy: 'absent' };
  const probe = (fn, p) => { try { return { stat: fn.call(fsImpl, p) }; } catch (err) { return { code: err?.code || 'error' }; } };
  const dir = path.dirname(file);
  const dirL = probe(fsImpl.lstatSync, dir);
  if (dirL.code) return dirL.code === 'ENOENT' ? { present: false, policy: 'absent' } : undeterminable(`could not be checked (${dirL.code})`);
  if (dirL.stat?.isSymbolicLink?.()) {
    const dirS = typeof fsImpl.statSync === 'function' ? probe(fsImpl.statSync, dir) : { code: 'ENOSTAT' };
    if (dirS.code) return undeterminable(dirS.code === 'ENOENT' ? 'is behind a dangling link' : `link could not be checked (${dirS.code})`);
    if (!dirS.stat?.isDirectory?.()) return undeterminable('is behind a link that is not a directory');
  }
  const fileL = probe(fsImpl.lstatSync, file);
  if (fileL.code) return fileL.code === 'ENOENT' ? { present: false, policy: 'absent' } : undeterminable(`could not be checked (${fileL.code})`);
  return undeterminable('is a dangling link');
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
  // The structured policy, never the raw value: a duplicate-key or otherwise unreadable declaration is not "private".
  if (pointer.present && pointer.policy === 'private') {
    parts.push(`upstream: unreachable-by-policy (declared in ${STORE_SETUP_POINTER_PATH})`);
  }
  if (verdict === STORE_VERDICT.UNREACHABLE && failure.cause) parts.push(`cause: ${failure.cause}`);
  if (verdict === STORE_VERDICT.UNCONFIGURED) parts.push('the tooling runs local-only; cross-session history is not recorded');
  // An undeterminable declaration is a privacy-relevant fault: say so even when the store is reachable.
  if (verdict === STORE_VERDICT.REACHABLE && pointer.present && pointer.policy === 'undeterminable' && pointer.problems.length > 0) {
    parts.push(`${STORE_SETUP_POINTER_PATH} ignored in part: ${pointer.problems.join('; ')}`);
  }
  if (verdict !== STORE_VERDICT.REACHABLE) {
    if (pointer.present && pointer.check) parts.push(`setup check (run it yourself): ${pointer.check}`);
    if (pointer.present && pointer.docs) parts.push(`setup docs: ${pointer.docs}`);
    if (pointer.present && pointer.problems.length > 0) parts.push(`${STORE_SETUP_POINTER_PATH} ignored in part: ${pointer.problems.join('; ')}`);
    if (!pointer.present) parts.push(`no ${STORE_SETUP_POINTER_PATH} in this repo — a team can commit one to tell new developers how to get a store`);
  }
  return parts.join(' | ');
}

const CONNECT_TIMEOUT_MS = 15_000;
const TEARDOWN_TIMEOUT_MS = 2_000;

/**
 * Make ONE bounded attempt to reach the store this repo is configured for.
 *
 * `injectResolvedDbEnv` copies the DSN + TLS mode out of the repo's own `.env`
 * (kept out of `process.env` for isolation); the tunnel TLS pair is copied the
 * same way here, or a tunnelled store would read unreachable from the doctor
 * while every other CLI reached it. `process.env` is the only channel the shared
 * pool reads and `getPool()` is a per-process singleton, so this mirrors
 * `injectResolvedDbEnv`'s existing contract: ONE subject root per process (the
 * doctor's shape), never a genuine shell export overwritten.
 *
 * @param {{subjectRoot: string, loadEnv: Function, injectResolvedDbEnv: Function,
 *          importClient?: () => Promise<object>, timeoutMs?: number}} deps
 * @returns {Promise<{configured: boolean, ok?: boolean, cause?: string, hint?: string}>}
 */
export async function probeStoreReachability({ subjectRoot, loadEnv, injectResolvedDbEnv, importClient, timeoutMs = CONNECT_TIMEOUT_MS, teardownTimeoutMs = TEARDOWN_TIMEOUT_MS }) {
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
    // The race only bounds the VERDICT; a stalled attempt still holds its socket.
    // Close the pool so the abandoned attempt is torn down and cannot keep the
    // process alive after the verdict has been reported.
    // Teardown is itself bounded: a pool end() can wait on the very attempt that
    // wedged, and the verdict must not wait with it.
    let teardownTimer;
    try {
      await Promise.race([
        Promise.resolve().then(() => client.closePool?.()).catch(() => {}),
        new Promise((resolve) => { teardownTimer = setTimeout(resolve, teardownTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(teardownTimer);   // a prompt teardown must not keep the process alive for the full deadline
    }
    return { configured: true, ok: false, cause, hint };
  } finally {
    clearTimeout(timer);
  }
}
