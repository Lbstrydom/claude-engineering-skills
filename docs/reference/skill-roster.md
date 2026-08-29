# Skill roster — per-skill scope, and the naming convention

Moved out of `AGENTS.md` (2026-08-10) under its progressive-disclosure rule:
subsystem-grade detail belongs in `docs/` with a short stub in AGENTS.md,
because AGENTS.md is loaded every session and size is a cost. AGENTS.md keeps the
invariants that constrain *any* change to a skill; the chain diagram and the
one-line scope per skill moved here on 2026-08-29. Everything below is the
elaboration.

Each skill is a sibling — they share env vars and the cloud audit store but have
distinct scopes. The authoritative flow for each lives in `skills/<name>/SKILL.md`;
this file records the scope boundaries and the design invariants that are not
obvious from reading the skill.

## The chain, and which lens is which

Moved from `AGENTS.md` 2026-08-29 under the same progressive-disclosure rule
that created this file: the diagram and the one-line-per-skill index are the
elaboration of a pointer, and AGENTS.md had run to 40 characters of headroom.
The invariants that constrain *any* change to a skill stayed there.

```
/plan                             → architecture & UX planning (auto-detects backend/frontend/full-stack)
        ↓
/audit-plan                      → iterative plan refinement (max 3 rounds, rigor-pressure stop)
        ↓
/audit-code                      → multi-pass code audit (R2+ suppression, debt capture)
        ↓
(/cycle runs this whole chain end-to-end, pausing for human implementation between audit-plan and audit-code)
        ↓
/ux-lock                         → Playwright e2e spec for each fix (locks in DOM contract)
        ↓
deploy to Railway / live URL
        ↓
/click-test + /persona-test + /nav-audit + /visual-audit → four lenses: page DOM ∥ journey narrative ∥ system IA/nav ∥ paint/visual
  (structural)  (narrative)   (system)    (paint)        Disjoint coverage — run on UI PRs. nav-audit + visual-audit are static (--verify <url> confirms against the live app).
        ↓
/ship                            → commit + push (with UX P0 warning from persona-test)
```

Which lens, not how it works — every mode, flag and mechanism is in the roster:

- **plan** — code that doesn't exist yet; its frontend path emits the machine-parseable "Acceptance Criteria" section `/ux-lock verify` consumes.
- **audit-plan** — refines a plan before implementation. Single-file edits.
- **audit-code** — code just written: LLM passes + R2+ suppression + mechanical waves.
- **ux-lock** — locks a fix's DOM contract (Playwright e2e); verify mode grades a plan against the live app.
- **persona-test** — deployed app, narrative QA (exploratory · pair · consistency).
- **click-test** — deployed app, structural DOM audit; catches what personas never trigger, because there's no narrative reason to notice it.
- **nav-audit** — the **system** lens (persona=journey, click=page, nav=system): is what's OFFERED what's NEEDED?
- **visual-audit** — the **paint** lens: math-first, deterministic; the VLM never gates.
- **ship** — packaging and delivery.

## `plan`

Code that doesn't exist yet. Unified planner (auto-detects backend / frontend /
full-stack); the frontend/full-stack path produces a machine-parseable
"Acceptance Criteria" section that `/ux-lock verify` consumes.

## `audit-plan`

Refines plans before implementation (max 3 rounds, rigor-pressure stop).
Single-file edits.

## `audit-code`

Code that was just written (5-pass parallel static analysis + LLM audit + R2+
suppression).

**Duplication wave.** Always also runs a mechanical duplication wave (pure-Git
diff attribution against the architectural-memory index, read-only). Suppress an
intentional duplicate with a
`// @duplicate-justification: target=<file>:<symbol> reason=<why>` pragma above
the declaration; see `skills/audit-code/SKILL.md` and
[`docs/plans/audit-code-duplication-wave.md`](../plans/audit-code-duplication-wave.md).

**Wave 6 — containment adjacency ("what else is in this branch?").** A diff hunk
landing inside an `if` branch triggers enumeration of that branch's other
top-level statements, each classified as condition-dependent or *merely nested*
(trapped). **Four invariants not to "simplify":**

1. Enumeration is never the LLM's job — the bouncer only judges what it's handed.
2. The trigger is the **diff**, never a finding.
3. `clean` is unconstructable without real coverage, and the state label never
   gates emission.
4. `buildAdjacencyState` has exactly one call site.

Containers are conditionals only, never functions — that is the cost bound. Opt
out via `--passes`; bounds are `adjacencyConfig` / `ADJACENCY_*`, **not**
`symbolIndexConfig`. Plan:
[`adjacency-check-containment.md`](../plans/adjacency-check-containment.md).

**Adding a mechanical wave?** Declare it in `MECHANICAL_WAVES`
([`audit-shadow.mjs`](../../scripts/lib/audit-shadow.mjs)) or `PASS_PROMPTS`
silently enrols it in the model-A/B/C shadow's **paid** generator comparison.

## `ux-lock`

Code that was just fixed (Playwright e2e regression lock).

**Verify mode** (`/ux-lock verify <plan.md>`) grades a `/plan` plan against its
live implementation — each criterion becomes a Playwright test case; results
populate `plan_verification_runs` + `plan_verification_items`.

**Selector policy (2026-07).** Generated specs LOCATE via the semantic ladder
(`getByRole` → `getByLabel`/`getByPlaceholder` → `getByText` → `getByTestId` →
justified-structural CSS carrying `// selector-policy: structural — <reason>`).
`ux-lock-run.mjs` lints every spec it runs plus its local-helper import closure
(unmarked structural selectors, `app-module-import` — specs must never import app
source; drive the UI). Warn by default, `--strict-selectors` exits 6; unjustified
counts persist per run row (`selector_policy_violations`, migration
`20260703200000`).
[`scripts/lib/ux-lock/selector-policy.mjs`](../../scripts/lib/ux-lock/selector-policy.mjs)
`classifySelector` is the **single policy oracle** — never add a second
classifier. Plan:
[`docs/plans/ux-lock-selector-policy.md`](../plans/ux-lock-selector-policy.md).

## `persona-test`

Deployed app, narrative QA. Three execution modes:

- **Exploratory** (default, MCP-driven): persona walks the app via Playwright
  MCP, finds UX issues, writes a P0-P3 report + debrief.
- **Pair** (`--pair "<p1>" "<p2>" <url>`): runs two opposed-expertise personas
  back-to-back, diffs findings into CONSENSUS / A-ONLY / B-ONLY buckets. Use when
  coverage matters more than speed — empirically ~92% disjoint findings.
- **Consistency mode** (`--mode consistency --canary <name>`, code-driven
  Playwright): deterministic runner against a canary journey + a `surfaces.json`
  manifest declaring `data-engine-claim` HTML attributes. Detects cross-step
  UI/state contradictions (DOM-vs-network-truth, stale-projection,
  undeclared-engine-claim, missing-surface). Contradictions land in the session
  ledger, and the canary's own `expectedContradictions` is the gate. The
  candidate/promotion path that turned them into generated Playwright specs was
  **retired 2026-08-11** — it never wrote a row, and a browser spec is the wrong
  artifact for a DOM-vs-engine contradiction (a declaration or a renderer
  contract test is). Note the gate counts rather than names: `max` is the only
  journey-level lock left, and raising it silently unlocks every past defect on
  that journey. HTML attribute contract:
  [`consistency-contract.md`](consistency-contract.md).

## `click-test`

Deployed app, structural DOM audit. Mechanical complement to persona-test — walks
every interactive element, asserts semantic-HTML contracts (duplicate IDs, orphan
labels, inputs without names, ARIA misuse, heading hierarchy, missing alt,
undersized touch targets). Catches issues personas never trigger because there's
no narrative reason to notice them. Optional `--with-modals` opens each
modal/dropdown and re-scans the live DOM. Cache-busts service workers before
scanning.

## `nav-audit`

The **system-level** third UX lens (persona=journey, click=page, nav=system).
Static, code-derived audit of the WHOLE navigation graph — every entry point ×
destination via `@babel/parser` AST (plus a string/template scan so vanilla
template-HTML apps work), run through a 10-class taxonomy (orphan, coverage-gap,
redundancy, competing-models, anchor-regression, …) asking "is what's OFFERED
what's NEEDED?", grounded in the persona registry.

**Two-artifact split**: route facts colocate in code (`navMeta` / `@nav`
docblock), product intent in a committed `nav-contract.json`, the observed graph
gitignored + regenerated. CI gate is **drift-only** (a declared-intent regression
on the changed surface).

`--verify <url>` reconciles static-vs-live, attributes each live destination to
its DOM-container layer for a per-persona scorecard, and runs the
layer-attribution classes over LIVE evidence (`source:'live'`) that the static
taxonomy cannot model.

**Capture honesty (v1.4)**: a visible-but-empty or never-observable nav container
is `unverifiable` and degrades to `unverified` rather than emit an authoritative
`missing`/`misplaced`; the activation pass aborts after 3 unactionable triggers so
it cannot amplify a degraded app's storm.

Plans: [`nav-audit-skill.md`](../plans/nav-audit-skill.md),
[`nav-audit-v1.3-live-findings.md`](../plans/nav-audit-v1.3-live-findings.md),
[`nav-audit-debt-digest-decouple.md`](../plans/nav-audit-debt-digest-decouple.md),
[`nav-audit-v1.4-capture-honesty.md`](../plans/nav-audit-v1.4-capture-honesty.md).

## `visual-audit`

The **paint-level** fourth UX lens (persona=journey, click=page, nav=system,
**visual=paint**). Math-first, deterministic — drives Playwright +
`getComputedStyle` + `getBoundingClientRect` + CDP `forcePseudoState` to assert
what the page *paints*; the VLM (`--explain`) is advisory and never gates.

**Verify-primary** (unlike static-primary nav-audit): paint cannot be asserted
without rendering, so the static run parses token sources only and emits NO paint
findings (the banner says so).

`--verify <url>` runs four tiers:

1. declared-token reconciliation (cascade-resolved, else `token_violation`);
2. theme parity — geometry must match for nodes rendered in BOTH themes;
   untokened literals identical across themes are `theme_unmapped_token`;
3. layout physics (overflow / clipping / overlap / image distortion);
4. the signifier matrix (`missing_visible_focus`, `state_has_no_visual_delta`,
   `disabled_not_signified`) read via forced pseudo-state after freezing
   transitions.

**Two-artifact split**: committed `visual-contract.json`; gitignored
`.audit-loop/visual-*.json`. CI gate is **drift-only** via the canonical
`ChangedScopeResolver`. Capture honesty: an absent/empty-skeleton surface or
unresolvable backdrop degrades to `unverified`, never a false authoritative
finding.

**Scope firewall** (verbatim in SKILL.md): *"include a check only if you can
assert it on a computed style without knowing what the page is FOR"* — signifiers
in, affordance judgments out (those are persona-test's). Plan:
[`visual-audit-skill.md`](../plans/visual-audit-skill.md).

## `ship`

Packaging and delivery. (Step 5.6 promoted consistency candidates into locked
Playwright specs; it was removed 2026-08-11 with the rest of that path.)

---

## Naming convention — two families, don't force a uniform prefix

Names encode *mechanism*, and there are two legitimate families:

- **`audit-*` (verb-first)** = the GPT+Gemini multi-round adjudication loop over
  a static artifact: `audit-plan`, `audit-code`, `audit-loop`. They share rounds
  + ledger suppression + a Gemini final gate.
- **UX-lens suffix** = the live/static UI checks. The suffix tells you the
  driver: **`-test` = pure live-browser walk** (`persona-test`, `click-test`);
  **`-audit` = static extract + `--verify` reconcile** (`nav-audit`,
  `visual-audit`).

So the pairs are already consistent. Renaming the lenses to
`audit-nav` / `audit-click` would *break* this: the `audit-` prefix would falsely
imply membership in the adjudication-loop family (rounds / ledger / Gemini) the
lenses don't have.

Grammar test: you "audit *the plan/code*" (verb+object) but you run "a *nav
audit*" (compound noun).
