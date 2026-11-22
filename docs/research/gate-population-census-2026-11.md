# Gate population census — 2026-11-22

**What it is.** The first look at every gate in this repo as one population: what each enforces, where it runs, what it costs, and which ones overlap, can go green having checked nothing, are wired nowhere, or dominate push time. **When you need it.** Before adding a gate or ratchet, before anyone proposes removing one, and when pre-push cost is discussed. Evidence is pinned to commit `b52a77f1` (main at census time); line numbers decay, so re-grep before acting.

**Method / limits.** Enumeration is derived from `package.json` (`check` expanded transitively: 41 scripts, 39 in `check:static` plus `test`), `.githooks/pre-push`, `.github/workflows/*.yml`, `scripts/gate-contracts/*.json` (24 contracts + `_exemptions.json`) and `skills/*/gate-contract.json` (18). Timing comes only from data the repo already holds (`docs/runbooks/gate-cost.md`, `scripts/lib/guards-preflight.mjs` `DECLARED_SLOW_GATES`, `.test-tiers.json`, `gh run view --json jobs`). **Per-gate timing is NOT measured for 37 of the 39 static gates**: the repo records only a 2026-10-13 aggregate (~100 s for 31 static gates on a loaded machine, i.e. ~3 s each) and two individual figures. A quick attempt to time six gates in this linked worktree was discarded: the worktree has no `node_modules`, so the exit codes could not be trusted (sandbox-honesty rule). Figures labelled `measured` carry their source; the rest are `derived`.

---

## 1. The population

### 1.1 Where each runner sits

| Runner | What it runs | Cost (source) |
|---|---|---|
| Pre-push, **both tiers** | `npm run check` in a clean-checkout sandbox: all 39 `check:static` gates, then `npm test` (`.githooks/pre-push:401-418`, `scripts/prepush-check.mjs`). Branch tier (`.test-tiers.json` `defaultTier: "branch"`) skips only unreached heavy test files; **static gates are identical in both tiers** (`gate-cost.md` §6, "run in every local push, in both tiers") | static ≈ 100 s for 31 gates (measured 2026-10-13, loaded) + `db:suites:gate` 72 s + `gates:poison` 64 s (both measured 2026-10-13); `npm test` 962 s local full (measured 2026-10-14) |
| Pre-push, working-tree step | `check-stale-skill-surface.mjs --gate` (`.githooks/pre-push:268`), run **again** inside `skills:check` | small, unmeasured |
| CI `full-suite.yml` | `npm test` only, PRs + pushes to main, ubuntu | 18–23 min wall (measured, runs 44978445037: 02:58→03:16 = 18 m 57 s; 44976708882: 23 m 23 s); 563 s in the 2026-10-14 plan figure |
| CI `postgres-parity.yml` | `unit` + `db-suite` jobs, path-filtered | `unit` 20 s, `db-suite` 61 s (run 44978445043) |
| CI `release.yml` | `npm test` on tags | tags only |
| CI `model-freshness.yml` | weekly cron model-catalog check | n/a to pushes |
| Local weekly maintenance | opt-in (`AUDIT_LOOP_WEEKLY_MAINTENANCE=1`) | n/a to pushes |

**Key structural fact:** the 39 static gates run **only locally**; CI never runs them ("The static gates are NOT in CI", `gate-cost.md` §6). So a PR's static-gate evidence is the author's push, not CI.

### 1.2 The 39 static gates (the `check:static` chain)

Grouped by what they guard. "Pill" = a poison-pill contract in `scripts/gate-contracts/` (negative control run by `gates:poison`); "Exempt" = declared in `_exemptions.json` with a reason.

| Group | Gates | Pill / exempt |
|---|---|---|
| Docs and prose | `context:check`, `docs:check`, `docs:refs:gate`, `docs:synced-links:gate`, `docs:architecture-intent:check`, `plans:status`, `plans:index:check`, `plans:lint`, `npm-args:gate` | pill: context, docs-synced-links, architecture-intent, plans-index; exempt: docs:check, docs:refs:gate, plans:status, plans:lint, npm-args |
| Generated-artifact freshness (Category B) | `requirements:map:check`, `bundle:deps:check`, `checklist:gen:check`, `skills:check` (7 commands inside) | all pilled except the exempt members of `skills:check` |
| Skills | `skills:consumer-refs:gate`, `skills:size:gate` (+ inside `skills:check`: refs, descriptions, frontmatter, shared-refs, regenerate, gate-contracts, stale-surface) | pill: consumer-refs, size |
| Ratchets / drift-only | `knip:gate`, `size:ratchet:gate`, `windowed-views:gate`, `stdout:flush:gate`, `emit:exit:gate`, `own-model:coverage:gate`, `gitignore:policy:gate`, `status:integrity:gate`, `upstream:coverage:gate`, `upstream:reconcile:gate` | pill: all but knip, status:integrity, upstream:reconcile |
| CLI hygiene | `cli:flags:gate`, `help:readonly:gate`, `anthropic:pin:gate`, `mcp:parity:gate`, `visual-contract-doc:gate` | pill: help-readonly, anthropic-pin, mcp-parity, visual-contract-doc; exempt: cli:flags |
| DB / store | `parity:check-coupling`, `db:check-rls:gate`, `db:enrolment:gate`, `db:suites:gate`, `on-conflict:check`, `efficacy:check` | pill: parity-coupling, db-enrolment; exempt: db:check-rls:gate, db:suites:gate, on-conflict, efficacy |
| Graph / worktree | `arch:coverage-gate`, `worktree:preflight:gate` | pill: worktree-preflight; exempt: arch:coverage-gate |
| Meta | `gates:poison` (runs every pill), `skills:check` → `check-gate-contracts.mjs` | exempt (overrides) |

Skill-level contracts (`skills/*/gate-contract.json`, 18) are a different layer: they bind a sentence stated in AGENTS.md/SKILL.md to its enforcing code + test (`statedIn`) and are validated by `skills:check` → `gates:check`. They add no runtime cost.

### 1.3 npm scripts that look like gates but are not in `check`

All 31 gate-shaped scripts outside the chain were read. **None is an orphan in the "claims to enforce, wired nowhere" sense**; each is one of: a `--json`/`--sarif` variant of a chained gate (`context:check:json`, `docs:check:json`, `db:check-rls:json`, `plans:lint:json`), an operator diagnostic by design (`sync:check`, `sync:version-check` — consumer-side staleness, `audit:check-deps`, `skills:fit-check`, `stores:drift`, `cache:check`, `checklist:pilot`, `fixture:verify`), a CI-only step (`models:check` → `model-freshness.yml`; `db:check-drift`, `parity:expected-schema` → `postgres-parity.yml`; `gate:provenance` and `skills:manifest:check` → workflows), or a looser sibling of a chained strict form (`parity:check-refs`, `parity:check-refs:strict` vs chained `parity:check-coupling`; `skills:check-surface` = the chained `--source-surfaces` mode). Wiring check: `node scripts/…` string match across `package.json` chain, `.githooks/pre-push`, `scripts/prepush-check.mjs` + lane/planless modules, and all five workflows.

---

## 2. Findings

IDs are stable for the coordinator's approval list. **L = loosening (needs Louis, own PR, one by one). T = tightening (may ship small, follow-up).**

### F1 — `efficacy:check` is a pure no-op in this repo (stated-not-held) — T or L (Louis chooses)

- Evidence: `package.json` `check:static` includes `npm run efficacy:check` → `scripts/efficacy-lints-check.mjs:20-21` `if (!config.enabled) process.exit(0); // silent no-op until a repo opts in`. The committed config is absent: `git ls-files | rg efficacy.*config` returns only `defaults/efficacy-lints.config.example.json`; `node scripts/efficacy-lints-check.mjs` run at `b52a77f1` prints nothing and exits 0 (reproduced). Default `enabled:false, gate:false` (`scripts/lib/efficacy-lints.mjs:54`). It is `_exemptions.json`-exempt on the grounds that it "degrades to skip", the **very property that makes it green without checking**.
- Why it matters: it occupies a line in `check` and the guards-preflight chain while never evaluating anything here; it reads as "efficacy lints pass".
- Proposal (choose one, Louis): **(a) T** make the unconfigured case print an explicit `efficacy-lints: NOT RUN (no efficacy-lints.config.json)` line on stderr (the "unmeasured is not clean" shape the repo already uses); **(b) L-1** remove it from `check:static` and keep it as an opt-in consumer diagnostic. (a) is the repo-consistent default.

### F2 — `arch:coverage-gate` has been report-only since 2026-07-18 (stated-not-held) — T

- Evidence: `.audit-loop/domain-map.json:946` `"enforce": false`, with `_comment_coverage` (line 940) "enforce:false ships first … for one cycle of real data". Four months on it is still false. With `enforce:false` the gate exits 0 on DEGRADED/UNVERIFIED (`scripts/arch-coverage-gate.mjs` — `exitCode === 0 && !config.enforce && (DEGRADED || UNVERIFIED)` branch). The sandbox correctly sets `ARCH_COVERAGE_REQUIRE_ENVELOPE=1` (`scripts/prepush-check.mjs:595`), so absence fails, but a degraded graph passes. AGENTS.md describes it as owning the exit code.
- Proposal: **T** decide the enforcement flip on data: run `arch:render` and read the verdict history; if the repo has been VERIFIED for the whole window, set `enforce:true` (a tightening, one JSON key, its own small PR). If not, record the reason in the file. Needs Louis only if the verdict is DEGRADED today.

### F3 — Pill-exempt gates with no dedicated failing-case test (stated-not-held) — T

`_exemptions.json` lists 19 check-chain commands without a poison pill. For most, the declared reason is sound (re-derived each run) and a dedicated test exists. Two have **no test that can make the gate fail**:

- `docs:check` (`scripts/check-docs-placement.mjs`): `git grep -l check-docs-placement -- tests` returns only `tests/fixtures/poison/stdout-flush-baseline-understated.json` (an unrelated fixture that lists every CLI). No test file exercises a root-placement violation. Exemption reason is that "there is no stale-artifact false-green to construct" — true of freshness, but the gate can still be vacuous (e.g. an allowlist that grew to admit everything).
- `efficacy:check`: only `tests/efficacy-lints.test.mjs` covers the library; the CLI wiring `if (!config.enabled) exit 0` is untested (see F1).
- Also thin: `arch:coverage-gate` (tests reach it only through `graph-coverage-lineage` and `prepush-sandbox-honesty`; the repo's own exemption cites "tests/gate-honesty.test.mjs (D6)").
- Proposal: **T** one small test per gate: `docs:check` over a throwaway tree with a stray `docs/foo.md` (red) vs a clean tree (green). Same shape as `tests/knip-gate.test.mjs`. Do not add pills; a test is cheaper and the exemption stays honest.

### F4 — Redundant double run of `check-stale-skill-surface` (overlap) — L (tiny)

- Evidence: `.githooks/pre-push:268` runs `check-stale-skill-surface.mjs --gate` against the working tree; `skills:check` (`package.json`) runs `check-stale-skill-surface.mjs --gate --source-surfaces` in the sandbox. The hook comment (§0.9) justifies the working-tree run (untracked debris is invisible to a clean checkout), and `--source-surfaces` checks committed content — they are **different predicates under one name**, not true duplicates. The overlap is only the shared `--gate` base.
- Proposal: **no action** (recorded so nobody "dedups" them). A removal would be a loosening and is not recommended.

### F5 — `db:suites:gate` and `postgres-parity.yml` `db-suite` run the same suites on two runners (overlap) — L (needs approval)

- Evidence: `scripts/db-suites-gate.mjs` header: runs `db-test-container.mjs suites` against an ephemeral local Postgres on every push (72 s, `DECLARED_SLOW_GATES`); `.github/workflows/postgres-parity.yml` `db-suite` job runs the same enrolled suites (61 s in CI, run 44978445043) on path-filtered PRs. The local gate exists because on 2026-07-20 the CI workflow had failed 20 runs silently (header of `db-suites-gate.mjs`), i.e. the redundancy is deliberate defence in depth, and `db:enrolment:gate` is the guard on both.
- Proposal: **L-2** (for Louis, not recommended now): make the local gate path-conditional the way the CI one is (run only if `scripts/lib/db/**`, `scripts/lib/store/**`, migrations or the enrolled suites change). This would cut ~72 s from most pushes but loosens a gate whose CI twin was silently dead once. Needs a CI-health signal first (e.g. `ci-verdict` for that workflow).

### F6 — CLI-hygiene gates share one scan family (overlap, partial) — no action

`cli:flags:gate`, `emit:exit:gate`, `stdout:flush:gate`, `help:readonly:gate` each walk `scripts/**` CLIs and share `find-stdout-exit-sites.mjs`/`cli-catalog`. They enforce **different predicates** (flags registered / failure sets exit code / exit drains stdout / `--help` is a read), each with its own baseline and pill (except `cli:flags`). I found no two enforcing the same predicate. The cost overlap (each parses the corpus) is a possible shared-pass optimisation, not a coherence defect; not proposed.

### F7 — Ratchet baselines at the high-water mark (coherence) — no action

`size:ratchet:gate` (scripts only) and `skills:size:gate` (skills markdown only) are disjoint populations with the same shape; `stdout:flush`, `knip`, `windowed-views` are drift-only in the same family. Consistent by design and documented (`docs/reference/ratchet-gates.md`). Mentioned because the question "do two ratchets overlap?" is answered **no**.

### F8 — Static gates never run in CI (coverage hole) — T/L (Louis, structural)

- Evidence: `gate-cost.md:268` "The static gates are NOT in CI (they need inputs a fresh clone lacks)". CI's `full-suite.yml` runs `npm test` only. So a `--no-verify` push, a push from a machine without the hook (hook = `core.hooksPath` per main checkout, memory `feedback_hooks_path_is_main_checkout`) or a coordinator-landed PR carries no static-gate evidence at all, and the "CI-green head" the coordinator pins to says nothing about the 39 gates.
- Proposal: a **T** (additive, small): a CI job running only those static gates that work on a fresh clone (the pill-contracted Category-B freshness gates — `plans:index:check`, `requirements:map:check`, `bundle:deps:check`, `checklist:gen:check`, `skills:check`, `docs:*`); declare per gate in `.gate-files.json` which are clone-safe, with a sandbox-honesty test that a clone-unsafe gate cannot join. This increases Actions minutes (budgeted by `tests/workflow-runner-labels.test.mjs`), so it is Louis's call, not an auto-PR.

### F9 — Cost outliers (top 5 by time per push)

Per push, all runners, **both tiers pay the static chain; full tier adds the whole suite**:

| Rank | Item | Cost | Label / source | Tier |
|---|---|---|---|---|
| 1 | `npm test` (full) | 962 s local; 563 s on CI ubuntu; 18–23 min CI wall in recent runs | measured (`gate-cost.md` §6; `gh run view` jobs for full-suite runs 44978445037 and 44976708882) | full tier + CI |
| 2 | `npm test` (branch tier remainder) | unmeasured; fleet/archive family was 57% of test time (`gate-cost.md` §1) and is what the branch tier skips | derived | branch tier |
| 3 | `db:suites:gate` | 72 s | measured 2026-10-13 (`guards-preflight.mjs:75`) | both |
| 4 | `gates:poison` | 64 s | measured 2026-10-13 (`guards-preflight.mjs:76`) | both |
| 5 | the other 37 static gates in aggregate | ~100 s ≈ 3 s each | measured aggregate 2026-10-13, 31 gates | both |

**What this says.** Outside the test suite, **two gates (136 s) are ~58% of the static chain's 236 s**, and both are verification-of-verification (`gates:poison`) or a duplicate of a CI job (`db:suites:gate`, F5). The "pre-push is slow because of many gates" premise is **not supported by the data**: the test step dominates every push by >4x (derived: 962 s / 236 s), and the fix that already worked is the tier (#214 halved the suite; the branch tier skips the fleet family). Gate count is a coherence cost (cognitive and maintenance), not a wall-clock one. **Unmeasured: the 37 individual static gates.** Proposal **T**: have `npm run check:static` (or `prepush-check`) print one per-step `gate <name> <seconds>` line (a timing wrapper around the existing `npm run` chain, no verdict change), so the next census is measurement instead of derivation. This is the only evidence gap that blocks a real cost decision.

### F10 — `gates:poison` is itself exempt, and is the second-slowest gate — L (needs approval)

- Evidence: `_exemptions.json` `gates:poison` is exempt with `policyOverride` (its pill would be a tmpdir with a tampered registry, "which `tests/gate-poison-pills.test.mjs` already constructs in-process", per its reason). It runs the **control and the poison** for each of the 24 contracts in temp repo copies (64 s).
- Overlap: the same predicates are exercised again by the contracts' `tests[]` (e.g. `size-ratchet-gate.json` lists `tests/file-size-ratchet.test.mjs` and `tests/gate-poison-pills.test.mjs`), which run in `npm test`.
- Proposal: **L-3** (not recommended, listed for completeness): run `gates:poison` only when `scripts/gate-contracts/**`, a contracted gate script or its fixtures changed, not on every push. Loosens the check that a gate which silently broke still turns red. The honest alternative is the cheaper **T**: add the changed-path trigger as an *additional* early run and keep the full push run.

---

## 3. Proposal register

| # | Type | Action | Needs Louis | PR |
|---|---|---|---|---|
| F1 | T (a) / L-1 (b) | `efficacy:check` prints `NOT RUN` when unconfigured, or is removed from `check` | choice only | own |
| F2 | T | decide `arch:coverage-gate` `enforce` from verdict history | if currently degraded | own |
| F3 | T | add failing-case tests for `docs:check` and the `efficacy:check` CLI wiring | no | one small PR |
| F4 | — | none (different predicates) | no | — |
| F5 | **L-2** | path-condition `db:suites:gate` like its CI twin | **yes** | own |
| F6, F7 | — | none | no | — |
| F8 | T | CI job for clone-safe static gates | yes (Actions budget) | own |
| F9 | T | per-step timing line in `check:static` | no | one small PR |
| F10 | **L-3** | path-condition `gates:poison` | **yes** | own |

**Loosenings, to list one by one for approval: L-1 (only if F1(b) is chosen), L-2 (F5), L-3 (F10).** None is implemented here. Tightenings F1(a), F3 and F9 are small and prepared as a follow-up on this branch only if the coordinator wants them; none is implemented in this commit.

## 4. Orphans and "is the population coherent?"

- **Orphans:** none. No gate-named script enforces a claim while wired into no runner (§1.3).
- **Stated-not-held:** F1 (clearest, reproduced), F2, F3. The repo's meta-gate (`gates:poison` + `_exemptions.json` with `forbiddenNewExemptions()`) already prevents new silent exemptions after 2026-07-31; F1 and F3 are older, exempt-by-reason entries whose reason ("degrades to skip") is exactly the failure shape.
- **Overlap:** no two gates enforce the same predicate. The real overlaps are *runner* overlaps (F5: local gate vs CI job; F10: poison run vs contract tests).
- **Biggest coherence gap is not too many gates but F8**: the gates are local-only, so CI-green says nothing about them.
