# Cross-skill data loop — table, column and view catalogue

Moved out of `AGENTS.md` (2026-08-01) under its progressive-disclosure rule.
What stayed resident there is the part that constrains every change — writes go
through `scripts/cross-skill.mjs`, never a hand-written curl POST. The
catalogue below is reference material: you consult it when wiring a new
reader or writer, not on every session.

Schema origin: migration `20260419120000_cross_skill_data_loop.sql`. Every
skill writes through `scripts/cross-skill.mjs`, which is a graceful no-op when
the cloud store is off.

> This is hand-maintained prose about a schema that migrations can change.
> When it disagrees with `supabase/migrations/**`, the migrations win — and fix
> the row here rather than leaving the contradiction.

## Tables

| Table | Writer | Reader | Purpose |
|-------|--------|--------|---------|
| `plans` | `/plan`, `openai-audit.mjs` | `/audit-plan`, `/audit-code`, `/ux-lock verify` | Register plan artefact, link audit_runs via plan_id |
| `regression_specs` | `/ux-lock`, `/ux-lock verify` | `/ship` | Record every Playwright spec authored (lock or verify mode) |
| `regression_spec_runs` | `/ux-lock`, CI | `meta-assess.mjs` | Per-run pass/fail history — `captured_regression=true` is a "save" |
| `persona_audit_correlations` | `/persona-test` | `bandit.mjs` | The highest-leverage table — persona P0/P1 ↔ audit finding ground-truth labels |
| `ship_events` | `/ship` | Dashboards | Outcome log: shipped / blocked / warned / overridden / aborted |
| `plan_verification_runs` | `/ux-lock verify` | `/ship`, dashboards | One row per verify invocation; totals for satisfaction % |
| `plan_verification_items` | `/ux-lock verify` | `/ship`, meta-assess | Per-criterion pass/fail with stable `criterion_hash` for time-series |
| `nav_audit_runs` | `/nav-audit` (static path) | dashboard drift aging | Run-history for `firstSeenFromHistory` — the >14-day governance smell needed real history, not just a gitignored local cache (`docs/plans/persona-nav-feedback-recovery.md` WS2) |
| `persona_finding_outcomes` | `cross-skill.mjs persona-outcomes label` | `/ship` UX gate, dashboard | Durable REPO-scoped (not session-scoped) fixed/dismissed/wont_fix/stale labels — `dismissed`/`wont_fix` close a finding across sessions; `fixed` that reappears re-flags as a regression (WS4) |

## Added columns

| Column | Table | Writer |
|--------|-------|--------|
| `commit_sha`, `branch`, `plan_id` | `audit_runs` | `openai-audit.mjs` in `runMultiPassCodeAudit` |
| `commit_sha`, `deployment_id` | `persona_test_sessions` | `/persona-test` Phase 6 |
| `click_path` (sanitized jsonb) | `persona_test_sessions` | `/persona-test` Phase 6 → `get-reachability-evidence` → `/nav-audit --bootstrap` seeds `personaIntents` (`source:persona-test-evidence`). URLs are origin-stripped + secret/PII-redacted by `sanitizeStepUrl` before storage. |

## Views

| View | Query for | Used by |
|------|-----------|---------|
| `audit_effectiveness` | User-visible precision + recall per repo | `meta-assess.mjs` (prompt evolution) |
| `unlocked_fixes` | Recent HIGH fixes without a /ux-lock spec | `/ship` Step 0.5b |
| `regression_saves` | Spec runs that caught a real regression | Dashboards |
| `ship_gate_effectiveness` | How often each block reason fires + override rate | Dashboards |
| `plan_satisfaction` | Latest verify run per plan + failing P0/P1 criteria | `/ship`, `/ux-lock verify` report |
| `persistent_plan_failures` | Criteria that have failed ≥2 consecutive runs | Meta-assess (chronic gaps) |

## Bandit reward extension

`computeReward(resolution, evaluationRecord, userImpact)` — when a
`persona_audit_correlations` row exists for a finding, the reward formula
shifts from 40/30/30 (procedural / substantive / deliberation) to 35/25/25/15,
with the user-impact term weighted by persona severity. See
`computeUserImpactReward()` in [`scripts/bandit.mjs`](../../scripts/bandit.mjs).

This is the point of the whole loop: a persona finding that corroborates an
audit finding is ground truth about user-visible impact, which nothing else in
the pipeline observes.
