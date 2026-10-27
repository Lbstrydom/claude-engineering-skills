/**
 * @fileoverview Per-LLM-call provenance buffer (docs/plans/own-model-telemetry-pr3.md
 * decision 4; memo section 6.8 row 5).
 *
 * A module-level singleton, ONE per process, owned by the entry point:
 *   - `bindRun({runId, repoId, workItemId, producer})` is called once the run id
 *     is known (producer `audit` in the audit spine, `final-review` in the Gemini
 *     CLI). Until then `record()` is a COUNTED no-op, never a guess.
 *   - `record(call)` is called by the LLM seam once per accepted call. It stores
 *     metadata only (model, route, hashes, tokens, latency, flags) - never prompt
 *     or response content - and NEVER throws or does I/O.
 *   - `drain()` hands the buffered rows plus the loss counts to the single writer.
 *
 * Identity: `call_id` is a UUIDv5 of `run|producer|process_nonce|seq`, so a replayed
 * spill collapses on the primary key and two processes cannot collide. Loss is
 * reported, not hidden: overflow drops the OLDEST and counts it.
 *
 * @module scripts/lib/telemetry/llm-call-log
 */
import crypto from 'node:crypto';
import { isWorkItemId } from '../ledger/work-item.mjs';

export const LLM_CALL_SCHEMA_VERSION = 1;
export const LLM_CALL_BUFFER_CAP = 500;
export const PRODUCERS = ['audit', 'final-review'];
const NS = '6f1c2f4e-0d0a-4b8e-9a77-3a1f3f2c9b10';

/** RFC 4122 UUIDv5 over the project namespace (same construction as ledger/work-item.mjs). */
function uuidV5(name) {
  const ns = Buffer.from(NS.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(ns).update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** PURE. The deterministic row identity. */
export function callIdFor({ runId, producer, nonce, seq }) {
  return uuidV5(`${runId}|${producer}|${nonce}|${seq}`);
}

const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v, n = 120) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);

/** Route of a model id: how it was reached (billing differs by route). PURE. */
export function routeFor({ azure = false, cli = false, model = '' } = {}) {
  if (cli) return 'cli';
  if (azure) return 'azure';
  return String(model).includes('/') ? 'openrouter' : 'native';
}

let state = null;
let unboundDropped = 0;

function fresh() {
  return { bound: null, nonce: crypto.randomBytes(4).toString('hex'), seq: 0, rows: [], dropped: 0, recorded: 0 };
}

/** Bind this process's log to a run. Re-binding to a different run starts a new log. */
export function bindRun({ runId, repoId = null, workItemId = null, producer = 'audit' } = {}) {
  try {
    if (!runId || !PRODUCERS.includes(producer)) return false;
    if (state?.bound?.runId === runId && state.bound.producer === producer) return true;
    state = fresh();
    state.bound = { runId, repoId, workItemId: isWorkItemId(workItemId) ? workItemId : null, producer };
    return true;
  } catch { return false; }
}

/**
 * Record one accepted call. Never throws, never blocks.
 * @param {object} c purpose, model, route, promptHash, promptVariant, temperature, reasoningEffort,
 *   usage {input_tokens, cached_tokens, output_tokens, reasoning_tokens}, latencyMs, costUsd, truncated, retried, fallback
 */
export function record(c) {
  try {
    if (!state?.bound) { unboundDropped++; return false; }
    const seq = state.seq++;
    const u = c?.usage ?? {};
    if (state.rows.length >= LLM_CALL_BUFFER_CAP) { state.rows.shift(); state.dropped++; }
    state.recorded++;
    state.rows.push({
      call_id: callIdFor({ runId: state.bound.runId, producer: state.bound.producer, nonce: state.nonce, seq }),
      audit_run_id: state.bound.runId,
      repo_id: state.bound.repoId,
      work_item_id: state.bound.workItemId,
      producer: state.bound.producer,
      purpose: str(c?.purpose, 60),
      model_resolved: str(c?.model),
      route: str(c?.route, 20),
      prompt_hash: /^[0-9a-f]{8,64}$/.test(c?.promptHash ?? '') ? c.promptHash : null,
      prompt_variant: str(c?.promptVariant, 60),
      temperature: num(c?.temperature),
      reasoning_effort: str(c?.reasoningEffort, 20),
      input_tokens: int(u.input_tokens),
      cached_tokens: int(u.cached_tokens),
      output_tokens: int(u.output_tokens),
      reasoning_tokens: int(u.reasoning_tokens),
      latency_ms: int(c?.latencyMs ?? u.latency_ms),
      cost_usd: num(c?.costUsd),
      truncated: bool(c?.truncated),
      retried: bool(c?.retried),
      fallback: bool(c?.fallback),
      schema_version: LLM_CALL_SCHEMA_VERSION,
    });
    return true;
  } catch { return false; }
}

/**
 * Take the buffered rows and loss counts for the writer. Empty when nothing was bound.
 * @returns {{runId: string, producer: string, nonce: string, rows: object[], recorded: number, dropped: number, unbound: number}|null}
 */
export function drain() {
  if (!state?.bound) return null;
  const out = {
    runId: state.bound.runId, producer: state.bound.producer, nonce: state.nonce,
    rows: state.rows, recorded: state.recorded, dropped: state.dropped, unbound: unboundDropped,
  };
  state.rows = [];
  return out;
}

/**
 * Record one accepted GPT call from the audit LLM seam. Metadata only: the prompt is
 * identified by a hash of its SYSTEM prompt (the template/rubric identity), never stored.
 * Never throws.
 * @param {{result: object, opts: object}} a the `callGPT` result and its options
 */
export function recordGptCall({ result, opts }) {
  try {
    if (!state?.bound) { unboundDropped++; return false; }
    const sys = typeof opts?.system === 'string' ? opts.system : (typeof opts?.systemPrompt === 'string' ? opts.systemPrompt : '');
    return record({
      purpose: opts?.passName ?? null,
      model: result?.model ?? null,
      route: routeFor({ azure: Boolean(process.env.AZURE_OPENAI_ENDPOINT), model: result?.model ?? '' }),
      promptHash: sys ? crypto.createHash('sha256').update(sys).digest('hex').slice(0, 16) : null,
      promptVariant: opts?.promptVariant ?? null,
      temperature: null,
      reasoningEffort: result?.reasoningEffort ?? null,
      usage: result?.usage,
      latencyMs: result?.latencyMs,
      costUsd: null,
      truncated: false,
      retried: result?._retried === true,
      fallback: false,
    });
  } catch { return false; }
}

/** Test seam. */
export function _resetLlmCallLog() { state = null; unboundDropped = 0; }
export const _peek = () => state;
