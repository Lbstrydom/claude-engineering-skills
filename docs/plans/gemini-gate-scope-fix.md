# Plan: Gemini-gate scope-error fix

- **Date drafted**: 2026-05-11
- **Status**: Complete — applied 2026-05-11
- **Scope**: 3-edit fix to `scripts/gemini-review.mjs` + 1 doc edit in `docs/audit/shared-references/gemini-gate.md` (canonical; auto-synced to `skills/audit-{plan,code}/references/gemini-gate.md` via `scripts/sync-shared-audit-refs.mjs`).

---

## Problem

Gemini final review (Step 7) sometimes flags issues in files NOT modified by the current PR. Observed in two audits:

- Wine-cellar audit — flagged drinkNowAI, cellarAI, openaiReviewer, agentOrchestrator (none in PR diff).
- This repo's symbol-index-bugs audit — Gemini R2 raised a MEDIUM about `git log --grep` in `scripts/explain-history.mjs`, which the PR did not touch.

Root cause: the user prompt sent to Gemini contains plan + transcript + inlined code files (assembled via `transcript.code_files ∪ extractPlanPaths(planContent)`), but no signal distinguishing "files this PR changed" from "files inlined for context". The system prompt's "category errors" section only addressed one flavour (plan-vs-current-state), not scope-out-of-diff. No post-output filter on `new_findings[]`.

## Fix (3 layers)

### Layer 1 — Transcript field

`transcript.changed_files: string[]` — populated by whoever builds the transcript (the audit-code skill at Step 7, from the `--changed` CSV passed to R1 audit). The Step 7 protocol doc now lists this as REQUIRED.

### Layer 2 — Prompt injection

`scripts/gemini-review.mjs:runFinalReview()` reads `transcript.changed_files` and prepends a `## Files In Scope (PR diff)` block to the user prompt, listing each path on its own line. The block is emitted only when `changed_files.length > 0` (no-op when absent — preserves pre-existing corpus-wide behaviour).

System prompt rule 8 added: "If a finding cites a file not in 'Files In Scope', it is out-of-scope. Only raise it if the deliberation itself is the concern. Cross-cutting concerns that a PR change BREAKS in an in-scope-adjacent file belong in the in-scope file's finding (cite both files in the description)."

### Layer 3 — Post-output filter

`applyScopeFilter(result, transcriptContent)` mirrors the shape of the existing `applyDebtSuppression`:

- Parses transcript, reads `changed_files`.
- For each `new_findings` entry, normalises the `file` field (trim, strip `./`) and checks membership against the changed-files set (with suffix matching for relative vs absolute paths).
- Entries with no `file` field are kept (deliberation-level findings).
- Out-of-scope findings are dropped from `new_findings`; count + IDs are recorded on the result envelope as `_scopeFilteredCount` and `_scopeFilteredFindings[]` for auditability; first 3 are logged to stderr as `[scope-dropped]`.
- `wrongly_dismissed[]` is intentionally NOT scope-filtered (cross-cutting GPT misses can legitimately point anywhere).
- Called after `applyDebtSuppression` in `main()`, before `addSemanticIds`.

## Files modified

| File | Change |
|---|---|
| `scripts/gemini-review.mjs` | +rule 8 in REVIEW_SYSTEM prompt; +`scopeBlock` block in user prompt; +`applyScopeFilter()` function (~30 LOC); +call site in `main()` |
| `docs/audit/shared-references/gemini-gate.md` | +`changed_files` field to "Build the transcript"; split "category errors" section into Flavour 1 (plan-vs-state) + Flavour 2 (out-of-scope), documenting the new layers + the `wrongly_dismissed` carve-out |

Note: `skills/audit-{plan,code}/references/gemini-gate.md` and `.claude/skills/audit-{plan,code}/references/gemini-gate.md` are auto-synced copies — never hand-edit. Run `npm run sync` (sync-shared-audit-refs.mjs + regenerate-skill-copies.mjs) after editing the canonical.

## What is NOT in scope

- The audit-code skill's Step 7 transcript-builder is the caller responsible for populating `changed_files`. This plan does NOT modify the skill markdown — it only documents the requirement in `gemini-gate.md`. Future audit-code invocations should pass the list; legacy invocations that omit it get the pre-existing corpus-wide review (no regression).
- No test was added — the function is pure (transcript JSON → filtered findings), thin, and exercised live every Step 7 run. Adding a unit test for a 30-line filter that wraps an array filter would be over-engineering.

## Trade-offs

**Pro**: catches the actual hallucination pattern observed across two repos; visible (logs + envelope fields); does not block legitimate cross-cutting concerns (wrongly_dismissed carve-out + deliberation-level findings kept).

**Con**: a legitimate "your change in X breaks contract in Y" finding where Y is unchanged would be filtered. Mitigation: the system-prompt rule says cite both files in the X-file finding's description. If Gemini fails to do that, the cross-cutting issue is filtered — but those are rare, and the alternative (no filter) generates far more false positives.
