# Testing doctrine — which seam gets which kind of test

Moved out of `AGENTS.md` (2026-08-01) under its progressive-disclosure rule:
subsystem-grade detail belongs in `docs/` with a short stub in AGENTS.md,
because AGENTS.md is loaded every session and size is a cost. The **Tier-3
same-commit rule** stayed resident in AGENTS.md — it is an obligation on every
change, not reference material. Everything below is the elaboration.

Origin: `/brainstorm --with-gemini`, 2026-06 — consensus of GPT-5.5,
Gemini-pro and Claude.

## The premise

Blanket TDD is theatre at the LLM boundary: you cannot red-green-refactor a
prompt. But test-first is high-value at deterministic seams, and **mandatory**
at the two seams where a silent regression is both likely and expensive. Hence
three tiers rather than one policy.

This is descriptive, not a gate — it writes down where rigor already pays.

## Tier 1 — test-first / TDD for deterministic seams

Modules with crisp inputs and outputs, where a regression is cheap to assert
and expensive to ship:

`schemas`, `sensitive-paths`, `vcs`, `bandit`, `ledger`, `findings-*`,
`config`, `file-io`, `sync-path-map`, `sync-rewriter`.

New behaviour here lands with its test.

## Tier 2 — eval / fixture / invariant testing for LLM-orchestration seams

`openai-audit`, `gemini-review`, prompt builders.

**Do NOT** assert on model prose, and do NOT mock the whole provider API to
test orchestration order — that tests the mock. Assert **invariants** instead:

- "Gemini final review always runs regardless of GPT convergence"
- "cloud-store failure never blocks the local ledger write"
- "sensitive paths never enter a provider payload"

Use canned-response fixtures for the parse / fallback / dedup paths.

## Tier 3 — HARD test-first (non-negotiable)

Two seams where a change lands with its test in the **same commit**:

1. **Sensitive-path egress** — a leak ships credentials to a third-party LLM.
   Guarded end-to-end by `tests/sensitive-egress.test.mjs` (the gate) plus
   `tests/audit-scope-egress.test.mjs` (the assembly path real audits use).

2. **Consumer sync / relocation contract** — a break ships *silently* to
   consumer repos you cannot observe. Guarded by `tests/sync-path-map.test.mjs`,
   `tests/sync-rewriter.test.mjs`, `tests/relocation-guard.test.mjs` (the
   `--selfcheck-relocation` string is *present*) and
   `tests/relocation-selfcheck-smoke.test.mjs` (the handler actually *works*,
   under a hermetic env).

The pairing in each case is deliberate: one test proves the guard exists, the
other proves it runs on the path production actually takes. A single test of
either kind alone has passed while the other half was broken.

## Deliberately deferred

`fast-check` property-based fuzzing and an offline LLM eval matrix — both would
add dependencies for a class of bug that has not recurred. Revisit if
schema-boundary bugs start coming back.

**A skill-trigger eval harness** (prompts → expected skill, scored by a model)
— deferred on a *different* rationale to the row above, so do not read that
one's "hasn't recurred" as covering this. The bug class HAS occurred: two
skills claimed `"verify the plan"`, and `/investigate` overlapped
`/explain --history` semantically. It is deferred because it **cannot be
honestly gated**. The pre-push `check` runs in a network-less sandbox worktree,
so the harness would skip and the gate would go green having checked nothing —
the precise anti-pattern in
[`pre-ship-empirical-verify.md`](../runbooks/pre-ship-empirical-verify.md)
("can this return green without having actually checked anything?") — and Tier 2
above forbids assertions on model prose regardless.

What was built instead, after measuring:
[`check-skill-descriptions.mjs`](../../scripts/check-skill-descriptions.mjs)
enforces the two halves that ARE deterministic (the 1024-char description
budget; literal trigger-phrase collisions). Fuzzy matching was measured and
rejected — Jaccard ≥0.5 over phrase tokens produced 47 cross-skill pairs,
essentially all noise from one shared word. Semantic overlap has no oracle, so
it is declared by a human in both descriptions instead (*topic* →
`/explain --history`, *claim* → `/investigate`).

Revisit only if a mechanism appears that can run offline and deterministically,
or if the pre-push gate stops being the place this would live.

## Companion rules

The **Do NOT** list in AGENTS.md carries the companion hard rules (no `.env` to
external APIs, ESM-only, no per-call client construction). Live-runtime skills
have their own doctrine in
[`docs/runbooks/pre-ship-empirical-verify.md`](../runbooks/pre-ship-empirical-verify.md).
