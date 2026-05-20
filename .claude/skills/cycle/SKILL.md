---
name: cycle
description: |
  End-to-end feature cycle orchestrator. Runs the full skill chain in
  sequence: /plan → /audit-plan → (wait for human implementation) →
  /audit-code → /persona-test (if frontend/full-stack) → /ux-lock (if
  fixes shipped) → /ship. Use when starting a new feature or non-trivial
  fix and you want the whole workflow on autopilot.
  Triggers on: "run the full cycle", "do the whole flow", "plan + audit
  + ship", "feature cycle", "/cycle".
  Usage: /cycle <task-description>          — Full chain from scratch
  Usage: /cycle plan <plan-file>            — Skip planning; use existing plan
  Usage: /cycle code <plan-file>            — Skip to code-audit-then-ship
  Usage: /cycle <plan-file> --no-persona    — Skip persona-test step
  Usage: /cycle <plan-file> --no-uxlock     — Skip ux-lock step (no UI changes)
  Usage: /cycle <plan-file> --no-ship       — Stop after audit; don't commit or push
  Usage: /cycle <plan-file> --max-rounds N  — Pass through to /audit-plan and /audit-code
---

# Feature Cycle Orchestrator

Chains the existing atomic skills into one workflow so you don't have to
remember which to invoke when. Each step is a delegation to the
underlying skill — this orchestrator just sequences + waits.

**This skill does NOT duplicate logic from the atomic skills**. If you
want fine control over a single step, invoke that step's skill directly
(`/audit-code`, `/audit-plan`, etc.). Use `/cycle` when you want the
golden-path workflow without thinking about it.

---

## Step 0 — Parse Input

| Input shape | Mode |
|---|---|
| `/cycle <task description>` (no file path) | **FULL** — generate plan, audit it, wait for impl, audit code, ship |
| `/cycle plan <plan-file>` | **SKIP_PLAN** — plan exists; audit it, wait for impl, audit code, ship |
| `/cycle code <plan-file>` | **SKIP_TO_CODE** — plan + impl exist; audit code, validate UX, ship |
| `/cycle <plan-file>` (no `plan`/`code` keyword) | **AUTO** — detect by checking if any new code exists since plan was written |

Optional flags:
- `--no-persona` — skip /persona-test (use when no live URL or backend-only)
- `--no-uxlock` — skip /ux-lock (use when no UI changes shipped)
- `--no-ship` — stop after audit; don't commit or push
- `--max-rounds N` — pass through to /audit-plan and /audit-code

Show kickoff card:

```
═══════════════════════════════════════
  /cycle — [MODE]
  Steps: plan → audit-plan → audit-code → persona-test → ux-lock → ship
  Skipped: --no-persona, --no-uxlock
═══════════════════════════════════════
```

---

## Step 1 — Plan (FULL mode only)

Invoke `/plan <task description>`. The unified `/plan` skill auto-detects
scope (backend / frontend / full-stack) and produces one consolidated
plan document at `docs/plans/<descriptive-name>.md`.

**On failure**: surface the error and abort. Don't proceed to audit.

---

## Step 2 — Audit Plan

Invoke `/audit-plan <plan-file>`. Iteratively refines the plan with
GPT-5.4 + Gemini final gate. Max 3 rounds; rigor-pressure stop.

**On verdict**:
- `APPROVE` (Gemini) → proceed to Step 3
- `CONCERNS` after Gemini round 2 (cap) → present to user, ask: "Plan has remaining concerns from final review. Proceed to implementation anyway, fix the plan first, or stop?"
- `REJECT` → present to user, recommend stopping the cycle to revise

---

## Step 3 — Wait for Implementation

This is the human-in-the-loop step. The plan is ready; the human (or
Claude in another session) implements it.

**`/cycle` pauses here.** It does not implement the plan automatically —
that's the human's job, OR can be done with a separate manual `/cycle code <plan>`
invocation later when implementation is done.

Output:

```
═══════════════════════════════════════
  /cycle paused at implementation gate
  Plan: docs/plans/<name>.md
  Resume with: /cycle code docs/plans/<name>.md
═══════════════════════════════════════
```

(In SKIP_PLAN and SKIP_TO_CODE modes, this step is skipped automatically
— the human has already implemented the plan before invoking /cycle.)

---

## Step 4 — Audit Code

Invoke `/audit-code <plan-file>` (default `--scope=diff`). Multi-pass
parallel GPT-5.4 audit with R2+ ledger suppression and Gemini final
review. Max 6 rounds; quality threshold `HIGH==0 && MEDIUM<=2 && quickFix==0`.

**On verdict**:
- `CONVERGED` → proceed to Step 5
- `INCOMPLETE` (passes timed out) → present to user, offer: continue with partial / re-run with higher timeout / stop
- Persistent HIGH findings after R6 → present to user with finding list, recommend fix-then-retry rather than ship

---

## Step 5 — Persona Test (if scope ⊇ frontend, AND not --no-persona)

Detect whether persona-test is applicable:
- Skip if plan scope is `backend` only
- Skip if `--no-persona` flag passed
- Skip if no `PERSONA_TEST_APP_URL` env var (no deployed instance)

Invoke `/persona-test <persona> <url>` — drives a browser as a registered
persona, collects P0–P3 findings.

**On verdict**:
- 0 P0 findings → proceed to Step 6
- ≥1 P0 finding → present to user, recommend fix before ship; offer to feed findings back into a new `/audit-code` round

---

## Step 6 — UX Lock (if any new fixes shipped, AND not --no-uxlock)

For each HIGH finding fixed in Step 4, AND each P0/P1 fixed in Step 5,
invoke `/ux-lock` to generate a Playwright spec that locks the fix.

Skip if no fixes were applied OR `--no-uxlock` flag passed OR backend-only
scope.

---

## Step 7 — Ship (unless --no-ship)

Invoke `/ship`. Runs the existing /ship checklist (status update, AGENTS
sync, plan update, stage + commit + push, ship_event log).

**Step 0.5c of /ship** automatically refreshes the architectural-memory
index (incremental refresh, regenerates `docs/architecture-map.md` if
changed). No additional action needed here.

---

## Step 8 — Cycle Summary

```
═══════════════════════════════════════
  /cycle complete — <PLAN-NAME>
  Plan:        docs/plans/<name>.md
  Audit-plan:  3 rounds, APPROVE
  Audit-code:  4 rounds, CONVERGED, H:0 M:1 L:2
  Persona:    0 P0, 1 P1 (deferred)
  UX-lock:    2 specs generated
  Ship:       commit abc1234 pushed to main
  Total time: 18m
  Total cost: ~$1.40
═══════════════════════════════════════
```

If any step was skipped, note why. If any step exited non-success,
surface as a warning at the top.

---

## Hard rules

- **Never auto-fix** between steps without user confirmation. Each
  audit's findings are surfaced; user decides whether to proceed.
- **Never skip `/audit-plan`** unless explicitly in SKIP_PLAN or SKIP_TO_CODE mode.
- **Never skip `/audit-code`** unless explicitly in SKIP_TO_SHIP mode (not currently exposed; reserved).
- **Cycle is human-orchestrated, not autonomous** — it pauses at the implementation gate (Step 3) so the human writes/reviews code, then resumes from `/cycle code <plan>`.
- **Cost cap awareness**: estimate total cost upfront from input size and surface it in the kickoff card. A typical full cycle costs $1–3.

---

## Reference files

This skill is a thin orchestrator — there are no references. All the
heavy logic lives in the underlying atomic skills (`/plan`,
`/audit-plan`, `/audit-code`, `/persona-test`, `/ux-lock`, `/ship`).
This skill's only job is sequencing.
