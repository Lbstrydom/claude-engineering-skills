---
summary: Proof oracle for any plan - what proves the change right, its pass condition, and the evidence the report shows.
---

# Proof oracle (every scope, not only frontend)

§10's Playwright criteria are an oracle for the UI only. A backend or full-stack plan that
names no oracle for its non-UI behaviour leaves the implementer to pick one after the
code exists, and the one picked afterwards is the one the code already passes.

## What §9 must state

One **Proof plan** line per behaviour change, written before implementation starts:

| Part | Content |
|---|---|
| Oracle | One of: a **red test** written first that fails for the stated reason and turns green; a **check against the source** of truth (the file, the store row, the log, the emitted request); a **repeatable calculation** (the command, its inputs, the expected figure). |
| Pass condition | The observable result that means "right": test names, the exact value, the exit code. |
| Evidence | What the final report will show: test names and counts, command output, commit sha. |

## Rules

- **The oracle must be able to fail.** If it would pass on the unfixed code, it proves
  nothing: run it red first, or add a negative control (`references/verification-discipline.md`).
- **Several behaviours get several lines**; do not write one line for the whole plan.
- **No oracle is a finding, not a blank.** A change with no possible oracle (pure
  prose, a rename) writes `Proof plan: none - <why>` so the absence is a decision.
- **Not a gate.** `/audit-code` reads the plan's proof lines as the rubric for
  "was it proven"; this file adds none of its own.
- The chip preamble's one-line `PROOF PLAN` (`/fleet`) is the digest of this section.
