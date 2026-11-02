---
summary: Step 3 rubrics in full — same-file independence (column/constraint + transaction) and the honest-deferral check.
---

# Triage rubrics — Step 3 detail

## Same-file independence

**Same-file independence needs more than "doesn't call it" (measured
2026-09-25 — don't re-loosen this).** 234 open `out-of-scope` debt entries
accumulated in this repo, several audit runs each mass-deferring 19-46
same-file findings with the identical boilerplate "unrelated to `<new
function>`... verified zero coupling." That answers direct call-graph
coupling, not the load-bearing test above — a same-file finding can share
state or a transaction with the new code without either calling the other.
When the finding's file is one the diff already touches, "my new/modified
code doesn't call this function" is **not sufficient on its own**. The
independence sentence must additionally state, truthfully, BOTH: (a) the
cited code does not read or write the SAME column(s), or enforce/depend on
the SAME constraint or invariant, that the new/modified code also reads,
writes, or depends on — sharing a *table* alone is not sufficient, the
overlap must be at the column/constraint level; and (b) the cited code's
writes do not execute inside the SAME transaction instance the new/modified
code's writes participate in — sharing a broader boundary (the same
request, the same file, the same subsystem) alone is not sufficient. If
either cannot be stated truthfully, the finding is load-bearing, not
independent, regardless of whether anything calls it. This is checkable
against real code (grep the column names, read the transaction boundary),
not a judgement call. **This does not mean the prose test alone catches
every mass-defer batch** — a same-file finding can be genuinely independent
by this exact test (e.g. two functions in one file that share neither state
nor a transaction) and still be part of a batch worth a second look purely
for its size; `debt-auto-capture.mjs`'s same-file-batch WARN (Step 3.6)
covers that separate, batch-shape signal.

## Honest-deferral check

**Honest-deferral check (Design right-sizing, AGENTS.md — the band-aid escape
hatch).** `defer` is the place "patched the easy way" hides. A `defer` of a
`valid` `in-scope` finding must name three things: (1) the **root cause**;
(2) the **minimal in-scope fix you considered and rejected**; (3) the **residual
risk**. A `defer` of an `out-of-scope` finding must additionally name the
**independence** — for a same-file finding, both parts of the test above
(no shared column/constraint, no shared transaction instance); for any other
out-of-scope finding, one sentence stating the new code does not call/depend
on the cited path. If you can't write it truthfully, it's load-bearing →
`fix-now`. Invariant: **never `defer` because
the correct fix is merely larger** — size is not scope, and neither is
authorship. Legitimate `defer` = a true (impact-tested) scope boundary or
explicitly accepted, documented debt. Strongest form: drop a `TODO` at the cited
line naming the root cause, so the dodge becomes a visible artifact. (The
over-engineering cliff is caught symmetrically by Gemini's `over_engineering_flags`
in the final review.)
