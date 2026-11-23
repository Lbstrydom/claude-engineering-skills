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
>   (timestamps, HEAD shas) → gitignored.** Not source, not a pure function of
>   committed source: `.audit-loop/domain-deps-observed.json`, `dashboard/*.html`,
>   `docs/architecture-map.md` (`npm run arch:render`), `skills.manifest.json`, …
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
> non-trivial fork, reject BOTH cliffs: the **band-aid** (patch the symptom, or
> defer the real fix *because it's harder*) and the **over-engineering** (an
> abstraction / config / artifact no *current* requirement needs). Ask: *"what's
> the band-aid, what's the over-built version, and why is mine the smallest thing
> that's a true function of the problem?"* A `defer` is honest only as a true scope
> boundary or documented debt, **never because the correct fix is larger**.
>
> **Scope is decided by impact, not authorship (load-bearing test).** Do not dismiss
> a finding as "out-of-scope / pre-existing / not introduced by this change" when the
> change being shipped *depends* on the cited path: *does the correctness or
> stability of what I'm shipping ride on it?* If yes it is in-scope **for the
> fix/defer decision** even when pre-existing, and a silent defer is the band-aid.
> A pre-existing finding in a *changed* file is a yellow flag; a green suite only
> covers exercised paths. A `defer` must name the **independence** (the new code
> does not call/depend on the cited path); for a same-file finding, that it does not
> share the SAME column/constraint or the SAME transaction instance — sharing a
> table or a broader boundary is not sufficient. `/plan`, `/audit-code` and
> `/audit-plan` (Step 3) enforce both.

> **Moved detail**: text cut from this file lives verbatim in [agents-md-dossiers.md](docs/reference/agents-md-dossiers.md) under the same H2 heading; the stub left here keeps the rule.
> **Path-specific tripwires** live in `.claude/rules/<topic>.md` (Claude Code loads one
> when a matching file is read or edited) and its byte-identical twin
> `.github/instructions/<topic>.instructions.md` (Copilot), kept equal by
> `tests/path-scoped-instructions-twins.test.mjs`. Edit both, or neither.

## Project Overview

18 skills covering the quality lifecycle, planning through code audit to live UX testing and
shipping. Node.js, ESM only (`"type": "module"`); CLI scripts + skill files invoked by AI
coding assistants.

## Skill Chain

18 skills; 16 run in this order: **plan → audit-plan → *(implement)* → audit-code
→ ux-lock → deploy → the four UI lenses → ship**, with `/cycle` driving the chain and
pausing for human implementation. The four lenses are **disjoint** and run together on a
UI PR — click-test (page DOM) ∥ persona-test (journey) ∥ nav-audit (system IA) ∥
visual-audit (paint). `/fleet` sits beside the chain, coordinating concurrent sessions
cooperatively (`references/coordinator-playbook.md`); `/harness-retro` proposes checks
for failures recurring across sessions (propose, never apply).

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
> `/explain --history`, *claim* → `/investigate`).
> VS Code Copilot reads root `.mcp.json` directly and only forwards `.vscode/mcp.json` — keep the two mirrored when adding servers.

Every reference file has `summary:` YAML frontmatter that must byte-match the
parent SKILL.md's reference-index row, enforced by `npm run skills:check`
([format](docs/reference/skill-reference-format.md)). A skill MAY also carry a
colocated `gate-contract.json` binding a stated gate to its enforcing code+test
(never packaged/synced; no contract = `uncontracted`, not failed), validated by
`skills:check`/`gates:check` ([detail](docs/reference/gate-honesty.md)). Each
skill is a sibling — shared env vars and cloud audit store, distinct scopes.

> **AN UNMEASURED ROUND MUST NOT WEAR A CLEAN ROUND'S CLOTHES.** A round that lost
> every pass to Azure 429s printed `Verdict: INCOMPLETE | H:0 M:0 L:0`, exit 0 — one
> word from a clean audit — and the convergence test reads only those numbers, so
> `/cycle` converges and ships. Pinned: `formatAuditSummaryLine` refuses the
> counts-first shape for INCOMPLETE; `openai-audit.mjs` sets **exit 3** (1 means
> "the CLI errored"); `countFindings` folds INCOMPLETE into `failed`, so ONE
> predicate answers "is this round evidence". 429 is budgeted apart from a generic
> transient (`retryAttemptsFor`/`nextRetryDelayMs`); `describeLostWrites` flags a
> `42P10`-shaped error as **store schema drift**.
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

> **Upstream-owned — never patch the synced copy.** A failure in a consumer's
> `scripts/.claude-skills/**` file is an **UPSTREAM** bug: fix it HERE + re-sync. A local
> edit is gitignored (invisible to review), overwritten next sync, and leaves the bug live
> for every other consumer. Banner, drift backstops and the `.githooks/pre-push.local`
> recipe for repo-specific push gates (never the managed hook):
> [consumer-adoption.md](docs/runbooks/consumer-adoption.md).
>
> **Consumers are not all on ONE store**, so **an unasked question must never
> render as an empty result** — a single-store read is blind to a consumer. Fan out with
> `npm run upstream:queues` / `stores:drift`; name a store by `storeDescriptor`
> (fingerprint + consumers, never a hostname — this repo is public). **An EMPTY DSN env
> var is the AIR-GAP signal** (`airGapDbUrl`) — never "fix" it to fall through to
> `~/.audit-loop.env`. [Detail](docs/reference/consumer-repo-layout.md)
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

> **Sync code carries three path-scoped tripwires** that load when you touch
> `scripts/sync-*.mjs`, `scripts/lib/sync-*.mjs`, the install code or
> `.sync-overrides.json`/`.sync-receipt.json`: divergence is DECLARED and never reverted
> silently (the manifest hash, never HEAD, is the BASE) · the layout's single source of
> truth is [`sync-path-map.mjs`](scripts/lib/sync-path-map.mjs) · a consumer's package
> manager is [`package-manager.mjs`](scripts/lib/package-manager.mjs)'s answer, never a
> hardcoded `npm`. Text: [`.claude/rules/consumer-sync.md`](.claude/rules/consumer-sync.md)
> (Claude Code) = `.github/instructions/consumer-sync.instructions.md` (Copilot); other
> hosts: open it before editing the sync.

### CLI smoke contract (`--selfcheck-relocation`)

A CLI in `CLI_SMOKE_SET` implements the `--selfcheck-relocation` handler at the
head of `main()` (CI fails if one lacks it); library modules get an import-test in
[`relocation-guard.test.mjs`](tests/relocation-guard.test.mjs) instead. **The entry
guard itself is `if (isInvokedAsScript(import.meta.url))`**
([cli-entry.mjs](scripts/lib/cli-entry.mjs)) — never a hand comparison of
`process.argv[1]` with `import.meta.url`: Node realpaths one side only, so through a
symlink or junction the hand guard is false and the CLI exits 0 having run nothing (16 of
26 did, measured 2026-10-13). No smoke run goes through a link, so the census in
[`cli-entry-guards.test.mjs`](tests/cli-entry-guards.test.mjs) is what enforces it.
Snippet + current set: [consumer-repo-layout.md](docs/reference/consumer-repo-layout.md)
§CLI smoke contract.

**Adopting these skills in a new consumer repo** — the migration recipe and
`doctor` (one command over every adoption-friction class, ratcheted by
`npm run upstream:coverage:gate`): [consumer-adoption.md](docs/runbooks/consumer-adoption.md) §Diagnostics.

## Browser Tool Setup (persona-test)

`/persona-test` drives a real browser through a declared driver contract shared with `/click-test`: the host's built-in browser pane (`mcp__Claude_Browser__*`) is what most sessions use, and **Playwright MCP is the pinned, free, credential-less fallback**. Its first-time setup is `npx playwright install chromium`, or the server crashes silently and no tools appear. Windows override, BrightData: [mcp-tooling.md](docs/runbooks/mcp-tooling.md).

## Mermaid validation (for plan diagrams)

Validate a diagram with `mcp__mermaid__generate_mermaid_diagram` (`outputType: "mermaid"`, no render). `npm run plans:lint` (in `check`) blocks on ERROR `subgraph-as-edge-endpoint`: anchor the edge to a node inside the subgraph. [mcp-tooling.md](docs/runbooks/mcp-tooling.md).

---

## Dependencies (CRITICAL — check versions before flagging issues)

| Package | Version | Notes |
|---------|---------|-------|
| `zod` | **4.6.7** | Zod 4 API — NOT Zod 3. `_def.type` is a string (`'object'`, `'array'`, `'enum'`), NOT `_def.typeName` (`'ZodObject'`). `shape` is a direct property on object schemas, NOT `_def.shape()`. `_def.entries` for enums, NOT `_def.values`. |
| `openai` | **7.8.0** | v7 since 2026-08-09; `responses.parse()` + `zodTextFormat()` unchanged (live-verified 2026-09-03; later zod bumps CI-verified only) |
| `@google/genai` | ^2.19.0 | `responseMimeType: 'application/json'` + `responseSchema` for structured output |
| `dotenv` | 17.4.2 | Load via `lib/load-env.mjs`, never `dotenv/config` (cwd-only) |

## Architecture

**Do not hand-maintain a module tree here** — [`docs/architecture-map.md`](docs/architecture-map.md)
is the live, generated per-symbol index; an inline tree goes stale silently (the
one removed 2026-07-13 listed 2 test files against 100+ real). Layout:
`scripts/*.mjs` are CLI entry points, `scripts/lib/**` focused modules
(`shared.mjs` stays a backwards-compatible barrel), `tests/` the Node test-runner
suite, `.claude/skills/**` is generated from `skills/**`.

Per-module prose and the named patterns (adaptive sizing, semantic dedup,
atomic persistence, the closed Gemini loop, …) live in
[`audit-internals.md`](docs/reference/audit-internals.md) — condensed out
2026-07-20 having rotted, exactly what the rule above prevents.

### Testing

Run: `npm test` (Node.js built-in test runner — the suite under `tests/`).
**Measured 2026-09-04: 14,711 tests, 0 fail, 39 skipped, 9m16s** (`npm test`, on
a linked worktree). Carry the date and the command.

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
every push to `main` stay full). Consumers get none of this — wine and
storyline stay local-first. [Plan](docs/plans/ci-full-suite-actions.md) ·
[runbook](docs/runbooks/gate-cost.md) §6.

**A rerun may diagnose, never clear.** `ci-verdict` counts every attempt for the head sha, so a head that ever failed reads `failed` (`failed-then-rerun`, exit 4) even when a rerun is green; only a new commit clears it, never a retry, sleep or skip. [Plan](docs/plans/verification-lessons.md) §2.1.

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

Three tiers: blanket TDD is theatre at the LLM boundary, rigor pays at deterministic
seams ([`testing-doctrine.md`](docs/reference/testing-doctrine.md)). Resident: **Tier 3
is non-negotiable** — a change lands with its test in the **same commit** at two seams,
*(a)* **sensitive-path egress** (a leak ships credentials to a third-party LLM) and
*(b)* the **consumer sync / relocation contract** (a break ships silently to repos you
cannot observe).

#### Pre-ship empirical verify — for skills that assert on a live runtime

Static review cannot catch what only appears when a real browser renders real data
(a mid-theme-transition `getComputedStyle` read once *fabricated* a bug). **(1)** Any
skill driving a browser must run against
ONE real app before being called done; a field finding with a green repro routes
to a regression test + ONE focused review, never the adjudication loop.
**(2)** Freeze transitions AFTER the flip + `await document.fonts.ready`; an
empty/failed capture degrades to `unverified`, never "verified / 0 findings".
**(3)** **Audit your success paths** — ask of any green-emitting branch *"can this
return green without having checked anything?"*
→ [`pre-ship-empirical-verify.md`](docs/runbooks/pre-ship-empirical-verify.md).

## Model Resolution

All model-reading env vars pass through `resolveModel()` ([model-resolver.mjs](scripts/lib/model-resolver.mjs)). **Use a sentinel (`latest-gpt`, `latest-opus`, `latest-pro`, …), never a concrete id in new code.**
- Never drop `-preview` from a Gemini 3 id unverified (bare `gemini-3-flash` / `gemini-3.1-pro` 404).
- Never retry a 4xx except 429 (`classifyLlmError`). Rewrapping an LLM error, keep `err.status` and the provider's `error.message`.
- **OpenRouter**: always send `provider:{require_parameters,sort}` + `reasoning:{effort}`, or runs fail at random.
- **A model id carries its ROUTE** (`qwen3.8-max` vs `qwen/qwen3.8-max` bill differently): never normalise `source_model`. For the vendor family call `modelFamily`, never a head-of-string helper; a new vendor needs `VENDOR_ALIASES`.

→ [model-resolution.md](docs/reference/model-resolution.md).

## Memory-Health Gate

[memory-health-gate.md](docs/reference/memory-health-gate.md). **A new wave that emits control state needs a `control_marker_prefixes` sentinel** (matched on the detail-snapshot prefix, never the category), or the gate reads AMBER forever.

## Learning System (Phase 1)

[learning-system.md](docs/runbooks/learning-system.md). **`LEARNING_DISABLE=1` kills all learning + telemetry**; telemetry never crashes a run (flush failures spill to `.audit/learning-outbox/`); a plan accepts a v1 limit with `<!-- audit:accept-v1: <glob> :: <reason> -->`.

## Environment Variables

**Full table**: [`docs/reference/environment-variables.md`](docs/reference/environment-variables.md); Azure vars:
[`azure-work-profile.md`](docs/runbooks/azure-work-profile.md). `AUDIT_AUTHOR_TIER_HINT` is observation-only and must never route. Rows that constrain how you write code:

| Variable | Default | Load-bearing because |
|----------|---------|----------------------|
| `OPENAI_API_KEY` | — | The one **required** variable. Everything else degrades gracefully. |
| `AUDIT_DB_URL` | — | Postgres DSN for the store. Unset → **local-only mode**, not an error. Supabase: **Session pooler (5432)**, never the Transaction pooler. |
| `LEARNING_DISABLE` | — | `1` kills **all** adaptive-learning behaviour + telemetry in one variable. |
| `LEARNING_REPO_NAME` | — | Must be the **`owner/repo` slug** (matches `audit_repos.name`): a bare repo name silently misses the lookup (weekly-review sat broken in every consumer). `install.mjs`/`setup.mjs` derive it; don't hand-type it. |
| `FINAL_REVIEW_TIMEOUT_MS` | `270000` | **COUPLED** to `FINAL_REVIEW_HARD_DEADLINE_MS`: the watchdog floor is `2x timeout + 60000`, so 270s is the most the default admits — raise both together. Read via `finalReviewTimeoutMs()`; `finalReviewModelSpec()` owns the ONE default for `FINAL_REVIEW_MODEL`. |

## Postgres-Parity Store (M1–M4)

The cloud store talks to **Postgres directly via `pg`** (no supabase-js/PostgREST; Supabase vs self-hosted is
just a connection string). **Load-bearing invariants**:

- **Never use the dashboard as the routine migration path** — it reintroduces the
  silent drift the ledger exists to eliminate; make the source migration idempotent
  and retry `--migrate`.
- **`audit_runs.commit_sha` is HEAD at audit-capture time, not the commit
  containing the audited diff** (the parent on a dirty tree, the normal case).
  Use `audited_sha`/`audited_tree` for target identity; NULL on both means
  unverifiable, never guess.
  [Plan](docs/plans/audit-target-identity-commit-sha-correction.md).
- **Migrations stay schema-portable**: `parity:check-coupling` fails on any `<schema>.`
  qualification or non-core reference outside the recorded baseline.
- **`emit({ok:false})` sets a non-zero exit code** ([cli-io.mjs](scripts/lib/cli-io.mjs)).
  Without the coupling a CLI reports a failure in its envelope and exits 0, which
  every caller checking `$?` reads as success. Opt out only with
  `emit(env, {softFail:true, reason})` — the reason is **required** — and
  `npm run emit:exit:gate` ratchets the opt-out population, failing on growth AND
  on an unrecorded reduction.
  [Design](docs/plans/cross-skill-command-registry.md) §2b F4.
- **Six more tripwires load when you touch store code** (`scripts/lib/db/**`,
  `scripts/lib/store/**`, `supabase/migrations/**`, the DB suites, durable-write and setup files):
  Session pooler 5432 never 6543 · through the `serializeWriteParam` write seam pass jsonb
  raw and `pgArray` a `text[]`, never hand-`JSON.stringify` · every
  store write through `durableWrite` · a schema error is not an empty result · "disposable"
  is a loopback ALLOWLIST · bound an RPC at the caller. Text:
  [`.claude/rules/postgres-store.md`](.claude/rules/postgres-store.md) (Claude Code) =
  `.github/instructions/postgres-store.instructions.md` (Copilot); other hosts: open it
  before editing those paths.

→ Design: [`postgres-parity.md`](docs/plans/postgres-parity.md) + [`schema-coupling`](docs/plans/postgres-parity-schema-coupling.md). Operations (setup, drift CLI, break-glass atomic-apply): [`runbooks/postgres-parity.md`](docs/runbooks/postgres-parity.md).

## Anthropic Backend Routing

All Claude API calls go through one seam,
[`anthropic-client.mjs`](scripts/lib/anthropic-client.mjs); `CLAUDE_BACKEND`
switches transport for the calls it can serve faithfully (refusal rule below):
`sdk` (committed default, what an unset var resolves to) bills `ANTHROPIC_API_KEY`;
`cli` spawns `claude -p` on the Max 20x Agent SDK credit (**local status: `cli`**,
gitignored `.env`). Call sites use `createAnthropicClient()`, never
`new Anthropic()` — guarded by
[anthropic-client-migration.test.mjs](tests/anthropic-client-migration.test.mjs).

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

- **Forced tool-calling needs `{backend:'sdk'}` explicitly.** `cli` always spawns
  `claude -p --tools ''`, so a forced `tool_choice` once got a plain `text` block
  with **no error** (tiered-recall's discovery generator lost a whole shadow
  window); since 2026-11-15 the seam THROWS, so the pin is the fix, not the intent.
- **`max_tokens` is UNENFORCED on `cli`** — accepted and ignored, not merely
  unenforceable, so it is never a bound for cost or for parse safety.
- **Availability is the backend's own answer, never `process.env.ANTHROPIC_API_KEY`.**
  A raw env check skips a fully-available backend (4th instance, 2026-11-14:
  [summarise.mjs](scripts/symbol-index/summarise.mjs) emitted **null summaries for
  the whole symbol corpus** under `CLAUDE_BACKEND=cli` with no key). Ask
  `isClaudeAvailable()` where the ambient backend will serve the call, and
  `isClaudeAvailableFor('sdk')` at a PINNED site — the ambient answer is `true` on
  a keyless `cli` install, so a pinned site passed its gate then threw
  `ANTHROPIC_API_KEY required`.
- **`claude-trace` cannot meter the scripted cli backend** (it corrupts the JSON
  envelope on stdout). Use the backend's own self-reported `cost_usd`.

→ Backend table, cost telemetry, migration pattern, call sites, `npm run anthropic:ping`: [`docs/reference/anthropic-backend-routing.md`](docs/reference/anthropic-backend-routing.md).

## Shadow Final-Review A/B — CLOSED 2026-07-28, verdict KEEP

Opt-in 2nd final reviewer (`FINAL_REVIEW_SHADOW`, default unset, never gates). **Read the [briefing](docs/research/final-review-shadow-adjudication-briefing.md) before any reviewer or model comparison.**

## Tiered-Recall Audit Pipeline

`AUDIT_TIERED_PIPELINE_ENABLED` defaults **off** ([plan](docs/plans/tiered-recall-audit-pipeline.md)).
- **Eligibility is per-call** (`allowTiered`): only `openai-audit.mjs`'s `main()` passes it, so tests and library callers never spend. Flag AND eligibility must both hold before a provider is constructed.
- **"Window met" is epoch-gated, not eyeballed** (2026-07-26, after the 5th false
  green): `comparedRuns` counts only rows the collector stamped with the
  current `TIERED_SHADOW_CONTRACT_EPOCH`; pre-stamp rows are ineligible and the
  window restarts — re-collect, never backfill.

## Model Swap-In Evaluation Harness

[model-eval-harness.md](docs/runbooks/model-eval-harness.md). Binding on any measurement work:
- **A model swap is SYNCHRONOUS**: run it when the model ships, adjudicate in the same sitting, verdict → `docs/research/`. Only intervention-over-organic-work earns a shadow, and exactly two are open; **do not add a sixth collector.**
- **Stamp `contractEpoch` at the collector**; unstamped ⇒ ineligible; bump on a meaning-changing fix and re-collect, **never backfill by date**.

## Local Weekly Maintenance Checks (opt-in)

`AUDIT_LOOP_WEEKLY_MAINTENANCE=1` runs the weekly checks from pre-push when overdue: the **only** runner of the four store-backed checks here ([runbook](docs/runbooks/local-maintenance-checks.md); `runner:doctor`, `cadence:doctor`). A cadence is OBSERVED, never trusted for having been configured, and **`ok` means "the run did not fail", not "what it measures is current"**: a skip emits `::notice title=audit-loop-no-measurement::`; never grep the job log for it.

## Azure AI Foundry Work Profile

[azure-work-profile.md](docs/runbooks/azure-work-profile.md). **Opt-in only**: active only when `AZURE_OPENAI_ENDPOINT` is set; without it, clients and models are byte-identical to the public path. For any code reaching a provider:
- **An availability gate must ask whether a ROUTE exists, not whether a public env var is set.** An `OPENAI_API_KEY` check upstream of an Azure-aware seam is dead on Azure (tell: a failure with zero latency). One oracle, `lib/provider-availability.mjs`; `isClaudeAvailable()`, never `ANTHROPIC_API_KEY`. An omitted `azureRoute` ADOPTS the tenant's route; pass `azureRoute: null` only where an id means the public service. Tests spawning such a CLI scrub `AZURE_*`; /brainstorm's voices are `defaultProviders()`, never a constant.
- **The deployment is constructor state** (`AzureOpenAI({endpoint, deployment, apiVersion})`), never a concatenated path or a client shared across purposes.
- **Endpoint and credential are ONE unit**: `createAnthropicClient({azureRoute})`, never a bare `baseURL`; assert on the emitted request.
- **A deployment or resource switch is a DIFFERENT vector space**: provenance is `resolveEmbedProfile()`, and `arch:refresh` auto-promotes to a full re-embed.

## Cross-Skill Data Loop

[cross-skill-data-loop.md](docs/reference/cross-skill-data-loop.md). **All cross-skill writes go through `scripts/cross-skill.mjs`**; never hand-write curl POSTs in a SKILL.md for these tables.

## R2+ Audit Mode (Phase 1)

`--round >= 2` (with `--ledger`/`--diff`/`--changed`) adds rulings injection and ledger suppression; read [r2-audit-mode.md](docs/reference/r2-audit-mode.md) before changing suppression, a rulings group or the existence gate. A rulings header claims only what its ruling ESTABLISHED, and hard-suppress keys on the CONCERN, never category text, or true positives vanish silently.

## Architectural Memory — pre-fix consultation (MANDATORY)

[Architectural memory](docs/plans/architectural-memory.md) indexes every symbol with
embeddings, so near-duplicates are findable before new code is written. `/plan`
consults it automatically — **but ad-hoc fixes bypass the planning skill entirely**,
where most architectural drift creeps in.

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
  or write a sibling, and say which and why; the band does **not** decide that.
  `bandReason: above-floor-cluster` is the *strongest* duplication signal.
- **`review`** — nothing rose above this repo's noise floor; proceed greenfield.
  **An uncalibrated repo (`bandReason: uncalibrated-repo`) bands `review` only**
  (honest, not degraded): run `npm run arch:refresh`.
- **`unscored`** — the symbol has **no embedding**, so nothing was compared. This
  is *absence of evidence*, not a weak match. Never read it as "checked and
  rejected".

The old `reuse`/`extend`/`justify-divergence` band names are **retired** — seeing
them means stale tooling ([history](docs/plans/arch-memory-band-recalibration.md)).

**When NOT to consult**: bug fixes changing only an existing function's body (no
new symbol); trivial edits (typos, formatting, one-line conditionals); doc-only or
test-only changes (unless adding test helpers); cloud store offline
(`{"cloud": false}` — log an `arch:refresh` hint, proceed). `{"cloud": true, "repoRegistered": false}`
is NOT offline: the store is up and this repo has no row — nothing was compared, so run `arch:refresh`.

**The rule above is host-neutral and mandatory; the hook is Claude-Code-only
ACCELERATION, not cross-agent enforcement.** A
`> **Architectural-memory consultation**` callout means
`.claude/hooks/arch-memory-check.sh` fired — treat it as authoritative.
**Hosts without the hook get none** (Cursor; Copilot drops its output) — there you run the command above by hand, and so must Claude when the hook didn't fire (a question that
became a fix mid-conversation). Hook details:
[enforcement-mechanisms.md](docs/reference/enforcement-mechanisms.md) §The two accelerators.

## Security incident memory — mandatory consultation

**Before security-relevant code outside `/plan`** (auth, payments, input parsing, logs with sensitive data, credentialed calls, uploads, a `docs/security-strategy.md` incident domain), run `node scripts/cross-skill.mjs get-incident-neighbourhood --json` (`targetPaths`, `intentDescription`, `k: 3`). Not for UI tweaks, type-only refactors, fixtures or doc edits. Address any `mitigation-failing` or `manual-verification-required` incident on your paths in the design. No `docs/security-strategy.md`? Run `/security-strategy bootstrap` once.

### Secret pre-write gate + audit trail (back-port from corporate kit)

`npm run security:refresh` REFUSES a high-confidence secret (scrub `docs/security-strategy.md`, re-run) and auto-redacts PII. The final redactor is `lib/secret-patterns.mjs`, deliberately **NOT** `sanitizer.mjs`, which corrupts incident prose. [Kit](docs/plans/security/).

## Quick-fix detection — two-layer architecture

**Philosophy**: nudge, not gate — root cause beats shortcut, explicit acceptance
beats a silent one.

<!-- host-contract: hook-rule; rule=quickfix-surfaced-before-done; portable=quickfix wave in /audit-code; accelerator=.claude/hooks/quickfix-scan.mjs -->

**The rule is host-neutral; the hook is Claude-Code-only acceleration.** A shortcut signature is surfaced before the change is called done, by either layer: the `quickfix` wave in /audit-code (all hosts, `quickFix == 0`) or `.claude/hooks/quickfix-scan.mjs` (Claude Code, every edit, never blocks). The cadence differs, so on Copilot say so. [enforcement-mechanisms.md](docs/reference/enforcement-mechanisms.md).

## Where enforcement lives — NOT in a `$PATH` wrapper

**Enforcement goes into the code that performs the action**, host-agnostic and fail-closed (`assertDisposableDbUrl`); a raw-shell gotcha with no repo code in the path stays prose. **A `$PATH` wrapper shadowing `git`/`npm` was REJECTED 2026-11-15**: read the four reasons in [enforcement-mechanisms.md](docs/reference/enforcement-mechanisms.md) before proposing one.

## Requirements Layer — de-facto invariant ledger

The invariants the code already enforces: CLI `scripts/requirements.mjs`; the **committed
`.requirements/ledger.json`** is the single persisted artefact. `/audit-code` injects a
`<requirements_rubric>` block when it exists. Detail:
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
SKILL.md** (prose a model follows) and the **consumer is code**: nothing
type-checks it and the failure is silent both ways (a reader matched **0 findings
in all 7 live sessions**: the SKILL.md said `severity`, every consumer read `code`).
Incidents: [`testing-doctrine.md`](docs/reference/testing-doctrine.md) §prose↔code seam.

- **Before reading a field out of a model-authored payload**, grep the authoring
  SKILL.md for the field name. A docstring about "the real production shape" is
  a claim about mutable state — see verification-discipline §1b.
- **At least one fixture must be derived from a row actually in the store.** A
  hand-written factory encodes what the reader expects, the assumption under test.
- **One exported accessor owns the read.** A duplicate inline predicate in
  `cross-skill.mjs` let the drift survive: two spellings, nothing to compare them.
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
  hard-fails on parse errors by default: dropped lines (`.filter(Boolean)`) let a
  caller read a short list as a complete one.

Category lists, the 12-case diff-state matrix, both error enums and their exit
codes: [`sensitive-paths-and-vcs.md`](docs/reference/sensitive-paths-and-vcs.md).

## Verification discipline (cross-skill)

Eight rules, each led by its measurement. Canonical:
[`verification-discipline.md`](docs/audit/shared-references/verification-discipline.md),
synced into ten skills' `references/` by `sync-shared-audit-refs.mjs` and
byte-checked in `npm run check`. **Edit the canonical, never a copy.**

- **Pin a line number to the commit you read it at** — `path:120 (a4ec98da)`.
  Correct-when-written references decay into wrong-but-**resolving** ones (5 of 9 in one
  verified document). Cite append-newest-first files
  (`status.md`) by section header, never by line. `npm run docs:citations -- <doc>`
  (report-only, not in `check`).
- **Label figures `measured`/`derived`/`expected` and carry the command.** This
  file's own test row was *2.3x* and *6.7x* stale, and it is what you reach for
  when a run looks wrong.
- **A check is not trustworthy until seen to fail; when one fails, suspect the
  instrument first.** Red-then-green, one defect at a time; a before/after
  observation of a pre-existing defect is **not** a negative control. Six
  consecutive verification-script failures in one session were all instrument
  defects. `/audit-code` Step 4.5 and `/ux-lock` Step 2.5 own this.
- **Reproducing a figure is not verifying its attribution.** A 22.5% reduction
  reproduced perfectly while its stated cause was false;
  `/investigate` Step 2.5 reports `figure` and `attribution` separately.
- **Promote a one-off check that mattered** — subject probe + negative control +
  vacuous-pass guard, with a disposition and a named retirement predicate:
  [contract-test-scaffold.md](skills/audit-code/examples/contract-test-scaffold.md).
- **Verify what the consumer receives, not what the producer sent.** `/ship`
  Step 6.8; `unverified` must name a concrete blocked prerequisite, never a bare
  "not applicable".

## Commit provenance trailers (`AI-*`)

`AI-*` trailers are written ONLY by `ship-commit.mjs` / `ship-train.mjs`; **never hand-type them**. `AI-Gate: passed` is rare by design: never hand-write `.audit/last-audit-run.json` or reorder a ship to chase it. [commit-provenance.md](docs/reference/commit-provenance.md).

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
