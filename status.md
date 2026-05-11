# Project Status Log

## 2026-05-11 (later) — Gemini-gate scope fix + OpenAI prompt prefix-cache restructure

### Changes (bundled commit — two related fixes)

**1. Gemini-gate scope fix** (`scripts/gemini-review.mjs` + shared docs)
- Added `transcript.changed_files` field as Step 7 transcript requirement.
- New rule 8 in REVIEW_SYSTEM: `new_findings[]` entries must cite a file from `Files In Scope (PR diff)` block.
- Tightened rule 7: `wrongly_dismissed[]` entries must trace to a prior dismissed finding OR provide explicit linkage from unchanged-file evidence to in-scope changed file (provenance requirement).
- New `applyScopeFilter()` post-output filter drops out-of-scope `new_findings`; logs `[scope-dropped]` to stderr + records `_scopeFilteredCount`/`_scopeFilteredFindings` on result envelope.
- Updated canonical doc at `docs/audit/shared-references/gemini-gate.md` + auto-synced to 4 mirrors.
- Audited in 3 GPT rounds + 2 Gemini rounds (REJECT final round was a Gemini hallucination — fabricated GPT quote contradicted by R1 stderr; documented).

**2. OpenAI prompt prefix-cache restructure** (`scripts/openai-audit.mjs` + new `scripts/lib/audit/prompt-builder.mjs`)
- New `buildAuditPassPrompt` pure function: 3-message structure (stable msg #1 = brief+plan+files; dynamic msg #2 = rulings; dynamic msg #3 = code) — preserves rulings-before-code instruction salience while keeping msg #1 byte-stable for OpenAI prefix caching.
- Migrated all 14 audit call sites in `openai-audit.mjs` to use `buildCachePrompt` helper.
- `_callGPTOnce` / `callGPT` / `safeCallGPT` now accept structured `{ system, messages }` OR legacy `{ systemPrompt, userPrompt }`; hybrid input rejected with `LlmError({category:'config'})` (fail-fast on programmer bugs); `safeCallGPT` re-throws config errors but stays graceful for LLM/runtime errors.
- `cached_tokens` telemetry threaded through entire call chain; aggregated to `_cacheMetrics` on the merged result + session manifest; `[cache] input=… cached=… hitRate=…%` stderr line per audit run.
- Opt-in cache-seed wrapper in `runMapReducePass` (`AUDIT_CACHE_SEED=1`) — sequential seed of smallest unit then parallel fanout; `shouldSeedCache()` policy checks `units.length > 1` + stable-prefix ≥ 1024 tokens; `throwIfConfigError` re-throws config-category rejections from Promise.allSettled (fail-fast preserved through fanout).
- `runMapReducePass` signature changed: now takes `(openai, files, passName, buildPromptForUnit, ...)` — per-unit prompt is built by caller closure.
- 40 new tests (22 prompt-builder + 18 wrapper-contract).
- Audited 2 GPT rounds + 1 Gemini round → Gemini APPROVE.

### Files Affected
- `scripts/gemini-review.mjs` (+rule 8 + scope block + applyScopeFilter + rule 7 provenance)
- `scripts/openai-audit.mjs` (~150 LOC change: prompt-builder integration, telemetry, cache-seed, test exports)
- `scripts/lib/audit/prompt-builder.mjs` (NEW — ~150 LOC pure function + helpers)
- `tests/prompt-builder.test.mjs` (NEW — 22 tests)
- `tests/openai-wrapper-contract.test.mjs` (NEW — 18 tests)
- `docs/audit/shared-references/gemini-gate.md` (+Flavour 2 section, +Step 7.1 refresh + Rule 7 cross-ref)
- `docs/plans/openai-prefix-cache.md` (NEW — 600-line plan, audited 3+2 rounds)
- `docs/plans/gemini-gate-scope-fix.md` + audit-summary (NEW)
- Auto-synced mirrors at `skills/audit-{plan,code}/references/gemini-gate.md` + `.claude/skills/audit-{plan,code}/references/gemini-gate.md`

### Audit Outcomes
- Gemini-gate plan: GPT R1→R2 PASS, Gemini R1 CONCERNS→R2 APPROVE (with HIGH hallucination documented)
- Prefix-cache plan: GPT R1 NEEDS_REVISION→R2 NEEDS_REVISION→R3 NEEDS_REVISION→Gemini R1 CONCERNS→R2 APPROVE; verification audit GPT R1 SIGNIFICANT_ISSUES (3 HIGHs — all rebutted/dismissed) → R2 NEEDS_FIXES (H:0 plateau, MEDIUMs are R1 re-raises) → Gemini APPROVE (1 LOW spread-order polish fixed)

### Next Steps
- Follow-up PR: deferred snapshot + integration + R2-churn-defense tests + their fixtures.
- Empirical cache-hit-rate measurement across 5+ real audits; flip `AUDIT_CACHE_SEED` default to ON once median R2 hit-rate > 30%.

---

## 2026-05-11 — Symbol-index bugs: arch:refresh --force + arch:duplicates thin-delegate

### Changes
- **Bug 1 — `refresh.mjs:--force` was a no-op**: when `openRefreshRun` failed with `REFRESH_IN_FLIGHT` and `--force` was passed, control fell through to `throw err`. Added an abort-then-retry path: query the stale `refresh_runs` row via `getReadClient()`, call `abortRefreshRun({reason: 'aborted by --force'})`, then re-attempt `openRefreshRun` once. Uses the existing import — no new dependencies.
- **Bug 2 — `arch:duplicates` flagged thin-delegate facades as duplication**: extracted `isThinDelegate()` heuristic to `scripts/lib/symbol-index/thin-delegate.mjs` (text-based: `<member.access>(<passthrough-args>)`). Wired into `extract.mjs` candidate loop with `stats.skippedDelegate` counter + done-progress line. Default-on; `--include-delegates` flag disables for debug/visibility.
- Added 29 unit tests (`tests/thin-delegate.test.mjs`) covering positive/negative/input-guard/argument-passthrough/VariableDeclaration-prefix/async-function-expression cases.
- Heuristic tightened twice during audit: (a) argument-passthrough rule (no operators/literals/objects/ternaries in args) — added per GPT R1 M4 compromise; (b) VariableDeclaration `name = function(...)` prefix-strip + `async` variant — added per Gemini R1/R2 review.
- Updated `docs/plans/symbol-index-bugs.md` with the actual repo test path + audit-ruling annotations + revised trade-off discussion.

### Files Affected
- `scripts/symbol-index/refresh.mjs` — Bug 1 force-abort path; `--include-delegates` flag passthrough + warning
- `scripts/symbol-index/extract.mjs` — Bug 2 thin-delegate filter; `--include-delegates` flag + warning
- `scripts/lib/symbol-index/thin-delegate.mjs` (NEW) — heuristic helper with argument-passthrough rule + JSDoc limitations
- `tests/thin-delegate.test.mjs` (NEW) — 29 unit cases
- `docs/plans/symbol-index-bugs.md` — updated test path + audit-ruling annotations
- `docs/plans/symbol-index-bugs-audit-summary.md` (NEW) — convergence summary
- `.audit/tech-debt.json` — captured 3 out-of-scope pre-existing items (extract.mjs IO error swallowing, hardcoded TS enum literals at lines 70-77, extractSymbols cognitive complexity 47)

### Audit Outcome
- **GPT (3 rounds)** → R1: 8 findings (5 in-scope adjudicated, 3 debt) → R2: 6 findings (all re-raises/false-positives, all adjudicated) → R3: convergence stop (only re-raises with new hashes)
- **Gemini final review (2 rounds, MANDATORY)** → R1 CONCERNS: 1 valid (FunctionExpression prefix) → fixed → R2 CONCERNS: 2 (async-FE false negative → fixed; `git log --grep` → out-of-scope hallucination, dismissed)
- Final: H:0 M:0 substantively, 29/29 thin-delegate tests pass, 1901/1902 full suite (1 pre-existing failure in `vendoring-provenance.test.mjs` is gitignored local artefact unrelated to this PR)

### Decisions Made
- Skip-at-extraction over store-and-classify-downstream — preserves index storage cost vs schema-retrofit cost; visibility-preservation shipped in same change-set as `--include-delegates` flag per audit ruling.
- Text-based heuristic over AST-level classification — keeps the recent ts-morph memory-pressure fix intact (releases SourceFile after extraction); 11 → 29 test cases cover the validated edge cases.
- Argument-passthrough rule: any operator/literal/object/ternary in arg position disqualifies. More conservative than the original plan's stance (which accepted `x ?? defaultVal` as facade); now correctly rejects it.

### Next Steps
- Optional: tackle deferred debt items (M5/M6/M7) when extract.mjs is refactored for the broader pipeline split.
- Consumer repos pick up the fix via plugin sync — no per-repo action needed.

---

## 2026-04-01 — Supabase Learning Loop, God Module Refactor, Audit Pipeline Fixes

### Changes
- Wired all 9 Supabase tables: bandit arms sync, FP patterns, adjudication events, prompt variants (learning-store.mjs)
- Connected Thompson Sampling bandit reward updates from rebuttal deliberation outcomes
- Split shared.mjs (1608 lines) → 7 focused modules under scripts/lib/ (schemas, file-io, ledger, code-analysis, context, findings, config) + barrel re-export
- Fixed bandit Beta posterior algorithm (was broken threshold, now proper alpha/beta update)
- Added atomic writes for ledger, bandit, and FP tracker persistence (atomicWriteFileSync)
- Enforced schema validation at trust boundaries (callGemini rejects invalid responses, writeLedgerEntry validates entries)
- Consolidated schema source of truth: zodToGeminiSchema() replaces hand-maintained JSON Schemas
- Centralized config validation in lib/config.mjs
- Made Gemini final review mandatory (not convergence-gated)
- Added Step 7.1: Claude deliberates on Gemini findings, then Gemini re-verifies (closed loop)
- Increased Gemini thinking budget to 16384 tokens
- Replaced silent .catch(() => {}) with error logging throughout
- Added fuzzy file discovery for plan paths that don't match exact filenames
- Added 47 unit tests (node:test) covering bandit, schemas, ledger, FP tracker
- Verified by 3-round GPT-5.4 audit + Gemini 3.1 Pro final review

### Files Affected
- scripts/lib/ (new) — 7 focused modules extracted from shared.mjs
- tests/ (new) — shared.test.mjs (33 tests), bandit.test.mjs (14 tests)
- scripts/shared.mjs — replaced 1608-line monolith with 80-line barrel re-export
- scripts/openai-audit.mjs — direct lib/ imports, bandit reward wiring, error logging
- scripts/gemini-review.mjs — derived schemas, 16K thinking budget, validation enforcement
- scripts/bandit.mjs — proper Beta posterior, atomic writes, flush on exit, warning on unknown arms
- scripts/learning-store.mjs — 5 new Supabase sync functions
- .claude/skills/audit-loop/SKILL.md — mandatory Gemini, Step 7.1 closed loop
- package.json — added test script

### Decisions Made
- Barrel re-export pattern: shared.mjs kept for backwards compatibility, consumers migrate to lib/ directly
- Fuzzy file discovery only triggers when regex finds <5 files (threshold prevents over-matching)
- Gemini re-verifies its own findings (not GPT) since GPT already missed them
- Codex plugin (openai/codex-plugin-cc) evaluated and rejected — not a fit for plan-aware audit pipeline

### Supabase Cloud Status
- audit_repos: 6 rows, audit_runs: 7 rows, audit_findings: 105 rows, audit_pass_stats: 34 rows, bandit_arms: 15 rows — all flowing
- suppression_events, false_positive_patterns, finding_adjudication_events: 0 rows (expected — need rebuttal/R2+ rounds)

### Next Steps
- Run full audit-loop with rebuttal to populate remaining Supabase tables
- Implement prompt variant A/B testing with bandit selection
- Consider splitting openai-audit.mjs orchestration from LLM call logic

---

## 2026-03-31 — Final Review Fallback to Claude Opus

### Changes
- Implemented provider fallback in scripts/gemini-review.mjs so Step 6.5 now runs Gemini when available, then Claude Opus when Gemini credentials are missing.
- Added Claude Opus invocation path using @anthropic-ai/sdk with shared verdict schema parsing and consistent output metadata.
- Updated ping behavior in scripts/gemini-review.mjs to validate either Gemini or Claude Opus depending on available credentials.
- Updated final-review docs and skill instructions to reflect fallback order instead of skipping when GEMINI_API_KEY is absent.
- Added environment variable documentation for CLAUDE_FINAL_REVIEW_MODEL and clarified ANTHROPIC_API_KEY usage for final-review fallback.

### Files Affected
- scripts/gemini-review.mjs — Added runtime provider selection and Claude Opus fallback execution path.
- .github/skills/audit-loop/SKILL.md — Updated Step 6.5 fallback behavior for Copilot skill flow.
- .claude/skills/audit-loop/SKILL.md — Updated Step 6.5 fallback behavior for Claude Code skill flow.
- .env.example — Documented fallback behavior and CLAUDE_FINAL_REVIEW_MODEL.
- CLAUDE.md — Updated architecture and environment variable table for fallback design.
- README.md — Updated final-review usage label and environment variable table.

### Decisions Made
- Final review provider precedence is Gemini first, Claude Opus second.
- Step 6.5 is only skipped when both GEMINI_API_KEY and ANTHROPIC_API_KEY are absent.
- Output payload now includes provider metadata to make downstream processing explicit.

### Next Steps
- Run an end-to-end final-review dry run in both provider modes to validate response schema stability and timeout behavior.

---
