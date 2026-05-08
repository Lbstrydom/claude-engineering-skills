# Plan: Adaptive Learning — Phase 2 (Live Quickfix Learner)

- **Date**: 2026-05-08
- **Status**: Draft (sub-plan; refines [`adaptive-learning-v1.md`](./adaptive-learning-v1.md))
- **Author**: Claude + Louis
- **Scope**: backend (js-ts; consumes audit-orchestration + learning-store domains)
- **Master plan**: [`docs/plans/adaptive-learning-v1.md`](./adaptive-learning-v1.md) — read for engineering principles (§4), sustainability (§5), risk register (§7), promotion gates (§5).
- **Dependency**: [Phase 1](./adaptive-learning-phase-1-foundation.md) MUST be merged + deployed first. This phase requires the `learning_decisions` table + `decision-logger.recordDecision()` API + `getWriteClient()` factory.

---

## 1. Phase Scope

Ship the **one live learner** in v1: per-repo quickfix pattern weights. This phase turns the existing `.audit/quickfix-hits.jsonl` telemetry into a learning loop that auto-disables noisy patterns.

1. **`quickfix-stats.mjs`** — Beta posterior on (pattern_id, repo). Loads from `learning_decisions` (canonical), writes derived `.audit/quickfix-pattern-stats.json` cache. `--rebuild` (cloud) and `--rebuild --bootstrap` (legacy git path).
2. **`quickfix-patterns.mjs` integration** — `matchPatterns()` reads cache synchronously (NO Supabase on hot path); skips low-acceptance patterns. Hook fires `recordDecision('quickfix_hit', ...)` with persisted state machine for outcome resolution.
3. **`backfill-outcomes.mjs`** — out-of-band reconciler that walks unresolved `quickfix_hit` decisions older than 30min, applies outcome based on current file state. Run by weekly cron + on-demand CLI.

**Explicitly out of phase**: replay framework (Phase 3), convergence_predict + arch_memory_band telemetry (Phase 3).

### Why this phase second
Quickfix is the cleanest reward signal in v1 (binary accept/suppress, hit-time outcome events) — proves the Beta posterior pattern works in a new domain before we build the heavier replay infrastructure in Phase 3.

---

## 2. Files Shipped This Phase

### Live learner
| File | Action | Notes |
|---|---|---|
| `scripts/lib/learning/beta-posterior.mjs` | NEW | Pure math: `betaPosterior(α,β)`, `thompsonSample({α,β})`, `updatePosterior({prior, observation})`. Same primitive as `bandit.mjs` (factored). |
| `scripts/lib/learning/cold-start.mjs` | NEW | Pure: `hasEnoughSamples({totalSamples, threshold})`, `withFallback(predict, fallback, samples, threshold)`. |
| `scripts/lib/learning/quickfix-stats.mjs` | NEW | Public API: `loadStats() → {patternName: {α,β,acceptanceRate,totalHits}}`, `shouldSkipPattern(...)`. CLI `--stats | --rebuild [--bootstrap]`. Reads from `learning_decisions` (decision_type='quickfix_hit') in steady-state. Writes `.audit/quickfix-pattern-stats.json` with `(max_outcome_at, total_row_count)` watermark. |

### Hook integration
| File | Action | Notes |
|---|---|---|
| `scripts/lib/quickfix-patterns.mjs` | EDIT | (1) `matchPatterns()` SYNCHRONOUS — `fs.readFileSync` on cache; trust for session; freshness via out-of-band reconciler. NO Supabase on hot path. (2) On hit: insert `learning_decisions` row immediately with `decision_key='quickfix_hit:<hit_id>'`, `outcome=null`. (3) Subsequent hook invocations check unresolved hits on the file and update outcomes (accept/suppress/ignore). (4) Respects `LEARNING_DISABLE=1`, `LEARNING_QUICKFIX=off`. |

### Backfill
| File | Action | Notes |
|---|---|---|
| `scripts/learning/backfill-outcomes.mjs` | NEW | Out-of-band outcome resolver. Pulls `learning_decisions` rows with `outcome IS NULL AND decision_type='quickfix_hit' AND created_at < now() - interval '30 minutes'`. Applies outcome detector based on current file state. Idempotent. CLI: stdout JSON summary `{processed, updated, skipped, errors}`; stderr progress logs. |
| `.github/workflows/learning-weekly-review.yml` | EDIT (extend) | Add a step that runs `npm run learning:backfill-outcomes` BEFORE the weekly review (so review reflects fresh outcomes). |
| `package.json` | EDIT | Add `learning:quickfix-rebuild`, `learning:quickfix-bootstrap`, `learning:backfill-outcomes` (all routed through `cross-skill.mjs`). |
| `scripts/cross-skill.mjs` | EDIT | Add subcommands `learning-backfill-outcomes` (delegates to backfill-outcomes.mjs). |

### Tests
| File | Action | Coverage |
|---|---|---|
| `tests/learning-beta-posterior.test.mjs` | NEW | Beta math: `betaPosterior(0,0)` uniform; `betaPosterior(10,2)` high mean; `thompsonSample` ∈ [0,1]; `updatePosterior` adds correctly. |
| `tests/learning-cold-start.test.mjs` | NEW | Threshold check; `withFallback` returns fallback below threshold. |
| `tests/learning-quickfix-stats.test.mjs` | NEW | `--rebuild` from synthetic learning_decisions rows; `--bootstrap` from synthetic .jsonl + git log; `shouldSkipPattern` threshold logic; cache round-trip; env opt-out. |
| `tests/learning-quickfix-hook.test.mjs` | NEW | `matchPatterns()` is synchronous (Function name check); persisted state machine — kill-and-resume scenario; outcome resolution via subsequent hook invocations OR backfill. |
| `tests/learning-backfill-outcomes.test.mjs` | NEW | Synthetic decision row + simulated git log → outcome correctly classified; null-outcome rows older than 30min picked up; rows newer skipped; idempotent against duplicate calls. |

---

## 3. Acceptance Criteria

(Subset of master §9 ACs that this phase ships.)

| ID | Criterion |
|---|---|
| AC7 | `scripts/lib/learning/beta-posterior.mjs` exports `betaPosterior`, `thompsonSample`, `updatePosterior` |
| AC10 | `quickfix-stats.--rebuild` correctly classifies hit→accept→suppress from synthetic data |
| AC11 | `matchPatterns()` skips a pattern with `acceptance < 0.20 AND total_hits >= 10` |
| AC12 | `LEARNING_QUICKFIX=off` AND `LEARNING_DISABLE=1` both bypass quickfix learner |
| AC17f | Quickfix outcomes emitted hook-time: edit-within-30min → accept, ignore-marker → suppress, line-removed → ignore, timeout → no_action |
| AC17n | Quickfix outcome resolved via persisted state — kill the hook process; subsequent hook invocation OR backfill correctly resolves outcome |
| AC17o | Cache freshness uses monotonic watermark `(max_outcome_at, count)` |
| AC17ii | `matchPatterns()` is fully synchronous: no Supabase queries, no async I/O on hot path |
| AC17bb | Partial index `learning_decisions_quickfix_unresolved_idx` exists (created by Phase 1 migration) and EXPLAIN shows usage |
| AC17mm | Hot-path index includes `outcome IS NULL` predicate; EXPLAIN shows index-only scan |
| AC24 | `backfill-outcomes.mjs` updates rows older than 30min; rows newer skipped; idempotent |

---

## 4. Test Plan

- Unit tests on pure functions (Beta math, cold-start, classifier) — no Supabase.
- Integration test: full hit → outcome → backfill loop against test Supabase project (or sqlite mode).
- Performance test: `matchPatterns()` latency p95 ≤ 50ms with cache file present.
- Existing tests stay green.

---

## 5. Dependencies on Other Phases

- **Upstream**: Phase 1 MUST be merged + deployed (schema + decision-logger + learning-store extensions).
- **Downstream**: Phase 3 reuses `beta-posterior.mjs` for replay framework but doesn't otherwise depend on Phase 2.

---

## 6. /cycle invocation

```bash
/cycle code docs/plans/adaptive-learning-phase-2-quickfix.md
```

Estimated effort: ~1 day implementation (most schema/wiring already done in Phase 1) + ~half-day audit/integration.
