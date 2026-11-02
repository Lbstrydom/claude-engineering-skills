---
summary: The measured cases behind Step 2.5's RED proof, the Step 3 store diagnosis, and why nothing gates on verify today.
---

# History and evidence

SKILL.md keeps each rule resident; this file holds the incidents and dated
measurements that produced them.

## Step 2.5 — the measured case behind "prove it RED"

This is not hypothetical. In one measured case a regression test for a blocked
internal-address fetch passed **before** the fix too: nothing was listening on
the probed port, so a raw request also returned null, and the assertion could
not distinguish "blocked by the guard" from "connection refused". Rewritten to
stand up a real local server serving a parseable payload, reverting the fix
produced four red tests — red *because the old code successfully parsed the
internal page*, which is the actual exploit.

## Step 3 — the 2026-08-22 store diagnosis

> **Diagnosis (docs/plans/skill-efficacy-census.md Phase 1, 2026-08-22)**: a
> live-store audit found `regression_spec_runs` at 0 rows and every
> `regression_specs` row attributed to `/ship`'s `lock-with-test` instead of
> this command. Tracing the actual write path (`recordRegressionSpec` /
> `recordRegressionSpecRun`, `scripts/ux-lock-run.mjs:335-369`) found it
> correctly wired — a failed write is counted and reported to stderr, not
> swallowed. The gap is adoption, not a bug: this deterministic runner is
> rarely invoked directly, and most fixes get locked via `/ship`'s simpler
> `lock-with-test` path instead. No code change was warranted.

## Steps V3–V5 — why nothing gates on verify today

- **Nothing gates on this today.** An earlier version said gating was `/ship`'s
  job "via the status rubric + `plan_satisfaction`". It is not: `/ship` never
  queries `plan_satisfaction` — `readPlanSatisfaction`
  (`scripts/lib/store/plans-ship.mjs`) is reachable through
  `cross-skill.mjs plan-satisfaction`, but ship's only use of it is an optional
  status.md reporting section. Meanwhile `skills/plan/SKILL.md` called §10 "the
  ship gate" and pointed here. Each skill delegated the gate to the other and
  nobody enforced it. Both claims are corrected; adding a real `/ship` gate is a
  separate decision, deliberately not taken
  (`docs/plans/gate-contract-expansion.md` §7b Phase 1, branch A1).
