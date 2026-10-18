---
summary: Pivot rule - findings recurring in one file or concern for 3 consecutive rounds mean rethink the design, not loop.
---

# Pivot rule - an earlier exit with a rethink

The cap (6 rounds) and the stability test (2 stable rounds) both answer "when do I stop
looping". Neither answers "this is not converging because the design is wrong". Fixing
what a round found, then finding the same area again, is a loop the cap only ends
late, with whatever is still open. The pivot rule ends it early and asks for a different
design. It adds an exit; it does not change the cap or the convergence test.

## Trigger (mechanical)

After Step 3 triage of round N >= 3, stop if **in each of rounds N-2, N-1 and N** at least
one **accepted** finding (not dismissed, not a mechanical-only one) lands in the same area:

- the same file in `affectedFiles`, **or**
- the same concern: a finding carrying `sameConcernAs` an earlier one (ledger-format.md),
  or sharing its `_hash` family.

A dismissed false positive does not count: that is churn the ledger already suppresses.

## Action

1. **Do not start round N+1.** Do not ship with the findings open either.
2. Write a short **Pivot note**: the file or concern; one line per round on what was
   found and fixed; why the current design keeps producing it (a responsibility in the
   wrong place, state with two writers, a boundary that leaks).
3. Propose **one or two different designs**, the simplest first: remove the
   responsibility, move the boundary, make the invalid state unrepresentable. A
   design that adds a guard on top of the same shape is the loop again.
4. Present the note to the user (under `/cycle --autonomous`, end the turn with
   "pivot proposed" and the note). The user chooses: rework, or continue to the cap.
5. A rework is a **new audit run**: fresh session id, round 1, its own 6-round cap and
   its own pivot counter (rounds are counted per run; the cap never carries over). Pass
   the same ledger file, so earlier dismissals and deferrals keep suppressing re-raises.
   If the user instead continues the current run, the counters are unchanged and the
   6-round cap still applies.

Step 7 (Gemini final review) still follows the last round that ran.

## Why

Two cases from 2026-10-18 in the wine-cellar app:

- **B3c**: four audit rounds on the same area, then a simplified rework converged. Had
  the recurrence held from round 1, this rule would have fired after round 3 and asked
  for the rework a round earlier.
- **baseline-permissions**: still being audited on round 5, one round short of the cap.

In both, the recurrence was the signal; the cap only forced a decision at the end.
