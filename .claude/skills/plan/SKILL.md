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
  component", "improve the UX of". Invoke on the request's shape; don't
  explore the repo for stack context first and answer directly — the skill
  gathers that itself once invoked. Accepts a task description as argument;
  an explicit scope hint and diagram controls are available as flags.
  Triggers on: "plan", "design this", "architect this".
  Full command syntax: see the Usage section in this skill.
allowed-tools: Bash(node scripts/cross-skill.mjs detect-stack)
---

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, `references/worktree-preflight.md` holds the entry to add — ask
> the user first, since it edits their `package.json`.

## Usage

```
Example: /plan add a wine recommendation engine
Usage: /plan <task description>                                  — auto-detected scope
Usage: /plan <task> --scope=backend|frontend|full-stack          — explicit scope hint
Usage: /plan <task> --no-diagram                                 — skip the architecture mermaid block
Usage: /plan <task> --diagram=sequence|graph|er|state            — force a specific mermaid diagram type
Usage: /plan <task> --campaign                                   — an evaluation/test campaign: adds the C1-C12 contract
Triggers on: "plan", "design this", "architect this", "I want to add",
"let's design", "plan the implementation", "how should we structure this".
```

# Unified Architecture + UX Planner

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/plan/SKILL.md` in full before continuing — the later steps still apply.

Single planning skill that produces ONE consolidated plan document, even
for cross-stack work. Principle tables load from `references/*.md` by
detected scope (Phase 0).

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

The callout's **Domain** column flags domain-mismatch reuse candidates
→ `references/context-callouts.md` §Phase 0.5 — read when a candidate sits in another domain.

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
line on every plan; that creates noise). When `freshnessWarning` is non-null,
add a freshness warning ABOVE the table. When the security strategy document
doesn't exist (response carries a `hint`), add a soft bootstrap warning at the
top of the plan output. → `references/context-callouts.md` §Phase 0.5c — read
when rendering any of these three.

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

If scope ⊇ frontend, check whether persona testing has surfaced pain points in
the area being planned. The command resolves the repo itself (`--repo` ->
`PERSONA_TEST_REPO_NAME` from `.env` -> ambient `git remote`) — do NOT
shell-expand the env var into `--repo`, which yields an empty flag in any
session that did not export it. Read it only through `cross-skill.mjs`.

```bash
node scripts/cross-skill.mjs get-persona-sessions-by-repo --limit 5 --select persona,focus,verdict,findings,p0_count,p1_count
```

Output shape: `{ok: true, cloud: true|false, measured, scope:{mode,slug}, rows: [...]}`.
When `cloud:false`, no persona-test database is configured — proceed without
this signal. When `measured:false`, no repo resolved and nothing was read —
also proceed, but never read the empty `rows` as "no findings".

Filter `rows` whose `focus` overlaps with the feature. If matches found, include in the Context Summary as **Known user-visible issues**
(→ `references/context-callouts.md` §Phase 1 — read when rendering that block). Treat P0/P1 matches as HIGH priority in the design.

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
If yes, identify chains, prerequisites, and per-chain atomicity (typical
cases: batch ops, multi-step workflows, state transitions, cross-entity swaps
→ `references/authoring-rationale.md` §Phase 1.5 — read when unsure whether a dependency exists).

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

→ `references/authoring-rationale.md` §Phase 5 — right-sizing gate — read when the three lines feel like ceremony.

**Manual vs scripted**: state in the plan which path the work takes and why
→ `references/authoring-rationale.md` §Phase 5 — manual vs scripted — read when
a change repeats across many similar sites (≥~5 regular edits).

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
  design is ungrounded — go back to Phase 1.
  **Pin every `file:line` to the commit you read it at** — `src/foo.js:42
  (a4ec98da)`. Cite append-newest-first files by section header, never by
  line. → `references/verification-discipline.md` §1; why: `references/authoring-rationale.md` §1 — Code Trace.
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

The Mermaid diagram is the **proposed** view, not a maintained file (existing
structure: the generated architecture map, Phase 0.6; → `references/authoring-rationale.md`
§2 — read when asked to keep the diagram current). Pick the type from the Phase 0 scope:

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
> (the bundle's `lib/plan-paths.mjs`) matches only paths containing a `/`; with
> fewer than 5 resolvable paths the audit's fuzzy keyword discovery fills the
> scope from plan *words* and reviews the wrong code. **Never invent file
> references to clear the threshold** — qualify the paths you genuinely touch.
> → `references/authoring-rationale.md` §7b — read when the count is under 5.
>
> Self-check before persisting (report-only; read the `regex-resolvable` line,
> not `found`/`missing` — fuzzy results are folded into `found`):
> ```bash
> node scripts/lib/plan-paths.mjs "$PLAN"   # $PLAN = the plan file you are about to persist
> ```

#### 8. Risk & Trade-off Register
- Trade-offs made + why
- What could go wrong
- What was deliberately deferred (and why that is OK)

#### 9. Testing Strategy
- What gets unit tested
- What gets integration tested
- Key edge cases
- **Proof plan** (every scope): per behaviour change, the oracle (red test, source check or repeatable calculation), pass condition, report evidence: `references/proof-oracle.md`
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

If the plan contains a ` ```mermaid ` block AND the Mermaid MCP is available
this session, validate each block before persisting — a syntax error otherwise
renders as a red error box in GitHub.

**The tool is `mcp__mermaid__generate_mermaid_diagram`**, from the `mermaid`
server that `.mcp.json` and `.vscode/mcp.json` both register. Pass the block as
`mermaid` and `outputType: "mermaid"` — that echoes the source back instead of
rendering an image, so validation costs nothing. Invalid syntax comes back as an
MCP error carrying the parser's line and column; that error IS the validation.
(Tool-name history: `references/authoring-rationale.md` §Phase 6.5 — read when the tool seems unavailable.)

- **MCP available** → validate each block; fix any reported syntax error
  in place before Phase 7.
- **MCP not available** → **skip silently and proceed.** The Mermaid MCP
  is an optional convenience, never an install dependency — Mermaid
  renders natively in GitHub and VS Code preview, so an unvalidated block
  still works for the reader. Do not warn the user about the missing MCP.

**This does not replace `plans:lint`, and neither replaces the other** (two
blind spots → `references/authoring-rationale.md` §Phase 6.5 — read when one looks redundant).

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

**If this plan must not ship before another plan lands**, say so as a
structured line, not only in prose (→ `references/authoring-rationale.md`
§Phase 7 `Depends on:` — read when tempted to leave it as prose):

```markdown
- **Depends on**: docs/plans/<other-plan>.md — <why, e.g. "wait for Cluster F to land first">
```

One line per dependency; `/cycle` Step 0.5 reads it back with
`node scripts/check-plan-status.mjs --check-deps <this-plan>` — a nudge, never a gate.

Register in the cross-skill store so audit-plan/audit-code + ux-lock can link:

Include the user's ORIGINAL task description as `taskText` in the SAME payload
— that is what arm-eval scores the arms on. **Write the
payload to a file with the Write tool, then pipe it via `--stdin`** — never
inline it into a shell single-quoted string (an apostrophe in the task text
corrupts the call; → `references/authoring-rationale.md` §Phase 7 payload — read when asked why).

1. Write `.claude/tmp/upsert-plan.json` with the Write tool:
   ```json
   {
     "path": "docs/plans/*.md",
     "skill": "plan",
     "status": "draft",
     "taskText": "the user's original task description, verbatim"
   }
   ```
2. Pipe it in:
   ```bash
   cat .claude/tmp/upsert-plan.json | node scripts/cross-skill.mjs upsert-plan --stdin
   ```

Update status as implementation progresses.

### Phase 7.5 — Arm-eval capture (AUTOMATIC — no action)

`upsert-plan` fires arm-eval capture itself — never run `arm-eval-maybe-capture`
too (→ `references/authoring-rationale.md` §Phase 7.5 — read when asked how capture works).

---

## Reminders

- **Detect scope first** — Phase 0 is load-bearing; the rest of the flow keys off it
- **Explore before proposing** — codebase is ground truth, not assumptions; §1's **Code Trace** is the artifact that proves you did (required on non-trivial plans)
- **Name the principles** — every design choice cites which principle(s) it serves (#N)
- **One document, one audit** — no merging child plans, no archive cruft
- **Section 10 acceptance criteria are what `/ux-lock verify` grades** for frontend/full-stack — a **report, not a gate**: verify exits 0 even when criteria fail, and `/ship` does not read `plan_satisfaction`. Write them to be gradeable, not because they block a ship (they don't)
- **Phase the work only when it's large** — §7b/§11 are conditional (Gate 1: ≥6 files / ≥2 subsystems / dep-chain; Gate 2: ≥2 clusters). Never emit a lone "Phase 1"; cluster coupled phases so the audit sees the seam
- **A measurement is a campaign** — an eval, labelled test set or experiment takes `--campaign`: `- **Mode**: campaign`, the C1–C12 `## Campaign Contract`, a dress rehearsal before the real run (`references/campaign.md`)
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
| `references/proof-oracle.md` | Proof oracle for any plan - what proves the change right, its pass condition, and the evidence the report shows. | Phase 6 §9 Proof plan. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Phase 6 §1 — writing the Code Trace, or any `file:line` citation, into the plan document. |
| `references/context-callouts.md` | Render templates for the plan's context callouts — incident table, freshness and bootstrap warnings, persona issues. | Phase 0.5c returned records, a `freshnessWarning` or a `hint`, OR Phase 1 persona rows matched the feature. |
| `references/authoring-rationale.md` | Why /plan's authoring rules exist — Code Trace, repo-relative paths, Mermaid checks, payload file, Depends on. | A rule is questioned, fewer than 5 plan paths resolve, OR a change repeats across ≥~5 similar sites. |
| `references/campaign.md` | Campaign mode — the C1-C12 contract an evaluation or test campaign plan must carry, and the dress-rehearsal gate. | `--campaign` was passed, OR the plan's output is a measurement (eval, test set, experiment). |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /plan —
