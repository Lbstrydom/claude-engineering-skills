# AGENTS.md — Claude Engineering Skills

> **Canonical project context for all AI coding agents.** Read by Claude Code,
> Claude in VS Code, GitHub Copilot, Cursor, Windsurf, Codex CLI, Gemini CLI.
> Claude users — see [CLAUDE.md](./CLAUDE.md) for Claude Code-specific
> addenda; everything below is shared.
>
> **This file holds load-bearing invariants, not dossiers — it's loaded every
> session, so size is a cost.** Subsystem-grade operational detail (connection
> recipes, env tables, migration mechanics) belongs in `docs/` with a short
> *what-it-is / when-you-need-it / pointer* stub here, mirroring the skill
> `SKILL.md ≤3K + references/` progressive-disclosure pattern. Same "avoid the
> messy middle" discipline as the generated-artifact policy below, applied to this
> file itself. **Enforced since 2026-07-13**: `npm run context:check` (run by
> the pre-push hook and `/ship` Step 4) fails on `ctx/oversized-agents-md`
> when this file exceeds **92000 characters** — condense a dossier section to a
> stub + `docs/<topic>.md` rather than raising the cap. **Characters, not lines,
> since 2026-08-01**: the two costliest bullets here were ONE line each (~2.5K
> chars), so the old line cap was blind to its own worst case. 92K is the same
> strictness, not a new budget — this file measured 91,201 chars sitting exactly
> at the old 1200-line cap.

<!-- arch-map-discoverability:start -->
> **Architecture map**: [`docs/architecture-map.md`](docs/architecture-map.md)
> is the live, generated index of every symbol in this repo. Start there
> when you need to find an existing function, class, or component before
> writing a new one.
>
> **Domain roster drift is gated.** [`docs/architecture-intent.md`](docs/architecture-intent.md)
> documents each domain as a `### \`<domain>\`` heading; **This doc + `.audit-loop/domain-map.json` together enforce**
> that the two agree. `npm run docs:architecture-intent:check` (in the pre-push
> `check`) fails when the map declares a domain the doc never documents — the
> reverse is never flagged, since the doc may retain retired domains as
> rationale. It landed 2026-08-02 after sitting unmerged for 110 commits, during
> which the doc drifted to 12 headings against a 36-domain map.
>
> **Bootstrap / refresh order** — when the map is stale, missing, or after
> editing [`.audit-loop/domain-map.json`](.audit-loop/domain-map.json):
> `npm run dashboard:setup` (chains `arch:refresh` → `arch:render` →
> `dashboard:build`). Domain re-tagging happens in `arch:refresh` against
> the symbol_index table — editing `domain-map.json` alone does not retag
> existing DB rows; always start with `arch:refresh` after a rename.
>
> **Two-layer dependency model** (Architecture tab tiers):
> - **Observed** — DB import graph from `symbol_file_imports`, written
>   to [`.audit-loop/domain-deps-observed.json`](.audit-loop/domain-deps-observed.json)
>   by `arch:render`, regenerated every render, gitignored. Evidence
>   layer: this is what code *actually* imports.
> - **Manual** — `allowedDeps` block inside `domain-map.json`, committed.
>   Intent layer: architectural rules the import graph cannot see
>   (dynamic imports, intentionally-forbidden edges, framework wiring).
>
> The dashboard reader merges both with per-edge provenance (`source ∈
> {observed, manual, both}`). Manual entries are NOT a fallback — they
> add architectural intent the import graph misses. The reader Zod-
> validates the observed envelope and rejects it as stale when the
> domain-map rules digest changes without a fresh `arch:render`.
> **Coverage honesty**: the envelope also carries a `coverage` verdict counting what
> the graph DROPPED; absent reads `unknown`, never clean. `npm run arch:coverage-gate`
> owns the exit code — in `check`, NOT `dashboard:setup`. [Design](docs/plans/observed-graph-coverage-honesty.md)

> **Generated-artifact policy (invariant — avoid the "messy middle").** Every
> generated file lands in exactly ONE of two categories; never tracked-but-
> unverified-and-volatile:
> - **A — derived from external/mutable state OR carrying volatile provenance
>   (timestamps, HEAD shas) → gitignored.** It is not source and cannot be a
>   pure function of committed source. Examples: `.audit-loop/domain-deps-observed.json`
>   (DB import graph), `.audit-loop/cache/`, **`dashboard/index.html` +
>   `dashboard/telemetry.html`** (local-only, rebuilt by `npm run dashboard`),
>   `.audit-loop/repo-alias-map.json` (spent reconcile intermediate), **the
>   `scripts/.sync-manifest.json`** (timestamp + HEAD sha ⇒ per-push churn;
>   gitignored in BOTH source and consumers since 2026-07-21 — Feature B of
>   `sync-ownership-from-content.md`, once ownership moved to content banners and
>   `sync-isolation-verify` read it from disk), **`docs/architecture-map.md`** (reclassified B → A
>   2026-07-20: header carries a timestamp + commit sha + refresh_id, the body
>   carries 33 LLM-written domain summaries, and it renders from the CLOUD
>   symbol_index — three independent reasons two renders of one commit differ;
>   regenerate with `npm run arch:render`).
> - **B — a pure, deterministic function of committed source → committed AND
>   freshness-verified in the pre-push `check`.** Regeneration must be byte-
>   identical (no clocks/shas/network). Example: `.claude/skills/**` (regen by
>   `skills:regenerate`, enforced by `skills:check`); `docs/plans/README.md`, the
>   status-bucketed plans index (`plans:index` / `plans:index:check`);
>   `docs/requirements-map.md` (`requirements:map` / `requirements:map:check`).
>
> The test for a tracked generated file: *would two regenerations on the same
> commit be byte-identical, and does a check enforce it?* If no → it belongs in
> A (gitignore it), not committed. A committed artifact whose dirtiness carries
> no information is churn, not a reference. (The dashboard reference page lived
> in the messy middle until 2026-06 — see `docs/plans/local-dashboard.md` §2.1.)
<!-- arch-map-discoverability:end -->

> **Design right-sizing — the simplest structurally-honest solution.** At any
> non-trivial fork, reject BOTH cliffs: the **band-aid** (patch the symptom or
> defer the real fix *because it's harder* — the root cause resurfaces) and the
> **over-engineering** (an abstraction / config / artifact no *current*
> requirement needs). Forcing question before committing: *"what's the band-aid,
> what's the over-built version, and why is mine the smallest thing that's a true
> function of the problem?"* `/plan` and `/audit-code` carry the full check; a
> `defer`/accept-debt is honest only as a true scope boundary or documented debt,
> **never because the correct fix is larger**.
>
> **Scope is decided by impact, not authorship (load-bearing test).** The
> companion failure mode: dismissing a finding as "out-of-scope / pre-existing /
> not introduced by this change" when the change being shipped actually *depends*
> on the cited code path. Authorship ("did I write this line?") and ownership
> ("does the plan own this section?") are the wrong test; **impact** is the right
> one — *does the correctness or stability of what I'm shipping ride on this
> path?* If yes, it is in-scope **for the fix/defer decision** even when
> pre-existing, and a silent defer is the band-aid. A pre-existing finding in a
> *changed* file is a yellow flag (you usually touched it because your change now
> rides on it), and passing tests don't clear it — a green suite only covers
> exercised paths. Legitimate `defer` therefore requires naming the
> **independence** (the new code does not call/depend on the cited path), not the
> authorship. `/audit-code` (Step 3) and `/audit-plan` (Step 3) both enforce this.

## Project Overview

**Purpose**: A bundle of 16 AI-pair-programming skills covering the full development quality lifecycle — from planning through code audit to live UX testing and shipping.
**Runtime**: Node.js (ESM modules, `"type": "module"`)
**Deployment**: CLI scripts + skill files, invoked by AI coding assistants (Claude Code, Copilot, Cursor, Windsurf)
**Repo**: Renamed from `claude-audit-loop` to `claude-engineering-skills` (Phase E)

## Skill Chain

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

**Skill file structure** (Phase B.1+ — progressive disclosure):

```
skills/<name>/                   ← authoritative; edit ONLY here
├── SKILL.md                     ← canonical flow; ≤3K tokens target
├── references/<topic>.md        ← rare/edge content, loaded on demand
└── examples/<sample>.md         ← optional output templates

.claude/skills/<name>/            ← generated copy — run `npm run skills:regenerate`
```

> **Note**: `.github/skills/<name>/` was a previously-generated mirror, deprecated in Phase 4 of ai-context-sync (at the time, no documented AI tool read it). **Updated 2026-07-21 (Copilot-compat audit)**: VS Code Copilot's Agent Skills (GA + default-on since VS Code 1.109, Jan 2026) natively discovers THREE workspace roots — `.github/skills/`, `.claude/skills/`, and `.agents/skills/` — plus personal dirs (`~/.copilot/skills`, `~/.claude/skills`, `~/.agents/skills`). Collision precedence between roots is **NOT officially documented** (the earlier "`.github/skills` wins" claim traces only to third-party sources) — so the robust rule is *never ship the same skill name in two discovered roots*. Keeping `.github/skills` deleted stays load-bearing: a stale resurrected copy is an undefined-behavior collision against the fresh `.claude/skills` copies (found live in ai-organiser 2026-07-21 — a 2025-era leftover shadowed 3 skills; sync deliberately never deletes it in consumers, so check `.github/skills/` AND `.agents/skills/` when a consumer's Copilot behaves oddly).
>
> The committed `.claude/skills/**` is the single Copilot-native surface. Contract (enforced by `skills:check` + verified in the 2026-07-21 audit): frontmatter `name` must equal the directory name and match `^[a-z0-9-]{1,64}$` (violation = **silent skip**); `description` is required, **max 1024 chars** — keep trigger phrases in the description, move Usage/Examples syntax into the SKILL body (`Full command syntax: see the Usage section in this skill.`). **The budget half of that claim was fiction until 2026-08-04**: only `name` was enforced (poison-tested), while `investigate` 1257 / `explain` 1152 / `ux-lock` 1062 sat over the cap with `skills:check` green — a stated-but-unenforced gate, the class the gate-honesty suite exists to catch. [`check-skill-descriptions.mjs`](scripts/check-skill-descriptions.mjs) now enforces the budget **and** forbids two skills advertising the same literal trigger phrase (one live clash: `"verify the plan"` in both audit-plan and ux-lock). Exact-match only, deliberately: fuzzy matching was measured at 47 cross-skill noise pairs (Jaccard ≥0.5, mostly one shared word) and rejected. Semantic overlap has no oracle — declare the discriminator in BOTH descriptions instead (*topic* → `/explain --history`, *claim* → `/investigate`). Copilot also reads `CLAUDE.md` + `AGENTS.md` + `.github/copilot-instructions.md` (all default-on) — mind duplication cost when editing. **The `.github/prompts/*.prompt.md` shim surface was RETIRED 2026-07-21**: since VS Code 1.109 skills surface as `/name` slash commands in the SAME namespace as prompt files, so same-basename shims collided with their own skills (and half pointed at non-existent CLIs). `.claude/skills/**` is now the sole Copilot slash-command surface — do not re-introduce a `.github/prompts` generator. MCP: VS Code reads `.vscode/mcp.json`, NOT Claude's `.mcp.json` — keep the two mirrored when adding servers. **`--keep-github-skills` was removed entirely 2026-07-28** (`docs/plans/refactor-skill-governance.md`) — from `regenerate-skill-copies.mjs`, `install-skills.mjs`, and `sync-to-repos.mjs` alike. None of the three write paths can resurrect `.github/skills/` any more; `regenerate-skill-copies.mjs` now actively deletes a pre-existing tree in this repo, and `check-stale-skill-surface.mjs` remains the drift backstop for a consumer-repo copy created by other means.

> **Skills install REPO-SCOPED, never machine-global (invariant, 2026-07-30).** A SKILL.md is only valid alongside the runner layout it cites (`scripts/X.mjs` here, `scripts/.claude-skills/X.mjs` in a consumer), and `~/.claude/skills/` is ONE directory shared by every repo — layout-agnostic by construction, so **no correct content for it exists** and rewriting it merely flips which repo is broken (it was also 15 name collisions against every synced consumer, the hazard the note above forbids). The `claude` (`~/.claude/skills/`) and `agents` (`.agents/skills/`) install surfaces are therefore **retired**: `resolveSkillTargets` throws for both plus `both`; `install-skills.mjs` no longer installs and exists only for `--uninstall-legacy` (receipt-bounded, so it can never touch a skill you wrote); `.githooks/post-merge` is **deleted** — it regenerated committed, freshness-verified artifacts and its only real effect was creating the global tree. Installing anywhere is one command: `npx github:Lbstrydom/claude-engineering-skills <dir>`, or `npm run sync -- --target-path <dir>` from here; `CONSUMER_REPOS` is the maintainer's convenience list, not a gate on who may install. Proposing a new skill-install surface? Answer first: *which of the two layouts does its content belong to, and what stops it colliding with `.claude/skills/`?* Full model + migration: [`docs/reference/skill-surface-ownership.md`](docs/reference/skill-surface-ownership.md).

Every reference file has `summary:` YAML frontmatter that must byte-match the
parent SKILL.md's reference-index row. `npm run skills:check` enforces this — see
`docs/reference/skill-reference-format.md`. A skill MAY also carry a colocated
`gate-contract.json` binding a stated gate to its enforcing code+test (never
packaged/synced; no contract = `uncontracted`, not failed) — `npm run
skills:check`/`gates:check` validate it; details: `docs/reference/gate-honesty.md`.

Each skill is a sibling — they share env vars and the cloud audit store but have distinct scopes:
- **plan**: code that doesn't exist yet. Unified planner (auto-detects backend/frontend/full-stack); the frontend/full-stack path produces a machine-parseable "Acceptance Criteria" section that `/ux-lock verify` consumes.
- **audit-plan**: refines plans before implementation (max 3 rounds, rigor-pressure stop). Single-file edits.
- **audit-code**: code that was just written (5-pass parallel static analysis + LLM audit + R2+ suppression). Always also runs a mechanical **duplication** wave (pure-Git diff attribution against the architectural-memory index, read-only) — suppress an intentional duplicate with a `// @duplicate-justification: target=<file>:<symbol> reason=<why>` pragma above the declaration; see `skills/audit-code/SKILL.md` and `docs/plans/audit-code-duplication-wave.md`. **Wave 6 — containment adjacency ("what else is in this branch?")**: a diff hunk landing inside an `if` branch triggers enumeration of that branch's other top-level statements, each classified as condition-dependent or *merely nested* (trapped). Four invariants not to "simplify": enumeration is never the LLM's job (the bouncer only judges what it's handed); the trigger is the **diff**, never a finding; `clean` is unconstructable without real coverage, and the state label never gates emission; `buildAdjacencyState` has exactly one call site. Containers are conditionals only, never functions (that's the cost bound). Opt out via `--passes`; bounds are `adjacencyConfig`/`ADJACENCY_*`, not `symbolIndexConfig`. Adding a mechanical wave? Declare it in `MECHANICAL_WAVES` ([`audit-shadow.mjs`](scripts/lib/audit-shadow.mjs)) or `PASS_PROMPTS` silently enrols it in the model-A/B/C shadow's **paid** generator comparison. Plan: [`adjacency-check-containment.md`](docs/plans/adjacency-check-containment.md).
- **ux-lock**: code that was just fixed (Playwright e2e regression lock). **Verify mode** (`/ux-lock verify <plan.md>`) grades a `/plan` plan against its live implementation — each criterion becomes a Playwright test case; results populate `plan_verification_runs` + `plan_verification_items`. **Selector policy (2026-07)**: generated specs LOCATE via the semantic ladder (`getByRole` → `getByLabel`/`getByPlaceholder` → `getByText` → `getByTestId` → justified-structural CSS carrying `// selector-policy: structural — <reason>`); `ux-lock-run.mjs` lints every spec it runs plus its local-helper import closure (unmarked structural selectors, `app-module-import` — specs must never import app source; drive the UI). Warn by default, `--strict-selectors` exits 6; unjustified counts persist per run row (`selector_policy_violations`, migration `20260703200000`). [`scripts/lib/ux-lock/selector-policy.mjs`](scripts/lib/ux-lock/selector-policy.mjs) `classifySelector` is the single policy oracle — `candidate-spec.mjs` reuses it so consistency-candidate promotion emits the same markers. Plan: `docs/plans/ux-lock-selector-policy.md`.
- **persona-test**: deployed app, narrative QA. Three execution modes:
  - **Exploratory** (default, MCP-driven): persona walks the app via Playwright MCP, finds UX issues, writes a P0-P3 report + debrief.
  - **Pair** (`--pair "<p1>" "<p2>" <url>`): runs two opposed-expertise personas back-to-back, diffs findings into CONSENSUS / A-ONLY / B-ONLY buckets. Use when coverage matters more than speed — empirically ~92% disjoint findings.
  - **Consistency mode** (`--mode consistency --canary <name>`, code-driven Playwright): deterministic runner against a canary journey + a `surfaces.json` manifest declaring `data-engine-claim` HTML attributes. Detects cross-step UI/state contradictions (DOM-vs-network-truth, stale-projection, undeclared-engine-claim, missing-surface). Emits `regression_specs` candidates with full witness snapshots; `/ship` Step 5.6 promotes them to locked Playwright specs. See `docs/reference/consistency-contract.md` for the HTML attribute contract.
- **click-test**: deployed app, structural DOM audit. Mechanical complement to persona-test — walks every interactive element, asserts semantic-HTML contracts (duplicate IDs, orphan labels, inputs without names, ARIA misuse, heading hierarchy, missing alt, undersized touch targets). Catches issues personas never trigger because there's no narrative reason to notice them. Optional `--with-modals` opens each modal/dropdown and re-scans the live DOM. Cache-busts service workers before scanning.
- **nav-audit**: the **system-level** third UX lens (persona=journey, click=page, nav=system). Static, code-derived audit of the WHOLE navigation graph — every entry point x destination via `@babel/parser` AST (plus a string/template scan so vanilla template-HTML apps work), run through a 10-class taxonomy (orphan, coverage-gap, redundancy, competing-models, anchor-regression, ...) asking "is what's OFFERED what's NEEDED?", grounded in the persona registry. Two-artifact split: route facts colocate in code (`navMeta`/`@nav` docblock), product intent in a committed `nav-contract.json`, the observed graph gitignored + regenerated. CI gate is **drift-only** (a declared-intent regression on the changed surface). `--verify <url>` reconciles static-vs-live, attributes each live destination to its DOM-container layer for a per-persona scorecard, and runs the layer-attribution classes over LIVE evidence (`source:'live'`) that the static taxonomy cannot model. **Capture honesty (v1.4)**: a visible-but-empty or never-observable nav container is `unverifiable` and degrades to `unverified` rather than emit an authoritative `missing`/`misplaced`; the activation pass aborts after 3 unactionable triggers so it cannot amplify a degraded app's storm. Plans: `docs/plans/nav-audit-skill.md`, `nav-audit-v1.3-live-findings.md`, `nav-audit-debt-digest-decouple.md`, `nav-audit-v1.4-capture-honesty.md`.
- **visual-audit**: the **paint-level** fourth UX lens (persona=journey, click=page, nav=system, **visual=paint**). Math-first, deterministic — drives Playwright + `getComputedStyle` + `getBoundingClientRect` + CDP `forcePseudoState` to assert what the page *paints*; the VLM (`--explain`) is advisory and never gates. **Verify-primary** (unlike static-primary nav-audit): paint cannot be asserted without rendering, so the static run parses token sources only and emits NO paint findings (the banner says so). `--verify <url>` runs four tiers: declared-token reconciliation (cascade-resolved, else `token_violation`), theme parity (geometry must match for nodes rendered in BOTH themes; untokened literals identical across themes are `theme_unmapped_token`), layout physics (overflow / clipping / overlap / image distortion), and the signifier matrix (`missing_visible_focus`, `state_has_no_visual_delta`, `disabled_not_signified`) read via forced pseudo-state after freezing transitions. Two-artifact split: committed `visual-contract.json`; gitignored `.audit-loop/visual-*.json`. CI gate is **drift-only** via the canonical `ChangedScopeResolver`. Capture honesty: an absent/empty-skeleton surface or unresolvable backdrop degrades to `unverified`, never a false authoritative finding. Scope firewall (verbatim in SKILL.md): *"include a check only if you can assert it on a computed style without knowing what the page is FOR"* — signifiers in, affordance judgments out (those are persona-test's). Plan: `docs/plans/visual-audit-skill.md`.
- **ship**: packaging and delivery (now includes Step 5.6 candidate promotion when consistency mode is adopted)

> **Skill naming convention (two families — don't "fix" by forcing a uniform prefix).**
> Names encode *mechanism*, and there are two legitimate families:
> - **`audit-*` (verb-first)** = the GPT+Gemini multi-round adjudication loop over a
>   static artifact: `audit-plan`, `audit-code`, `audit-loop`. They share rounds +
>   ledger suppression + a Gemini final gate.
> - **UX-lens suffix** = the live/static UI checks. The suffix tells you the driver:
>   **`-test` = pure live-browser walk** (`persona-test`, `click-test`); **`-audit` =
>   static extract + `--verify` reconcile** (`nav-audit`, `visual-audit`).
>
> So the pairs are already consistent. Renaming the lenses to `audit-nav`/`audit-click`
> would *break* this: the `audit-` prefix would falsely imply membership in the
> adjudication-loop family (rounds/ledger/Gemini) the lenses don't have. Grammar test:
> you "audit *the plan/code*" (verb+object) but you run "a *nav audit*" (compound noun).

## Consumer-repo layout (isolation)

This source repo's tooling deploys to consumer repos under
**`scripts/.claude-skills/`** rather than the consumer's natural
`scripts/` directory. The directory is gitignored on the consumer
side via a managed block in their root `.gitignore`. The directory
isn't tracked — fresh clones of a consumer repo need to re-run
`npm run sync -- --target <name>` from THIS repo to hydrate it. (The `--` is
load-bearing: without it npm eats `--target` as its own config and forwards the
value as a bare positional the script ignores, so the sync writes into EVERY
consumer instead of the named one. Verified 2026-07-20.)

> **Upstream-owned — never patch the synced copy (governance).** A failure in a
> consumer's `scripts/.claude-skills/**` file is an **UPSTREAM** bug: push back
> and fix it HERE (claude-engineering-skills) + re-sync — do **not** edit the
> synced copy in the consumer. It's gitignored (invisible to review), overwritten
> on the next sync (your fix is lost), and the bug persists for every other
> consumer. Each synced tooling file now carries a banner saying exactly this
> (injected by `sync-banner.mjs`). Drift backstops (already exist — no new
> tooling): `npm run sync:dry` from this repo shows any consumer file that
> differs from source; the synced `sync-isolation-verify` hash-checks a
> consumer's tree against its manifest. This is the band-aid-vs-root-cause rule
> at the consumer/upstream seam — the local edit is the band-aid; the upstream
> fix is the root. Repo-specific **push gates** have a sanctioned home — the committed, never-rewritten `.githooks/pre-push.local` ([recipe](docs/runbooks/consumer-adoption.md)), never an edit to the managed hook.
>
> **File the report, don't paste it (2026-07-31).** Consumer: `cross-skill.mjs upstream report --title …
> --affected-path <synced path>` (body on **stdin**) — auto-captures repo, **bundle sha**, and whether the
> path is really upstream-owned. Here: `npm run upstream:issues` → `upstream ack|fix --commit <sha>|wont-fix
> --id <id>`; **`/ship` Step 0.5h prints the open count** (advisory — cloud state nudges, never blocks; 2
> reports sat unread 2026-08-01, one already fixed 45min earlier). Prose reports arrived with a non-existent
> path against an unknowable version for a bug fixed the day before; the worksheet answers "already fixed?"
> mechanically. Bodies readable by every repo sharing the DSN. [Plan](docs/plans/upstream-issue-reports.md).

> **Three shapes consumers keep reporting — check for them when adding a gate or nudge (2026-08-08).**
> *(1) A read handing back a key its writer rejects*: `/ship` 0.5e listed unclosable rows for weeks because
> `unremediated_acceptances` projected `audit_finding_id` while its only closer needs `--fingerprint` — two
> reports, one column. **A new close-this-row nudge means a new row in**
> [`view-writer-key-contract.test.mjs`](tests/view-writer-key-contract.test.mjs). *(2) A gate judging files
> the repo does not own*: `context:check` scanned a vendored gitignored `.agents/skills/**/CLAUDE.md` and
> exited 1 on a clean repo — fix with `git ls-files --others --ignored` (**ignored AND untracked**; plain
> ignore-status stops judging *tracked* files matching a pattern), never a longer exclusion list, which grows
> per vendoring tool. *(3) A check verifying one direction only*: `sync-isolation-verify` walked
> manifest→disk, so 100 orphaned executables were invisible *by construction*; gate **2C** now walks
> disk→manifest over `scripts/.claude-skills/` alone (other dirs hold consumer-owned files; flagging those
> earns a bypass). Ask of any set comparison: **which side am I iterating, and what is unrepresentable from
> it?**

> **Upstream bug, but you're blocked? Source patch = forbidden; a labelled
> runtime/env workaround is OK and must reconcile.** Editing upstream-owned
> *source* in a fork/consumer is never allowed (above). But a **runtime/env/DB**
> unblock (e.g. an `ALTER` while a schema migration is pending upstream) is
> acceptable IF you (1) report the bug so it's fixed here, (2) **label it
> `TEMP — pending upstream fix`**, and (3) **reconcile** once the fix lands
> (`git pull upstream` + `setup-postgres --migrate`, etc.). Prefer waiting when
> not urgent. A local DB workaround that *diverges* from the eventual upstream
> migration, or that silently leaves the live schema ahead of the migration
> ledger, is the failure mode this rule prevents.

### Sync mechanics — pointer

Sync-behavior detail (why the isolated subdir exists, the what-goes-where table,
the managed-gitignore runtime-outputs block + self-healing untrack semantics, the
`sync-*` module list): [`docs/runbooks/consumer-adoption.md`](docs/runbooks/consumer-adoption.md)
§"Sync internals". One structural invariant stays here: **the sync layout's single
source of truth is [`scripts/lib/sync-path-map.mjs`](scripts/lib/sync-path-map.mjs)**
— never hand-compute a consumer path.

### CLI smoke contract (`--selfcheck-relocation`)

Every top-level CLI script that needs to prove its imports survive relocation implements:

```js
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
```

at the head of `main()`. Today: `check-setup.mjs`, `cross-skill.mjs`, `cache-hitrate-check.mjs`, `symbol-index/drift.mjs`, `security-memory/refresh-incidents.mjs`. Library modules (no `main()`) instead get an import-test in [`tests/relocation-guard.test.mjs`](tests/relocation-guard.test.mjs). The CI guard fails if a CLI script in `CLI_SMOKE_SET` lacks the handler.

### Adopting these skills in a new consumer repo

See [`docs/runbooks/consumer-adoption.md`](docs/runbooks/consumer-adoption.md) for the one-time migration recipe (legacy file cleanup, gitignore block, manifest layout transition).

## Browser Tool Setup (persona-test)

`/persona-test` drives a real browser. **Playwright MCP is the preferred tool** — it's free, no credentials needed, works on your own apps.

`.mcp.json` is included in this repo. Claude Code auto-discovers it and prompts you to enable Playwright MCP on first open. Just click **Allow** when prompted.

**First-time setup — install the browser:**
```bash
npx playwright install chromium
```
This is required before the MCP server will start. Without it, the server crashes silently and no tools appear.

**Verify it's working:**
```bash
npx @playwright/mcp@latest --version   # should print a version number
```

**Windows users** — Claude Code may need an MCP override; see [CLAUDE.md](./CLAUDE.md#claude-code-only-notes).

BrightData Scraping Browser is also supported (handles anti-bot/CAPTCHA) but requires a paid account and KYC approval. Playwright is preferred for testing your own apps.

## Mermaid validation (for plan diagrams)

Two surfaces for catching broken Mermaid before it ships:

- **Interactive (during plan generation)** — `.mcp.json` registers `mcp-mermaid`. Claude Code prompts to enable on first open (same flow as Playwright MCP). When enabled, I (Claude) can validate + render Mermaid blocks before persisting a plan — exposes `mcp__claude_ai_Mermaid_*` tools. No API key needed.
- **Pre-push (static lint)** — `npm run plans:lint` scans `docs/plans/*.md` for two classes of bugs that GitHub renders leniently but VS Code preview / stricter renderers reject:
  - **ERROR `subgraph-as-edge-endpoint`** — using a `subgraph` ID as an edge endpoint (`SG1 -.- other`). Mermaid graph syntax doesn't allow this; anchor the edge to a node *inside* the subgraph.
  - **WARN `unquoted-special-chars-in-label`** — node label brackets containing `<br/>` or non-ASCII chars (em-dash, etc.) without surrounding quotes. The bracketed-but-unquoted form parses in current Mermaid but breaks in older bundled versions. Always use `ID["..."]` when the label has special chars.

Runs as part of `npm run check` (the pre-push hook). ERRORs block; WARNs are advisory. Why narrow rule coverage: the full Mermaid parser is in the 76MB `mermaid` package, too heavy for one lint. `@mermaid-js/parser` (lightweight alternative) doesn't yet handle flowchart/graph — we'll switch when it does. Until then, this regex linter + the MCP cover the gap.

---

## Dependencies (CRITICAL — check versions before flagging issues)

| Package | Version | Notes |
|---------|---------|-------|
| `zod` | **4.0.0** | Zod 4 API — NOT Zod 3. `_def.type` is a string (`'object'`, `'array'`, `'enum'`), NOT `_def.typeName` (`'ZodObject'`). `shape` is a direct property on object schemas, NOT `_def.shape()`. `_def.entries` for enums, NOT `_def.values`. |
| `openai` | 6.17.0 | Uses `responses.parse()` with `zodTextFormat()` for structured output |
| `@google/genai` | ^1.47.0 | Google Generative AI SDK. Uses `responseMimeType: 'application/json'` + `responseSchema` for structured output |
| `dotenv` | 17.0.0 | Auto-loads `.env` via `import 'dotenv/config'` |

## Architecture

**Do not hand-maintain a module tree here** — [`docs/architecture-map.md`](docs/architecture-map.md)
is the live, generated per-symbol index (see the bootstrap note at the top of this
file); an inline tree goes stale silently (the one removed 2026-07-13 still listed
2 test files against 100+ real ones). Layout in one line: `scripts/*.mjs` are CLI
entry points; `scripts/lib/**` are focused modules (split from the former
`shared.mjs` monolith, which remains as a backwards-compatible barrel); `tests/` is
the Node built-in test-runner suite; `.claude/skills/**` is generated from `skills/**`.

### Script responsibilities + key patterns — pointer

Per-module prose (openai-audit, gemini-review, the learning-store barrel) and the
named patterns (adaptive sizing, semantic dedup, atomic persistence, the closed
Gemini loop, …) live in
[`docs/reference/audit-internals.md`](docs/reference/audit-internals.md).
Condensed out 2026-07-20 because it had already gone stale — it still described
`learning-store.mjs` as talking to Supabase three milestones after M3 split it
into 9 modules behind the `db/` seam, which is the rot the rule above prevents.

### Testing

Run: `npm test` (Node.js built-in test runner — the suite under `tests/`).

#### Pre-push runs against a clean checkout, not the working tree

The hook runs `check` in a throwaway worktree at the **commit being pushed**
([`prepush-check.mjs`](scripts/prepush-check.mjs)). Two sessions share one tree
here, so tree-checking gave false blocks (a cried-wolf gate gets `--no-verify`'d)
and false passes (a fix in the tree but not the commit read green). Not `git
stash` — that yanks the other session's files mid-edit. Detail + escape hatches:
[`docs/runbooks/prepush-sandbox.md`](docs/runbooks/prepush-sandbox.md).

- **A worktree has no `node_modules`, and tools must RESOLVE that, not assume it.**
  Everything in a nested worktree works because Node walks up and finds the main
  checkout's copy — so any tool that hard-codes `<repoRoot>/node_modules` breaks
  there and nowhere else. Two tools provision it into an isolated copy;
  `prepush-check.mjs` guards with `existsSync` + falls back to `npm ci`, while
  `check-gate-poison-pills.mjs` did not, and on Windows **a junction to a missing
  target succeeds and leaves a dangling link** (verified 2026-08-08), so its
  try/catch never fired and the only symptom was the CONTROL run dying on
  `Cannot find package 'zod'` — a message pointing at the gate under test rather
  than the harness. It now resolves upward like Node does and asserts the link
  RESOLVES, not merely that creating it threw nothing. (`prepush-check.mjs` was
  already correct — in a worktree it just falls back to a slower `npm ci`, which
  is safe, so it was deliberately left alone.) Do not "fix" a worktree by
  hand-linking `node_modules` into it: that hides the tool bug from the next
  person and is the ritual this removes.
- **Sandbox-honesty rule.** A fresh worktree has no gitignored inputs, so a check
  that *skips* on a missing input passes having read nothing (known skips are
  forced hard: `AUDIT_PUSH_RANGE_REQUIRED`, `ARCH_COVERAGE_REQUIRE_ENVELOPE`).
  **Adding a check? Ask whether it can go green in a clean checkout having
  checked nothing — if so it needs a strictness flag, not a tolerated skip.** A
  sandbox setup failure is a push failure, never a pass.
- **One range, one resolver** — [`push-range.mjs`](scripts/lib/push-range.mjs).
  Gates must not re-infer a base from working-tree state (`@{u}`, dirty→`HEAD~1`):
  that scoped multi-commit pushes to their tip and collapsed to `HEAD~1` always
  in a detached tree. An unresolvable explicit base fails hard, never demotes to
  inference.
- **Hashing working-tree bytes ≠ hashing committed source.** `skills.manifest.json`
  broke its own Category-B contract this way: 16 skill files carried CRLF locally
  while `.gitattributes` pins `eol=lf`, git calls such files CLEAN, so
  `bundleVersion` tracked local line endings and a fresh clone read STALE.
  Generators hashing files for a committed artifact must canonicalise CRLF→LF —
  **with `canonicalizeEol` from [`lib/file-io.mjs`](scripts/lib/file-io.mjs)**, the
  one byte-level fold (it leaves a lone `CR` alone and never decodes, so it cannot
  corrupt non-UTF-8 bytes while hashing them). It bit a SECOND generator on
  2026-08-08: `regenerate-skill-copies.mjs` compared raw bytes, so a worktree
  whose `.claude/skills/**` landed CRLF while `skills/**` landed LF reported all
  67 destinations as differing — sending the operator to regenerate, which
  commits an EOL flip as if it were content. The tell is a diff where git says
  clean and your tool says changed: **git is right, the tool is comparing the
  wrong thing.** Do NOT canonicalise where the exact bytes ARE the contract
  (transfer-corruption checks) — that masks the corruption being looked for.

#### Testing doctrine — pointer

Three tiers, because blanket TDD is theatre at the LLM boundary but rigor pays
at deterministic seams: **Tier 1** test-first for deterministic modules
(`schemas`, `sensitive-paths`, `vcs`, `bandit`, `ledger`, `findings-*`,
`config`, `file-io`, `sync-*`); **Tier 2** invariants + canned fixtures for
LLM-orchestration seams — never assertions on model prose, never a
whole-provider mock (that tests the mock); **Tier 3 (non-negotiable)** two
seams where a change lands with its test in the **same commit** — *(a)*
**sensitive-path egress**, because a leak ships credentials to a third-party
LLM, and *(b)* the **consumer sync / relocation contract**, because a break
ships silently to repos you cannot observe. Tier list, guarding tests, and the
deliberate deferrals: [`docs/reference/testing-doctrine.md`](docs/reference/testing-doctrine.md).

#### Pre-ship empirical verify — for skills that assert on a live runtime

Static review cannot catch what only appears when a real browser renders real
data — a mid-theme-transition `getComputedStyle` read once *fabricated* a bug
that survived four review passes. Three load-bearing rules: **(1)** any skill
driving a browser (visual-audit, nav-audit `--verify`, persona-test,
persona-consistency, click-test, ux-lock) **must run against ONE real app
before being called done**, and a field finding with a green repro routes to a
regression test + ONE focused review, never the adjudication loop (that
resolves uncertainty the repro already killed); **(2)** two capture bug classes
to check by name — mid-state-change capture (freeze transitions AFTER the flip
+ `await document.fonts.ready`) and empty/failed capture, which must degrade to
`unverified`, never "verified / 0 findings"; **(3)** **audit your success
paths** — ask of any green-emitting branch *"can this return green without
having checked anything?"* (six such holes in visual-audit `--gate` alone).
→ [`docs/runbooks/pre-ship-empirical-verify.md`](docs/runbooks/pre-ship-empirical-verify.md).

## Model Resolution

`scripts/lib/model-resolver.mjs` resolves model IDs so config stops going stale
when providers ship new versions. All model-reading env vars in config.mjs pass
through `resolveModel()`.

**Sentinels** (preferred in `.env`):

| Sentinel            | Picks from                                  |
|---------------------|---------------------------------------------|
| `latest-gpt`        | newest non-mini GPT in the pool             |
| `latest-gpt-mini`   | newest GPT mini variant                     |
| `latest-opus`       | newest Claude Opus                          |
| `latest-sonnet`     | newest Claude Sonnet                        |
| `latest-haiku`      | newest Claude Haiku (prefers undated alias) |
| `latest-pro`        | `gemini-pro-latest` (alias short-circuit)   |
| `latest-flash`      | `gemini-flash-latest`                       |
| `latest-flash-lite` | `gemini-flash-lite-latest`                  |

**Resolution** (`resolveModel`): stale concrete IDs → `DEPRECATED_REMAP` → sentinel
(one-time warning); a sentinel picks the newest tier match from live-catalog ∪
`STATIC_POOL` (Google's `gemini-{tier}-latest` alias is authoritative); concrete IDs
pass through. The heavy LLM entry points (audit / brainstorm / gemini-review) call
`refreshModelCatalog()` + re-resolve, so new provider models are picked up
automatically — no manual `STATIC_POOL` edit needed. `MODEL_CATALOG_REFRESH=skip`
opts out (air-gapped CI); silent fallback to the static pool on network failure.
Self-check: `node scripts/lib/model-resolver.mjs resolve | catalog`.

**Anti-patterns (load-bearing):**
- Do NOT pin concrete model IDs in new code — use a sentinel (`latest-*`).
- Do NOT drop `-preview` from Gemini 3 IDs unverified — bare `gemini-3-flash` /
  `gemini-3.1-pro` never shipped (Google 404s). Verify via the `…/v1beta/models` list.
- Do NOT retry 404 — `classifyLlmError` treats any 4xx (except 429) as non-retryable.
- When rewrapping an LLM error, surface `err.status` + the real provider
  `error.message` — don't collapse to `"API error ${status}"` (it names the bad model).
- **OpenRouter**: one model id → many backends w/ incompatible ctx limits, picked per request; and reasoning tokens count against `max_tokens`. Unpinned runs fail at random, reading as model flakiness — always send `provider:{require_parameters,sort}` + `reasoning:{effort}`. [experiment-4](docs/research/experiment-4-cheap-final-reviewer-smoke.md)

→ Resolution-order detail, live-catalog mechanics, startup-log example, static-pool
maintenance: [`docs/reference/model-resolution.md`](docs/reference/model-resolution.md).

## Memory-Health Gate

`scripts/memory-health.mjs` runs three trigger metrics against the audit store to decide
whether our flat `audit_findings` + fingerprint-dedup design is starting to leak
signal that a graph-shaped memory (pgvector + community clustering) would
recover. Three triggers:

| Metric | What it measures | Default trigger |
|---|---|---|
| Fuzzy re-raise rate | New-fingerprint findings whose text matches a prior finding (trigram sim > 0.6) | `> 15%` |
| Cluster density | Median per-repo count of open finding pairs that are **semantic same-file cross-run re-raises** (cosine > 0.85 over `finding_embeddings`, migrated off trigram 2026-07-21). Reports embedding **coverage**; a low-coverage reading is `unknown`, not green. Excludes control-state markers. Trigram survives as a fallback when the semantic RPC is absent | `>= 5` |
| Recurrence rate | Fixed findings that reappear in same repo within 30 days under a new fingerprint | `> 10%` |

Runtime is the `memory_health_metrics(window_days)` Postgres RPC added by
`supabase/migrations/20260421163525_memory_health.sql` (uses `pg_trgm`).

> **Metrics 1 and 3 are SAMPLED, and two Postgres traps live here (2026-08-08).**
> The gate had measured nothing for months: the 2026-04-21 perf patch added a `%`
> prefilter *and* truncated both operands to `LEFT(detail_snapshot,500)` in one
> edit, which disabled the bare-column GIN index `%` was added to use — 3.7M
> filter-evaluated pairs, >15 min, killed by the runner's 5-min spawn budget as a
> bare `spawn ETIMEDOUT`. Fixed by `20260808160000_memory_health_trgm_index.sql`:
> a GIN index on `left(detail_snapshot,500)`, LATERAL probes behind an
> **`OFFSET 0` fence** (without it the planner still picks the `created_at`
> btree — it costs `%` at 1 unit against a measured ~65us), and a `per_repo_cap`
> on the **driving** set. Cap the driving set, NEVER the searched set — the
> latter drops real matches and biases the rate down into a false GREEN. So
> `fuzzy_reraise.rate` / `recurrence.rate` are sample estimates over the N most
> recent per repo; read `new_fingerprints_total` / `fixed_findings_total` /
> `per_repo_cap` beside them. **Trap 1: `SET statement_timeout` on a function is
> DECORATIVE** — Postgres arms the timer at statement start and a `SET` inside
> the body never re-arms it (negative-controlled); bound these RPCs at the
> caller, as `db/rpc.mjs` now does via `withTx` + `SET LOCAL`. **Trap 2:
> `CREATE OR REPLACE FUNCTION` replaces the whole proconfig array and resets the
> ACL**, so any redefinition silently reverts `20260721130000`'s `search_path`
> pin + EXECUTE revoke unless it re-states both — verify with `pg_proc.proconfig`
> / `proacl`, not review.

> **Cluster density counts FINDINGS, never a wave's own control state.** A wave
> that prints a machine-generated notice about its own execution (coverage cap
> hit, aborted enumeration) emits byte-identical text every time, so those rows
> pair at similarity 1.00 with each other and inflate the metric by
> construction — 44% of the raw signal on 2026-07-20. Sentinels are listed in
> `control_marker_prefixes` (migration `20260720210000`) and matched on the
> **detail-snapshot prefix, not the category**: the adjacency wave emits both
> `ADJACENCY_INCOMPLETE` control state AND real `[Adjacency]` findings, so
> excluding the category would drop genuine signal. **Add a sentinel there when
> a new wave starts emitting control state**, or this gate will read AMBER
> forever on its own logging. Two companion fixes in the same migration:
> `open_findings` now means the considered population (it previously counted
> only findings that already had a match), and a repo with zero similar pairs
> contributes a 0 to the median instead of vanishing from it via an INNER JOIN.

**Auto-scheduled** via `.github/workflows/memory-health.yml` — runs every Monday
09:00 UTC, silent when all metrics green, opens/updates a sticky GH issue
(label `memory-health`) when any trigger fires. Auto-closes when metrics
return to green. Run locally: `npm run memory:health` or `npm run memory:health:json`.

**Decision rule**: 0 triggers for 4 weeks → current design is fine. 1 trigger
for 2 consecutive weeks → prototype pgvector similarity. 2+ triggers → build
the full clustering pipeline.

> **pgvector prototyped + promoted (2026-07-21):** trigram UNDER-counts churn; semantic cosine
> catches reworded re-raises. `scripts/semantic-suppress.mjs` reconciler (dry-run default) + a
> record-time hook in `recordFindings` (merged pass) **default-ON**, fail-open, kill switch
> `AUDIT_SEMANTIC_SUPPRESS_ENABLED=false`. Dedups the store row, NEVER the audit report; core
> `semantic-suppression.mjs`/`semanticSuppressConfig`. [`docs/research/pgvector-clustering-prototype.md`](docs/research/pgvector-clustering-prototype.md).

## Learning System (Phase 1)

Adaptive-learning telemetry across audit decision points (pass selection, convergence
prediction, arch-memory band, auto-deferral) → the `learning_decisions` table +
per-repo `recurring_finding_clusters`. Phase 1 is the foundation; later phases promote
decision points to live learners. **Load-bearing**:

- **Kill switch**: `LEARNING_DISABLE=1` disables all live learning + telemetry in one
  env var (also in the Environment Variables table).
- **Auto-deferral** (`--scope diff` only) fires only when BOTH hold: finding category
  in the AUTO_DEFERRABLE_CLASSES allowlist AND deterministic SCM evidence (not in
  HEAD~1..HEAD, or a plan marker, or recurring 2+ rounds); else → `needs_triage`. Plan
  marker to accept a v1 limit: `<!-- audit:accept-v1: <glob> :: <reason> -->`.
- Telemetry never crashes a run: flush failures spill to `.audit/learning-outbox/`
  (CI: synchronous retry instead, counted as `lostInCI`).

→ **Operations** (CLI `npm run learning:*`, weekly review, quickfix-learner hit
lifecycle, Phase-3 replay framework + promotion recipe, outbox detail):
[`docs/runbooks/learning-system.md`](docs/runbooks/learning-system.md).
→ **Design**: master plan [`docs/plans/adaptive-learning-v1.md`](docs/plans/adaptive-learning-v1.md)
+ per-phase `adaptive-learning-phase-{1,2,3}-*.md`.

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes | — | GPT access (audit model defaults to latest pinned GPT) |
| `GEMINI_API_KEY` | No | — | Gemini final review (Step 7 falls back to Claude Opus if absent) |
| `OPENAI_AUDIT_MODEL` | No | `latest-gpt` | Model sentinel or concrete ID (see "Model Resolution" below) |
| `OPENAI_AUDIT_REASONING` | No | `high` | Reasoning effort |
| `GEMINI_REVIEW_MODEL` | No | `latest-pro` | Gemini model sentinel or concrete ID |
| `GEMINI_REVIEW_TIMEOUT_MS` | No | `180000` | Gemini timeout (raised from 120s 2026-07-31 — observed 78–101s runs left too little headroom; a timeout is single-shot, never retried) |
| `ANTHROPIC_API_KEY` | No | — | Claude Haiku fallback for brief generation (sdk backend only) |
| `CLAUDE_BACKEND` | No | `sdk` | Routing for Claude calls: `sdk` (raw API) or `cli` (`claude -p` headless — draws from Max 20x Agent SDK $200/mo credit from 2026-06-15). See "Anthropic Backend Routing" below. |
| `CLAUDE_BIN` | No | `claude` | Path/name of the `claude` CLI (cli backend only) |
| `CLAUDE_FINAL_REVIEW_MODEL` | No | `latest-opus` | Claude Opus override (Step 7 fallback) |
| `FINAL_REVIEW_SHADOW` | No | — | Opt-in **shadow** final reviewer (observation-only A/B): `claude-opus` \| `anthropic` \| `gemini`. Runs a second blind reviewer in parallel with the primary; never gates the build. No-op when unset or under an Azure profile. See "Shadow final-review A/B" below. |
| `FINAL_REVIEW_SHADOW_MODEL` | No | per-provider | Concrete model / sentinel for the shadow reviewer. Unset → derived from the provider (`claude-opus`→`latest-opus`, `gemini`→`latest-pro`). A family mismatch is a logged no-op. `FINAL_REVIEW_{BASE_URL,API_KEY,MODEL,HARD_DEADLINE_MS}` (provider-agnostic gateway + termination watchdog) are documented in the [azure-work-profile runbook](docs/runbooks/azure-work-profile.md) §Provider-agnostic final review. |
| `BRIEF_MODEL_GEMINI` | No | `latest-flash` | Brief-generation Gemini model |
| `BRIEF_MODEL_CLAUDE` | No | `latest-haiku` | Brief-generation Claude model |
| `META_ASSESS_MODEL` | No | `latest-flash` | Meta-assessment Gemini model |
| `META_ASSESS_GPT_FALLBACK` | No | `latest-gpt-mini` | Meta-assessment GPT fallback when GEMINI_API_KEY is absent |
| `SUPPRESS_SIMILARITY_THRESHOLD` | No | `0.35` | Jaccard threshold for R2+ suppression (0.0-1.0) |
| `AUDIT_DB_URL` | No | — | **Postgres DSN** for the audit-loop store. Supabase users: dashboard → Connect → **Session pooler** (URI, port 5432). Unset → local-only mode (#16 graceful degradation). Replaces the legacy `SUPABASE_AUDIT_*` triplet (postgres-parity M4). |
| `AUDIT_DB_SSL_MODE` | No | `require` | TLS mode: `require` (default; strict verify), `no-verify` (accept self-signed — needed for Supabase poolers), `disable`. |
| `AUDIT_DB_POOL_MAX` | No | `4` | Maximum simultaneous pg connections. Increase only when the audit-loop's chunked upserts demand it. |
| `PERSONA_TEST_APP_URL` | No | — | Default app URL for persona-test list/add (per-project `.env`) |
| `PERSONA_TEST_REPO_NAME` | No | — | Repo name for cross-referencing audit-loop findings (per-project `.env`) |
| `MEMORY_HEALTH_WINDOW_DAYS` | No | `30` | Memory-health lookback window |
| `MEMORY_HEALTH_FUZZY_RATE` | No | `0.15` | Fuzzy re-raise rate trigger threshold |
| `MEMORY_HEALTH_CLUSTER_MEDIAN` | No | `5` | Cluster density trigger threshold (median similar pairs/repo) |
| `MEMORY_HEALTH_RECURRENCE_RATE` | No | `0.10` | Fixed-finding recurrence rate trigger threshold |
| `MEMORY_HEALTH_MIN_FINDINGS` | No | `50` | Minimum findings in window to report a trigger (below → INSUFFICIENT_DATA) |
| `MEMORY_HEALTH_RPC_TIMEOUT_MS` | No | `240000` | Caller-side bound on `memory_health_metrics` (the function's own `SET statement_timeout` is inert). Sized under the maintenance runner's 300s spawn budget so a runaway is a loud `57014`, not a silent kill. |
| ~~`SUPABASE_AUDIT_*`~~ | — | — | **Sunset in M4** (postgres-parity). The audit-loop now uses `AUDIT_DB_URL` exclusively; the legacy URL + anon-key + service-role-key triplet was tied to the old `@supabase/supabase-js` PostgREST path which has been removed. The runtime DSN's password IS the secret — no separate write-role key. |
| `LEARNING_DISABLE` | No | — | Set to `1` to disable all adaptive-learning live behaviour and telemetry recording (single env-var kill switch). |
| `LEARNING_REPO_NAME` | Required for weekly-review | — | Per-repo gate for `weekly-review.mjs`. Aborts if missing — prevents cross-tenant data leakage in the digest issue body. **Must be the `owner/repo` slug** (matches `audit_repos.name`, derived from the git origin URL via `resolveRepoIdentity()`) — the bare repo name silently misses the lookup (`{posted:false, reason:'unknown-repo'}`), which is exactly how this sat broken for weeks in every consumer before 2026-07-22. `install.mjs`/`setup.mjs` now derive it automatically; don't hand-type it. |
| `LEARNING_QUEUE_CAP_PER_TYPE` | No | `64` | Per-`decision_type` bounded sub-queue cap. Increase for high-throughput audits. |
| `AUDIT_AUTHOR_TIER_HINT` | No | — | **Observation-only** (never routes). Optional author-model hint (concrete id e.g. `claude-sonnet-4-6`, or a logical tier `economy\|standard\|frontier`) read by the `author_tier` recorder in `openai-audit.mjs` to capture actual-vs-suggested tier + the ladder partition key. A concrete id populates the partition key; a bare logical tier leaves it null. See `docs/plans/model-tier-observation.md`. |

## Postgres-Parity Store (M1–M4)

The cloud learning store talks to **Postgres directly via the `pg` driver** — no
`@supabase/supabase-js` / PostgREST layer. "Supabase-hosted vs self-hosted" is just a
connection string. **Load-bearing invariants** (the rest is in the docs below):

- **Connect**: `AUDIT_DB_URL=postgresql://…pooler.supabase.com:5432/postgres` +
  `AUDIT_DB_SSL_MODE=no-verify`. Use the Supabase **Session pooler (5432)**, **NOT the
  Transaction pooler (6543)** — it drops server-side prepared statements + the
  `search_path=public` pin the `db/` seam needs.
- **Single-tenant**: the DSN password IS the secret (no separate read/write keys); the
  runtime `pg.Pool` ([`scripts/lib/db/client.mjs`](scripts/lib/db/client.mjs)) owns
  `public` and **bypasses RLS** (correct here). Schema is **`public`-only** in v1.
- **Setup**: `node scripts/setup-postgres.mjs --migrate` (fresh / new migrations,
  idempotent) · `--adopt` (seed the `audit_loop_migrations` ledger from a
  pre-provisioned DB) · `--check-drift` (CI: exit 1 on drift). Shared secrets across
  consumer repos: `npm run setup:cloud` → `~/.audit-loop.env`.
- **Never use the dashboard as the routine migration path** — it reintroduces the
  silent-drift the ledger exists to eliminate; make the source migration idempotent
  and retry `--migrate` instead.
- **jsonb-safe write seam (load-bearing — do NOT hand-`JSON.stringify` jsonb columns).**
  The db-layer write builders ([`scripts/lib/db/query.mjs`](scripts/lib/db/query.mjs)
  `serializeWriteParam`) auto-JSON-serialize a plain array bound to ANY column on the
  INSERT/UPSERT/UPDATE-SET path — because node-postgres binds a raw JS array as a
  Postgres ARRAY literal, which a `jsonb` column rejects (`22P02`, non-empty) or
  silently stores as `{}` (empty). This was the M3 supabase-js→pg regression
  (PostgREST used to JSON-serialize bodies implicitly). So: **pass jsonb values raw**
  (the seam handles it); a genuine Postgres array column (`text[]`/`int[]`) opts OUT
  with **`pgArray(value)`** so its array stays a literal. WHERE predicates are NOT
  serialized (array equality stays raw). A jsonb writer that forgets is safe; a
  `text[]` writer that forgets `pgArray()` fails LOUDLY. Guard:
  [`tests/store-jsonb-array-serialization.test.mjs`](tests/store-jsonb-array-serialization.test.mjs);
  the `/audit-code` backend pass also flags raw-array-to-jsonb + silent DB-write
  error-swallow + unverified-write-success (RLS/0-row) as HIGH.
- **Migrations stay schema-portable**: `parity:check-coupling` fails on any `<schema>.`
  qualification or non-core reference outside the recorded baseline.
- **"Disposable" is an ALLOWLIST of loopback hosts, and it fails CLOSED.**
  `isDisposableDbHost` / `assertDisposableDbUrl` (`scripts/lib/db/client.mjs`)
  guard the `db-setup`/`db-withtx` suites (they `DROP SCHEMA public CASCADE`) and
  the `generate-expected-schema.mjs` fixture — closing the 2026-07-14 wipe
  incident. Both were a **denylist** of `*.supabase.*` until 2026-08-08, resting
  on their own docstring's *"this repo has exactly one Supabase project, and it is
  always production"* — which the NAS cutover falsified the same day, leaving both
  guards inert against the new production store. It bit within hours: the schema
  fixture was regenerated from production with no warning (9 wrong
  `ordinal_position` values — a restored DB renumbers `attnum` past `DROP COLUMN`
  tombstones, a fresh replay does not). **Never re-express this as "not
  $VENDOR"** — a denylist of production hosts is only as current as the last infra
  change; an allowlist is a property of what disposable *means*. Same reason
  production identity is compared as host+port+database, not as a DSN string
  (`?sslmode=disable` defeats string equality). No env escape hatch, deliberately.
  Detail: [postgres-parity-runbook.md](docs/runbooks/postgres-parity.md) §Incident.
  **Regenerate the fixture only from a fresh replay** — `npm run db:local:regen`.

→ **Design** (no-adapter `pg`-direct decision, schema scope, privilege model, file plan): [`docs/plans/postgres-parity.md`](docs/plans/postgres-parity.md) + [`postgres-parity-schema-coupling.md`](docs/plans/postgres-parity-schema-coupling.md). **Operations** (setup recipe, migration-drift CLI + exit codes, pre-push snippet, break-glass atomic-apply, shared-cloud-config, prerequisites): [`docs/runbooks/postgres-parity.md`](docs/runbooks/postgres-parity.md).

## Anthropic Backend Routing

All Claude API calls go through one seam,
[`scripts/lib/anthropic-client.mjs`](scripts/lib/anthropic-client.mjs);
`CLAUDE_BACKEND` switches transport without touching call sites. `sdk`
(default) is the direct `@anthropic-ai/sdk` API billing `ANTHROPIC_API_KEY`;
`cli` spawns `claude -p --output-format json` and draws on the Max 20x Agent
SDK credit. **Local status: `cli`** (in the gitignored `.env`; the committed
default stays `sdk` for CI without the `claude` CLI). Call sites use
`createAnthropicClient()`, never `new Anthropic()` — regression-guarded by
[tests/anthropic-client-migration.test.mjs](tests/anthropic-client-migration.test.mjs).
Smoke test: `npm run anthropic:ping`.

**Load-bearing gotchas** (operational depth in the reference below):

- **Forced tool-calling needs `{backend:'sdk'}` explicitly (found 2026-07-14).**
  The `cli` backend reads only `{model, max_tokens, system, messages}` and
  **silently drops** `tools`/`tool_choice` — it always spawns
  `claude -p --tools ''`. A caller forcing `tool_choice` gets a plain `text`
  block back with **no error**, so the failure surfaces one layer up. This
  broke the tiered-recall pipeline's discovery generator for a whole shadow
  window (20/20 runs fell back to legacy). Any call site forcing `tool_choice`
  must pass `createAnthropicClient({backend:'sdk'})` — never the ambient env.
- **Availability is `isClaudeAvailable()`, not `process.env.ANTHROPIC_API_KEY`.**
  The cli backend authenticates via the `claude` CLI and needs no key, so a raw
  env check silently skips a fully-available backend.
- **`claude-trace` cannot meter the scripted cli backend** (it corrupts the JSON
  envelope on stdout). Use the backend's own self-reported `cost_usd`.

→ Backend table, cost-telemetry detail, migration pattern, and the full
call-site list: [`docs/reference/anthropic-backend-routing.md`](docs/reference/anthropic-backend-routing.md).

## Shadow Final-Review A/B — CLOSED 2026-07-28, verdict KEEP

Opt-in, observation-only 2nd final reviewer, run blind to test whether a second
gate earns its keep. **Committed default unset; re-enabled locally 2026-07-29** (KEEP
was the verdict; the flag drifted off). `FINAL_REVIEW_SHADOW=claude-opus|gemini|openrouter`
(a gateway needs an explicit `FINAL_REVIEW_SHADOW_MODEL`; unset ⇒ not entered, byte-identical; no-op under Azure; never gates).
Verdict/method/stopping rule + three dated corrections: [briefing](docs/research/final-review-shadow-adjudication-briefing.md) · [plan](docs/plans/final-review-shadow-reviewer.md).
Three results that generalise — **read before any reviewer/model comparison**:

- **A floor arm and a ratio arm can BOTH fire.** Surface the contradiction; never pick
  the arm fitting the data nor retune against the data that fired it — measure what
  you left unmeasured instead.
- **"Found it" ≠ "found it first."** KEEP = findings were real, NOT unique. Within-run
  overlap vs GPT passes = 0 files / 19 both-runs; cross-run re-raises confirmed, unmeasured.
- **The loop fixes the best catches BEFORE adjudication**, so credit lands in a source
  comment, `user_action` stays null, and the tail reads as noise. One missing write-back,
  two symptoms: set `user_action` at fix time; record same-run pass-finding refs.

- **Operator-doc convention (repo-wide, bit twice pre-2026-07-02)**: real values or
  PowerShell vars in CLI examples, **never `<angle-brackets>`** (PowerShell reserves
  `<` — unpasteable); render a `--worksheet`, not raw JSON.

→ Measurement how-to + attribution schema: [`final-review-shadow-reviewer.md`](docs/plans/final-review-shadow-reviewer.md). **Before building a bigger instrument**, read [`final-review-shadow-bakeoff.md`](docs/plans/final-review-shadow-bakeoff.md)'s PARKED banner (right-sizing) + [`final-review-credit-and-cheap-shadow.md`](docs/plans/final-review-credit-and-cheap-shadow.md) §1.2 (cheap-gateway evidence).

## Tiered-Recall Audit Pipeline

A discovery → Stage 0 (deterministic evidence triage) → Stage 1 (cheap-model
triage) → Stage 2 (Gemini adjudicator + bounded clean-challenge) alternative to
the always-on GPT 5-pass legacy audit. All 12 phases (Clusters A-F) implemented
and tested. `openai-audit.mjs`'s chooser (`tieredAuditConfig.pipelineEnabled`,
env `AUDIT_TIERED_PIPELINE_ENABLED`) defaults **off** — production runs legacy.

**Load-bearing invariants** (mechanics, model-resolution, cross-repo behaviour,
CLI/dashboard surfaces and full incident history: plan doc, pointer below):

- **Execution eligibility is per-call, not env-global** (`allowTiered` — the
  2026-07-13 incident fix): env flags only express "the window is open"; only
  `openai-audit.mjs`'s `main()` passes `allowTiered: true`, so tests and library
  callers can never spend. Both must hold before a provider is constructed.
- **The discovery generator needs forced `tool_choice`, so it pins
  `{backend:'sdk'}` explicitly** — never the ambient `CLAUDE_BACKEND` (see the
  Anthropic Backend Routing gotcha above); silently produced 20
  all-`fallback_legacy` runs before 2026-07-14.
- **"Window met" is now epoch-gated, not eyeballed** (2026-07-26, after the 5th
  false green): `comparedRuns` counts only rows the collector stamped with the
  current `TIERED_SHADOW_CONTRACT_EPOCH`. All pre-stamp rows are ineligible and
  the window restarts — re-collect, never backfill (see the swap-eval section).
- **Not yet done**: the shadow window (10–15 commits) and Phase 14. **Also at
  Phase 14**: the adjudicator-role eval has never run (Stage 2 uses Gemini) —
  [model-eval-harness.md](docs/runbooks/model-eval-harness.md) §"Adjudicator
  role — not yet run".

→ Full plan, phase spec, Stage-1 triager resolution, shadow-validation
mechanics + CLI/dashboard surfaces, Stage-2 adapter wiring, and the audit
trail: [`docs/plans/tiered-recall-audit-pipeline.md`](docs/plans/tiered-recall-audit-pipeline.md)
(still in `docs/plans/` — Phase 14 pends the shadow window).

## Model Swap-In Evaluation Harness

A standing suite (`scripts/lib/model-eval/`) answering "is this new LLM release
worth switching to?" for the **auditor** (currently GPT) or **adjudicator**
(currently Gemini) role. Entry:
`node scripts/model-eval-{auditor,adjudicator}.mjs --candidate <spec> --tier screen|promotion`
— **step-by-step playbook in the runbook below; start there.**

**Load-bearing invariants** (mechanics, tiers, history in the docs below):
- **Accepted false-negative direction**: a Tier-C-only run (restricted-catalog
  Azure) can never emit `verdict:'switch'` — only `keep`/`inconclusive`/
  `manual_review_required`. Schema-enforced, not a convention.
- **The oracle-matching recall ceiling**: scoring credits only the ONE curated
  defect per entry while real models find OTHER genuine bugs in the same diff,
  so **low recall is not a quality signal** — read the raw per-case output
  first, and treat recall as a floor, not the deciding metric (FP-rate + cost
  decide). Applies to promotion-tier's Tier C fallback too; Tier C never
  substitutes for a Tier A/B comparative result.
- **Egress-gate prose/diff false-positive classes: fixed 2026-07-12** — historical
  recall is the contract; don't re-add trailing-punctuation stripping (tried,
  reverted: re-blocked valid entries). Guarded in `tests/egress-path-scan.test.mjs`
  + `tests/sensitive-paths.test.mjs`.
- **Verdict of record (2026-07-13): GLM-5.2 vs GPT-5.6 → `keep` GPT-5.6**
  (real Tier A, $1.87; FP-rate drove it; the recall column is untrustworthy
  per the ceiling above).
- **A model swap is SYNCHRONOUS, never a background window** (2026-07-26): run it
  when the model ships, adjudicate in the same sitting, verdict → `docs/research/`.
  Passive collection killed arm-eval and produced five false "window met" reads —
  epoch drift, dormancy and the wipe all need *elapsed time*. Only
  intervention-over-organic-work earns a shadow; exactly two are open
  (tiered-pipeline, final-review 2nd gate). **Do not add a sixth collector.**
- **Evidence counts only if produced under the contract the stopping rule
  validates**: stamp `contractEpoch` **at the collector**, verify by match
  (`TIERED_SHADOW_CONTRACT_EPOCH`). Unstamped ⇒ ineligible, never "assume
  current"; bump on a meaning-changing fix and re-collect — **never backfill by
  date** (the relabelling that let the 5th false green through).

→ **Operational reference**: [`docs/runbooks/model-eval-harness.md`](docs/runbooks/model-eval-harness.md) · **Design + prior-art trace**: [`docs/plans/model-swap-eval-harness.md`](docs/plans/model-swap-eval-harness.md) · **First real verdict write-up**: [`docs/research/experiment-3-model-swap-glm-vs-gpt.md`](docs/research/experiment-3-model-swap-glm-vs-gpt.md).

## Local Weekly Maintenance Checks (opt-in)

Optional, default-OFF local replica of the 5 weekly GH Actions maintenance
workflows, for orgs that block Actions runners. Opportunistic — triggered
from the pre-push hook when overdue, **not** an OS scheduler (avoids the
wrong-PATH/cwd/asleep-at-trigger failure class). Enable via `setup.mjs` Step 4
or `AUDIT_LOOP_WEEKLY_MAINTENANCE=1`. Detail: [`docs/runbooks/local-maintenance-checks.md`](docs/runbooks/local-maintenance-checks.md).

## Azure AI Foundry Work Profile

Run the **same** bundle in a corporate Azure environment (restricted models)
without drifting from the public-profile repo. Full guide:
[`docs/runbooks/azure-work-profile.md`](docs/runbooks/azure-work-profile.md); plan +
audit trail: [`docs/plans/azure-work-profile.md`](docs/plans/azure-work-profile.md).

> **Opt-in invariant (load-bearing).** The Azure path activates **only** when
> `AZURE_OPENAI_ENDPOINT` is set. With no Azure env vars, client construction and
> resolved models are **byte-identical** to the public path (regression-guarded
> by `tests/openai-client.test.mjs`). It never touches your personal setup.

| Role | Public | Azure work profile |
|---|---|---|
| GPT auditor | `new OpenAI()` → api.openai.com | Azure OpenAI v1 (`AZURE_OPENAI_ENDPOINT/openai/v1`), deployment `AZURE_OPENAI_GPT_DEPLOYMENT` |
| Final reviewer | Gemini → Claude Opus fallback | **Opus on Foundry** (`AZURE_AI_ENDPOINT`), deployment `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` — replaces Gemini |
| Embeddings | Gemini `gemini-embedding-001` | Azure `text-embedding-3-large` (`dimensions: 768`) |

**Seam (mirrors `anthropic-client.mjs`)**: [`scripts/lib/openai-client.mjs`](scripts/lib/openai-client.mjs)
`createOpenAIClient({purpose})` + [`embed-text.mjs`](scripts/lib/embed-text.mjs)
`embedText()` route to Azure-v1 or public by env presence; `azureConfig` in
[config.mjs](scripts/lib/config.mjs). Wire deployment comes from the
`AZURE_*_DEPLOYMENT` vars while `OPENAI_AUDIT_MODEL` / `CLAUDE_FINAL_REVIEW_MODEL`
stay logical sentinels (dodges the `gpt-5.3 → latest-gpt` remap footgun);
`MODEL_CATALOG_REFRESH` auto-skips under Azure.

**Load-bearing gotchas** (the operational depth is in the guide):
- **Vector-space safety + embedding-deployment doctor**: provenance is the single
  endpoint-qualified `resolveEmbedProfile()` identity; a deployment/resource switch
  is a distinct space and `refresh` auto-promotes to full so spaces can't mix. Unset
  `AZURE_OPENAI_EMBED_DEPLOYMENT` → guessed default may 400 → `npm run azure:doctor -- --fix` probes + locks the real name in. [Recipe](docs/runbooks/azure-work-profile.md) §3.
- **Final-reviewer precedence** (top wins): `--provider` → `FINAL_REVIEW_PROVIDER`
  → Gemini (if `GEMINI_API_KEY`) → Azure `azure-claude` (only when the profile is
  active) → public Opus. A stray `AZURE_OPENAI_ENDPOINT` no longer silently hijacks
  the reviewer; persist with `gemini-review.mjs set-provider azure-claude`.
- **Arch-index summaries stay on Sonnet** (not Haiku) under Azure — deployment quota,
  not per-token cost, is the binding constraint on the `arch:refresh` batch.

→ **Setup, env-var reference, provider-precedence detail, Foundry-Anthropic API shape,
deployment quotas, rate-limits + throttling, rollback**: [`docs/runbooks/azure-work-profile.md`](docs/runbooks/azure-work-profile.md)
(guide) + [`docs/plans/azure-work-profile.md`](docs/plans/azure-work-profile.md)
(plan/audit). Template: [`defaults/work-profile.env.example`](defaults/work-profile.env.example).

## Cross-Skill Data Loop

Migration `20260419120000_cross_skill_data_loop.sql` closes the feedback loop
between the skills. Every skill writes to a shared learning store via
`scripts/cross-skill.mjs` — graceful no-op when the cloud store is off.

Catalogue — 9 tables, 3 added columns, 6 views, and the bandit reward
extension: [`docs/reference/cross-skill-data-loop.md`](docs/reference/cross-skill-data-loop.md).
The highest-leverage row is `persona_audit_correlations`: a persona P0/P1 that
corroborates an audit finding is ground truth about user-visible impact, and it
re-weights `computeReward` from 40/30/30 to 35/25/25/15.

**Design rule**: all cross-skill writes go through `scripts/cross-skill.mjs`.
Never hand-write curl POSTs in a SKILL.md for these tables — the CLI handles
auth, graceful no-op, git-derived commit_sha, and error normalisation.

**Skill recommender (à-la-carte "what's next" advisor).** `cross-skill.mjs
recommend-skills` + the pure [`scripts/lib/skill-recommender.mjs`](scripts/lib/skill-recommender.mjs)
suggest the FEW additional lenses that fit a change, so a user who ran ONE skill
doesn't have to remember the chain (distinct from `/cycle`'s full-auto path).
Deterministic (no LLM); signal hierarchy audit-findings → plan `applicable_lenses`
→ tight file globs; **nudge-not-gate**, **cap 2**, **silent when nothing fits**,
env-aware (browser lenses need a live URL), never re-suggests the just-ran or
already-covered lens. `/audit-code` Step 6.6 prints the card at convergence.

## R2+ Audit Mode (Phase 1)

When `--round >= 2`, the audit script enables three-layer defence against finding churn:

1. **Rulings injection** (Layer 1): `buildRulingsBlock()` formats prior rulings as system-prompt exclusions
2. **R2+ prompts** (Layer 2): `R2_ROUND_MODIFIER` + pass rubric (not "find all issues")
3. **Post-output suppression** (Layer 3): `suppressReRaises()` fuzzy-matches findings against ledger, then — when cloud is on — `runCloudFpPass()` applies the **cloud FP-pattern policy** (`docs/plans/cloud-fp-suppression-read-loop.md`). Called **unconditionally, outside the ledger branch** (a no-ledger run is exactly the case a pattern learned on another machine serves) and it **exempts `reopened`** so category statistics can never mask a regression. Layer 1 stays local-ledger-only: a pre-generation "do NOT raise X" hint can stop a required reopen from ever reaching the classifier, so the cloud policy deliberately does **not** feed the prompt.

### R2+ CLI Flags

| Flag | Purpose |
|------|---------|
| `--round <n>` | Round number (triggers R2+ mode if >= 2) |
| `--ledger <path>` | Adjudication ledger JSON (rulings + suppression) |
| `--diff <path>` | Unified diff (git diff output) for line-level annotations |
| `--changed <list>` | Files modified this round (authoritative for reopen detection) |

### Adjudication Ledger

Two-axis state model: `adjudicationOutcome` (dismissed/accepted/severity_adjusted) + `remediationState` (pending/planned/fixed/verified/regressed). Written by orchestrator via `writeLedgerEntry()`.

## Architectural Memory — Pre-fix Consultation (MANDATORY)

The architectural-memory feature (`docs/plans/architectural-memory.md`)
indexes every symbol in this repo into the audit store, with embeddings, so we
can find near-duplicates before writing new code. The `/plan` skill
consults it automatically. **But ad-hoc fixes in Claude Code or Copilot
bypass the planning skill entirely** — which is where most architectural
drift creeps in.

**Rule** — if you (the AI agent reading this) are about to write a new
function, class, hook, component, route, method, or constant as part of
a fix or feature request, you MUST first run:

```bash
node scripts/cross-skill.mjs get-neighbourhood --json '{
  "targetPaths": ["<files you intend to touch>"],
  "intentDescription": "<one-line summary of what you are about to write>",
  "k": 8
}'
```

Then act on the recommendation column. **Three bands, and no absolute cosine
numbers — the cutoff is computed per repo** (see "Why no fixed numbers" below):

- **`precedent`** — existing code occupies this space and merits a serious look
  **before** you write anything. Open the named symbols. Then decide, on the
  code, whether to reuse one, extend one, or write a sibling — and say which,
  and why, in your reply. The band does **not** tell you which of those three
  is right; a distance score cannot see dependency direction, API shape,
  ownership or accumulated debt.
  - `bandReason: above-floor-cluster` — several similar symbols. This is the
    *strongest* duplication signal, not a weaker one.
  - `bandReason: above-floor-standout` — one clear match.
- **`review`** — nothing rose above this repo's noise floor. Proceed greenfield.
  `bandReason` says why: `below-noise-floor` (compared, and weak) or
  `uncalibrated-repo` (no calibration exists here yet — see below).
- **`unscored`** — the symbol has **no embedding**, so nothing was compared.
  This is *absence of evidence*, not a weak match. Never read it as "checked
  and rejected".

**Why no fixed numbers.** The old `reuse ≥0.90 / extend ≥0.85 /
justify-divergence ≥0.75` bands fired **zero times in 1,763 consultations** —
this pipeline tops out near 0.83, so they were mathematically unreachable and
the feature was silently inert for its whole history. The cutoff is now `μ + 3σ`
over the repo's OWN symbol-embedding background, computed at `arch:refresh`. A
threshold is a property of *corpus × summary style × embedding model × compose
template × normalizer*, not of the tool — and this tooling syncs to other repos,
so shipping a constant would repeat the defect elsewhere. **An uncalibrated repo
bands `review` only**: honest, not degraded — nothing has established what a
meaningful score is there; run `npm run arch:refresh`. The three old band names
are **retired**; seeing them means the tooling is stale.

**When NOT to consult**:

- Pure bug fixes that change only an existing function's body (no new symbol introduced).
- Trivial edits: typos, formatting, single-line conditional tweaks.
- Doc-only or test-only changes (unless adding new test helpers).
- When the cloud store is offline (`{"cloud": false}`) — log a hint that `npm run arch:refresh` would enable consultation, then proceed.

**Auto-fired** by `.claude/hooks/arch-memory-check.sh` on `UserPromptSubmit` when the
prompt carries an intent verb (`fix`/`add`/`implement`/`refactor`/… — the list lives in
the hook). A `> **Architectural-memory consultation**` callout means it fired: treat it as
authoritative. It didn't fire (a question that became a fix mid-conversation)? Run the
command above by hand. Disable with `ARCH_MEMORY_HOOK_DISABLE=1`. Cost is ~$0.0003 + one
RPC, disk-cached 24h by `(intentDescription, model, dim)`.

## Security incident memory — Mandatory consultation

Companion to architectural memory. The `/plan` skill auto-fires
`get-incident-neighbourhood` in Phase 0.5b — for ad-hoc fixes outside
`/plan`, manually consult before writing security-relevant code:

```bash
node scripts/cross-skill.mjs get-incident-neighbourhood --json '{
  "targetPaths": ["<files you intend to touch>"],
  "intentDescription": "<one-line summary>",
  "k": 3
}'
```

**When to consult**: any change to auth flows, payment handling, input
parsing, log statements that might carry sensitive data, external API
calls with credentials, file uploads, or anything in a domain previously
mentioned in `docs/security-strategy.md` incidents.

**When NOT to consult**: pure UI tweaks, type-only refactors, test
fixtures, doc-only changes, cosmetic edits.

If the response includes incidents with `mitigation-failing` or
`manual-verification-required` status that match your target paths,
explicitly address them in the design before proposing code.

If `docs/security-strategy.md` doesn't exist for this repo, run
`/security-strategy bootstrap` once to seed it. Single-line
post-push reminders surface security-relevant commits via `/ship`.

### Secret pre-write gate + audit trail (back-port from corporate kit)

`npm run security:refresh` gates every parsed incident before it reaches the DB
([secret-classifier.mjs](scripts/lib/security/secret-classifier.mjs)):
high-confidence secret shapes **REFUSE** (not indexed, non-zero exit — scrub
`docs/security-strategy.md` and re-run); low-confidence PII **auto-REDACTs**
into the stored row. Writes append to `security_strategy_events` as governance
evidence. One defence-in-depth invariant: the final-pass redactor is the gentle
`lib/secret-patterns.mjs`, deliberately **NOT** `sanitizer.mjs`, which
blanket-redacts any 20+ char token and would corrupt incident prose. Full kit +
why the corporate Azure modules were not ported: [docs/plans/security/](docs/plans/security/).

---

**Empirical effectiveness test** — run once per repo on deploy and after major
prompt changes: A/B two fresh sessions on the same near-duplicate-rich prompt
(`ARCH_MEMORY_HOOK_DISABLE=1` control vs hook enabled), over 5–10 prompts;
"effective" is reuse-or-mention in ≥60%. Full recipe: the comment block at the
bottom of `tests/hook-arch-memory-check.test.mjs`.

## Quick-fix detection — two-layer architecture

Plan: `docs/plans/brainstorm-quickfix-v1.md` Feature B.

**Philosophy**: nudge, not gate. Root cause beats shortcut, but explicit
acceptance beats silent shortcut. The system surfaces shortcuts so the
author can decide whether they're warranted, not so they're automatically
blocked.

**Layer 1 — prospective hook** (`.claude/hooks/quickfix-scan.mjs`): fires on
every Edit/Write (PostToolUse), pure-regex scan for ~12 mechanical shortcut
signatures (empty catch, unjustified `@ts-ignore`, masked errors, hardcoded
localhost, …). Emits a `<system-reminder>` callout — NEVER blocks. Opt-outs:
`QUICKFIX_HOOK_DISABLE=1` (session), `// quickfix-hook:ignore` on the line
(language-correct comment syntax per file type), auto-bail on >80K-char
diffs, sensitive-path short-circuit. Pattern matrix:
`scripts/lib/quickfix-patterns.mjs` (one entry per new pattern).

**Layer 2 — retrospective audit pass** (`quickfix` wave in /audit-code):
low-reasoning GPT pass for DESIGN-level shortcuts the regex can't see (stub
returns, tests asserting non-failure, masked root causes). Findings emit
`is_quick_fix: true`; the `quickFix == 0` convergence threshold gates them.

Two layers because neither covers the other's axis: mechanical-at-edit-time
vs semantic-at-review-time. Full spec:
`docs/plans/brainstorm-quickfix-v1.md` §B.

## Requirements Layer — de-facto invariant ledger

Plan: `docs/plans/requirements-layer.md`. A materialized view of the
codebase's de-facto requirements — the behavioural / safety / security /
correctness / persistence invariants the code already enforces.

- **`scripts/requirements.mjs`** — CLI: `extract --files <a,b,…> [--runs N]`
  → `reconcile` → `index`. `extract` runs the LLM extractor 2× and merges;
  `reconcile` folds candidates + gap assessments + hand-curated
  `overrides.json` into the ledger; both hold a repo-scoped `withFileLock`.
- **`scripts/lib/requirements/`** — `schema.mjs` (Zod contracts, shared
  `RequirementIdSchema`), `extract.mjs`, `gap-challenge.mjs` (advisory),
  `ledger.mjs` (pure `reconcile`), `context.mjs` (`getRequirementsContext`),
  `llm-json.mjs`.
- **`.requirements/`** — `README.md` + the **committed** `ledger.json` (the
  shared, diffable rubric) are tracked; `candidates.json` / `gaps.json` are
  gitignored extraction intermediates; `overrides.json` is user-curated
  (committed when present). `ledger.json` is the single persisted artefact —
  the index is derived in-memory.
- **`/audit-code` consumption** — when `.requirements/ledger.json` exists,
  `runMultiPassCodeAudit` injects a `<requirements_rubric>` block (in-scope
  `active` invariants enforced, the rest indexed) through the shared
  `buildAuditPassPrompt`. Non-blocking: ledger absent → audit unaffected.
- **Egress safety** — `extract --files` is user-supplied: every path is
  repo-root-contained AND symlink-resolved before read; sensitive paths
  (and sensitive symlink targets) are refused; bodies are secret-redacted.

## Personal config — keep it out of the public repo

This repo is **public on GitHub**. The committed `.claude/settings.json`
must contain only project-portable, neutral values. Per-developer
overrides — local paths, machine-specific tweaks, personal allow-rules —
go in **`.claude/settings.local.json`** (gitignored at line 9 of
`.gitignore`).

Most relevant: `permissions.additionalDirectories`. Never add personal
folder paths (other projects, vault locations, AppData paths) to the
committed `settings.json`. The empty-array placeholder is intentional.

See `.claude/settings.local.example.json` for the format. To add your
own paths after cloning:

```bash
cp .claude/settings.local.example.json .claude/settings.local.json
# edit additionalDirectories with your local paths
```

Claude Code merges `settings.json` (project) with `settings.local.json`
(local) automatically — your local entries layer on top of the committed
defaults without polluting the public repo.

## Scope discipline — pre-existing uncommitted changes

When you find uncommitted, unstaged, untracked, or unpushed changes in
the repo that are **unrelated to the current task**: leave them alone.
They are the user's working set, not yours to tidy.

**Rules:**

- **Stage by name only** — never `git add -A`, `git add .`, or `git
  add -u`. Stage exactly the files you modified for the current task.
- **Never auto-commit** pre-existing state to "clean up" — that
  bundles unrelated work into your commit and corrupts blame/history.
- **Never auto-stash** unrelated work — stash conflicts on pop bite
  worse than the original mess.
- **Never `git rm --cached`** legacy tracked-but-gitignored files
  without an explicit user instruction; that change ships to every
  collaborator and isn't reversible by `git pull`.
- **Mention what you saw, once**, in a one-line note: *"Heads-up:
  there are 3 unrelated unstaged files (foo.ts, bar.mjs, baz.json) I
  left untouched."* Then move on — don't relitigate them.
- If the unrelated state genuinely blocks the task (e.g., a half-edited
  file you need to also edit), stop and ask the user how to proceed
  before touching it.

**Why:** Scope expansion is the failure mode this rule prevents.  Without
it, sessions drift from the requested task into repo-hygiene meta-work
the user didn't authorise, and the final commit bundles unrelated work
that's hard to revert cleanly.  Repo hygiene is a separate, dedicated
task — request it explicitly when you want it done.

## Sensitive paths + VCS contract (canonical locations)

[`scripts/lib/sensitive-paths.mjs`](scripts/lib/sensitive-paths.mjs) is the
**single source of truth** for sensitive-path classification (`sensitive` vs
`generatedNoise`) — four consumers delegate to it; never add a fifth
implementation. Three invariants that constrain any change here:

- **Skip logging goes through `formatSkipLog`.** Sensitive entries aggregate;
  `SENSITIVE_PATHS_DEBUG=1` emits `[redacted:<sha256-hex8>].<ext>` — never
  basenames, never full paths.
- **Fail closed, always.** `resolveAndClassify` re-checks the realpath, so a
  symlink named innocently but resolving into `~/.ssh/` is caught; a resolution
  error or a repo-escaping symlink classifies as `sensitive`, and `redactSecrets`
  returns `[REDACTED:redaction-failed]` rather than leak a payload it could not
  process. INC-001 in [docs/security-strategy.md](docs/security-strategy.md)
  records the symlink-bypass class this closed.
- **Structured results, never bare throws.**
  [`scripts/lib/vcs.mjs`](scripts/lib/vcs.mjs) returns `{ok:true,…}` or
  `{ok:false, error:{code,…}}` over a closed `VcsErrorCode` enum, of which
  `EXEC_FAILED` is the **only** retryable code. Likewise
  `runJsonLinesAsyncStrict` ([subprocess.mjs](scripts/lib/subprocess.mjs))
  hard-fails on parse errors by default — that closes the `.filter(Boolean)`
  silent-data-loss invariant, where dropped lines let a caller read a short
  list as a complete one.

Category lists, the 12-case diff-state matrix, both error enums and their exit
codes: [`docs/reference/sensitive-paths-and-vcs.md`](docs/reference/sensitive-paths-and-vcs.md).

## Verification discipline (cross-skill)

Six rules from a 2026-08-07 field report, each led by its measurement. Canonical:
[`docs/audit/shared-references/verification-discipline.md`](docs/audit/shared-references/verification-discipline.md),
synced into seven skills' `references/` by `sync-shared-audit-refs.mjs` and
byte-checked in `npm run check`. **Edit the canonical, never a copy.**

- **Pin a line number to the commit you read it at** — `path:120 (a4ec98da)`.
  *5 of 9* bad claims in one verified document were correct when written and
  decayed into wrong-but-**resolving** references. Cite append-newest-first files
  (`status.md`) by section header, never by line. Check with
  `npm run docs:citations -- <doc>` (report-only, not in `check`).
- **Label figures `measured`/`derived`/`expected` and carry the command.** This
  file's own test row read `~5250 tests (~12s)` against a real 12,216 in 80s —
  *2.3x* and *6.7x* stale, and it is the number you reach for when a run looks
  wrong.
- **A check is not trustworthy until seen to fail; when one fails, suspect the
  instrument first.** Red-then-green, one defect at a time. A before/after
  observation of a pre-existing defect is **not** a negative control. Six
  consecutive verification-script failures in one session were all instrument
  defects. `/audit-code` Step 4.5 and `/ux-lock` Step 2.5 own this.
- **Reproducing a figure is not verifying its attribution.** A 22.5% reduction
  reproduced perfectly while its stated cause was false — the parent already had
  the credited property, and the real mechanism was *92%* of the delta.
  `/investigate` Step 2.5 reports `figure` and `attribution` separately.
- **Promote a one-off check that mattered** — subject probe + negative control +
  vacuous-pass guard, with a disposition and a named retirement predicate:
  [`skills/audit-code/examples/contract-test-scaffold.md`](skills/audit-code/examples/contract-test-scaffold.md).
- **Verify what the consumer receives, not what the producer sent.** `/ship`
  Step 6.8; `unverified` must name a concrete blocked prerequisite, never a bare
  "not applicable".

## Commit provenance trailers (`AI-*`)

`/ship` commits carry `AI-Skill`/`AI-Models`/`AI-Gate`/conditional `AI-Run-ID`
git trailers written ONLY by `scripts/ship-commit.mjs` (`/ship` Step 6.3) —
never hand-typed; the `AI-*` namespace is reserved. `AI-Gate: passed` is
verdict-verified against the store's `audit_runs` row (fail-closed — an
unevidenced or unverified `passed` cannot exist). Applies from tag
`provenance-v1` forward; absence
after that = "not mechanically produced". Schema, query cookbook, failure
contract: [`docs/reference/commit-provenance.md`](docs/reference/commit-provenance.md).

## Code Style

- ESM modules (`import`/`export`, not `require`)
- `process.stderr.write()` for progress logging (keeps stdout clean for JSON output)
- `--out <file>` pattern: JSON to file, 1-line summary to stdout
- Zod schemas define structured output contracts for all LLM calls
- Functions follow `{result, usage, latencyMs}` return contract

## Do NOT

- Use `_def.typeName` or `_def.shape()` — these are Zod 3 patterns, we use Zod 4
- Send `.env` or credential files to external APIs
- Use `require()` — project is ESM-only
- Create new Anthropic/OpenAI client instances per call — reuse the client created in `main()`

## Accepted Technical Debt

These items were evaluated and deliberately accepted:

| Item | Rationale | Revisit trigger |
|------|-----------|-----------------|
| `atomicWriteFileSync` no fsync | CLI tool, not a database. Rename atomicity protects against process crash (the real failure mode). | Never — unless used in a daemon/server context |
| `atomicWriteFileSync` temp naming (PID+timestamp) | Collision requires same PID + same millisecond + same directory. Probability negligible. | Never |
| `readFileOrDie` process.exit(1) | Name is self-documenting. Only called from CLI entry points. | If ever called from a library context |
| `normalizePath()` lowercasing | Correct for Windows (case-insensitive FS). On case-sensitive Linux, distinct files could collide — acceptable for local-repo auditing. | If deployed as a CI service on Linux |
| Module-global caches (`_repoProfileCache`, `_taskStore`, `_clientCache`) | Safe in CLI-per-invocation model. Each process starts fresh. Anthropic client cache uses effective-resolved env values so two unparameterised calls hit the same entry. `_resetClientCache()` available for tests. | If extracting as a library or running as a long-lived server |
| `anthropic-client.mjs` `_internals` test exports | Mirrors `file-io.mjs`, `shared.mjs` project pattern. Internal helpers (`buildPromptFromMessages`, `normaliseCliOutput`, `quoteWinArg`) need direct test coverage; underscore-prefix signals private. | If we adopt stricter export hygiene project-wide |
