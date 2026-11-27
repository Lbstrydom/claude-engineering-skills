# Audit summary: fleet lease orphaned waiters and priority

- **Plan**: docs/plans/fleet-lease-orphan-waiters-and-priority.md
- **Date**: 2026-11-27
- **Rounds**: 4 GPT rounds (cap 6) + final gate (2 rounds, Gemini)
- **Result**: NOT CONVERGED on GPT (R4: H4 M2, all fixed after the round); final gate APPROVE, 0 blocking, 0 debt

| Round | H | M | Fixed | Dismissed |
|---|---|---|---|---|
| R1 | 10 | 4 | 14 (H9 as a compromise: said once, never treated as gone) | 0 |
| R2 | 6 | 3 | 8 | 1 (H5: ppid 1 at start would falsely orphan runs under a pid-1 init) |
| R3 | 4 | 2 | 5 | 1 (M1: pidless after overflow is the conservative, bounded choice) |
| R4 | 4 | 2 | 5 | 1 (H2: equal-rank eviction among highs keeps priority enforced) |

Every fix that came with a new test was proven red by reverting the fix alone, then green on restore (17 reverts, all RED).

The rounds narrowed from core defects (R1: runner identity, launcher checked only after a refusal, a timer left running) to
mixed-version and Windows pid-reuse edge cases (R3/R4). The audit was stopped at R4 per the rigor cap rather than run to the
round limit; R4's findings are fixed but were not re-audited by GPT.

Final gate: round 1 APPROVE over PARTIAL code coverage (7 of 10 files head-cut); round 2 re-scoped to the three core source
files (`lease-model.mjs`, `lease-run.mjs`, `lease.mjs`), Code: FULL, APPROVE.

Census: passes structure/wiring/backend/frontend/sustainability completed in R1 (file coverage complete); R2-R4 ran
backend + sustainability over the changed files; arch-memory ineligible (--scope diff).
