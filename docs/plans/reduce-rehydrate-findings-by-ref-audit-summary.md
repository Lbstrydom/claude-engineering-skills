# Audit summary: REDUCE decides by reference (upstream aa0298f2)

- **Plan**: [reduce-rehydrate-findings-by-ref.md](./reduce-rehydrate-findings-by-ref.md)
- **Date**: 2026-11-28
- **Base**: `067057e9`

## /audit-plan

SID `audit-plan-1795854519884-90992`, 2 rounds (requested cap).

| Round | Verdict | H | M | Accepted |
|---|---|---|---|---|
| R1 | SIGNIFICANT_GAPS | 4 | 3 | 6/7 (H1 dismissed: misread of the skills/** edit rule) |
| R2 | NEEDS_REVISION | 2 | 0 | 2/2 |

Final gate: gemini-4-argon, **APPROVE** (`approve`), 1 LOW wording nit, fixed.

## /audit-code

SID `audit-code-1795855358174-32056`, 6 rounds (the code-audit cap), `--scope diff`, then `backend,sustainability` R2+.

| Round | Verdict | H | M | Disposition |
|---|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 6 | 6 | 11 fixed, 1 dismissed (M6: adjacency wave's maxContainers bound, test files only) |
| R2 | SIGNIFICANT_ISSUES | 1 | 3 | all fixed |
| R3 | SIGNIFICANT_ISSUES | 1 | 1 | all fixed |
| R4 | SIGNIFICANT_ISSUES | 1 | 0 | fixed |
| R5 | SIGNIFICANT_ISSUES | 2 | 2 | fixed (R5 H1/H2 was a regression the R4 fix introduced) |
| R6 | SIGNIFICANT_ISSUES | 1 | 1 | fixed after the round; covered by the final gate below |

**Not converged by GPT's own threshold**: every round from R2 on raised a narrower combination of the
same seam (merge provenance × gating tags × unit span). Each was valid and fixed with a test; the round
cap stopped further GPT rounds, so the R6 fixes were reviewed by the final gate, not by a GPT round.

Final gate: gemini-4-argon, round 1 with `--batch` — **APPROVE** (`approve`, blocking 0, debt 0),
**Code coverage FULL** in both batches (4 changed files, every changed line shown). An earlier
unbatched round-1 call also returned APPROVE but with coverage PARTIAL (468 changed lines unshown), so
it is not counted as the gate.

## Census

| Identifier | State |
|---|---|
| structure, wiring, backend, frontend, sustainability | completed (R1); backend, sustainability (R2-R6) |
| quickfix, duplication | completed (R1) |
| adjacency | completed with an enumeration bound (R1 M6) |
| arch-memory | ineligible (`--scope diff`) |
| file coverage | completed (`_coverage.status: complete`, every round) |

## Proof

- Seam test `tests/reduce-rehydrate.test.mjs` — a >200-char MAP finding carrying every field survives
  REDUCE byte for byte. **Red at `067057e9`** (detail cut to 200 chars; unknown ref not detected), green after.
- Red-then-green also observed for the lossless identity collapse (revert → 2 tests red) and for
  append-not-replace provenance (revert → 1 test red).
