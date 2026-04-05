# Plan: Robustness Hardening & R2+ Ledger Auto-Write

- **Date**: 2026-04-04
- **Status**: In Progress (revised after Round 3 audit — converging)
- **Author**: Claude + Louis
- **Scope**: Fix JSON truncation, add null guards, retry logic, MAP failure thresholds, and auto-populate the adjudication ledger so R2+ suppression actually works

---

## 1. Context Summary

### Purpose

The audit loop's multi-model architecture (Claude plans/codes, GPT-5.4 audits, Gemini 3.1 Pro reviews) finds real issues, but two systemic problems undermine reliability:

1. **JSON robustness gaps** — The map-reduce pipeline has 6 failure modes that cause silent data loss or crashes: string-level JSON truncation producing invalid syntax, no null guards on pass results, zero retry logic, no MAP failure threshold, unchecked `finish_reason`/incomplete structured output, and no MAP usage accounting on degraded runs.

2. **R2+ ledger never written** — The entire R2+ suppression system (3-layer defence: rulings injection, R2+ prompts, post-output suppression) is wired for *reading* but the ledger is never *written*. Round 2+ audits re-raise identical findings because there's no ledger to suppress from. `writeLedgerEntry()` and `generateTopicId()` are implemented, tested, exported, but dead code in the audit flow.

### Evidence

- 3/9 MAP units failed in a recent audit run due to JSON parse errors from GPT-5.4 truncation
- `mergedResult._suppression` is referenced at `openai-audit.mjs:1073` but never populated (bug)
- `generateTopicId()` is imported at line 40 but never called
- `writeLedgerEntry()` is never imported into `openai-audit.mjs`
- `fp-tracker.json` and `bandit-state.json` exist and work; only the ledger is missing
- Step 3.5 in SKILL.md documents manual `node -e` invocation that nobody executes

### Key Requirements

1. **Valid JSON always sent to REDUCE** — truncation must produce syntactically valid JSON, with explicit sort enforcement
2. **No crash on null pass results** — defensive access on all `.result.findings` chains
3. **Single retry on transient failures** — timeout, 5xx, rate-limit get one retry with classified error handling
4. **MAP failure threshold** — skip REDUCE when >50% units fail, return raw survivors with accurate usage
5. **Auto-write ledger (default-on)** — ledger written automatically after Round 1; `--no-ledger` to disable
6. **Populate `_suppression` metadata** — fix the dead reference at line 1073
7. **Detect incomplete/truncated structured output** — `finish_reason === 'length'` and incomplete status treated as degraded
8. **Backward compatible** — all changes are additive; existing CLI invocations unaffected

### Non-Goals

- Changing the REDUCE algorithm or prompt (only fixing its input)
- Full exponential backoff with jitter (one retry with classified errors is sufficient)
- Auto-running Round 2 (ledger is written; orchestrator decides when to use it)
- Modifying Gemini review or learning-store integration
- Normalizing the pass-result contract to discriminated unions (future work — optional chain is the scoped fix here)

---

## 2. Proposed Changes

### 2.1 Safe JSON Truncation for REDUCE Phase

**File**: `scripts/openai-audit.mjs` — lines 470-482

**Current**: String-level `.slice(0, 120000)` on serialized JSON. Cuts mid-object/mid-array, producing syntactically invalid JSON that GPT must guess how to interpret.

```javascript
// BROKEN: produces invalid JSON
if (findingsJson.length > 120000) {
  findingsJson = findingsJson.slice(0, 120000) + '\n... [truncated]';
}
```

**Change**: Extract a `buildReducePayload()` helper that owns sorting, summarization, truncation, and budget guarantee. Always produces syntactically valid JSON.

```javascript
const MAX_REDUCE_JSON_CHARS = 120_000;
const MAX_DETAIL_CHARS = 200;
const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Build a budget-safe JSON payload for the REDUCE phase.
 * Owns the sort invariant (HIGH > MEDIUM > LOW, tie-break by id).
 * Drops lowest-severity findings until under budget.
 * Caps individual detail fields to prevent single-finding overflow.
 * @throws {Error} if even a single finding exceeds budget after capping
 */
function buildReducePayload(findings, budget = MAX_REDUCE_JSON_CHARS) {
  // Enforce sort — do not rely on upstream ordering
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

  // Edge case: single finding still over budget — progressively shrink all variable-length fields
  if (json.length > budget && subset.length === 1) {
    const f = subset[0];
    // Shrink detail first, then category, then section
    const shrinkable = ['detail', 'category', 'section'];
    for (const field of shrinkable) {
      if (json.length <= budget) break;
      const maxLen = Math.max(30, (f[field]?.length ?? 0) - (json.length - budget));
      f[field] = f[field]?.slice(0, maxLen);
      subset[0] = { ...f };
      json = JSON.stringify(subset, null, 2);
    }
  }

  // Fail-closed: if still over budget after all shrinking, return degraded result
  if (json.length > budget) {
    return { json: '[]', includedCount: 0, totalCount: findings.length, degraded: true };
  }

  return { json, includedCount: subset.length, totalCount: findings.length, degraded: false };
}
```

**Usage at truncation site** (replaces lines 470-482):

```javascript
const payload = buildReducePayload(allFindings);
if (payload.degraded) {
  // Budget impossible — skip REDUCE, return raw findings with warning
  process.stderr.write(`  [${passName}] REDUCE payload could not fit budget — skipping REDUCE\n`);
  return {
    result: { pass_name: passName, findings: allFindings, quick_fix_warnings: [],
              summary: `REDUCE skipped: findings exceeded budget after normalization.` },
    usage: mapUsage, latencyMs: Date.now() - mapStart, _reduceSkipped: true
  };
}
const { json: findingsJson, includedCount, totalCount } = payload;
if (includedCount < totalCount) {
  process.stderr.write(`  [${passName}] REDUCE input truncated: ${includedCount}/${totalCount} findings (budget: ${MAX_REDUCE_JSON_CHARS} chars)\n`);
}
```

### 2.2 Null Guards on Pass Result Access

**File**: `scripts/openai-audit.mjs` — lines 910-916

**Current**: Direct `.result.findings` access. If any pass returned `{ result: null }` (e.g. from `safeCallGPT` fallback), this throws `TypeError: Cannot read properties of null`.

```javascript
addFindings(structureResult.result.findings, 'Structure');
addFindings(wiringResult.result.findings, 'Wiring');
for (let i = 0; i < backendResults.length; i++) {
  addFindings(backendResults[i].result.findings, backendPassNames[i] ?? 'Backend');
}
addFindings(frontendResult.result.findings, 'Frontend');
addFindings(sustainResult.result.findings, 'Sustainability');
```

**Change**: Optional chain on `.result`:

```javascript
addFindings(structureResult?.result?.findings, 'Structure');
addFindings(wiringResult?.result?.findings, 'Wiring');
for (let i = 0; i < backendResults.length; i++) {
  addFindings(backendResults[i]?.result?.findings, backendPassNames[i] ?? 'Backend');
}
addFindings(frontendResult?.result?.findings, 'Frontend');
addFindings(sustainResult?.result?.findings, 'Sustainability');
```

`addFindings()` already handles `null`/`undefined` via `findings ?? []` (line 881). The optional chain prevents the `TypeError` on the intermediate `.result` access.

### 2.3 Single Retry with Backoff in callGPT

**File**: `scripts/openai-audit.mjs` — `callGPT()` function (lines ~295-370)

**Current**: Zero retry logic. Transient failures (network timeout, rate limit, 5xx) permanently lose the pass.

**Change**: Add a `classifyLlmError()` helper for structured error classification, then wrap the API call in a single-retry loop. No new dependencies.

**Error classifier** (defined in `scripts/openai-audit.mjs` near `callGPT`):

```javascript
/**
 * Classify an LLM API error into retryable vs permanent categories.
 * Uses structured fields where available (err.status, err.code, err.cause),
 * falls back to message matching for fetch/network errors.
 * @returns {{ retryable: boolean, category: string }}
 */
function classifyLlmError(err) {
  // Structured status codes (OpenAI SDK sets these)
  if (err.status) {
    if ([429, 500, 502, 503, 504].includes(err.status)) return { retryable: true, category: `http-${err.status}` };
    if (err.status >= 400 && err.status < 500) return { retryable: false, category: `http-${err.status}` };
  }
  // Abort/timeout (AbortController signal or SDK timeout)
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return { retryable: true, category: 'timeout' };
  // Network-level failures (fetch errors, DNS, ECONNRESET)
  if (err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ENOTFOUND') return { retryable: true, category: 'network' };
  if (err.message?.toLowerCase().includes('timeout')) return { retryable: true, category: 'timeout' };
  if (err.message?.toLowerCase().includes('fetch failed')) return { retryable: true, category: 'network' };
  // Default: not retryable (schema validation, auth, bad request)
  return { retryable: false, category: 'permanent' };
}
```

**Retry wrapper**:

```javascript
const MAX_RETRIES = 1;

async function callGPT(openai, opts) {
  let lastErr;
  const startMs = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await _callGPTOnce(openai, opts);
      if (attempt > 0) {
        // Accumulate total wall-clock time across retries
        result.latencyMs = Date.now() - startMs;
        result._retried = true;
        result._attempts = attempt + 1;
      }
      return result;
    } catch (err) {
      lastErr = err;
      const { retryable, category } = classifyLlmError(err);

      if (attempt < MAX_RETRIES && retryable) {
        const delayMs = 2000 * (attempt + 1);
        process.stderr.write(`  [${opts.passName ?? 'call'}] Retry ${attempt + 1}/${MAX_RETRIES} in ${(delayMs / 1000).toFixed(0)}s [${category}] (${err.message?.slice(0, 80)})\n`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
```

The existing `callGPT` body is renamed to `_callGPTOnce`. The public `callGPT` wraps it with retry logic. `safeCallGPT` is unchanged (it already catches and returns fallback). Total wall-clock latency is accumulated across attempts so metrics remain accurate.

### 2.4 MAP Failure Threshold

**File**: `scripts/openai-audit.mjs` — lines 457-465 (after MAP collection loop)

**Current**: If all MAP units fail, `allFindings` is empty and we early-return. But if 4/5 fail, we still REDUCE from 1 unit's findings — producing unreliable synthesis.

**Change**: Add a threshold check after counting failures:

```javascript
// Aggregate MAP usage and count effective failures (rejected OR null-result)
const mapUsage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
let effectiveFailures = 0;
for (const r of results) {
  if (r.status === 'fulfilled') {
    // safeCallGPT can return { result: null } — count as degraded, not success
    if (r.value?.usage) {
      mapUsage.input_tokens += r.value.usage.input_tokens ?? 0;
      mapUsage.output_tokens += r.value.usage.output_tokens ?? 0;
      mapUsage.reasoning_tokens += r.value.usage.reasoning_tokens ?? 0;
    }
    if (!r.value?.result || !Array.isArray(r.value.result.findings)) {
      effectiveFailures++;
    }
  } else {
    effectiveFailures++;
    if (r.reason?._accumulatedUsage) {
      mapUsage.input_tokens += r.reason._accumulatedUsage.input_tokens ?? 0;
      mapUsage.output_tokens += r.reason._accumulatedUsage.output_tokens ?? 0;
      mapUsage.reasoning_tokens += r.reason._accumulatedUsage.reasoning_tokens ?? 0;
    }
  }
}

// Bail if majority of MAP units failed — REDUCE from fragments is unreliable
const failureRate = effectiveFailures / units.length;
if (failureRate > 0.5 && allFindings.length > 0) {
  process.stderr.write(`  [${passName}] ${effectiveFailures}/${units.length} MAP units failed (${(failureRate * 100).toFixed(0)}%) — skipping REDUCE, returning normalized raw findings\n`);
  // Apply shared normalization even when REDUCE is skipped
  const normalized = normalizeFindingsForOutput(allFindings);
  return {
    result: {
      pass_name: passName,
      findings: normalized,
      quick_fix_warnings: [],
      summary: `Map-reduce: ${effectiveFailures}/${units.length} units failed. Returning ${normalized.length} raw findings (REDUCE skipped).`
    },
    usage: mapUsage,  // Truthful token accounting from MAP phase
    latencyMs: Date.now() - mapStart,
    _mapFailureRate: failureRate,
    _reduceSkipped: true
  };
}
```

**Shared normalization helper** (used by both normal and degraded paths):

```javascript
/**
 * Normalize findings for output: semantic dedup, stable sort, metadata enrichment.
 * Run on both REDUCE output and raw MAP survivors for consistent downstream behavior.
 */
function normalizeFindingsForOutput(findings) {
  // Semantic dedup by content hash
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const hash = f._hash || semanticId(f);
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push({ ...f, _hash: hash });
  }
  // Stable sort: severity (HIGH > MEDIUM > LOW), then by id
  deduped.sort((a, b) => {
    const sd = (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2);
    return sd !== 0 ? sd : (a.id ?? '').localeCompare(b.id ?? '');
  });
  return deduped;
}
```

### 2.5 Auto-Write Adjudication Ledger (Default-On, Batch Write)

**File**: `scripts/openai-audit.mjs`, `scripts/lib/ledger.mjs`

**Current**: `writeLedgerEntry()` and `generateTopicId()` are imported but never called. The ledger is only consumed (read) during R2+ via `--ledger` flag. Step 3.5 in SKILL.md documents a manual `node -e` invocation that nobody executes.

**Root problem**: Making ledger writing opt-in via a flag reproduces the same failure mode — if nobody passes the flag, the ledger is never written and R2+ remains broken. Additionally, calling `writeLedgerEntry()` in a per-finding loop causes O(n) full-file read-modify-write cycles.

**Change**: `--ledger <path>` becomes the **single canonical read+write path**. On Round 1, if `--ledger` is absent but `--out` is present, the ledger path is derived deterministically (`<out-base>-ledger.json`) and printed to stderr. On Round 2+, if `--ledger` is absent, the script **fails fast** with a clear error (suppression requires a ledger). `--no-ledger` disables all ledger I/O for backward compatibility.

**Path resolution helper** (defined near CLI parsing):

```javascript
/**
 * Resolve canonical ledger path. Rules:
 * - Explicit --ledger always wins
 * - Round 1 without --ledger: auto-derive from --out using path.parse/format
 * - Round 2+: require explicit --ledger (fail-fast if absent)
 * - --no-ledger: null (all ledger I/O disabled)
 */
function resolveLedgerPath({ explicitLedger, outFile, round, noLedger }) {
  if (noLedger) return null;
  if (explicitLedger) return path.resolve(explicitLedger);

  if (round >= 2) {
    process.stderr.write(`  [ERROR] Round ${round} requires --ledger <path> for suppression. Use --no-ledger to skip.\n`);
    process.exit(1);
  }

  if (!outFile) return null;

  // Derive from --out: /tmp/sid-r1-result.json → /tmp/sid-r1-ledger.json
  const parsed = path.parse(outFile);
  const baseName = parsed.name.replace(/-result$/, '');
  const ledgerName = `${baseName}-ledger${parsed.ext}`;
  return path.resolve(parsed.dir, ledgerName);
}
```

**CLI parsing** (near existing arg parsing, ~line 525):

```javascript
const noLedger = args.includes('--no-ledger');
const ledgerPath = resolveLedgerPath({ explicitLedger: ledgerFile, outFile, round, noLedger });
if (ledgerPath && !ledgerFile) {
  process.stderr.write(`  [ledger] Auto-derived path: ${ledgerPath}\n`);
}
```

**Single path for read and write**: The same `ledgerPath` is used to load existing entries (R2+ suppression) and to write new entries after findings are finalized. This eliminates split-brain across rounds.

**Batch ledger API** (new function in `scripts/lib/ledger.mjs`):

```javascript
/**
 * Batch-write ledger entries. Reads existing ledger (if any), upserts all entries
 * by topicId with idempotent merge, performs exactly one atomic write.
 * Validates existing ledger and incoming entries via Zod schemas.
 * Only treats ENOENT as 'new file' — permission/corruption errors surface to caller.
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {object[]} entries - Array of LedgerEntry-shaped objects
 * @returns {{ inserted: number, updated: number, total: number }}
 * @throws {Error} on permission errors, corruption, or validation failures
 */
export function batchWriteLedger(ledgerPath, entries) {
  let ledger = { version: 1, entries: [] };

  // Read existing ledger — only ENOENT is treated as 'new file'
  try {
    const raw = fs.readFileSync(ledgerPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Validate existing ledger structure
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      throw new Error(`Corrupted ledger: missing entries array`);
    }
    ledger = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // Permission, parse, validation errors bubble up
  }

  const byTopic = new Map(ledger.entries.map(e => [e.topicId, e]));
  let inserted = 0, updated = 0;

  for (const entry of entries) {
    if (!entry.topicId) continue;
    // Validate entry has required fields
    if (!entry.severity || !entry.adjudicationOutcome) {
      process.stderr.write(`  [ledger] Skipping invalid entry: ${entry.topicId}\n`);
      continue;
    }

    if (byTopic.has(entry.topicId)) {
      const existing = byTopic.get(entry.topicId);
      // Preserve both adjudication axes — only update observation fields
      byTopic.set(entry.topicId, {
        ...existing,
        // Observation fields: update to latest sighting
        lastSeenRound: entry.round,
        latestFindingId: entry.findingId,
        detail: entry.detail,
        severity: entry.severity,  // Severity can change across rounds
        // Adjudication fields: NEVER overwrite from auto-write
        adjudicationOutcome: existing.adjudicationOutcome,
        remediationState: existing.remediationState,
        ruling: existing.ruling,
        rulingRationale: existing.rulingRationale,
        // Tracking
        firstSeenRound: existing.firstSeenRound ?? existing.round ?? entry.round
      });
      updated++;
    } else {
      byTopic.set(entry.topicId, {
        ...entry,
        firstSeenRound: entry.round,
        lastSeenRound: entry.round
      });
      inserted++;
    }
  }

  ledger.entries = [...byTopic.values()];
  // Validate final ledger before atomic write
  if (ledger.entries.some(e => !e.topicId)) {
    throw new Error('Ledger integrity check failed: entry without topicId');
  }
  atomicWriteFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  return { inserted, updated, total: ledger.entries.length };
}
```

**Ledger population** (after line 964, after R2+ suppression and final `allFindings` is set). **The authoritative finding set is `allFindings` at this point** — post-dedup, post-R2+ suppression (Round 2+), post-FP-tracker suppression. Suppressed findings are NOT written; they already have ledger entries from prior rounds.

```javascript
if (ledgerPath && !noLedger) {
  // Create immutable copies for ledger projection — do NOT mutate allFindings
  const enriched = allFindings.map(f => {
    const copy = { ...f };
    populateFindingMetadata(copy, copy._pass);
    return copy;
  });

  const ledgerEntries = enriched.map(f => ({
    topicId: generateTopicId(f),  // Uses full finding: file, principle, category, pass, content hash
    findingId: f.id,
    severity: f.severity,
    category: f.category,
    section: f.section,
    detail: f.detail?.slice(0, 300),
    pass: f._pass,
    _hash: f._hash,
    adjudicationOutcome: 'pending',
    remediationState: 'pending',
    round
  }));

  const { inserted, updated, total } = batchWriteLedger(ledgerPath, ledgerEntries);
  process.stderr.write(`  [ledger] Written to ${ledgerPath}: ${inserted} new, ${updated} updated, ${total} total\n`);
}
```

**Topic identity**: `generateTopicId()` (already implemented in `lib/ledger.mjs:24-34`) hashes: normalized file path + principle + category + pass + content hash (`_hash` or `semanticId()`). This is stable across severity changes and unique across distinct findings in the same file.

**Ledger write failure policy**: Ledger write happens BEFORE final result emission to `--out`. On failure:
1. Log warning to stderr with error details
2. Attach `_ledgerWriteError: err.message` to `mergedResult`
3. Still emit the result JSON (audit findings are more important than ledger persistence)
4. Exit code remains 0 (findings were produced successfully)
5. If `--strict-ledger` flag is passed, exit code 2 on ledger write failure (for CI pipelines that require ledger integrity)

```javascript
if (ledgerPath && !noLedger) {
  try {
    const { inserted, updated, total } = batchWriteLedger(ledgerPath, ledgerEntries);
    process.stderr.write(`  [ledger] Written: ${inserted} new, ${updated} updated, ${total} total\n`);
  } catch (err) {
    process.stderr.write(`  [ledger] WRITE FAILED: ${err.message}\n`);
    mergedResult._ledgerWriteError = err.message;
    if (args.includes('--strict-ledger')) {
      // Emit result first, then exit with error
      if (outFile) fs.writeFileSync(outFile, JSON.stringify(mergedResult, null, 2));
      process.exit(2);
    }
  }
}
```

**SKILL.md update**: Step 2 invocation no longer needs `--write-ledger`. Ledger is auto-written alongside `--out`. Step 3.5 simplifies to: "Ledger is auto-populated. To update adjudication outcomes after deliberation, use `writeLedgerEntry()` to set `adjudicationOutcome: 'dismissed'|'accepted'`." Round 2 passes `--ledger /tmp/$SID-r1-ledger.json`.

### 2.6 Populate `_suppression` on mergedResult

**File**: `scripts/openai-audit.mjs` — lines 922-964

**Current**: Suppression stats are logged to stderr but never attached to `mergedResult`. Line 1073 checks `mergedResult._suppression` but it's always `undefined`.

**Change**: After the R2+ suppression block, attach the stats:

```javascript
// After line 961: allFindings.push(...kept, ...reopened);

mergedResult._suppression = {
  kept: kept.length,
  suppressed: suppressed.length,
  reopened: reopened.length,
  suppressedIds: suppressed.map(s => s.matchedTopic?.slice(0, 12)),
  fpSuppressed: fpSuppressed?.length ?? 0
};
```

This fixes the dead reference at line 1073 and enables `recordSuppressionEvents()` to actually persist data.

### 2.7 Detect Incomplete/Truncated Structured Output

**File**: `scripts/openai-audit.mjs` — `_callGPTOnce()` (lines ~335-345)

**Current**: Only checks `response.status === 'incomplete'`. Does not check `finish_reason === 'length'` (max_tokens truncation) or other degraded states. With `openai@6.17.0` structured output, an incomplete response may still produce a partial `output_parsed` that passes the null check.

**Change**: Add a completion-status normalization step after `responses.parse()`. Attach partial usage to error objects so retry and MAP accounting can track tokens consumed by failed attempts.

**Custom error class** (replaces message-string matching in `classifyLlmError`):

```javascript
/**
 * Structured LLM error — carries usage and category for retry/accounting.
 * classifyLlmError() checks err.llmCategory instead of message strings.
 */
class LlmError extends Error {
  constructor(message, { category, usage = null, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.llmCategory = category;    // 'truncated' | 'incomplete' | 'schema' | etc.
    this.llmUsage = usage;          // { input_tokens, output_tokens, reasoning_tokens } or null
    this.llmRetryable = retryable;
  }
}
```

**Completion-status normalization** in `_callGPTOnce()`:

```javascript
const response = await openai.responses.parse(requestParams, { signal: controller.signal });
clearTimeout(timer);
const latencyMs = Date.now() - startMs;

// Extract usage regardless of success/failure — needed for accounting
const usage = {
  input_tokens: response.usage?.input_tokens ?? 0,
  output_tokens: response.usage?.output_tokens ?? 0,
  reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
  latency_ms: latencyMs
};

// Normalize completion status — detect all degraded states
if (response.status === 'incomplete') {
  const reason = response.incomplete_details?.reason ?? 'unknown';
  throw new LlmError(`Response incomplete: ${reason}`, { category: 'incomplete', usage, retryable: true });
}

// Check ALL output items for completion (max_tokens truncation)
// OpenAI Responses API can have multiple output items — check each
for (const item of (response.output ?? [])) {
  if (item?.status === 'incomplete') {
    throw new LlmError(`Output truncated: ${item.incomplete_details?.reason ?? 'max_tokens'}`,
      { category: 'truncated', usage, retryable: true });
  }
}

const result = response.output_parsed;
if (!result) throw new LlmError('No parsed output from model', { category: 'empty', usage });

// Validate expected shape
if (schema && result.findings !== undefined && !Array.isArray(result.findings)) {
  throw new LlmError(`Schema violation: findings is ${typeof result.findings}, expected array`,
    { category: 'schema', usage });
}
```

**Updated `classifyLlmError()`** — uses structured fields, no message matching:

```javascript
function classifyLlmError(err) {
  // Structured LlmError — use its fields directly
  if (err.llmCategory) return { retryable: err.llmRetryable, category: err.llmCategory };
  // HTTP status codes (OpenAI SDK)
  if (err.status) {
    if ([429, 500, 502, 503, 504].includes(err.status)) return { retryable: true, category: `http-${err.status}` };
    if (err.status >= 400 && err.status < 500) return { retryable: false, category: `http-${err.status}` };
  }
  // Abort/timeout
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return { retryable: true, category: 'timeout' };
  // Network-level failures
  if (err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ENOTFOUND') return { retryable: true, category: 'network' };
  return { retryable: false, category: 'permanent' };
}
```

**Updated retry wrapper** — accumulates usage across attempts:

```javascript
async function callGPT(openai, opts) {
  let lastErr;
  const startMs = Date.now();
  const accumulatedUsage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await _callGPTOnce(openai, opts);
      if (attempt > 0) {
        // Add prior failed attempt usage
        result.usage.input_tokens += accumulatedUsage.input_tokens;
        result.usage.output_tokens += accumulatedUsage.output_tokens;
        result.usage.reasoning_tokens += accumulatedUsage.reasoning_tokens;
        result.latencyMs = Date.now() - startMs;
        result._retried = true;
        result._attempts = attempt + 1;
      }
      return result;
    } catch (err) {
      lastErr = err;
      // Accumulate usage from failed attempt
      if (err.llmUsage) {
        accumulatedUsage.input_tokens += err.llmUsage.input_tokens ?? 0;
        accumulatedUsage.output_tokens += err.llmUsage.output_tokens ?? 0;
        accumulatedUsage.reasoning_tokens += err.llmUsage.reasoning_tokens ?? 0;
      }
      const { retryable, category } = classifyLlmError(err);
      if (attempt < MAX_RETRIES && retryable) {
        const delayMs = category === 'http-429'
          ? Math.min(8000, 2000 * (attempt + 1) + Math.random() * 1000)  // Jitter for rate limits
          : 2000 * (attempt + 1);
        process.stderr.write(`  [${opts.passName ?? 'call'}] Retry ${attempt + 1}/${MAX_RETRIES} in ${(delayMs / 1000).toFixed(1)}s [${category}]\n`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      // Attach accumulated usage to final error for MAP accounting
      err._accumulatedUsage = accumulatedUsage;
      throw err;
    }
  }
  throw lastErr;
}
```

**Updated MAP usage accounting** — includes failed attempt usage:

```javascript
const mapUsage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
for (const r of results) {
  if (r.status === 'fulfilled' && r.value?.usage) {
    mapUsage.input_tokens += r.value.usage.input_tokens ?? 0;
    mapUsage.output_tokens += r.value.usage.output_tokens ?? 0;
    mapUsage.reasoning_tokens += r.value.usage.reasoning_tokens ?? 0;
  } else if (r.status === 'rejected' && r.reason?._accumulatedUsage) {
    // Include tokens consumed by failed MAP units
    mapUsage.input_tokens += r.reason._accumulatedUsage.input_tokens ?? 0;
    mapUsage.output_tokens += r.reason._accumulatedUsage.output_tokens ?? 0;
    mapUsage.reasoning_tokens += r.reason._accumulatedUsage.reasoning_tokens ?? 0;
  }
}
```

**What counts as a "failed MAP unit"**: A MAP unit is counted as failed when its `Promise.allSettled` result has `status === 'rejected'`. This happens when `_callGPTOnce` throws (timeout, truncation, incomplete, schema violation, network error) AND the retry in `callGPT` also fails or the error is not retryable. In other words: a unit fails when it cannot produce a valid `PassFindings` result after all retry attempts.

---

## 3. File Impact Summary

| File | Changes |
|---|---|
| `scripts/openai-audit.mjs` | 2.1 (truncation + normalization), 2.2 (null guards), 2.3 (retry + LlmError + classifyLlmError), 2.4 (MAP threshold + effective failures + usage), 2.5 (ledger auto-write + resolveLedgerPath), 2.6 (suppression metadata), 2.7 (incomplete output detection) |
| `scripts/lib/ledger.mjs` | 2.5 — add `batchWriteLedger()` with validation + 2-axis preservation |
| `scripts/lib/schemas.mjs` | 2.5 — add/update `LedgerEntrySchema` with new fields (`firstSeenRound`, `lastSeenRound`, `latestFindingId`) |
| `.claude/skills/audit-loop/SKILL.md` | Simplify Step 3.5 (ledger now auto-written), update Step 5 R2+ invocation |
| `.github/skills/audit-loop/SKILL.md` | Mirror SKILL.md changes |
| `tests/shared.test.mjs` | Add tests for all changes |

### Constants (centralized in `scripts/openai-audit.mjs` config block)

```javascript
// ── Robustness constants ────────────────────────────────────────────
const MAX_REDUCE_JSON_CHARS = 120_000;   // Character budget for REDUCE input payload
const MAX_DETAIL_CHARS = 200;            // Per-finding detail cap in REDUCE payload
const MAP_FAILURE_THRESHOLD = 0.5;       // Skip REDUCE when this fraction of MAP units fail
const RETRY_MAX_ATTEMPTS = 1;            // Max retries per callGPT invocation
const RETRY_BASE_DELAY_MS = 2000;        // Base delay for retry backoff
const RETRY_429_MAX_DELAY_MS = 8000;     // Max delay for rate-limit retries (includes jitter)
const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };  // Severity sort order
```

---

## 4. Testing Strategy

### Unit Tests (node --test)

| Test | What it validates |
|---|---|
| `buildReducePayload()` produces valid JSON | Output parses without error for any input |
| `buildReducePayload()` respects budget | Output length <= MAX_REDUCE_JSON_CHARS |
| `buildReducePayload()` enforces sort | HIGH findings always before MEDIUM/LOW regardless of input order |
| `buildReducePayload()` handles single oversized finding | Detail truncated further, still valid JSON |
| `buildReducePayload()` handles empty input | Returns valid empty array JSON |
| `classifyLlmError()` — HTTP 429 | Returns `{ retryable: true, category: 'http-429' }` |
| `classifyLlmError()` — HTTP 400 | Returns `{ retryable: false, category: 'http-400' }` |
| `classifyLlmError()` — AbortError | Returns `{ retryable: true, category: 'timeout' }` |
| `classifyLlmError()` — ECONNRESET | Returns `{ retryable: true, category: 'network' }` |
| `classifyLlmError()` — truncated output | Returns `{ retryable: true, category: 'truncated' }` |
| `classifyLlmError()` — unknown error | Returns `{ retryable: false, category: 'permanent' }` |
| Retry wraps single failure then succeeds | Mock 429 then success, verify 1 retry + accumulated latency |
| Retry not triggered on permanent error | Mock 400, verify immediate throw, 0 retries |
| MAP usage accounting across failures | Fulfilled units' tokens summed, rejected units skipped |
| MAP threshold skips REDUCE at >50% failure | Returns raw findings with truthful usage |
| MAP threshold allows REDUCE at <=50% failure | Proceeds to REDUCE normally |
| `batchWriteLedger()` creates new file | Valid JSON ledger with version + entries |
| `batchWriteLedger()` upserts by topicId | Existing entries updated, new entries inserted, one atomic write |
| `batchWriteLedger()` is idempotent | Same entries written twice = same result |
| `batchWriteLedger()` preserves adjudication axes | Existing `adjudicationOutcome` and `remediationState` not overwritten |
| `batchWriteLedger()` tracks round sightings | `firstSeenRound` preserved, `lastSeenRound` updated |
| `batchWriteLedger()` rejects corrupted ledger | Non-ENOENT read errors thrown, not swallowed |
| `batchWriteLedger()` validates entries | Entries without topicId or severity are skipped with warning |
| Ledger auto-write uses full finding for topicId | `generateTopicId(f)` receives enriched copy, not field subset |
| Ledger auto-write does not mutate allFindings | Original finding objects unchanged after ledger projection |
| Ledger path derivation from --out | `/tmp/sid-r1-result.json` → `/tmp/sid-r1-ledger.json` |
| R2+ fails fast without --ledger | `process.exit(1)` with clear error message |
| `--no-ledger` suppresses all ledger I/O | No file created, no fail-fast on R2+ |
| `_suppression` populated after R2+ | mergedResult has kept/suppressed/reopened counts |
| `buildReducePayload()` returns degraded on impossible budget | `{ degraded: true, includedCount: 0 }` when no shrinking works |
| `classifyLlmError()` — LlmError with category | Returns `{ retryable, category }` from structured fields, no message matching |
| Retry accumulates usage across attempts | Failed attempt tokens added to successful result |
| Retry attaches usage to final error | `err._accumulatedUsage` present on throw |
| Retry adds jitter for 429 | Delay includes random component for rate limits |
| MAP usage includes failed units | `r.reason._accumulatedUsage` tokens summed |
| Incomplete response detected | LlmError with `category: 'incomplete'` and usage attached |
| Truncated output detected | LlmError with `category: 'truncated'`, retryable = true |

### Integration Smoke Test

Run a real audit with default ledger auto-write:
```bash
node scripts/openai-audit.mjs code docs/plans/test.md --out /tmp/test-result.json
```
Then verify:
1. `/tmp/test-ledger.json` auto-created alongside output
2. Ledger file is valid JSON with `version` and `entries` array
3. Entry count matches finding count
4. Each entry has `topicId`, `adjudicationOutcome: 'pending'`, `firstSeenRound`, `lastSeenRound`
5. Run Round 2 with `--ledger /tmp/test-ledger.json --round 2` and verify suppression kicks in
6. Run with `--no-ledger` and verify no ledger file created
7. Run Round 2 without `--ledger` and verify fail-fast error message

---

## 5. Rollback Strategy

All changes are additive or guarded by conditions:
- Ledger auto-write is default-on but `--no-ledger` disables it; existing invocations without `--out` produce no ledger file
- Retry logic wraps existing function (remove wrapper = revert to `_callGPTOnce`)
- `classifyLlmError()` and `LlmError` are pure additions with no side effects on existing code
- Null guards are purely defensive (no behavioral change on happy path)
- MAP threshold only activates on >50% failure (existing behavior preserved below threshold)
- `_suppression` metadata is a new field (no existing code depends on it being absent)
- Incomplete output detection adds stricter validation inside existing try-catch (errors are caught by `safeCallGPT`)

**Backward-compatibility note on new side effects**: Ledger auto-creation and changed stderr output are new observable behaviors. For automation/scripts that parse stderr or check for file existence: (1) stderr format is informational, not a contract, (2) `--no-ledger` suppresses all ledger side effects, (3) the fail-fast on R2+ without `--ledger` is a new hard error — scripts must be updated to pass a ledger path for multi-round workflows.

---

## 6. Implementation Order

1. **2.7** Incomplete output detection (adds to `_callGPTOnce`, must exist before retry wraps it)
2. **2.3** Retry logic + `classifyLlmError()` (wraps `_callGPTOnce`, depends on 2.7 error messages)
3. **2.1** Safe JSON truncation via `buildReducePayload()` (highest impact, self-contained)
4. **2.2** Null guards (5 lines, prevents crashes)
5. **2.4** MAP failure threshold + usage accounting (depends on 2.3 retry existing for full resilience)
6. **2.6** Populate `_suppression` (fixes existing bug)
7. **2.5** `batchWriteLedger()` in lib/ledger.mjs + auto-write in openai-audit.mjs (feature addition, enables R2+)
8. Tests for all of the above
9. SKILL.md updates

## 7. Future Work (Out of Scope)

- **Normalize pass-result contract** — Replace nullable `{ result }` with discriminated union `{ status: 'ok'|'error'|'degraded', result, error }` so downstream consumers have one shape. Currently scoped to optional chain (2.2) as a targeted fix.
- **Multi-retry with jitter** — Current single-retry is sufficient for observed failure rates. If MAP failure rates remain >10% after this work, revisit with exponential backoff + jitter.
- **Auto-adjudicate ledger from rebuttal** — After rebuttal resolution, auto-update ledger entries from 'pending' to 'accepted'/'dismissed'. Currently requires manual `writeLedgerEntry()` call in Step 3.5.
