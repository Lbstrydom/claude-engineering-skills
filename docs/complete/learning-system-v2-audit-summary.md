# Learning System v2 — Audit Summary

- **Plan**: docs/plans/learning-system-v2.md
- **Mode**: PLAN_AUDIT
- **Rounds**: 6 (max reached — not converged) + 2 Gemini final reviews
- **Date**: 2026-04-03

## Audit Trail

| Round | Verdict | H | M | L | Key Action |
|-------|---------|---|---|---|------------|
| 1 | SIGNIFICANT_GAPS | 11 | 1 | 0 | All accepted — EMA bug, timestamp data loss, FP granularity |
| 2 | SIGNIFICANT_GAPS | 6 | 5 | 1 | All accepted — dead backoff layers, missing persistence, prompt ownership |
| 3 | SIGNIFICANT_GAPS | 9 | 5 | 1 | Consolidated rewrite — PassEvaluationRecord, immutable revisions, MutexFileStore |
| 4 | SIGNIFICANT_GAPS | 7→4 | 5→7 | 1→2 | Deliberated (H5→LOW, H7 dismissed). 13 fixes applied |
| 5 | SIGNIFICANT_GAPS | 11→7 | 3→6 | 0 | Deliberated (H5→MEDIUM, H7 dismissed). 13 fixes applied |
| 6 | SIGNIFICANT_GAPS | 8 | 3 | 1 | Max rounds reached |
| Gemini R1 | REJECT | 3 | 2 | 0 | EMA/decay contradiction, experiment resurrection, FP migration data loss |
| Gemini R2 | REJECT | 2 | 3 | 0 | Task dedup, stale decay reads, rollback order, bandit decay mismatch |

## Convergence Analysis

Plan exhibits **finding churn**: each fix expands surface area, GPT finds new issues at boundaries. Plan grew from ~650 to ~1700+ lines over 6 rounds.

## Remaining Issues (Implementation-Level)

1. Concurrent mutation → use `mutate(fn)` under lock
2. Timestamp normalization → one-time migration on first load
3. Bandit alpha/beta decay mismatch → periodic discount factor
4. Store contract → consistent safeParse, not throw-then-check
5. Reward aggregation → pick one definition, delete the other
6. RemediationTask dedup → deduplicate by taskId on load
7. Suppression reads → apply lazy decay in-memory before evaluation
8. Rollback ordering → deactivate arm before abandoning revision

## Decision

**Option B accepted**: Implement full plan with known risks. Defer contextual bandits (hierarchical backoff by size/language) to v2.1. Resolve remaining findings during implementation + CODE_AUDIT.

## Cost

~$2.40 total (6 GPT rounds + 2 deliberations + 2 Gemini reviews)
