# Audit Summary — openai-prefix-cache

**Plan**: docs/plans/openai-prefix-cache.md
**Scope**: --scope diff (10 files: prompt-builder.mjs + openai-audit.mjs + 2 tests + plan docs + gemini-gate doc family)
**Rounds**: GPT R1 → R2 → Gemini R1 (APPROVE)

## Convergence

| Round | Verdict | H | M | L | Outcome |
|---|---|---|---|---|---|
| GPT R1 | SIGNIFICANT_ISSUES | 3 | 8 | 5 | All 3 HIGHs rebutted — H1/H2 DISMISSED (workflow output, paths exist); H3 → LOW (JSDoc trust-boundary added) |
| GPT R2 | NEEDS_FIXES | 0 | 8 | 4 | HIGH plateau at 0; MEDIUMs mostly re-raises of R1 (M3/M6=H3 re-raise, M4=M8 re-raise) + 1 real micro-bug (M5: spread order in estimateStablePrefixTokens) |
| Gemini R1 | **APPROVE** | — | — | 1 LOW | Caught subtle spread-order bug in M5 fix (Claude's `code: ''` before `...opts`); fixed |

## Adjudications

### Fixed in implementation

- **R1/H3 → LOW (JSDoc trust-boundary)**: Added explicit "trust boundary contract" JSDoc to `buildAuditPassPrompt` documenting that callers MUST source inputs from vetted helpers (readProjectContextForPass, extractPlanForPass, readFilesAsContext); sanitization stays at source helpers per existing security architecture.
- **R1/M3 (validateOpts)**: Extended `validateOpts` in prompt-builder.mjs to also check optional fields (fileListContext, codeHeader, unitLabel — strings only; history, roundModifier — string|null).
- **R1/M8 (sunset note)**: Added explicit 30-day sunset plan for legacy `{ systemPrompt, userPrompt }` mode at `normalisePromptInput` JSDoc.
- **R2/M5 (estimate over-coupling)**: Made `code` truly ignored in `estimateStablePrefixTokens` — moved spread order so `code: ''` is final.
- **Gemini R1/LOW (spread-order subtle bug)**: Fixed the M5 fix — `...opts` BEFORE `code: ''` so the empty-code override is final.

### Dismissed via rebuttal (all 3 R1 HIGHs)

- **H1 (Missing planned files = audit-summary artifacts)**: DISMISSED — these are cycle outputs, not preconditions; the one for this audit lives at this very file.
- **H2 (Missing planned modules = lib/context.mjs, lib/llm-wrappers.mjs)**: DISMISSED — both files exist at `scripts/lib/...`; auditor misread relative path shorthand.
- **H3 (Sensitive Data Exposure Boundary)**: Compromised to LOW — sanitization at source helpers is the correct boundary; duplicating inside prompt-builder would be redundant.

### Deferred to follow-up PR (R1/M1)

- `tests/prompt-builder.snapshot.test.mjs` — synthetic baseline fixture, not safety-critical (wrapper-contract tests verify shape invariants).
- `tests/integration-prompt-cache.test.mjs` — live API test ($0.01/run), gated by `RUN_LIVE_TESTS=1`.
- `tests/r2-churn-defense.test.mjs` — needs synthetic fixture; R2 churn invariant currently verified live by every R2+ run.

## Cache telemetry verification

R1 audit logged `[cache] input=22903 cached=0 hitRate=0.0% (~0.0% savings)` — expected on cold-start cache. The telemetry plumbing works end-to-end:
- `_callGPTOnce` extracts `prompt_tokens_details.cached_tokens` from OpenAI response
- `callGPT` retry-aggregates across attempts
- `safeCallGPT` graceful-degradation includes `cached_tokens: 0`
- `runMultiPassCodeAudit` aggregates into `_cacheMetrics` on merged result
- Per-pass entries keyed by passName via parallel-array reconciliation
- `_cacheMetrics` written to `.audit/session-audit-*.json` via manifest

Cache hit rate will improve empirically on R2+ audits within the 5-min OpenAI TTL, AND when `AUDIT_CACHE_SEED=1` is set on map-reduce passes (still default OFF per plan §6).

## Scope filter verification (eating own dogfood)

Gemini final review used the NEW `transcript.changed_files` field (10 files). `applyScopeFilter` ran with `scope-filtered count: 0` — correctly kept all in-scope findings (the only finding had no `file` field — a deliberation-level meta-finding, which is the documented carve-out).

## Files changed

| File | Change |
|---|---|
| `scripts/openai-audit.mjs` | +`buildCachePrompt` helper; +14 migrated call sites; +`normalisePromptInput`; +`cached_tokens` thread-through; +`_cacheMetrics`; +cache-seed wrapper in `runMapReducePass`; +`__testExports` gated by env |
| `scripts/lib/audit/prompt-builder.mjs` (NEW) | `buildAuditPassPrompt` pure function + `estimateTokens` + `estimateStablePrefixTokens` |
| `tests/prompt-builder.test.mjs` (NEW) | 22 unit tests covering shape, R1/R2/R3 cache invariants, edge cases |
| `tests/openai-wrapper-contract.test.mjs` (NEW) | 18 wrapper-contract tests (legacy mode, structured mode, hybrid rejection, retry aggregation, fail-fast policy) |
| `docs/plans/openai-prefix-cache.md` | Audited 3 GPT rounds + 2 Gemini rounds; status flipped to Complete via implementation log |

## Test results

- `tests/prompt-builder.test.mjs` + `tests/openai-wrapper-contract.test.mjs`: **40/40 pass**
- Full suite: 1941/1942 pass (1 pre-existing vendoring-provenance failure unrelated to this PR — gitignored local artifact stale since prior session)
