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
> when this file exceeds 1200 lines — condense a dossier section to a stub +
> `docs/<topic>.md` rather than raising the cap.

<!-- arch-map-discoverability:start -->
> **Architecture map**: [`docs/architecture-map.md`](docs/architecture-map.md)
> is the live, generated index of every symbol in this repo. Start there
> when you need to find an existing function, class, or component before
> writing a new one.
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
> Only AGENTS.md describes this — [CLAUDE.md](CLAUDE.md) intentionally
> stays a thin Claude-Code-only addendum via `@./AGENTS.md`, so this
> single-file change is the canonical surface.

> **Generated-artifact policy (invariant — avoid the "messy middle").** Every
> generated file lands in exactly ONE of two categories; never tracked-but-
> unverified-and-volatile:
> - **A — derived from external/mutable state OR carrying volatile provenance
>   (timestamps, HEAD shas) → gitignored.** It is not source and cannot be a
>   pure function of committed source. Examples: `.audit-loop/domain-deps-observed.json`
>   (DB import graph), `.audit-loop/cache/`, **`dashboard/index.html` +
>   `dashboard/telemetry.html`** (local-only, rebuilt by `npm run dashboard`),
>   `.audit-loop/repo-alias-map.json` (spent reconcile intermediate), **the
>   SOURCE repo's `scripts/.sync-manifest.json`** (regenerated on every `npm run
>   sync` with a timestamp + HEAD sha — committing it is pure per-push churn;
>   gitignored source-only, while CONSUMERS still track their own copy for the
>   isolation verifier).
> - **B — a pure, deterministic function of committed source → committed AND
>   freshness-verified in the pre-push `check`.** Regeneration must be byte-
>   identical (no clocks/shas/network). Example: `.claude/skills/**` (regen by
>   `skills:regenerate`, enforced by `skills:check`). `docs/architecture-map.md`
>   is committed because it's structural-from-source.
>
> The test for a tracked generated file: *would two regenerations on the same
> commit be byte-identical, and does a check enforce it?* If no → it belongs in
> A (gitignore it), not committed. A committed artifact whose dirtiness carries
> no information is churn, not a reference. (The dashboard reference page lived
> in the messy middle until 2026-06 — see `docs/completed/local-dashboard.md` §2.1.)
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

**Purpose**: A bundle of 15 AI-pair-programming skills covering the full development quality lifecycle — from planning through code audit to live UX testing and shipping.
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

> **Note**: `.github/skills/<name>/` was a previously-generated mirror, deprecated in Phase 4 of ai-context-sync (at the time, no documented AI tool read it). **Updated 2026-07-13**: VS Code Copilot's Agent Skills (the cross-agent open standard) now natively discovers BOTH `.github/skills/` AND `.claude/skills/` — with `.github/skills/` taking PRECEDENCE on name collisions. That makes keeping `.github/skills` deleted MORE important, not less: a stale resurrected copy would silently shadow the fresh `.claude/skills` copies Copilot already reads.
>
> The committed `.claude/skills/**` is the single Copilot-native surface (frontmatter `name` must equal the directory name — Copilot skips mismatches silently; ours all match). `.github/prompts/` slash-command shims remain as the classic prompt-file surface. `--keep-github-skills` remains a legacy escape hatch only.

Every reference file has `summary:` YAML frontmatter that must byte-match
the parent SKILL.md's reference-index row. `npm run skills:check` enforces
this — see `docs/reference/skill-reference-format.md`. A skill MAY also carry a
colocated `gate-contract.json` binding a stated gate to its enforcing
code+test (never packaged/synced; no contract = `uncontracted`, not
failed) — `npm run skills:check`/`gates:check` validate it; details:
`docs/reference/gate-honesty.md`.

Each skill is a sibling — they share env vars and Supabase stores but have distinct scopes:
- **plan**: code that doesn't exist yet. Unified planner (auto-detects backend/frontend/full-stack); the frontend/full-stack path produces a machine-parseable "Acceptance Criteria" section that `/ux-lock verify` consumes.
- **audit-plan**: refines plans before implementation (max 3 rounds, rigor-pressure stop). Single-file edits.
- **audit-code**: code that was just written (5-pass parallel static analysis + LLM audit + R2+ suppression). Always also runs a mechanical **duplication** wave (pure-Git diff attribution against the architectural-memory index, read-only) — suppress an intentional duplicate with a `// @duplicate-justification: target=<file>:<symbol> reason=<why>` pragma above the declaration; see `skills/audit-code/SKILL.md` and `docs/completed/audit-code-duplication-wave.md`.
- **ux-lock**: code that was just fixed (Playwright e2e regression lock). **Verify mode** (`/ux-lock verify <plan.md>`) grades a `/plan` plan against its live implementation — each criterion becomes a Playwright test case; results populate `plan_verification_runs` + `plan_verification_items`. **Selector policy (2026-07)**: generated specs LOCATE via the semantic ladder (`getByRole` → `getByLabel`/`getByPlaceholder` → `getByText` → `getByTestId` → justified-structural CSS carrying `// selector-policy: structural — <reason>`); `ux-lock-run.mjs` lints every spec it runs plus its local-helper import closure (unmarked structural selectors, `app-module-import` — specs must never import app source; drive the UI). Warn by default, `--strict-selectors` exits 6; unjustified counts persist per run row (`selector_policy_violations`, migration `20260703200000`). [`scripts/lib/ux-lock/selector-policy.mjs`](scripts/lib/ux-lock/selector-policy.mjs) `classifySelector` is the single policy oracle — `candidate-spec.mjs` reuses it so consistency-candidate promotion emits the same markers. Plan: `docs/completed/ux-lock-selector-policy.md`.
- **persona-test**: deployed app, narrative QA. Three execution modes:
  - **Exploratory** (default, MCP-driven): persona walks the app via Playwright MCP, finds UX issues, writes a P0-P3 report + debrief.
  - **Pair** (`--pair "<p1>" "<p2>" <url>`): runs two opposed-expertise personas back-to-back, diffs findings into CONSENSUS / A-ONLY / B-ONLY buckets. Use when coverage matters more than speed — empirically ~92% disjoint findings.
  - **Consistency mode** (`--mode consistency --canary <name>`, code-driven Playwright): deterministic runner against a canary journey + a `surfaces.json` manifest declaring `data-engine-claim` HTML attributes. Detects cross-step UI/state contradictions (DOM-vs-network-truth, stale-projection, undeclared-engine-claim, missing-surface). Emits `regression_specs` candidates with full witness snapshots; `/ship` Step 5.6 promotes them to locked Playwright specs. See `docs/reference/consistency-contract.md` for the HTML attribute contract.
- **click-test**: deployed app, structural DOM audit. Mechanical complement to persona-test — walks every interactive element, asserts semantic-HTML contracts (duplicate IDs, orphan labels, inputs without names, ARIA misuse, heading hierarchy, missing alt, undersized touch targets). Catches issues personas never trigger because there's no narrative reason to notice them. Optional `--with-modals` opens each modal/dropdown and re-scans the live DOM. Cache-busts service workers before scanning.
- **nav-audit**: the **system-level** third UX lens (persona-test = journey-first, click-test = page-first, nav-audit = system-first). Static, code-derived audit of the WHOLE navigation graph — extracts every entry point × destination via `@babel/parser` AST (+ a string/template scan so vanilla template-HTML apps work), attributes anchors by render-containment, and runs a 10-class taxonomy (orphan, coverage-gap, redundancy, competing-models, anchor-regression, …) asking "is what's OFFERED what's NEEDED?" grounded in the persona registry. Two-artifact split: route-owned facts colocate in code (`navMeta`/`@nav` docblock); product intent lives in a tiny committed `nav-contract.json`; the observed graph is gitignored + regenerated. CI gate is **drift-only** (hard-fails only on a declared-intent regression on the changed surface). `--verify <url>` drives headless Chromium to reconcile static-vs-live (confirmed / static-only / runtime-only), attribute each live destination to its DOM-container layer → per-persona scorecard (pass/misplaced/missing), and ALSO run the layer-attribution finding classes over the **live** evidence ("Live findings", `source:'live'` — competing-models/over-exposure/sequencing fire on data-driven apps the static taxonomy can't model; state-scoped so responsive duplication isn't a false competing-model). A bounded **activation pass** opens collapsed menus/hamburgers and re-snapshots so behind-menu destinations aren't mislabeled "missing" (`--no-activate` to disable). The persisted verify-result is keyed on the contract digest (incl. `exclude`) + `NAV_VERIFY_TOOL_VERSION` (the live-result semantics version, decoupled from the observed-envelope `NAV_TOOL_VERSION`); the dashboard surfaces live evidence independently of the static observed envelope (live-only mode). **Capture honesty (v1.4)**: when a declared nav container is *visible-but-empty* (a stall, e.g. under a cold-init rate-limit storm) or never observable, that layer is `unverifiable` and the scorecard/live-findings degrade to `unverified` + a warning rather than emit an authoritative `misplaced`/`missing` — a `display:none` responsive container is a legitimate variant, not a stall. The activation pass adaptively aborts after 3 consecutive unactionable triggers so it can't amplify a degraded app's storm. Dashboard "Nav Audit" tab (REGISTRY.reference): Per-Persona Reachability Scorecard + Nav Drift + Live findings. Plans: `docs/completed/nav-audit-skill.md`, `nav-audit-v1.3-live-findings.md`, `nav-audit-debt-digest-decouple.md`, `nav-audit-v1.4-capture-honesty.md`.
- **visual-audit**: the **paint-level** fourth UX lens (persona=journey, click=page, nav=system, **visual=paint**). Math-first, deterministic visual-contract auditor — drives Playwright + `getComputedStyle` + `getBoundingClientRect` + CDP `forcePseudoState` to assert what the page *paints*, with a VLM advisory-only (`--explain`, never gates). **Verify-primary** (unlike static-primary nav-audit): paint can't be asserted without rendering, so the static run only parses declared token sources → allowed-set + a source-coherence lint and emits NO paint findings (banner says so); `--verify <url>` runs the four tiers. **Tiers**: (1) declared-token reconciliation — a rendered value must be on the declared scale OR set by a token-referencing winning declaration (cascade-resolved), else `token_violation`; token-less apps get a report-only inferred-cluster fallback; (2) theme parity — MUST-MATCH in-flow geometry (only for nodes rendered in *both* themes, so a `display:none`-in-one-theme element isn't false-flagged) + may-differ-if-tokened colors (untokened literal identical across themes → `theme_unmapped_token`) + contrast over the in-browser-resolved opaque backdrop; (3) layout physics — overflow / silent clipping / overlap (ancestor-descendant containment excluded) / image distortion; (4) signifier matrix — `missing_visible_focus` (any indicator: outline/ring/border/bg), `state_has_no_visual_delta`, `disabled_not_signified`, read via CDP forced-pseudo-state after freezing transitions (no flaky actuation). Two-artifact split: committed `visual-contract.json` (surfaces + sourceGlobs + tokenSources + themes + globalStyleGlobs); gitignored `.audit-loop/visual-{observed,verify-result,drift-ledger}.json`. CI gate is **drift-only** via the canonical `ChangedScopeResolver` (changed-scope.mjs) — blocks a gate-eligible finding only when its surface's sourceGlobs, a changed token source, a contract edit, or a `globalStyleGlobs` cascade touches the change. Capture honesty: an absent/empty-skeleton surface or unresolvable backdrop degrades to `unverified`, never a false authoritative finding. The scope firewall (in SKILL.md verbatim): *"include a check only if you can assert it on a computed style without knowing what the page is FOR"* — signifiers in, affordance judgments out (those are persona-test's). Dashboard "Visual Audit" tab (REGISTRY.reference): Contracted-Surface Scorecard + Visual Findings. Plan: `docs/completed/visual-audit-skill.md`.
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
> So `nav-audit`/`visual-audit` are a consistent pair, and `click-test`/`persona-test`
> are another. Renaming the lenses to `audit-nav`/`audit-click` would *break* this:
> "audit click" isn't a coherent object, and the `audit-` prefix would falsely imply
> membership in the adjudication-loop family (rounds/ledger/Gemini) that the lenses
> don't have. The grammar test: you "audit *the plan/code*" (verb+object) but you run
> "a *nav audit*" / "a *click test*" (compound noun). Keep the names; this note is the
> legibility fix.

## Consumer-repo layout (isolation)

This source repo's tooling deploys to consumer repos under
**`scripts/.claude-skills/`** rather than the consumer's natural
`scripts/` directory. The directory is gitignored on the consumer
side via a managed block in their root `.gitignore`. The directory
isn't tracked — fresh clones of a consumer repo need to re-run
`npm run sync --target <name>` from THIS repo to hydrate it.

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
> fix is the root.
>
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

The sync-behavior detail (why the isolated subdir exists, the full
what-goes-where table, the managed-gitignore runtime-outputs block +
self-healing untrack semantics, and the `sync-*` key-module list) lives in
[`docs/runbooks/consumer-adoption.md`](docs/runbooks/consumer-adoption.md) §"Sync internals".
One structural invariant stays here: **the sync layout's single source of
truth is [`scripts/lib/sync-path-map.mjs`](scripts/lib/sync-path-map.mjs)** —
never hand-compute a consumer path.

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
is the live, generated per-symbol index (see the bootstrap note at the top of
this file); an inline tree goes stale silently (the one removed 2026-07-13
still listed 2 test files against 100+ real ones). Layout in one line:
`scripts/*.mjs` are CLI entry points; `scripts/lib/**` are focused modules
(split from the former `shared.mjs` monolith — `shared.mjs` remains as a
backwards-compatible barrel); `tests/` is the Node built-in test-runner suite;
`.claude/skills/**` is generated from `skills/**`.

### Script Responsibilities

- **lib/*.mjs**: Focused modules — import directly from `./lib/<module>.mjs` for explicit deps, or from `./shared.mjs` barrel for convenience. Schemas (`lib/schemas.mjs`) are the single source of truth (JSON Schemas derived via `zodToGeminiSchema()`).
- **openai-audit.mjs**: 5-pass parallel code audit (structure, wiring, backend, frontend, sustainability). Plan audit. Rebuttal deliberation. Uses GPT with `responses.parse()` + Zod schemas. Integrates bandit reward updates + Supabase cloud sync.
- **gemini-review.mjs**: Independent final review (MANDATORY — not gated by convergence). Receives full audit transcript. Detects bias, false consensus, missed issues. Uses Gemini 3.1 Pro (16K thinking budget), with Claude Opus fallback. Claude deliberates on CONCERNS, then Gemini re-verifies.
- **learning-store.mjs**: Cloud persistence via Supabase — repos, runs, findings, pass stats, bandit arms, FP patterns, adjudication events. Graceful fallback to local-only mode.

### Key Patterns

- **Adaptive sizing**: `computePassLimits()` scales token limits and timeouts based on context size
- **Graceful degradation**: `safeCallGPT()` catches failures and returns empty results instead of crashing
- **Semantic dedup**: Content-hash IDs (`semanticId()`) enable exact cross-round and cross-model finding matching
- **Targeted context**: `readProjectContextForPass()` sends only relevant AGENTS.md sections per pass (~1500 chars vs 8000)
- **Sensitive file filtering**: `.env`, credentials, keys are never sent to external APIs
- **Atomic persistence**: `atomicWriteFileSync()` — temp file + rename for crash-safe writes (ledger, bandit, FP tracker)
- **Fuzzy file discovery**: When plan paths don't match exact filenames, Phase 2 extracts PascalCase/backtick identifiers and matches against repo files
- **Schema validation at boundaries**: `callGemini()` throws on validation failure, `writeLedgerEntry()` validates entries before write
- **Thompson Sampling**: `PromptBandit` — Beta posterior updates from deliberation outcomes, synced to Supabase
- **Closed Gemini loop**: Step 7.1 — Claude deliberates on Gemini findings, fixes, then Gemini re-verifies (not GPT)

### Testing

Run: `npm test` (Node.js built-in test runner — the suite under `tests/`).
Covers atomic writes, schema derivation, ledger operations, finding identity,
FP tracker, bandit posterior, reward computation, sensitive-path egress, the
sync/relocation contract, and more.

#### Testing doctrine — which seam gets which kind of test

Blanket TDD is theatre at the LLM boundary (you can't red-green-refactor a
prompt). But test-first is high-value at deterministic seams and **mandatory**
at the two seams where a silent regression is both likely and expensive. Three
tiers (origin: `/brainstorm --with-gemini`, 2026-06; consensus of GPT-5.5,
Gemini-pro, Claude):

- **Tier 1 — test-first / TDD for deterministic seams.** Modules with crisp
  inputs/outputs where a regression is cheap to assert and expensive to ship:
  `schemas`, `sensitive-paths`, `vcs`, `bandit`, `ledger`, `findings-*`,
  `config`, `file-io`, `sync-path-map`, `sync-rewriter`. New behaviour here
  lands with its test.

- **Tier 2 — eval / fixture / invariant testing for LLM-orchestration seams.**
  `openai-audit`, `gemini-review`, prompt builders. **Do NOT** assert on model
  prose or mock the whole provider API to test orchestration order — that tests
  the mock. Instead assert **invariants** ("Gemini final review always runs
  regardless of GPT convergence"; "Supabase failure never blocks the local
  ledger write"; "sensitive paths never enter a provider payload") and use
  canned-response fixtures for the parse / fallback / dedup paths.

- **Tier 3 — HARD test-first (non-negotiable) for the two silent-regression-prone
  seams.** A change here lands with its test in the **same commit**:
  1. **Sensitive-path egress** — a leak ships credentials to a third-party LLM.
     Guarded end-to-end by `tests/sensitive-egress.test.mjs` (the gate) +
     `tests/audit-scope-egress.test.mjs` (the assembly path real audits use).
  2. **Consumer sync / relocation contract** — a break ships *silently* to
     consumer repos you can't observe. Guarded by `tests/sync-path-map.test.mjs`,
     `tests/sync-rewriter.test.mjs`, `tests/relocation-guard.test.mjs` (the
     `--selfcheck-relocation` string is *present*) + `tests/relocation-selfcheck-smoke.test.mjs`
     (the handler actually *works* under a hermetic env).

This is descriptive, not a new gate — it writes down where rigor already pays.
`fast-check` property-based fuzzing and an offline LLM eval matrix are
deliberately deferred (no new deps) — revisit if schema-boundary bugs recur.
See the **Do NOT** list below for the companion hard rules (no `.env` to
external APIs, etc.).

#### Pre-ship empirical verify — for skills that assert on a live runtime

The multi-LLM audit catches *static* error classes; it cannot catch bugs that
only manifest when a real browser renders a real app's real data (the
visual-audit shakedown proved this — a mid-theme-transition `getComputedStyle`
read *fabricated* a bug that survived four review passes). Three doctrine
rules, all load-bearing:

1. **Any skill that drives a browser / asserts on a live runtime**
   (visual-audit, nav-audit `--verify`, persona-test, persona-consistency,
   click-test, ux-lock) **must run against ONE real app before being declared
   done.** A field finding with a green repro routes to a regression test +
   ONE focused review — never the multi-round adjudication loop (that
   resolves *uncertainty*, which the repro already killed).
2. **Two recurring browser-capture bug classes to check by name**:
   mid-state-change capture (freeze transitions at runtime AFTER the flip +
   `await document.fonts.ready`), and empty/failed capture must never read
   clean (zero states captured → `unverified`/non-zero exit, never
   "verified / 0 findings").
3. **Audit your success paths**: any branch that can emit
   pass/clean/0-findings/green is where to be adversarial — ask *"can this
   return green without having actually checked anything?"* (the visual-audit
   `--gate` alone yielded six such holes; none caught by static review).

→ Full worked detail, per-skill exposure survey, and the gate-honesty case
list: [`docs/runbooks/pre-ship-empirical-verify.md`](docs/runbooks/pre-ship-empirical-verify.md).

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

→ Resolution-order detail, live-catalog mechanics, startup-log example, static-pool
maintenance: [`docs/reference/model-resolution.md`](docs/reference/model-resolution.md).

## Memory-Health Gate

`scripts/memory-health.mjs` runs three trigger metrics against Supabase to decide
whether our flat `audit_findings` + fingerprint-dedup design is starting to leak
signal that a graph-shaped memory (pgvector + community clustering) would
recover. Three triggers:

| Metric | What it measures | Default trigger |
|---|---|---|
| Fuzzy re-raise rate | New-fingerprint findings whose text matches a prior finding (trigram sim > 0.6) | `> 15%` |
| Cluster density | Median per-repo count of open finding pairs with sim > 0.5 but different fingerprints | `>= 5` |
| Recurrence rate | Fixed findings that reappear in same repo within 30 days under a new fingerprint | `> 10%` |

Runtime is the `memory_health_metrics(window_days)` Postgres RPC added by
`supabase/migrations/20260421120000_memory_health.sql` (uses `pg_trgm`).

**Auto-scheduled** via `.github/workflows/memory-health.yml` — runs every Monday
09:00 UTC, silent when all metrics green, opens/updates a sticky GH issue
(label `memory-health`) when any trigger fires. Auto-closes when metrics
return to green. Run locally: `npm run memory:health` or `npm run memory:health:json`.

**Decision rule**: 0 triggers for 4 weeks → current design is fine. 1 trigger
for 2 consecutive weeks → prototype pgvector similarity. 2+ triggers → build
the full clustering pipeline.

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
→ **Design**: master plan [`docs/completed/adaptive-learning-v1.md`](docs/completed/adaptive-learning-v1.md)
+ per-phase `adaptive-learning-phase-{1,2,3}-*.md`.

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes | — | GPT access (audit model defaults to latest pinned GPT) |
| `GEMINI_API_KEY` | No | — | Gemini final review (Step 7 falls back to Claude Opus if absent) |
| `OPENAI_AUDIT_MODEL` | No | `latest-gpt` | Model sentinel or concrete ID (see "Model Resolution" below) |
| `OPENAI_AUDIT_REASONING` | No | `high` | Reasoning effort |
| `GEMINI_REVIEW_MODEL` | No | `latest-pro` | Gemini model sentinel or concrete ID |
| `GEMINI_REVIEW_TIMEOUT_MS` | No | `120000` | Gemini timeout |
| `ANTHROPIC_API_KEY` | No | — | Claude Haiku fallback for brief generation (sdk backend only) |
| `CLAUDE_BACKEND` | No | `sdk` | Routing for Claude calls: `sdk` (raw API) or `cli` (`claude -p` headless — draws from Max 20x Agent SDK $200/mo credit from 2026-06-15). See "Anthropic Backend Routing" below. |
| `CLAUDE_BIN` | No | `claude` | Path/name of the `claude` CLI (cli backend only) |
| `CLAUDE_FINAL_REVIEW_MODEL` | No | `latest-opus` | Claude Opus override (Step 7 fallback) |
| `FINAL_REVIEW_SHADOW` | No | — | Opt-in **shadow** final reviewer (observation-only A/B): `claude-opus` \| `anthropic` \| `gemini`. Runs a second blind reviewer in parallel with the primary; never gates the build. No-op when unset or under an Azure profile. See "Shadow final-review A/B" below. |
| `FINAL_REVIEW_SHADOW_MODEL` | No | per-provider | Concrete model / sentinel for the shadow reviewer. Unset → derived from the provider (`claude-opus`→`latest-opus`, `gemini`→`latest-pro`). A family mismatch is a logged no-op. |
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
| ~~`SUPABASE_AUDIT_*`~~ | — | — | **Sunset in M4** (postgres-parity). The audit-loop now uses `AUDIT_DB_URL` exclusively; the legacy URL + anon-key + service-role-key triplet was tied to the old `@supabase/supabase-js` PostgREST path which has been removed. The runtime DSN's password IS the secret — no separate write-role key. |
| `LEARNING_DISABLE` | No | — | Set to `1` to disable all adaptive-learning live behaviour and telemetry recording (single env-var kill switch). |
| `LEARNING_REPO_NAME` | Required for weekly-review | — | Per-repo gate for `weekly-review.mjs`. Aborts if missing — prevents cross-tenant data leakage in the digest issue body. |
| `LEARNING_QUEUE_CAP_PER_TYPE` | No | `64` | Per-`decision_type` bounded sub-queue cap. Increase for high-throughput audits. |
| `AUDIT_AUTHOR_TIER_HINT` | No | — | **Observation-only** (never routes). Optional author-model hint (concrete id e.g. `claude-sonnet-4-6`, or a logical tier `economy\|standard\|frontier`) read by the `author_tier` recorder in `openai-audit.mjs` to capture actual-vs-suggested tier + the ladder partition key. A concrete id populates the partition key; a bare logical tier leaves it null. See `docs/completed/model-tier-observation.md`. |

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
- **`AUDIT_DB_TEST_URL` must be disposable — enforced, not documented-only.**
  `assertDisposableDbUrl` (`scripts/lib/db/client.mjs`) runs before any pool reset
  in the `db-setup`/`db-withtx` integration suites, rejecting a Supabase-hosted or
  production-identical test URL — closes a 2026-07-14 wipe incident. Detail: [postgres-parity-runbook.md](docs/runbooks/postgres-parity.md) §Incident.

→ **Design** (no-adapter `pg`-direct decision, schema scope, privilege model, file plan): [`docs/completed/postgres-parity.md`](docs/completed/postgres-parity.md) + [`postgres-parity-schema-coupling.md`](docs/completed/postgres-parity-schema-coupling.md). **Operations** (setup recipe, migration-drift CLI + exit codes, pre-push snippet, break-glass atomic-apply, shared-cloud-config, prerequisites): [`docs/runbooks/postgres-parity.md`](docs/runbooks/postgres-parity.md).

## Anthropic Backend Routing

All Claude API calls go through [`scripts/lib/anthropic-client.mjs`](scripts/lib/anthropic-client.mjs).
The `CLAUDE_BACKEND` env switches the underlying transport without touching
call sites:

| Backend | Transport | Bills against | Use when |
|---|---|---|---|
| `sdk` (default) | `@anthropic-ai/sdk` direct API | `ANTHROPIC_API_KEY` token meter | Today; CI without `claude` CLI installed |
| `cli` | `claude -p --output-format json` subprocess | **Before 2026-06-15**: your interactive Max 20x subscription (same pool as IDE sessions). **From 2026-06-15**: dedicated Max 20x Agent SDK $200/mo credit. | After credit redemption opens; reduces API spend on high-volume scripts |

> **Status (2026-06-29): flipped to `cli` locally.** The 2026-06-15 pool split
> has passed, so the cli backend now draws from the dedicated Agent SDK credit
> (not the interactive IDE pool). `CLAUDE_BACKEND=cli` lives in the gitignored
> `.env` (per-machine; the committed default stays `sdk` for CI without the
> `claude` CLI). Consumers opt in via their own `.env`.
>
> **Cost telemetry — what actually works (corrected 2026-06-29).** The cli
> backend self-reports `cost_usd` + token `usage` per call (parsed from
> `claude -p --output-format json` by `normaliseCliOutput`) — that is the
> authoritative per-call signal for scripted jobs like `npm run arch:refresh`
> (12 batched `claude -p` calls on its incremental path). **`claude-trace`
> canNOT meter the scripted cli backend**: its interceptor writes log banners to
> *stdout*, which corrupts the JSON envelope the backend parses, and it emits one
> JSONL+HTML (and a browser-open attempt) per spawned process — useless across a
> batch. Injecting it via `NODE_OPTIONS=--require <loader>` also breaks `npm`
> itself (the loader expects to wrap the `claude` entry, not arbitrary node
> processes). `claude-trace` is still the right tool for your **interactive**
> Claude Code sessions (the shared-pool concern it was installed for); it is
> installed globally and on PATH. The $200 credit is non-rolling and overage
> requires manually-enabled billing, so watch the backend's own `cost_usd` on
> high-volume runs.

**Migration**: call sites use the factory instead of `new Anthropic({apiKey})`:

```js
const { createAnthropicClient } = await import('./anthropic-client.mjs');
const client = await createAnthropicClient();
const resp = await client.messages.create({ model, max_tokens, system, messages });
```

The adapter exposes the same `.messages.create()` shape as the raw SDK, so
the body of every call site stays identical. The factory caches a single
client per `(backend, apiKey, claudeBin)` key for the process lifetime —
matches the "reuse client created in main()" rule below.

**Fully migrated** (2026-06-29): every Claude call site now goes through
`createAnthropicClient()` — `lib/context.mjs`, `lib/neighbourhood-query.mjs`,
`lib/llm-wrappers.mjs`, `symbol-index/summarise{,‑domains}.mjs`,
`refine-prompts.mjs`, `evolve-prompts.mjs`, and `gemini-review.mjs` (shadow
client, ping, Opus final-review fallback). No bare `new Anthropic()` remains
outside the factory itself (regression-guarded by a `grep` in
[tests/anthropic-client-migration.test.mjs](tests/anthropic-client-migration.test.mjs)).

**Backend-aware availability gate**: call sites that conditionally attempt a
Claude call use `isClaudeAvailable()` (exported from `anthropic-client.mjs`),
**not** `process.env.ANTHROPIC_API_KEY` — the cli backend authenticates via the
`claude` CLI and needs no key, so a raw env check would silently skip a fully-
available cli backend.

**Smoke test**: `npm run anthropic:ping` invokes a tiny prompt through
whichever backend the env resolves to.

> **Forced tool-calling needs `{backend:'sdk'}` explicitly (load-bearing
> gotcha, found 2026-07-14).** The `cli` backend's `messages.create()` only
> reads `{model, max_tokens, system, messages}` — it silently drops `tools`/
> `tool_choice` (by design: it always spawns `claude -p --tools ''`, a
> single-shot-text contract). A caller that needs `tool_choice:{type:'tool',
> name:'...'}` for structured output gets a plain `text` block back instead,
> with **no error** — the failure surfaces one layer up, wherever the caller
> checks for a `tool_use` block. This broke the tiered-recall pipeline's
> Sonnet discovery generator silently for the entire 2026-07-13→07-14 shadow
> window (20/20 runs fell back to legacy) before being root-caused; see
> `docs/plans/tiered-recall-audit-pipeline.md`. Any new call site that forces
> `tool_choice` must pass `createAnthropicClient({backend:'sdk'})` explicitly
> — never rely on the ambient `CLAUDE_BACKEND` resolution for that case.

## Shadow Final-Review A/B

Plan: [`docs/completed/final-review-shadow-reviewer.md`](docs/completed/final-review-shadow-reviewer.md).
An **opt-in, observation-only** second final reviewer that runs **blind** (same
audit transcript, never sees the primary's output) in parallel with the primary
final review, to empirically test whether a second final gate is worth keeping.

- **Enable**: set `FINAL_REVIEW_SHADOW=claude-opus` (or `gemini`). Unset → the
  shadow path is not entered at all (byte-identical to today). **No-op under an
  active Azure profile** — Claude/Fable/Mythos aren't on Foundry (load-bearing
  guard). The shadow **never gates the build** — its verdict is logged to the
  `--out` `_shadow` block but never touches `gemini_verdict`.
- **Measure** (operator how-to): `node scripts/cross-skill.mjs final-review-stats
  --repo REPO_NAME` → per-`source_model` × `bucket` × `severity` DISTINCT-fingerprint
  counts + the shadow-only spot-check queue + shadow token/latency cost. **Human
  adjudication is worksheet-first**: add `--worksheet` to render the pending queue as
  markdown with paste-ready `final-review-adjudicate` commands (real ids baked in;
  actions `accepted|dismissed`). Same surface as `model-ab-adjudicate --worksheet`;
  shared renderer [`scripts/lib/adjudication-worksheet.mjs`](scripts/lib/adjudication-worksheet.mjs).
  **Doc convention (recurrence guard)**: operator CLI examples use real values or
  PowerShell variables, never `<angle-bracket>` placeholders — PowerShell reserves
  `<`, so a placeholder command can't even be pasted, and a raw-JSON queue is not a
  human review surface.
- **Pre-registered stopping rule** (load-bearing — decided before data collection):
  collect `N ≥ 20` runs per fixed (primary, shadow) model pair; **KEEP** iff
  human-accepted shadow-only HIGH/MEDIUM ≥ 1 per 5 runs AND cost in tolerance;
  **DROP** if shadow-only is predominantly dismissed/LOW. Don't conflate "always
  catches something" with effectiveness.

→ Attribution schema (`source_model`, `bucket`, idempotent-replace persistence) +
the full stopping-rule rationale: [`docs/completed/final-review-shadow-reviewer.md`](docs/completed/final-review-shadow-reviewer.md).

## Tiered-Recall Audit Pipeline

A discovery → Stage 0 (deterministic evidence triage) → Stage 1 (cheap-model
triage) → Stage 2 (Gemini adjudicator + bounded clean-challenge) alternative
to the always-on GPT 5-pass legacy audit. All 12 phases (Clusters A-F) are
implemented and tested. `openai-audit.mjs`'s chooser
(`tieredAuditConfig.pipelineEnabled`, env `AUDIT_TIERED_PIPELINE_ENABLED`)
defaults **off** — production runs the legacy path today.

- **Stage 1 triager model** resolves via `scripts/lib/audit/stage1-triager-
  resolver.mjs`: an explicit `AUDIT_STAGE1_MODEL` operator pin wins if set;
  else the validated `docs/experiments/audit-effectiveness/cheap-triager-
  validation.json` manifest's `candidateModel` (GLM, passed 2026-07-12) is
  used; else GPT-5.5 (the safe default), always with a loud, named fallback
  reason — never a silent default.
- **Close-out shadow validation** (`tieredAuditConfig.shadowEnabled`, env
  `AUDIT_TIERED_SHADOW_ENABLED`, independent of `pipelineEnabled`): runs the
  tiered pipeline as an observation-only comparison alongside the real
  legacy run. Observations go to the local gitignored
  `.audit/tiered-shadow-log.jsonl` (fallback) AND, when `AUDIT_DB_URL` is
  set, the Supabase `tiered_shadow_observations` table (cross-repo totals);
  `getTieredShadowObservations` takes an explicit `repoIds` list only —
  never an ambient "all repos" scan. Progress check:
  `npm run audit:tiered-shadow-report` (cloud-first, `--repos <path,...>`
  for siblings, `--log <path>` forces local-only); the telemetry
  dashboard's **Tiered Shadow** tab is the visual progress surface for the
  Phase-14 window (same `summarize()` — they cannot disagree; the CLI stays
  authoritative). Deliberately NOT a 4th
  arm on the model-A/B/C shadow infra — different execution shape (whole-run
  vs per-pass substitution); rationale in the plan doc.
- **Execution eligibility is per-call, not env-global** (`allowTiered` —
  the 2026-07-13 incident fix): the env flags express "the window is open";
  only `openai-audit.mjs`'s `main()` passes `allowTiered: true`, so tests
  and library callers can never spend. Both must hold before any provider
  is constructed.
- **Cross-repo behavior**: the flag lives in `~/.audit-loop.env` (shared
  loader, no allowlist), so one line flips every local repo. In consumers,
  Stage 1 falls back to GPT-5.5 with a loud named reason — the GLM
  validation manifest was graded on THIS repo's finding distribution and is
  deliberately NOT synced.
- **2026-07-14 incident, fixed**: the window read as "met" (20 runs across
  two repos) while every single run was `fallback_legacy` — two compounding
  bugs. Root cause: the Sonnet discovery generator needs forced
  `tool_choice`, which the ambient `CLAUDE_BACKEND=cli` silently can't do
  (see the Anthropic Backend Routing gotcha above) — every round's required
  generator failed, every round fell back. Reporting bug: `comparedRuns`
  counted a `fallback_legacy` run as a real comparison merely because a
  `comparison` object existed, letting the fake "met" reading through. Both
  fixed: the tiered pipeline's `anthropicClient` now forces
  `{backend:'sdk'}`; `comparedRuns` now requires `tieredRunStatus ===
  'complete'`; `tieredFallbackReason` is now persisted so a future all-
  fallback state is diagnosable from the DB/dashboard, not a live repro. The
  old 20 rows are void — the window restarts from zero.
- **Not yet done**: the shadow-validation window itself (10-15 real commits with
  the flag on, now genuinely collecting from zero) and Phase 14 (the production-
  flip decision gate). **Also check at Phase 14**: the model-swap-eval-harness's
  adjudicator-role eval has never run (Stage 2 here uses Gemini) — see
  [model-eval-harness.md](docs/runbooks/model-eval-harness.md) §"Adjudicator role — not yet run".

→ Full plan, phase-by-phase spec, Stage-2 adapter wiring history (the
two-handle design, module-relative resolution for consumer layouts), and
audit trail: [`docs/plans/tiered-recall-audit-pipeline.md`](docs/plans/tiered-recall-audit-pipeline.md)
(still in `docs/plans/`, not `docs/completed/` — Phase 14 is pending on the
shadow-validation window, which has not started collecting).

## Model Swap-In Evaluation Harness

A standing test suite (`scripts/lib/model-eval/`) answering "is this new LLM
release worth switching to?" for the **auditor** role (currently GPT) or the
**adjudicator** role (currently Gemini), with the audit-effectiveness
research's rigor. Entry points:
`node scripts/model-eval-{auditor,adjudicator}.mjs --candidate <spec> --tier screen|promotion`.

**Load-bearing invariants** (full mechanics, tiers, and history in the docs
below):
- **Accepted false-negative direction**: a Tier-C-only run (e.g. a
  restricted-catalog Azure repo) can never emit `verdict:'switch'` — only
  `keep`/`inconclusive`/`manual_review_required`. Schema-enforced, not a
  convention.
- **The oracle-matching recall ceiling**: `known-defects.json` scoring can
  only credit the ONE curated defect per entry, but real models find OTHER
  genuine bugs in the same organic diffs — so a low recall or `inconclusive`
  is NOT necessarily a model-quality signal; check the raw per-case
  extraction output before trusting it. Applies to promotion-tier's Tier C
  fallback too (same single-shot extractor) — Tier C never substitutes for a
  Tier A/B comparative result.
- **Egress-gate prose/diff false-positive classes were found + fixed
  2026-07-12** (`looksLikeRealPath` gate; `(?<!\w)` lookbehind for `.env`;
  category/metachar/extension carve-outs) — historical recall is the
  contract; don't re-add trailing-punctuation stripping (tried, reverted:
  it re-blocked valid corpus entries). Guarded in
  `tests/egress-path-scan.test.mjs` + `tests/sensitive-paths.test.mjs`.
- **Verdict of record (2026-07-13): GLM-5.2 vs GPT-5.6 → `keep` GPT-5.6**
  (real Tier A, $1.87; FP-rate drove it; the recall column is untrustworthy
  per the ceiling above).

→ **Operational reference**: [`docs/runbooks/model-eval-harness.md`](docs/runbooks/model-eval-harness.md) · **Design + prior-art trace**: [`docs/completed/model-swap-eval-harness.md`](docs/completed/model-swap-eval-harness.md) · **First real verdict write-up**: [`docs/research/experiment-3-model-swap-glm-vs-gpt.md`](docs/research/experiment-3-model-swap-glm-vs-gpt.md).

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
audit trail: [`docs/completed/azure-work-profile.md`](docs/completed/azure-work-profile.md).

> **Opt-in invariant (load-bearing).** The Azure path activates **only** when
> `AZURE_OPENAI_ENDPOINT` is set. With no Azure env vars, client construction and
> resolved models are **byte-identical** to the public path (regression-guarded
> by `tests/openai-client.test.mjs`). It never touches your personal setup.

| Role | Public | Azure work profile |
|---|---|---|
| GPT auditor | `new OpenAI()` → api.openai.com | Azure OpenAI v1 (`AZURE_OPENAI_ENDPOINT/openai/v1`), deployment `AZURE_OPENAI_GPT_DEPLOYMENT` |
| Final reviewer | Gemini → Claude Opus fallback | **Opus on Foundry** (`AZURE_AI_ENDPOINT`), deployment `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` — replaces Gemini |
| Embeddings | Gemini `gemini-embedding-001` | Azure `text-embedding-3-small` (`dimensions: 768`) |

**Seam (mirrors `anthropic-client.mjs`)**: [`scripts/lib/openai-client.mjs`](scripts/lib/openai-client.mjs)
`createOpenAIClient({purpose})` + [`embed-text.mjs`](scripts/lib/embed-text.mjs)
`embedText()` route to Azure-v1 or public by env presence; `azureConfig` in
[config.mjs](scripts/lib/config.mjs). Wire deployment comes from the
`AZURE_*_DEPLOYMENT` vars while `OPENAI_AUDIT_MODEL` / `CLAUDE_FINAL_REVIEW_MODEL`
stay logical sentinels (dodges the `gpt-5.3 → latest-gpt` remap footgun);
`MODEL_CATALOG_REFRESH` auto-skips under Azure.

**Load-bearing gotchas** (the operational depth is in the guide):
- **Vector-space safety**: adopting Azure on a Gemini-built index is **refused**
  (provenance guard in `neighbourhood-query.mjs`); rebuild once with
  `npm run arch:refresh` + `npm run security:refresh`.
- **Final-reviewer precedence** (top wins): `--provider` → `FINAL_REVIEW_PROVIDER`
  → Gemini (if `GEMINI_API_KEY`) → Azure `azure-claude` (only when the profile is
  active) → public Opus. A stray `AZURE_OPENAI_ENDPOINT` no longer silently hijacks
  the reviewer; persist with `gemini-review.mjs set-provider azure-claude`.
- **Arch-index summaries stay on Sonnet** (not Haiku) under Azure — deployment quota,
  not per-token cost, is the binding constraint on the `arch:refresh` batch.

→ **Setup, env-var reference, provider-precedence detail, Foundry-Anthropic API shape,
deployment quotas, rate-limits + throttling, rollback**: [`docs/runbooks/azure-work-profile.md`](docs/runbooks/azure-work-profile.md)
(guide) + [`docs/completed/azure-work-profile.md`](docs/completed/azure-work-profile.md)
(plan/audit). Template: [`defaults/work-profile.env.example`](defaults/work-profile.env.example).

## Cross-Skill Data Loop

Migration `20260419120000_cross_skill_data_loop.sql` closes the feedback loop
between the skills. Every skill writes to a shared learning store via
`scripts/cross-skill.mjs` — graceful no-op when Supabase is off.

### Tables

| Table | Writer | Reader | Purpose |
|-------|--------|--------|---------|
| `plans` | `/plan`, `openai-audit.mjs` | `/audit-plan`, `/audit-code`, `/ux-lock verify` | Register plan artefact, link audit_runs via plan_id |
| `regression_specs` | `/ux-lock`, `/ux-lock verify` | `/ship` | Record every Playwright spec authored (lock or verify mode) |
| `regression_spec_runs` | `/ux-lock`, CI | `meta-assess.mjs` | Per-run pass/fail history — `captured_regression=true` is a "save" |
| `persona_audit_correlations` | `/persona-test` | `bandit.mjs` | The highest-leverage table — persona P0/P1 ↔ audit finding ground-truth labels |
| `ship_events` | `/ship` | Dashboards | Outcome log: shipped / blocked / warned / overridden / aborted |
| `plan_verification_runs` | `/ux-lock verify` | `/ship`, dashboards | One row per verify invocation; totals for satisfaction % |
| `plan_verification_items` | `/ux-lock verify` | `/ship`, meta-assess | Per-criterion pass/fail with stable `criterion_hash` for time-series |
| `nav_audit_runs` | `/nav-audit` (static path) | dashboard drift aging | Run-history for `firstSeenFromHistory` — the >14-day governance smell needed real history, not just a gitignored local cache (`docs/completed/persona-nav-feedback-recovery.md` WS2) |
| `persona_finding_outcomes` | `cross-skill.mjs persona-outcomes label` | `/ship` UX gate, dashboard | Durable REPO-scoped (not session-scoped) fixed/dismissed/wont_fix/stale labels — `dismissed`/`wont_fix` close a finding across sessions; `fixed` that reappears re-flags as a regression (WS4) |

### Added columns

| Column | Table | Writer |
|--------|-------|--------|
| `commit_sha`, `branch`, `plan_id` | `audit_runs` | `openai-audit.mjs` in `runMultiPassCodeAudit` |
| `commit_sha`, `deployment_id` | `persona_test_sessions` | `/persona-test` Phase 6 |
| `click_path` (sanitized jsonb) | `persona_test_sessions` | `/persona-test` Phase 6 → `get-reachability-evidence` → `/nav-audit --bootstrap` seeds `personaIntents` (`source:persona-test-evidence`). URLs are origin-stripped + secret/PII-redacted by `sanitizeStepUrl` before storage. |

### Views

| View | Query for | Used by |
|------|-----------|---------|
| `audit_effectiveness` | User-visible precision + recall per repo | `meta-assess.mjs` (prompt evolution) |
| `unlocked_fixes` | Recent HIGH fixes without a /ux-lock spec | `/ship` Step 0.5b |
| `regression_saves` | Spec runs that caught a real regression | Dashboards |
| `ship_gate_effectiveness` | How often each block reason fires + override rate | Dashboards |
| `plan_satisfaction` | Latest verify run per plan + failing P0/P1 criteria | `/ship`, `/ux-lock verify` report |
| `persistent_plan_failures` | Criteria that have failed ≥2 consecutive runs | Meta-assess (chronic gaps) |

### Bandit reward extension

`computeReward(resolution, evaluationRecord, userImpact)` — when a
`persona_audit_correlations` row exists for a finding, the reward formula
shifts from 40/30/30 (procedural/substantive/deliberation) to
35/25/25/15 with the user-impact term weighted by persona severity. See
`computeUserImpactReward()` in [scripts/bandit.mjs](scripts/bandit.mjs).

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
3. **Post-output suppression** (Layer 3): `suppressReRaises()` fuzzy-matches findings against ledger

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

The architectural-memory feature (`docs/completed/architectural-memory.md`)
indexes every symbol in this repo into Supabase, with embeddings, so we
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

Then act on the recommendation column:

- **`reuse`** (cosine ≥ 0.90) — reuse the existing symbol unless the user explicitly wants a sibling. Note the existing symbol in your reply.
- **`extend`** (0.85–0.90) — strongly prefer extending the existing symbol; document why if you create a new one.
- **`justify-divergence`** (0.75–0.85) — write the new code, but explicitly mention in your reply that you saw the similar candidate and why divergence is the right call.
- **`review`** (<0.75) or empty records — proceed greenfield.

**When NOT to consult**:

- Pure bug fixes that change only an existing function's body (no new symbol introduced).
- Trivial edits: typos, formatting, single-line conditional tweaks.
- Doc-only or test-only changes (unless adding new test helpers).
- When the cloud store is offline (`{"cloud": false}`) — log a hint that `npm run arch:refresh` would enable consultation, then proceed.

**Auto-fired via Claude Code hook**: `.claude/hooks/arch-memory-check.sh`
runs on `UserPromptSubmit` whenever the user's prompt contains an intent
verb (`fix`, `add`, `implement`, `create`, `build`, `write`, `refactor`,
`make`, `wire`, `hook`, `introduce`, `replace`, `extend`). If the
consultation fired, you'll see a `> **Architectural-memory consultation**`
callout prepended to the prompt — treat it as authoritative and follow
the recommendation column. If it didn't fire (e.g., the user asked a
question that turned into a fix mid-conversation), run the command
manually as described above.

**Disable per-session** (rare — debugging the hook, or working on the
hook's own tests): set `ARCH_MEMORY_HOOK_DISABLE=1` in env.

**Cost**: each consultation = 1 Gemini embed (~$0.0003) + 1 Supabase
RPC (~50–200ms). Cached on disk by `(intentDescription, model, dim)`
so repeats within 24h are free.

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

`npm run security:refresh` runs every parsed incident through a hybrid
secret/PII gate ([scripts/lib/security/secret-classifier.mjs](scripts/lib/security/secret-classifier.mjs))
before it touches the DB: high-confidence secret shapes → **REFUSE** (not
indexed; refresh exits non-zero — scrub `docs/security-strategy.md` and
re-run); low-confidence PII → **auto-REDACT** into the stored row itself.
Every write is logged to the append-only `security_strategy_events` audit
trail (governance evidence of what was indexed and kept out); read via
`getSecurityStats`/`getSecurityEvents` in
[scripts/lib/store/security.mjs](scripts/lib/store/security.mjs). One
defence-in-depth invariant: the final-pass redactor is the gentle
`lib/secret-patterns.mjs`, deliberately NOT `sanitizer.mjs` (which
blanket-redacts any 20+ char token and would corrupt incident prose).
Embeddings stay Gemini here (the corporate kit's Azure modules were
intentionally not ported — [docs/plans/security/](docs/plans/security/) has
the full kit + rationale; the dashboard Security tab renders the trail).

---

**Empirical effectiveness test** (run once per repo when deploying, and
after major prompt changes — the recipe is also embedded as comments at
the bottom of `tests/hook-arch-memory-check.test.mjs`):
1. Pick a fix that has known near-duplicates (e.g. for ai-organiser:
   "add a function that watches vault file renames").
2. Two fresh Claude sessions, same prompt:
   - Session A: `ARCH_MEMORY_HOOK_DISABLE=1` (control)
   - Session B: hook enabled (treatment)
3. Record per session: did Claude reuse, mention, or write blind? Token delta.
4. Hook is "effective" if treatment reuses-or-mentions in ≥60% of cases
   vs control's baseline. Run on 5–10 representative prompts.

## Quick-fix detection — two-layer architecture

Plan: `docs/completed/brainstorm-quickfix-v1.md` Feature B.

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
`docs/completed/brainstorm-quickfix-v1.md` §B.

## Requirements Layer — de-facto invariant ledger

Plan: `docs/completed/requirements-layer.md`. A materialized view of the
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

[scripts/lib/sensitive-paths.mjs](scripts/lib/sensitive-paths.mjs) is the
**single source of truth** for sensitive-path classification. Two categories:
`sensitive` (`.env*`, `secrets/`, `credentials*`, certs/keys, `.aws/`, `.ssh/`,
`id_rsa*`, `password.*`, `tokens?.*`) and `generatedNoise` (lockfiles, `.min.js`,
`.map`). The four legacy consumers (`quickfix-patterns.mjs`, `audit-scope.mjs`,
`sensitive-egress-gate.mjs`, `extract.mjs`) all delegate here via
`classifyPath` / `shouldSkipForIndexing` / `filterDiffFiles`. Skip logging
MUST go through `formatSkipLog` — sensitive entries aggregate by default;
`SENSITIVE_PATHS_DEBUG=1` emits `[redacted:<sha256-hex8>].<ext>` (never
basenames, never full paths). The state-aware `filterDiffFiles` rewrites a
modified-to-sensitive entry as `deleted:` so the indexer can tombstone prior
rows; a deletion of a sensitive path is preserved as a tombstone for the
same reason. See `docs/plans/sustainability-cleanup-batch.md` WS3 for the
12-case state matrix.

**Canonical-path layer (WS-CANON)**: `resolveAndClassify(p, {repoRoot})`
sits on top of `classifyPath`. It runs the lexical check first (cheap;
no FS touch); if that's `null` it calls `fs.realpathSync` and
re-classifies the canonical target. A symlink whose visible name is
innocent (`repo/notes.txt`) but whose target resolves into `~/.ssh/id_rsa`
or `secrets/` is now caught. Fail-closed on resolution errors
(`resolutionFailed: true` → `category: 'sensitive'`) and on symlinks
that escape `repoRoot` (`escapedRepo: true` → `category: 'sensitive'`).
`gateSymbolForEgress({…, repoRoot})` opts in; callers without `repoRoot`
get the pre-WS-CANON lexical-only behaviour. `redactSecrets` is fail-
closed too — non-string payloads route through
[`scripts/lib/redact.mjs::redactObject`](scripts/lib/redact.mjs)
(depth/node-capped, ancestor-stack cycle detection) and any failure
returns `[REDACTED:redaction-failed]` rather than leaking the raw
payload. INC-001 in [docs/security-strategy.md](docs/security-strategy.md)
records the symlink-bypass class.

[scripts/lib/vcs.mjs](scripts/lib/vcs.mjs) is the structured VCS contract.
`gitCommitSha` / `gitDiffWithWorkingTree` return `{ok:true, …} | {ok:false,
error:{code,message,cause?}}` with a closed `VcsErrorCode` enum:
`GIT_BINARY_MISSING` (exit 127), `NOT_A_GIT_REPOSITORY` (exit 5),
`BAD_REVISION` (exit 4), `WORKING_TREE_UNREADABLE` (exit 5), `EXEC_FAILED`
(exit 1, the only retryable code — see `RETRYABLE_VCS_ERRORS`). Map via
`vcs.exitCodeFor(code)`. `isSafeGitRevision` is the boolean predicate;
`runJsonLines` (generic JSON-lines subprocess helper) moved to
[scripts/lib/subprocess.mjs](scripts/lib/subprocess.mjs) (WS-LIVE) as
`runJsonLinesAsync` + `runJsonLinesAsyncStrict` — async streaming
restores heartbeat liveness during the symbol-index pipeline. Closed
`SubprocErrorCode` enum: `EXIT_NONZERO` / `SPAWN_FAILED` /
`KILLED_BY_SIGNAL` / `PARSE_FAILED_HARD`. The strict wrapper hard-fails
on parse errors by default (closes the `.filter(Boolean)` silent-data-
loss invariant); pass `opts.maxParseErrors: Infinity` for legacy
tolerant behaviour.

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
