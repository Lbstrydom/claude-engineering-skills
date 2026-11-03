---
summary: Why the stop rules are what they are — acceptance-rate evidence, Gemini-cap rationale, outcome-recording fallback.
---

# Convergence evidence and outcome-recording fallback

`SKILL.md` keeps the decision tables. This file holds the measurements behind them
and the rarely-needed manual fallback for Step 3.5b.

## Why acceptance rate, not finding count (Step 3)

**Plan audits have infinite refinement surface** — after round 2-3, findings
shift from "real design bugs" to "push for more rigor".

**A rising HIGH count is NOT a stop signal on its own.** Fixing round N's
findings CREATES new specified surface that round N+1 legitimately audits: R2's
findings are largely propagation debt from R1's fixes (stale cross-references in
older sections), R3's are net-new surface from R2's. Measured 2026-08-08 on a
large plan: H:5 → H:5 → H:6 across three rounds, with **23 of 23 findings
accepted as fix-now — zero dismissals, zero deferrals, zero rebuttals** — and
the independent Gemini gate scoring the deliberation "exemplary… no false
positives". The old count rule said STOP after R2. It would have been wrong.
A raw count cannot distinguish "the auditor is reaching" from "the plan is
growing correct detail"; the acceptance rate can.

## Why the Gemini gate is capped at 2 rounds (Step 6)

The Gemini gate has the **same infinite-refinement surface** as the GPT loop:
on a detailed plan it yields ~1–3 new edge findings *per round indefinitely*,
and the verdict drifts from design defects → praise + implementation-completeness
nits ("you didn't specify the store step / where the cooldown goes"). That is
the **stop signal**, not a reason to run again.

This mirrors the GPT cap (3 rounds default, 5 absolute, extended only while the
acceptance rate stays high): cap by default; a concrete net-new *design* bug after
round 2 goes to the user, never to a third round, and never for rigor pressure or
implementation detail.

## Why `--run-id` matters (Step 6)

Without `--run-id` the review still runs and simply records no verdict — measured
2026-08-14, 0 of 55 plan runs had one against 45 of 178 code runs. The value is
`_cloudRunId` on the last round's result artifact; when cloud is off it is absent
and the flag is dropped.

## Step 3.5b manual fallback (only after a `[finalize] WARN` line)

`write-ledger-entries.mjs` labels each round automatically. Only if a
`[finalize] WARN` line appeared, run (`--result` is the round's result, `--ledger`
the ledger from Step 3.5 — rulings must already be in it):

```bash
ROUND=2   # the round number just completed
node scripts/write-code-outcomes.mjs --result ".audit/$SID-r$ROUND-result.json" --ledger .audit/$SID-ledger.json --round "$ROUND"
```

`labelled: 0` with a non-zero `total` is a failure to fix, never a pass: the
ledger had no rulings, or they did not join the findings. (The CLI is
mode-agnostic — plan findings carry `pass: 'plan'`.)

> **Run unification**: to attach all rounds to one `audit_runs` row, mint one
> id up front and pass the SAME `--run-id <uuid>` every round (as the code audit
> and `/cycle` do). The run's accepted/dismissed counts are recomputed
> run-wide, so shared and per-round rows both read correctly.

The LOCAL PlanFpTracker recording (`write-plan-outcomes.mjs`) is NOT part of this
fallback — it runs every round and is in `SKILL.md` Step 3.5b. Two stores, two purposes: the cloud labels feed effectiveness metrics /
FP-learning / prompt evolution; the PlanFpTracker feeds the pre-output
recurring-finding suppression specific to plan audits.
