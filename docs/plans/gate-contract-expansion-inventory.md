# Gate inventory — the 13 uncontracted skills

- **Date**: 2026-07-20
- **Status**: Complete — status corrected 2026-07-22 (was stale at `In Progress`).
  Every candidate across all 13 skills has a disposition and, per the parent
  plan, a contract now exists for all 15 skills (`check-gate-contracts.mjs`
  reports zero uncontracted).
- **Author**: Claude + Louis
- **Scope**: backend (survey artefact; authors no contracts)

Deliverable of [`gate-contract-expansion.md`](./gate-contract-expansion.md) §7a.
This is a **disposition ledger**, not a contract: it exists so the successor
plan can author `gate-contract.json` files from resolved rows instead of
re-deriving them, and so no candidate is dropped silently.

## Survey rule (mechanical, not taste)

Candidate = any SKILL.md line containing an enforcement verb — *blocks, fails,
exits, refuses, requires, must, never, always, threshold, cap, max, gate*. Each
candidate takes **exactly one** disposition:

| Disposition | Meaning |
|---|---|
| `executable` | a registry oracle + hermetic fixture can assert it |
| `document-only` | no honest mechanical oracle exists — reason recorded |
| `not-a-gate` | descriptive prose, not an enforcement claim |
| `defect` | the claim is unbacked → resolve before contracting (never contract as-is) |

**Completion criterion**: the inventory is done when no candidate is
unlabelled. It is *not* done when every skill has a contract — two skills
correctly have none.

## Status of this pass

**First pass complete; row-level detail pending per skill.** The bands and the
`defect` rows below are resolved and are the load-bearing output. The
per-gate columns required by §7a (`gateId`, verbatim `stated`, `statedIn`
anchor, `oracle`/`scenario`, `expect`) are filled in **per skill, immediately
before that skill's contract is authored** in the successor plan — filling all
~40 rows speculatively here would repeat the error that narrowed the parent
plan at audit round 3 (specifying contracts before their fixtures exist).

## Bands

| Band | Skills | Note |
|---|---|---|
| Gate-dense | `cycle`, `ship`, `audit-plan`, `ux-lock`, `nav-audit`, `click-test`, `persona-test` | contract earns its keep |
| Thin but real | `ai-context-management`, `security-strategy`, `brainstorm`, `plan` | 1–3 honest assertions each |
| No stated gates | `explain`, `skills` | `{gates: [], reason}` declaration only |

## Resolved `defect` rows

| # | Claim | Verdict | Action |
|---|---|---|---|
| D-1 | `plan:654` "§10 acceptance criteria is **the ship gate**" + `ux-lock:229` "gating is `/ship`'s job via … `plan_satisfaction`" | **REAL** — `/ship` never queries it; `readPlanSatisfaction` is reachable but ship only optionally reports it in status.md. Two skills each delegated the gate to the other. | **FIXED** (branch A2, operator sign-off 2026-07-20): both claims corrected; no `/ship` gate added |
| D-2 | `click-test:571` "The required `record-click-test` subcommand" | **RETRACTED — not a defect.** The line sits under `## Phase 7 — Persistence (Out of Scope for v1)` in a "Why deferred" list and states the subcommand **does not exist**. Correctly-documented deferral. | none — no edit made |
| D-3 | `loader.mjs formatSummaryLines` printed `CHECKED <n>` counting *declared* executable gates, then claimed env-skipped ones were "never counted as checked" | **REAL** — the output contradicted itself; a gate that executed nothing inflated the headline. Found inside the gate-honesty suite while implementing its own harness. | **FIXED** — CHECKED now means RAN; 3 regression tests |

**D-2 is the instructive one.** It reached a plan as a "verified defect" because
a survey quoted one line and nobody read the surrounding section. The rule it
produces: **a `defect` row requires reading the enclosing section, not the
matched line.** A grep hit is a candidate, never a verdict.

## Candidate highlights per skill

Condensed from the full survey; the `executable` calls are provisional until
each row's fixture is specified.

- **`cycle`** — densest surface. Best candidates: `preview-gate [HALT]` (names a
  real tested seam), fix-gate convergence predicate `HIGH==0 && MEDIUM<=2 &&
  quickFix==0`, "`test:unit` alone never clears a destructive cluster's
  fix-gate", `author-tier` records-but-never-routes (a *negative* — assert no
  routing code reads it).
- **`ship`** — mostly **negative** gates: Step 0.5 is "non-blocking by default",
  0.5c "ALWAYS advisory", candidate-promotion failures "do NOT block". Plus the
  strongest positive candidate in the skill: `--gate passed` is refused without
  verified evidence.
- **`ux-lock`** — verify exits 0 even on criterion failure (now that D-1 is
  fixed, this is a clean self-contained claim); `--strict-selectors` flips
  warn→fail. **`statedIn` blocker**: the selector policy's canonical prose is in
  a reference file — restate in SKILL.md or mark document-only.
- **`nav-audit`** — exit table `0`/`1`/`2`. **Must split per outcome** (§7a): one
  `cli-exit` scenario per exit code, or narrow the `stated` quote. Quoting three
  outcomes while exercising one is the defect this suite exists to catch.
- **`persona-test`** — consistency-runner exit table (2 rig-broken / 3 fatal-rig
  / 4 ledger-persist-failed / 6 app-error); `personaFindingHash()` as single
  source. Confidence thresholds (≥0.6/0.7/0.8) are **document-only** — the input
  is model self-reported confidence.
- **`audit-plan`** — Gemini round cap ≤2, GPT ≤3; `FINAL_GATE_SKIPPED` sentinel
  on no-key; `--mode plan` required. Round caps are numeric and pinnable.
- **`click-test`** — verdict precedence (`auth-required` → never `Clean`);
  touch-target threshold; `>999` → `scanner-error`.
- **`plan`** — Gate-1 numeric triggers (≥6 files / ≥2 subsystems); the
  anti-degenerate "never a lone Phase 1"; "warnings never block" negatives.
- **`brainstorm`** — already names its own test file in prose
  (`tests/brainstorm-artifact-context.test.mjs`), so it is the cheapest contract
  in the set: sensitive-path refusal, symlink-escape refusal, "a refusal never
  aborts the round".
- **`security-strategy`** — write-gated-on-round-trip-parse; `redactSecrets()`
  before egress.
- **`ai-context-management`** — exit-code map `0`/`1`/`2`.
- **`explain`, `skills`** — no stated gates. `explain` makes only read-only and
  "cite sources" claims; `skills` claims a design property ("never drift" —
  because it reads frontmatter directly), not an enforced check. Both get
  `{gates: [], reason}` in the successor plan.

## Carried constraints (from the parent plan's audit)

1. **No new oracle** — every gate fits `cli-exit` or is `document-only`; a gate
   fitting neither is a finding, not a reason to grow the registry.
2. **`stated` may never be broader than what the oracle exercises** — split per
   outcome or narrow the quote.
3. **`statedIn`** is the owning SKILL.md or AGENTS.md only; a reference-file
   gate is restated (an edit that must appear in a phase) or document-only.
4. **A `defect` row is never contracted as-is** — resolve first, then contract
   the corrected invariant.
