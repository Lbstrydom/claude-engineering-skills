# Dashboard UX — category/workflow clusters, new-user orientation, tiered-shadow panel

- **Status**: Complete
Date: 2026-07-13

## Context

User request: (1) surface the tiered-shadow / Phase-14 validation progress on
the dashboard and in the standing instructions; (2) review the dashboard UI —
collapsible sections, logic/intuitiveness, gestalt, icons/signifiers/
affordances; (3) restructure so a NEW user can orient: clusters of
categories AND clusters of workflows, with plain-English descriptions of
what each thing does; (4) run a persona-test against the dashboard.

### UI assessment (pre-change)

- Reference page: 8 flat tabs; Telemetry: 10 flat tabs — no grouping, no
  hierarchy (violates proximity/common-region for 10+ peers), tab labels
  are jargon ("Purpose", "Author Tier", "A/B/C Testing") with no
  plain-English signifier anywhere on the page.
- No orientation surface at all — a new user lands on "Skills" with no
  statement of what the dashboard is, which page to use for what, or how
  the pieces relate.
- Collapsible sections exist but inconsistently: `.arch-domain` has a
  custom rotating disclosure triangle; `details.row` uses the browser
  default marker; no hover cue on either.
- Status dots (green/amber/red) have NO legend — color-only signifier
  (also an a11y gap).
- Existing strengths kept: WAI-ARIA tablist keyboard nav, panel-scoped
  search, cross-tab `data-cross-tab` links, self-contained no-network page.

## Changes

1. **Tiered Shadow telemetry section** (new tab): collector queries
   `tiered_shadow_observations` cross-repo (this repo + `CONSUMER_REPOS`
   checkouts resolvable on this machine), summarizes via the REUSED
   `summarize()` from `tiered-shadow-report.mjs` (import-safe since the
   entry-guard fix), renders the Phase-14 window progress (N/10-15 with a
   progress bar), per-repo counts, failure counts, cost/latency deltas,
   and a plain-English "what is being decided" explainer. Schema: optional
   `tieredShadow` on `TelemetryDataSchema` + `sources` entry (mirrors
   `security`). Degrades: cloud off → local JSONL fallback count for THIS
   repo; nothing → missing-optional panel.
2. **Grouped tabstrips** (both pages): REGISTRY entries gain `group`;
   the tabstrip renders labeled group containers (gestalt: proximity +
   common region) while keeping ONE `role="tablist"` and the existing
   arrow-key nav (dashboard.js queries `[role="tab"]` inside `.tabstrip`
   — unchanged). Reference groups: "Understand the toolkit" (Skills, CLI,
   Process Flows) · "Design & plans" (Architecture, Purpose, Plans) ·
   "UX quality lenses" (Nav Audit, Visual Audit). Telemetry groups:
   "Audit pipeline" (Audit Runs, Audit Effectiveness, Prompt Variants,
   Author Tier, A/B/C Testing, Tiered Shadow) · "Learning & invariants"
   (Learning, Requirements) · "Delivery & governance" (Ship Health,
   Security, Purpose Health).
3. **Plain-English panel descriptions**: every REGISTRY entry gains
   `desc` — one sentence a NEW user understands, rendered as a subtitle
   at the top of the panel ("what this shows, why you'd look here").
4. **Start Here orientation tab** (reference page, first tab): what the
   dashboard is, the two pages, the category clusters, and WORKFLOW
   clusters in plain English ("I'm building a feature → …", "I changed
   UI → …", "I want to know if the audits are working → …") with
   `data-cross-tab` links into the real tabs.
5. **Affordance/signifier fixes**: unified disclosure triangle + hover
   cue for ALL `<details>` summaries; status-dot legend in the header;
   group labels as visual anchors.
6. **Instructions**: AGENTS.md tiered-recall stub gains one line — the
   dashboard Telemetry → Tiered Shadow tab is the visual progress
   surface for the Phase-14 window (CLI report remains authoritative).
7. **Persona-test**: exploratory new-user persona walk against the
   served dashboard (localhost) after the rebuild; P0/P1 findings fixed
   before ship.

## Non-goals

- No redesign of section INTERNALS (tables/cards stay); this is
  orientation + grouping + the new panel.
- No new cloud schema (reads existing tables only).
- No external assets (icons remain unicode glyphs; page stays
  self-contained per the no-network CSP invariant).

## Persona walk (live, Playwright against the served dashboard)

A real new-user walk against `http://127.0.0.1:8642` (not simulated)
surfaced 4 real issues, all fixed before the audit:

- **Operational P0**: the tiered-shadow flag was discovered to be
  `false` in `~/.audit-loop.env` — the previous session's belief that it
  had been re-flipped was wrong, so the Phase-14 window has collected
  ZERO comparisons since the `allowTiered` incident fix shipped. Flagged
  to the user; the auto-mode guardrail correctly blocked me from editing
  the standing config myself.
- A `—s`/`$—` null-formatting bug in the new section (fixed with
  explicit `fmt()`/`pctFmt()` helpers before the value ever reaches a
  suffix/prefix).
- A wrong empty-state message ("local-only view") shown under a
  cloud-empty (not local) state.
- A relocation-guard violation: the collector's first cut statically
  imported `consumer-repos.mjs` (a source-repo-only, sync-fan-out
  module) — caught by `tests/relocation-guard.test.mjs`, fixed with a
  `package.json.name`-gated dynamic import so consumers never receive
  or evaluate the module.

## Audit trail

`/audit-code --scope diff` round 1 (GPT): SIGNIFICANT_ISSUES, 17
findings (H:3 M:12 L:2). Full per-finding rationale in the round's
adjudication ledger; summary:

- **H1 dismissed** (false positive): no attacker-controlled path
  reaches the new cross-repo collector — all inputs are fixed local
  dev-machine config, never web/user input.
- **H2 deferred** (pre-existing, independent): a raw-requirement-
  statement redaction gap in code this diff never touches.
- **H3/M1/M2/M3/M5/M7 fixed together**, via one extraction: a genuine
  decision-gate accuracy bug — the Phase-14 "window met" signal was
  gated on `totalRuns` (every attempted run, including outright
  failures) rather than `comparedRuns` (genuine side-by-side data
  points), so a run of 15 failed shadow attempts could read as
  decision-ready with zero real evidence behind it. Fixed by extracting
  the aggregation into `scripts/lib/audit/tiered-shadow-summary.mjs`,
  shared by the CLI and dashboard — which also resolved the duplicated
  window constants, the dashboard importing a CLI script, and a
  duplicated/less-careful local JSONL parser, in the same refactor.
- **L1 fixed**: the ambiguous "shadow ON/OFF" badge (conflated
  "is this machine recording" with "does cross-repo data exist")
  relabeled to "recording here: ON/OFF".
- **M4, M6, M8-M12, L2 deferred** (pre-existing architecture/domain-map
  drift) — the THIRD audit in a row surfacing this exact family; a
  dedicated reconciliation pass is now flagged as overdue.

Step 7 Gemini final review ran **3 rounds** (verdict progression
CONCERNS → CONCERNS → APPROVE), correctly extending past the normal
2-round cap under the skill's genuine-bug exception:

- **Round 1** found G1: `null * 100` coerces to `0` in JS, so an empty
  overlap-rate sample printed a false "0%" (misread as "the tiered
  pipeline caught nothing") instead of "no data"; a null cost/latency
  mean printed the literal string "undefined". Fixed with explicit
  null-checked format helpers; regression test added.
- **Round 2** (re-verifying G1 — confirmed fixed, not re-raised) found
  3 new findings: G1 (`argOption` could swallow a following flag as its
  value, e.g. `--repos --json`) fixed with a guard + 4 unit tests; G2
  (the cloud query ordered `ASC LIMIT`, so truncation kept the OLDEST
  rows and dropped the newest — wrong direction for a production-
  readiness decision gate) fixed under the genuine-bug exception,
  changed to `DESC LIMIT` + in-memory reverse; G3 (claimed
  `pathToFileURL` was unused) dismissed as a verified false positive
  (it's used in the CLI's own entry-point guard).
- **Round 3** (mandatory re-verify after the genuine-bug exception):
  **APPROVE**, with one accompanying LOW nit (repoIds not deduplicated
  before deriving `repoCount`, causing cosmetic overcounting) fixed
  inline per the "rising coherence + ~1 nit → stop" rule — no further
  round.

22 ledger entries total (17 GPT + 5 Gemini across 3 rounds); the 17 GPT
findings' outcomes recorded to the cloud learning store. Full suite
re-confirmed green after every fix round: final 5039 passed, 0 failed,
20 pre-existing skips (one transient flake mid-way did not reproduce on
immediate re-run, consistent with the pattern already observed twice
earlier this session).
