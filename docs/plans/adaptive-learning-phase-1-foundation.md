# Plan: Adaptive Learning — Phase 1 (Foundation + Auto-Deferral + Weekly Review)

- **Date**: 2026-05-08
- **Status**: **Complete** — shipped as commit `0bde3ab` on 2026-05-08; schema migration applied 2026-05-09
- **Author**: Claude + Louis
- **Scope**: backend (js-ts; consumes audit-orchestration + learning-store + supabase domains)
- **Master plan**: [`docs/plans/adaptive-learning-v1.md`](./adaptive-learning-v1.md) — read for engineering principles (§4), sustainability (§5), and full risk register (§7). This phase plan covers only what THIS /cycle ships.
- **Dependency**: none. This is the first phase.

---

## 1. Phase Scope

Ship the **foundation layer** that all subsequent learning work builds on:

1. **Schema migration** — every column/table the master plan v1 needs (additive). Future phases extend code paths but not schema.
2. **`decision-logger` primitive** — the generic `recordDecision()` API + per-type bounded queues + environment-aware outbox.
3. **Auto-deferral + needs_triage classifier** — replaces mid-audit "defer this finding?" prompts with deterministic SCM evidence + class allowlist + scope-mode gate.
4. **Weekly review** — sticky GitHub issue (per-repo, capped at 7 items, 3 sections).
5. **`pass_selection` telemetry-only logger** — just collects data so future Phase 3 promotion has cold-start data ready.

**Explicitly out of phase**: the live quickfix learner (Phase 2), the replay framework (Phase 3), the convergence_predict + arch_memory_band telemetry hooks (Phase 3).

### Why this phase first
Auto-deferral + weekly review is the biggest user-facing improvement (no more per-finding prompts during audits). Schema + decision-logger are prerequisites for every future phase, so paying that cost up-front is unavoidable.

---

## 2. Files Shipped This Phase

### Schema
| File | Action | Notes |
|---|---|---|
| `supabase/migrations/20260508120000_adaptive_learning_v1.sql` | NEW | The full schema migration from master §6. All columns/tables/views/indexes/procs created here, even those used by later phases (cheap; additive-only). |

### Shared library
| File | Action | Notes |
|---|---|---|
| `scripts/lib/learning/decision-logger.mjs` | NEW | The keystone primitive. Per-type bounded sub-queues (cap 64/type, 5 types). Env-aware outbox: local FS spill or CI sync-retry. Single-object `recordDecision({...})` API. Sync `flush()` at audit-end + SIGINT + beforeExit. |
| `scripts/lib/audit/deferral-classifier.mjs` | NEW | Pure `classifyDeferralEvidence(finding, runContext) → {class, evidence, isDeterministic}`. Class allowlist (style/formatting/unused-import/etc.). Scope-mode gate (`--scope diff` only). Plan-marker parser `parseAcceptV1Markers()`. |

### Auto-deferral integration
| File | Action | Notes |
|---|---|---|
| `scripts/openai-audit.mjs` | EDIT | At triage step: replace any per-finding user-prompt with `classifyDeferralEvidence` → either `defer_finding` stored proc (deterministic+allowed class) OR `mark_finding_needs_triage` stored proc (everything else). Pre-wave: emit one `recordDecision('pass_selection', ...)` per audit run with `outcome=null`. Post-audit: backfill outcome with kept/dismissed counts. |
| `scripts/lib/stores/supabase-store.mjs` | EDIT | Add `getWriteClient()` factory using `SUPABASE_AUDIT_SERVICE_ROLE_KEY` (separate from anon `getClient()`). Required for writes to the new RLS service-role-only tables. |
| `scripts/learning-store.mjs` | EDIT | Add `insertLearningDecision(...)`, `backfillLearningOutcome(...)`, `reconcileOutbox()`, `recordDiffComplexity(runId, complexity)`, `recordConvergenceState(...)`, `recordFindingResolution(...)`, `callDeferFinding(...)`, `callMarkFindingNeedsTriage(...)`. All routed through `getWriteClient()` for service-role-only tables. |
| `scripts/cross-skill.mjs` | EDIT | New subcommands: `learning-record`, `learning-stats`, `learning-weekly-review`. |

### Weekly review
| File | Action | Notes |
|---|---|---|
| `scripts/learning/weekly-review.mjs` | NEW | Per-repo (`LEARNING_REPO_NAME` env required; aborts if missing). Pulls `pending_triage_findings` + `no_brainer_recommendations` + stale clusters. Section ordering deterministic; cap 7 (3+3+1 greedy fill). Posts/updates sticky GH issue label `learning-weekly-review`. CLI output contract: stdout JSON; stderr/`--out` markdown; `--format markdown` opt-in. |
| `.github/workflows/learning-weekly-review.yml` | NEW | Cron `0 9 * * 1`. Same auth + token pattern as `memory-health.yml`. Sets `LEARNING_REPO_NAME` from repo env. |
| `package.json` | EDIT | Add `learning:weekly-review` (routed via `cross-skill.mjs`), `learning:stats`. |

### Documentation
| File | Action | Notes |
|---|---|---|
| `AGENTS.md` | EDIT | New "Learning System (Phase 1)" section: env vars, opt-out (`LEARNING_DISABLE=1`), how to interpret weekly review, plan-marker syntax. Phases 2–3 will extend this section. |
| `README.md` | EDIT | One-line pointer to `npm run learning:stats` and weekly review issue. |

### Tests
| File | Action | Coverage |
|---|---|---|
| `tests/learning-decision-logger.test.mjs` | NEW | Per-type sub-queue caps; drop-oldest of same type only; env-aware outbox; sync flush; idempotent reconcile via `decision_key`. |
| `tests/learning-deferral-classifier.test.mjs` | NEW | Class allowlist (positive + negative per class); scope-mode gate (diff vs plan/full); plan-marker parser; deterministic-only auto-defer; ambiguous → null. |
| `tests/learning-weekly-review.test.mjs` | NEW | `LEARNING_REPO_NAME` required; per-repo filter; cap 7 with greedy fill; section ordering; stdout JSON contract; `--format markdown` opt-in. |
| `tests/learning-store-phase1.test.mjs` | NEW | `getWriteClient()` uses service-role; anon write to `learning_decisions` is RLS-rejected; `defer_finding` proc idempotency (call twice, occurrence_count = 1). |

---

## 3. Acceptance Criteria

(Subset of master §9 ACs that this phase ships. Numbering preserved for cross-reference.)

| ID | Criterion |
|---|---|
| AC1 | `audit_runs` columns added: `diff_complexity`, `round_converged_after`, `rigor_pressure_round` |
| AC2 | `audit_findings` columns added: `user_action`, `dismiss_reason`, `fix_commit_sha`, `time_to_resolution_ms` |
| AC3 | `recurring_finding_clusters` table exists with `UNIQUE(repo_id, cluster_hash)` + RLS service-role-only |
| AC4 | `learning_decisions` table with `decision_key text NOT NULL UNIQUE` + RLS service-role-only |
| AC4b/c/d | Composite UNIQUE allows audit-bound + off-audit; CHECK constraint enforces shape; CHECK on `user_action` includes `needs_triage` |
| AC5/6 | Views `no_brainer_recommendations`, `pending_triage_findings`, `persona_density_per_repo` exist with `WITH (security_invoker = true)` |
| AC8 | `decision-logger.recordDecision` validates input via Zod; rejects malformed |
| AC17a | `defer_finding` + `mark_finding_needs_triage` procs exist; `EXECUTE` revoked from PUBLIC/anon; service_role only; locked search_path |
| AC17e | `flush()` drains queue at audit-end + SIGINT; outbox spill (local) or sync-retry (CI) per env detection |
| AC17g | All package.json `learning:*` scripts route through `cross-skill.mjs` |
| AC17u/v | `getWriteClient()` exists; missing service-role env → graceful degrade (no crash) |
| AC17z | `defer_finding` populates `decision_key` in INSERT; `ON CONFLICT (decision_key) DO NOTHING` |
| AC17ee | `defer_finding` is idempotent — twice with same `(audit_run_id, round, sequence)` does NOT bump `occurrence_count` twice |
| AC17gg | Auto-deferral gated to `--scope diff` only |
| AC17hh | All 3 views use `WITH (security_invoker = true)` |
| AC17jj | Per-type sub-queues; high-frequency events cannot evict low-frequency events |
| AC17kk | Outbox env-aware (CI uses sync-retry, not disk) |
| AC17ll | `recurring_finding_clusters` upsert appends deduped `files_affected` |
| AC17cc | `weekly-review.mjs` requires `LEARNING_REPO_NAME`; per-repo filter on all 3 queries |
| AC17dd | `recordDecision` API is single-object signature only (grep + lint) |
| AC17w | `learning:*` CLIs emit JSON to stdout by default |

---

## 4. Test Plan

Per master §8 plus phase-specific scope. Unit-test runner: `node --test`.

- All new pure functions tested without Supabase (decision-logger validation, deferral-classifier, weekly-review formatting).
- Schema migration: applied to live Supabase via `supabase db push --include-all`; verified anon SELECT returns empty body (RLS works); `WITH (security_invoker = true)` shown in `pg_views`.
- Stored procedures: invoked via test harness with synthetic findings; idempotency + transactional boundary verified.
- Existing tests stay green (`npm test` exit 0 modulo pre-existing vendoring-provenance fail).

---

## 5. Dependencies on Other Phases

- **Upstream**: none.
- **Downstream**: Phase 2 + Phase 3 BOTH depend on Phase 1's schema, decision-logger, and learning-store extensions. They cannot ship without Phase 1.

---

## 6. /cycle invocation

```bash
/cycle code docs/plans/adaptive-learning-phase-1-foundation.md
```

Skip `/cycle plan` since the plan already exists. /cycle will run /audit-plan briefly (likely 1 round since most issues already resolved at the master level), wait for impl, then /audit-code + /persona-test (skipped — backend) + /ship.

Estimated effort: ~1.5–2 days implementation + ~half-day audit + integration.
