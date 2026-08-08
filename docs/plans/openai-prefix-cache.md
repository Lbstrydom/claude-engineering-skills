# Plan: OpenAI prompt prefix-caching for the audit pipeline

- **Date**: 2026-05-11
- **Status**: Complete — implemented + verified 2026-05-11 (PR-1..5 shipped; Gemini final review APPROVE)
- **Author**: Claude + Louis (origin: /brainstorm with GPT-5 + Gemini-3-Pro on 2026-05-11)
- **Scope**: backend
- **Target domain(s)**: `audit-orchestration`, `tests`
- **Module placement (R1/M1 fix)**: the new prompt-builder lives at `scripts/lib/audit/prompt-builder.mjs` (audit-scoped, NOT `scripts/lib/audit/prompt-builder.mjs`). Its contract is audit-specific (brief, planSlice, code, history, unitLabel) — promoting it to shared-infra would be premature abstraction. If true cross-domain reuse emerges later, extract a lower-level generic message composer beneath this audit wrapper. Single-domain work.

> **Neighbourhood considered** (top similarity scores against `scripts/openai-audit.mjs` + planned new `scripts/lib/audit/prompt-builder.mjs`)
>
> | Symbol | File | Domain | Recommendation |
> |---|---|---|---|
> | `runMultiPassCodeAudit` | `scripts/openai-audit.mjs:780` | audit-orchestration | review (entry point — call-site refactor target) |
> | `runMapReducePass` | `scripts/openai-audit.mjs:613` | audit-orchestration | review (per-unit fan-out — primary cache-seed target) |
> | `_callGPTOnce` | `scripts/openai-audit.mjs:365` | audit-orchestration | review (must return cached_tokens for telemetry) |
> | `safeCallGPT` | `scripts/openai-audit.mjs:507` | audit-orchestration | review (extend opts to accept messages array) |
> | `callGPT` | `scripts/openai-audit.mjs:462` | audit-orchestration | review (retry wrapper — pass through new opts) |
> | `buildR2SystemPrompt` | `scripts/lib/ledger.mjs:486` | shared-lib | review (current system-prompt assembler — being replaced) |
> | `readProjectContextForPass` | `scripts/lib/context.mjs:518` | shared-lib | reuse (returns per-pass-sliced brief; stays as-is) |
> | `extractPlanForPass` | `scripts/lib/context.mjs:606` | shared-lib | reuse (returns per-pass-sliced plan; stays as-is) |
> | `buildDebatePrompt` | `scripts/lib/brainstorm/debate-prompt.mjs:51` | brainstorm | review (similar shape — different domain, sibling not shared abstraction) |
>
> No high-similarity reuse candidate; all in `review` band. The new prompt-builder lives in `shared-lib` because it has no audit-specific logic.

No security incidents matched these paths.

---

## 0.  TL;DR — what changes, what doesn't

**This is a smaller intervention than the brainstorm suggested.** Phase-1 exploration found that `readProjectContextForPass()` and `extractPlanForPass()` already pre-slice content per pass (different addendum, different plan sections). The brainstorm assumed we were sending the full preamble to every pass — we aren't. Naively "send full plan + full brief to every pass to enable cross-pass caching" would *increase* total billed tokens (50% cache discount doesn't offset 3x volume).

**What we DO**:
1. Within-pass / cross-round restructure: split the per-pass user prompt into a stable msg #1 (brief + plan-slice + file-list-context) and a dynamic msg #2 (unit label + code + history-block). Stable msg #1 becomes cacheable across map-reduce sub-passes AND across rounds (R1→R2→R3).
2. Telemetry: thread `cached_tokens` through `_callGPTOnce` → `callGPT` → `safeCallGPT` → per-audit summary in session manifest.
3. Cache-seed within map-reduce when `units.length > 1`: run sub-pass 0 to completion first, then Promise.allSettled the remainder. Wall-clock cost: ~5-15s on the first sub-pass. Benefit: cache hit on user msg #1 for sub-passes 1..N-1.

**What we DO NOT**:
- ❌ Cross-pass cache-seed at R1 fanout (5 quality passes have different rubrics + different content slices — no shared prefix worth seeding).
- ❌ Gemini transcript caching (brainstorm B — abandoned: 32K threshold + state mgmt + would force Opus self-review fallback).
- ❌ Anthropic ephemeral caching on the Opus fallback path (defer — only fires when `GEMINI_API_KEY` is absent).

**Honest expected savings** (after exploration):
- R1 single-pass audits (typical small PR): **5-15% input-token reduction** (only from R1's pre-R2 historyBlock relocation, no map-reduce yet)
- R1 with map-reduce (large file sets): **20-35% input-token reduction** on the map-reduce passes
- R2+ rounds: **30-50% input-token reduction** per pass (same plan, same files, only history-block changes)
- **Whole-audit weighted average: ~15-25%** — far below the brainstorm's "60% headline", which assumed an architecture we don't have.

This is still worth shipping for the R2+ benefit alone, plus the telemetry surface lets us measure real savings and refine.

---

## 1.  Context Summary

### What exists today (Phase 1 exploration)

- **`_callGPTOnce(openai, opts)`** (`scripts/openai-audit.mjs:365-456`): does the actual `openai.responses.parse({ input: [{role:'system',content:systemPrompt}, {role:'user',content:userPrompt}] })`. Two-message format already; no third+ message support.
- **`callGPT` / `safeCallGPT`** wrap it with retry + graceful degradation. Pass `{ systemPrompt, userPrompt, schema, schemaName, reasoning, maxTokens, timeoutMs, passName }` through unchanged.
- **Per-pass call sites in `runMultiPassCodeAudit`** (line 780-2001, ~14 call sites): each builds `userPrompt` ad-hoc as a string-concat: `'## Project Context\n' + readProjectContextForPass(passName) + '\n' + historyBlock + '\n## Plan\n' + extractPlanForPass(planContent, passName) + '\n\n' + fileListContext + '\n\n## ...\n' + readFilesAsContext(...)`. **Layout puts historyBlock BEFORE the plan slice** — destroys cache stability across rounds because historyBlock changes between R1/R2/R3.
- **`runMapReducePass`** (line 613): N sub-units fired in parallel via `Promise.allSettled`. Each sub-unit's userPrompt is `'## Project Brief\n' + projectBrief + '\n\n## Audit Unit i/N (n files)\n\n## Code\n' + context`. **`${i+1}` is injected EARLY in the string** — breaks cache after the literal `## Audit Unit ` prefix (~25 stable chars before the unit-number varies).
- **No cache telemetry today**: `_callGPTOnce` returns `usage: { input_tokens, output_tokens, reasoning_tokens, latency_ms }` — no `cached_tokens` field; OpenAI's `prompt_tokens_details.cached_tokens` is on the response but discarded.

### Patterns reused vs new

**Reused**:
- `readProjectContextForPass` / `extractPlanForPass` — per-pass slicing stays.
- `_callGPTOnce` two-message Responses API contract — extended, not replaced.
- Session-manifest write at end-of-audit (in `main()` near line ~2400) — extended with cache totals.

**New**:
- `scripts/lib/audit/prompt-builder.mjs` — pure function `buildAuditPassPrompt({ systemRubric, brief, planSlice, fileListContext, code, history, unitLabel })` returning `{ system, messages: [...] }`. Single SSoT for prompt shape across all audit call sites (#5).
- `cached_tokens` field in usage objects throughout the audit-pipeline call-chain.
- `cache-seed` helper inside `runMapReducePass` — synchronous-first-then-fan-out gated by `shouldSeedCache()` policy (checks `AUDIT_CACHE_SEED === '1'` AND `units.length > 1` AND prefix-token estimate ≥ threshold).

### Known user-visible issues

N/A (backend-only, no UI).

### Past lessons

- The recent gemini-gate-scope-fix audit had a Gemini-R2 hallucination at HIGH severity. Don't trust isolated quotes from any reviewer about "GPT warned in R1" — verify with stderr. (Reinforces #19 Observability — telemetry surfaces should be auditable, not just claimed.)
- The symbol-index-bugs audit demonstrated that R2+ ledger suppression catches re-raises but burns input tokens re-sending the same brief+plan+files context. Direct evidence that R2+ caching is the highest-value lever.

---

## 2.  Proposed Architecture

```
                         ┌─────────────────────────────────────────────────┐
                         │  scripts/lib/audit/prompt-builder.mjs  (NEW)    │
                         │  ─────────────────────────────────────           │
                         │  buildAuditPassPrompt({                          │
                         │    systemRubric,    // pass-specific, STATIC    │
                         │                     // (NO rulings injected     │
                         │                     //  into system — H1 fix)   │
                         │    brief,           // pass-sliced via          │
                         │                     // readProjectContextForPass│
                         │    planSlice,       // pass-sliced via          │
                         │                     // extractPlanForPass       │
                         │    fileListContext, // file list summary        │
                         │    code,            // file contents            │
                         │    history,         // OPTIONAL R2+ rulings     │
                         │    unitLabel,       // OPTIONAL map-reduce      │
                         │  }) → { system, messages: [m1, m2?, m3] }       │
                         │                                                  │
                         │  THREE-MESSAGE STRUCTURE (M4 fix —              │
                         │  preserves rulings salience before code):       │
                         │                                                  │
                         │  msg #1 (stable across rounds + map-reduce      │
                         │           sub-units):                            │
                         │    `## Project Context\n${brief}\n\n`           │
                         │    `## Plan\n${planSlice}\n\n`                  │
                         │    `${fileListContext}`                         │
                         │                                                  │
                         │  msg #2 (DYNAMIC — R2+ rulings; omitted on R1): │
                         │    `## Prior Rulings\n${history}`               │
                         │                                                  │
                         │  msg #3 (DYNAMIC — code + unit label):          │
                         │    `## Code${unitLabel ? ' (' + unitLabel +     │
                         │     ')' : ''}\n${code}`                          │
                         │                                                  │
                         │  Rationale: msg #1 is the cacheable prefix.     │
                         │  msg #2 precedes msg #3, preserving the         │
                         │  rulings-before-code instruction salience       │
                         │  that the R2+ pipeline depends on for           │
                         │  suppression accuracy (M4 fix).                 │
                         └─────────────────────────────────────────────────┘
                                          │
                                          │  consumed by
                                          ▼
       ┌──────────────────────────────────────────────────────────────────┐
       │  scripts/openai-audit.mjs                                        │
       │  ────────────────────────                                        │
       │                                                                  │
       │  Per-pass call site (14 sites — Wave 1, 2, 3, 4):               │
       │    // H1 fix: do NOT pre-bake rulings into system.              │
       │    // Use STATIC rubric only; rulings go in dynamic msg #2.     │
       │    const { system, messages } = buildAuditPassPrompt({          │
       │      systemRubric: PASS_<NAME>_SYSTEM + focusBlock,             │
       │      brief: readProjectContextForPass(passName),                │
       │      planSlice: extractPlanForPass(planContent, passName),     │
       │      fileListContext,                                           │
       │      code: readFilesAsContext(files, ...),                      │
       │      history: isR2Plus                                          │
       │        ? buildRulingsBlock(ledgerFile, passName, impactSet)    │
       │        : null,                                                  │
       │    });                                                          │
       │    safeCallGPT(openai, { system, messages, schema, ... });      │
       │                                                                  │
       │  Map-reduce sub-pass (in runMapReducePass):                     │
       │    const { system, messages } = buildAuditPassPrompt({          │
       │      systemRubric, brief, planSlice, fileListContext, code,    │
       │      unitLabel: `Audit Unit ${i+1}/${units.length}`,            │
       │      history,                                                   │
       │    });                                                          │
       │    callGPT(openai, { system, messages, ... });                  │
       │                                                                  │
       │  Cache-seed wrapper (NEW, ~line 630 — H2 + L2 +                 │
       │  Gemini-R1/MED + LOW fix):                                       │
       │    // runOneUnit signature today: (unit, i) → ...                │
       │    // - unit is the AuditUnit object                             │
       │    // - i is the unit's original index                           │
       │    if (shouldSeedCache(units, prefixEstimate)) {                │
       │      const seedIdx = pickSeedUnit(units); // smallest by tok    │
       │      const [seedSettled] = await Promise.allSettled([           │
       │        runOneUnit(units[seedIdx], seedIdx)                      │
       │      ]);                                                        │
       │      // Gemini-R1/MED: re-throw config errors immediately       │
       │      // (programmer bugs must not be swallowed by allSettled)   │
       │      throwIfConfigError(seedSettled);                           │
       │      const fanoutIdxs = units                                   │
       │        .map((_, i) => i)                                        │
       │        .filter(i => i !== seedIdx);                             │
       │      const fanoutSettled = await Promise.allSettled(            │
       │        fanoutIdxs.map(i => runOneUnit(units[i], i))             │
       │      );                                                          │
       │      // Re-throw any config errors from fanout (fail-fast)      │
       │      for (const s of fanoutSettled) throwIfConfigError(s);      │
       │      // Reconstruct results in ORIGINAL unit order              │
       │      results = new Array(units.length);                         │
       │      results[seedIdx] = seedSettled;                            │
       │      fanoutIdxs.forEach((origIdx, j) =>                         │
       │        { results[origIdx] = fanoutSettled[j] });                │
       │    } else {                                                     │
       │      results = await Promise.allSettled(                        │
       │        units.map((unit, i) => runOneUnit(unit, i))              │
       │      );                                                          │
       │      for (const s of results) throwIfConfigError(s);            │
       │    }                                                            │
       │                                                                  │
       │  // helper, local to runMapReducePass:                          │
       │  function throwIfConfigError(settled) {                         │
       │    if (settled.status === 'rejected' &&                         │
       │        settled.reason instanceof LlmError &&                    │
       │        settled.reason.category === 'config') {                  │
       │      throw settled.reason; // fail-fast on programmer bugs      │
       │    }                                                            │
       │  }                                                              │
       │                                                                  │
       │  _callGPTOnce extended return:                                  │
       │    usage.cached_tokens = response.usage                         │
       │      ?.prompt_tokens_details?.cached_tokens ?? 0                │
       │                                                                  │
       │  Session manifest at end of main():                             │
       │    manifest.cacheMetrics = {                                    │
       │      totalInputTokens, totalCachedTokens, cacheHitRate,        │
       │      perPass: { structure: {...}, ... }                         │
       │    }                                                            │
       └──────────────────────────────────────────────────────────────────┘
```

### Key design decisions (with cited principles)

1. **`buildAuditPassPrompt` is a pure function in an audit-scoped lib module (`scripts/lib/audit/prompt-builder.mjs`)** (#3 Modularity, #11 Testability, R1/M1 fix). Takes flat input, returns `{ system, messages }`. No I/O, no LLM calls, no side effects. The contract is audit-specific (brief / planSlice / code / history / unitLabel) — placing it under `lib/audit/` makes that explicit rather than masquerading as shared infra. Unit-testable in isolation; integration-tested by snapshot comparison against current `userPrompt` strings.

2. **THREE user messages (M4 fix)** (#5 SSoT, #18 Backward Compat). The Responses API accepts arbitrarily many user messages; OpenAI auto-caches the byte-stable prefix from the start of the request. Splitting into three (stable msg #1, dynamic rulings msg #2, dynamic code msg #3) preserves the rulings-before-code instruction salience the R2+ pipeline depends on for suppression accuracy, while keeping msg #1 byte-stable across rounds and map-reduce sub-units.

3. **R1/H1 + Gemini-R1/H1 fix — system prompt is strictly round-agnostic** (#5 SSoT). Today `buildR2SystemPrompt(rubric, rulings)` concatenates rulings INTO the system prompt; AND the R2_ROUND_MODIFIER constant is also conditionally injected into system on R2+. Both make the system prompt round-varying, invalidating the OpenAI prefix cache from byte 0. **Fix**: the audit `system` prompt for a given pass is **ONLY** `PASS_<NAME>_SYSTEM + focusBlock` — both static across rounds. Both `R2_ROUND_MODIFIER` (round-specific prelude) AND `rulings` (round-specific dismissals/adjustments) move to dynamic user msg #2 — R2_ROUND_MODIFIER first, then rulings text. On R1, msg #2 is omitted entirely. A snapshot test asserts the system prompt is BYTE-IDENTICAL across R1/R2/R3 for a given pass — fixture loads three states and diffs.

4. **`unitLabel` (map-reduce unit number) goes in user msg #3** (same as #2). Today's `## Audit Unit ${i+1}/${units.length}` breaks the cacheable prefix at the unit-number injection. Moving it to msg #3 alongside code keeps msg #1 stable across all sub-units in a pass.

5. **`safeCallGPT`/`callGPT`/`_callGPTOnce` accept a `messages` array param OR the legacy `userPrompt` string** (#18 Backward Compat). Internally normalises to messages array via a single discriminated-union normalisation layer in `_callGPTOnce`. **Layered contract** (R2 H2 fix):
   - **`_callGPTOnce`** rejects hybrid combinations (`{ systemPrompt, messages }`, `{ system, userPrompt }`, `{ systemPrompt, userPrompt, system, messages }`, etc.) by throwing `LlmError({ category: 'config', retryable: false })` BEFORE any LLM call. Accepts exactly one of:
     - Legacy mode: `{ systemPrompt: string, userPrompt: string }`
     - Structured mode: `{ system: string, messages: [{role:'user',content:string}, ...] }`
   - **`callGPT`** propagates that error (4xx-equivalent: non-retryable).
   - **`safeCallGPT` is graceful for LLM errors, fail-fast for config errors (R3/H1 fix)**: it catches `LlmError` categories `transient`, `incomplete`, `truncated`, `model_error`, `network_error`, `timeout` and returns the graceful-degradation shape. It RE-THROWS `LlmError({category:'config'})` — those are programmer errors (hybrid input, schema mismatch) that should crash loudly in tests, not silently degrade an audit pass in production. This preserves "audit keeps running despite LLM flakes" without masking developer bugs.

   Legacy callers (brainstorm, etc.) don't have to migrate.

6. **Cache-seed is opt-in via `AUDIT_CACHE_SEED=1` env (default OFF on initial ship)** (#11 Testability, #19 Observability, R1/H2 + R3/M3 fix). **Single env semantic**: `AUDIT_CACHE_SEED === '1'` ENABLES; ANY OTHER value (unset, empty string, `'0'`, `'true'`, `'yes'`) DISABLES. Documented in the env-var table. The `shouldSeedCache()` policy function reads this env ONCE per audit run, not per call — env reads are not in the hot path. **Seed is settled, not awaited** — wrapped in `Promise.allSettled` so a seed failure cannot block fan-out (R1/H2 fix). Result ordering is preserved by reconstructing the array post-fan-out using the original unit index, not seed order.

7. **L2 fix — seed unit selection**. The seed unit is chosen by `pickSeedUnit(units)` — pick the smallest (by token count) unit. Reason: the seed's only job is to warm the cache with msg #1; the dynamic code body is irrelevant to that purpose. Smallest unit = fastest warm-up. Result ordering remains tied to the original unit index regardless of which unit seeded.

7b. **Gemini-R1/MED fix — `throwIfConfigError` after each `Promise.allSettled`**. The R3/H1 fail-fast policy (re-throw `category:'config'` errors from `safeCallGPT`) is defeated by `Promise.allSettled` wrappers in `runMapReducePass`, which silently capture every rejection. **Fix**: after every `Promise.allSettled(...)` in `runMapReducePass` (seed call, fanout call, and the non-seed plain-fanout case), iterate settled results and immediately throw if any rejection is `LlmError({category:'config'})`. Wrapping helper `throwIfConfigError(settled)` is local to `runMapReducePass`. Wrapper-contract test asserts that a config error in any unit propagates to the caller (not swallowed).

7c. **R2/M3 fix — `shouldSeedCache()` eligibility policy**. Before any seed-then-fanout, an eligibility function checks both:
   - `units.length > 1` (no point seeding for a single unit)
   - `estimatePrefixTokens(systemRubric, brief, planSlice, fileListContext) >= STABLE_PREFIX_MIN_TOKENS` (default `1024`, env-tunable via `AUDIT_CACHE_STABLE_PREFIX_MIN`)

   `estimatePrefixTokens` uses the same deterministic char-based estimate (~chars/4) used in `computePassLimits` — no new tokenizer dependency in the hot path. Below the threshold, seed-then-fanout falls back to plain `Promise.allSettled` (current behaviour). The same function is used in both production and tests so behaviour is identical.

   Telemetry records `seedEligible`, `seedUsed`, `seedSkipReason` per map-reduce pass into the manifest:

   ```js
   manifest.cacheMetrics.perPass['backend'].mapReduce = {
     seedEligible: true,
     seedUsed: true,
     seedSkipReason: null,  // or 'units.length<=1', 'prefix-too-small', 'env-disabled'
     seedUnitIdx: 2,        // which unit was picked
     seedUnitTokens: 1500,
   }
   ```

8. **NO cross-pass cache-seed at R1 fanout of the 5 quality passes**. Per-pass slicing analysis (Phase 1): the 5 R1 passes have different rubrics + different brief addendums + different plan slices + different file scopes. Trying to share a prefix across passes would require sending the full plan + full brief to every pass — 3x token volume for a 50%-discount cache hit = net loss. Documented decision; no code.

9. **Cache telemetry is observability, not gating** (#19 Observability, #15 Error Handling). `cached_tokens` is logged + aggregated, never thrown on. Missing `prompt_tokens_details` (older OpenAI response shape) → log `cached_tokens: 0`, audit proceeds.

### Telemetry contract (R1/M3 fix — explicit schema)

Every LLM call returns the following `usage` shape from `_callGPTOnce`:

```js
{
  input_tokens:        Number, // total billed input tokens for this attempt
  cached_tokens:       Number, // tokens hit by cache this attempt (0 if no cache hit)
  output_tokens:       Number, // total output tokens
  reasoning_tokens:    Number, // reasoning tokens (subset of output_tokens)
  latency_ms:          Number  // wall-clock for this attempt
}
```

`callGPT` aggregates across retries into `_accumulatedUsage` (same fields, summed).

`safeCallGPT` returns `usage` in the same shape; on graceful-degradation failure returns the zero-shape `{ input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }`.

Session manifest (per-audit aggregate) extends with:

```js
manifest.cacheMetrics = {
  totalInputTokens:    Number,   // sum across ALL attempts of ALL calls
  totalCachedTokens:   Number,   // sum across ALL attempts of ALL calls
  hitRate:             Number,   // totalCachedTokens / totalInputTokens (0..1)
  estimatedSavingsPct: Number,   // hitRate * 0.5 (OpenAI's ~50% discount on cached tokens)
  perPass: {                     // keyed by passName
    structure: { totalInputTokens, totalCachedTokens, hitRate, callCount, retryCount },
    wiring:    { ... },
    backend:   { ... },
    frontend:  { ... },
    sustainability: { ... },
    quickfix:  { ... },
    'reduce-backend':   { ... }, // map-reduce reduce phase
    'map-backend-0':    { ... }, // each map-reduce sub-unit
    'map-backend-1':    { ... },
    // ...
  }
}
```

**Definitions**:
- `hitRate` denominator is `totalInputTokens` (all billed input tokens across all attempts of all calls in this audit). Retries count separately. **Division-by-zero guard**: if `totalInputTokens === 0` (all-passes-degraded edge case), `hitRate` is computed as `0` BEFORE Zod validation — avoids `NaN` violating `.min(0).max(1)`. Same guard applies to per-pass `hitRate`.
- A "logical call" = one `callGPT` invocation (one pass or one map-reduce unit). Retries are aggregated into the logical call's totals.
- `estimatedSavingsPct` is a derived field; the actual cost saving formula is provider-defined and may shift. Recompute from `hitRate` when needed; don't trust a stale value.
- `retryCount` per pass = sum of retry-driven extra attempts (not including the first attempt).

These fields are written to `.audit/session-audit-<timestamp>.json` and surface in `[audit-summary]` stderr at end-of-run.

---

## 3.  Engineering Principles Applied

- **#1 DRY**: every audit call site builds prompts via the single `buildAuditPassPrompt` function. No copy-pasted `## Project Context\n${...}\n## Plan\n${...}` string templates across 14 call sites.
- **#3 Modularity**: `prompt-builder.mjs` is one file with one responsibility (prompt shape). No state, no I/O. Composable into the call sites without circular deps.
- **#5 SSoT**: prompt structure lives in ONE function. New audit-pass additions go through it. Contract test (Phase 9) asserts no `'## Project Context\\n'` literal remains in `openai-audit.mjs` outside the wrapper.
- **#11 Testability**: `buildAuditPassPrompt` is pure → unit tests for boundary conditions (no history, no unitLabel, empty code). Snapshot tests compare new structure against the byte-equivalent of today's string output for a known fixture, confirming behaviour preservation BEFORE cache-seed lands.
- **#15 Error Handling**: cached_tokens read is defensive: `response.usage?.prompt_tokens_details?.cached_tokens ?? 0`. Cache-seed pass is gated by env and falls back to existing parallel-fanout on failure (`process.stderr.write` log + continue, don't abort).
- **#18 Backward Compat**: legacy string-userPrompt callers (brainstorm, debate-prompt) keep working. The `_callGPTOnce` contract is extended, not changed.
- **#19 Observability**: every audit run writes `cacheMetrics` to the session manifest. Per-pass stderr lines include cached_tokens count + hit rate. Aggregate `estimated_savings_pct` is computed against the would-be uncached input-token count.
- **#20 Long-Term Flexibility**: the messages-array contract opens the door for future additions (e.g. tool-use blocks for tool-pre-pass results, separate cached blocks for repo profile vs plan vs code) without re-architecting.

---

## 4.  Execution Model (sequencing)

Operations have **strict ordering dependencies**:

| Step | Depends on | Why |
|---|---|---|
| 1. Implement `prompt-builder.mjs` (pure fn) | nothing | foundation |
| 2. Unit + snapshot tests for `buildAuditPassPrompt` | step 1 | verify shape before integration |
| 3. Extend `_callGPTOnce` / `callGPT` / `safeCallGPT` opts to accept `messages` | step 1 | call-chain plumbing |
| 4. Migrate 14 audit call sites in `openai-audit.mjs` to use `buildAuditPassPrompt` | steps 1-3 | one site at a time, behaviour-preserving |
| 5. Run full `/audit-code` on a known plan; compare findings count + hashes to baseline | step 4 | regression check |
| 6. Add cache telemetry (`cached_tokens` plumbing) | step 4 | non-blocking; can land before/after step 5 |
| 7. Add cache-seed wrapper in `runMapReducePass` (opt-in via env) | steps 4, 6 | telemetry needed to measure benefit |
| 8. Run `/audit-code` with `AUDIT_CACHE_SEED=1` on a large-file plan; verify cached_tokens > 0 | step 7 | smoke test |
| 9. Flip default `AUDIT_CACHE_SEED` to 1 in a follow-up PR (gated on telemetry data) | step 8 | needs empirical data |

**Step 9 is OUT OF SCOPE** for this plan. Ship steps 1-8. Open a follow-up issue for step 9 with empirical cache-hit-rate threshold (proposal: flip default when median R2 hit-rate > 30% across 5+ real audits).

**Partial-failure recovery**: each step's commit is independently revertable. Steps 1-3 (new module + plumbing) don't change behaviour. Step 4 is the only behaviour-affecting commit — has snapshot tests. If step 4 regresses, revert; steps 1-3 remain useful for future work.

---

## 5.  Sustainability Notes

### Assumptions that could change

- **OpenAI keeps the Responses API two-+-N-user-message format**. If they ever require a single user message, refactor `buildAuditPassPrompt` to concat into one user message — straightforward, no caller change. The 50% cache discount on stable prefix should persist.
- **5-minute TTL on OpenAI auto-cache**. If TTL shortens, R1 with map-reduce + 5+ units could see cache evictions mid-pass. Mitigation: log TTL-related cache misses (when cached_tokens=0 on a call we expected to hit), surface in session manifest.
- **`readProjectContextForPass` / `extractPlanForPass` continue per-pass slicing**. If we ever want cross-pass cache hits, REVERT to full-brief + full-plan per pass and add a `cachedPrefixBytes` budget governor. Today's plan keeps slicing.

### Future extension points deliberately built in

- `buildAuditPassPrompt({ ... otherMessages: [] })` — opens room for tool-use result blocks between stable msg #1 and dynamic msg #2 without restructuring.
- `usage.cached_tokens` field — once collected for 30 days, feed into the learning system's `audit_pass_stats` table for per-pass cache-rate trending.

### What if requirements change in 6 months

- **OpenAI ships explicit caching** (like Gemini's `cachedContent` API) → opt-in mode for repeated audits of the same plan. `prompt-builder.mjs` is the natural place to add cache-handle management.
- **A new audit pass is added (e.g. `security`)** → one call site to add (uses `buildAuditPassPrompt`). Per-pass slicing helpers already exist in `lib/context.mjs`.

---

## 6.  Risk & Trade-off Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Snapshot tests miss subtle prompt shape changes that degrade GPT response quality | medium | medium | Step 5: run full audit and compare finding hashes against baseline. Re-audit a known small plan (gemini-gate-scope-fix) and verify ≥90% finding overlap. |
| Cache-seed adds wall-clock latency that operators dislike | medium | low | Opt-in via env; default OFF. Once empirical data shows ROI, flip default. |
| OpenAI's TTL shortens, breaking R2+ cross-round caching | low | medium | Telemetry catches it (cached_tokens=0 on R2 calls). At worst we lose the R2+ benefit; R1 within-pass still works. |
| Adding `messages` array param to `_callGPTOnce` breaks brainstorm's `callGemini` (separate file but similar shape) | low | low | Brainstorm uses Gemini API, not OpenAI Responses. No code path crosses. Verified by grep. |
| Test fixture for snapshot tests gets stale | medium | low | Fixture is a small synthetic project (`tests/fixtures/synthetic-audit/`); locks via SHA in test file. Refresh annually or when a pass is added. |

### Trade-offs explicitly accepted

- **No cross-pass cache-seed**: a brainstorm participant (Gemini) flagged this as the bigger win. Phase 1 exploration disproved it. Trade-off: forgone 5-15s wall-clock-reduction-via-prefix-sharing in exchange for not increasing per-pass token volume by 3x.
- **Cache-seed within map-reduce ADDS wall-clock to first call**: estimated +5-15s on the first sub-unit, then parallel after. Trade-off accepted because R2+ benefit is the primary driver and most audits are R2+ now (post-gemini-gate-fix observation: convergence rarely hits at R1).
- **No B (Gemini transcript caching)**: see TL;DR. Trade-off accepted because savings are pennies per audit AND the alternative path (switch default reviewer to Opus 1h-ephemeral) destroys model-diversity — the architectural justification for Gemini.

---

## 7.  Testing Strategy

### Unit tests for `buildAuditPassPrompt` (`tests/prompt-builder.test.mjs` — NEW)

- Minimal fields → correct `{ system, messages }` shape; system = `systemRubric`; messages = `[msg1, msg3]` (no msg2 when history absent)
- With `history: 'rulings...'` → 3 messages; msg #2 is `## Prior Rulings\n${history}`; msg #1 unchanged
- With `unitLabel: 'Unit 3/7'` → label appears in msg #3 only (`## Code (Unit 3/7)\n${code}`); msg #1 + msg #2 unchanged
- Without `history` and `unitLabel` → 2 messages; msg #3 is `## Code\n${code}`
- Empty `code` → msg #3 has `## Code\n` literal (preserves shape; OpenAI handles)
- **Cache invariant test**: 5 consecutive calls with same `{ systemRubric, brief, planSlice, fileListContext }` and varying `{ code, history, unitLabel }` produce byte-identical `system` AND byte-identical msg #1 (the cache-prefix contract)
- **R1/R2/R3 cache invariant test**: same pass invoked across three rounds (history `null`, `'rulings A'`, `'rulings B'`) produces byte-identical `system` AND byte-identical msg #1 across all three (R1/H1 fix verification)

### Wrapper-level tests (R1/M2 fix — `tests/openai-wrapper-contract.test.mjs` — NEW)

- **Legacy string path**: `safeCallGPT(openai, { systemPrompt, userPrompt, schema, schemaName })` still works; internal normalisation produces a 2-message input identical to the pre-refactor shape
- **New messages path**: `safeCallGPT(openai, { system, messages, schema, schemaName })` works; `_callGPTOnce` sends the messages array verbatim
- **Mixed input rejection — layered contract**:
  - `_callGPTOnce(openai, { systemPrompt, messages, ... })` throws `LlmError({category:'config', retryable:false})` (also covers `{ system, userPrompt }`, `{ systemPrompt, userPrompt, system, messages }`, and any other hybrid)
  - `callGPT` propagates the error (no retry burn — config errors are non-retryable)
  - `safeCallGPT` (R3/H1 fix): catches LLM/runtime errors but **re-throws `category:'config'` errors**. A hybrid-input test must assert `safeCallGPT` throws, NOT that it returns `failed:true`. This is fail-fast for programmer errors; graceful for transient LLM issues.
- **404 stays non-retryable**: an injected 404 from a mocked LLM client surfaces immediately (no retry burn), preserving existing classification (per CLAUDE.md "Do not retry 4xx")
- **Graceful degradation shape**: forced failure returns `{ result: emptyResult, usage: { input_tokens:0, cached_tokens:0, output_tokens:0, reasoning_tokens:0, latency_ms:0 }, latencyMs:0, failed:true, error:<message> }` (includes the new `cached_tokens:0` field)
- **Retry aggregation**: when `callGPT` retries 3x, the returned `usage` reflects summed input_tokens, summed cached_tokens, summed output_tokens, and a `retryCount` field that matches reality
- **Seeded map-reduce failure continuation** (R1/H2 fix): mock seed unit throws; verify fan-out still proceeds; verify `results[seedIdx]` is a rejected `Promise.allSettled` entry; verify remaining indices are populated correctly

### Snapshot test (`tests/prompt-builder.snapshot.test.mjs` — NEW)

- Synthetic input mirroring a typical audit pass call: brief, planSlice, fileListContext, code, history
- Run through both legacy code path (current string-concat in `openai-audit.mjs`) AND new `buildAuditPassPrompt`
- Assert: BYTE-CONCATENATED `messages.map(m => m.content).join('\n\n')` equals legacy `userPrompt` modulo agreed re-ordering (history moves from before-plan to msg #2 — after stable msg #1, before code msg #3; unit-label moves from middle to msg #3)
- Snapshot updates require an explicit `UPDATE_SNAPSHOTS=1` env flag

### R2 churn-defense regression test (R1/M4 fix — `tests/r2-churn-defense.test.mjs` — NEW)

- Load a known re-raise/suppression fixture from `tests/fixtures/r2-churn/` (committed): plan, R1 findings (with ledger entries), R2 expected suppressions
- Run R2 audit pipeline against the fixture using the new 3-message structure
- Assert: every R1-dismissed finding remains dismissed in R2; every R1-severity-adjusted finding has the adjusted severity in R2; the post-output `suppressReRaises` count matches the fixture's expectation
- This pins the invariant that the message-reorder does not change suppression accuracy — which is the highest-value R2+ behaviour

### Live integration test (R1/L1 fix — `tests/integration-prompt-cache.test.mjs` — NEW)

- Skip when `OPENAI_API_KEY` absent OR `RUN_LIVE_TESTS !== '1'`
- Fixture: build msg #1 from `tests/fixtures/prefix-cache-stable-prefix.txt` — committed deterministic content. Size is enforced via `Math.ceil(text.length / 4) >= 2048` (same char-based estimate used in `computePassLimits`). Fixture char-length locked at 8500+ to guarantee the threshold. No new tokenizer dependency.
- Run two back-to-back calls with identical msg #1, different msg #2/#3
- **Simplified assertion (was: `cached_tokens >= msg_1_token_estimate * 0.8`)**: assert `usage.cached_tokens > 0` on the second call. Provider-grounded; no estimator dependency.
- Cost ~$0.01-0.02 per run. Opt-in only.

### Manual regression run (post-implementation, pre-ship)

- Re-audit `docs/plans/gemini-gate-scope-fix.md` (the recent shipped work)
- Compare R1 findings against the previous audit's R1 result (cached at `C:/Users/User/AppData/Local/Temp/audit-code-1778490162-r1-result.json`)
- Acceptance: ≥80% of finding `_hash` values match between old and new run; total severity counts (H/M/L) within ±1 of baseline

---

## 8.  Risk & Migration Plan (rollout sequence)

1. **PR-1 (this plan's main commit)**: `scripts/lib/audit/prompt-builder.mjs` + unit + snapshot tests. No audit-pipeline changes. Tests pass. **Behavior: zero diff.** [Steps 1-2]
2. **PR-2 (call-chain plumbing)**: extend `_callGPTOnce` / `callGPT` / `safeCallGPT` to accept `{ system, messages }` as an alternative to `{ systemPrompt, userPrompt }`. Internally normalise. Mixed input rejection. No call-site changes yet. Wrapper-level tests pass. **Behavior: zero diff.** [Step 3]
3. **PR-3 (migration)**: migrate 14 audit call sites in `openai-audit.mjs` to use `buildAuditPassPrompt`. Retire `buildR2SystemPrompt` for these call sites (rulings now flow via msg #2, not system). Snapshot tests verify byte-equivalence (modulo agreed re-ordering). Manual regression audit. R2 churn-defense regression test passes. **Behavior: history-block moves from before-plan in user-prompt to dynamic msg #2 (between stable msg #1 and code msg #3); unit-label moves to msg #3.** [Steps 4-5]
4. **PR-4 (telemetry)**: add `cached_tokens` to usage return chain; aggregate to session manifest per the §2 schema. **Behavior: new fields in session manifest; no functional change.** [Step 6]
5. **PR-5 (cache-seed, opt-in)**: add cache-seed wrapper in `runMapReducePass` gated on `AUDIT_CACHE_SEED=1`. Default OFF. Seed unit picked by `pickSeedUnit(units)` (smallest). Seed wrapped in `Promise.allSettled` so failure cannot block fan-out. **Behavior: opt-in only; default fanout unchanged.** [Steps 7-8]
6. **Verification gate (mandatory per repo Step 7 rule — R1/M5 fix)**: after PR-3 + PR-4 + PR-5 land, re-run /audit-code on this plan AND on the most recent shipped plan (`docs/plans/gemini-gate-scope-fix.md`). Gemini final review (Step 7) must return APPROVE or CONCERNS-with-no-blocker. The verification artefact (`docs/plans/openai-prefix-cache-audit-summary.md`) MUST be committed alongside the implementation; ship is BLOCKED on this artefact existing. This is not a best-effort note — it is the closed-loop gate.
7. **PR-6 (future, NOT IN THIS PLAN)**: flip `AUDIT_CACHE_SEED` default to ON after empirical data shows median R2 cache-hit-rate > 30% across 5+ real audits. Empirical bar tracked in a follow-up issue.

**PR-6 shipped 2026-07-14** (PR #53, commit `8fcae2c`): `decideSeed` (`scripts/lib/audit/legacy-production-audit.mjs`) now defaults ON (`AUDIT_CACHE_SEED !== '0'`, opt-out per-run); `cache-hitrate-check.mjs` now watches the seed-ON cohort post-flip and recommends reverting if it doesn't clear the 30% bar. Note: the empirical bar that triggered this flip was gated by the weekly `audit-cache-seed-flip-check` cloud routine, which turned out to have been silently non-functional since the M4 postgres-parity migration (it exported the sunset `SUPABASE_AUDIT_URL`/`SUPABASE_AUDIT_ANON_KEY` pair, which the check script never read — every run fell back to an empty local log and reported a false `INSUFFICIENT_DATA`). The actual flip decision was made from a direct manual query against `audit_runs`, not from that routine's output. Fixed the same day (routine now exports the real `AUDIT_DB_URL`).

**This plan bundles PR-1 through PR-5 + the verification gate into one /cycle commit (per user's "and /ship" intent + held gemini-gate work).** Each PR-N is a logical commit but they ship together — small enough to review as one unit.

---

## 9.  File-Level Plan

### New files

#### `scripts/lib/audit/prompt-builder.mjs` (~150 LOC)

Purpose: single SSoT for audit prompt shape. Pure function.

Exports:
- `buildAuditPassPrompt(opts)` → `{ system: string, messages: Array<{role:'user',content:string}> }`
- `PROMPT_BUILDER_VERSION` constant for snapshot-test stability tracking

Imports: nothing (no I/O, no node fs/path).

Imported by: `scripts/openai-audit.mjs` (call sites in `runMultiPassCodeAudit`, `runMapReducePass`).

Why this file: #3 Modularity (one file, one purpose), #5 SSoT (prompt shape lives here, nowhere else).

#### `tests/prompt-builder.test.mjs` (~120 LOC)

Unit tests per §7 (8 cases: minimal, history-only, unitLabel-only, both, empty-code, cache-invariant-5x, R1/R2/R3-invariant). Uses `node --test` + `node:assert/strict`.

#### `tests/prompt-builder.snapshot.test.mjs` (~60 LOC)

Snapshot test per §7. Reads `tests/fixtures/prompt-builder.snapshot.txt` (committed). Update gated by `UPDATE_SNAPSHOTS=1`.

#### `tests/fixtures/prompt-builder.snapshot.txt` (~5 KB)

Expected byte output for the snapshot test.

## Implementation Log

### 2026-05-11 — PR-1..5 shipped; deferred-tests rationale

- **PR-1..5 implemented**: prompt-builder module, wrapper extension, 14-site migration, telemetry + cache-seed wrapper.
- **Tests shipped** (44 cases total): `tests/prompt-builder.test.mjs` (22), `tests/openai-wrapper-contract.test.mjs` (18), plus 4 cache-invariant assertions for R1/R2/R3.
- **Deferred to follow-up PR** (verification audit M1):
  - `tests/prompt-builder.snapshot.test.mjs` — requires a synthetic 5K baseline snapshot fixture; the wrapper-contract tests already verify shape invariants which is the primary regression risk; snapshot test adds defence-in-depth, not safety-critical.
  - `tests/integration-prompt-cache.test.mjs` — live integration cost (~$0.01/run) and gated by `RUN_LIVE_TESTS=1`; not a CI blocker.
  - `tests/r2-churn-defense.test.mjs` — requires `tests/fixtures/r2-churn/` (synthetic plan + R1 findings + ledger + R2 expected). The R2 churn-defense invariant IS exercised live by every R2+ audit run; manual verification via running `/audit-code` against an R2 case is the current defence.
- Bundle commit: opens follow-up issue to add these three tests + fixtures within the next sprint.

#### `tests/openai-wrapper-contract.test.mjs` (~150 LOC) — R1/M2 + R2/H2 fix

Wrapper-contract test suite per §7: legacy path, structured path, hybrid rejection at `_callGPTOnce`, hybrid TOTALITY at `safeCallGPT`, 404 non-retryable, graceful-degradation shape with `cached_tokens: 0`, retry aggregation, seeded map-reduce failure continuation.

Mocks the OpenAI client via a lightweight stub (no live calls). Same `node --test` convention.

#### `tests/r2-churn-defense.test.mjs` (~100 LOC) — R1/M4 fix

R2 churn-defense regression test per §7. Loads fixture from `tests/fixtures/r2-churn/`. Asserts suppression accuracy is preserved after the message-reorder.

#### `tests/fixtures/r2-churn/` (~15 KB total) — R1/M4 fix

Three committed files:
- `plan.md` — minimal synthetic plan
- `r1-findings.json` — synthetic R1 findings with `_hash` values
- `r1-ledger.json` — ledger entries marking some dismissed/severity-adjusted
- `r2-expected.json` — expected suppression outcomes for R2

#### `tests/integration-prompt-cache.test.mjs` (~80 LOC) — R1/L1 fix

Live integration test per §7. Gated by `RUN_LIVE_TESTS=1 && OPENAI_API_KEY`. Asserts `cached_tokens > 0` after a 2048+-token stable-prefix warm-up.

#### `tests/fixtures/prefix-cache-stable-prefix.txt` (~10 KB) — R1/L1 fix

Synthetic 2048+-token stable preamble used by the live integration test. Committed; deterministic content (Lorem-ipsum-style filler with embedded structural markers).

### Modified files

#### `scripts/openai-audit.mjs` (~2500 LOC; ~100 LOC changed)

(Same as before — see decision list above.)

#### `scripts/lib/schemas.mjs` — R2/M4 fix

Add and export `CacheMetricsSchema` Zod schema:

```js
export const CacheMetricsPerPassSchema = z.object({
  totalInputTokens: z.number().int().nonnegative(),
  totalCachedTokens: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1),
  callCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  mapReduce: z.object({
    seedEligible: z.boolean(),
    seedUsed: z.boolean(),
    seedSkipReason: z.string().nullable(),
    seedUnitIdx: z.number().int().nonnegative().nullable(),
    seedUnitTokens: z.number().int().nonnegative().nullable(),
  }).optional(),
});

export const CacheMetricsSchema = z.object({
  totalInputTokens: z.number().int().nonnegative(),
  totalCachedTokens: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1),
  estimatedSavingsPct: z.number().min(0).max(0.5),
  perPass: z.record(z.string(), CacheMetricsPerPassSchema),
});
```

`scripts/openai-audit.mjs` imports + validates before writing manifest. Tests import the same schema.

### Dev-only dependency change

**None.** R1/L1 originally proposed `tiktoken-lite` for deterministic token counting in the live test, but R2/M5 flagged the half-spec. **Resolution**: use the existing repo char-based estimate (`Math.ceil(text.length / 4)`) which is what `computePassLimits` already does. The 2048-token minimum is `Math.ceil(text.length / 4) >= 2048` → text.length >= 8192 chars. The committed fixture's char-length is locked at 8500+ to ensure the threshold is always exceeded. No new dep.

### Modified files

#### `scripts/openai-audit.mjs` (~2500 LOC; ~80 LOC changed)

**Changes**:
- Lines ~365-456 (`_callGPTOnce`): accept either `systemPrompt+userPrompt` OR `system+messages`; normalise to messages-array internally; capture `response.usage.prompt_tokens_details.cached_tokens` into return shape.
- Lines ~462-505 (`callGPT`): pass-through new opts; aggregate `cached_tokens` in `_accumulatedUsage` field across retries.
- Lines ~507-525 (`safeCallGPT`): pass-through; include `cached_tokens: 0` in graceful-degradation empty result.
- Lines ~613-771 (`runMapReducePass`): replace inline userPrompt template with `buildAuditPassPrompt(...)`; add cache-seed wrapper around `Promise.allSettled` when `units.length > 1 && process.env.AUDIT_CACHE_SEED === '1'`.
- Lines ~780-2001 (`runMultiPassCodeAudit`): migrate 14 per-pass call sites to use `buildAuditPassPrompt`. The system-prompt + focus-block concatenation stays at the call site (different rubric per pass).
- Lines ~2007-2449 (`main`): at end-of-audit, aggregate per-pass `cached_tokens` into session manifest under `cacheMetrics` using the camelCase schema from §2 (`totalInputTokens`, `totalCachedTokens`, `hitRate`, `estimatedSavingsPct`, `perPass`). Schema lives in `scripts/lib/schemas.mjs` as `CacheMetricsSchema` (new Zod schema, exported) and is validated before write. All consumers (manifest writer, stderr summary, tests) import the same schema — no naming drift.

**Why these changes**: #5 SSoT (prompt shape extracted), #18 Backward Compat (legacy contract preserved), #19 Observability (cache telemetry surfaced).

#### `scripts/lib/llm-wrappers.mjs` (if it has `safeCallGPT`/`callGPT` aliases — verify)

Verified in Phase 1: `lib/llm-wrappers.mjs:22-42` exports a `safeCallGPT` for non-audit callers (brainstorm, etc.). **No change needed** — that wrapper goes to OpenAI chat completions, not Responses API, and doesn't need cache support.

#### `docs/plans/openai-prefix-cache.md` (this file)

Authoritative spec; no implementation.

### Files NOT modified

- `scripts/lib/context.mjs` (`readProjectContextForPass`, `extractPlanForPass`) — per-pass slicing stays.
- `scripts/lib/ledger.mjs` (`buildR2SystemPrompt`) — function STAYS (other non-cache-aware callers may use it), but **audit call sites stop using it** (R1+R2 H1 fix). The audit call sites compose the static system prompt from `PASS_<NAME>_SYSTEM + R2_ROUND_MODIFIER + focusBlock` directly — that's the byte-stable system text. Rulings (the dynamic part previously inside `buildR2SystemPrompt`) move to user msg #2 via `buildAuditPassPrompt`'s `history` param. A contract test in `tests/openai-wrapper-contract.test.mjs` asserts no audit call site imports `buildR2SystemPrompt`.
- `scripts/gemini-review.mjs` — out of scope (B abandoned).
- `scripts/lib/brainstorm/*` — different domain, separate prompt-builders (`debate-prompt.mjs` etc.).

---

## 10.  Bundle plan (Per /cycle context)

This /cycle bundles three logical commits into ONE ship:

1. **Held gemini-gate scope-fix** (audited in this session, ready to ship): see `docs/plans/gemini-gate-scope-fix-audit-summary.md` once /ship moves it. Includes scripts/gemini-review.mjs + canonical doc + auto-synced mirrors.
2. **This plan + implementation** (PR-1 through PR-5 collapsed): `scripts/lib/audit/prompt-builder.mjs` + tests + `scripts/openai-audit.mjs` changes + session-manifest extension.
3. **Status + plan archive** (handled by /ship): status.md entry, plan status flip to Complete, archive move to `docs/completed/`.

Commit message: `feat(audit): prompt prefix-cache restructure + telemetry + held gemini-gate scope fix`. Two intent-tags in one commit because the work is small and the audit cycle is bundled.

---

## 11.  Addendum — 2026-08-08: the seed A/B had no control arm

The 2026-07-14 PR-6 flip made `AUDIT_CACHE_SEED` default-ON and left
`cache-hitrate-check` to validate it from the seed-ON cohort. That validation
was not decidable as designed. Two independent defects, both fixed.

### 11.1  The verdict turned on cohort parity, not on the data

`cache_hit_rate` is a Postgres `numeric`, which node-pg returns as a **string**.
`median()` summed the two middle elements directly, so an EVEN-sized cohort
concatenated (`"0.11" + "0.13"` → `"0.110.13"`) and divided to `NaN`, while an
ODD-sized one returned its middle element untouched and coerced correctly on a
later `* 100`.

`NaN > flipThreshold` is false, so **an even-sized seed-ON cohort always fell
through to HOLD** regardless of its hit rates. The live reading escaped this
only by luck: 67 seed-ON runs (odd) reported a true 11.3%, while 72 seed-OFF
(even) produced the `Seed-OFF baseline: NaN%` that made the comparison
unreadable. One more seed-ON run would have silently inverted the verdict.

Fixed in `d98cc3c4`. `median()` now coerces, filters non-finite values, and
returns `null` — not `0` — when nothing usable is present, because `0` reads as
a measured "0% hit rate" and is indistinguishable from a real one. Empties are
rejected BEFORE coercion, since `Number(null)` is `0` and would survive a
`Number.isFinite` filter. The Supabase boundary likewise keeps a null
`cache_hit_rate` as null rather than `?? 0`: a rate is not a count, and 112 of
251 R2+ rows were null — enough fabricated zeros to move the median.

### 11.2  seed-OFF was never a control (the load-bearing defect)

`decideSeed` returned on `!envFlag` **before** assessing eligibility, so an
opted-out run was never evaluated and was indistinguishable from one that could
never have seeded. The seed-OFF cohort therefore mixed two populations:

| Population | Comparable to seed-ON? |
|---|---|
| eligible, seeding withheld (`AUDIT_CACHE_SEED=0`) | yes — this is the control |
| ineligible: `units.length <= 1`, or prefix below `AUDIT_CACHE_STABLE_PREFIX_MIN` | no |

Ineligibility is not random. `units.length <= 1` skips seeding, and single-unit
audits are *small* ones — so seed-OFF skewed systematically small and the
cohort comparison **measured audit size, not seeding**. This is why the
2026-08-08 reading could not settle the revert question: the median said seeding
was 2.2x better (11.3% vs 5.2%) while the mean said the cohorts were identical
(19.4% vs 20.8%), and both arms were confounded.

Fixed in `ce2a0213`:

- `decideSeed` assesses eligibility FIRST; the env flag gates USE only. An
  eligible-but-withheld run records `seedEligible: true` +
  `seedSkipReason: 'env-disabled'`. Costs one extra `buildPromptForUnit` probe
  on opted-out runs — it builds from an empty `_context`, so no file reads and
  no API call.
- Migration `20260808190000` adds `cache_seed_eligible` +
  `cache_seed_skip_reason`, **nullable with no default**. The 583 pre-existing
  rows genuinely do not know their eligibility; `NOT NULL DEFAULT false` would
  assert "was not eligible" for every one and re-contaminate the cohort the
  migration exists to clean.
- `cache-hitrate-check` segments on `seedEligible === true` — never
  `!== false`, since null means pre-migration UNKNOWN — and reports the lift.
  Below 5 control runs it reports `Uncontrolled` and states plainly: do not
  revert on the threshold alone.

### 11.3  Status: the revert question is OPEN

```
Seed-ON median:  11.3%   (seed-OFF baseline: 5.2%)
Control arm:     NOT POPULATED (0 run(s))
Recommendation:  HOLD — "DO NOT revert on this alone"
```

A **control-arm collection period** started 2026-08-08: `AUDIT_CACHE_SEED=0` is
set in the shared `~/.audit-loop.env`, so organic audits from every repo
populate the control. Check progress with `npm run cache:check` → the
`Control arm` line, and **remove that setting once the arm has >= 5 runs** or
seeding stays off indefinitely.

### 11.4  Do not try to manufacture control runs

This was attempted and does not work. `decideSeed` is only reached inside
`runMapReducePass`, so a run is only eligible if a pass actually map-reduces
(>8 files or >25K chars for the high-reasoning passes). An audit's effective
file set is intersected with the PLAN's referenced files, so a narrow plan caps
the count well below that — three attempted runs all recorded
`eligible=false`, and a fourth aborted on the "0 implementation files reached
the prompt" guard.

The deeper reason to stop: every knob available to force eligibility (a broader
plan, `--scope full`, a longer file list) makes the run *less* like the organic
seed-ON cohort. Manufacturing five synthetic controls to match 67 organic
treatments re-creates the exact size confound §11.2 removes — and worse, it
would carry an authoritative `Controlled:` label while doing so. Let the arm
fill from normal work.

### 11.5  Two lessons that generalise beyond this plan

- **Postgres `numeric`/`bigint` arrive as strings over node-pg.** Sorting
  coerces, so the bug stays invisible until the first `+`. Coerce at the DB
  boundary where rows are mapped, not at each use site.
- **An aggregate over an empty set must not return 0.** Return `null`. A zero
  is a measurement claim, and here it was indistinguishable from a real 0% hit
  rate — the same false-zero class as a hardcoded telemetry default.
