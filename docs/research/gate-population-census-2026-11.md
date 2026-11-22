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

### F1 — `efficacy:check` is a pure no-op in this repo (stated-not-held) — T, **DONE (F1a)**

> **Landed in this PR (coordinator-approved).** `scripts/efficacy-lints-check.mjs` now writes `efficacy-lints: NOT RUN (...) - nothing was checked` to stderr when unconfigured and keeps exit 0. The coordinator asked for a non-zero exit; that was **not** done because the script is synced to every consumer (`scripts/lib/sync-entry-lists.mjs`), none has a config, and exit 1 would block every consumer push, which is a loosening-in-reverse the owner did not approve. Tests: `tests/efficacy-lints-check-cli.test.mjs` (red→green seen by renaming the message). The derived requirement `REQ-behavioural-4da0a21d` ("without output") is about stdout, which stays empty. Removal (L-1) is untouched.


- Evidence: `package.json` `check:static` includes `npm run efficacy:check` → `scripts/efficacy-lints-check.mjs:20-21` `if (!config.enabled) process.exit(0); // silent no-op until a repo opts in`. The committed config is absent: `git ls-files | rg efficacy.*config` returns only `defaults/efficacy-lints.config.example.json`; `node scripts/efficacy-lints-check.mjs` run at `b52a77f1` prints nothing and exits 0 (reproduced). Default `enabled:false, gate:false` (`scripts/lib/efficacy-lints.mjs:54`). It is `_exemptions.json`-exempt on the grounds that it "degrades to skip", the **very property that makes it green without checking**.
- Why it matters: it occupies a line in `check` and the guards-preflight chain while never evaluating anything here; it reads as "efficacy lints pass".
- Proposal (choose one, Louis): **(a) T** make the unconfigured case print an explicit `efficacy-lints: NOT RUN (no efficacy-lints.config.json)` line on stderr (the "unmeasured is not clean" shape the repo already uses); **(b) L-1** remove it from `check:static` and keep it as an opt-in consumer diagnostic. (a) is the repo-consistent default.

### F2 — `arch:coverage-gate` has been report-only since 2026-07-18 (stated-not-held) — T, **measured, flip NOT landed**

> **Measured, then held back (audit M4).** In this worktree (head = origin/main `b52a77f1`) `npm run arch:render` reported `coverage VERIFIED` (1699/1719 files cruised, 98.8%; 2888/2888 attributable edges); with `enforce:true` and `ARCH_COVERAGE_REQUIRE_ENVELOPE=1` the gate printed `VERIFIED` and exited 0. **But the verdict is not a measurement of this head:** the envelope's coverage block carries `measuredAt` 2026-09-28 (`arch:render` reuses it; only `arch:refresh` re-extracts, and that writes the shared audit store, so it was not run here), and the pre-push sandbox copies the main checkout's envelope, dated 2026-09-20. Flipping `enforce` on a verdict that can be two months stale would make the gate judge the wrong graph. The flip stays a proposal, **prerequisite:** a fresh `npm run arch:refresh && npm run arch:render` in the main checkout showing VERIFIED, and a freshness bound in the gate (reject a `measuredAt` older than the push base), then `.audit-loop/domain-map.json` `coverage.enforce: true` (one key, its own small PR).

### F3 — Pill-exempt gates with no dedicated failing-case test (stated-not-held) — T, **DONE for `docs:check` and the `efficacy:check` CLI**

> **Landed:** `tests/check-docs-placement.test.mjs` (control green on an allowlisted root, red on a stray hand-written file, exit 2 on a missing `docs/`) and `tests/efficacy-lints-check-cli.test.mjs` (see F1). `arch:coverage-gate` remains thinly tested; unchanged.


`_exemptions.json` lists 19 check-chain commands without a poison pill. For most, the declared reason is sound (re-derived each run) and a dedicated test exists. Two have **no test that can make the gate fail**:

- `docs:check` (`scripts/check-docs-placement.mjs`): `git grep -l check-docs-placement -- tests` returns only `tests/fixtures/poison/stdout-flush-baseline-understated.json` (an unrelated fixture that lists every CLI). No test file exercises a root-placement violation. Exemption reason is that "there is no stale-artifact false-green to construct" — true of freshness, but the gate can still be vacuous (e.g. an allowlist that grew to admit everything).
- `efficacy:check`: only `tests/efficacy-lints.test.mjs` covers the library; the CLI wiring `if (!config.enabled) exit 0` is untested (see F1).
- Also thin: `arch:coverage-gate` (tests reach it only through `graph-coverage-lineage` and `prepush-sandbox-honesty`; the repo's own exemption cites "tests/gate-honesty.test.mjs (D6)").
- Proposal: **T** one small test per gate: `docs:check` over a throwaway tree with a stray hand-written file at the docs root (red) vs a clean tree (green). Same shape as `tests/knip-gate.test.mjs`. Do not add pills; a test is cheaper and the exemption stays honest.

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

### F8 — Static gates never run in CI (coverage hole) — T/L (Louis, structural) — **costed, NOT added**

> **Costing against `tests/workflow-runner-labels.test.mjs`.** The budget guard asks only for: every `runs-on` a standard runner (free for this public repo), no artifacts, no cache, a cancelling concurrency group on `full-suite.yml`, and **exactly one job in `full-suite.yml`** (the check name `full-suite` is pinned by the ruleset and the verdict reader). So minutes are not the obstacle: a new workflow with a standard-runner job fits without raising anything, and `full-suite.yml` must not be given a second job. **The obstacle is correctness, not budget:** which of the 39 gates pass on a fresh clone is unmeasured (`gate-cost.md` §6 says they "need inputs a fresh clone lacks"), and a job that runs a guessed subset can go green having read nothing, which is the exact sandbox-honesty trap. Adding it needs a per-gate clone-safe declaration plus one real CI run to prove each gate red-then-green, so it is left as a proposal. Estimated shape when approved: `npm ci --ignore-scripts` + the declared subset, ≈2–3 min on `ubuntu-latest` (derived: ~3 s per gate + install).


- Evidence: `gate-cost.md:268` "The static gates are NOT in CI (they need inputs a fresh clone lacks)". CI's `full-suite.yml` runs `npm test` only. So a `--no-verify` push, a push from a machine without the hook (hook = `core.hooksPath` per main checkout, memory `feedback_hooks_path_is_main_checkout`) or a coordinator-landed PR carries no static-gate evidence at all, and the "CI-green head" the coordinator pins to says nothing about the 39 gates.
- Proposal: a **T** (additive, small): a CI job running only those static gates that work on a fresh clone (the pill-contracted Category-B freshness gates — `plans:index:check`, `requirements:map:check`, `bundle:deps:check`, `checklist:gen:check`, `skills:check`, `docs:*`); declare per gate in `.gate-files.json` which are clone-safe, with a sandbox-honesty test that a clone-unsafe gate cannot join. This increases Actions minutes (budgeted by `tests/workflow-runner-labels.test.mjs`), so it is Louis's call, not an auto-PR.

### F9 — Cost outliers (top 5 by time per push) — per-gate timing line **DONE**

> **Landed:** the pre-push sandbox now runs the static gates one at a time (same order, same stop-on-first-failure as the `&&` chain) and prints `gate-time/v1 <gate> <s>s` per gate plus a closing `gate-time/v1 static total=… slowest: …` line (`scripts/lib/prepush-tier.mjs` `runTimedStaticGates`; falls back to `npm run check:static` unchanged when `package.json` is not a plain `npm run` chain). Observation only; tests in `tests/prepush-tier.test.mjs`. The next census can quote measured per-gate cost from push output.


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
| F1 | T (a) DONE / L-1 (b) open | `efficacy:check` prints `NOT RUN` when unconfigured (done); removal from `check` is L-1 | L-1 only | this PR |
| F2 | T, measured, held | `enforce:true` only after a fresh `arch:refresh` plus a staleness bound in the gate | no | own |
| F3 | T DONE | failing-case tests for `docs:check` and the `efficacy:check` CLI | no | this PR |
| F4 | — | none (different predicates) | no | — |
| F5 | **L-2** | path-condition `db:suites:gate` like its CI twin | **yes** | own |
| F6, F7 | — | none | no | — |
| F8 | T, not built | CI job for clone-safe static gates; fits the budget guard, blocked on a per-gate clone-safe proof | yes | own |
| F9 | T DONE | per-gate `gate-time/v1` line in the pre-push output | no | this PR |
| F10 | **L-3** | path-condition `gates:poison` | **yes** | own |

**Loosenings, to list one by one for approval: L-1 (only if F1(b) is chosen), L-2 (F5), L-3 (F10).** None is implemented here. Tightenings F1(a), F3 and F9 are implemented in this PR (coordinator-approved); F2 was measured but its flip is held (stale evidence), and F8 is costed and left as a proposal.

## 4. Orphans and "is the population coherent?"

- **Orphans:** none. No gate-named script enforces a claim while wired into no runner (§1.3).
- **Stated-not-held:** F1 (clearest, reproduced), F2, F3. The repo's meta-gate (`gates:poison` + `_exemptions.json` with `forbiddenNewExemptions()`) already prevents new silent exemptions after 2026-07-31; F1 and F3 are older, exempt-by-reason entries whose reason ("degrades to skip") is exactly the failure shape.
- **Overlap:** no two gates enforce the same predicate. The real overlaps are *runner* overlaps (F5: local gate vs CI job; F10: poison run vs contract tests).
- **Biggest coherence gap is not too many gates but F8**: the gates are local-only, so CI-green says nothing about them.
