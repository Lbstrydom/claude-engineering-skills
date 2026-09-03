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
>
> **RETAGGING A MODULE CHANGES EVERY EDGE *INTO* IT — re-baseline BOTH
> directions.** Moving a file to another domain changes the `from` domain of
> everything it imports *and* the `to` domain of everything that imports it. The
> second half is the one that gets forgotten, because it is invisible from the
> file you are editing. **Three retags in four days made this exact error**:
> `d5e66d35` (2026-08-10) cleared `shared-lib`'s outbound grant and created four
> inbound violations, its own commit message showing the one-sided check
> (*"adds no new edge: model-eval → audit-orchestration was already declared"* —
> that is what the file IMPORTS, never who imports IT); `a146bb7b` (08-12)
> repeated it, retagging `lib/cross-skill/**` and creating four
> `tests → cross-skill-bridge` violations. Do not verify this by grep — a
> docstring mention reads as an import. Run the mechanical check:
> `tests/arm-vocabulary-layering.test.mjs` re-derives the whole violation set and
> is in `npm test`, so a retag that breaks the inbound half fails at push.
> Detail: [god-module-and-layering-debt.md](docs/plans/god-module-and-layering-debt.md) §1.2.

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

16 skills, run in this order: **plan → audit-plan → *(implement)* → audit-code
→ ux-lock → deploy → the four UI lenses → ship**, with `/cycle` driving the whole
chain and pausing for human implementation. The four lenses are **disjoint** and
run together on a UI PR — click-test (page DOM) ∥ persona-test (journey) ∥
nav-audit (system IA) ∥ visual-audit (paint).

Diagram, one-line scope per skill, and per-skill depth (modes, flags, the design
invariants of each wave and lens) + the naming convention:
[`docs/reference/skill-roster.md`](docs/reference/skill-roster.md) — read it before
renaming a skill or "simplifying" a wave.

**Skill file structure** (Phase B.1+ — progressive disclosure):

```
skills/<name>/                   ← authoritative; edit ONLY here
├── SKILL.md                     ← canonical flow; ≤3K tokens target
├── references/<topic>.md        ← rare/edge content, loaded on demand
└── examples/<sample>.md         ← optional output templates

.claude/skills/<name>/            ← generated copy — run `npm run skills:regenerate`
```

> **Skill surfaces — three invariants.** Discovery-root history, the Copilot-compat
> audit, the retired-tooling table and the migration recipe live in
> [`docs/reference/skill-surface-ownership.md`](docs/reference/skill-surface-ownership.md).
>
> **(1) Never ship the same skill name in two discovered roots.** Copilot discovers
> `.github/skills/`, `.claude/skills/` and `.agents/skills/` plus personal dirs, and
> precedence between them is **undocumented**. The committed `.claude/skills/**` is
> the single Copilot-native surface; `.github/skills/` and the
> `.github/prompts/*.prompt.md` shims are **RETIRED** — never re-introduce a
> generator, and check both retired roots when a consumer's Copilot behaves oddly
> (sync deliberately never deletes them).
>
> **(2) Skills install REPO-SCOPED, never machine-global.** A SKILL.md is only valid
> alongside the runner layout it cites (`scripts/X.mjs` here,
> `scripts/.claude-skills/X.mjs` in a consumer), so **no correct content exists** for
> the layout-agnostic `~/.claude/skills/`. It and `.agents/skills/` are retired
> (`resolveSkillTargets` throws) and `.githooks/post-merge` is **deleted** — don't
> restore it. Installing is one command:
> `npx github:Lbstrydom/claude-engineering-skills <dir>`, or
> `npm run sync -- --target-path <dir>`. Proposing a new surface? Answer first:
> *which layout does its content belong to, and what stops it colliding with
> `.claude/skills/`?*
>
> **(3) Frontmatter is a contract** (enforced by `skills:check`): `name` must equal the
> directory name and match `^[a-z0-9-]{1,64}$` (violation = **silent skip**);
> `description` is required, **max 1024 chars** (keep trigger phrases there, move
> Usage syntax into the body); no two skills may advertise the same **literal**
> trigger phrase; and every optional known key (`disable-model-invocation`,
> `allowed-tools`, `license`, `model`, `argument-hint`, `user-invocable`) must sit
> at **column 0** — indented under `description: |` it is description TEXT, parsed,
> valid and **inert** (a consumer's `/audit` declared it must not be self-invoked
> while staying model-invocable, measured 2026-09-03; nothing errors, it just stops
> applying). `check-skill-frontmatter.mjs` cross-checks a lexical scan against a
> real YAML parse; the same lib refuses the sync and runs consumer-side as
> `sync-isolation-verify` gate 9. Semantic overlap has no oracle — declare the discriminator in BOTH
> descriptions (*topic* → `/explain --history`, *claim* → `/investigate`). Copilot also
> reads `CLAUDE.md` + `AGENTS.md`; this repo ships **no** `.github/copilot-instructions.md`
> — a third surface to keep in sync, owning nothing. Absence enforced. VS Code reads
> `.vscode/mcp.json`, **NOT** `.mcp.json` — keep the two mirrored when adding servers.

Every reference file has `summary:` YAML frontmatter that must byte-match the
parent SKILL.md's reference-index row. `npm run skills:check` enforces this — see
`docs/reference/skill-reference-format.md`. A skill MAY also carry a colocated
`gate-contract.json` binding a stated gate to its enforcing code+test (never
packaged/synced; no contract = `uncontracted`, not failed) — `npm run
skills:check`/`gates:check` validate it; details: `docs/reference/gate-honesty.md`.

Each skill is a sibling — they share env vars and the cloud audit store but have
distinct scopes.

**Four imperatives the roster is too late to tell you.** **(1)** A new mechanical
wave must be declared in `MECHANICAL_WAVES` ([audit-shadow.mjs](scripts/lib/audit-shadow.mjs)),
or `PASS_PROMPTS` silently enrols it in the model-A/B/C shadow's **paid** comparison.
**(2)** `classifySelector` ([selector-policy.mjs](scripts/lib/ux-lock/selector-policy.mjs))
is ux-lock's **single** policy oracle — never add a second classifier.
**(3)** persona-consistency's `expectedContradictions.max` is loosenable — treat
raising it like deleting a test. **(4)** visual-audit's scope firewall: *include a
check only if you can assert it on a computed style without knowing what the page
is FOR* — signifiers in, affordance judgments out (those are persona-test's).

## Consumer-repo layout (isolation)

This source repo's tooling deploys to consumer repos under
**`scripts/.claude-skills/`** rather than the consumer's natural
`scripts/` directory. The directory is gitignored on the consumer
side via a managed block in their root `.gitignore`. The directory
isn't tracked — fresh clones of a consumer repo need to re-run
`npm run sync -- --target <name>` from THIS repo to hydrate it. (The `--` is
load-bearing: without it npm swallows `--target` and the sync writes into EVERY
consumer instead of the named one. Verified 2026-07-20.)

> **Upstream-owned — never patch the synced copy (governance).** A failure in a
> consumer's `scripts/.claude-skills/**` file is an **UPSTREAM** bug: fix it HERE
> + re-sync. The local edit is gitignored (invisible to review), overwritten next
> sync, and leaves the bug live for every other consumer — the band-aid at the
> consumer/upstream seam. Each synced file carries a banner saying so
> (`sync-banner.mjs`); drift backstops and the `.githooks/pre-push.local` recipe
> for repo-specific push gates (never the managed hook):
> [consumer-adoption.md](docs/runbooks/consumer-adoption.md).
>
> **Consumers are not all on ONE store.** A consumer files into whatever store ITS
> `AUDIT_DB_URL` names — not this repo's — so a single-store read is blind to a
> consumer and renders that blindness as good news (`/ship` printed `0 open`
> against 8). Fan out with `npm run upstream:queues`, deduped by
> `storeFingerprint`. **An unasked question must never render as an empty result**,
> and a store is named to operators by **fingerprint + the consumers using it**,
> never a hostname — this repo is public and one consumer's store is corporate.
>
> **File the report, don't paste it.** Consumer: `cross-skill.mjs upstream report
> --affected-path <synced path>`; here: `npm run upstream:issues` →
> `ack|fix|wont-fix|annotate|history`. **Every body and `--note` goes on stdin** —
> a backtick in an argv note runs as command substitution and silently elides text
> the append-only log cannot repair; `annotate` is the only legal repair, never a
> second `fixed`. Recipe + closure flags:
> [consumer-adoption.md](docs/runbooks/consumer-adoption.md) §Reporting an upstream bug.

> **Five shapes consumers keep reporting — check for them when adding a gate or
> nudge.** Write-ups, predicates and measured inert windows:
> [consumer-adoption.md](docs/runbooks/consumer-adoption.md) §Five shapes.
> *(1)* A read handing back a key its writer rejects — a new close-this-row nudge
> means a new row in [`view-writer-key-contract.test.mjs`](tests/view-writer-key-contract.test.mjs).
> *(2)* A gate judging files the repo does not own — the predicate is **ignored AND
> untracked**, asked of the **candidates**, never of the repo.
> *(3)* A check verifying one direction only — of any set comparison ask: **which
> side am I iterating, and what is unrepresentable from it?**
> *(4)* A documented command whose tooling cannot be present where it runs — **only
> tracked content reaches a linked worktree**, so a remedy must ride on
> `package.json`. Gate: `npm run worktree:preflight:gate`.
> *(5)* A synced SKILL.md naming an `npm run` alias or an out-of-closure `docs/`
> file — claims about another repo that nothing can make true (`--if-present`
> **exits 0 having run nothing**). **Name synced tooling by path**:
> `node scripts/<name>.mjs`. Gate: `npm run skills:consumer-refs:gate`, a ratchet.

> **Upstream bug, but you're blocked?** Patching upstream-owned *source* stays
> forbidden; a **runtime/env/DB** unblock is OK if you report it, label it
> `TEMP — pending upstream fix`, and reconcile when the fix lands. Recipe +
> the divergence it prevents: [consumer-adoption.md](docs/runbooks/consumer-adoption.md)
> §"Blocked on an upstream bug".

> **Consumer divergence is DECLARED, never inferred — and the sync must never
> revert it silently.** **(1)** The manifest hash is the three-way BASE —
> `disk === base` ⇒ overwrite freely, `disk !== base` is consumer content:
> **tracked ⇒ REFUSE + fail** (`--overwrite-diverged` consents), untracked ⇒
> overwrite loudly. Basing it on the manifest and not HEAD is what stops it firing
> on ordinary updates. **(2)** Standing divergence is declared in the committed
> `.sync-overrides.json` — `reason` required, malformed ⇒ ABORT (never
> fail-open), and `scripts/.claude-skills/**` may never be claimed (that is an
> upstream report). **(3)** Every sync writes the committed `.sync-receipt.json`,
> a deliberate generated-artifact-policy exception: its dirtiness is the only
> evidence a sync ran — and **append-only** (newest-first list), because the
> sync never commits and a second one used to erase the first.
> Adding a co-owned config? A merge may never move a launcher
> from a pinned path to an unpinned fetch — `sync-pin-guard.mjs`, guard **plus**
> an independent post-condition.
> [Plan](docs/plans/consumer-sync-durability.md).

### Sync mechanics — pointer

Sync-behavior detail (the isolated subdir, the what-goes-where table, the
managed-gitignore block + untrack semantics, the `sync-*` module list):
[`consumer-adoption.md`](docs/runbooks/consumer-adoption.md) §"Sync internals".
One structural invariant stays here: **the sync layout's single source of truth is
[`sync-path-map.mjs`](scripts/lib/sync-path-map.mjs)** — never hand-compute a
consumer path.

**A consumer's package manager is [`package-manager.mjs`](scripts/lib/package-manager.mjs)'s
answer, never a hardcoded `npm`/`npx`** — the managers are not swappable, so two
lockfiles + no `packageManager` field is **ambiguous and left alone**, never guessed.
Adjudicate an install by RE-PROBING `node_modules`, never the exit code (pnpm exits
non-zero on `ERR_PNPM_IGNORED_BUILDS` after a successful install). Why it matters,
and the corepack/`.cmd` trap: [consumer-adoption.md](docs/runbooks/consumer-adoption.md)
§Your package manager.

### CLI smoke contract (`--selfcheck-relocation`)

Every top-level CLI script that needs to prove its imports survive relocation implements:

```js
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
```

at the head of `main()`. Today: `check-setup.mjs`, `doctor.mjs`, `cross-skill.mjs`, plus others in `CLI_SMOKE_SET`. Library modules (no `main()`) get an import-test in [`tests/relocation-guard.test.mjs`](tests/relocation-guard.test.mjs); the CI guard fails if a `CLI_SMOKE_SET` script lacks the handler.

### Adopting these skills in a new consumer repo

See [`docs/runbooks/consumer-adoption.md`](docs/runbooks/consumer-adoption.md) §Diagnostics for the migration recipe and `doctor` — one command over every adoption-friction class, ratcheted by `npm run upstream:coverage:gate`.

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

- **Interactive (during plan generation)** — `.mcp.json` registers `mcp-mermaid`. Claude Code prompts to enable on first open (same flow as Playwright MCP). VS Code registers the same server from `.vscode/mcp.json`. The tool is **`mcp__mermaid__generate_mermaid_diagram`** (server name `mermaid` ⇒ that prefix); call it with `outputType: "mermaid"` to validate without rendering — invalid syntax returns an MCP error with the parser's line/column. No API key needed. It complements `plans:lint`, which catches renderer-strictness bugs the parser accepts (measured: the MCP passes `SG1 -.- B`). This bullet said `mcp__claude_ai_Mermaid_*` until 2026-09-02 — a server this repo never registered, so `/plan`'s validation step had never run.
- **Pre-push (static lint)** — `npm run plans:lint` scans `docs/plans/*.md` for two classes of bugs that GitHub renders leniently but VS Code preview / stricter renderers reject:
  - **ERROR `subgraph-as-edge-endpoint`** — using a `subgraph` ID as an edge endpoint (`SG1 -.- other`). Mermaid graph syntax doesn't allow this; anchor the edge to a node *inside* the subgraph.
  - **WARN `unquoted-special-chars-in-label`** — node label brackets containing `<br/>` or non-ASCII chars (em-dash, etc.) without surrounding quotes. The bracketed-but-unquoted form parses in current Mermaid but breaks in older bundled versions. Always use `ID["..."]` when the label has special chars.

Runs as part of `npm run check` (the pre-push hook). ERRORs block; WARNs are advisory. Why narrow rule coverage: the full Mermaid parser is in the 76MB `mermaid` package, too heavy for one lint. `@mermaid-js/parser` (lightweight alternative) doesn't yet handle flowchart/graph — we'll switch when it does. Until then, this regex linter + the MCP cover the gap.

---

## Dependencies (CRITICAL — check versions before flagging issues)

| Package | Version | Notes |
|---------|---------|-------|
| `zod` | **4.5.2** | Zod 4 API — NOT Zod 3. `_def.type` is a string (`'object'`, `'array'`, `'enum'`), NOT `_def.typeName` (`'ZodObject'`). `shape` is a direct property on object schemas, NOT `_def.shape()`. `_def.entries` for enums, NOT `_def.values`. |
| `openai` | **7.8.0** | v7 since 2026-08-09; `responses.parse()` + `zodTextFormat()` unchanged and live-verified on the bump to 7.8.0 + zod 4.5.2 (2026-09-03) |
| `@google/genai` | ^2.19.0 | Google Generative AI SDK. Uses `responseMimeType: 'application/json'` + `responseSchema` for structured output |
| `dotenv` | 17.4.2 | Load via `lib/load-env.mjs`, never `dotenv/config` (cwd-only) |

## Architecture

**Do not hand-maintain a module tree here** — [`docs/architecture-map.md`](docs/architecture-map.md)
is the live, generated per-symbol index (see the bootstrap note at the top of this
file); an inline tree goes stale silently (the one removed 2026-07-13 listed
2 test files against 100+ real). Layout in one line: `scripts/*.mjs` are CLI
entry points; `scripts/lib/**` are focused modules (split from the former
`shared.mjs` monolith, which remains as a backwards-compatible barrel); `tests/` is
the Node built-in test-runner suite; `.claude/skills/**` is generated from `skills/**`.

### Script responsibilities + key patterns — pointer

Per-module prose (openai-audit, gemini-review, the learning-store barrel) and the
named patterns (adaptive sizing, semantic dedup, atomic persistence, the closed
Gemini loop, …) live in
[`docs/reference/audit-internals.md`](docs/reference/audit-internals.md).
Condensed out 2026-07-20 having already rotted — exactly what the rule above
prevents.

### Testing

Run: `npm test` (Node.js built-in test runner — the suite under `tests/`).

#### Pre-push runs against a clean checkout, not the working tree

The hook runs `check` in a throwaway worktree at the **commit being pushed**
([`prepush-check.mjs`](scripts/prepush-check.mjs)). Two sessions share one tree
here, so tree-checking gave false blocks (a cried-wolf gate gets `--no-verify`'d)
and false passes (a fix in the tree but not the commit read green). Not `git
stash` — that yanks the other session's files mid-edit. Detail + escape hatches:
[`docs/runbooks/prepush-sandbox.md`](docs/runbooks/prepush-sandbox.md).

#### A spend-bearing run PINS its revision — it never shares the working tree

Same tree, higher stakes: the store refuses a snapshot whose arms disagree, so
two died on 2026-08-17 (~$13) — one to a rebase, one to a **concurrent session's
commit**. Run ANY revision-stamped, spend-bearing job (arm-eval, solo-control,
model-eval, replays) via `npm run fixture:create`: detached at an explicit sha,
`node_modules` linked, **every arm's credential verified before spend**. Two
traps it does not remove: gitignored inputs are ABSENT (transcripts by absolute
path), and **trust the store, not the fixture's local bake-off log**, which reads
near-zero and looks like lost progress.
[Runbook](docs/runbooks/pinned-revision-fixture.md)

- **A DB suite no runner names has never run.** Without a disposable DSN it skips
  itself, and node reports a never-run suite as a clean pass — so enrolment in
  `db-test-container.mjs`'s `*_SUITE_FILES` (**and**, in lockstep,
  `postgres-parity.yml`) is the only thing that makes it coverage. A 2026-08-11
  census found **15 enrolled nowhere**; six failed the moment they ran.
  `npm run db:enrolment:gate` iterates the FILESYSTEM — the only side that can see
  a file no list mentions. **Adding a DB-gated suite is two edits, never one.**
- **Sandbox-honesty rule.** A fresh worktree has no gitignored inputs, so a check
  that *skips* on a missing input passes having read nothing (known skips are
  forced hard: `AUDIT_PUSH_RANGE_REQUIRED`, `ARCH_COVERAGE_REQUIRE_ENVELOPE`).
  **Adding a check? Ask whether it can go green in a clean checkout having
  checked nothing — if so it needs a strictness flag, not a tolerated skip.** A
  sandbox setup failure is a push failure, never a pass.
- **`npm test` refuses a green it did not earn.** Node can report a suite as
  `not ok` and still exit 0 — `dd83e1f8` shipped `# fail 0` with three suites that
  never ran. `adjudicateRun` ([run-tests.mjs](scripts/run-tests.mjs)) fails the run
  on any non-todo `test:fail` alongside exit 0, keyed on the **consequence** rather
  than the cause, and fails **closed** when its own report is missing.
  [prepush-sandbox.md](docs/runbooks/prepush-sandbox.md) §2.3.
- **One range, one resolver** — [`push-range.mjs`](scripts/lib/push-range.mjs).
  Gates must not re-infer a base from working-tree state (`@{u}`, dirty→`HEAD~1`):
  that scoped multi-commit pushes to their tip and collapsed to `HEAD~1` always
  in a detached tree. An unresolvable explicit base fails hard, never demotes to
  inference.
- **Hashing working-tree bytes ≠ hashing committed source.** A generator hashing
  files for a *committed* artifact must canonicalise CRLF→LF, with
  `canonicalizeEol` from [`lib/file-io.mjs`](scripts/lib/file-io.mjs) — the one
  byte-level fold. The tell: **git says clean and your tool says changed; git is
  right.** Do NOT canonicalise where the exact bytes ARE the contract
  (transfer-corruption checks). That, and the worktree-`node_modules` rule (never
  hard-code `<repoRoot>/node_modules`, never hand-link one in):
  [prepush-sandbox.md](docs/runbooks/prepush-sandbox.md) §2.1–2.2.
- **An mtime freshness oracle is usually wrong in the HEALTHY case, not merely
  lossy** — the writer's own ordering decides it, and `lock newer than
  node_modules/` was the normal post-install state. Before writing one, ask **who
  writes these two paths, in what order**; then use the tool's own content record
  instead — npm keeps `node_modules/.package-lock.json`. Compare CONTENT, never
  key counts (455 declared vs 410 installed here; every absentee `optional`).
  [prepush-sandbox.md](docs/runbooks/prepush-sandbox.md) §4.

#### Testing doctrine — pointer

Three tiers, because blanket TDD is theatre at the LLM boundary but rigor pays at
deterministic seams: **Tier 1** test-first for deterministic modules; **Tier 2**
invariants + canned fixtures for LLM-orchestration seams — never assertions on
model prose, never a whole-provider mock (that tests the mock); **Tier 3
(non-negotiable)** two seams where a change lands with its test in the **same
commit** — *(a)* **sensitive-path egress** (a leak ships credentials to a
third-party LLM) and *(b)* the **consumer sync / relocation contract** (a break
ships silently to repos you cannot observe). Tier list, guarding tests and the
deliberate deferrals: [`docs/reference/testing-doctrine.md`](docs/reference/testing-doctrine.md).

#### Pre-ship empirical verify — for skills that assert on a live runtime

Static review cannot catch what only appears when a real browser renders real
data — a mid-theme-transition `getComputedStyle` read once *fabricated* a bug
that survived four review passes. **(1)** Any skill driving a browser must run
against ONE real app before being called done, and a field finding with a green
repro routes to a regression test + ONE focused review, never the adjudication
loop. **(2)** Two capture bug classes by name: mid-state-change capture (freeze
transitions AFTER the flip + `await document.fonts.ready`), and empty/failed
capture, which must degrade to `unverified`, never "verified / 0 findings".
**(3)** **Audit your success paths** — ask of any green-emitting branch *"can this
return green without having checked anything?"*
→ [`docs/runbooks/pre-ship-empirical-verify.md`](docs/runbooks/pre-ship-empirical-verify.md).

## Model Resolution

`scripts/lib/model-resolver.mjs` resolves model IDs so config stops going stale
when providers ship new versions. All model-reading env vars in config.mjs pass
through `resolveModel()`.

**Sentinels** (preferred in `.env`) — `latest-gpt`, `latest-gpt-mini`,
`latest-opus`, `latest-sonnet`, `latest-haiku`, and Google's authoritative
aliases `latest-pro` / `latest-flash` / `latest-flash-lite`. A sentinel picks
the newest tier match from live-catalog ∪ `STATIC_POOL`; a stale concrete id is
remapped to one with a one-time warning; concrete ids pass through. The heavy
entry points refresh the catalog and re-resolve, so new provider models are
picked up with no `STATIC_POOL` edit (`MODEL_CATALOG_REFRESH=skip` opts out for
air-gapped CI; a network failure falls back silently). Per-sentinel table,
resolution order and static-pool maintenance:
[`model-resolution.md`](docs/reference/model-resolution.md). Self-check:
`node scripts/lib/model-resolver.mjs resolve | catalog`.

**Anti-patterns (load-bearing):**
- Do NOT pin concrete model IDs in new code — use a sentinel (`latest-*`).
- Do NOT drop `-preview` from Gemini 3 IDs unverified — bare `gemini-3-flash` /
  `gemini-3.1-pro` never shipped (Google 404s). Verify via the `…/v1beta/models` list.
- Do NOT retry 404 — `classifyLlmError` treats any 4xx (except 429) as non-retryable.
- When rewrapping an LLM error, surface `err.status` + the real provider
  `error.message` — don't collapse to `"API error ${status}"` (it names the bad model).
- **OpenRouter**: one model id → many backends w/ incompatible ctx limits, picked per request; and reasoning tokens count against `max_tokens`. Unpinned runs fail at random, reading as model flakiness — always send `provider:{require_parameters,sort}` + `reasoning:{effort}`. [experiment-4](docs/research/experiment-4-cheap-final-reviewer-smoke.md)
- **A model id carries its ROUTE, and the two are never reconciled.** Some models
  are reached BOTH natively and via OpenRouter (`qwen3.8-max` vs `qwen/qwen3.8-max`);
  `transportForModel` dispatches on exactly that shape and the routes bill
  differently, so **never "normalise" `source_model`** — it erases the routing
  decision and corrupts costing. What must NOT vary by route is the vendor
  **family**: call `modelFamily`, never a local head-of-string helper. Reading the
  vendor off whichever half of the id was present is how a model grading its own
  output got recorded as unbiased (`self_family`, fixed 2026-08-23). A new vendor
  needs `VENDOR_ALIASES` too — `npm test` fails until it has it.

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
| Cluster density | Median per-repo count of open finding pairs that are **semantic same-file cross-run re-raises** (cosine > 0.85). Reports embedding **coverage** — a low-coverage reading is `unknown`, never green — and excludes control-state markers | `>= 5` |
| Recurrence rate | Fixed findings that reappear in same repo within 30 days under a new fingerprint | `> 10%` |

Runtime is the `memory_health_metrics(window_days)` Postgres RPC added by
`supabase/migrations/20260421163525_memory_health.sql` (uses `pg_trgm`).

**Decision rule**: 0 triggers for 4 weeks → current design is fine. 1 trigger
for 2 consecutive weeks → prototype pgvector similarity. 2+ triggers → build
the full clustering pipeline. Auto-scheduled weekly by
`.github/workflows/memory-health.yml`; locally `npm run memory:health`.

Three obligations stay resident; the incidents, query mechanics and thresholds are
in [`docs/reference/memory-health-gate.md`](docs/reference/memory-health-gate.md):

- **Metrics 1 and 3 are SAMPLED, not exhaustive** — `fuzzy_reraise.rate` /
  `recurrence.rate` are estimates over the N most recent per repo; read
  `new_fingerprints_total` / `fixed_findings_total` / `per_repo_cap` beside them.
  When capping, **cap the driving set, NEVER the searched set** — the latter drops
  real matches and biases the rate down into a false GREEN.
- **Add a `control_marker_prefixes` sentinel when a new wave starts emitting
  control state**, or the gate reads AMBER forever on its own logging:
  machine-generated notices are byte-identical, so they pair at similarity 1.00
  (44% of the raw signal on 2026-07-20). Matched on the detail-snapshot **prefix**,
  never the category — a wave emits both control state and real findings.
- **Bound an RPC at the CALLER** — `SET statement_timeout` inside a function is
  decorative, and `CREATE OR REPLACE FUNCTION` resets `proconfig` **and** the ACL,
  silently reverting a `search_path` pin + EXECUTE revoke. Both traps, and how to
  verify them from `pg_proc` rather than by review, are in the reference above.

> **pgvector promoted (2026-07-21):** semantic cosine catches reworded re-raises that
> trigram under-counts. Record-time hook in `recordFindings`, **default-ON**, fail-open,
> kill switch `AUDIT_SEMANTIC_SUPPRESS_ENABLED=false`. Dedups the store row, NEVER the
> audit report.

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

**Full table** (every variable, default and purpose):
[`docs/reference/environment-variables.md`](docs/reference/environment-variables.md).
Azure work-profile vars: [`azure-work-profile.md`](docs/runbooks/azure-work-profile.md).
The rows below are the ones whose semantics constrain how you write code:

| Variable | Default | Load-bearing because |
|----------|---------|----------------------|
| `OPENAI_API_KEY` | — | The one **required** variable. Everything else degrades gracefully. |
| `AUDIT_DB_URL` | — | Postgres DSN for the store. Unset → **local-only mode**, not an error (#16 graceful degradation). Supabase: **Session pooler (5432)**, never the Transaction pooler. |
| `LEARNING_DISABLE` | — | `1` kills **all** adaptive-learning behaviour + telemetry in one variable. |
| `LEARNING_REPO_NAME` | — | Must be the **`owner/repo` slug** (matches `audit_repos.name`) — a bare repo name silently misses the lookup, which is how weekly-review sat broken for weeks in every consumer. `install.mjs`/`setup.mjs` derive it; don't hand-type it. |
| `GEMINI_REVIEW_TIMEOUT_MS` | `270000` | **COUPLED** to `FINAL_REVIEW_HARD_DEADLINE_MS`: the watchdog floor is `2×timeout + 60000`, so 270s is the most the default admits — raise both together. |
| `AUDIT_AUTHOR_TIER_HINT` | — | **Observation-only** — it records an author-model tier and must never route. |
| ~~`SUPABASE_AUDIT_*`~~ | — | **Sunset in M4.** The runtime DSN's password IS the secret — there is no separate write-role key. |

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
- **jsonb-safe write seam — do NOT hand-`JSON.stringify` a jsonb column.** The
  db-layer write builders (`serializeWriteParam`) auto-serialize a plain array
  bound to ANY column on the write path, because node-postgres binds one as a
  Postgres ARRAY literal that jsonb rejects (`22P02`) or silently stores as `{}`.
  **Pass jsonb values raw**; a real `text[]`/`int[]` column opts OUT with
  **`pgArray(value)`**. The asymmetry is the thing to remember: a jsonb writer
  that forgets is safe, a `text[]` writer that forgets fails LOUDLY.
  [postgres-parity.md](docs/runbooks/postgres-parity.md) §jsonb write seam.
- **Migrations stay schema-portable**: `parity:check-coupling` fails on any `<schema>.`
  qualification or non-core reference outside the recorded baseline.
- **Every audit-store write in `legacy-production-audit.mjs`'s cloud block goes
  through `durableWrite`** ([durable-write.mjs](scripts/lib/durable-write.mjs)),
  registered in [audit-store-writers.mjs](scripts/lib/audit-store-writers.mjs) —
  which is the registry's ONLY bootstrap, so both the orchestrator and
  `cross-skill.mjs write-spill` must import it. Four outcomes, and they are not
  interchangeable: `written` · `spilled` (queued, replayed by a later drain) ·
  `lost` (evidence kept, never replayed) · `skipped` (the store declined — cloud
  off is a supported mode, not a failure). `lost` **or** `spilled` makes a run
  `incomplete`. Spill-eligibility requires a declared `rowKey` backed by a real
  DB constraint — a logical key is not an `ON CONFLICT` target (a PARTIAL unique
  index answers `42P10`). `npm test` derives the writer set from **every module
  under `scripts/lib/store/**`** over the verb set
  `record|sync|upsert|save|persist|write|delete|retire|mark`, so a new
  write-shaped export must be registered or exempted **with a reason** — before
  2026-08-12 it named two modules and a writer in a third was *unrepresentable*,
  not merely unlisted.
  Plan: [audit-store-write-durability.md](docs/plans/audit-store-write-durability.md).
- **`emit({ok:false})` sets a non-zero exit code** ([cli-io.mjs](scripts/lib/cli-io.mjs)).
  Without the coupling a CLI reports a failure in its envelope and exits 0, which
  every caller checking `$?` reads as success. Opt out only with
  `emit(env, {softFail:true, reason})` — the reason is **required** — and
  `npm run emit:exit:gate` ratchets the opt-out population, failing on growth AND
  on an unrecorded reduction.
  Design: [cross-skill-command-registry.md](docs/plans/cross-skill-command-registry.md) §2b F4.
- **"Disposable" is an ALLOWLIST of loopback hosts, and it fails CLOSED.**
  `isDisposableDbHost` / `assertDisposableDbUrl` (`scripts/lib/db/client.mjs`)
  guard the suites that `DROP SCHEMA public CASCADE` and the schema fixture.
  **Never re-express this as "not $VENDOR"** — the denylist it replaced went
  inert the day the store moved, and a denylist is only as current as the last
  infra change. Same reason production identity is compared as host+port+database,
  never as a DSN string. No env escape hatch, deliberately, and **regenerate the
  fixture only from a fresh replay** (`npm run db:local:regen`).
  [postgres-parity.md](docs/runbooks/postgres-parity.md) §Incident + §Correction.

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

Opt-in, observation-only 2nd final reviewer, run blind. **Committed default unset;
paused locally 2026-08-14 on cost** — an unscoped envelope made a shadow run cost
multiples of the primary Gemini review it exists to sanity-check.
`FINAL_REVIEW_SHADOW=claude-opus|gemini|openrouter|xai` (a gateway needs an explicit
`FINAL_REVIEW_SHADOW_MODEL`; xai is a native provider, own base URL/credential pair,
not a gateway; unset ⇒ not entered, byte-identical; no-op under Azure; never gates).

**Envelope scope.** `FINAL_REVIEW_SHADOW_SCOPE=full|thin|gap`; **`thin` is the
intended default going forward** — the shadow's job is a targeted gap-check, not a
second full audit. `gap` is **campaign-ineligible**, a manifest binds a cohort to
ONE scope, and an active campaign refuses `gap` or an invalid value **before any
provider call**. Semantics + budget cap:
[`environment-variables.md`](docs/reference/environment-variables.md) §Shadow final review.
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

→ Measurement how-to + attribution schema: the plan linked above. **Before building a bigger instrument**, read [`final-review-shadow-bakeoff.md`](docs/plans/final-review-shadow-bakeoff.md)'s PARKED banner (right-sizing) + [`final-review-credit-and-cheap-shadow.md`](docs/plans/final-review-credit-and-cheap-shadow.md) §1.2 (cheap-gateway evidence).

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

→ Everything enumerated above:
[`docs/plans/tiered-recall-audit-pipeline.md`](docs/plans/tiered-recall-audit-pipeline.md).

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
  defect per entry while real models find OTHER genuine bugs in the same diff, so
  **low recall is not a quality signal** — read the raw per-case output first and
  treat recall as a floor; FP-rate + cost decide. Tier C never substitutes for a
  Tier A/B comparative result.
- **Egress-gate prose/diff false positives: fixed 2026-07-12** — historical recall
  is the contract; don't re-add trailing-punctuation stripping (tried, reverted:
  it re-blocked valid entries).
- **Verdict of record (2026-07-13): GLM-5.2 vs GPT-5.6 → `keep` GPT-5.6** (real
  Tier A, $1.87; FP-rate drove it, the recall column being untrustworthy above).
- **A model swap is SYNCHRONOUS, never a background window**: run it when the model
  ships, adjudicate in the same sitting, verdict → `docs/research/`. Passive
  collection killed arm-eval and produced five false "window met" reads. Only
  intervention-over-organic-work earns a shadow; exactly two are open
  (tiered-pipeline, final-review 2nd gate). **Do not add a sixth collector.**
- **Evidence counts only if produced under the contract the stopping rule
  validates**: stamp `contractEpoch` **at the collector** and verify by match.
  Unstamped ⇒ ineligible, never "assume current"; bump on a meaning-changing fix
  and re-collect — **never backfill by date**, the relabelling that let the fifth
  false green through.

→ **Operational reference**: [`docs/runbooks/model-eval-harness.md`](docs/runbooks/model-eval-harness.md) · **Design + prior-art trace**: [`docs/plans/model-swap-eval-harness.md`](docs/plans/model-swap-eval-harness.md) · **First real verdict write-up**: [`docs/research/experiment-3-model-swap-glm-vs-gpt.md`](docs/research/experiment-3-model-swap-glm-vs-gpt.md).

## Local Weekly Maintenance Checks (opt-in)

Optional, default-OFF local replica of the 5 weekly GH Actions maintenance
workflows, for orgs that block Actions runners. Opportunistic — triggered
from the pre-push hook when overdue, **not** an OS scheduler (avoids the
wrong-PATH/cwd/asleep-at-trigger failure class). Enable via `setup.mjs` Step 4
or `AUDIT_LOOP_WEEKLY_MAINTENANCE=1`. Detail: [`docs/runbooks/local-maintenance-checks.md`](docs/runbooks/local-maintenance-checks.md).

**Sibling tool**: `npm run runner:doctor` tests self-hosted-runner viability;
`local`/`remove` inventory + guide teardown of runners on THIS machine (health
from GitHub, never the local service manager). Detail: [`docs/runbooks/actions-runner-doctor.md`](docs/runbooks/actions-runner-doctor.md).

## Azure AI Foundry Work Profile

**What it is**: running the **same** bundle in a corporate Azure environment
(restricted models) without drifting from the public-profile repo — env-selected
role swaps, GPT auditor → Azure OpenAI, final reviewer → Opus on Foundry
(replacing Gemini), embeddings → `text-embedding-3-large` (`dimensions: 768`).
**When you need the dossier**: standing a tenant up, choosing an
`AZURE_CLAUDE_ROUTE`, debugging a 401/404/429, or reading the env-var,
final-reviewer-precedence, deployment-quota or throttling tables.
**Pointer**: [`docs/runbooks/azure-work-profile.md`](docs/runbooks/azure-work-profile.md)
(guide) + [`docs/plans/azure-work-profile.md`](docs/plans/azure-work-profile.md)
(plan/audit trail); template
[`defaults/work-profile.env.example`](defaults/work-profile.env.example).

> **Opt-in invariant (load-bearing).** The Azure path activates **only** when
> `AZURE_OPENAI_ENDPOINT` is set. With no Azure env vars, client construction and
> resolved models are **byte-identical** to the public path (regression-guarded
> by `tests/openai-client.test.mjs`). It never touches your personal setup.

**Seam** (mirrors `anthropic-client.mjs`): [`openai-client.mjs`](scripts/lib/openai-client.mjs)
`createOpenAIClient({purpose})` + [`embed-text.mjs`](scripts/lib/embed-text.mjs)
`embedText()` route to Azure or public **by env presence**; `azureConfig` in
[config.mjs](scripts/lib/config.mjs).

**Four invariants that constrain any code reaching a provider** (the mechanics,
incidents and opt-out lists are in the guide):

- **An availability gate must ask whether a ROUTE exists, not whether a public env
  var is set** (four instances so far). An `if (!process.env.OPENAI_API_KEY)` guard
  upstream of an Azure-aware seam makes the Azure branch unreachable — dead code on
  exactly the installs it was written for, and the tell is a **failure with zero
  latency**: nothing was called. **Grep the whole path a call site takes for the
  public key name**, let ONE oracle answer
  (`lib/brainstorm/provider-availability.mjs`), and use **`isClaudeAvailable()`,
  never `ANTHROPIC_API_KEY`**. An **omitted `azureRoute` ADOPTS the tenant's
  route**; pass `azureRoute: null` only where an id *means* the public service.
  Tests spawning such a CLI must scrub `AZURE_*`, or they pass — or spend — by
  whose machine they run on. A profile-dependent DEFAULT is the other half: which
  voices /brainstorm runs is `defaultProviders()`, never a constant.
- **The deployment is CONSTRUCTOR-level route state, not a body field** (2026-08-12).
  Build `AzureOpenAI({endpoint, deployment, apiVersion})` and let the SDK derive
  `/openai/deployments/{deployment}/…` — **never concatenate an operation path**,
  and never share one client across purposes (the cache key carries purpose +
  deployment). Probing *candidate* deployments needs a client per candidate.
- **An endpoint and the credential it is addressed with are ONE unit.**
  `azureConfig.claudeRoute` resolves them together; pass it as
  `createAnthropicClient({azureRoute})`, **never a bare `baseURL`**. Generalise:
  *if a change can make one host receive another's credential, the two were
  resolved apart and must not be.* Assert on the **emitted request**, not the
  client config ([azure-claude-route.test.mjs](tests/azure-claude-route.test.mjs))
  — the SDK binds transport at construction, so a post-hoc `globalThis.fetch`
  patch observes nothing and the request escapes to the network.
- **A deployment or resource switch is a DIFFERENT vector space.** Provenance is the
  single endpoint-qualified `resolveEmbedProfile()` identity, and `arch:refresh`
  auto-promotes to a full re-embed so two spaces can't mix. An unset
  `AZURE_OPENAI_EMBED_DEPLOYMENT` falls back to a guess that may 400 —
  `npm run azure:doctor -- --fix` probes and locks the real name in.

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
3. **Post-output suppression** (Layer 3): `suppressReRaises()` against the ledger, then the cloud FP-pattern policy — called **unconditionally** (a no-ledger run is exactly the case a pattern learned elsewhere serves) and **exempting `reopened`** so statistics can never mask a regression. Layer 1 stays local-ledger-only on purpose.

Two invariants constrain anyone changing them; the group table, both traps and
the incidents are in
[`docs/reference/r2-audit-mode.md`](docs/reference/r2-audit-mode.md):

- **A rulings group's header may claim only what its ruling ESTABLISHED.** A
  defer is not a disproof, so DEFERRED bars re-arguing scope while *licensing a
  different defect in the same code*. Give a new group the weakest instruction
  that is **true** — an overstated header suppresses true positives silently.
- **The existence gate runs on BOTH reviewer paths, and its classifier is
  prose-shaped.** Widening classification is the safe direction (unadjudicable ⇒
  `requires_verification`, severity preserved; only `refuted` downgrades) — and
  both of its historical bugs let it report health while classifying zero.

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

**Why no fixed numbers.** The old `reuse ≥0.90 / extend ≥0.85 / justify-divergence
≥0.75` bands fired **zero times in 1,763 consultations** — the pipeline tops out near
0.83, so they were mathematically unreachable and the feature was inert for its whole
history. The cutoff is now `μ + 3σ` over the repo's OWN symbol-embedding background,
computed at `arch:refresh`, because a threshold is a property of *corpus × summary
style × embedding model × compose template × normalizer*, not of the tool — and this
tooling syncs elsewhere, so a constant would repeat the defect there. **An
uncalibrated repo bands `review` only**: honest, not degraded; run
`npm run arch:refresh`. The three old band names are **retired** — seeing them means
stale tooling.

**When NOT to consult**:

- Pure bug fixes that change only an existing function's body (no new symbol introduced).
- Trivial edits: typos, formatting, single-line conditional tweaks.
- Doc-only or test-only changes (unless adding new test helpers).
- Cloud store offline (`{"cloud": false}`) — log an `npm run arch:refresh` hint, proceed.

**The rule above is host-neutral and mandatory; the hook is Claude-Code-only
ACCELERATION, not cross-agent enforcement.** `.claude/hooks/arch-memory-check.sh`
auto-fires on `UserPromptSubmit` when the prompt carries an intent verb
(`fix`/`add`/`implement`/… — list in the hook), and a
`> **Architectural-memory consultation**` callout means it fired: treat it as
authoritative. **Copilot, Cursor and every other host get no hook** — there you run
the command above by hand, and so must Claude when the hook didn't fire (a question
that became a fix mid-conversation). Disable with `ARCH_MEMORY_HOOK_DISABLE=1`. Cost
~$0.0003 + one RPC, disk-cached 24h by `(intentDescription, model, dim)`.

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

**Empirical effectiveness test** — A/B the hook against an
`ARCH_MEMORY_HOOK_DISABLE=1` control; recipe + threshold in the comment block at
the bottom of `tests/hook-arch-memory-check.test.mjs`.

## Quick-fix detection — two-layer architecture

Plan: `docs/plans/brainstorm-quickfix-v1.md` Feature B.

**Philosophy**: nudge, not gate. Root cause beats shortcut, but explicit
acceptance beats silent shortcut. The system surfaces shortcuts so the
author can decide whether they're warranted, not so they're automatically
blocked.

<!-- host-contract: hook-rule; rule=quickfix-surfaced-before-done; portable=quickfix wave in /audit-code; accelerator=.claude/hooks/quickfix-scan.mjs -->

**The RULE is host-neutral; the hook is Claude-Code-only ACCELERATION** (same
shape as arch-memory above). *Rule*: a shortcut signature is surfaced to the
author before the change is called done — satisfied when EITHER layer ran.
*Portable path (all hosts)*: **Layer 2**, the `quickfix` wave in /audit-code —
a low-reasoning GPT pass for DESIGN-level shortcuts regex can't see (stub
returns, tests asserting non-failure, masked root causes); emits
`is_quick_fix: true`, gated by the `quickFix == 0` convergence threshold.
*Accelerator (Claude Code only)*: **Layer 1**, `.claude/hooks/quickfix-scan.mjs`
— fires on every Edit/Write (PostToolUse), pure-regex over ~12 mechanical
signatures (empty catch, unjustified `@ts-ignore`, masked errors, hardcoded
localhost, …), emits a `<system-reminder>`, NEVER blocks. Opt-outs:
`QUICKFIX_HOOK_DISABLE=1`, `// quickfix-hook:ignore`, >80K-char diff bail,
sensitive-path short-circuit. Patterns: `scripts/lib/quickfix-patterns.mjs`.
**Cadence is NOT equivalent** — hook = every edit, wave = once per audit, so on
Copilot a shortcut is caught later and only in audited changes. Say so rather
than implying parity.

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

## Contracts across the prose↔code seam (no compiler runs here)

The single-oracle rule (`classifySelector`, `sensitive-paths.mjs`) is stated
elsewhere for **code↔code** seams. Its worst case is the seam where the
**producer is a SKILL.md** — prose a model follows — and the **consumer is
code**. Nothing type-checks that, nothing errors, and the failure is silent in
both directions.

Two incidents produced the rules below and are written up in
[`testing-doctrine.md`](docs/reference/testing-doctrine.md) §prose↔code seam: a
reader that matched **0 findings in all 7 live sessions** because the SKILL.md
said `severity` and every consumer read `code`, and a prompt that asked for a
field the response schema forbade outright.

- **Before reading a field out of a model-authored payload**, grep the authoring
  SKILL.md for the field name. A docstring about "the real production shape" is
  a claim about mutable state — see verification-discipline §1b.
- **At least one fixture must be derived from a row actually in the store.** A
  hand-written factory encodes what the reader expects, which is the assumption
  under test.
- **One exported accessor owns the read.** The duplicate inline predicate in
  `cross-skill.mjs` is why the drift survived undetected — two spellings, and
  nothing that could compare them.
- **Name the mismatch distinctly.** "No P0/P1 findings" and "P0/P1 declared but
  none parsed" must not share a reason string; the second is a shape bug wearing
  the first's clothes.
- **The worse variant: the prompt asks for a field the RESPONSE SCHEMA forbids** —
  unrepresentable, not mistyped, and uncatchable from either side alone. Ask it of
  the EMITTED schema (`z.toJSONSchema(...)` → `properties`/`required`), never of the
  Zod source: **a prompt that names a field is a claim about a contract you have not
  checked.** A required field must also be filled by every non-LLM constructor, so
  adding one is never a one-line change.

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
synced into eight skills' `references/` by `sync-shared-audit-refs.mjs` and
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
- Use `import 'dotenv/config'` — cwd-only; import `lib/load-env.mjs` instead
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
