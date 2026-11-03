---
summary: Why /cycle's linear steps are shaped as they are — inline dispatch, plan deps, empty-diff guard, persona URL, ship.
---

# Orchestration rationale — the linear (non-cluster) steps

`SKILL.md` keeps every step's rule and command resident. This file holds the
reasoning and history behind them, moved verbatim. Read the section for the step
whose rule is being questioned.

## No-dispatch fallback — why arguments are passed explicitly

Without it an inlined `/audit-code` has no user message naming
a plan, and its own contract would correctly make it ask-and-stop — which
would deadlock every inline cycle.

## Step 0.5 — why the cross-plan check exists

Why this exists: nothing previously checked a plan's own stated ordering
dependency on another plan's status, so two concurrent sessions each running
a different plan could land in the wrong order with no warning (upstream
report `f5ac366f`). A plan with no `Depends on:` line prints nothing to act
on and costs one cheap local read.

## Step 3 — the SKIP_TO_CODE empty-implementation guard

**POSIX shell only** (Git Bash on Windows) — the `[ ... ]` test syntax has
no native PowerShell equivalent; run this step in a bash-capable shell
even on a Windows/Copilot host.

Why the fork names two exact commands: `--autonomous` alone does nothing here,
since `SKIP_TO_CODE` routes straight past the implementation gate regardless of
the flag (Step 3's decision table), so "just add `--autonomous`" is not a fix
while the `code` keyword stays. `plan` mode is the one whose gate actually reads
`--autonomous`.

This mirrors the Step 3C rule "never default `--diff` to HEAD — empty diff =
silent skip", extended to the human `code` path. (The AUTO-mode "any new code
since the plan commit" detection gates this too.)

## Step 4 — solo author-model control

> **Solo author-model control** fires automatically inside `/audit-code`
> (its Step 6.5b — backgrounded, toggle-gated) when the `arm-eval` shadow is on.
> `/cycle` delegates to `/audit-code`, so no separate action is needed here; if
> you run the autonomous per-cluster path (Step 3C) that invokes `/audit-code`,
> it inherits the same trigger.

## Step 5 — why the URL resolution does not stop at the env var

**`PERSONA_TEST_APP_URL` unset is
not the same fact as "no deployed instance"** — a repo that only sets the
env var for CI/PR-preview but runs a normal local dev server otherwise has
a perfectly runnable target that this env-only check would miss.

## Step 7 — why ship is always a blocked handoff

`/ship`'s frontmatter carries `disable-model-invocation: true`, which refuses
ANY programmatic call, including one made from inside `/cycle`'s own
orchestration (Claude Code and VS Code Copilot both honour the key — see
`/ship`'s own header). This is not a failure mode to handle; it is the
permanent, unconditional shape of this step, autonomous or not — the
`--autonomous` flag authorizes within-cluster fixes (Hard rules), it does
NOT authorize shipping. There is no version of Step 7 that completes without
the human typing `/ship` themselves.

Once the human runs that command, `/ship` executes its own checklist
(status update, AGENTS sync, plan update, stage + commit + push,
ship_event log) and its Step 0.5c refreshes the architectural-memory index —
no further action from `/cycle` either way.

From the end of Step 3C.2:

> Reaching this point means the ENTIRE autonomous loop — implement, audit,
> fix-gate, close-out, consolidated Gemini gate — completed without a human.
> Step 7 still stops it: `/ship` cannot be invoked programmatically (see Step 7
> below), so even a fully autonomous, fully converged run ends in a blocked
> handoff naming `/ship docs/plans/<name>.md`, never a pushed commit.
