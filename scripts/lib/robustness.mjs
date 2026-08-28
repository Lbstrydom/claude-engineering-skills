/**
 * @fileoverview Pure robustness utilities for the audit pipeline.
 * Error classification, payload truncation, finding normalization, ledger path resolution.
 * All functions are side-effect-free and testable in isolation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openaiConfig } from './config.mjs';

// ── Constants ────────────────────────────────────────────────────────────────
export const MAX_REDUCE_JSON_CHARS = 120_000;
export const MAX_DETAIL_CHARS = 200;
export const MAP_FAILURE_THRESHOLD = 0.5;
export const RETRY_MAX_ATTEMPTS = 1;
export const RETRY_BASE_DELAY_MS = 2000;
export const RETRY_429_MAX_DELAY_MS = 8000;
export const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Stable directory for all local audit state. */
export const AUDIT_DIR = '.audit';
/** Canonical session ledger filename (always in AUDIT_DIR). */
export const SESSION_LEDGER_FILE = 'session-ledger.json';
/** Prefix for SID-scoped session manifest files. */
export const SESSION_MANIFEST_PREFIX = 'session-';

// ── LLM Error Classification ─────────────────────────────────────────────────

/**
 * Structured LLM error — carries usage and category for retry/accounting.
 */
export class LlmError extends Error {
  constructor(message, { category, usage = null, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.llmCategory = category;
    this.llmUsage = usage;
    this.llmRetryable = retryable;
  }
}

/**
 * Classify an LLM API error into retryable vs permanent categories.
 * Uses structured fields where available, avoids message-string matching.
 */
export function classifyLlmError(err) {
  if (err.llmCategory) return { retryable: err.llmRetryable, category: err.llmCategory };
  if (err.status) {
    if ([429, 500, 502, 503, 504].includes(err.status)) return { retryable: true, category: `http-${err.status}` };
    if (err.status >= 400 && err.status < 500) return { retryable: false, category: `http-${err.status}` };
  }
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return { retryable: true, category: 'timeout' };
  if (err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ENOTFOUND') return { retryable: true, category: 'network' };
  return { retryable: false, category: 'permanent' };
}

// ── Reduce Payload Builder ──────────────────────────────────────────────────

/**
 * Build a budget-safe JSON payload for the REDUCE phase.
 * Owns the sort invariant (HIGH > MEDIUM > LOW, tie-break by id).
 * Drops lowest-severity findings until under budget.
 */
export function buildReducePayload(findings, budget = MAX_REDUCE_JSON_CHARS) {
  const sorted = [...findings].sort((a, b) => {
    const sd = (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2);
    return sd !== 0 ? sd : (a.id ?? '').localeCompare(b.id ?? '');
  });

  const summarize = (f) => ({
    id: f.id, severity: f.severity, category: f.category,
    section: f.section, detail: f.detail?.slice(0, MAX_DETAIL_CHARS),
    is_quick_fix: f.is_quick_fix, _mapUnit: f._mapUnit
  });

  let subset = sorted.map(summarize);
  let json = JSON.stringify(subset, null, 2);

  while (json.length > budget && subset.length > 1) {
    subset.pop();
    json = JSON.stringify(subset, null, 2);
  }

  if (json.length > budget && subset.length === 1) {
    const f = subset[0];
    for (const field of ['detail', 'category', 'section']) {
      if (json.length <= budget) break;
      const maxLen = Math.max(30, (f[field]?.length ?? 0) - (json.length - budget));
      f[field] = f[field]?.slice(0, maxLen);
      subset[0] = { ...f };
      json = JSON.stringify(subset, null, 2);
    }
  }

  if (json.length > budget) {
    return { json: '[]', includedCount: 0, totalCount: findings.length, degraded: true };
  }

  return { json, includedCount: subset.length, totalCount: findings.length, degraded: false };
}

/**
 * Normalize findings for output: semantic dedup, stable sort.
 * Used by both REDUCE output and raw MAP survivors for consistent downstream behavior.
 * @param {Array} findings
 * @param {Function} [semanticIdFn] - Hash function for dedup (defaults to JSON.stringify)
 */
export function normalizeFindingsForOutput(findings, semanticIdFn) {
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const hash = f._hash || (semanticIdFn ? semanticIdFn(f) : JSON.stringify(f));
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push({ ...f, _hash: hash });
  }
  deduped.sort((a, b) => {
    const sd = (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2);
    return sd !== 0 ? sd : (a.id ?? '').localeCompare(b.id ?? '');
  });
  return deduped;
}

/**
 * Add one `safeCallGPT` usage envelope into an accumulator, treating a null
 * accumulator as "nothing measured yet".
 *
 * Shared primitive (legacy-production-audit-decomposition Phase 2) — used by
 * both `map-reduce-scheduler.mjs`'s `runMapReducePass` and `adjacency-pass.mjs`'s
 * bouncer-usage accumulation; neither may import from the other, so this lives
 * in the pre-existing shared robustness module rather than being duplicated or
 * given its own new file.
 *
 * @param {object|null} acc
 * @param {{input_tokens?:number, cached_tokens?:number, output_tokens?:number, reasoning_tokens?:number, latency_ms?:number}} next
 */
export function addUsage(acc, next) {
  const base = acc ?? { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 };
  return {
    input_tokens: base.input_tokens + (next.input_tokens ?? 0),
    cached_tokens: base.cached_tokens + (next.cached_tokens ?? 0),
    output_tokens: base.output_tokens + (next.output_tokens ?? 0),
    reasoning_tokens: base.reasoning_tokens + (next.reasoning_tokens ?? 0),
    latency_ms: base.latency_ms + (next.latency_ms ?? 0),
  };
}

/**
 * The choke point for the audit pipeline's `if (learningWritesAllowed)` /
 * `if (X && learningWritesAllowed)` convention used to gate ad hoc (bandit
 * flush + sync, FP-pattern sync, the outcomes.jsonl append loop, and the
 * orphan-metrics emits) — nothing stopped a future write from skipping the
 * check entirely (audit fb7cec72, 2026-07-17). `grep "writeLearningState("`
 * enumerates those call sites in one shot instead of requiring a full-file read.
 *
 * Relocated here from `legacy-production-audit.mjs` (legacy-production-audit-
 * decomposition Phase 3), earlier than its ultimate Phase 4d destination
 * (`run-telemetry.mjs`): Phase 3's orphan-pass.mjs needs it now, and — per
 * this plan's dependency direction — a pass module may import only
 * established shared primitives, never back into legacy-production-audit.mjs.
 * Trivial and dependency-free, so an early move costs nothing; run-telemetry.mjs
 * will import it from here too when Phase 4d lands, exactly as
 * pass-result-cache.mjs/map-reduce-scheduler.mjs already do for `addUsage`.
 *
 * **NOT exhaustive over every persistence-capable call in the audit
 * pipeline** — a later audit (H1-H4, 2026-07-24) correctly found OTHER
 * cloud-write/telemetry sites this wrapper does not cover: debt-memory
 * writes, ledger writes, and session writes. See
 * docs/plans/audit-backlog-triage-hardening.md item 1's "Explicitly NOT in
 * scope" framing (item 5's God-orchestrator decomposition — this plan —
 * covers the eventual real fix). Full lint-level enforcement of even the
 * sites this wrapper DOES cover (forbidding a raw store call outside it) is
 * also out of scope here.
 *
 * **THIS PARAGRAPH HAS BEEN WRONG TWICE — 2026-08-13.** It first claimed
 * those sites "silently discard failures (`.catch(() => {})`)" long after
 * they had been fixed to check and log; the file contains zero such
 * swallows. Then, corrected, it still listed `recordDiffComplexity` and
 * `backfillLearningOutcome` as uncovered — and within the hour both were
 * routed through `durableWrite`, along with `recordConvergenceState`.
 *
 * That is the reason it is worth writing down rather than just editing: the
 * FIRST stale version was cited by `docs/plans/god-module-and-layering-debt.md`
 * as the authority for a whole cluster of work, and that cluster had to be
 * re-cut on contact with the code. A docstring enumerating call sites decays
 * every time somebody moves one, and a decayed one is not a cosmetic defect —
 * it is a false premise other plans build on. **Prefer `grep durableWrite(` /
 * `grep writeLearningState(` over trusting this list.**
 *
 * The distinction the list existed to draw is still the right one, and now
 * has a mechanical answer instead of prose: a logged failure is not a
 * REPRESENTED one. A write reaches `writeOutcomes` only through
 * `durableWrite`, and `tests/audit-store-durability-call-site.test.mjs`
 * checks BOTH directions — store exports registered-or-exempted, and
 * orchestrator imports likewise. `reconcileRemediationProjection` and
 * `markFindingsRemediation` stay outside the seam deliberately (the on-disk
 * ledger is their durable copy) and instead return enough for their caller
 * to report a failure or a shortfall.
 *
 * @param {boolean} allowed
 * @param {() => any} fn
 */
export function writeLearningState(allowed, fn) {
  if (!allowed) return;
  return fn();
}

// ── Durable-write outcome tally ─────────────────────────────────────────────

/**
 * Fold `durableWrite` results into the run's write-outcome tally.
 *
 * Kept as a named helper rather than an inline reduce because the SHAPE is the
 * contract: `{written, spilled, lost}` reaches `audit_runs.write_outcomes`, and
 * `lost > 0` is what makes a run `incomplete`. `byWriter` is carried too — a
 * bare total says a write was lost, not WHICH, and the operator's next question
 * is always which.
 *
 * `skipped` is counted but is NOT a failure: it means the store declined the
 * write (cloud off), which is a supported mode. Only `lost` makes a run
 * incomplete — conflating the two would mark every local-only run as broken.
 *
 * Lives here (not in legacy-production-audit.mjs) because the tally is created
 * early in the orchestration spine — before the finalization coordinator's
 * three stage modules exist — and threads through both: the spine's own
 * pre-wave writes (`audit.planLink`, `audit.diffComplexity`) and
 * `run-telemetry.mjs`/`run-persistence.mjs`'s post-wave writes all fold into
 * the SAME accumulating object, so one exported definition is the only way to
 * avoid three independently-drifting copies of a bug-shaped reduce.
 *
 * @param {{written:number, spilled:number, lost:number, skipped:number, byWriter:Record<string,object>}} tally
 * @param {Array<{outcome:string, writerId:string, error?:string}>} results
 */
const WRITE_OUTCOMES = new Set(['written', 'spilled', 'lost', 'skipped']);

export function tallyWriteOutcomes(tally, results) {
  for (const r of results) {
    if (!r || typeof r.outcome !== 'string') continue;
    // An unrecognised outcome is counted as `lost`, never dropped. Silently
    // ignoring it would let a future outcome name read as a clean run — the
    // false-zero shape this whole mechanism exists to remove.
    const bucket = WRITE_OUTCOMES.has(r.outcome) ? r.outcome : 'lost';
    tally[bucket]++;
    const w = tally.byWriter[r.writerId] ?? (tally.byWriter[r.writerId] = { written: 0, spilled: 0, lost: 0, skipped: 0 });
    w[bucket]++;
    if (bucket !== 'written' && r.error && !w.lastError) w.lastError = String(r.error).slice(0, 300);
  }
  return tally;
}

// ── JSON Repair ──────────────────────────────────────────────────────────────

/**
 * Attempt to repair truncated JSON using a deterministic bracket-balance algorithm.
 * Never fabricates content — only closes open brackets/quotes.
 * Handles common GPT truncation patterns: open arrays, objects, strings.
 *
 * @param {string} raw - Possibly truncated JSON string
 * @returns {{ ok: boolean, result?: object, repaired?: boolean, error?: string }}
 */
export function tryRepairJson(raw) {
  // Fast path — already valid
  try { return { ok: true, result: JSON.parse(raw) }; } catch {}

  // Strip trailing comma before closing (e.g. `[{"id":"1"},` → `[{"id":"1"}`)
  // and trailing whitespace before attempting repair
  let trimmed = raw.trimEnd().replace(/,\s*$/, '');

  // Balance-aware repair: track open structures and string state
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const ch of trimmed) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // Close open string (handle trailing backslash edge case — G4 fix)
  let repaired = trimmed;
  if (inString) {
    if (escaped) repaired = repaired.slice(0, -1); // remove trailing '\'
    repaired += '"';
  }
  // Close open structures in reverse order
  while (stack.length > 0) repaired += stack.pop();

  try {
    const result = JSON.parse(repaired);
    return { ok: true, result, repaired: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Ledger Path Resolution ──────────────────────────────────────────────────

/**
 * Resolve canonical ledger path.
 * - Explicit --ledger always wins
 * - Round 2+ without explicit: tries SID-scoped manifest, then stable session ledger
 * - Round 1 without explicit: derive from --out, or default to .audit/session-ledger.json
 * - --no-ledger: null
 */
export function resolveLedgerPath({ explicitLedger, outFile, round, noLedger, sessionId }) {
  if (noLedger) return null;
  if (explicitLedger) return path.resolve(explicitLedger);

  if (round >= 2) {
    // R2+: try SID-scoped manifest first, then stable session ledger fallback
    const sid = sessionId || process.env.AUDIT_SESSION_ID;
    if (sid) {
      const manifestPath = path.resolve(AUDIT_DIR, `${SESSION_MANIFEST_PREFIX}${sid}.json`);
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest.ledgerPath) return path.resolve(manifest.ledgerPath);
        } catch { /* fall through */ }
      }
    }
    // Fallback: stable session ledger
    return path.resolve(AUDIT_DIR, SESSION_LEDGER_FILE);
  }

  // Derive from --out when available
  if (outFile) {
    const parsed = path.parse(outFile);
    const baseName = parsed.name.replace(/-result$/, '');
    const ledgerName = `${baseName}-ledger${parsed.ext}`;
    return path.resolve(parsed.dir, ledgerName);
  }

  // Default to .audit/ in repo root
  return path.resolve(AUDIT_DIR, SESSION_LEDGER_FILE);
}

// ── Adaptive Sizing ──────────────────────────────────────────────────────────

/**
 * Compute per-pass token limits and timeouts based on actual file content size.
 * Moved here from openai-audit.mjs to give robustness.mjs single ownership of budget math.
 *
 * Heuristics (calibrated from live GPT-5.4 runs):
 *   - ~4 chars per token (input estimation)
 *   - reasoning: high uses ~40-60% of output tokens for thinking
 *   - GPT-5.4 generates ~150-250 tokens/sec depending on reasoning effort
 *   - Each finding in the schema is ~200-400 output tokens
 *
 * @param {number} contextChars - Total chars being sent as user prompt
 * @param {string} reasoning - 'low' | 'medium' | 'high'
 * @param {number} [minTokens=0] - Floor for maxTokens (prevents reduce starvation)
 * @returns {{ maxTokens: number, timeoutMs: number }}
 */
// Per-reasoning-level constants (lookup tables avoid nested ternaries)
const REASONING_MULTIPLIER  = { high: 0.4,   medium: 0.25,  low: 0.1  };
const REASONING_BASE_TOKENS = { high: 10000,  medium: 6000,  low: 4000 };
const REASONING_TOKENS_PER_SEC = { high: 100, medium: 150,   low: 250  };
const REASONING_FLOOR_SEC   = { high: 150,   medium: 60,    low: 30   };

export function computePassLimits(contextChars, reasoning = 'high', minTokens = 0) {
  const MAX_OUTPUT_TOKENS_CAP = openaiConfig.maxOutputTokensCap;
  const TIMEOUT_MS_CAP = openaiConfig.timeoutMsCap;

  const level = reasoning in REASONING_MULTIPLIER ? reasoning : 'low';
  const estimatedInputTokens = Math.ceil(contextChars / 4);

  // Output tokens: base for findings + proportional to input size for reasoning
  // High reasoning needs a higher base because ~60% of tokens go to internal thinking
  const baseOutputTokens = REASONING_BASE_TOKENS[level];
  const reasoningOverhead = Math.ceil(estimatedInputTokens * REASONING_MULTIPLIER[level]);
  const maxTokens = Math.min(
    MAX_OUTPUT_TOKENS_CAP,
    Math.max(minTokens, baseOutputTokens + reasoningOverhead)
  );

  // Timeout: based on expected generation speed + reasoning overhead
  // GPT-5.4 with reasoning: high spends 90-150s thinking BEFORE output starts
  const tokensPerSec = REASONING_TOKENS_PER_SEC[level];
  const reasoningFloorSec = REASONING_FLOOR_SEC[level];
  const estimatedGenerationSec = maxTokens / tokensPerSec;
  const minTimeoutMs = (reasoningFloorSec + 60) * 1000; // floor + generous network buffer
  const timeoutMs = Math.min(
    TIMEOUT_MS_CAP,
    Math.max(minTimeoutMs, Math.ceil((estimatedGenerationSec + reasoningFloorSec) * 1000))
  );

  return { maxTokens, timeoutMs };
}
