# Plan: Dogfooding Ergonomics v1

- **Date**: 2026-05-09
- **Status**: Complete — shipped 2026-05-09; archive auto-moves this file via `/ship` Step 5.5
- **Author**: Claude + Louis
- **Scope**: backend (js-ts; consumes audit-orchestration + skills domains)
- **Origin**: 2-LLM brainstorm (OpenAI gpt-5 + Gemini pro) on "what to build next" — synthesis chose minimum-viable stabilization that accelerates dogfooding instead of front-loaded MEDIUMs or feature work

---

## 1. Context Summary

Adaptive-learning v1 just shipped end-to-end (commits 0bde3ab/cf9a89b/e40a40e/5398438; schema applied 2026-05-09). The next phase requires **real `learning_decisions` data** to validate v2 candidate policies. Until that data accumulates (~30 days), every hour spent on this repo that doesn't either (a) accelerate dogfooding on consumer apps or (b) ship a feature consumed by dogfooding is an hour the data clock isn't ticking.

This plan ships the **minimum-viable stabilization** for that handover: one smoke test, one consumer-repo invocation hook, and one skill change (auto-archive completed plans on `/ship`).

### Detected scope + stack
- Scope: backend
- Stack: js-ts (Node ESM)
- Target domain(s): `audit-orchestration`, `skills`, `learning-store`

---

## 2. Proposed Architecture

### A. `tests/learning-smoke.test.mjs` — live Supabase round-trip

Gated on `SUPABASE_AUDIT_SERVICE_ROLE_KEY` being present (skips silently in CI). When the env is set, runs a full insert→read→cleanup cycle:

1. Insert one synthetic `learning_decisions` row with a unique throwaway `decision_key` (UUID prefix `smoke-test-`).
2. Read back via service-role client; assert all fields round-trip correctly.
3. Read each of the 3 views (`pending_triage_findings`, `no_brainer_recommendations`, `persona_density_per_repo`) — confirm they're queryable and return shape (rows OR empty array OK).
4. Cleanup: delete the inserted row (also tests delete-by-decision_key).

This is the ONLY MEDIUM from the audit that pays back during dogfooding — it surfaces deployment regressions instantly when the schema or RLS drifts.

### B. `scripts/archive-completed-plans.mjs` — auto-archive utility

Pure CLI, no LLM calls. Algorithm:
- Scan `docs/plans/*.md`
- Parse the `- **Status**:` line in the metadata block
- If status starts with `Complete` (e.g. "Complete (v1)", "Complete — shipped as ..."), move the file to `docs/completed/`
- Also move any sibling `<plan-name>-audit-summary.md` files (from `/audit-code` Step 6 convergence reports)
- Idempotent — if the file already exists in `docs/completed/`, log warning and skip
- CLI flags: `--dry-run` (print what would move, don't move), `--force` (overwrite duplicates)
- Returns JSON summary `{moved: [...], skipped: [...], errors: [...]}`

Wired into `/ship` SKILL as a final step (after the existing post-push checks). Can also be invoked directly: `npm run plans:archive`.

### C. wine-cellar-app pre-push hook

A `.git/hooks/pre-push` wrapper in the wine-cellar-app repo that invokes `node /path/to/claude-audit-loop/scripts/openai-audit.mjs code <plan> --scope diff` if any plan exists in `docs/plans/`. Skips silently when no plan is present (so it doesn't block normal commits).

This is OUT-OF-SCOPE to commit in this repo (it's a wine-cellar-app file). Plan documents the recipe + curl-style snippet so the user can wire it in their wine-cellar-app session.

### D. Update `/ship` SKILL

Add a new step (Step 8 or end-of-flow): "Archive completed plans". Invokes `npm run plans:archive`. Auto-runs after every `/ship` invocation; can be skipped with `--no-archive` flag.

---

## 3. File-Level Plan

| File | Action | Notes |
|---|---|---|
| `tests/learning-smoke.test.mjs` | NEW | Live Supabase round-trip; gated on service-role env |
| `scripts/archive-completed-plans.mjs` | NEW | Pure CLI utility; scans + moves; --dry-run + --force |
| `package.json` | EDIT | Add `plans:archive` script |
| `.claude/skills/ship/SKILL.md` | EDIT | Add Step "Archive completed plans" at end |
| `skills/ship/SKILL.md` | EDIT | Source-of-truth for the SKILL (canonical) |
| `AGENTS.md` | EDIT | Document `npm run plans:archive` + auto-archive on /ship |
| `docs/plans/dogfooding-ergonomics-v1.md` | NEW | This plan (will auto-archive on /ship) |

Out-of-scope (documented but not committed here):
- wine-cellar-app pre-push hook — recipe in §2.C; user wires it in their wine-cellar-app session

---

## 4. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC1 | `tests/learning-smoke.test.mjs` exists and skips silently when `SUPABASE_AUDIT_SERVICE_ROLE_KEY` is absent |
| AC2 | When env is set, smoke test inserts a row, reads it back, queries 3 views, and cleans up |
| AC3 | `scripts/archive-completed-plans.mjs` exists with `--dry-run` and `--force` flags |
| AC4 | Archive script moves only files whose Status line matches `^- \*\*Status\*\*: Complete` |
| AC5 | Archive script moves sibling `*-audit-summary.md` files alongside the parent plan |
| AC6 | Archive is idempotent — running twice produces same final state |
| AC7 | `npm run plans:archive` is wired in package.json |
| AC8 | `/ship` SKILL has a new step that invokes archive (both .claude/skills/ship and skills/ship) |
| AC9 | This plan's own status flips to "Complete" when shipped, and the archive step moves it to `docs/completed/` automatically |
| AC10 | All existing tests stay green |

---

## 5. Out of Scope

- wine-cellar-app pre-push hook (lives in a different repo; user wires via documented recipe)
- TUI/structured terminal output (Gemini's bigger ergonomics push — defer until dogfooding surfaces actual UX pain)
- The other 3 deferred MEDIUMs (cellar_id naming, cross-skill.mjs decomposition, getRepoIdByName fix already shipped in 5398438) — accept as v1.x debt
