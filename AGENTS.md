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
> `SKILL.md ≤3K + references/` pattern. **Enforced since 2026-07-13**: `npm run context:check` (run by
> the pre-push hook and `/ship` Step 4) fails on
> `ctx/oversized-agents-md` above **79000 characters**
> (`DEFAULT_MAX_AGENTS_MD_CHARS` in `scripts/check-context-drift.mjs`) — condense
> a dossier section to a stub + `docs/<topic>.md` rather than raising the cap.
>
> **The test for a line: would an agent that never opens the linked doc still
> avoid the mistake?** A line that *describes* a subsystem moves; a **tripwire**,
> one that stops a mistake an agent would make unprompted, stays resident whatever
> its section's size — shortened, not relocated. **And 27 sentences here are
> quoted character-for-character by gate contracts** (`statedIn: AGENTS.md`), so
> `npm run check` fails on any rewording: list them before editing —
> [gate-honesty.md](docs/reference/gate-honesty.md) §`stated` is a VERBATIM quote.

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
> reverse is never flagged, since the doc may retain retired domains as rationale.
>
> **Bootstrap / refresh order** — stale or missing map, or after editing
> [`.audit-loop/domain-map.json`](.audit-loop/domain-map.json): `npm run
> dashboard:setup`. **Editing `domain-map.json` alone does not retag existing DB
> rows** (re-tagging happens in `arch:refresh` against `symbol_index`) — always
> start with `arch:refresh` after a rename. An `OWNERSHIP_RULE_EPOCH` change
> promotes the next run to a full walk.
>
> **Two-layer dependency model** — **Observed** (the DB import graph, gitignored:
> what code *actually* imports) + **Manual** (`allowedDeps` in the committed
> `domain-map.json`: intent the graph cannot see). Manual entries are NOT a
> fallback, and a stale observed envelope is rejected. **Coverage honesty**: the
> envelope carries a `coverage` verdict counting what the graph DROPPED; absent
> reads `unknown`, never clean. `npm run arch:coverage-gate` owns the exit code —
> in `check`, NOT `dashboard:setup`.
> [Detail](docs/reference/architecture-index.md) ·
> [Design](docs/plans/observed-graph-coverage-honesty.md)
>
> **THE CORPUS IS THE REPO, NOT THE DISK — and dep-cruiser's extension list is a
> QUESTION, not a constant.** The index walked the filesystem against a fixed
> `SKIP_DIRS` and never asked git, so gitignored-and-untracked files were indexed
> as a consumer's code; and `CRUISABLE_EXTENSIONS` *claimed* `.ts`/`.vue` parseable
> when dep-cruiser could not resolve `typescript`, so `arch:drift` printed
> `Layering violations: 0` — *nothing measured*, worded as *no violations*.
> `enumerateFilesWithOwnership` now asks the one oracle
> ([disowned-paths.mjs](scripts/lib/disowned-paths.mjs): **ignored AND untracked**,
> of the CANDIDATES, fail-open and loud) and `assessParserAvailability` asks the
> parser. **Generalise: before a walk or an allowlist decides what a repo contains,
> ask what already knows — git for ownership, the parser for its own capability.**
> [Measurements](docs/reference/architecture-index.md).
>
> **RETAGGING A MODULE CHANGES EVERY EDGE *INTO* IT — re-baseline BOTH
> directions.** Moving a file to another domain changes the `from` domain of
> everything it imports *and* the `to` domain of everything that imports it; the
> second half is invisible from the file you are editing, and three retags in four
> days (`d5e66d35`, `a146bb7b`) forgot it. Do not verify by grep — a docstring
> mention reads as an import. `tests/arm-vocabulary-layering.test.mjs` re-derives
> the whole violation set and is in `npm test`, so a retag that breaks the inbound
> half fails at push.
> [Detail](docs/plans/god-module-and-layering-debt.md) §1.2.

> **An ignored path declares WHY it is ignored, and a private one declares where
> it durably lives.** The two categories below cover *generated* files; a third,
> **P — private and load-bearing**, covers what is neither generated nor
> publishable: never public, not regenerable, and therefore owing a
> `Durable home:` (skipping that question left 37 tech-debt entries on exactly one
> disk). Declared in `.gitignore`'s own comment blocks (`Category: A|B|P`, plus
> `Durable home:` / `Recoverable:` / `Disposable:` for P), gated drift-only by
> `npm run gitignore:policy:gate`. Policy + per-rule table:
> [`gitignore-policy.md`](docs/reference/gitignore-policy.md).
>
> **An exit that stdout can reach must drain first.** On Windows a piped
> `process.stdout` is asynchronous — `npm run x`, `x | tee` and every CI capture
> are pipes — so `process.exit()` **discards whatever has not flushed**, and a
> truncated JSON envelope reads to its caller as a parse error blamed on the wrong
> thing. Use **`await finishAndExit(code)`** ([cli-io.mjs](scripts/lib/cli-io.mjs))
> after writing to stdout. In a **synchronous** function it cannot be awaited: hand
> the decision to the async caller, and never fire `void finishAndExit(code)` and
> fall through — that returns at once and the exit still truncates.
> `npm run stdout:flush:gate` ratchets the population drift-only (growth AND
> unrecorded shrink fail; `--report` for the triaged census; deliberate
> non-findings are a `stderr` write before an exit and the `--selfcheck-relocation`
> two-statement body).
> [Census](docs/reference/ratchet-gates.md) · [Plan](docs/plans/stdout-flush-drain-gate.md)
>
> **A figure compared over time is a trend only if the population is stable.**
> `unremediated_acceptances` is a 7–30 day window on `audit_runs.created_at`, so
> its 116 → 47 fall over five weeks was rows **aging out** — the two windows shared
> **0** rows and **110 of the 116** were still open, and both figures reproduced
> exactly: reproducing a figure cannot detect that the population under it rotated.
> The mechanical test is whether the reader's result depends on `now()`.
> Windowedness **propagates** (the view at the centre of this names no clock at
> all), so every such view must declare its window in `.windowed-views.json`,
> gated drift-only by `npm run windowed-views:gate`.
> [§7](docs/plans/standing-queue-burndown.md) ·
> [discipline](docs/audit/shared-references/verification-discipline.md) §4a.
>
> **Oversized files may not grow.** `npm run size:ratchet:gate` ratchets every
> `scripts/**` file already over 1000 lines against `.file-size-baseline.json`,
> drift-only in knip-gate's shape. **A shrink fails too** — asking you to
> re-baseline — because a baseline pinned at the historical high-water mark lets
> a file grow back unchallenged. [Measurement](docs/reference/ratchet-gates.md).
>
> **A capture column with no coverage entry is a column nobody will notice stops filling.**
> `.own-model-coverage.json` tracks the own-model telemetry columns with
> hand-set floors; `npm run own-model:coverage:gate` (offline, in `check`) fails
> when an entry names a column the schema fixture lacks, or a nullable column a
> covered migration added has no entry or reasoned exemption. `own-model:coverage`
> is the live drift check — **zero eligible rows is `unmeasured`, never green**.
> [Plan](docs/plans/own-model-telemetry-pr3.md)
>
> **Skill markdown may not grow.** `npm run skills:size:gate` ratchets every
> `skills/**/*.md` (and the canonical shared references, never the generated copies)
> in characters against `.skill-size-baseline.json`: a file over 12,000 chars (≈3K
> tokens, the SKILL.md target nothing enforced) may not grow, one under it may not
> cross, and a shrink fails until re-baselined. Move detail to `references/`.
> [Measurement](docs/reference/ratchet-gates.md).
>
> **`--help` is a pure read on every CLI.** `npm run help:readonly:gate` runs each
> one with `--help` under a preload that blocks writes, network and mutating spawns
> (a CLI that ignores the flag simply RUNS: `prepush-check --help` created a worktree).
> No baseline: fix an offender with `import './lib/help-guard-run.mjs'` as its first import.
> [Plan](docs/plans/fleet-feedback-cluster1-bugs.md)
>
> **Generated-artifact policy (invariant — avoid the "messy middle").** Every
> generated file lands in exactly ONE of two categories; never tracked-but-
> unverified-and-volatile:
> - **A — derived from external/mutable state OR carrying volatile provenance
>   (timestamps, HEAD shas) → gitignored.** Not source, and not a pure function of
>   committed source: `.audit-loop/domain-deps-observed.json`, `.audit-loop/cache/`,
>   `dashboard/*.html`, `scripts/.sync-manifest.json`, `docs/architecture-map.md`
>   (regenerate with `npm run arch:render`), `skills.manifest.json`.
> - **B — a pure, deterministic function of committed source → committed AND
>   freshness-verified in the pre-push `check`.** Regeneration must be
>   byte-identical (no clocks/shas/network): `.claude/skills/**`
>   (`skills:regenerate` / `skills:check`), `docs/plans/README.md`, the
>   status-bucketed plans index (`plans:index` / `plans:index:check`);
>   `docs/requirements-map.md` (`requirements:map` / `requirements:map:check`); `scripts/lib/bundle-deps.json`
>   (`npm run bundle:deps` / `bundle:deps:check`).
>
> The test for a tracked generated file: *would two regenerations on the same
> commit be byte-identical, and does a check enforce it?* If no → it belongs in A
> (gitignore it), not committed. A committed artifact whose dirtiness carries no
> information is churn, not a reference. Per-example history and rationale:
> [gitignore-policy.md](docs/reference/gitignore-policy.md).
<!-- arch-map-discoverability:end -->

> **Design right-sizing — the simplest structurally-honest solution.** At any
> non-trivial fork, reject BOTH cliffs: the **band-aid** (patch the symptom or
> defer the real fix *because it's harder*) and the **over-engineering** (an
> abstraction / config / artifact no *current* requirement needs). Forcing
> question: *"what's the band-aid, what's the over-built version, and why is mine
> the smallest thing that's a true function of the problem?"* `/plan` and
> `/audit-code` carry the full check; a `defer` is honest only as a true scope
> boundary or documented debt, **never because the correct fix is larger**.
>
> **Scope is decided by impact, not authorship (load-bearing test).** The
> companion failure mode: dismissing a finding as "out-of-scope / pre-existing /
> not introduced by this change" when the change being shipped actually *depends*
> on the cited path. Authorship and plan-ownership are the wrong test; **impact**
> is the right one — *does the correctness or stability of what I'm shipping ride
> on this path?* If yes it is in-scope **for the fix/defer decision** even when
> pre-existing, and a silent defer is the band-aid. A pre-existing finding in a
> *changed* file is a yellow flag, and passing tests don't clear it — a green
> suite only covers exercised paths. Legitimate `defer` requires naming the
> **independence** (the new code does not call/depend on the cited path), not the
> authorship; for a same-file finding, that the cited code does not share the SAME
> column/constraint or the SAME transaction instance the new code depends on —
> sharing a table or a broader boundary is not sufficient. `/audit-code` (Step 3)
> and `/audit-plan` (Step 3) enforce this.

## Project Overview

18 AI-pair-programming skills covering the development quality lifecycle, planning
through code audit to live UX testing and shipping. Node.js, ESM only
(`"type": "module"`); CLI scripts + skill files invoked by AI coding assistants.
Renamed from `claude-audit-loop` in Phase E.

## Skill Chain

18 skills; 16 run in this order: **plan → audit-plan → *(implement)* → audit-code
→ ux-lock → deploy → the four UI lenses → ship**, with `/cycle` driving the whole
chain and pausing for human implementation. The four lenses are **disjoint** and
run together on a UI PR — click-test (page DOM) ∥ persona-test (journey) ∥
nav-audit (system IA) ∥ visual-audit (paint). `/fleet` sits beside the chain,
coordinating concurrent sessions cooperatively
(`references/coordinator-playbook.md`); `/harness-retro` runs after sessions,
proposing checks for failures that recur across them (propose, never apply).

Diagram, per-skill scope and depth (modes, flags, wave/lens design invariants) and
the naming convention: [`skill-roster.md`](docs/reference/skill-roster.md) — read
it before renaming a skill or "simplifying" a wave.

**Skill file structure** (progressive disclosure): `skills/<name>/` is
**authoritative — edit ONLY here** — with `SKILL.md` (canonical flow, ≤3K tokens),
`references/<topic>.md` (loaded on demand) and optional `examples/`.
`.claude/skills/<name>/` is the generated copy — run `npm run skills:regenerate`
and **never hand-edit it**.

> **Skill surfaces — three invariants.** Discovery-root history, the
> retired-tooling table, the migration recipe and the full frontmatter contract:
> [`skill-surface-ownership.md`](docs/reference/skill-surface-ownership.md).
>
> **(1) Never ship the same skill name in two discovered roots** — Copilot's
> precedence between `.github/skills/`, `.claude/skills/` and `.agents/skills/` is
> **undocumented**. The committed `.claude/skills/**` is the single Copilot-native
> surface; `.github/skills/` and the `.github/prompts/*.prompt.md` shims are
> **RETIRED** — never re-introduce a generator, and check both retired roots when a
> consumer's Copilot behaves oddly (the sync deliberately never deletes them).
>
> **(2) Skills install REPO-SCOPED, never machine-global.** A SKILL.md is only
> valid alongside the runner layout it cites, so **no correct content exists** for
> the layout-agnostic `~/.claude/skills/`; it and `.agents/skills/` are retired
> (`resolveSkillTargets` throws) and `.githooks/post-merge` is **deleted**.
> Installing is `npx github:Lbstrydom/claude-engineering-skills <dir>`. Proposing a
> new surface? Answer first: *which layout does its content belong to, and what
> stops it colliding with `.claude/skills/`?*
>
> **(3) Frontmatter is a contract** (enforced by `skills:check`), and its sharpest
> trap is silence: a bad `name` is a **silent skip**;
> `description` is required, **max 1024 chars**; every optional key sits at **column 0** —
> indented under `description: |` it is description TEXT, parsed, valid and
> **inert**. Semantic
> overlap has no oracle: declare the discriminator in BOTH descriptions (*topic* →
> `/explain --history`, *claim* → `/investigate`). VS Code reads
> `.vscode/mcp.json`, **NOT** `.mcp.json` — keep the two mirrored when adding servers.

Every reference file has `summary:` YAML frontmatter that must byte-match the
parent SKILL.md's reference-index row, enforced by `npm run skills:check`
([format](docs/reference/skill-reference-format.md)). A skill MAY also carry a
colocated `gate-contract.json` binding a stated gate to its enforcing code+test
(never packaged/synced; no contract = `uncontracted`, not failed), validated by
`skills:check`/`gates:check` ([detail](docs/reference/gate-honesty.md)). Each
skill is a sibling — shared env vars and cloud audit store, distinct scopes.

> **AN UNMEASURED ROUND MUST NOT WEAR A CLEAN ROUND'S CLOTHES.** A round that lost
> every pass to Azure 429s printed `Verdict: INCOMPLETE | H:0 M:0 L:0`, exit 0 —
> one word from a clean audit, and the convergence test reads only those three
> numbers, so `/cycle` converges and ships. Pinned: `formatAuditSummaryLine`
> refuses the counts-first shape for INCOMPLETE; `openai-audit.mjs` sets **exit 3**
> (1 already means "the CLI errored"); `countFindings` folds INCOMPLETE into its
> `failed` flag, so ONE predicate answers "is this round evidence". 429 is budgeted
> apart from a generic transient (`retryAttemptsFor`/`nextRetryDelayMs`), and
> `describeLostWrites` flags a `42P10`-shaped error as **store schema drift**.
> [Detail](docs/reference/audit-internals.md)

**Four imperatives the roster is too late to tell you.** **(1)** A new mechanical
wave must be declared in `MECHANICAL_WAVES` ([audit-shadow.mjs](scripts/lib/audit-shadow.mjs)),
or `PASS_PROMPTS` silently enrols it in the model-A/B/C shadow's **paid**
comparison. **(2)** `classifySelector` ([selector-policy.mjs](scripts/lib/ux-lock/selector-policy.mjs))
is ux-lock's **single** policy oracle — never add a second classifier.
**(3)** persona-consistency's `expectedContradictions.max` is loosenable — treat
raising it like deleting a test. **(4)** visual-audit's scope firewall: *include a
check only if you can assert it on a computed style without knowing what the page
is FOR* — signifiers in, affordance judgments out (those are persona-test's).

## Consumer-repo layout (isolation)

This repo's tooling deploys to consumers under **`scripts/.claude-skills/`**, not
their natural `scripts/`, gitignored via a managed block in their root
`.gitignore`. Untracked, so a fresh clone of a consumer needs `npm run sync --
--target <name>` from THIS repo to hydrate it. **The `--` is load-bearing**:
without it npm swallows `--target` and the sync writes into EVERY consumer
instead of the named one (verified 2026-07-20).

> **Upstream-owned — never patch the synced copy (governance).** A failure in a
> consumer's `scripts/.claude-skills/**` file is an **UPSTREAM** bug: fix it HERE
> + re-sync. The local edit is gitignored (invisible to review), overwritten next
> sync, and leaves the bug live for every other consumer. Each synced file carries
> a banner saying so (`sync-banner.mjs`); drift backstops and the
> `.githooks/pre-push.local` recipe for repo-specific push gates (never the managed
> hook): [consumer-adoption.md](docs/runbooks/consumer-adoption.md).
>
> **Consumers are not all on ONE store**, so **an unasked question must never
> render as an empty result** — a single-store read is blind to a consumer (`/ship`
> printed `0 open` against 8). Fan out with `npm run upstream:queues` /
> `stores:drift`; name a store by `storeDescriptor` (fingerprint + consumers, never
> a hostname — this repo is public). **An EMPTY DSN env var is the AIR-GAP signal**
> (`airGapDbUrl`) — never "fix" it to fall through to `~/.audit-loop.env`.
> [Detail](docs/reference/consumer-repo-layout.md)
>
> **File the report, don't paste it.** Consumer: `cross-skill.mjs upstream report
> --affected-path <synced path>`; here: `npm run upstream:issues` →
> `ack|fix|wont-fix|annotate|history`. **Every body and `--note` goes on stdin** —
> a backtick in an argv note runs as command substitution and silently elides text
> the append-only log cannot repair; `annotate` is the only legal repair, never a
> second `fixed`. [consumer-adoption.md](docs/runbooks/consumer-adoption.md)
> §Reporting an upstream bug.

> **SEVEN shapes consumers keep reporting — read them before adding a gate or a
> nudge**, one `###` each with its measurement and predicate in
> [consumer-repo-layout.md](docs/reference/consumer-repo-layout.md) §Seven shapes:
> *(1)* a read handing back a key its writer rejects · *(2)* a gate judging files
> the repo does not own · *(3)* a check verifying one direction only · *(4)* a
> documented command whose tooling cannot reach a linked worktree
> (Gate: `npm run worktree:preflight:gate`) · *(5)* synced content naming an
> `npm run` alias or an out-of-closure `docs/` file — **name synced tooling BY
> PATH** and the sync rewrites it (`npm run skills:consumer-refs:gate`) · *(6)* a
> **relative link** in synced markdown, whose href resolves where the file LANDS
> (`npm run docs:synced-links:gate`) · *(7)* a synced SKILL.md resolving its own
> subject through the **shell** — document the command BARE and let the CLI's chain
> end in `measured:false`, never a refusal and never a zero.

> **"Is this file mine to fix?" must be answerable OFFLINE**, and no single signal
> answers it — git-ignore state, the content banner and the sync manifest each have
> a hole. The one predicate is `createUpstreamOwnershipOracle`, unioning git-ignore
> state with the **committed** `scripts/.sync-owned.json`; compare
> **case-insensitively**. **`skills:hydrate` cannot run in CI by construction** and
> FAILS there rather than exiting 0 having copied nothing. The three holes, and why
> `debt:review` never leverage-ranks upstream-owned entries:
> [consumer-repo-layout.md](docs/reference/consumer-repo-layout.md)

> **Upstream bug, but you're blocked?** Patching upstream-owned *source* stays
> forbidden; a **runtime/env/DB** unblock is OK if you report it, label it
> `TEMP — pending upstream fix` and reconcile when the fix lands.
> [consumer-adoption.md](docs/runbooks/consumer-adoption.md) §Blocked.

> **Consumer divergence is DECLARED, never inferred — and the sync must never
> revert it silently.** The **manifest hash, never HEAD**, is the three-way BASE;
> standing divergence lives in the committed `.sync-overrides.json`
> (`scripts/.claude-skills/**` is never claimable — that is an upstream report);
> and the committed, append-only `.sync-receipt.json` is a deliberate
> generated-artifact-policy exception, because its dirtiness is the only evidence
> a sync ran. The three mechanics in full (refusal rules, `upstreamMoved`,
> `--overwrite-diverged`) before you touch the sync:
> [consumer-repo-layout.md](docs/reference/consumer-repo-layout.md) §Consumer
> divergence · [Plan](docs/plans/consumer-sync-durability.md).

### Sync mechanics — pointer

Sync-behavior detail (the isolated subdir, the what-goes-where table, the
managed-gitignore block, the `sync-*` module list):
[`consumer-adoption.md`](docs/runbooks/consumer-adoption.md) §"Sync internals".
One structural invariant stays here: **the sync layout's single source of truth is
[`sync-path-map.mjs`](scripts/lib/sync-path-map.mjs)** — never hand-compute one.

**A consumer's package manager is [`package-manager.mjs`](scripts/lib/package-manager.mjs)'s
answer, never a hardcoded `npm`/`npx`** — the managers are not swappable, so two
lockfiles + no `packageManager` field is **ambiguous and left alone**, never
guessed. Adjudicate an install by RE-PROBING `node_modules`, never the exit code
(pnpm exits non-zero on `ERR_PNPM_IGNORED_BUILDS` after a successful install). The
corepack/`.cmd` trap:
[consumer-adoption.md](docs/runbooks/consumer-adoption.md) §Your package manager.

### CLI smoke contract (`--selfcheck-relocation`)

A CLI in `CLI_SMOKE_SET` implements the `--selfcheck-relocation` handler at the
head of `main()` (CI fails if one lacks it); library modules get an import-test in
[`relocation-guard.test.mjs`](tests/relocation-guard.test.mjs) instead. **The entry
guard itself is `if (isInvokedAsScript(import.meta.url))`**
([cli-entry.mjs](scripts/lib/cli-entry.mjs)) — never a hand comparison of
`process.argv[1]` with `import.meta.url`. Node realpaths one side and not the
other, so through a symlink or junction the hand guard is false and the CLI exits
0 having run nothing (16 of 26 did, measured 2026-10-13); no smoke run goes
through a link, so the census in
[`cli-entry-guards.test.mjs`](tests/cli-entry-guards.test.mjs) is what enforces it.
Snippet + current set: [consumer-repo-layout.md](docs/reference/consumer-repo-layout.md)
§CLI smoke contract.

**Adopting these skills in a new consumer repo** — the migration recipe and
`doctor` (one command over every adoption-friction class, ratcheted by
`npm run upstream:coverage:gate`): [consumer-adoption.md](docs/runbooks/consumer-adoption.md) §Diagnostics.

## Browser Tool Setup (persona-test)

`/persona-test` drives a real browser; **Playwright MCP is the preferred tool** (free, no credentials, registered in `.mcp.json`). **First-time setup: `npx playwright install chromium`** — without it the server crashes silently and no tools appear. Windows may need an MCP override: [CLAUDE.md](./CLAUDE.md#claude-code-only-notes). BrightData alternative: [mcp-tooling.md](docs/runbooks/mcp-tooling.md).

## Mermaid validation (for plan diagrams)

**Interactive**: call **`mcp__mermaid__generate_mermaid_diagram`** with `outputType: "mermaid"` to validate without rendering — invalid syntax returns an MCP error with line/column, no API key. **Pre-push**: `npm run plans:lint` (in `check`) scans `docs/plans/*.md` for what the parser accepts but stricter renderers reject — **ERROR `subgraph-as-edge-endpoint`** (anchor the edge to a node *inside* the subgraph) blocks; **WARN `unquoted-special-chars-in-label`** (write `ID["..."]` when a label has `<br/>` or non-ASCII) is advisory. Registration and rule-coverage rationale: [mcp-tooling.md](docs/runbooks/mcp-tooling.md).

---

## Dependencies (CRITICAL — check versions before flagging issues)

| Package | Version | Notes |
|---------|---------|-------|
| `zod` | **4.6.7** | Zod 4 API — NOT Zod 3. `_def.type` is a string (`'object'`, `'array'`, `'enum'`), NOT `_def.typeName` (`'ZodObject'`). `shape` is a direct property on object schemas, NOT `_def.shape()`. `_def.entries` for enums, NOT `_def.values`. |
| `openai` | **7.8.0** | v7 since 2026-08-09; `responses.parse()` + `zodTextFormat()` unchanged, live-verified on the 7.8.0 + zod 4.5.2 bump (2026-09-03); zod 4.6.5 (#115) and 4.6.7 (#294) are CI-verified only |
| `@google/genai` | ^2.19.0 | `responseMimeType: 'application/json'` + `responseSchema` for structured output |
| `dotenv` | 17.4.2 | Load via `lib/load-env.mjs`, never `dotenv/config` (cwd-only) |

## Architecture

**Do not hand-maintain a module tree here** — [`docs/architecture-map.md`](docs/architecture-map.md)
is the live, generated per-symbol index (bootstrap note at the top of this file);
an inline tree goes stale silently, the one removed 2026-07-13 listing 2 test
files against 100+ real. Layout in one line: `scripts/*.mjs` are CLI entry points,
`scripts/lib/**` focused modules (split from the former `shared.mjs` monolith,
still a backwards-compatible barrel), `tests/` the Node test-runner suite, and
`.claude/skills/**` is generated from `skills/**`.

Per-module prose (openai-audit, gemini-review, the learning-store barrel) and the
named patterns (adaptive sizing, semantic dedup, atomic persistence, the closed
Gemini loop, …) live in
[`audit-internals.md`](docs/reference/audit-internals.md) — condensed out
2026-07-20 having already rotted, exactly what the rule above prevents.

### Testing

Run: `npm test` (Node.js built-in test runner — the suite under `tests/`).
**Measured 2026-09-04: 14,711 tests, 0 fail, 39 skipped, 9m16s** (`npm test`, on
a linked worktree). Carry the date and the command — the anecdote in
§verification-discipline is about this very row going 2.3x stale.

#### Pre-push runs against a clean checkout, not the working tree

The hook runs `check` in a throwaway worktree at the **commit being pushed**
([`prepush-check.mjs`](scripts/prepush-check.mjs)) — never `git stash`, which
yanks a concurrent session's files mid-edit. **A killed hook must fail CLOSED**:
Git for Windows reads a signal-killed hook as exit 0, so the marked
`fail-closed-on-signal` trap block stays byte-identical in both hooks. Why,
escape hatches and #225: [`prepush-sandbox.md`](docs/runbooks/prepush-sandbox.md) §1, §8.

**THIS repo's full suite runs in GitHub Actions, not on the shared machine.** CES
is public, so `full-suite.yml` is its one full run per PR, and a local CES push is
the **branch tier** by default (`.test-tiers.json`; `AUDIT_PREPUSH_TIER=full` and
every push to `main` stay full). The Actions budget is gated by
`tests/workflow-runner-labels.test.mjs`. Consumers get none of this — wine and
storyline stay local-first. [Plan](docs/plans/ci-full-suite-actions.md) ·
[runbook](docs/runbooks/gate-cost.md) §6.

#### A spend-bearing run PINS its revision — it never shares the working tree

The store refuses a snapshot whose arms disagree, so two died on 2026-08-17
(~$13) — one to a rebase, one to a **concurrent session's commit**. Run ANY
revision-stamped, spend-bearing job (arm-eval, solo-control, model-eval, replays)
via `npm run fixture:create`. Two traps it does not remove: gitignored inputs are
ABSENT, and **trust the store, not the fixture's local bake-off log**, which reads
near-zero and looks like lost progress.
[Runbook](docs/runbooks/pinned-revision-fixture.md)

- **A DB suite no runner names has never run.** Without a disposable DSN it skips
  itself, and node reports a never-run suite as a clean pass — so enrolment in
  `db-test-container.mjs`'s `*_SUITE_FILES` (**and**, in lockstep,
  `postgres-parity.yml`) is the only thing that makes it coverage (2026-08-11
  census: 15 enrolled nowhere). **Adding a DB-gated suite is two edits, never
  one**; `npm run db:enrolment:gate` iterates the FILESYSTEM, the only side that
  can see a file no list mentions. Run them via `npm run db:local` (mirrors CI) —
  never by setting `AUDIT_DB_TEST_URL` globally for an unscoped `npm test`: every
  enrolled file hits one container concurrently and times out
  (`cancelledByParent`), reading as regressions that are pure contention.
- **Sandbox-honesty rule.** A fresh worktree has no gitignored inputs, so a check
  that *skips* on a missing input passes having read nothing. **Adding a check? Ask
  whether it can go green in a clean checkout having checked nothing — if so it
  needs a strictness flag, not a tolerated skip.** A sandbox setup failure is a
  push failure, not a pass.
- **`npm test` refuses a green it did not earn.** Node can report a suite as
  `not ok` and still exit 0, so `adjudicateRun` ([run-tests.mjs](scripts/run-tests.mjs))
  keys on the **consequence**, not the cause, and fails **closed** when its own
  report is missing. [prepush-sandbox.md](docs/runbooks/prepush-sandbox.md) §2.3.
- **One range, one resolver** — [`push-range.mjs`](scripts/lib/push-range.mjs).
  Gates must not re-infer a base from working-tree state (`@{u}`, dirty→`HEAD~1`);
  an unresolvable explicit base fails hard, never demotes to inference.
  [prepush-sandbox.md](docs/runbooks/prepush-sandbox.md) §3.
- **Hashing working-tree bytes ≠ hashing committed source.** A generator hashing
  files for a *committed* artifact must canonicalise CRLF→LF with `canonicalizeEol`
  ([`file-io.mjs`](scripts/lib/file-io.mjs)), the one byte-level fold — but NOT
  where the exact bytes ARE the contract. The tell: **git says clean and your tool
  says changed; git is right.** That and the worktree-`node_modules` rule:
  [prepush-sandbox.md](docs/runbooks/prepush-sandbox.md) §2.1–2.2.
- **An mtime freshness oracle is usually wrong in the HEALTHY case, not merely
  lossy** — the writer's own ordering decides it, and `lock newer than
  node_modules/` was the normal post-install state. Ask **who writes these two
  paths, in what order**; then use the tool's own content record instead (npm keeps
  `node_modules/.package-lock.json`). Compare CONTENT, never key counts.
  [prepush-sandbox.md](docs/runbooks/prepush-sandbox.md) §4.

#### Testing doctrine — pointer

Three tiers, because blanket TDD is theatre at the LLM boundary but rigor pays at
deterministic seams. Tiers 1–2, the guarding tests and the deliberate deferrals:
[`testing-doctrine.md`](docs/reference/testing-doctrine.md). Resident: **Tier 3 is
non-negotiable** — two seams where a change lands with its test in the **same
commit**, *(a)* **sensitive-path egress** (a leak ships credentials to a
third-party LLM) and *(b)* the **consumer sync / relocation contract** (a break
ships silently to repos you cannot observe).

#### Pre-ship empirical verify — for skills that assert on a live runtime

Static review cannot catch what only appears when a real browser renders real data
— a mid-theme-transition `getComputedStyle` read once *fabricated* a bug that
survived four review passes. **(1)** Any skill driving a browser must run against
ONE real app before being called done; a field finding with a green repro routes
to a regression test + ONE focused review, never the adjudication loop.
**(2)** Freeze transitions AFTER the flip + `await document.fonts.ready`; an
empty/failed capture degrades to `unverified`, never "verified / 0 findings".
**(3)** **Audit your success paths** — ask of any green-emitting branch *"can this
return green without having checked anything?"*
→ [`pre-ship-empirical-verify.md`](docs/runbooks/pre-ship-empirical-verify.md).

## Model Resolution

`scripts/lib/model-resolver.mjs` resolves model IDs so config stops going stale
when providers ship new versions. All model-reading env vars in config.mjs pass
through `resolveModel()`.

**Sentinels** (preferred in `.env`) — `latest-gpt`, `latest-gpt-mini`,
`latest-opus`, `latest-sonnet`, `latest-haiku`, plus Google's `latest-pro` /
`latest-flash` / `latest-flash-lite`. A sentinel picks the newest tier match from
live-catalog ∪ `STATIC_POOL`; a stale concrete id is remapped with a one-time
warning; concrete ids pass through. Heavy entry points refresh the catalog and
re-resolve, so new provider models need no `STATIC_POOL` edit
(`MODEL_CATALOG_REFRESH=skip` opts out for air-gapped CI; a network failure falls
back silently). Self-check: `node scripts/lib/model-resolver.mjs resolve | catalog`.

**Anti-patterns (load-bearing):**
- Do NOT pin concrete model IDs in new code — use a sentinel (`latest-*`).
- Do NOT drop `-preview` from Gemini 3 IDs unverified — bare `gemini-3-flash` /
  `gemini-3.1-pro` never shipped (Google 404s). Verify via the `…/v1beta/models` list.
- Do NOT retry 404 — `classifyLlmError` treats any 4xx (except 429) as non-retryable.
- When rewrapping an LLM error, surface `err.status` + the real provider
  `error.message` — don't collapse to `"API error ${status}"` (it names the bad model).
- **OpenRouter**: one model id → many backends with incompatible ctx limits, picked per request, and reasoning tokens count against `max_tokens`. Unpinned runs fail at random, reading as model flakiness — always send `provider:{require_parameters,sort}` + `reasoning:{effort}`. [experiment-4](docs/research/experiment-4-cheap-final-reviewer-smoke.md)
- **A model id carries its ROUTE, and the two are never reconciled.** Some models
  are reached BOTH natively and via OpenRouter (`qwen3.8-max` vs
  `qwen/qwen3.8-max`); `transportForModel` dispatches on exactly that shape and
  the routes bill differently, so **never "normalise" `source_model`** — it erases
  the routing decision and corrupts costing. What must NOT vary by route is the
  vendor **family**: call `modelFamily`, never a local head-of-string helper —
  reading the vendor off whichever half of the id was present is how a model
  grading its own output got recorded as unbiased (`self_family`, fixed
  2026-08-23). A new vendor needs `VENDOR_ALIASES` too; `npm test` fails until it has it.

→ Per-sentinel table, resolution order, live-catalog mechanics, startup-log
example, static-pool maintenance:
[`model-resolution.md`](docs/reference/model-resolution.md).

## Memory-Health Gate

`scripts/memory-health.mjs`: three trigger metrics deciding whether the flat
`audit_findings` + fingerprint-dedup design leaks signal a graph memory would
recover. A weekly AMBER, a metric change, promoting the graph design:
[`memory-health-gate.md`](docs/reference/memory-health-gate.md).
**Resident**: a new wave that emits control state needs a
`control_marker_prefixes` sentinel (matched on the detail-snapshot **prefix**,
never the category), or the gate reads AMBER forever on its own logging.

## Learning System (Phase 1)

Adaptive-learning telemetry across audit decision points → `learning_decisions` +
`recurring_finding_clusters`. Auto-deferral, `learning:*`, the weekly review,
replay/promotion:
[`learning-system.md`](docs/runbooks/learning-system.md). **Resident**:
`LEARNING_DISABLE=1` kills all live learning + telemetry; telemetry never crashes
a run (flush failures spill to `.audit/learning-outbox/`); a plan accepts a v1
limit with `<!-- audit:accept-v1: <glob> :: <reason> -->`.

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
| `FINAL_REVIEW_TIMEOUT_MS` | `270000` | **COUPLED** to `FINAL_REVIEW_HARD_DEADLINE_MS`: the watchdog floor is `2x timeout + 60000`, so 270s is the most the default admits — raise both together. Read by `finalReviewTimeoutMs()` (`GEMINI_REVIEW_TIMEOUT_MS` is a deprecated alias); `finalReviewModelSpec()` owns the ONE default for `FINAL_REVIEW_MODEL`. |
| `AUDIT_AUTHOR_TIER_HINT` | — | **Observation-only** — it records an author-model tier and must never route. |
| ~~`SUPABASE_AUDIT_*`~~ | — | **Sunset in M4.** The runtime DSN's credential is the access control — there is no separate write-role key. |

## Postgres-Parity Store (M1–M4)

The cloud learning store talks to **Postgres directly via the `pg` driver** — no
`@supabase/supabase-js` / PostgREST layer; "Supabase-hosted vs self-hosted" is just
a connection string. **Load-bearing invariants** (the rest is in the docs below):

- **Connect**: `AUDIT_DB_URL` + `AUDIT_DB_SSL_MODE=no-verify`, via the Supabase
  **Session pooler (5432)**, **NOT the Transaction pooler (6543)** — 6543 drops
  server-side prepared statements and the `search_path=public` pin the `db/` seam
  needs. Single-tenant: a role's credential is the access control (no separate
  read/write keys). The runtime `pg.Pool` ([`db/client.mjs`](scripts/lib/db/client.mjs))
  either owns `public` or is a `BYPASSRLS` role with DML grants, so it **bypasses
  RLS** (correct here); an **owner + least-privilege runtime split** is supported,
  and its `ALTER DEFAULT PRIVILEGES FOR ROLE <owner>` line is the one that gets
  forgotten ([postgres-parity.md](docs/runbooks/postgres-parity.md) §Two roles). The
  schema is **`public`-only** in v1. Moving to a different store:
  [moving-the-audit-store.md](docs/runbooks/moving-the-audit-store.md). Setup recipe,
  `--migrate`/`--adopt`/`--check-drift`, `npm run setup:cloud`:
  [postgres-parity.md](docs/runbooks/postgres-parity.md) §Connecting + §Setup recipe.
- **Never use the dashboard as the routine migration path** — it reintroduces the
  silent-drift the ledger exists to eliminate; make the source migration idempotent
  and retry `--migrate` instead.
- **`audit_runs.commit_sha` is HEAD at audit-capture time, not the commit
  containing the audited diff** — the parent on a dirty tree (the normal case).
  Use `audited_sha`/`audited_tree` for target identity; NULL on both means
  unverifiable, never guess. Measured 2026-09-20: 72% zero file-overlap between
  `commit_sha`'s diff and its own findings across 94 sampled runs.
  [Plan](docs/plans/audit-target-identity-commit-sha-correction.md).
- **jsonb-safe write seam — do NOT hand-`JSON.stringify` a jsonb column.**
  `serializeWriteParam` auto-serializes a plain array bound to ANY column on the
  write path (node-postgres otherwise binds an ARRAY literal jsonb rejects with
  `22P02` or silently stores as `{}`). **Pass jsonb values raw**; a real
  `text[]`/`int[]` column opts OUT with **`pgArray(value)`** — a jsonb writer that
  forgets is safe, a `text[]` writer that forgets fails LOUDLY.
  [postgres-parity.md](docs/runbooks/postgres-parity.md) §jsonb write seam.
- **Migrations stay schema-portable**: `parity:check-coupling` fails on any `<schema>.`
  qualification or non-core reference outside the recorded baseline.
- **Every audit-store write in `legacy-production-audit.mjs`'s cloud block goes
  through `durableWrite`** ([durable-write.mjs](scripts/lib/durable-write.mjs)),
  registered in [audit-store-writers.mjs](scripts/lib/audit-store-writers.mjs).
  Four outcomes, not interchangeable: `written` · `spilled` · `lost` · `skipped`
  (cloud off is a supported mode, not a failure); `lost` **or** `spilled` makes a
  run `incomplete`. A new write-shaped export under `scripts/lib/store/**` must be
  registered or exempted **with a reason** — `npm test` derives the set from the
  filesystem, the only side that can see a module no list mentions. Outcome
  semantics, spill-eligibility and the single bootstrap:
  [postgres-parity.md](docs/runbooks/postgres-parity.md) · [plan](docs/plans/audit-store-write-durability.md).
- **`emit({ok:false})` sets a non-zero exit code** ([cli-io.mjs](scripts/lib/cli-io.mjs)).
  Without the coupling a CLI reports a failure in its envelope and exits 0, which
  every caller checking `$?` reads as success. Opt out only with
  `emit(env, {softFail:true, reason})` — the reason is **required** — and
  `npm run emit:exit:gate` ratchets the opt-out population, failing on growth AND
  on an unrecorded reduction.
  [Design](docs/plans/cross-skill-command-registry.md) §2b F4.
- **A SCHEMA ERROR IS NOT AN EMPTY RESULT — and a bare `catch { return null }`
  renders it as one.** Ask of any catch around a query: *can a broken query and an
  absent row leave here as the same value?* `isSchemaFaultSqlstate` /
  `describeSchemaFault` ([db/errors.mjs](scripts/lib/db/errors.mjs)) make a
  read-path catch **degrade loudly**. Testing the pure decision is not enough —
  **split it out AND put one assertion on a real Postgres**; the pure tests passed
  throughout the whole period a freshness cache was dead (incident 2026-09-05).
  [postgres-parity.md](docs/runbooks/postgres-parity.md).
- **"Disposable" is an ALLOWLIST of loopback hosts, and it fails CLOSED.**
  `isDisposableDbHost` / `assertDisposableDbUrl` ([db/client.mjs](scripts/lib/db/client.mjs))
  guard the suites that `DROP SCHEMA public CASCADE` and the schema fixture.
  **Never re-express this as "not $VENDOR"** — a denylist is only as current as the
  last infra change, and the one it replaced went inert the day the store moved.
  Production identity is compared as host+port+database, never as a DSN string; no
  env escape hatch, deliberately; and **regenerate the fixture only from a fresh
  replay** (`npm run db:local:regen`).
  [postgres-parity.md](docs/runbooks/postgres-parity.md) §Incident + §Correction.
- **Bound an RPC at the CALLER** — `SET statement_timeout` inside a function is
  decorative. `CREATE OR REPLACE FUNCTION` resets **`proconfig`** (restate `SET
  search_path`) but PRESERVES the ACL; **changing the argument list makes a
  DIFFERENT function**, whose default ACL is `EXECUTE` to `PUBLIC` and which the
  old `REVOKE` does not name. Verify by `has_function_privilege`, never by review
  or by a `proacl` that reads `NULL`.
  [memory-health-gate.md](docs/reference/memory-health-gate.md).

→ **Design** (the no-adapter `pg`-direct decision, schema scope, privilege model): [`postgres-parity.md`](docs/plans/postgres-parity.md) + [`schema-coupling`](docs/plans/postgres-parity-schema-coupling.md). **Operations** (setup, migration-drift CLI + exit codes, break-glass atomic-apply, shared cloud config): [`runbooks/postgres-parity.md`](docs/runbooks/postgres-parity.md).

## Anthropic Backend Routing

All Claude API calls go through one seam,
[`anthropic-client.mjs`](scripts/lib/anthropic-client.mjs); `CLAUDE_BACKEND`
switches transport without touching call sites — for the calls that transport can
serve faithfully (refusal rule below). `sdk` (committed default, and what an unset
`CLAUDE_BACKEND` resolves to) is the direct `@anthropic-ai/sdk` API billing
`ANTHROPIC_API_KEY`; `cli` spawns `claude -p --output-format json` on the Max 20x
Agent SDK credit. **Local status: `cli`** (gitignored `.env`; the committed default
stays `sdk` for CI without the `claude` CLI). Call sites use
`createAnthropicClient()`, never `new Anthropic()` — guarded by
[anthropic-client-migration.test.mjs](tests/anthropic-client-migration.test.mjs).
Smoke test: `npm run anthropic:ping`.

> **A BACKEND MUST NOT ACCEPT A CALL IT CANNOT HONOUR — THROW AND PIN.** A param
> `cli` accepts and then drops or OUTRANKS surfaced as a MODEL failure.
> `unserviceableCliParams` is the single oracle, decided from the PARAMS, and an
> **ALLOWLIST**: it serves `model`/`max_tokens`/`messages` and **THROWS** on every
> other param, named or not, ambient or explicit — never routed to sdk, which would
> let a param pick the meter; a key it cannot enumerate fails CLOSED. The fix is a
> declared `{backend:'sdk'}` pin gated on **`isClaudeAvailableFor('sdk')`**, and
> since the throw cannot fire in CI (which runs the `sdk` default)
> `npm run anthropic:pin:gate` is the guard. **`cli`'s cost does not depend on your
> prompt** — a ~164K-token prefix per call, so no prompt change fixes a `cli` cost
> problem and `--bare` strips the prefix and the OAuth credit together. What `cli`
> does pass (`--system-prompt` is passed and obeyed), `BILLING PIN`, measurements:
> [reference](docs/reference/anthropic-backend-routing.md) ·
> [plan](docs/plans/anthropic-cli-faithfulness-routing.md).

**Load-bearing gotchas**:

- **Forced tool-calling needs `{backend:'sdk'}` explicitly (found 2026-07-14).**
  `cli` always spawns `claude -p --tools ''`, so a caller forcing `tool_choice` got
  a plain `text` block with **no error** — costing the tiered-recall discovery
  generator a whole shadow window (20/20 runs fell back to legacy). Since
  2026-11-15 the seam THROWS instead, so the pin is the fix, not the intent.
- **`max_tokens` is UNENFORCED on `cli`** — accepted and ignored, not merely
  unenforceable, so it is never a bound for cost or for parse safety.
- **Availability is the backend's own answer, never `process.env.ANTHROPIC_API_KEY`.**
  A raw env check skips a fully-available backend — fourth instance found
  2026-11-14 in [summarise.mjs](scripts/symbol-index/summarise.mjs), the
  highest-volume Claude call site here, which under `CLAUDE_BACKEND=cli` with no
  key emitted **null summaries for the whole symbol corpus**. Ask
  `isClaudeAvailable()` where the ambient backend will serve the call, and
  `isClaudeAvailableFor('sdk')` at a PINNED site — the ambient answer is `true` on
  a keyless `cli` install, so a pinned site passed its gate then threw
  `ANTHROPIC_API_KEY required` for a backend nobody selected.
- **`claude-trace` cannot meter the scripted cli backend** (it corrupts the JSON
  envelope on stdout). Use the backend's own self-reported `cost_usd`.

→ Backend table, cost-telemetry detail, migration pattern, and the full
call-site list: [`docs/reference/anthropic-backend-routing.md`](docs/reference/anthropic-backend-routing.md).

## Shadow Final-Review A/B — CLOSED 2026-07-28, verdict KEEP

Opt-in, observation-only 2nd final reviewer (`FINAL_REVIEW_SHADOW`); committed
default unset, paused locally on cost. Unset ⇒ byte-identical; never gates. Read
it **before any reviewer/model comparison** (three results that generalise):
[briefing](docs/research/final-review-shadow-adjudication-briefing.md) ·
[plan](docs/plans/final-review-shadow-reviewer.md).

## Tiered-Recall Audit Pipeline

Discovery → Stage 0/1/2 alternative to the GPT 5-pass legacy audit; chooser
`AUDIT_TIERED_PIPELINE_ENABLED` defaults **off** (production runs legacy).
Enabling it, its shadow window, Phase 14:
[`tiered-recall-audit-pipeline.md`](docs/plans/tiered-recall-audit-pipeline.md).
Resident:

- **Execution eligibility is per-call, not env-global** (`allowTiered`): only
  `openai-audit.mjs`'s `main()` passes `allowTiered: true`, so tests and library
  callers can never spend. Both must hold before a provider is constructed.
- **"Window met" is epoch-gated, not eyeballed** (2026-07-26, after the 5th false
  green): `comparedRuns` counts only rows the collector stamped with the
  current `TIERED_SHADOW_CONTRACT_EPOCH`; pre-stamp rows are ineligible and the
  window restarts — re-collect, never backfill.

## Model Swap-In Evaluation Harness

`scripts/lib/model-eval/` answers "is this new LLM release worth switching to?" for
the auditor or adjudicator role. Playbook, tiers, recall-ceiling caveat, verdict
history: [`model-eval-harness.md`](docs/runbooks/model-eval-harness.md). Resident,
because they bind any measurement work:
- **A model swap is SYNCHRONOUS, never a background window**: run it when the
  model ships, adjudicate in the same sitting, verdict → `docs/research/`. Passive
  collection killed arm-eval and produced five false "window met" reads. Only
  intervention-over-organic-work earns a shadow; exactly two are open
  (tiered-pipeline, final-review 2nd gate). **Do not add a sixth collector.**
- **Evidence counts only if produced under the contract the stopping rule
  validates**: stamp `contractEpoch` **at the collector** and verify by match.
  Unstamped ⇒ ineligible, never "assume current"; bump on a meaning-changing fix
  and re-collect — **never backfill by date**, the relabelling that let the fifth
  false green through.

→ Design: [`docs/plans/model-swap-eval-harness.md`](docs/plans/model-swap-eval-harness.md).

## Local Weekly Maintenance Checks (opt-in)

Default-OFF local replica of the weekly maintenance checks, run from the pre-push
hook when overdue (`AUDIT_LOOP_WEEKLY_MAINTENANCE=1`; `npm run maintenance:status`)
— in THIS repo the only runner of the four store-backed checks, whose Actions
crons were deleted 2026-09-13. Enabling it, a stale heartbeat,
`runner:doctor`/`cadence:doctor`:
[local-maintenance-checks.md](docs/runbooks/local-maintenance-checks.md) ·
[workflow-cadence-doctor.md](docs/reference/workflow-cadence-doctor.md).
**Resident**: a cadence is OBSERVED, never trusted for having been configured, and
**`ok` means "the run did not fail", not "the thing it measures is current"** — so
a workflow skip branch emits `::notice title=audit-loop-no-measurement::<reason>`
(`lib/measurement-marker.mjs`); never grep the job log for it.

## Azure AI Foundry Work Profile

The **same** bundle in a corporate Azure tenant (restricted models), env-selected.
**Opt-in invariant**: the Azure path activates **only** when `AZURE_OPENAI_ENDPOINT`
is set; without Azure env vars, client construction and resolved models are
**byte-identical** to the public path. Seams: `createOpenAIClient({purpose})`,
`embedText()`, `azureConfig` in [config.mjs](scripts/lib/config.mjs). Dossier
(tenant setup, `AZURE_CLAUDE_ROUTE`, 401/404/429, quota):
[`azure-work-profile.md`](docs/runbooks/azure-work-profile.md).

**Four invariants that constrain any code reaching a provider**:

- **An availability gate must ask whether a ROUTE exists, not whether a public env
  var is set.** An `if (!process.env.OPENAI_API_KEY)` guard upstream of an
  Azure-aware seam is dead code on exactly the installs it was written for (tell: a
  **failure with zero latency**). Let ONE oracle answer
  (`lib/provider-availability.mjs`); use **`isClaudeAvailable()`, never
  `ANTHROPIC_API_KEY`**. An **omitted `azureRoute` ADOPTS the tenant's route**;
  pass `azureRoute: null` only where an id *means* the public service. Tests
  spawning such a CLI must scrub `AZURE_*`. Which voices /brainstorm runs is
  `defaultProviders()`, never a constant.
- **The deployment is CONSTRUCTOR-level route state, not a body field**: build
  `AzureOpenAI({endpoint, deployment, apiVersion})`, **never concatenate an
  operation path**, and never share one client across purposes.
- **An endpoint and the credential it is addressed with are ONE unit** — pass
  `azureConfig.claudeRoute` as `createAnthropicClient({azureRoute})`, **never a
  bare `baseURL`**. Assert on the **emitted request**, not the client config.
- **A deployment or resource switch is a DIFFERENT vector space** — provenance is
  `resolveEmbedProfile()`, and `arch:refresh` auto-promotes to a full re-embed.

## Cross-Skill Data Loop

Migration `20260419120000_cross_skill_data_loop.sql` closes the feedback loop
between the skills. Catalogue (9 tables, 3 columns, 6 views, the bandit reward
extension, the `recommend-skills` advisor):
[`cross-skill-data-loop.md`](docs/reference/cross-skill-data-loop.md).

**Design rule**: all cross-skill writes go through `scripts/cross-skill.mjs`, a
graceful no-op when the cloud store is off. Never hand-write curl POSTs in a
SKILL.md for these tables — the CLI handles auth, graceful no-op, git-derived
commit_sha and error normalisation.

## R2+ Audit Mode (Phase 1)

`--round >= 2` (with `--ledger`/`--diff`/`--changed`) enables three-layer defence
against finding churn: rulings injection, R2+ prompts, post-output suppression.
The **Adjudication Ledger** is two-axis — `adjudicationOutcome` ×
`remediationState`, written via `writeLedgerEntry()`. Changing suppression, a
rulings group or the existence gate: read
[`r2-audit-mode.md`](docs/reference/r2-audit-mode.md) first. Resident: a rulings
header claims only what its ruling ESTABLISHED, and hard-suppress keys on the
CONCERN, never on category text — an overstated header or fuzzed category
suppresses true positives silently.

## Architectural Memory — pre-fix consultation (MANDATORY)

[Architectural memory](docs/plans/architectural-memory.md) indexes every symbol in
this repo into the audit store with embeddings, so near-duplicates are findable
before new code is written. `/plan` consults it automatically — **but ad-hoc fixes
in Claude Code or Copilot bypass the planning skill entirely**, where most
architectural drift creeps in.

**Rule** — before writing a new function, class, hook, component, route, method or
constant as part of a fix or feature request, you MUST run
`node scripts/cross-skill.mjs get-neighbourhood --json` with `targetPaths` (files
you intend to touch), `intentDescription` (one line on what you are about to write)
and `k: 8`.

Then act on the recommendation column. **Three bands, and no absolute cosine
numbers — the cutoff is `μ + 3σ` over the repo's OWN embedding background**,
computed at `arch:refresh`:

- **`precedent`** — existing code occupies this space: open the named symbols
  **before** you write anything, then decide on the code whether to reuse, extend
  or write a sibling, and say which and why. The band does **not** decide that for
  you. `bandReason: above-floor-cluster` is the *strongest* duplication signal,
  not a weaker one.
- **`review`** — nothing rose above this repo's noise floor; proceed greenfield.
  **An uncalibrated repo (`bandReason: uncalibrated-repo`) bands `review` only**:
  honest, not degraded; run `npm run arch:refresh`.
- **`unscored`** — the symbol has **no embedding**, so nothing was compared. This
  is *absence of evidence*, not a weak match. Never read it as "checked and
  rejected".

The old `reuse`/`extend`/`justify-divergence` band names are **retired** — seeing
them means stale tooling. Band semantics and recalibration history:
[arch-memory-band-recalibration.md](docs/plans/arch-memory-band-recalibration.md).

**When NOT to consult**: bug fixes changing only an existing function's body (no
new symbol); trivial edits (typos, formatting, one-line conditionals); doc-only or
test-only changes (unless adding test helpers); cloud store offline
(`{"cloud": false}` — log an `arch:refresh` hint, proceed). `{"cloud": true, "repoRegistered": false}`
is NOT offline: the store is up and this repo has no row — nothing was compared, so run `arch:refresh`.

**The rule above is host-neutral and mandatory; the hook is Claude-Code-only
ACCELERATION, not cross-agent enforcement.** A
`> **Architectural-memory consultation**` callout means
`.claude/hooks/arch-memory-check.sh` fired — treat it as authoritative.
**Copilot, Cursor and every other host get no hook** — there you run the command
above by hand, and so must Claude when the hook didn't fire (a question that
became a fix mid-conversation). Trigger verbs, cost, cache and the disable flag:
[enforcement-mechanisms.md](docs/reference/enforcement-mechanisms.md)
§The two accelerators.

## Security incident memory — mandatory consultation

Companion to architectural memory. `/plan` auto-fires
`get-incident-neighbourhood` in Phase 0.5b — for ad-hoc fixes outside `/plan`,
consult it by hand before writing security-relevant code:

`node scripts/cross-skill.mjs get-incident-neighbourhood --json` with the same
`targetPaths` / `intentDescription` shape and `k: 3`.

**When to consult**: any change to auth flows, payment handling, input parsing,
logs that might carry sensitive data, external API calls with credentials, file
uploads, or any domain named in a `docs/security-strategy.md` incident. **NOT**:
UI tweaks, type-only refactors, test fixtures, doc-only or cosmetic edits.

If the response includes incidents with `mitigation-failing` or
`manual-verification-required` status matching your target paths, address them
explicitly in the design before proposing code. If `docs/security-strategy.md`
doesn't exist here, run `/security-strategy bootstrap` once to seed it; `/ship`
surfaces security-relevant commits in a one-line post-push reminder.

### Secret pre-write gate + audit trail (back-port from corporate kit)

`npm run security:refresh` gates every parsed incident before it reaches the DB
([secret-classifier.mjs](scripts/lib/security/secret-classifier.mjs)):
high-confidence secret shapes **REFUSE** (not indexed, non-zero exit — scrub
`docs/security-strategy.md` and re-run); low-confidence PII **auto-REDACTs** into
the stored row, and writes append to `security_strategy_events`. One
defence-in-depth invariant: the final-pass redactor is the gentle
`lib/secret-patterns.mjs`, deliberately **NOT** `sanitizer.mjs`, which
blanket-redacts any 20+ char token and would corrupt incident prose. Full kit:
[docs/plans/security/](docs/plans/security/).

## Quick-fix detection — two-layer architecture

**Philosophy**: nudge, not gate — root cause beats shortcut, explicit acceptance
beats a silent one.

<!-- host-contract: hook-rule; rule=quickfix-surfaced-before-done; portable=quickfix wave in /audit-code; accelerator=.claude/hooks/quickfix-scan.mjs -->

**The RULE is host-neutral; the hook is Claude-Code-only ACCELERATION** (same
shape as arch-memory above). *Rule*: a shortcut signature is surfaced to the
author before the change is called done — satisfied when EITHER layer ran.
*Portable path (all hosts)*: **Layer 2**, the `quickfix` wave in /audit-code, a
low-reasoning GPT pass for DESIGN-level shortcuts regex can't see; emits
`is_quick_fix: true`, gated by the `quickFix == 0` convergence threshold.
*Accelerator (Claude Code only)*: **Layer 1**,
`.claude/hooks/quickfix-scan.mjs` — pure-regex on every Edit/Write, emits a
`<system-reminder>`, NEVER blocks. Two layers because neither covers the other's
axis: mechanical-at-edit-time vs semantic-at-review-time. **Cadence is NOT
equivalent** — hook = every edit, wave = once per audit, so on Copilot a shortcut
is caught later and only in audited changes; say so rather than implying parity.
Signatures and opt-outs:
[enforcement-mechanisms.md](docs/reference/enforcement-mechanisms.md)
§The two accelerators · full spec:
[`brainstorm-quickfix-v1.md`](docs/plans/brainstorm-quickfix-v1.md) §B.

## Where enforcement lives — NOT in a `$PATH` wrapper

**Enforcement goes into the code that performs the action — host-agnostic and
fail-closed.** `assertDisposableDbUrl` is the pattern: the destructive suites
cannot run against a non-loopback DSN because **the code refuses**, on every host,
with no PATH and no hook. Its limit is the honest part — it covers only actions
that go through repo code, so a raw-shell gotcha ("never bare `git stash` in a
shared tree") has no interception point and stays prose on every host.

**A `$PATH`-wrapper layer — a `.bin/` prepended to `PATH` shadowing `git`/`npm` to
intercept dangerous invocations — was proposed for exactly that gap and REJECTED
2026-11-15**: machine/shell-global state (the retired-surface shape, §Skill Chain
invariant 2); `spawnSync('git', …)` resolves through PATH, so the gates' own
tooling would run through it and a bug in it reads as a clean gate; PATH shadowing
resolves differently in Git Bash, PowerShell and `cmd`; and it is invisibly
bypassable, so it is an accelerator at far higher blast radius. The four reasons
and the forcing question for the next such proposal:
[`enforcement-mechanisms.md`](docs/reference/enforcement-mechanisms.md).

## Requirements Layer — de-facto invariant ledger

A materialized view of the codebase's de-facto requirements — the invariants the
code already enforces. CLI `scripts/requirements.mjs` (`extract --files` →
`reconcile` → `index`); the **committed `.requirements/ledger.json`** is the single
persisted artefact (the index is derived in-memory). `/audit-code` injects a
`<requirements_rubric>` block when the ledger exists, and is unaffected when it
doesn't. Per-module detail and the `.requirements/` layout:
[`requirements-layer.md`](docs/plans/requirements-layer.md).

**Egress safety (resident)** — `extract --files` is user-supplied: every path is
repo-root-contained AND symlink-resolved before read; sensitive paths (and
sensitive symlink targets) are refused; bodies are secret-redacted.

## Personal config — keep it out of the public repo

This repo is **public on GitHub**, so the committed `.claude/settings.json` holds
only project-portable values — above all `permissions.additionalDirectories`,
whose empty-array placeholder is intentional. Never put a personal folder path
there. Per-developer overrides go in the gitignored
**`.claude/settings.local.json`**, merged on top automatically; copy
`.claude/settings.local.example.json` for the format.

## Scope discipline — pre-existing uncommitted changes

Uncommitted, unstaged, untracked or unpushed changes **unrelated to the current
task** are the user's working set — leave them alone. Scope expansion is the
failure mode this prevents; repo hygiene is a separate, explicitly requested task.

- **Stage by name only** — never `git add -A`, `git add .` or `git add -u`. Stage
  exactly the files you modified for the current task.
- **Never auto-commit** pre-existing state to "clean up" — that bundles unrelated
  work into your commit and corrupts blame/history.
- **Never auto-stash** unrelated work — stash conflicts on pop bite worse than
  the original mess.
- **Never `git rm --cached`** legacy tracked-but-gitignored files without an
  explicit user instruction; it ships to every collaborator and `git pull` does
  not reverse it.
- **Mention what you saw, once**: *"Heads-up: 3 unrelated unstaged files left
  untouched (foo.ts, bar.mjs, baz.json)."* Then move on.
- If the unrelated state genuinely blocks the task (a half-edited file you must
  also edit), stop and ask before touching it.

## Contracts across the prose↔code seam (no compiler runs here)

The single-oracle rule's worst case is the seam where the **producer is a
SKILL.md** — prose a model follows — and the **consumer is code**. Nothing
type-checks that, nothing errors, and the failure is silent both ways. Two
incidents produced the rules below, written up in
[`testing-doctrine.md`](docs/reference/testing-doctrine.md) §prose↔code seam: a
reader that matched **0 findings in all 7 live sessions** because the SKILL.md
said `severity` and every consumer read `code`, and a prompt asking for a field
the response schema forbade outright.

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
  the EMITTED schema (`z.toJSONSchema(...)` → `properties`/`required`), never of
  the Zod source: **a prompt that names a field is a claim about a contract you
  have not checked.** A required field must also be filled by every non-LLM
  constructor, so adding one is never a one-line change.
- **A hand-written annotated example in a reference doc is the same seam, one hop
  over** — `contract-and-bootstrap.md`'s JSONC example drifted from
  `VisualContractSchema` silently until `npm run visual-contract-doc:gate` compared
  both sides' `z.toJSONSchema(...)` key sets, in both directions, never the doc
  against the Zod source.

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
  process (INC-001 in [security-strategy.md](docs/security-strategy.md)).
- **Structured results, never bare throws.** [`vcs.mjs`](scripts/lib/vcs.mjs)
  returns `{ok:true,…}` or `{ok:false, error:{code,…}}` over a closed
  `VcsErrorCode` enum, of which `EXEC_FAILED` is the **only** retryable code.
  Likewise `runJsonLinesAsyncStrict` ([subprocess.mjs](scripts/lib/subprocess.mjs))
  hard-fails on parse errors by default — that closes the `.filter(Boolean)`
  silent-data-loss invariant, where dropped lines let a caller read a short list
  as a complete one.

Category lists, the 12-case diff-state matrix, both error enums and their exit
codes: [`sensitive-paths-and-vcs.md`](docs/reference/sensitive-paths-and-vcs.md).

## Verification discipline (cross-skill)

Eight rules, each led by its measurement. Canonical:
[`verification-discipline.md`](docs/audit/shared-references/verification-discipline.md),
synced into ten skills' `references/` by `sync-shared-audit-refs.mjs` and
byte-checked in `npm run check`. **Edit the canonical, never a copy.**

- **Pin a line number to the commit you read it at** — `path:120 (a4ec98da)`.
  *5 of 9* bad claims in one verified document were correct when written and
  decayed into wrong-but-**resolving** references. Cite append-newest-first files
  (`status.md`) by section header, never by line. `npm run docs:citations -- <doc>`
  (report-only, not in `check`).
- **Label figures `measured`/`derived`/`expected` and carry the command.** This
  file's own test row read `~5250 tests (~12s)` against a real 12,216 in 80s —
  *2.3x* and *6.7x* stale, and it is what you reach for when a run looks wrong.
- **A check is not trustworthy until seen to fail; when one fails, suspect the
  instrument first.** Red-then-green, one defect at a time; a before/after
  observation of a pre-existing defect is **not** a negative control. Six
  consecutive verification-script failures in one session were all instrument
  defects. `/audit-code` Step 4.5 and `/ux-lock` Step 2.5 own this.
- **Reproducing a figure is not verifying its attribution.** A 22.5% reduction
  reproduced perfectly while its stated cause was false — the parent already had
  the credited property, and the real mechanism was *92%* of the delta;
  `/investigate` Step 2.5 reports `figure` and `attribution` separately.
- **Promote a one-off check that mattered** — subject probe + negative control +
  vacuous-pass guard, with a disposition and a named retirement predicate:
  [contract-test-scaffold.md](skills/audit-code/examples/contract-test-scaffold.md).
- **Verify what the consumer receives, not what the producer sent.** `/ship`
  Step 6.8; `unverified` must name a concrete blocked prerequisite, never a bare
  "not applicable".

## Commit provenance trailers (`AI-*`)

`/ship` commits carry `AI-*` git trailers (`AI-Skill`/`AI-Models`/`AI-Gate`/…)
written ONLY by `ship-commit.mjs` and `ship-train.mjs` — **never hand-typed; the
`AI-*` namespace is reserved.** `AI-Gate` is `passed`/`converged` (verified against
the store) or `waived`/`not-run` (declared); **`passed` is rare by design** — never
hand-write `.audit/last-audit-run.json` or reorder a ship to chase it. Reading or
querying trailers, and gate refusals:
[`commit-provenance.md`](docs/reference/commit-provenance.md).

## Code Style

- ESM modules (`import`/`export`, not `require`)
- `process.stderr.write()` for progress logging (keeps stdout clean for JSON)
- `--out <file>`: JSON to file, 1-line summary to stdout
- Zod schemas define structured output contracts for all LLM calls
- Functions follow the `{result, usage, latencyMs}` return contract
- Operator docs: real values or PowerShell vars in CLI examples, **never `<angle-brackets>`** (PowerShell reserves `<` — unpasteable); render a `--worksheet`, not raw JSON

## Do NOT

- Use `_def.typeName` / `_def.shape()` (Zod 3) or `require()` — see §Dependencies
- Send `.env` or credential files to external APIs
- Use `import 'dotenv/config'` — cwd-only; import `lib/load-env.mjs` instead
- Create new Anthropic/OpenAI client instances per call — reuse the one from `main()`
- Hand-keep a "which files are code" extension list — derive from `file-taxonomy.mjs` ([contract](docs/reference/file-coverage.md))

## Accepted Technical Debt

These items were evaluated and deliberately accepted:

| Item | Rationale | Revisit trigger |
|------|-----------|-----------------|
| `atomicWriteFileSync` no fsync | CLI tool, not a database. Rename atomicity protects against process crash (the real failure mode). | Never — unless used in a daemon/server context |
| `atomicWriteFileSync` temp naming (PID+timestamp) | Collision requires same PID + same millisecond + same directory. Probability negligible. | Never |
| `readFileOrDie` process.exit(1) | Name is self-documenting. Only called from CLI entry points. | If ever called from a library context |
| `normalizePath()` lowercasing | Correct for Windows, and it is a MATCHING key. **Scoped 2026-09-06**: a path STORED for a reader to open takes `displayPathOf` — 138 rows named a real file in the wrong case. | Re-fusing the two key spaces |
| Module-global caches (`_repoProfileCache`, `_taskStore`, `_clientCache`) | Safe in CLI-per-invocation model. Each process starts fresh. Anthropic client cache uses effective-resolved env values so two unparameterised calls hit the same entry. `_resetClientCache()` available for tests. | If extracting as a library or running as a long-lived server |
| `anthropic-client.mjs` `_internals` test exports | Mirrors `file-io.mjs`, `shared.mjs` project pattern. Internal helpers (`buildPromptFromMessages`, `normaliseCliOutput`, `quoteWinArg`) need direct test coverage; underscore-prefix signals private. | If we adopt stricter export hygiene project-wide |
