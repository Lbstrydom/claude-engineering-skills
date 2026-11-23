/**
 * @fileoverview One spend ceiling per run, enforced AT the provider-call seams
 * (docs/plans/seeded-defect-benchmark.md §2.6).
 *
 * INERT unless `AUDIT_BUDGET_LEDGER` names a ledger file: every seam then runs
 * exactly the code it ran before this module existed. When it is set:
 *
 *  - a call RESERVES an upper bound before it is sent — (UTF-8 bytes of the
 *    request body × input price) + (the request's ENFORCED output cap × output
 *    price). A byte-level BPE token is >= 1 byte, so bytes bound input tokens.
 *    A request with no enforced output cap, or a model with no price, is
 *    REFUSED before sending (`BudgetStopError`, code `budget-stop`);
 *  - the reservation is appended (and fsynced) under an in-process mutex AND a
 *    cross-process exclusive lock file, so two processes cannot both spend the
 *    last dollars;
 *  - states: `reserved` -> `settled` | `failed-billed` | `failed-unbilled` |
 *    `failed-unknown` (| `reconciled` by an operator). Only POSITIVE evidence
 *    makes a failure unbilled; anything else keeps the full reservation as
 *    spent. A settled call with no usable usage keeps its reservation (flagged);
 *  - a `reserved` record whose process is dead is indeterminate: the next
 *    reserve REFUSES until `reconcileCall` records provider evidence. Nothing
 *    re-sends an indeterminate call.
 *
 * Amounts are integer micro-USD internally so "total <= cap" is exact.
 *
 * @module scripts/lib/llm-budget
 */

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { priceFor, costFromUsage, CACHE_MULTIPLIER } from './model-pricing.mjs';

export const BUDGET_LEDGER_ENV = 'AUDIT_BUDGET_LEDGER';
/** Distinct exit code for "the budget stopped the run" (1 = CLI error, 3 = INCOMPLETE audit). */
export const BUDGET_STOP_EXIT_CODE = 5;
export const BUDGET_STOP_CODE = 'budget-stop';

/**
 * Every file under `scripts/**` that constructs a provider request must be in
 * exactly one of these two lists (tests/pilot-budget-ledger.test.mjs derives the
 * set from the filesystem). A new seam therefore cannot silently bypass the
 * budget: it is either wired (SEAM_INVENTORY) or explicitly declared unmetered
 * with a reason.
 */
export const SEAM_INVENTORY = Object.freeze([
  { file: 'scripts/lib/audit/llm-helpers.mjs', seam: '_callGPTOnce', provider: 'openai' },
  { file: 'scripts/lib/final-review/transport.mjs', seam: 'callReviewer', provider: 'google|anthropic|openai-compat' },
  { file: 'scripts/lib/anthropic-client.mjs', seam: 'createAnthropicClient.messages.create', provider: 'anthropic' },
  { file: 'scripts/lib/audit/step-back-provider.mjs', seam: 'responses.create|generateContent (messages.create rides the anthropic client seam)', provider: 'openai|google' },
  { file: 'scripts/lib/llm-wrappers.mjs', seam: 'safeCallGPT|callGemini|callClaude', provider: 'openai|google|anthropic' },
]);

/**
 * Files that construct a request but only through a WIRED seam's client (so the seam meters them). `via` names
 * the seam imports the file must use.
 */
export const METERED_VIA_SEAM = Object.freeze([
  { file: 'scripts/lib/model-eval/concern-matcher.mjs', via: ['createAnthropicClient', 'callGemini'], note: 'judge: sdk-pinned createAnthropicClient + llm-wrappers callGemini' },
]);

const PROBE = 'connectivity/diagnostic probe, tiny fixed output; not on a pilot path';
const OUT_OF_SCOPE = 'not on a pilot path; a pilot run must not route calls through it while AUDIT_BUDGET_LEDGER is set';
/** Provider-request sites that are NOT metered (declared, with reason). */
export const UNMETERED_REQUEST_SITES = Object.freeze([
  { file: 'scripts/anthropic-ping.mjs', reason: PROBE },
  { file: 'scripts/azure-doctor.mjs', reason: PROBE },
  { file: 'scripts/azure-limits.mjs', reason: PROBE },
  { file: 'scripts/gemini-review.mjs', reason: `${PROBE} (the review itself goes through final-review/transport.mjs)` },
  { file: 'scripts/lib/azure/claude-discovery.mjs', reason: PROBE },
  { file: 'scripts/lib/azure/gpt-discovery.mjs', reason: PROBE },
  ...[
    'scripts/campaign.mjs', 'scripts/debt-review.mjs', 'scripts/meta-assess.mjs', 'scripts/refine-prompts.mjs',
    'scripts/solo-control-audit.mjs', 'scripts/lib/arch-memory/normalize-intent.mjs', 'scripts/lib/arm-eval/judge.mjs',
    'scripts/lib/arm-eval/producers/model-call.mjs', 'scripts/lib/audit-shadow.mjs',
    'scripts/lib/audit/tiered-provider-calls.mjs',
    'scripts/lib/brainstorm/azure-claude-adapter.mjs', 'scripts/lib/brainstorm/gemini-adapter.mjs',
    'scripts/lib/brainstorm/openai-adapter.mjs', 'scripts/lib/context.mjs',
    'scripts/lib/model-eval/decision/arm.mjs', 'scripts/lib/model-eval/decision/cross-grade.mjs',
    'scripts/lib/model-eval/decision/judge.mjs', 'scripts/lib/model-eval/provider-adapter.mjs',
    'scripts/lib/neighbourhood-query.mjs', 'scripts/lib/oss-structured-output.mjs',
    'scripts/lib/remediation-verification.mjs', 'scripts/lib/solo-control/cluster-propose.mjs',
    'scripts/lib/solo-control/gate-reviews.mjs', 'scripts/lib/solo-control/judge.mjs', 'scripts/lib/visual/explain.mjs',
    'scripts/lib/work-unit-labels.mjs', 'scripts/symbol-index/summarise-domains.mjs', 'scripts/symbol-index/summarise.mjs',
  ].map((file) => ({ file, reason: OUT_OF_SCOPE })),
]);

/** Raised when the budget refuses or cannot vouch for a call. Never retryable. */
export class BudgetStopError extends Error {
  /**
   * @param {string} reason - machine reason (`would-exceed-cap`, `unpriced-model`, `uncapped-request`, ...)
   * @param {string} message
   * @param {object} [details]
   */
  constructor(reason, message, details = {}) {
    super(`[llm-budget] ${message}`);
    this.name = 'BudgetStopError';
    this.code = BUDGET_STOP_CODE;
    this.reason = reason;
    this.exitCode = BUDGET_STOP_EXIT_CODE;
    this.details = details;
    _stopLatched = true;
  }
}

let _stopLatched = false;
/** True once any BudgetStopError was raised in this process (survives catch-all wrappers that swallow it). */
export function budgetStopOccurred() { return _stopLatched; }
/** Tests only. */
export function _resetBudgetStopLatch() { _stopLatched = false; }

/** @returns {string|null} the ledger path, or null when the budget is inert. */
export function ledgerFileFromEnv(env = process.env) {
  const v = env[BUDGET_LEDGER_ENV];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
export function isBudgetActive(env = process.env) { return ledgerFileFromEnv(env) !== null; }

const MICRO = 1_000_000;
const toMicroCeil = (usd) => Math.ceil(usd * MICRO - 1e-9);
const usdOf = (micro) => micro / MICRO;

// ── Ledger file ──────────────────────────────────────────────────────────────

/**
 * Drop a torn trailing fragment (a crash mid-append left bytes with no newline) BEFORE appending, so the next record never
 * glues onto it. Safe: a reserve is appended before its request is sent, so a torn reserve never reached the wire, and a torn
 * settle/fail leaves its reservation counted (the call stays reserved). Always called under the ledger lock.
 */
function repairTornTail(fd) {
  const size = fs.fstatSync(fd).size;
  if (size === 0) return;
  const last = Buffer.alloc(1);
  fs.readSync(fd, last, 0, 1, size - 1);
  if (last[0] === 0x0a) return;
  const chunk = Buffer.alloc(Math.min(size, 65536));
  const start = size - chunk.length;
  fs.readSync(fd, chunk, 0, chunk.length, start);
  const nl = chunk.lastIndexOf(0x0a);
  if (nl < 0 && start > 0) throw new BudgetStopError('ledger-corrupt', 'ledger tail has no record boundary within 64KiB');
  const fragment = chunk.subarray(nl + 1).toString('utf8');
  // ONE tail policy with readEvents: a COMPLETE record that merely lacks its newline is kept (terminated), never deleted;
  // only an unparseable fragment is a torn append.
  let complete = false; try { JSON.parse(fragment); complete = true; } catch { /* torn */ }
  if (complete) { fs.writeSync(fd, '\n', size); return; }
  fs.ftruncateSync(fd, nl < 0 ? 0 : start + nl + 1);
}

function appendLine(file, obj) {
  const fd = fs.openSync(file, 'r+');
  try {
    repairTornTail(fd);
    // r+ has no append offset: write at the end explicitly, in a CHECKED loop (a short write must never leave a record unterminated).
    const buf = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
    let off = 0; const base = fs.fstatSync(fd).size;
    while (off < buf.length) { const n = fs.writeSync(fd, buf, off, buf.length - off, base + off); if (!(n > 0)) throw new BudgetStopError('ledger-corrupt', 'ledger write made no progress'); off += n; }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readEvents(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') throw new BudgetStopError('ledger-missing', `ledger ${file} does not exist (initLedger first)`);
    throw err;
  }
  // Tail decided from the ORIGINAL file boundary, never from a blank-filtered list: only text after the last newline can be a torn append.
  const raw = text.split('\n');
  const tail = text.endsWith('\n') ? '' : raw.pop();
  const lines = raw.filter((l) => l.trim() !== '');
  if (tail && tail.trim() !== '') lines.push(tail);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    try { events.push(JSON.parse(lines[i])); } catch {
      // Only an UNTERMINATED last fragment is a crash mid-append (a reserve is appended before send, so it never reached the wire).
      // A newline-terminated record that does not parse is corruption: it may have been a real reservation.
      if (i === lines.length - 1 && tail && tail.trim() !== '') break;
      throw new BudgetStopError('ledger-corrupt', `ledger ${file} line ${i + 1} is not valid JSON`);
    }
  }
  if (events.length === 0 || events[0].type !== 'header') {
    throw new BudgetStopError('ledger-corrupt', `ledger ${file} has no header`);
  }
  return events;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Create (or resume) a ledger. An existing ledger with the same cap is resumed;
 * a different cap is refused (raising a cap is a human decision, not a flag).
 * @param {{file: string, capUsd: number, runId?: string}} p
 */
export function initLedger({ file, capUsd, runId } = {}) {
  if (!file) throw new Error('initLedger: file required');
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('initLedger: capUsd must be a positive number');
  const header = { type: 'header', capUsd, runId: runId ?? crypto.randomUUID(), createdAt: new Date().toISOString() };
  try {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeSync(fd, `${JSON.stringify(header)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return header;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const existing = readEvents(file)[0];
  if (existing.capUsd !== capUsd) {
    throw new Error(`initLedger: ${file} already exists with capUsd ${existing.capUsd}; refusing to change it to ${capUsd}`);
  }
  return existing;
}

// ── Lock: in-process mutex + cross-process exclusive lock file ───────────────

const _chains = new Map();
const LOCK_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireFileLock(file) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return lock;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Stale only when the recorded holder is provably dead (or the file is unreadable AND old). Re-read just
    // before removing so a lock another process re-created in the meantime is not deleted.
    try {
      const held = fs.readFileSync(lock, 'utf8').trim();
      const holder = Number.parseInt(held, 10);
      const dead = held !== '' ? !pidAlive(holder) : (Date.now() - fs.statSync(lock).mtimeMs > 10_000);
      if (dead && fs.readFileSync(lock, 'utf8').trim() === held) fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch { /* lock vanished between calls — retry */ }
    if (Date.now() > deadline) throw new BudgetStopError('lock-timeout', `could not take ${lock} within ${LOCK_TIMEOUT_MS}ms`);
    await sleep(5 + Math.floor(Math.random() * 20));
  }
}

function withLedgerLock(file, fn) {
  const prev = _chains.get(file) ?? Promise.resolve();
  const run = prev.then(async () => {
    const lock = await acquireFileLock(file);
    try { return await fn(); } finally { fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  _chains.set(file, run.catch(() => {}));
  return run;
}

// ── Reduction ────────────────────────────────────────────────────────────────

function reduce(events) {
  const header = events[0];
  const calls = new Map();
  for (const e of events.slice(1)) {
    if (e.type === 'reserve') {
      calls.set(e.callId, { ...e, state: 'reserved', costMicro: e.reservedMicro, flags: [] });
    } else if (calls.has(e.callId)) {
      const c = calls.get(e.callId);
      if (e.type === 'settle') {
        c.state = 'settled'; c.costMicro = e.costMicro; c.usage = e.usage; c.modelServed = e.modelServed;
        c.flags = e.flags ?? []; c.tokens = e.tokens;
      } else if (e.type === 'fail') {
        c.state = e.state; c.costMicro = e.costMicro; c.usage = e.usage ?? c.usage; c.error = e.error;
        c.flags = e.flags ?? [];
      } else if (e.type === 'reconcile') {
        c.state = 'reconciled'; c.costMicro = e.costMicro; c.evidence = e.evidence;
      }
    }
  }
  const capMicro = toMicroCeil(header.capUsd);
  let spentMicro = 0; let outstandingMicro = 0; let settledMicro = 0;
  const indeterminate = []; const flagged = [];
  for (const c of calls.values()) {
    if (c.state === 'failed-unbilled') continue;
    spentMicro += c.costMicro;
    if (c.state === 'settled') settledMicro += c.costMicro;
    if (c.state === 'reserved' || c.state === 'failed-unknown') outstandingMicro += c.costMicro;
    if (c.state === 'reserved' && !(c.host === os.hostname() && pidAlive(c.pid))) indeterminate.push(c.callId);
    if (c.flags.length) flagged.push({ callId: c.callId, flags: c.flags });
  }
  return { header, calls, capMicro, spentMicro, outstandingMicro, settledMicro, indeterminate, flagged };
}

/**
 * Read-only summary. spent = settled/billed cost + every reservation still
 * outstanding (in flight, failed-unknown, orphaned) — never less.
 * @param {string} file
 */
export function readLedgerSummary(file) {
  const r = reduce(readEvents(file));
  return {
    capUsd: r.header.capUsd, runId: r.header.runId, createdAt: r.header.createdAt,
    spentUsd: usdOf(r.spentMicro), remainingUsd: usdOf(r.capMicro - r.spentMicro),
    settledUsd: usdOf(r.settledMicro), outstandingUsd: usdOf(r.outstandingMicro),
    indeterminate: r.indeterminate, flagged: r.flagged,
    calls: [...r.calls.values()].map((c) => ({
      callId: c.callId, state: c.state, seam: c.seam, provider: c.provider, model: c.model,
      modelServed: c.modelServed ?? null, reservedUsd: usdOf(c.reservedMicro), costUsd: c.state === 'failed-unbilled' ? 0 : usdOf(c.costMicro),
      tokens: c.tokens ?? null, flags: c.flags, evidence: c.evidence ?? null,
    })),
  };
}

// ── Reservation ──────────────────────────────────────────────────────────────

/**
 * Upper-bound reservation for one request. Pure. Throws BudgetStopError for an
 * unpriced model or a request with no enforced output cap.
 * @returns {{reservedMicro:number, inputBytes:number, outputCap:number}}
 */
export function estimateReservation({ model, body, outputCap }) {
  if (!Number.isInteger(outputCap) || outputCap <= 0) {
    throw new BudgetStopError('uncapped-request',
      `request to "${model}" has no enforced output cap (max_tokens / max_output_tokens / maxOutputTokens); refused while a budget is active`);
  }
  const inputBytes = Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body ?? null), 'utf8');
  // priceFor selects a tier from the (>= real) byte count, so a tiered model reserves at the upper tier.
  const px = priceFor(model, { inputTokens: inputBytes });
  if (!px || !Number.isFinite(px.input) || !Number.isFinite(px.output)) {
    throw new BudgetStopError('unpriced-model', `model "${model}" has no price; refused while a budget is active`);
  }
  // Worst case every input byte is a cache-WRITE token (billed above base input).
  const inRate = px.input * Math.max(1, CACHE_MULTIPLIER.write);
  const reservedMicro = Math.ceil(inputBytes * inRate + outputCap * px.output);
  return { reservedMicro, inputBytes, outputCap };
}

/**
 * Reserve before sending. Throws BudgetStopError when the ledger holds an
 * indeterminate record, or the reservation would exceed the remaining cap.
 * @param {{seam:string, provider:string, model:string, body:any, outputCap:number, file?:string}} spec
 * @returns {Promise<object>} handle for settleCall / failCall
 */
export async function reserveCall(spec) {
  const file = spec.file ?? ledgerFileFromEnv();
  if (!file) throw new BudgetStopError('ledger-missing', `${BUDGET_LEDGER_ENV} is not set`);
  const est = estimateReservation(spec); // refuses before touching the ledger
  return withLedgerLock(file, async () => {
    const r = reduce(readEvents(file));
    if (r.indeterminate.length) {
      throw new BudgetStopError('indeterminate-reserved',
        `ledger holds ${r.indeterminate.length} reserved call(s) left by a process that is gone (${r.indeterminate.join(', ')}); `
        + 'check the provider usage dashboard and run `step-back-replay.mjs reconcile` before continuing', { callIds: r.indeterminate });
    }
    const remaining = r.capMicro - r.spentMicro;
    if (est.reservedMicro > remaining) {
      throw new BudgetStopError('would-exceed-cap',
        `reserving $${usdOf(est.reservedMicro).toFixed(4)} for ${spec.seam} would exceed the remaining $${usdOf(remaining).toFixed(4)} of the $${r.header.capUsd} cap`,
        { reservedUsd: usdOf(est.reservedMicro), remainingUsd: usdOf(remaining) });
    }
    const callId = crypto.randomUUID();
    appendLine(file, {
      type: 'reserve', callId, ts: new Date().toISOString(), pid: process.pid, host: os.hostname(),
      seam: spec.seam, provider: spec.provider, model: spec.model,
      reservedMicro: est.reservedMicro, inputBytes: est.inputBytes, outputCap: est.outputCap,
    });
    return { file, callId, seam: spec.seam, provider: spec.provider, model: spec.model, reservedMicro: est.reservedMicro, closed: false };
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Metered cost in micro-USD for a usage object, or null when the usage cannot be trusted. */
function meteredMicro(usage, models) {
  if (!usage || typeof usage !== 'object' || usage.usageMissing === true) return null;
  if (!(num(usage.input_tokens ?? usage.prompt_tokens) > 0)) return null; // a real call always has input tokens
  for (const m of models) {
    if (!m) continue;
    const c = costFromUsage(usage, m);
    if (c.priced && !c.unmeterable && Number.isFinite(c.totalUsd)) {
      return { micro: toMicroCeil(c.totalUsd), tokens: { input: c.inputTokens, output: c.outputTokens } };
    }
  }
  return null;
}

/** Record the metered result. A call with no usable usage keeps its reservation as its cost, flagged. */
export async function settleCall(handle, { usage, modelServed } = {}) {
  if (handle.closed) return;
  const m = meteredMicro(usage, [modelServed, handle.model]);
  const flags = [];
  let costMicro;
  if (m) {
    costMicro = m.micro;
    if (costMicro > handle.reservedMicro) flags.push('over-reservation');
  } else {
    costMicro = handle.reservedMicro; flags.push('unmetered-kept-reservation');
  }
  await withLedgerLock(handle.file, async () => {
    appendLine(handle.file, {
      type: 'settle', callId: handle.callId, ts: new Date().toISOString(), costMicro, flags,
      modelServed: modelServed ?? null, usage: usage ?? null, tokens: m?.tokens ?? null,
    });
  });
  handle.closed = true;
}

/** Decide the failure state from POSITIVE evidence only. */
function classifyFailure(err, sent) {
  const usage = err?.usage ?? err?.llmUsage ?? null;
  if (usage && num(usage.input_tokens ?? usage.prompt_tokens) > 0 && usage.usageMissing !== true) return { state: 'failed-billed', usage };
  if (sent === false) return { state: 'failed-unbilled' };
  const st = Number(err?.status ?? err?.statusCode);
  if (Number.isInteger(st) && st >= 400 && st < 500 && st !== 408 && st !== 429) return { state: 'failed-unbilled' };
  return { state: 'failed-unknown' };
}

/**
 * Record a failed call. `sent:false` is positive evidence the request never reached the wire.
 * Timeout / connection loss / 5xx / 408 / 429 / any error without usage => failed-unknown (full reservation kept).
 */
export async function failCall(handle, err, { sent = true } = {}) {
  if (handle.closed) return;
  const c = classifyFailure(err, sent);
  let state = c.state; let costMicro = 0; const flags = [];
  if (state === 'failed-billed') {
    const m = meteredMicro(c.usage, [handle.model]);
    if (m) { costMicro = m.micro; if (costMicro > handle.reservedMicro) flags.push('over-reservation'); } else { state = 'failed-unknown'; }
  }
  if (state === 'failed-unknown') { costMicro = handle.reservedMicro; flags.push('cost-unknown-kept-reservation'); }
  await withLedgerLock(handle.file, async () => {
    appendLine(handle.file, {
      type: 'fail', callId: handle.callId, ts: new Date().toISOString(), state, costMicro, flags,
      usage: c.usage ?? null, error: String(err?.message ?? err).slice(0, 300),
    });
  });
  handle.closed = true;
}

/**
 * Operator reconciliation of an indeterminate call (`reserved` of a dead
 * process, or `failed-unknown`). Records what the provider's own usage
 * dashboard/logs showed. Refuses an empty evidence string.
 * @param {{file:string, callId:string, evidence:string, costUsd:number}} p - costUsd = what the provider actually billed (0 allowed)
 */
export async function reconcileCall({ file, callId, evidence, costUsd } = {}) {
  if (!file || !callId) throw new Error('reconcileCall: file and callId required');
  if (typeof evidence !== 'string' || evidence.trim() === '') throw new Error('reconcileCall: evidence (non-empty string) required');
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('reconcileCall: costUsd must be a number >= 0');
  return withLedgerLock(file, async () => {
    const r = reduce(readEvents(file));
    const c = r.calls.get(callId);
    if (!c) throw new Error(`reconcileCall: no call ${callId} in ${file}`);
    const ok = (c.state === 'reserved' && r.indeterminate.includes(callId)) || c.state === 'failed-unknown';
    if (!ok) throw new Error(`reconcileCall: call ${callId} is ${c.state}, not indeterminate`);
    appendLine(file, { type: 'reconcile', callId, ts: new Date().toISOString(), evidence: evidence.trim(), costMicro: toMicroCeil(costUsd) });
    return { callId, costUsd };
  });
}

// ── Seam helper ──────────────────────────────────────────────────────────────

const _scope = new AsyncLocalStorage();
/** True inside a metered call: an inner seam (e.g. the SDK under callReviewer) is already covered by the outer reservation. */
export function inBudgetScope() { return _scope.getStore() !== undefined; }

/**
 * Run `fn` under a reservation. Inert (returns `fn()` untouched — same promise
 * or thenable) when the budget is off or an enclosing call already holds one.
 * @param {{seam:string, provider:string, model:string, body:any, outputCap:number}} spec
 * @param {() => any} fn - performs the provider request
 * @param {(result:any) => {usage?:object, modelServed?:string}} [extract]
 */
export function withBudget(spec, fn, extract = (r) => ({ usage: r?.usage, modelServed: r?.model })) {
  const file = ledgerFileFromEnv();
  if (!file || inBudgetScope()) return fn();
  return _runMetered(file, spec, fn, extract);
}

async function _runMetered(file, spec, fn, extract) {
  const handle = await reserveCall({ ...spec, file });
  let result;
  try {
    result = await _scope.run({ handle }, fn);
  } catch (err) {
    await failCall(handle, err, { sent: err?.budgetNotSent !== true })
      .catch((e) => process.stderr.write(`  [llm-budget] could not record failure (reservation stays counted): ${e.message}\n`));
    throw err;
  }
  let ex = {};
  try { ex = extract(result) ?? {}; } catch { /* unusable usage => reservation kept */ }
  await settleCall(handle, ex)
    .catch((e) => process.stderr.write(`  [llm-budget] could not record settlement (reservation stays counted): ${e.message}\n`));
  return result;
}

/**
 * The `createAnthropicClient` sdk-backend seam (called by anthropic-client.mjs's wrapSdkClient). Returns `undefined`
 * when the budget is off, so the caller's original path runs unchanged. Active: SDK silent retries are disabled
 * (each retry is a new billed request and must reserve again); a request already inside a metered call is covered
 * by that outer reservation; a streamed request outside one is refused (its usage is only known once consumed).
 */
export function budgetedMessagesCreate(rawClient, body, opts) {
  if (!isBudgetActive()) return undefined;
  const o = { ...opts, maxRetries: 0 };
  if (inBudgetScope()) return rawClient.messages.create(body, o);
  if (body && body.stream) {
    return Promise.reject(new BudgetStopError('unmetered-stream',
      'a streaming messages.create must be metered by its caller (withBudget) while a budget is active'));
  }
  return withBudget(
    { seam: 'anthropic-client.messages.create', provider: 'anthropic', model: body?.model, body, outputCap: body?.max_tokens },
    () => rawClient.messages.create(body, o),
  );
}

/**
 * The cli-backend seam: `claude -p` has NO enforced output cap (max_tokens is accepted and ignored), so no
 * upper-bound reservation can exist for it. With a budget active it is refused; pin the call site to {backend:"sdk"}.
 */
export function assertCliAllowedUnderBudget() {
  if (!isBudgetActive()) return;
  throw new BudgetStopError('uncapped-request',
    'the cli backend cannot enforce max_tokens (claude -p has no equivalent flag), so its output is uncapped and '
    + 'no upper-bound reservation exists; refused while AUDIT_BUDGET_LEDGER is set. Use the sdk backend ({backend: "sdk"}).');
}
