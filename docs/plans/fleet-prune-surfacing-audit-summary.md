# Audit summary: fleet prune surfacing (upstream 56773c7c)
- **Date**: 2026-10-13
- **Plan**: docs/plans/fleet-prune-surfacing.md

## /audit-code --scope diff: CONVERGED, round 3

Final: H:0 M:0 L:0. Rounds: 3 (R1 H:2 M:5; R2 and R3 PASS, 2/2 stable).

R1, triaged at 86% acceptance:
- H1 and H2 (same root cause): a failed status plan, or `prune --apply`, left
  the previous complete count readable as `ok`. Fixed: both now write an
  unmeasured record (`invalidatePruneCache`). A failed write is a warning. A
  negative age reads as unknown. The schema requires a parseable `at` and
  subsets that do not exceed their totals.
- M1 and M4: `upstreamGoneBranches` now runs through the deadline-clipped git.
  The orphan scan stays outside the deadline: it is a filesystem walk under its
  own entry caps.
- M2: content-on-base subsets carry the lower-bound prefix under a budget cut.
- M3: folded into H1.
- M5: dismissed. This was the adjacency wave's own enumeration cap, not a
  code defect.

Step 4.5: each of the six fixes, reverted alone, turned exactly its own test
red. Restored, they are green (19/19 in tests/fleet-prune-summary.test.mjs).

CENSUS (R3): structure, wiring, backend and sustainability completed.
frontend: ineligible (backend-only diff). Detector re-run: blocked:false,
0 detectors. File coverage: complete.

## Final gate (Gemini)

Round 1 APPROVE, round 2 APPROVE (cap). Both rounds report that 41 of the
changed lines, in one head-cut file, were never shown to Gemini. The APPROVE
covers what it examined. The GPT rounds had complete file coverage.
