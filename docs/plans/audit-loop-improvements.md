# Plan: Audit-Loop Reliability & Intelligence Improvements
- **Date**: 2026-04-15
- **Status**: Complete (shipped — reliability + intelligence improvements landed across `scripts/openai-audit.mjs` (P0 reduce fallback via `safeCallGPT`), `scripts/lib/robustness.mjs` (LlmError + classifyLlmError), `scripts/lib/ledger.mjs` (suppressReRaises + R2+ buildRulingsBlock), `scripts/lib/file-io.mjs` (atomic ledger writes), `scripts/lib/code-analysis.mjs` (greedy bin-packing buildAuditUnits). All R1 + Gemini G1-G4 fixes integrated. Status line corrected 2026-05-23 from "Approved (R1 + Gemini G1-G4 fixes applied)".)
- **Author**: Claude + Louis

---

## 1. Context Summary

### What Exists Today

The audit-loop is a 3-model pipeline (Claude → GPT-5.4 → Gemini) with:

- **`scripts/openai-audit.mjs`** — 5-pass parallel code auditor with map-reduce architecture
- **`scripts/gemini-review.mjs`** — final Gemini 3.1 Pro / Claude Opus adjudicator
- **`scripts/audit-loop.mjs`** — CLI orchestrator (multi-round loop, convergence check, debt step)
- **`scripts/lib/robustness.mjs`** — `resolveLedgerPath()`, `buildReducePayload()`, error classes
- **`scripts/lib/ledger.mjs`** — `suppressReRaises()`, `buildRulingsBlock()`, ledger write/upsert
- **`scripts/lib/file-io.mjs`** — `readFilesAsAnnotatedContext()` with `// ── CHANGED ──` markers
- **`scripts/lib/code-analysis.mjs`** — `buildAuditUnits()` for greedy bin-packing into map units
- **`scripts/lib/schemas.mjs`** — Zod schemas, single source of truth for all result contracts

### Existing Patterns Already In Use

| Pattern | Location | Relevance |
|---------|----------|-----------|
| `safeCallGPT()` — graceful degradation on LLM failure | `openai-audit.mjs:502` | P0 reduce fallback |
| `atomicWriteFileSync()` — crash-safe writes | `file-io.mjs:15` | P0 ledger writes |
| `LlmError` + `classifyLlmError()` — structured errors | `robustness.mjs:23` | P0 error classification |
| `// ── CHANGED ──` / `// ── END CHANGED ──` markers | `file-io.mjs:198` | P1 scope leakage |
| `buildReducePayload()` — budget-safe JSON for reduce | `robustness.mjs:55` | P0 reduce repair |
| `buildAuditUnits()` — file count bin-packing | `code-analysis.mjs:200` | P1 frontend MAP |
| `.audit/session-ledger.json` — deterministic ledger | `audit-loop.mjs:165` | P0 ledger path |
| `proper-lockfile` — concurrent write safety | `debt-ledger.mjs` | P0/P2 state files |

### What is New vs Reused

- **P0 reduce repair**: extend `robustness.mjs` (add `ReduceStatus` enum + bracket-balance repair) and `runMapReducePass()` — no new files
- **P0 ledger guard**: session manifest in `.audit/`, extend `resolveLedgerPath()`, preflight in `openai-audit.mjs`
- **P1 diff markers**: enhance `readFilesAsAnnotatedContext()` — additive, transport-neutral boundary syntax
- **P1 MAP sizing**: add `maxFilesPerUnit` + `computePassLimits(minTokens)` — all within existing modules
- **P2 debt trigger**: consolidate run counter into session ledger metadata, add `--debt-review` flag
- **P2 plan FP index**: new module `scripts/lib/plan-fp-tracker.mjs` with defined triage capture workflow
- **P2 Phase 7**: new module `scripts/lib/predictive-strategy.mjs` — priority/sizing only, no pass skipping by default

---

## 2. Proposed Architecture

### P0-A: Reduce-Step Failure Detection and Fallback

**Problem**: When the REDUCE phase fails (parse error, timeout, or model error), findings from successful MAP units are silently discarded. The root cause is ambiguous: `safeCallGPT` uses `EMPTY_SUSTAIN = { findings: [] }` from the call site in `runMultiPassCodeAudit`, not `{ findings: allFindings }` — so the MAP findings are only preserved inside `runMapReducePass` itself. Additionally, the fallback currently triggers on `reducedFindings.length === 0` which conflates a legitimate "reduce succeeded but all findings were deduplicated" outcome with a failure.

**Fix A1 — Explicit `ReduceStatus` enum** (in `robustness.mjs`):

```js
/** Explicit reduce execution status — avoids conflating success-with-zero vs failure. */
export const ReduceStatus = Object.freeze({
  OK: 'ok',
  PARSE_ERROR: 'parse_error',
  TIMEOUT: 'timeout',
  MODEL_ERROR: 'model_error',
  BUDGET_EXCEEDED: 'budget_exceeded',
  SKIPPED: 'skipped',
});
```

`runMapReducePass()` sets `_reduceStatus` on the returned object from the actual error classification rather than inferring it from finding count.

**Fix A2 — Bracket-balance JSON repair** (in `robustness.mjs`):

Replace the brittle suffix-guessing approach with a deterministic bracket-balance algorithm that walks the raw string and closes any open brackets/strings:

```js
/**
 * Attempt to repair truncated JSON by closing open brackets/strings.
 * Deterministic: walks the raw string tracking open structures.
 * Never fabricates content — only closes open brackets and quotes.
 * @param {string} raw - Possibly truncated JSON string
 * @returns {{ ok: boolean, result?: object, repaired?: boolean, error?: string }}
 */
export function tryRepairJson(raw) {
  // Fast path — already valid
  try { return { ok: true, result: JSON.parse(raw) }; } catch {}

  // Balance-aware repair: close open strings, arrays, objects in reverse order
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const ch of raw) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // Close open string, then close open structures in reverse
  // G4 fix: trailing backslash would escape the closing quote — remove it
  // G1 fix: trailing comma before closing brackets produces invalid JSON — strip it
  let repaired = raw.trimEnd()
    .replace(/,\s*$/, '');  // strip trailing comma (e.g. `[{...},` → `[{...}`)
  if (inString) {
    if (escaped) repaired = repaired.slice(0, -1); // remove trailing '\'
    repaired += '"';
  }
  while (stack.length > 0) repaired += stack.pop();

  try {
    const result = JSON.parse(repaired);
    return { ok: true, result, repaired: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
```

**Fix A3 — Status-gated MAP fallback in `runMapReducePass()`**:

```js
// After safeCallGPT returns:
const reduceStatus = reduceResult._reduceStatus ?? ReduceStatus.OK;
const reducedFindings = reduceResult.result?.findings ?? [];

if (reduceStatus !== ReduceStatus.OK && allFindings.length > 0) {
  // Reduce failed with an explicit status — preserve MAP findings
  process.stderr.write(
    `  [${passName}] REDUCE failed (${reduceStatus}) — preserving ${allFindings.length} raw MAP findings\n`
  );
  return {
    result: {
      pass_name: passName,
      findings: normalizeFindingsForOutput(allFindings),
      quick_fix_warnings: [],
      summary: `REDUCE failed (${reduceStatus}) — ${allFindings.length} raw findings preserved`,
      _executionMeta: { reduceStatus, reduceSkipped: true },
    },
    usage: { ...mapUsage, latency_ms: Date.now() - mapStart },
    latencyMs: Date.now() - mapStart,
  };
}
// reduceStatus === OK but zero findings is legitimate dedup — do NOT fall back
```

**Fix A4 — Repair attempt in `_callGPTOnce()`**: When `output_parsed` is null despite `status: 'complete'`, attempt `tryRepairJson()` on the raw response text before throwing `LlmError`. This is the transport boundary where the repair is most appropriate.

**Schema contract** (Fix for H2 — addressed in §4.1 schemas.mjs):
`_executionMeta` is added to the `CodeAuditResultSchema` in `schemas.mjs` as the single source of truth. All pass results carry this field.

**Principles applied**: #12 Defensive Validation (status-gated, not count-gated), #15 Consistent Error Handling (ReduceStatus enum, not ad-hoc strings), #16 Graceful Degradation, #10 SSOT (schema first).

---

### P0-B: Session-Manifest Ledger Identity

**Problem**: The ledger path is derived from the `--out` temp file path, which changes with every new process PID. When R2 starts in a new process, the skill must re-discover the R1 ledger path — but there is no canonical session record.

**Root cause**: Ledger identity is coupled to process-scoped temp paths. The fix in `resolveLedgerPath()` to fall back to `.audit/session-ledger.json` when `round >= 2` and no `outFile` helps when called from `audit-loop.mjs`, but does NOT help when called from the skill orchestrator (which always passes `--out` to a new temp path).

**Fix — SID-scoped session manifest** (`.audit/session-{sid}.json`):

Written atomically in R1 by `audit-loop.mjs` when it establishes the SID. Contains:

```json
{
  "sid": "audit-1744753200",
  "ledgerPath": ".audit/session-ledger.json",
  "startedAt": "2026-04-15T12:00:00.000Z",
  "round": 1
}
```

**G2 fix — SID-scoped, not singleton**: Using `session-{sid}.json` instead of `current-session.json` eliminates concurrent session collisions (CI environments, parallel feature branches). Each session has its own manifest file keyed by SID. Old manifest files are cleaned up after 24h.

In R2+, `resolveLedgerPath()` requires the SID to be passed via the new `--session-id <sid>` flag (or via `AUDIT_SESSION_ID` env var). It reads `.audit/session-{sid}.json` to recover the ledger path. The skill orchestrator captures the SID from R1 output (`result._sid`) and passes it to R2.

**Fallback chain** (when `--session-id` not provided): → `.audit/session-ledger.json` → null (warn)

**G2-extended fix — Move session init to `openai-audit.mjs`**: The skill orchestrator bypasses `audit-loop.mjs` and calls `openai-audit.mjs` directly. Session manifest creation and debt counter initialization must happen inside `openai-audit.mjs`, not `audit-loop.mjs`. Specifically:
- `openai-audit.mjs` writes `.audit/session-{sid}.json` at the end of R1 (after the ledger is created)
- `openai-audit.mjs` increments `meta.runsSinceDebtReview` in `.audit/session-ledger.json` at the end of each run
- `audit-loop.mjs` does NOT duplicate this logic — it reads `_sid` from the R1 result and passes it as `--session-id` to R2

**G1 fix — Stable metadata persistence with locking** (also addresses M4):

The `meta` block (`runsSinceDebtReview`, `totalRuns`) lives exclusively in `.audit/session-ledger.json` — it is NEVER written to the temp findings ledger.

`batchWriteLedger()` gains a `targetMetaPath` option. When set, it locks `.audit/session-ledger.json` via `proper-lockfile` (stale: 10000ms), reads the existing meta, merges the new meta values, and atomically writes back. This provides both crash-safety AND concurrent write isolation:
- `atomicWriteFileSync` prevents corrupt file content on crash
- `proper-lockfile` prevents lost updates when two processes race on read-modify-write

**Preflight guard** — `validateLedgerForR2(ledgerPath, round)` in `openai-audit.mjs`:

```js
function validateLedgerForR2(ledgerPath, round) {
  if (round < 2) return { valid: true };
  if (!ledgerPath) {
    process.stderr.write('  [ledger] WARNING: R2 started with no ledger — running without suppression\n');
    return { valid: false, suppressionUnavailable: true };
  }
  if (!fs.existsSync(ledgerPath)) {
    process.stderr.write(`  [ledger] WARNING: Ledger not found at ${ledgerPath} — running without suppression\n`);
    return { valid: false, suppressionUnavailable: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    if (!raw.entries || !Array.isArray(raw.entries)) throw new Error('missing entries array');
    process.stderr.write(`  [ledger] R2 ledger valid — ${raw.entries.length} prior entries\n`);
    return { valid: true, entryCount: raw.entries.length };
  } catch (err) {
    process.stderr.write(`  [ledger] WARNING: Ledger corrupted (${err.message}) — running without suppression\n`);
    return { valid: false, suppressionUnavailable: true };
  }
}
```

**Output flag**: `_suppressionUnavailable: true` added to result `_executionMeta` (same schema block as P0-A). In `audit-loop.mjs`, a round where `_suppressionUnavailable: true` does NOT increment `stableCount`.

**Convergence guard**: `isConverged()` in `audit-loop.mjs` receives the full result; if `result._executionMeta?.suppressionUnavailable` is true, return false regardless of finding counts.

**Principles applied**: #10 SSOT (SID-scoped manifest per session; meta always in stable ledger), #12 Defensive Validation, #8 No Hardcoding (constants in `robustness.mjs`), #13 Idempotency (manifest write is SID-keyed, not singleton).

---

### P0-C: `executionMeta` Schema Block (SSOT for H2)

**G3 clarification**: `CodeAuditResultSchema` is defined in `openai-audit.mjs` (line ~258), not in `schemas.mjs`. `PlanAuditResultSchema` is also in `openai-audit.mjs`. These remain where they are — they are implementation-internal schemas for that script. What IS added to `schemas.mjs` is `ExecutionMetaSchema` alone, which is then imported by `openai-audit.mjs` and added to the existing schemas there. `schemas.mjs` is the SSOT for the meta schema definition, not for the full result schemas.

`ExecutionMetaSchema` in `schemas.mjs`:

```js
const ExecutionMetaSchema = z.object({
  reduceStatus: z.enum(['ok', 'parse_error', 'timeout', 'model_error', 'budget_exceeded', 'skipped']).optional(),
  reduceSkipped: z.boolean().optional(),
  suppressionUnavailable: z.boolean().optional(),
  passesSkipped: z.array(z.string()).optional(),      // for Phase 7 predictions
  predictionUsed: z.boolean().optional(),             // for Phase 7
}).optional();
```

This is the single schema source. `_reduceFailed` and `_suppressionUnavailable` are replaced by this typed block everywhere they appear. No ad-hoc boolean flags at the result top level.

---

### P1-A: Transport-Neutral Boundary Markers for Diff-Scope Enforcement

**Problem**: `readFilesAsAnnotatedContext()` marks changed regions with `// ── CHANGED ──` but unchanged code between hunks has no visual signal. GPT drifts to auditing surrounding context.

**H5 fix applied**: The current `// ── CHANGED ──` approach uses language-specific comment syntax, which is invalid in JSON, YAML, Markdown, HTML, and binary formats. A transport-neutral approach is required.

**Fix — Transport-neutral boundary envelope**:

Rather than injecting language comment syntax into the file content, wrap the entire file block in an envelope with explicit boundary annotations in the surrounding prose. Each file block becomes:

```
### path/to/file.js [CHANGED] — Review ONLY the CHANGED sections below
\`\`\`js
[unchanged code]
// ━━━━ UNCHANGED CONTEXT — DO NOT FLAG ━━━━
[unchanged code block]
// ━━━━ END UNCHANGED CONTEXT ━━━━
// ── CHANGED ──
[changed hunk]
// ── END CHANGED ──
// ━━━━ UNCHANGED CONTEXT — DO NOT FLAG ━━━━
[remaining unchanged code]
// ━━━━ END UNCHANGED CONTEXT ━━━━
\`\`\`
```

> **Corrected 2026-07-26 — markers are LINE comments, never block comments.**
> This section originally specified `/* … */` block-comment markers, and that is
> what shipped. It was wrong. A git hunk boundary routinely lands *inside* a
> file-level JSDoc block (git's leading context lines start mid-comment whenever
> the first change is near the top of a file), so the marker's closing delimiter
> closed the JSDoc early and the file's real one became a stray token — the
> annotated payload handed to the auditor was genuinely invalid JavaScript, and
> `node --check` rejected it. It cost a HIGH `[Sustainability] Syntax error`
> finding against a file that parses cleanly and runs 119 green tests. A `//`
> marker landing inside a block comment is inert: it degrades to plain text
> instead of corrupting the parse. Invariant now enforced by
> [`tests/diff-annotation-marker-safety.test.mjs`](../../tests/diff-annotation-marker-safety.test.mjs)
> ("no marker contains a block-comment close delimiter"). Note the CHANGED pair
> shown above also differs from this section's original `/* ━━━━ CHANGED ━━━━ */`
> — the implementation has always used line comments there.

**For non-JS/TS files** where block comment syntax is invalid (JSON, YAML, Markdown, plain text): use a **line-numbered margin + header** approach. GPT cannot follow `[CHANGED — LINES 45-52]` in a header without visible line numbers in the content. Instead:

1. Inject line numbers into the left margin of every line: `45 | "key": "value"`
2. Keep the `[CHANGED — LINES 45-52]` header annotation so GPT has both the line range and the ability to count

```
### path/to/config.json [CHANGED — LINES 45-52 AND 88-94 — REVIEW ONLY THESE LINES]
\`\`\`json
 44 |   "oldKey": "value",
 45 |   "newKey": "updatedValue",
...
 52 |   "anotherKey": "value",
 53 |   "unchanged": true,
```

Line numbers are added via a `numberLines(content, startLine)` utility in `file-io.mjs`. The margin is 4 chars wide (`%4d |`) — minimal overhead, fits within the 10K char per-file budget.

**Scope**: Line numbering is ONLY added to non-code files that have diff hunks. JS/TS/Python/etc. use inline block-comment markers instead (they already have `// ── CHANGED ──` syntax and don't need line numbers).

**Language routing** (in `readFilesAsAnnotatedContext()`):
- JS/TS/CSS/Python/Go/Rust/Java/Ruby/Shell: inline `/* ━━ */` markers (profile-appropriate comment style)
- JSON/YAML/Markdown/HTML: header-only annotation listing changed line ranges

**Principles applied**: #12 Defensive Validation (no corrupt file content), #2 Single Responsibility (annotation logic centralized in `readFilesAsAnnotatedContext`), #8 No Hardcoding (routing via language profile, not switch statement).

---

### P1-B: Size-Aware MAP Units with Unified Budget Ownership

**Problem**: `buildAuditUnits()` uses file-count bin-packing but doesn't enforce a per-unit file cap. Large files saturate units and cause timeouts. The `computePassLimits()` reduce budget floor is unspecified and unowned.

**Fix B1 — `maxFilesPerUnit` parameter** in `code-analysis.mjs`:

```js
export function buildAuditUnits(files, maxTokensPerUnit = 30000, maxFilesPerUnit = Infinity) {
  // In bin-packing loop:
  const shouldSplit = (current.tokens + file.tokens > maxTokensPerUnit
                    || current.files.length >= maxFilesPerUnit)
                   && current.files.length > 0;
  if (shouldSplit) { units.push(current); current = { files: [], tokens: 0 }; }
  ...
}
```

**M2 clarification — single-file oversized handling is already implemented**: `buildAuditUnits()` (lines 218-228 of `code-analysis.mjs`) already handles files that exceed `maxTokensPerUnit` individually: they are chunked by `chunkLargeFile()` into separate units each. This existing behavior is preserved and not regressed. The `maxFilesPerUnit` parameter is an ADDITIVE constraint on top of the existing token-based splitting — it does not replace single-file chunking.
```

**Fix B2 — `minTokens` parameter for `computePassLimits()`** (owned by `robustness.mjs`):

```js
/**
 * @param {number} contextChars
 * @param {string} reasoning
 * @param {number} [minTokens=0] - Floor for maxTokens (prevents reduce starvation)
 */
export function computePassLimits(contextChars, reasoning = 'high', minTokens = 0) {
  ...
  const maxTokens = Math.min(MAX_OUTPUT_TOKENS_CAP,
    Math.max(minTokens, baseOutputTokens + reasoningOverhead)
  );
  ...
}
```

`computePassLimits` is already in `robustness.mjs` (it was moved there during the lib split). The `minTokens` param is added there. All callers pass it explicitly when they need a floor (reduce calls pass `minTokens: 10000`).

**Wire in config** (in `config.mjs`):

```js
frontendMaxFilesPerUnit: safeInt(process.env.OPENAI_AUDIT_FRONTEND_MAX_FILES_PER_UNIT, 4),
backendMaxFilesPerUnit: safeInt(process.env.OPENAI_AUDIT_BACKEND_MAX_FILES_PER_UNIT, 6),
reduceMinTokens: safeInt(process.env.OPENAI_AUDIT_REDUCE_MIN_TOKENS, 10000),
```

**Frontend reduce timeout floor**: In `runMapReducePass()`, for frontend/backend passes, set `reduceLimits.timeoutMs = Math.max(reduceLimits.timeoutMs, 240000)` (up from 180s).

**Principles applied**: #7 Modularity, #8 No Hardcoding, #10 SSOT (`computePassLimits` owns all budget math), #17 N+1 prevention (fewer retries = lower cost).

---

### P2-A: Debt Resolution Periodic Trigger

**Problem**: 23 debt items captured, 0 resolved. The trigger fires only when `entries.length >= 5 AND (recurring >= 2 OR clusters >= 2 OR violations > 0)` — too specific. Run counter should live in the existing session ledger metadata, not a new file.

**Fix — Consolidate into session ledger metadata** (addresses M3):

The `.audit/session-ledger.json` already has a `version` field and `entries` array. Add a `meta` block:

```json
{
  "version": 1,
  "meta": {
    "runsSinceDebtReview": 7,
    "lastDebtReviewAt": "2026-04-10T09:00:00.000Z",
    "totalRuns": 63
  },
  "entries": [...]
}
```

This is ONE file for session state, written via `batchWriteLedger()` which already performs an atomic read-modify-write.

**Fix — `--debt-review` flag** and `forceDebtReview` logic in `audit-loop.mjs`:

```js
const ledgerData = readLedgerMeta(ledgerFile);  // reads meta block
const forceDebtReview = args.debtReview || (ledgerData.meta?.runsSinceDebtReview ?? 0) >= 10;
```

After each round, `runsSinceDebtReview` is incremented via `batchWriteLedger` meta update. After Step 8 runs, reset to 0.

**Debt age surfacing**: `debt-review.mjs` receives `--sort-by-age` flag; entries are sorted by `capturedAt` ascending before display.

**Concurrency** (addresses M4): The `meta` block is updated within the existing `batchWriteLedger()` read-modify-write cycle, which already uses `atomicWriteFileSync()`. No separate file, no separate lock needed.

**Principles applied**: #1 DRY (no `debtReviewMeta.json`), #13 Idempotency, #14 Transaction Safety.

---

### P2-B: Plan-Finding Similarity Index with Defined Triage Workflow

**Problem**: `PlanFpTracker.recordOutcome()` has no defined input path — outcomes are never captured, so the tracker never learns.

**Fix — Explicit triage capture workflow**:

After each plan audit triage (in the SKILL.md orchestration and in `audit-loop.mjs` plan mode), outcomes are written via a new CLI entry point `scripts/write-plan-outcomes.mjs`:

```bash
node scripts/write-plan-outcomes.mjs \
  --result /tmp/$SID-r1-result.json \
  --outcomes '[{"id":"H1","action":"fix-now"},{"id":"M3","action":"dismiss"}]'
```

This script:
1. Loads `PlanFpTracker` from `.audit/plan-fp-patterns.json`
2. For each finding in `--result`, looks up outcome in `--outcomes` JSON
3. Calls `tracker.recordOutcome(finding.category + ' ' + finding.detail, outcome.action)`
4. Saves tracker (atomic write via `atomicWriteFileSync`)

**Wire in `openai-audit.mjs` plan mode**: After GPT returns findings, load `PlanFpTracker` and call `shouldSuppress()` on each finding. Log suppressed findings to stderr. The tracker is loaded from the path in `AUDIT_DIR` — if file doesn't exist (first run), tracker has no patterns and suppresses nothing.

**Concurrency** (addresses M4): `PlanFpTracker.save()` uses `atomicWriteFileSync` + `proper-lockfile` with `stale: 10000ms` timeout, same pattern as `debt-ledger.mjs`.

**Persistence**: `.audit/plan-fp-patterns.json` (local gitignored). Supabase sync deferred until local version proves useful.

**Principles applied**: #10 SSOT (one write path via `write-plan-outcomes.mjs`), #11 Testability, #1 DRY (reuses `jaccardSimilarity`).

---

### P2-C: Phase 7 Predictive Strategy — Priority/Sizing Only

**H5 fix applied**: Pass skipping from predictions is dangerous. Historical HIGH-finding absence doesn't mean a pass won't find issues — new bug classes, new files, architectural changes all defeat the prediction. Predictions must only guide **priority ordering** and **unit sizing**, never pass elimination.

**Default behavior** (pass skip = off):
- `rankFilesByRisk()` reorders files within each pass — highest-risk files go into their own MAP unit
- `recommendUnitSize()` adjusts `maxTokensPerUnit` per file based on historical complexity
- `predictActivePasses()` returns confidence scores but does NOT skip passes

**Explicit opt-in skip** (gated by `--predictive-skip` flag):
- Only skip a pass when: `--predictive-skip` is set AND confidence ≥ 0.95 AND last 20 runs for this repo found 0 HIGH findings in that pass AND the diff touches no file historically associated with HIGH findings
- Skipped passes are recorded in `_executionMeta.passesSkipped` (schema from P0-C)
- Convergence check treats a prediction-skipped round as non-authoritative for skipped passes

**New module `scripts/lib/predictive-strategy.mjs`**:

```js
export class PredictiveStrategy {
  async load(store) { /* 5s timeout; no-op if unavailable */ }
  
  predictActivePasses(repoId, diffStats) {
    /* Returns Map<passName, {confidence: 0-1, recommendSkip: boolean}> */
    /* recommendSkip is only true when all skip criteria are met */
  }
  
  rankFilesByRisk(files, passName, repoId) {
    /* Returns files sorted by predicted HIGH-finding probability */
  }
  
  recommendUnitSize(files, passName) {
    /* Returns maxTokensPerUnit override based on historical timeout rate */
  }
}
```

**Graceful degradation**: If Supabase is unavailable or load times out, `PredictiveStrategy` methods return safe defaults (all passes recommended, original file order, default unit size).

**Principles applied**: #3 Open/Closed, #16 Graceful Degradation, #20 Long-Term Flexibility.

---

## 3. Sustainability Notes

### Assumptions that could change

| Assumption | Risk | Mitigation |
|-----------|------|-----------|
| GPT-5.4 `responses.parse()` API unchanged | Medium | `_callGPTOnce` is isolated; swap at one site |
| `.audit/` is writable and persisted between R1 and R2 | Low | `mkdirSync(recursive: true)` handles creation; session manifest provides cross-process identity |
| Jaccard similarity at 0.35 threshold stays calibrated | Medium | `SUPPRESS_SIMILARITY_THRESHOLD` env var already configurable |
| Supabase schema doesn't change for predictive strategy | Low | Store is gated by `isCloudEnabled()`, graceful fallback exists |
| Non-JS file types don't change comment syntax | Low | Language routing uses profile registry; adding a new profile doesn't require code changes |
| `proper-lockfile` TTL (10s) is sufficient | Low | Same setting already used in `debt-ledger.mjs` |

### Extension points deliberately built in

- `ReduceStatus` is an enum — new status values are additive
- `tryRepairJson()` is pure — callers can extend without modifying core logic  
- `buildAuditUnits(maxFilesPerUnit)` is additive — existing callers unaffected
- `PredictiveStrategy` is a class with injectable store — testable with mock store
- `ExecutionMetaSchema` fields are all optional — new fields don't break existing readers
- Session manifest is a simple JSON file — any new session-scoped state can be added to `meta`

### What we're NOT doing (and why)

- **Not replacing `safeCallGPT`** — graceful degradation pattern is correct; fix is status-aware gating on top of it
- **Not streaming in Claude Opus fallback** — the R12 "streaming requirement" error was a one-off proxy issue, not a code bug. No evidence of recurrence. Monitor.
- **Not cross-repo plan finding suppression** — `PlanFpTracker` local first, cloud sync deferred
- **Not adding plan mode to `audit-loop.mjs` multi-round** — plan mode is single-round by design

---

## 4. File-Level Plan

### 4.1 `scripts/lib/schemas.mjs` (MODIFY — H2/P0-C)

**What changes**:
- Add and export `ExecutionMetaSchema` (typed block: `reduceStatus`, `suppressionUnavailable`, `passesSkipped`, `predictionUsed`)
- Export `ReduceStatus` string literals (matching `ExecutionMetaSchema.reduceStatus` enum values)

**What does NOT move here**: `CodeAuditResultSchema` and `PlanAuditResultSchema` remain in `openai-audit.mjs` — they are implementation-internal. `openai-audit.mjs` imports `ExecutionMetaSchema` from `schemas.mjs` and adds it as `.extend({ _executionMeta: ExecutionMetaSchema })` to both schemas.

**Why this file**: SSOT for the meta schema definition. Full result schemas are private to the auditor script.

---

### 4.2 `scripts/lib/robustness.mjs` (MODIFY — P0-A, P0-B, P1-B)

**What changes**:
- Add `tryRepairJson(raw)` — bracket-balance algorithm (pure function, no side effects)
- Add `ReduceStatus` object constant (matches `ExecutionMetaSchema` enum)
- Add `AUDIT_DIR = '.audit'`, `SESSION_LEDGER_FILE = 'session-ledger.json'`, `SESSION_MANIFEST_PREFIX = 'session-'` constants
- Modify `resolveLedgerPath()`: when `round >= 2` and no explicit ledger, read `.audit/session-{sid}.json` (SID from `--session-id` or `AUDIT_SESSION_ID` env); if no SID, fall back to `.audit/session-ledger.json`
- Add `computePassLimits(contextChars, reasoning, minTokens = 0)` — add `minTokens` floor parameter (non-breaking)

**Note**: `computePassLimits` is currently in `openai-audit.mjs` (not yet in `robustness.mjs`). Move it to `robustness.mjs` as part of this change to give it a single owner. Import it back in `openai-audit.mjs` from `robustness.mjs`.

**Why this file**: SSOT for robustness constants, ledger path logic, and budget math.

---

### 4.3 `scripts/openai-audit.mjs` (MODIFY — P0-A, P0-B, P1-B, P2-B)

**What changes**:

**P0-A**: In `runMapReducePass()`, replace count-gated fallback with status-gated fallback using `ReduceStatus`. Wire `tryRepairJson()` into `_callGPTOnce()` for null `output_parsed` recovery.

**P0-B**: Add `validateLedgerForR2(ledgerPath, round)` (pure, 25 lines). Call in `runMultiPassCodeAudit()`. Set `_executionMeta.suppressionUnavailable: true` on output when validation fails.

**P1-B**: Change `buildAuditUnits()` call sites for frontend/backend passes to pass `openaiConfig.frontendMaxFilesPerUnit` / `openaiConfig.backendMaxFilesPerUnit`. Update reduce `computePassLimits()` call to pass `openaiConfig.reduceMinTokens`. Increase frontend reduce timeout floor to 240s.

**P0-B (session manifest + meta — G2 fix)**: At end of R1 in `runMultiPassCodeAudit()`:
- Write `.audit/session-{sid}.json` (SID-scoped manifest with ledger path)
- Increment `meta.runsSinceDebtReview` in `.audit/session-ledger.json` via `batchWriteLedger(targetMetaPath)` with proper-lockfile
- Set `result._sid = sid` for caller pickup

**P2-B**: In `runPlanAudit()`, load `PlanFpTracker` from `.audit/plan-fp-patterns.json`. Call `shouldSuppress()` on each finding before returning. Log filtered count.

**Import `computePassLimits` from `robustness.mjs`** (after the move).

---

### 4.4 `scripts/lib/file-io.mjs` (MODIFY — P1-A)

**What changes**:
- Enhance `readFilesAsAnnotatedContext()` to add transport-neutral boundary annotations
- Add `getCommentStyle(relPath)` internal helper (routes via language profile to either inline block-comment markers or header-only annotation for non-code files)
- For files with diff hunks: inject inline markers (JS/TS/Python/etc.) OR add line-range annotation to block header (JSON/YAML/Markdown/HTML)
- For files without diff info: pass through unchanged (no annotation)

**New internal constant**: `COMMENT_STYLES` map from profile extension group to comment format (`'block'` | `'header-only'`).

---

### 4.5 `scripts/lib/code-analysis.mjs` (MODIFY — P1-B)

**What changes**:
- Add `maxFilesPerUnit = Infinity` third parameter to `buildAuditUnits()`
- Add file-count cap condition in bin-packing loop (5 lines)
- Backward compatible: all existing callers unaffected

---

### 4.6 `scripts/lib/config.mjs` (MODIFY — P1-B, P2)

**What changes**:
- Add to `openaiConfig`:
  ```js
  frontendMaxFilesPerUnit: safeInt(process.env.OPENAI_AUDIT_FRONTEND_MAX_FILES_PER_UNIT, 4),
  backendMaxFilesPerUnit: safeInt(process.env.OPENAI_AUDIT_BACKEND_MAX_FILES_PER_UNIT, 6),
  reduceMinTokens: safeInt(process.env.OPENAI_AUDIT_REDUCE_MIN_TOKENS, 10000),
  ```
- No breaking changes

---

### 4.7 `scripts/audit-loop.mjs` (MODIFY — P0-B, P2-A)

**What changes**:

**P0-B**:
- Read `results._sid` from R1 output and pass `--session-id ${results._sid}` to R2
- After each round, check `results._executionMeta?.suppressionUnavailable` — skip `stableCount` increment if true
- Pass `validateLedgerForR2` result to convergence check
- Does NOT write session manifest or increment meta — `openai-audit.mjs` owns this (G2 fix)

**P2-A**:
- Add `--debt-review` to arg parser
- `forceDebtReview` reads from session ledger meta (written by `openai-audit.mjs`)
- Add `--sort-by-age` when calling `debt-review.mjs` in Step 8
- After Step 8, call `batchWriteLedger(targetMetaPath)` to reset `runsSinceDebtReview = 0`

---

### 4.8 `scripts/lib/plan-fp-tracker.mjs` (NEW — P2-B)

**Purpose**: Track dismissed plan findings to suppress recurring "scope pressure" patterns.

**Key exports**:
- `class PlanFpTracker` with `load(path)`, `recordOutcome(text, action)`, `shouldSuppress(text)`, `save()`
- Concurrency: `proper-lockfile` with `stale: 10000` + `atomicWriteFileSync`
- `EMA_DECAY = 0.8`, `SUPPRESS_THRESHOLD = 0.7`, `SUPPRESS_MIN_CONSECUTIVE = 3`
- File format: `.audit/plan-fp-patterns.json`

**Dependencies**: `jaccardSimilarity` from `ledger.mjs`, `atomicWriteFileSync` from `file-io.mjs`, `proper-lockfile`

---

### 4.9 `scripts/write-plan-outcomes.mjs` (NEW — P2-B)

**Purpose**: CLI entry point for recording plan audit triage outcomes into `PlanFpTracker`. Decouples outcome capture from the audit run itself.

**Usage**: `node scripts/write-plan-outcomes.mjs --result <path> --outcomes '[{...}]'`

**Key logic**: Loads result JSON + outcomes array, calls `tracker.recordOutcome()` per finding, saves.

---

### 4.10 `scripts/lib/predictive-strategy.mjs` (NEW — P2-C)

**Purpose**: Predict file risk and unit sizing for resource allocation. Pass skipping = explicit opt-in only.

**Key exports**: `class PredictiveStrategy` with `load(store)`, `predictActivePasses()`, `rankFilesByRisk()`, `recommendUnitSize()`

**Graceful degradation**: All methods return safe defaults when store unavailable.

---

### 4.11 `tests/robustness.test.mjs` (NEW — P0)

**Tests**:
- `tryRepairJson`: valid JSON unchanged; truncated `[{"x":"y"` repaired; multi-level nesting; fully broken → `{ok: false}`
- `resolveLedgerPath` R2 fallback: no ledger + no outFile → reads manifest; no manifest → `.audit/session-ledger.json`
- `validateLedgerForR2`: missing, corrupted, valid JSON with entries

---

### 4.12 `tests/code-analysis.test.mjs` (MODIFY — P1-B)

**Add tests**:
- `buildAuditUnits(files, 30000, 2)`: 6 files → ≥3 units, none with >2 files
- `buildAuditUnits(files, 30000)` (no cap): existing behavior preserved

---

### 4.13 `tests/file-io.test.mjs` (NEW — P1-A)

**Tests**:
- JS file with diff hunks: inline line-comment markers appear, UNCHANGED CONTEXT regions are marked (line comments, not block — see the 2026-07-26 correction in §"Transport-neutral boundary envelope")
- JSON file with diff hunks: header shows `[CHANGED — LINES X-Y]`, no markers injected into content
- File with no diff entry: no annotation markers
- Profile routing: Python uses `#`-style block markers; JSON uses header-only

---

### 4.14 `tests/plan-fp-tracker.test.mjs` (NEW — P2-B)

**Tests**:
- New tracker has no patterns; `shouldSuppress` returns false
- After ≥3 consecutive dismissals of similar text: `shouldSuppress` returns true
- Accepted finding resets consecutive counter; suppression lifts on next similar finding

---

## 5. Risk & Trade-off Register

| Decision | Trade-off | Risk | Mitigation |
|----------|-----------|------|-----------|
| Status-gated fallback (not count-gated) | Legitimate reduce-to-zero no longer triggers fallback | Reduce failure must set status correctly | `safeCallGPT` wraps the call; error classification is explicit via `ReduceStatus` |
| Session manifest for ledger identity | New file dependency between R1 and R2 | Manifest may be stale if `.audit/` is cleaned | Fallback chain: manifest → `.audit/session-ledger.json` → null (warn) |
| Header-only annotation for non-code files | Less precise than inline markers | GPT may still audit non-changed lines in JSON | Changed line ranges in header are exact; GPT instruction is explicit |
| `computePassLimits` moved to `robustness.mjs` | Module dependency shift | Callers in `openai-audit.mjs` need import update | Single import line change; function signature unchanged |
| `meta` block added to session ledger | Schema evolution | Older ledger files without `meta` block | `batchWriteLedger` initializes `meta: {}` if absent |
| Pass skipping is opt-in behind `--predictive-skip` | Predictive benefit limited without skip | Users who want skip must opt in | Default safe behavior; power users can enable |
| `plan-fp-patterns.json` locked with `proper-lockfile` | Adds lockfile dependency | Lock contention on rapid sequential runs | 10s stale timeout; `audit-loop.mjs` is single-threaded per session |

### Deliberately deferred

- **Streaming in Claude Opus fallback**: R12 "streaming requirement" failure was one-off. Monitor for recurrence.
- **Cross-repo cloud sync for `PlanFpTracker`**: Local-first, defer until validated
- **Phase 7 pass skip mode**: Implemented but gated behind `--predictive-skip`. Enable after 10 more runs of prediction accuracy data.
- **Full cost accounting for prediction-skipped passes**: `_executionMeta.passesSkipped` records the skip; cost attribution deferred.

---

## 6. Testing Strategy

### Unit Tests (isolated, no network)

| Test File | Function/Class | Key Cases |
|-----------|---------------|-----------|
| `tests/robustness.test.mjs` | `tryRepairJson` | valid, truncated array, truncated object, multi-level, fully broken |
| `tests/robustness.test.mjs` | `resolveLedgerPath` (manifest + fallback) | manifest present, manifest absent, explicit override |
| `tests/robustness.test.mjs` | `validateLedgerForR2` | missing file, corrupted JSON, valid file with entries |
| `tests/robustness.test.mjs` | `computePassLimits` (minTokens) | floor respected when reasoning output is low |
| `tests/code-analysis.test.mjs` | `buildAuditUnits` (maxFilesPerUnit) | cap enforced, backward compat |
| `tests/file-io.test.mjs` | `readFilesAsAnnotatedContext` | JS markers, JSON header-only, no-diff passthrough, Python prefix |
| `tests/plan-fp-tracker.test.mjs` | `PlanFpTracker` | new tracker, suppress after 3+, accept resets counter, concurrency |

### Integration Tests (file system, no network)

- `validateLedgerForR2` with real temp files (write valid/corrupted JSON, verify detection)
- `PlanFpTracker` load + record + save round-trip with temp directory
- `batchWriteLedger` meta block: write, re-read, confirm `runsSinceDebtReview` increments

### Manual Smoke Tests (require `OPENAI_API_KEY`)

1. **P0-A**: Force reduce failure with `OPENAI_AUDIT_MAX_TOKENS=100`. Confirm `_executionMeta.reduceStatus` in output JSON and MAP findings preserved.
2. **P0-B**: Delete `.audit/current-session.json`, run R2 with no `--ledger`. Confirm `WARNING: Ledger not found` in stderr and `_executionMeta.suppressionUnavailable: true` in output.
3. **P1-A**: Run `--scope diff` on a recent commit. Inspect context string — confirm JS files have inline markers; JSON config files have `[CHANGED — LINES X-Y]` in headers.
4. **P1-B**: Run `--passes frontend` on a 12-file frontend. Confirm `MAP: ≥3 units` in stderr and no retry logged.

### Regression Guard

`npm test` must pass 100% before and after each phase. P0 ships only when all existing tests still pass. The `computePassLimits` move is the only change that could affect existing tests (import path change — caught immediately by `npm test`).

---

## 7. Implementation Order

```
Phase 1 — P0 (independent, can be parallelized):
  [P0-C] schemas.mjs: add ExecutionMetaSchema, ReduceStatus
  [P0-A] robustness.mjs: add tryRepairJson(), ReduceStatus, move computePassLimits here
  [P0-A] openai-audit.mjs: status-gated fallback, repair in _callGPTOnce, import computePassLimits
  [P0-B] robustness.mjs: AUDIT_DIR + SESSION_MANIFEST_PREFIX constants, resolveLedgerPath SID-scoped read
  [P0-B] openai-audit.mjs: validateLedgerForR2(), set _executionMeta.suppressionUnavailable
  [P0-B] audit-loop.mjs: write SID-scoped manifest R1, pass --session-id to R2, meta in session-ledger.json
  [P0-B] ledger.mjs: batchWriteLedger() gains targetMetaPath + proper-lockfile for meta isolation
  [P0-B] openai-audit.mjs: write SID-scoped session manifest + increment meta.runsSinceDebtReview at R1 end
  TEST: tests/robustness.test.mjs (all P0 cases)

Phase 2 — P1 (after P0 tests pass):
  [P1-A] file-io.mjs: transport-neutral annotation (+ tests/file-io.test.mjs)
  [P1-B] robustness.mjs: computePassLimits minTokens param
  [P1-B] code-analysis.mjs: maxFilesPerUnit param (+ tests/code-analysis.test.mjs update)
  [P1-B] config.mjs: frontendMaxFilesPerUnit, backendMaxFilesPerUnit, reduceMinTokens
  [P1-B] openai-audit.mjs: wire maxFilesPerUnit + reduceMinTokens into pass calls

Phase 3 — P2 (after P1 validated in production for ≥5 runs):
  [P2-A] audit-loop.mjs: --debt-review flag, meta block in ledger, --sort-by-age
  [P2-B] plan-fp-tracker.mjs: new module (+ tests/plan-fp-tracker.test.mjs)
  [P2-B] write-plan-outcomes.mjs: new CLI entry point
  [P2-B] openai-audit.mjs: wire PlanFpTracker into runPlanAudit
  [P2-C] predictive-strategy.mjs: new module (no-op by default, --predictive-skip gated)
  [P2-C] openai-audit.mjs: wire PredictiveStrategy (ranking + sizing only)
```

Each phase is independently deployable. P0 is production-safe immediately. P1 is additive. P2 is gated behind flags and has no behavioral change until explicitly enabled.
