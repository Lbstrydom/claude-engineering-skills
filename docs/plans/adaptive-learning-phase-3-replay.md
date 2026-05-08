# Plan: Adaptive Learning — Phase 3 (Replay Framework + Remaining Telemetry)

- **Date**: 2026-05-08
- **Status**: Draft (sub-plan; refines [`adaptive-learning-v1.md`](./adaptive-learning-v1.md))
- **Author**: Claude + Louis
- **Scope**: backend (js-ts; consumes audit-orchestration + learning-store + arch-memory domains)
- **Master plan**: [`docs/plans/adaptive-learning-v1.md`](./adaptive-learning-v1.md) — read for engineering principles (§4), sustainability (§5), promotion gates (§5), risk register (§7).
- **Dependency**: [Phase 1](./adaptive-learning-phase-1-foundation.md) MUST be merged + deployed. [Phase 2](./adaptive-learning-phase-2-quickfix.md) is recommended but not strictly required (Phase 3 reuses `beta-posterior.mjs`).

---

## 1. Phase Scope

Ship the **graduation infrastructure** that lets future v2 candidates promote from telemetry-only to live without a 3-month wait:

1. **`replay.mjs` framework** — offline counterfactual evaluation engine. Reads `learning_decisions`, applies a candidate policy fn, computes counterfactual reward distribution vs baseline.
2. **`replay.mjs` CLI** — `npm run learning:replay <decision_type>`.
3. **`convergence_predict` telemetry** — per-round `recordDecision` in `openai-audit.mjs` capturing round/findings/delta-pattern. Outcome backfilled at audit-end.
4. **`arch_memory_band` telemetry** — `recordDecision` in `neighbourhood-query.mjs` capturing similarity/band/intent. Outcome backfilled by `backfill-outcomes.mjs` (already shipped Phase 2) extended with arch-memory detector (re-import within 30min).

**Explicitly out of phase**: actually graduating any of these to live (that's v2 — gated by §5 promotion criteria + persona density per repo).

### Why this phase last
Replay framework requires real `learning_decisions` rows to be useful — Phase 1 starts collecting `pass_selection` data; Phase 2 starts collecting `quickfix_hit` data; Phase 3 adds the remaining two telemetry streams + the engine that consumes them. Building replay before there's data to replay is wasted effort.

---

## 2. Files Shipped This Phase

### Replay engine
| File | Action | Notes |
|---|---|---|
| `scripts/lib/learning/replay.mjs` | NEW | Public API: `replay({decisionType, sinceMs, candidatePolicy, baselinePolicy, rewardFn}) → {baselineDist, candidateDist, deltaSummary}`. Reads `learning_decisions` rows; for each, runs both policies on historical context; computes counterfactual reward stats. Pure given fixture rows. |
| `scripts/learning/replay.mjs` | NEW | CLI wrapper. Args: `<decision_type> [--policy <module>] [--since <duration>] [--repo <name>] [--format json\|markdown]`. Default policy: built-in baseline that mimics current hardcoded behavior. Stdout JSON by default; `--format markdown` for human comparison table. Stderr progress. |

### Telemetry hooks
| File | Action | Notes |
|---|---|---|
| `scripts/openai-audit.mjs` | EDIT | After each round's findings settle: `recordDecision({decisionType: 'convergence_predict', repoId, auditRunId, round: N, sequence: 0, context: {round, currentFindings, deltaPattern}, choice: {chose: 'continue'}, outcome: null})`. Post-audit: backfill outcome `{converged_at: round, hit_max: bool, hit_rigor_pressure: bool}` for all this run's convergence_predict rows. |
| `scripts/lib/neighbourhood-query.mjs` | EDIT | After `recommendationFromSimilarity()` returns its band: `recordDecision({decisionType: 'arch_memory_band', repoId, externalId: <hit_id>, context: {similarity, sym, intent}, choice: {band: rec}, outcome: null})`. No behavior change to recommendation logic. |
| `scripts/learning/backfill-outcomes.mjs` | EDIT | Extend with detector for `arch_memory_band`: scan git log for re-import vs new-symbol within 30min of decision_at; classify `reuse-correct` / `wrong-fork` / `extend-correct` / `uncertain`. Also extend with detector for `convergence_predict` if not already covered by openai-audit's post-audit backfill. |
| `scripts/cross-skill.mjs` | EDIT | Add subcommand `learning-replay`. |
| `package.json` | EDIT | Add `learning:replay` (routed through `cross-skill.mjs`). |

### Tests
| File | Action | Coverage |
|---|---|---|
| `tests/learning-replay.test.mjs` | NEW | Given fixture `learning_decisions` rows + a candidate policy, replay returns expected counterfactual distribution; baseline-vs-candidate delta correctly summarised; empty input returns degenerate-but-valid result; `--format markdown` produces comparison table. |
| `tests/learning-convergence-telemetry.test.mjs` | NEW | Per-round `recordDecision` fires correctly; outcome backfill at audit-end populates expected fields; idempotent if backfill runs twice. |
| `tests/learning-arch-memory-telemetry.test.mjs` | NEW | `recordDecision('arch_memory_band', ...)` fires once per neighbourhood query; off-audit decision_key format `arch_memory_band:<hit_id>`; backfill detector classifies outcomes correctly given synthetic git fixtures. |

---

## 3. Acceptance Criteria

(Subset of master §9 ACs that this phase ships.)

| ID | Criterion |
|---|---|
| AC9 | `scripts/lib/learning/replay.mjs` exports `replay` and returns expected counterfactual distribution on fixture |
| AC14 | `recordDecision('convergence_predict', ...)` fires once per round; rows appear with correct `audit_run_id` |
| AC15 | `recordDecision('arch_memory_band', ...)` fires once per neighbourhood query |
| AC23 | `npm run learning:replay <decision_type>` produces a comparison report from fixture data |
| AC17h | `learning_decisions` outcome backfill is idempotent — running backfill twice produces same final state |
| AC17i | `decision_key` audit-bound format `<run>:<type>:r<round>:s<seq>`; off-audit format `<type>:<external_id>` (verified for arch_memory_band) |
| AC17j | CHECK constraint `decision_key_audit_or_external` rejects rows missing both audit fields AND external_id |
| AC17w | `learning:replay` CLI emits JSON to stdout by default; `--format markdown` opt-in |
| AC17x | Stdout JSON schema for `learning:replay` documented in module JSDoc + Zod-validated in tests |

---

## 4. Test Plan

- Unit tests on `replay()` with fixture rows — no Supabase.
- Integration test: full telemetry pipeline (decision recorded → outcome backfilled → replay reads).
- Existing tests stay green.

---

## 5. Dependencies on Other Phases

- **Upstream**: Phase 1 MUST be merged. Phase 2's `beta-posterior.mjs` and `backfill-outcomes.mjs` are reused/extended.
- **Downstream**: enables v2 promotion of pass_selection / convergence_predict / arch_memory_band live learners (out of v1 scope; gated per master §5).

---

## 6. /cycle invocation

```bash
/cycle code docs/plans/adaptive-learning-phase-3-replay.md
```

Estimated effort: ~1 day implementation + ~half-day audit/integration.

---

## 7. After Phase 3 — what's needed for v2 promotion

This phase ships the LAST piece needed before any deferred learner can graduate. Per master §5 promotion gates:

1. ≥30 days of `learning_decisions` data with `outcome` populated for the target decision_type
2. `npm run learning:replay <decision_type>` shows the candidate policy meets type-specific bar (recall loss, precision lift, etc.)
3. For `pass_selection` only: per-repo `persona_density_per_repo.density_30d >= 4`
4. Hard floors apply when promoted (sentinel passes never skipped, arch_memory band ≥ 0.85 reuse floor)

Phase 1 + 2 + 3 land all the data collection + evaluation infrastructure. v2 work is then write-a-candidate-policy + replay-validate + flag-flip — a 1–2 day job per learner.
