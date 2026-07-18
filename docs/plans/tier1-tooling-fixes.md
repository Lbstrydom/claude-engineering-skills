# Plan: Tier-1 tooling fixes (from the wine-cellar-app session feedback)

- **Date**: 2026-06-28
- **Status**: Complete (2026-06-28 — /audit-code GPT R3 PASS; Gemini R2 APPROVE)
- **Scope**: backend (CLI tooling + a skill flow) — three independent, low-coupling fixes

## 1. Context Summary

Three concrete tooling issues surfaced while running the skills against a consumer repo.
All are cross-repo-general (not wine-cellar-specific). Implemented; this plan exists to
audit the change before shipping.

**Code Trace:** `scripts/openai-audit.mjs:1535` (`extractPlanPaths`) → `:1544`
(`classifyFiles`) → `:1778-1784` (scoped partitions) → `:1981-1995` (effective sets,
where the A1 guard sits) → passes read file contents via `readFilesAsContext`.
`scripts/lib/audit-scope.mjs` owns scope/context assembly (new `auditSubjectFileGuard`).
`scripts/lib/ledger.mjs:88` (`writeLedgerEntry` atomic write — A3 echo).
`skills/cycle/SKILL.md` Step 3 (A2). `skills/audit-code/references/r2-plus-mode.md` (A3 doc).

## 2. The fixes

### A1 (HIGH) — `/audit-code` must not emit a verdict over code it never read
The code auditor could run all passes with an EMPTY "All Implementation Files" block
(when `--diff`/`--changed` scoping matched none of the plan's files, or the plan's paths
don't resolve) and emit a confident SIGNIFICANT_ISSUES verdict + a hollow HIGH. This is
the "audit your success paths" rule applied to the auditor itself.
- **`auditSubjectFileGuard({scopeMode, subjectFileCount, hasFileFilter, foundCount, referencedCount})`**
  in `audit-scope.mjs` — pure predicate, returns a refusal message when 0 subject files
  would reach the prompt, else null. `full` scope exempt; `shared` files don't count as subject.
- Wired into `runMultiPassCodeAudit` BEFORE the passes spend money: `if (guardMsg) throw` →
  `main()`'s catch prints `Error: …` + exits 1 (fails loudly, no hollow result JSON).
- `--diff` that is unreadable now WARNS loudly (and detects the `base..HEAD` range-misuse)
  instead of being silently swallowed.

### A2 (MEDIUM) — `/cycle --autonomous` must not silently pause on a sub-§11 plan
A plan below the §11 threshold has no clustering block, and `--autonomous` only activated
the cluster loop when §11 existed — so `--autonomous` on a small plan silently fell back to
the human pause, contradicting the explicit flag. Added a **degenerate single-cluster**
branch (the whole plan as one implicit cluster: implement → audit union diff → fix-gate →
consolidated Gemini gate → ship), with a one-line up-front notice so it is never silent.

### A3 (LOW) — temp-path visibility on Windows/git-bash
`/tmp/...` in argv is MSYS-rewritten to `%LOCALAPPDATA%\Temp`, while a literal `/tmp/...` in
a follow-up `node -e` resolves to `C:\tmp` — divergent, and invisible. `writeOutput` already
echoes the resolved absolute path; `writeLedgerEntry` now echoes it on success too. A caveat
in the R2 reference tells the operator to read back the echoed absolute path, not reconstruct
`/tmp/...`, and clarifies `--diff` is a FILE paired with `--changed`.

## 3. Test

`tests/audit-subject-file-guard.test.mjs` (4 cases) unit-tests the A1 predicate (refuse on
scoped-0-files, refuse on no-resolved-files, allow when files present, full-scope exempt).
A2/A3 are a skill-flow change + an echo/doc change (no new deterministic seam to unit-test).
Full suite green.

## 4. Out of scope
Tier-2 (the "green ≠ realized" efficacy/cross-surface-agreement theme) is a separate
brainstorm + plan. These three are the unambiguous tooling fixes only.
