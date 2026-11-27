# Audit summary: fleet train landing friction

- **Plan**: docs/plans/fleet-train-landing-friction.md
- **Date**: 2026-11-27
- **SID**: audit-code-1795795620925-81956

## Rounds (GPT, `openai-audit.mjs code`)

| Round | Scope | Verdict | H | M | L | Outcome |
|---|---|---|---|---|---|---|
| 1 | diff (whole change) | SIGNIFICANT_ISSUES | 13 | 13 | 1 | 23 fixed (heavy cross-pass duplication); H6/M7 overruled in deliberation (CES runner has no policy guard by design); H5 compromise |
| 2 | R2+ over the R1 fixes | SIGNIFICANT_ISSUES | 3 | 2 | 0 | all 5 fixed |
| 3 | R2+ over the R2 fixes | SIGNIFICANT_ISSUES | 1 | 1 | 0 | H1 overruled in deliberation; M1 compromise (owner decision, below) |

Threshold after round 3 deliberation: H:0, M:1 (≤2), quickFix 0. Stopped at 3 rounds (no real defect in round 3).

## What the audit changed in the design

- **Outcome provenance** (R1 H1/H8/H13): the classification marker is never read from the tier's output. Fleet names a
  per-attempt `FLEET_TEST_OUTCOME_FILE`; the runner writes it and scrubs the variable from its tests.
- A targeted rerun never replaces the first attempt's kind (R1 H2/H10); a timeout guard outranks every count, an
  instrument guard outranks a null count (R1 H7/M8/M11, R2 H2).
- After a failed process reap: no rerun, no next tier, never accept-guard eligible, and a train with an unrun pre-land
  tier is recorded `none` (R1 H5, R2 H1/M1).
- Approval substitutes the aggregate red only when every recorded red is an accepted guard (R1 H11).
- Ancestry ordering: equal commits are no edge; asking stops after one timeout (R1 H3/M6/M1).

## Remaining (accepted)

- **R3 M1 — owner decision**: a GREEN tier whose process reap failed stays approvable, as at 888b11e5. Making that block
  approval is a stricter gate change, left to Louis (plan gate box).

## Final gate (Step 7)

`gemini-review.mjs` round 1: **APPROVE**, gate `approve` (blocking 0, debt 0), model gemini-4-argon. Coverage note from
the reviewer: **Code: PARTIAL, 696 changed line(s) never shown** — the APPROVE covers the code it was shown.

## Census (round 3)

| identifier | state |
|---|---|
| backend | completed |
| sustainability | completed |
| structure, wiring, frontend | ineligible (R2+ pass selection: backend + sustainability only) |
| arch-memory | ineligible (--scope=diff) |
| file coverage | completed (R1 `_coverage.status: complete`) |
| final gate | completed (APPROVE; code coverage partial) |
