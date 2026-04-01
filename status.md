# Project Status Log

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
