# Plan-audit learning parity + AGENTS.md sprawl cap

- **Status**: Complete
Date: 2026-07-13

## Context

The user asked whether the audit-code improvements (round-verbosity
management etc.) also apply to audit-plan. A code trace showed most of the
machinery is already shared (both modes drive `openai-audit.mjs`: R2+
rulings injection, R2 prompt modifier, post-output `suppressReRaises`, plus
plan-only `PlanFpTracker` pre-output suppression). Two genuine asymmetries
were found and are closed by this batch, and a third, separate request —
"does anything catch AGENTS.md sprawl in /ship?" (answer was NO) — is
closed alongside.

## Changes

### Gap 1 — plan audits now reach the cloud learning store

- `audit_runs.mode` had `CHECK (mode IN ('plan','code'))` from the original
  migration, but the plan branch never created a run row — plan-audit triage
  outcomes only ever fed the LOCAL PlanFpTracker; the learning loop had zero
  plan-audit ground truth.
- New `scripts/lib/audit/plan-audit-cloud.mjs`:
  `registerPlanAuditRun` (repo identity via `resolveRepoForStore`,
  commit/branch anchor, `upsertPlan` linkage, `recordRunStart(mode='plan')`,
  run-unification via `--run-id`) + `completePlanAuditRun` (post-suppression
  `recordFindings(pass='plan')` + `recordRunComplete`; deliberately does NOT
  write `gemini_verdict` — that column belongs to the Step-7 gate). Both
  best-effort, never-throw, cloud-off → nulls.
- `openai-audit.mjs` plan branch: registers the run AFTER the arm-eval
  shadow block and only when `!result._cloudRunId` (one plan audit → one
  audit_runs row even when the concluded arm-eval experiment is re-enabled),
  stamps `result._cloudRunId` before the `--out` write.
- `finalizePriorRoundOutcomes` MOVED from `legacy-production-audit.mjs` to
  the shared `lib/finalize-outcomes.mjs` (it was already mode-agnostic);
  the plan branch now calls it at the start of every R2+ invocation — the
  identical deterministic outcome capture the code orchestrator runs. The
  manual final-round fallback is the existing mode-agnostic
  `write-code-outcomes.mjs`.
- `skills/audit-plan/SKILL.md`: new Step 3.5b documenting automatic capture
  + the two manual fallback CLIs (cloud labels via write-code-outcomes;
  local PlanFpTracker via write-plan-outcomes — two stores, two purposes).

### Gap 2 — requirements rubric in the plan-audit prompt

- New `getPlanRequirementsRubric(planContent, {baseDir, allowInfraFiles})`
  in `scripts/lib/requirements/context.mjs`: derives targetPaths from the
  plan's own referenced files (`extractPlanPaths().found` — existing files
  only) and delegates to `getRequirementsContext`. A plan that touches a
  file governed by an active de-facto invariant now gets that invariant
  surfaced at DESIGN time.
- Plan branch injects the resulting `<requirements_rubric>` block into the
  prompt (after the T0 inventory, before rulings); non-blocking on any
  failure; honors `--allow-infra-scope`.
- `skills/audit-plan/SKILL.md` documents it (same "automatic, no flag"
  contract as the code audit's rubric).

### AGENTS.md sprawl cap + first enforcement-driven trim

- `check-context-drift.mjs` (run by the pre-push hook + /ship Step 4 via
  `npm run context:check --strict`): new `ctx/oversized-agents-md` rule
  (`maxAgentsMdLines`, default 1200, config-overridable) — fires for ANY
  AGENTS.md, paired or standalone. Previously only CLAUDE.md had a size
  check; AGENTS.md had silently grown to 1412 lines.
- First trim (1412 → ~1150), no information deleted — dossier sections
  moved verbatim to docs with what/when/pointer stubs left behind:
  - Model Swap-In Evaluation Harness → `docs/runbooks/model-eval-harness.md` (new)
  - Pre-ship empirical verify worked detail → `docs/runbooks/pre-ship-empirical-verify.md` (new)
  - Tiered-recall shadow wiring history → appended to
    `docs/completed/tiered-recall-audit-pipeline.md` (addendum)
  - Consumer-sync mechanics (why-isolated, what-sync-writes table,
    key modules) → `docs/runbooks/consumer-adoption.md` §"Sync internals"
  - Inline `scripts/` tree in Architecture DELETED as stale duplication
    (listed 2 test files vs 100+ real; `docs/architecture-map.md` is the
    live generated index) — replaced with a one-line layout note.
  - Secret pre-write gate + quickfix-detection sections compressed in
    place (invariants kept; mechanics summarized with pointers).
  - Removed a duplicated PERSONA_TEST_* env-table row pair.

## Tests

- `tests/plan-audit-cloud.test.mjs` (new, hermetic AUDIT_DB_URL=''):
  cloud-off → nulls, never throws; malformed input → silent no-op.
- `tests/requirements-context.test.mjs`: +2 for `getPlanRequirementsRubric`
  (governed-file in-scope w/ `allowInfraFiles` passthrough; absent ledger
  degrades).
- `tests/check-context-drift.test.mjs`: +3 for `ctx/oversized-agents-md`
  (paired repo, AGENTS-only repo, under-cap negative).
- Full suite: 5027 passed, 0 failed, 20 pre-existing skips.

## Audit trail

`/audit-code --scope diff --allow-infra-scope` (this batch IS audit-tool
infrastructure) round 1, GPT: SIGNIFICANT_ISSUES, 39 findings (H:15 M:22
L:2). Full per-finding rationale in the round's adjudication ledger;
summary:

- **13 dismissed (H1,H4,H6-H13,M7,M9,M11) — out-of-scope historical plan
  text**: these audited the ALREADY-SHIPPED tiered-recall pipeline's own
  design text (phases 6-12), pulled into `--scope diff` only because this
  batch appended a short addendum to the completed plan doc. Independence
  verified: this batch changes none of the cited designs.
- **6 fixed**: H5 (audit-plan's Step-6 gate wording now matches the
  no-silent-skip 4-step degradation ladder), H14+H3 (a fully-silent
  `recordFindings` failure now logs loudly — a failed insert previously
  produced a complete-looking, zero-findings run with no diagnostic), M1
  (stale `SUPABASE_AUDIT_URL` → `AUDIT_DB_URL`), M2 (`registerPlanAuditRun`
  now defaults its parameter — a no-arg call previously threw
  synchronously, before the try block, violating the never-throws
  contract), M8 (SKILL.md now documents `--run-id` unification across
  rounds).
- **3 fixed by documentation**: M5 (the `baseDir`-vs-`cwd` root-resolution
  asymmetry in `getPlanRequirementsRubric` is now an explicit contract),
  M13 (the planned-but-not-yet-created-file blind spot is now a stated
  contract — invariants for such files surface at code-audit time
  instead), M16 (destructure-guard regression tests added).
- **18 deferred, all with independence rationale**: H2 (SKILL.md
  placeholder convention, repo-wide, unchanged by this batch); M3/M6/M10/
  M12/M14/M15 (pre-existing `getRequirementsContext` internals — this
  batch added only a thin delegating wrapper); M4 (testing-doctrine
  boundary — enabled-cloud round trips are deliberately not mocked; the
  real write path was verified live against Supabase this session); and
  H15/M17-M22/L1/L2 (pre-existing domain-map/architecture-intent drift —
  the third audit in a row surfacing this exact family; a dedicated
  domain-map reconciliation pass is now a flagged candidate task).

Step 7 Gemini final review: **APPROVE**, 0 new findings, 0 wrongly
dismissed, `deliberation_was_fair: true`. Quote: *"GPT flagged a large
volume of issues... but significantly over-indexed by auditing the
contents of a historical plan document that was merely appended in this
PR. Claude correctly recognized these as out-of-scope... while taking
accountability for genuine new defects."*

39/39 findings' outcomes recorded to the cloud learning store. Full suite
re-confirmed green after fixes: 5028 passed, 0 failed, 20 pre-existing
skips.
