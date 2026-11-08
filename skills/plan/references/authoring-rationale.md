---
summary: Why /plan's authoring rules exist — Code Trace, repo-relative paths, Mermaid checks, payload file, Depends on.
---

# Authoring rationale — measurements and history behind the rules

`SKILL.md` keeps every rule, section requirement and command. This file holds
the reasoning, examples and measured incidents behind them, moved verbatim.

## Token efficiency (why references load by scope)

**Token efficiency**: principle tables (20 engineering, 26 UX, 17
technical) live in `references/*.md` and load on demand only when the
detected scope needs them. Backend-only work loads only engineering
references; frontend-only loads only UX + technical; full-stack loads
both. Per-invocation cost ≈ what you'd pay for the original skills.

## Phase 1.5 — when the execution model matters

This phase catches sequencing bugs that surface as HIGH findings in
audit round 3+.

- **Batch operations**: moves, imports, migrations — order matters, partial failure needs rollback
- **Multi-step workflows**: wizard flows, onboarding sequences — step N depends on step N-1
- **State transitions**: status changes, approval chains — invalid intermediate states must be prevented
- **Cross-entity operations**: swaps, cycles, rebalancing — A↔B swap is not two independent moves

## Phase 5 — right-sizing gate

This is a brake, not ceremony: it fires only when new structure is on the table.
Writing both extremes is the forcing function — it makes the right-sized middle
obvious and is harder to rationalise past than a yes/no self-check.

## Phase 5 — manual vs scripted

**Manual vs scripted (right-sizing applied to execution).** When a change repeats
across many similar sites — a rename, codemod, data backfill, ≥~5 regular edits —
prefer a **one-off script** *only if* the transformation is regular and
**verifiable** (you can assert the result). If the sites vary, the edit is
judgment-heavy, or there are < ~5 — **do it by hand** (a fragile codemod for
trivial/irregular work is the over-engineering cliff; grinding 50 regular edits
by hand is the band-aid cliff). A throwaway script is a Category-A artifact
(tmp / gitignored), never committed. State which path and why in the plan.

## §1 — Code Trace

This bullet makes "trace before
designing" leave a footprint instead of being an honour-system instruction.

The trace is read weeks later, against a moved tree: a path is
durable, a path plus a line is a snapshot that decays into a wrong-but-
resolving reference (measured: 5 of 9 bad claims in one document were correct
when written).

## §2 — the Mermaid block is the proposed view

The Mermaid block is the **proposed** view — an artifact of this plan, not
a maintained file. It dies with the plan; nothing claims it stays current.
For *existing* structure defer to `docs/architecture-map.md` (the
generated, always-current index).

## §7b — why paths must be repo-relative

> it requires **at least one `/`**, so a bare basename is invisible to it
> *anywhere in the plan*, including in `Files:` lines and prose.
>
> The failure is silent and misleading, hence this callout.
> Too few resolvable paths and `/audit-code --scope diff` finds an empty
> diff∩plan intersection and **aborts** ("0 implementation files reached the
> prompt") — correct, but it pushes you to `--scope plan`, where **fuzzy keyword
> discovery** fills the scope from plan *words* instead.
>
> **The threshold is exact: fewer than 5 resolvable paths and fuzzy fires**
> (`plan-paths.mjs` — `FUZZY_DISCOVERY_THRESHOLD`). Measured 2026-07-19 across this
> repo's plans: `debt-burndown` 31 → clean, `egress-secret-coverage-gap` 6 →
> clean, `migration-bootstrap-coupling` **4 → fuzzy fired**, adding **21 unrelated
> files** matched on words like "findings" and "provenance". The audit returned 17
> findings, **16 citing files the change never touched** — an audit that looked
> thorough and reviewed the wrong code.
>
> A small plan can legitimately sit under 5. That is fine — the point is to know
> it, not to pad the list. **Never invent file references to clear the
> threshold**; a fabricated path is worse than fuzzy noise. Qualify the paths you
> genuinely touch, then read the audit's scope line before trusting its findings.
>
> Cheap self-check before persisting — it prints the REGEX-resolvable count (the
> number the threshold actually tests), what fuzzy added, and how many paths
> don't resolve. A large `missing` means your paths are basenames.
> Report-only, exit 0 — a small plan may legitimately sit under the threshold.

## Phase 6.5 — the Mermaid MCP tool name, and why both instruments stay

> This gate named `mcp__claude_ai_Mermaid_Chart__validate_and_render_mermaid_diagram`
> until 2026-09-02 — a different server, with a verb the registered one does not
> expose. Two mismatches, so the availability test could never be true, and
> because the else-branch below skips *silently* the step could not report its
> own deadness: it had never run once, in any host. When a step is written to
> skip quietly, its availability check has to be verified by executing it, not
> by reading it.

**This does not replace `plans:lint`, and neither replaces the other.** Measured
2026-09-02: the MCP accepts `SG1 -.- B` (a subgraph id used as an edge endpoint)
without complaint, which `plans:lint` classifies as an ERROR because stricter
renderers reject it; the MCP in turn catches ordinary parse errors the regex
linter never looks for. Two instruments, two blind spots — do not delete either
on the grounds that the other covers it.

## Phase 7 — why `Depends on:` is a structured line

A free "wait for Cluster F" note is
invisible to every other session (upstream report `f5ac366f`: the loser
hand-reconciled via a rebase + manual code transplant).

## Phase 7 — why the payload goes through a file

Persisting the plan and dispatching
the capture is then one atomic call (no separate, skippable step).
The user's own task text can
contain an apostrophe (e.g. "the user's original task"), and an apostrophe
inside a single-quoted shell string terminates the string early, corrupting
the call (same defect class the `--triage` payload note above already covers).

## Phase 7.5 — arm-eval capture

`upsert-plan` fires capture itself: when the payload carries `taskText` and the
per-repo `arm-eval-toggle` is on, it dispatches a detached, blinded A/B/C
arm-eval session in the background (`scripts/lib/arm-eval/capture-trigger.mjs`).
A separate `arm-eval-maybe-capture` command would double-capture. Toggle off →
byte-identical no-op; the plan is unaffected.

## Phase 7 `Depends on:` read-back

`node scripts/check-plan-status.mjs --check-deps <this-plan>` reads each
`Depends on` line against the referenced plan's own `Status:` line. An unmet
dependency is reported, never blocked on, since only the operator knows whether
it is still safe to proceed.
