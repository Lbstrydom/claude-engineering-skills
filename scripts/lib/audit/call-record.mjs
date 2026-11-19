/**
 * @fileoverview Request/response records for `openai-audit.mjs code --resume`.
 * Plan: docs/plans/sashiko-audit-improvements.md §3 (PR A).
 *
 * Every SUCCESSFUL structured GPT call of a legacy code-audit round is written to
 * `.audit/call-records/<auditedTree>/<sid>-r<round>/<requestKey>.json`. A later
 * `--resume` of the SAME session and round, against the SAME tree, replays a
 * record instead of paying for the call again, so a quota stop (429/timeout) does
 * not re-pay the passes that finished.
 *
 * Identity is content, never time:
 *  - the key is sha256 over the effective request (route + model + every
 *    output-affecting param + prompt + schema) — nothing time-derived;
 *  - the namespace is the audited tree AND the SID/round, and the envelope stores
 *    all three, so a record found in the right directory but carrying another
 *    identity is a miss;
 *  - a hit must re-parse against the CURRENT schema, and its stored key fields must
 *    hash to its own name; anything else is a miss and the call goes live.
 * Replay happens only when `--resume` was passed, so a fresh round stays fresh.
 * Only a call that returned successfully is ever written (`callGPT`'s success
 * return), so a truncated/incomplete/failed answer can never be replayed.
 * Every I/O failure degrades to the live path, loudly, and never fails the audit.
 *
 * Process-level singleton, like the cache this replaces: the CLI is one run per
 * process (AGENTS.md accepted debt, module-global caches).
 *
 * @module scripts/lib/audit/call-record
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from '../file-io.mjs';

export const CALL_RECORD_KEY_VERSION = 1;
export const CALL_RECORD_ROOT_REL = path.join('.audit', 'call-records');
const DEFAULT_KEEP = 5;

const state = {
  enabled: false, resume: false, dir: null, rootDir: null,
  identity: null, // { auditedTree, auditSessionId, auditRound }
  replayed: 0, live: 0, writes: 0, writeFailures: 0, readMisses: 0,
};

const log = (m) => process.stderr.write(`  [call-record] ${m}\n`);

/** Canonical JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The request key + the fields it hashes (stored in the envelope so a hit can be re-verified). */
export function requestKeyFor(keyFields) {
  const fields = { v: CALL_RECORD_KEY_VERSION, ...keyFields };
  return { requestKey: sha256(canonicalJson(fields)), keyFields: fields };
}

function dirFor(rootDir, identity) {
  const leaf = `${String(identity.auditSessionId).replace(/[^\w.-]/g, '_')}-r${identity.auditRound}`;
  return path.join(rootDir, identity.auditedTree, leaf);
}

/**
 * Newest `keep` tree directories survive; the current tree is never removed. Mtime only orders disposable cache
 * entries for deletion — never an identity or a freshness signal. ENOENT/EBUSY from a concurrent deleter = already gone.
 */
export function pruneCallRecords(rootDir, currentTree, keep = DEFAULT_KEEP) {
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return 0; }
  const dated = entries.map((e) => {
    let m = 0; try { m = fs.statSync(path.join(rootDir, e.name)).mtimeMs; } catch { /* gone */ }
    return { name: e.name, m };
  }).sort((a, b) => b.m - a.m);
  let removed = 0;
  for (const [i, e] of dated.entries()) {
    if (e.name === currentTree || i < keep) continue;
    try { fs.rmSync(path.join(rootDir, e.name), { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }); removed++; } catch { /* concurrent deleter / busy */ }
  }
  return removed;
}

/**
 * How many envelopes in `dir` could replay for this identity: a `<sha256>.json` whose parsed envelope names itself and carries
 * this tree/SID/round. An absent directory is zero; any other read error is reported, never folded into "empty".
 * (The schema check stays at lookup, where the schema is known.)
 */
function countUsableRecords(dir, identity) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { return err.code === 'ENOENT' ? { count: 0 } : { count: 0, error: err.code || err.message }; }
  let count = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') continue;   // removed by a concurrent prune: not a record any more
      return { count, error: `${err.code || err.message} reading a record` };   // EACCES/EIO: reported, never "empty"
    }
    try {
      const env = JSON.parse(raw);
      if (env.requestKey === name.slice(0, -5) && env.auditedTree === identity.auditedTree
        && env.auditSessionId === identity.auditSessionId && env.auditRound === identity.auditRound && env.response?.result !== undefined) count++;
    } catch { /* unparseable: not a usable record */ }
  }
  return { count };
}

/**
 * Configure recording for this process.
 * @returns {{ok:true}|{ok:false, reason:string}} — `ok:false` is a refusal only when `resume` was asked for.
 */
export function configureCallRecords({ repoRoot = process.cwd(), identity, resume = false, env = process.env, keep } = {}) {
  Object.assign(state, { enabled: false, resume: false, dir: null, rootDir: null, identity: null, replayed: 0, live: 0, writes: 0, writeFailures: 0, readMisses: 0 });
  const missing = !identity?.auditedTree ? 'audit-target identity unavailable' : !identity.auditSessionId || !Number.isInteger(identity.auditRound) ? 'session id or round unresolved (pass --session-id/--round or a <sid>-r<N>-result.json --out)' : null;
  if (resume && missing) return { ok: false, reason: `cannot resume: ${missing}` };
  if (env.AUDIT_CALL_RECORD === '0') {
    if (resume) return { ok: false, reason: 'cannot resume: AUDIT_CALL_RECORD=0 disables call records' };
    return { ok: true };
  }
  if (missing) { log(`recording off for this run: ${missing}`); return { ok: true }; }
  const rootDir = path.join(repoRoot, CALL_RECORD_ROOT_REL);
  const dir = dirFor(rootDir, identity);
  // A directory alone proves nothing: a run that lost every call leaves an empty one. Resumable = at least one finished call recorded.
  if (resume) {
    const found = countUsableRecords(dir, identity);
    if (found.error) return { ok: false, reason: `cannot resume: record directory unreadable (${found.error})` };
    if (found.count === 0) return { ok: false, reason: `nothing to resume for ${identity.auditSessionId} round ${identity.auditRound} at this tree` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (resume) return { ok: false, reason: `cannot resume: record directory unusable (${err.code || err.message})` };
    log(`recording off: cannot create ${dir}: ${err.code || err.message}`);
    return { ok: true };
  }
  const k = Number.parseInt(env.AUDIT_CALL_RECORD_KEEP ?? '', 10);
  pruneCallRecords(rootDir, identity.auditedTree, keep ?? (Number.isInteger(k) && k > 0 ? k : DEFAULT_KEEP));
  Object.assign(state, { enabled: true, resume, dir, rootDir, identity: { ...identity } });
  return { ok: true };
}

/** Decide whether `--resume` is allowed at all. @returns {string|null} the refusal, or null */
export function resumeRefusal({ resume, mode, tiered }) {
  if (!resume) return null;
  if (mode !== 'code') return `--resume applies to code audits only (resume-unsupported:${mode ?? 'none'})`;
  return tiered ? '--resume is not supported with the tiered pipeline (resume-unsupported:tiered)' : null;
}

/** main()'s check: a refused `--resume` is a usage error (stderr, exit 1). Returns whether `--resume` was passed. */
export function parseResumeFlag(args, { mode, tiered }) {
  const resume = args.includes('--resume');
  const refusal = resumeRefusal({ resume, mode, tiered });
  if (refusal) { process.stderr.write(`Error: ${refusal}
`); process.exit(1); }
  return resume;
}

/** configureCallRecords for a run context; a refused resume is a usage error: message on stderr, exit 1 (nothing has been written to stdout yet). */
export function configureForRun(ctx, opts) {
  const cfg = configureCallRecords({
    repoRoot: process.cwd(),
    identity: { auditedTree: ctx.auditedTree, auditSessionId: opts.auditIdentity?.auditSessionId ?? null, auditRound: opts.auditIdentity?.auditRound ?? null },
    resume: opts.resume === true,
  });
  if (!cfg.ok) { process.stderr.write(`Error: ${cfg.reason}
`); process.exit(1); }
}

/** Stamp a finished result with the run's resume summary (no-op when records were off). */
export function withResumeSummary(result) {
  const sum = resumeSummary();
  return sum && result && typeof result === 'object' ? { ...result, _resume: sum } : result;
}

export const callRecordsActive = () => state.enabled;
export const isResuming = () => state.enabled && state.resume;
export function noteLiveCall() { if (state.enabled) state.live++; }

/** Run summary for the result stamp; null when this run neither recorded nor resumed. */
export function resumeSummary() {
  if (!state.enabled) return null;
  return {
    resumed: state.resume, replayedCalls: state.replayed, liveCalls: state.live,
    recordWriteFailures: state.writeFailures, recordsTree: state.identity.auditedTree,
  };
}

/**
 * A hit only if: the envelope parses, its identity matches this run, its key fields hash to requestKey === filename,
 * and its stored result re-parses against the CURRENT schema. Anything else is a logged miss.
 * @returns {object|null} the stored `response` ({result, usage, model, reasoningEffort}) or null
 */
export function lookupCallRecord(requestKey, schema) {
  if (!state.enabled || !state.resume) return null;
  const file = path.join(state.dir, `${requestKey}.json`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') log(`unreadable record ${requestKey.slice(0, 12)} (${err.code}) — live call`); state.readMisses++; return null; }
  try {
    const env = JSON.parse(raw);
    const id = state.identity;
    if (env.requestKey !== requestKey || sha256(canonicalJson(env.keyFields)) !== requestKey) throw new Error('key fields do not hash to the record name');
    if (env.auditedTree !== id.auditedTree || env.auditSessionId !== id.auditSessionId || env.auditRound !== id.auditRound) throw new Error('identity mismatch');
    const parsed = schema.safeParse(env.response?.result);
    if (!parsed.success) throw new Error('stored result fails the current schema');
    state.replayed++;
    return env.response;
  } catch (err) {
    log(`corrupt record ${requestKey.slice(0, 12)} — ignored (${err.message})`);
    state.readMisses++;
    return null;
  }
}

/** Atomic publish of one successful call. Never throws; a failure is counted and logged. */
export function writeCallRecord(requestKey, keyFields, response) {
  if (!state.enabled) return false;
  try {
    const id = state.identity;
    atomicWriteFileSync(path.join(state.dir, `${requestKey}.json`), JSON.stringify({
      requestKey, keyFields, auditedTree: id.auditedTree, auditSessionId: id.auditSessionId, auditRound: id.auditRound,
      response, recordedAt: new Date().toISOString(), // informational only: never keyed, never read by replay
    }));
    state.writes++;
    // Heartbeat: an active audit keeps its tree newest by mtime, so another process's retention pass (which orders by mtime and
    // keeps the newest N) does not remove it. A pruned tree only costs a replay: lookups miss and calls go live.
    try { const now = new Date(); fs.utimesSync(path.dirname(state.dir), now, now); } catch { /* best effort */ }
    return true;
  } catch (err) {
    state.writeFailures++;
    log(`write failed ${err.code || err.message}`);
    return false;
  }
}

export function _resetCallRecordsForTests() {
  Object.assign(state, { enabled: false, resume: false, dir: null, rootDir: null, identity: null, replayed: 0, live: 0, writes: 0, writeFailures: 0, readMisses: 0 });
}
