---
name: plan
description: |
  Unified architecture + UX planner with engineering principles. Auto-detects
  whether the work is backend-only, frontend-only, or full-stack and applies
  the appropriate principle sets. Use when the user asks to plan, design, or
  architect anything — features, refactors, API endpoints, services, UI
  components, pages, layouts, user flows, modals, forms, visual changes,
  database schemas. Also auto-invoke when detecting planning context like
  "I want to add", "let's design", "plan the implementation", "how should we
  structure this", "I need to refactor", "design the UI for", "build a
  component", "improve the UX of". Accepts a task description as argument;
  an explicit scope hint and diagram controls are available as flags.
  Triggers on: "plan", "design this", "architect this".
  Full command syntax: see the Usage section in this skill.
---

## Usage

```
Example: /plan add a wine recommendation engine
Usage: /plan <task description>                                  — auto-detected scope
Usage: /plan <task> --scope=backend|frontend|full-stack          — explicit scope hint
Usage: /plan <task> --no-diagram                                 — skip the architecture mermaid block
Usage: /plan <task> --diagram=sequence|graph|er|state            — force a specific mermaid diagram type
Triggers on: "plan", "design this", "architect this", "I want to add",
"let's design", "plan the implementation", "how should we structure this".
```

# Unified Architecture + UX Planner

Single planning skill that produces ONE consolidated plan document, even
for cross-stack work.

**Token efficiency**: principle tables (20 engineering, 26 UX, 17
technical) live in `references/*.md` and load on demand only when the
detected scope needs them. Backend-only work loads only engineering
references; frontend-only loads only UX + technical; full-stack loads
both. Per-invocation cost ≈ what you'd pay for the original skills.

---

## Phase 0 — Repo Stack Detection + Scope Detection

### Repo Stack Detection

```bash
node scripts/cross-skill.mjs detect-stack
```

Returns `{ stack, pythonFramework, detectedFrom }`.

| `stack` | Profile to apply |
|---|---|
| `js-ts` | Universal principles |
| `python` | Universal + Python profile (see references) |
| `mixed` | File-based routing per the touched files; both profiles if both languages |
| `unknown` | Universal principles only |

### Scope (the new bit)

Choose ONE of: `backend`, `frontend`, `full-stack`. Use this
decision tree:

| Signal | Conclusion |
|---|---|
| User explicitly passed `--scope=X` | Use X |
| Task touches only routes/services/models/migrations/CLIs/scripts/server | `backend` |
| Task touches only components/pages/layouts/styles/forms/UI flows | `frontend` |
| Task spans both, OR mentions API + UI together, OR is a feature with user-visible behavior backed by data | `full-stack` |
| Genuinely uncertain | `full-stack` (safer — extra principles cost a few tokens vs missing real concerns) |

**Cite the detected scope at the top of the plan** in a one-liner so
the auditor and reviewer know which principle sets apply.

Lazy reference loading by scope:

| Scope | References to load in Phase 2/3 |
|---|---|
| backend | `references/engineering-principles.md` (+ python-backend-profile if Python) |
| frontend | `references/ux-principles.md` + `references/technical-principles.md` (+ python-frontend-profile if Python+templates) |
| full-stack | All of the above |

---

## Phase 0.5 — Architectural-memory Neighbourhood

If the architectural memory is populated for this repo (a prior
`npm run arch:refresh` succeeded against a Supabase project), consult
the symbol-index for near-duplicates BEFORE proposing new code:

```bash
node scripts/cross-skill.mjs get-neighbourhood --json '{
  "targetPaths": ["<paths/being/touched>"],
  "intentDescription": "<one-line task summary>",
  "kind": ["function","class","component","hook","route","method"]
}'
```

Inline the returned `markdown` field as **"Neighbourhood considered"**
near the top of the plan output. State-handling per the failure matrix:

- `cloud:false` → emit literal `npm run arch:refresh` hint; proceed.
- `cloud:true, records:[]` → "No near-duplicates found — proceed."
- `EMBEDDING_MISMATCH` / `RPC_ERROR` → emit `_consultation failed: <code>; plan proceeds without architectural context_`; continue.
- `BAD_INPUT` → surface to user, abort plan generation.

A `precedent` band means existing code occupies this space: open the named
symbols and decide on the code whether to reuse, extend, or write a sibling —
then record which and why under "Proposed Architecture". The band does not make
that choice; a distance score cannot see dependency direction, API shape or
ownership. `review` = nothing cleared the repo's noise floor (proceed
greenfield); `unscored` = no embedding, so nothing was compared.

The neighbourhood callout includes a **Domain** column showing each
candidate's `domainTag` from `.audit-loop/domain-map.json`. Use this
to spot domain-mismatch reuse candidates (e.g. "the existing helper
is in `wine-shop` but I want to add to `pairing-lab` — should this be
shared?").

### Phase 0.5b — Compute target domain(s) and surface boundary work

Run alongside the neighbourhood query:

```bash
node scripts/cross-skill.mjs compute-target-domains --json '{
  "targetPaths": ["<paths/being/touched>"]
}'
```

Returns `{domains: [...], untaggedPaths: [...], crossDomain: bool, ruleCount}`.

Render two header lines in the plan output (right after the metadata
block):

- **Always** (when `domains.length > 0`):
  `- **Target domain(s)**: \`<d1>\`, \`<d2>\``
- **When `crossDomain === true`** (>1 distinct tagged domain):
  `- ⚠ **Cross-domain work** — touches >1 domain; confirm boundary crossings are intentional.`
- **When `untaggedPaths.length > 0`** (paths matched no rule):
  `- ⚠ **Untagged paths**: \`<p1>\`, \`<p2>\` — these don't match any rule in \`.audit-loop/domain-map.json\`. Consider adding a rule before designing.`

Both warnings are heads-ups, not blocks. They surface architectural
decisions the planner should make explicitly.

### Phase 0.5c — Security incident neighbourhood (proactive memory)

Run alongside the arch-memory + target-domains queries:

```bash
node scripts/cross-skill.mjs get-incident-neighbourhood --json '{
  "targetPaths": ["<paths/being/touched>"],
  "intentDescription": "<one-line task summary>",
  "k": 3
}'
```

Returns `{records, totalCandidatesConsidered, freshnessWarning}`. Render
**only when `records.length > 0`** (don't add a "no incidents — proceed"
line on every plan; that creates noise).

```markdown
> **Past incidents to verify against** (3 shown of 5 total)
>
> | Incident | Affected paths | Status | Lessons |
> |---|---|---|---|
> | **INC-001** — Debug log leaked credit-card numbers | `src/billing/**` | `manual-verification-required` | Route payment logs through redact.mjs; never log raw payloads. |
> | **INC-007** — Stripe webhook accepted unverified payloads | `src/checkout/stripe.js` | `mitigation-passing` (semgrep) | Always verify the signature header before parsing body. |
```

When `freshnessWarning` is non-null (markdown edited since last refresh),
add the warning ABOVE the table:

```markdown
> ⚠ `docs/security-strategy.md` edited since last refresh — run
> `npm run security:refresh` to bring the security index current.
```

When `docs/security-strategy.md` doesn't exist (response will have
`hint` containing the bootstrap suggestion), add a soft warning at the
top of the plan output:

```markdown
> _No security strategy document found. Run `/security-strategy bootstrap`
> to seed one and unlock proactive security memory consultation._
```

Soft warning only — never blocks plan generation.

For any plan that crosses a trust boundary surfaced in the incidents
callout, add a required **"Security Considerations"** section in the
plan output addressing each relevant invariant.

### Phase 0.6 — Read the rendered architecture map for the target domain(s)

If `docs/architecture-map.md` exists AND target domains are non-empty:
**Read** the file (or `Grep` for `## <domain>`) and read the symbol
table beneath each target-domain section. This is the human-curated
view — complements the embedding-based neighbourhood query with the
full inventory of the domain you're working in. Especially valuable
when the domain has its own per-domain Haiku summary at the top
explaining the domain's purpose.

No tool invocation; pure file Read.

---

## Phase 1 — Understand Before You Design

**Explore the codebase FIRST.** The biggest planning failure is
proposing solutions without understanding what already exists.

### Pre-step — Persona test history (frontend or full-stack scope only)

If `PERSONA_TEST_REPO_NAME` is set AND scope ⊇ frontend, check whether
persona testing has surfaced pain points in the area being planned. After
the 20260507 RLS hardening this MUST go through `cross-skill.mjs` (which
uses the service-role key) — anon reads are now blocked at the policy
boundary.

```bash
node scripts/cross-skill.mjs get-persona-sessions-by-repo \
  --repo "$PERSONA_TEST_REPO_NAME" --limit 5 \
  --select persona,focus,verdict,findings,p0_count,p1_count
```

Output shape: `{ok: true, cloud: true|false, rows: [...]}`. When
`cloud:false`, no persona-test database is configured — proceed without
this signal. Filter `rows` whose `focus` overlaps with the feature. If matches
found, include in the Context Summary as **Known user-visible issues**:

```
Known user-visible issues (from persona testing):
  • [P0] Form submit unresponsive — "Pieter" session, Apr 14 (focus: adding a bottle)
  • [P1] No loading state on search — 3 sessions, recurring
```

Treat P0/P1 matches as HIGH priority in the design.

### Exploration checklist (apply the rows that match scope)

**Always**:
1. **Map the landscape**: read the relevant existing files
2. **Identify existing patterns**: how does the codebase already solve similar problems?
3. **Find reusable components**: existing services, utilities, abstractions, components
4. **Check for prior art**: something similar partially built?

**If scope ⊇ backend**:
5. **Trace the data flow**: request lifecycle from route → service → DB and back

**If scope ⊇ frontend**:
6. **Audit the current UI**: read relevant HTML/CSS/JS for the area being changed
7. **Map component landscape**: existing modals, cards, grids, forms, toasts
8. **Identify the design language**: colour palette, typography, spacing, button styles
9. **Trace user flows**: how the user navigates to and through related features
10. **Check responsive behaviour**: how the UI handles different screen sizes
11. **Note pain points**: what feels clunky, inconsistent, or confusing

Do NOT propose a plan until exploration is complete.

---

## Phase 1.5 — Execution Model (backend or full-stack scope only)

Forced question: **Are any planned operations dependent on others?**
If yes, identify chains, prerequisites, and per-chain atomicity.

This phase catches sequencing bugs that surface as HIGH findings in
audit round 3+.

### When this phase matters

- **Batch operations**: moves, imports, migrations — order matters, partial failure needs rollback
- **Multi-step workflows**: wizard flows, onboarding sequences — step N depends on step N-1
- **State transitions**: status changes, approval chains — invalid intermediate states must be prevented
- **Cross-entity operations**: swaps, cycles, rebalancing — A↔B swap is not two independent moves

### What to produce

1. **Dependency graph**: which operations must complete before others can start?
2. **Chain identification**: group dependent operations into atomic chains
3. **Failure semantics**: for each chain — rollback, retry, skip?
4. **Concurrency model**: can chains run in parallel, or must they be serial?

If all operations are independent — document that explicitly and move on.
If ANY dependency exists — define execution order, atomicity boundary,
and partial-failure recovery before proceeding.

For frontend-only scope, this phase typically reduces to "operations are
independent" and you move on quickly.

---

## Phase 2 — Engineering Principles (backend or full-stack scope)

If scope ⊇ backend, every backend design decision is evaluated against
20 principles across:
- **Core Design** (1–10): DRY, SOLID, Modularity, No Hardcoding, Single Source of Truth
- **Robustness** (11–16): Testability, Validation, Idempotency, Transaction Safety, Error Handling, Graceful Degradation
- **Performance & Sustainability** (17–20): N+1 prevention, Backward Compat, Observability, Long-Term Flexibility

Cite principle numbers in the plan's "Proposed Architecture" section
(e.g. `(#1, #11)` next to a decision).

Full tables + anti-patterns: `references/engineering-principles.md`.

If frontend-only scope: skip this phase entirely.

---

## Phase 3 — UX & Design Principles (frontend or full-stack scope)

If scope ⊇ frontend, every UI/UX decision is evaluated against 26
principles across four groups: Gestalt, Interaction/Usability,
Cognitive Load, Accessibility. Plus Nielsen's 10 heuristics as final
cross-check.

Cite numbers in the plan's "UX Design Decisions" section.

Full tables: `references/ux-principles.md`.

If backend-only scope: skip this phase entirely.

---

## Phase 4 — Technical Implementation Principles (frontend or full-stack scope)

If scope ⊇ frontend, evaluate against 17 technical principles across
Component Architecture (#27–31), State Management (#32–35), Event
Handling (#36–39), CSS & Styling (#40–43).

Cite numbers in the plan's "Technical Architecture" section.

Full tables + anti-patterns: `references/technical-principles.md`.

If backend-only scope: skip this phase entirely.

---

## Phase 5 — Long-Term Sustainability

Resist the urge to solve only the immediate problem. Every plan answers:

### Right-sizing gate (when the plan introduces new structure)

The flexibility checklist below biases toward abstraction; this is its
counterweight (**Design right-sizing**, AGENTS.md). **When the plan introduces a
new abstraction, dependency, persistent artifact, or config surface** (the §7b
Gate-1 trigger class — skip for trivial plans), write three lines so the chosen
design is visibly in the middle, not on either cliff:

- **Band-aid extreme** — the quickest patch that leaves the root cause to resurface.
- **Over-engineered extreme** — the fully general/abstract/configurable version.
- **Chosen** — and the **current** requirement it serves. *No current requirement
  → drop the abstraction.* "Might need it later" / "cleaner" / "extensible" is not
  a current requirement (YAGNI overrides the flexibility checklist).

This is a brake, not ceremony: it fires only when new structure is on the table.
Writing both extremes is the forcing function — it makes the right-sized middle
obvious and is harder to rationalise past than a yes/no self-check.

**Manual vs scripted (right-sizing applied to execution).** When a change repeats
across many similar sites — a rename, codemod, data backfill, ≥~5 regular edits —
prefer a **one-off script** *only if* the transformation is regular and
**verifiable** (you can assert the result). If the sites vary, the edit is
judgment-heavy, or there are < ~5 — **do it by hand** (a fragile codemod for
trivial/irregular work is the over-engineering cliff; grinding 50 regular edits
by hand is the band-aid cliff). A throwaway script is a Category-A artifact
(tmp / gitignored), never committed. State which path and why in the plan.

### System-level thinking (always)

- **What assumptions does this design encode?** Which might change?
- **If requirements change in 6 months, what breaks?** Design seams now so changes are localised.
- **Does this tighten or loosen coupling?** Prefer loose coupling — components communicate through well-defined interfaces.
- **Patterns or exceptions?** If this is the first of its kind, design as a pattern others can follow. If it deviates, justify why.

### Architecture flexibility checklist

- [ ] **Data-driven over logic-driven**: behaviour by data/config, not rewriting code?
- [ ] **Strategy pattern over switch**: would a new variant require a new file (good) or modifying existing function (bad)?
- [ ] **Composable pipeline**: can processing steps be added, removed, reordered without rewriting?
- [ ] **Abstraction boundaries**: if we swap DB, AI provider, or external API, how many files change? Target: 1–2 adapter files.
- [ ] **Migration path**: if this outgrows its design, is there a clear upgrade path without rewrite?

### UI-specific (frontend or full-stack scope)

- **What if the design system changes?** CSS variables + reusable classes?
- **What if we add more items/views?** Does the layout scale from 5 to 500? From 3 tabs to 12?
- **What if mobile support tightens?** Is the component architecture responsive-ready?
- **What if accessibility requirements tighten?** ARIA attributes, keyboard flows, focus management already in place?
- **Are we creating a reusable pattern?** First of its kind → design as template.

---

## Phase 6 — Present the Plan

Structure ONE consolidated output document. Section presence depends on scope:

### Always

#### 1. Context Summary
- Detected scope + stack + Python framework (one line)
- What exists today (Phase 1)
- **Code Trace** — the evidence that Phase 1 actually happened. Cite the
  `file_path:line` refs you read and the call path you followed (e.g.
  `route handler `api/wines.js:42` → `wineService.add()` `services/wine.js:88`
  → `db.insert` `db/wines.js:15``). Required on any **non-trivial** plan (the
  §7b Gate-1 trigger class: ≥6 files, ≥2 subsystems, a dependency chain, or
  >1 sitting of work). Trivial single-file plans may write `Code Trace: <file>`
  and move on. An absent or hand-waved trace on a non-trivial plan means the
  design is ungrounded — go back to Phase 1. This bullet makes "trace before
  designing" leave a footprint instead of being an honour-system instruction.
- Patterns reused vs new
- Known user-visible issues (if persona data + frontend scope)
- Neighbourhood considered (if Phase 0.5 fired with results)

#### 2. Proposed Architecture
- **Architecture diagram** — a fenced ` ```mermaid ` block (type from the
  table below). Default-on; skip with `--no-diagram`, or force a type with
  `--diagram=sequence|graph|er|state`.
- Component diagram (which files/modules, how they interact)
- Data flow (request → response path) — backend/full-stack
- User flow + ASCII wireframe — frontend/full-stack
- Key design decisions and **which principles drove them** (cite #N)

The Mermaid block is the **proposed** view — an artifact of this plan, not
a maintained file. It dies with the plan; nothing claims it stays current.
For *existing* structure defer to `docs/architecture-map.md` (the
generated, always-current index). Pick the type from the Phase 0 scope:

| Scope / signal | Mermaid diagram |
|---|---|
| `backend` — request lifecycle | `sequenceDiagram` (route → service → DB → back) |
| `backend` — module structure | `graph LR` component boxes |
| `frontend` | `graph TD` component tree |
| `full-stack` | `graph TD` with one `subgraph` per tier (Client / API / Data) |
| DB schema work | `erDiagram` |

Mermaid renders natively in GitHub and VS Code preview — no tooling needed
for the reader. Copy the exact fence syntax from `examples/mermaid-blocks.md`.

### If scope ⊇ frontend

#### 3. UX Design Decisions
- Key choices and **which UX principles drove them**
- How Gestalt principles shaped the layout
- How cognitive load was managed
- Accessibility approach

#### 4. Technical Architecture (frontend)
- Component diagram (JS modules, how they interact)
- State management approach
- Event handling strategy
- CSS architecture (new classes, variables, responsive approach)

#### 5. State Map (frontend)
For every component, document: Empty / Loading / Error / Success / Edge cases.
For components with a non-trivial state machine, optionally render the
transitions as a `stateDiagram-v2` block — template in
`examples/mermaid-blocks.md`.

### Always

#### 6. Sustainability Notes
- Assumptions that could change
- How the design accommodates future change
- Extension points deliberately built in

#### 7. File-Level Plan
For each file to be created or modified:
- **File path** + purpose
- **Key functions/exports** with brief descriptions
- **Dependencies** (imports + what imports it)
- **Why this file** (which principle justifies it)

##### 7b. Implementation Phases (conditional — Gate 1)
Emit an ordered phase list ONLY when the work is genuinely large —
**Gate 1**: ≥6 files touched, OR ≥2 distinct subsystems/domains, OR a
sequential dependency chain (from Phase 1.5), OR clearly >1 sitting of
work. Otherwise the plan stays flat (§7 only) — **no phases, never a lone
"Phase 1"** (anti-degenerate invariant: a plan with phases always has ≥2).
Keeps ceremony proportional to the work.

Format each phase: `**Phase N — <name>**: <what it does>. Files: <path>
(create|modify|delete), …` — **every file intent-tagged** (the tag drives
`/cycle`'s clustered-audit preflight; see §11). Mechanical close-out
(regenerate / build / lint / verify) is **NOT** a phase — list it
separately as `**Close-out (not a phase)**: <commands>`, excluded from the
§11 partition.

> **Write every path REPO-RELATIVE — `scripts/setup-postgres.mjs`, never
> `setup-postgres.mjs`.** This is not style. `extractPlanPaths`
> (`scripts/lib/plan-paths.mjs`) matches on `(?:[\w.-]+\/)+[\w.-]+\.ext` — it
> requires **at least one `/`**, so a bare basename is invisible to it *anywhere
> in the plan*, including in `Files:` lines and prose.
>
> The failure is silent and actively misleading, which is why it earns a callout.
> Too few resolvable paths and `/audit-code --scope diff` finds an empty
> diff∩plan intersection and **aborts** ("0 implementation files reached the
> prompt") — correct, but it pushes you to `--scope plan`, where **fuzzy keyword
> discovery** fills the scope from plan *words* instead.
>
> **The threshold is exact: fewer than 5 resolvable paths and fuzzy fires**
> (`plan-paths.mjs` — `if (regexFoundCount < 5)`). Measured 2026-07-19 across this
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
> Cheap self-check before persisting — if `found` is small or `missing` is large,
> your paths are basenames:
> ```bash
> node -e "import('./scripts/lib/plan-paths.mjs').then(async m=>{const fs=await import('node:fs');
>   const r=m.extractPlanPaths(fs.readFileSync(process.argv[1],'utf8'),{allowInfraFiles:true});
>   console.log('found',r.found.length,'missing',r.missing.length);})" docs/plans/<name>.md
> ```

#### 8. Risk & Trade-off Register
- Trade-offs made + why
- What could go wrong
- What was deliberately deferred (and why that is OK)

#### 9. Testing Strategy
- What gets unit tested
- What gets integration tested
- Key edge cases
- (Frontend) Visual/manual checklist + a11y testing + responsive breakpoints

### If scope ⊇ frontend

#### 10. Acceptance Criteria (Playwright-verifiable)

Same machine-parseable format the removed `/plan-frontend` skill used to call
Section 9. Drives `/ux-lock verify`. Format:

```
- [SEVERITY] [CATEGORY] <one-line description>
  - Setup: <how to reach the state this asserts on>
  - Assert: <what to check, as a semantic DOM contract>
```

Severity: `P0`/`P1`/`P2`/`P3`. Category (closed set): `visibility`,
`interaction`, `a11y`, `state`, `responsive`, `text`, `navigation`, `other`.

Assertion rules (critical — verify mode cannot work if you break these):
- Assert on **semantic DOM contracts only**: `getByRole(...)`, `getByLabel(...)`, `getByTestId(...)`, `aria-*`, ARIA roles, axe-core
- **Never** reference CSS class names, internal state, or implementation details
- **Never** describe "it should feel fast" — that's `/persona-test` territory
- If a criterion can only be expressed via class selector, propose adding a `data-testid` during implementation

Coverage guidance: ≥1 P0 per primary user flow; ≥1 a11y per new component;
≥1 state criterion for components with loading/error/empty states; ≥1
responsive if mobile is a target.

If you can't write ≥5 criteria for a non-trivial frontend plan, it may
be under-specified — revisit Phase 1 and §5 (State Map).

### Always (conditional)

#### 11. Execution Clustering (conditional — Gate 2)

Emit ONLY when §7b fired AND the phases group into **≥2 clusters** (a real
merge/split decision exists). A large-but-cohesive plan keeps §7b with no
§11; small plans have neither. `/cycle` reads this block to drive clustered
implementation + audit. **Cluster coupled phases** so `/audit-code`'s
cross-cutting wiring pass can inspect the seam between them — clustering is
quality-positive, not just a token saving.

**Grammar** (the contract `/cycle` and `/audit-plan` consume):
1. One bullet per cluster: `- **Cluster <ID>** — Phases <contiguous range> — fix-gate: <yes|final|none>`. Clusters are **contiguous ascending ranges** of §7b, listed in order — this makes cluster order a valid topological order without a separate dependency graph.
2. `Coupling:` sub-bullet (**required**) — WHY these phases group (the auditable claim; the shared seam).
3. **Cluster audit scope is derived, not restated**: it is the union of the member phases' `Files:` (plus an optional `Additional files:` sub-bullet, each entry intent-tagged per §7b). Never add a free-standing per-cluster `Files:` line — that is a second source of truth that drifts.
4. `fix-gate: yes` → cluster must reach `/audit-code` convergence (`HIGH == 0 && MEDIUM <= 2 && quickFix == 0`) before the next builds on it; `final` → last cluster, gated by the consolidated Gemini pass; `none` → no blocking gate.
5. Trailing `- **Final gate**:` line (**required**) — declares the mandatory consolidated Gemini review over the union diff.
6. **Partition invariant**: every §7b *implementation* phase appears in exactly one cluster (none omitted/duplicated); close-out work is outside the phase set and is not clustered.
7. **Optional** `author-tier: economy|standard|frontier` sub-bullet — an **advisory, observation-only** hint of the model tier this cluster's work likely warrants (you MAY derive it from the same scope signals the model-tier observer uses: floor paths → frontier, mechanical-only → economy). `/cycle` **records** it for actual-vs-suggested analysis but **does NOT change which model runs** — there is no router yet (see `docs/plans/model-tier-observation.md`). Omit it unless it adds signal; it never gates anything.

**Authoring**: group coupled phases (cite the seam in `Coupling:`); keep
independent phases splittable; place `fix-gate: yes` before any cluster
that builds on a prior cluster's output; the last cluster is `fix-gate:
final`. ≥2 clusters or omit the block entirely.

---

## Phase 6.5 — Validate diagrams (optional, graceful)

If the plan contains a ` ```mermaid ` block AND the Mermaid Chart MCP is
available this session (`mcp__claude_ai_Mermaid_Chart__validate_and_render_mermaid_diagram`),
validate each block before persisting — a syntax error otherwise renders
as a red error box in GitHub.

- **MCP available** → validate each block; fix any reported syntax error
  in place before Phase 7.
- **MCP not available** → **skip silently and proceed.** The Mermaid MCP
  is an optional convenience, never an install dependency — Mermaid
  renders natively in GitHub and VS Code preview, so an unvalidated block
  still works for the reader. Do not warn the user about the missing MCP.

---

## Phase 7 — Persist the Plan

Save to `docs/plans/<descriptive-name>.md`. Create `docs/plans/` if
needed. Metadata header:

```markdown
# Plan: <Feature Name>
- **Date**: <today's date>
- **Status**: Draft | Approved | In Progress | Complete | Superseded
- **Author**: Claude + <user>
- **Scope**: backend | frontend | full-stack   ← from Phase 0
```

Register in the cross-skill store so audit-plan/audit-code + ux-lock can link:

Include the user's ORIGINAL task description as `taskText` in the SAME payload
— that is what arm-eval scores the arms on. Persisting the plan and dispatching
the capture is then one atomic call (no separate, skippable step):

```bash
node scripts/cross-skill.mjs upsert-plan --json '{
  "path": "docs/plans/<name>.md",
  "skill": "plan",
  "status": "draft",
  "taskText": "<the user's original task description>"
}'
```

Update status as implementation progresses.

### Phase 7.5 — Arm-eval capture (AUTOMATIC — no action)

Capture is now fired by `upsert-plan` itself: when the payload carries
`taskText` and the per-repo `arm-eval-toggle` is on, it dispatches a detached,
blinded A/B/C arm-eval session for that task in the background
(`scripts/lib/arm-eval/capture-trigger.mjs`). You do NOT run a separate
`arm-eval-maybe-capture` command — doing so would double-capture. Toggle off →
byte-identical no-op. The plan YOU wrote is unaffected (the capture generates
its own arm outputs; nothing replaces your plan).

---

## Reminders

- **Detect scope first** — Phase 0 is load-bearing; the rest of the flow keys off it
- **Explore before proposing** — codebase is ground truth, not assumptions; §1's **Code Trace** is the artifact that proves you did (required on non-trivial plans)
- **Name the principles** — every design choice cites which principle(s) it serves (#N)
- **One document, one audit** — no merging child plans, no archive cruft
- **Section 10 acceptance criteria are what `/ux-lock verify` grades** for frontend/full-stack — a **report, not a gate**: verify exits 0 even when criteria fail, and `/ship` does not read `plan_satisfaction`. Write them to be gradeable, not because they block a ship (they don't)
- **Phase the work only when it's large** — §7b/§11 are conditional (Gate 1: ≥6 files / ≥2 subsystems / dep-chain; Gate 2: ≥2 clusters). Never emit a lone "Phase 1"; cluster coupled phases so the audit sees the seam
- **Show every state** — Empty/Loading/Error/Success for any component you design
- **Wireframe before code** — ASCII layouts prevent expensive rework
- **Accessibility is not optional** — baseline, not nice-to-have

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies (scope detection
in Phase 0 tells you which ones).

| File | Summary | Read when |
|---|---|---|
| `references/engineering-principles.md` | 20 engineering principles — core design, robustness, performance, sustainability. | Phase 2 — scope ⊇ backend AND writing Proposed Architecture; need to cite principles. |
| `references/ux-principles.md` | 26 UX + design principles — Gestalt, interaction, cognitive load, accessibility, state/resilience. | Phase 3 — scope ⊇ frontend AND evaluating a design decision. |
| `references/technical-principles.md` | 17 technical implementation principles — component architecture, state, events, CSS/styling. | Phase 4 — scope ⊇ frontend AND writing Technical Architecture. |
| `references/python-backend-profile.md` | Python backend profile — framework-tagged principle checks + stack commands + anti-patterns. | Phase 0 detect-stack returned `python` (or mixed with Python backend files) AND scope ⊇ backend. |
| `references/python-frontend-profile.md` | Python frontend profile — Jinja/Django/Flask template patterns + HTMX + anti-patterns. | Phase 0 detect-stack returned `python` (or mixed with Python frontend files) AND scope ⊇ frontend. |
| `examples/mermaid-blocks.md` | Mermaid diagram templates — sequenceDiagram, graph, erDiagram, stateDiagram-v2 — one per scope. | Phase 6 §2/§5 — emitting an architecture or state diagram; need the exact fence syntax. |

<!-- POISON FIXTURE: a hand-edit to the GENERATED .claude/skills/ copy. The generated tree is Category B; an edit here is invisible until someone regenerates, and until 2026 the only thing standing between that edit and main was this check. -->
