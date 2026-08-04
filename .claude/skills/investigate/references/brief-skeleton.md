---
summary: Copy-paste brief template for delegating an investigation to a sub-agent or fresh session.
---

# Investigation brief skeleton

Use when the investigation will be run by someone (or something) that does not
share this conversation's context. Fill the bracketed parts; keep the unbracketed
lines close to verbatim — they are the load-bearing ones.

The single edit that matters most: **TASK 2 asks for a quantity and a justified
method, never for a named command.** That is the line that would have caught both
2026-08-03 failures.

```text
CONTEXT
[The claim, verbatim. Where it currently comes from. Why it is being checked now.]
[What is already known and verified, so the agent does not re-derive it.]

PRE-AUTHORISATION
A negative, null or contradictory result is a legitimate and reportable outcome.
I would rather narrow a claim than defend an inflated one. If the evidence does
not support the claim, say so plainly and recommend the narrower version.

TASK 1 - Establish what is actually in question
Identify which measurement, event or object the source actually refers to. Do
not assume the obvious reading. Report what you determined and how.
[State any premise of this brief you want confirmed rather than assumed.]

TASK 2 - Measure or locate it
Choose the method. State which method you chose and why. Cross-check with a
second independent method - one that does not share an input with the first.
Reconcile any disagreement and report it even if you resolve it.
Capture raw output verbatim, including failures and retries, in the order
issued, to [path whose date you determine at run time].
State what result would demonstrate the instrument was working, and capture it.

TASK 3 - Report, without softening
[Direct questions, numbered, each answerable in a sentence.]
Label any figure not traceable to a captured command as such.
Where the evidence does not settle a question, say it does not settle it. Do
not supply a plausible inference in place of a missing record.

TASK 4 - Recommend
Recommend a position and justify it. Any options listed are illustrative, not
exhaustive. If the honest answer is a split or something not listed, say so.

CONSTRAINTS
- [Read-only scope, or exactly what may be written.]
- Clean up only the artefacts this task created, by name. No general prune.
- Do not infer causation from chronological proximity.
- Absence of a recorded rationale is a finding, not a gap to fill.
- [Name the specific cheat paths this task opens. See below.]
- Report disk, time or cost headroom before starting if the task consumes any.
- If history was rewritten, squashed, or the record is otherwise unavailable,
  say so explicitly rather than working around it.
```

## Naming the cheat paths

Generic rigour instructions do nothing. The constraint has to name the specific
way *this* task could be silently corrupted. Examples that earned their place:

- "Do not adjust the figures to match a fresh build." — the task was reproducing
  a historical measurement; rebuilding is the easy way to get a clean number
  that answers a different question.
- "Do not substitute a different commit or patch the old file to make it build."
  — the historical build was expected to fail; making it succeed destroys the
  measurement.
- "Absence of a recorded rationale is a finding, not a gap to fill with a
  plausible one." — the most important of the three. Intent cannot be recovered
  from a diff, and a confabulated rationale is indistinguishable from a recorded
  one in the output.

## Naming the fallacy

Not "be careful about causation" — the actual trap this question sets. In the
provenance investigation, two commits one day apart were driven by unrelated
goals, and the lazy read merged them. The useful line was:

> Do not infer causation from chronological proximity.

## Where this came from

Distilled from consolidated feedback on two 2026-08-03 briefs (a Docker
image-size verification and a multi-stage build provenance dating). Both briefs
returned correct answers despite prescribing a method that fails silently on the
question asked. The pattern was extracted from those failures afterwards, not
designed up front.
