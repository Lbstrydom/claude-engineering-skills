# Plan: Consumer corpus honesty — the index, the round, and the ownership seam

- **Date**: 2026-09-04
- **Status**: Complete — implemented and audited. GPT `/audit-code` ×5 rounds
  (H:6→2→3→3→4), 27 findings accepted and fixed, 49 deferred with independence
  stated, 9 refuted by direct measurement. Stopped at the rigor cap in round 5:
  every remaining HIGH was a deferred-independent re-raise, two of them at their
  fifth. Gemini final gate ×2, `CONCERNS_REMAINING` both times, all 4 findings
  addressed or deferred with reasons — its first-round HIGH was the most
  valuable finding of the whole exercise (see §6).
- **Source**: a consumer report from `louis-strydom_wartsila/storyline` (Windows
  pnpm monorepo: Electron desktop app, several `services/*` and `packages/*`
  workspaces, self-hosted Actions runner; synced bundle at `8802550`). Four
  existing upstream reports are referenced by id below; the rest were found
  while implementing.
- **Reproduced before implementing**: every figure in §1 was measured against
  `c:\git\storyline` with the pre-change code. The consumer's own numbers were
  taken as a hypothesis, not a spec — which is how §1.2's stated cause turned
  out to be wrong (§1.2a).

---

## 0. The one theme

Every item here is an instance of **a check or a report that can succeed while
having measured nothing**. That is the exact failure mode this bundle's skills
preach against, and it was reachable in six of them at once. The fixes are not
a feature; they are the removal of six false greens.

Read alongside [`observed-graph-coverage-honesty.md`](observed-graph-coverage-honesty.md),
whose §7c closed this class **for the measurement spike** on 2026-07-22 — the
spike bound `dependency-cruiser` to *this* repo's install, which has no
`typescript`, silently disabling TS-aware parsing. That note concluded
production's `extract.mjs` was unaffected, and for ai-organiser it was. §1.2a
below is the same mechanism arriving through the other door: the *consumer's*
install, where production `extract.mjs` had no way to report it either.

---

## 1. What was measured

All figures `measured` (not derived, not expected) on 2026-09-04 against
`c:\git\storyline` at its then-current HEAD, using this repo's worktree at
`claude/symbol-index-corpus-fix-196b90`.

### 1.1 The walker indexed the filesystem, not the repo

Reports `5f3fa3ec-b485-468b-ad11-b59a1f1f74d1`, `7e6a5492-cabd-4a85-ab05-391be7519e24`.

`enumerateFiles` in [`scripts/symbol-index/extract.mjs`](../../scripts/symbol-index/extract.mjs)
walked against a fixed `SKIP_DIRS` name list and never consulted git.

| Reading | Value |
|---|---|
| Files walked | 5,158 |
| **Ignored-and-untracked** | **3,963 (76.8%)** |
| Largest contributor | `scripts/.claude-skills/` — 553 files, *this bundle* |
| Next | `.venv/Lib` 633, `tools/renderer-spike` (ignored subset), `.audit/*` 247 |
| Cost of asking git | 145ms, against a 175ms walk |

Consequences the consumer measured independently: of the 14 duplicate clusters
remaining after they had removed **all 68 of their own**, **all 14 were inside
the bundle** — so GREEN (`score <= threshold * 0.5`) was unreachable no matter
what they did to their own code. Their `samples.uncruised` opened with
`.venv/lib/site-packages/...` and `.audit/*.js`.

### 1.2 The layering graph was empty — but not for the reported reason

The consumer reported `isInternalEdge` discarding pnpm workspace edges, citing
`services/core/node_modules/@workbench/contracts -> ../../../../packages/contracts`.

**Measured: `nodeModulesPath: 0` of 2,668 cruised dependencies.** Not one edge
in that repo resolves through `node_modules`. A two-package pnpm fixture
(junction under a nested `node_modules`) confirms dependency-cruiser already
canonicalises the link: `resolved` came back as `packages/contracts/index.js`
with `dependencyTypes: ['undetermined','import']`, identical with and without
`resolveOptions.symlinks`. **The reported cause is falsified.**

### 1.2a The real cause: an extension list that asserts instead of asking

| Reading | Value |
|---|---|
| Modules cruised | 689 |
| …under `scripts/` (the bundle's own `.mjs`) | 658 |
| …`.ts` / `.tsx` | **0** |
| `allExtensions` availability in storyline | `.js .cjs .mjs .jsx` available; **`.ts .tsx .d.ts .cts .mts .vue .svelte` UNAVAILABLE** |
| `typescript` resolvable from storyline root | **no** (pnpm strict layout does not hoist it) |
| Eligible files with no parser (post-1.1 corpus) | **522 of 675 (77%)** — `.ts` 478, `.tsx` 44 |

`CRUISABLE_EXTENSIONS` in
[`scripts/lib/symbol-index/graph-coverage.mjs`](../../scripts/lib/symbol-index/graph-coverage.mjs)
listed `.ts`/`.vue`/`.svelte` as a **capability claim**. Half that list is
conditional on a transpiler being resolvable. The graph reported
`outcome: 'ok'` and `arch:drift` printed `Layering violations: 0` — a sentence
that reads as *no violations* and means *nothing was measured*. The consumer
had to write that sentence into their own runbook to stop someone quoting it as
a pass, and left `allowedDeps` deliberately unset rather than ratchet a blind
graph into a baseline.

**This repo has the same gap and cannot see it**: `allExtensions` reports `.ts`
unavailable here too, and it matters for exactly 5 files (test fixtures) out of
1,559 eligible — 0.3%. Invisible by construction.

Two smaller defects in the same loop:

- **3 unresolved specifiers were persisted as file paths.** `d.couldNotResolve`
  edges carry the raw specifier in `resolved`, so `@workbench/core/persistence`
  was written as though it were a file. Both of the consumer's `untaggedTo`
  attribution samples were bare specifiers.
- **1,594 edges belonged to the bundle**, not the consumer (measured after
  1.1's filter exists; before it, they were persisted as the consumer's graph).

### 1.3 A failed round rendered as a clean one

Under Azure OpenAI peak load, every pass in one round failed — two on a 90s
timeout, four on `429 The system is currently experiencing high demand` — and
the round printed:

```
Verdict: INCOMPLETE | H:0 M:0 L:0
```

and exited **0**. `H:0 M:0 L:0` is byte-identical to a clean audit apart from
one word, and `audit-loop.mjs`'s `isConverged` reads exactly those three
numbers. An agent chaining rounds — which `/cycle` does — converges and ships.

`RETRY_MAX_ATTEMPTS = 1` with `RETRY_429_MAX_DELAY_MS = 8000` is a retry policy
that cannot succeed against the condition it exists for: the provider is saying
*come back later*. (The consumer notes their contention was partly
self-inflicted — a concurrent `arch:refresh` saturating the same deployment —
which is a reason to back off further, not less.)

### 1.4 A standing, unnamed write loss

Present in all four of their audit runs:

```
[learning] syncBanditArms failed: there is no unique or exclusion constraint matching the ON CONFLICT specification
[durable-write] 18 written, 0 spilled, 1 lost — queue: 0 pending (oldest n/a), 4 unreplayable
```

The migrations here declare `bandit_arms_unique UNIQUE (pass_name, variant_id,
context_bucket)` and `20260718090000` even preflights it, so **their store is
behind the migrations** — a `42P10`, not a code defect. But `N lost` named no
writer and carried no remedy, so it read as noise on every run.

### 1.5 `arch:*` cannot run in anyone's CI

`skills:hydrate` resolves its source from `git rev-parse --git-common-dir`. In a
plain clone — what `actions/checkout` produces — the common dir **is** the
clone, so it takes the `main-checkout` branch and copies nothing, exits 0, and
`scripts/.claude-skills/` (gitignored) is not in the checkout either. Every
`arch:*` step then dies on a bare `MODULE_NOT_FOUND` with nothing connecting it
to the command that was supposed to prevent that. The consumer could only make
their scheduled workflow run by copying from a runner-local checkout named by a
repository variable — welding CI to one workstation, and making a
GitHub-hosted runner impossible.

### 1.6 Ownership is unanswerable offline

Three signals, each with a hole:

| Signal | Covers | Misses |
|---|---|---|
| ignored-and-untracked | `scripts/.claude-skills/**` | `.claude/hooks/**`, `.claude/skills/**` — consumers COMMIT these |
| content banner | most synced payload | the same two: a `SKILL.md` cannot carry one (frontmatter must be the first bytes), and the hooks do not — **verified against the live consumer** |
| `scripts/.sync-manifest.json` | everything | gitignored on both sides ⇒ absent from every fresh clone, i.e. from CI |

Measured in their duplication-policy verifier: **32 violations + 1 mixed-owner
triage with the manifest absent; 31 + 0 with it present.** The extra violation
is this bundle's own `readStdin` cluster across three of its hooks, reported to
the consumer as their code to fix. They cannot fix it.

Case is load-bearing: the manifest spells `SKILL.md`, their debt ledger cites
`skill.md`, and **six upstream-owned entries were classified as their own work**
until the comparison was case-folded.

### 1.7 Four smaller, well-evidenced items

- **`arch:duplicates --json` has no truncation signal**, and `--limit` defaults
  to 20. Their repo had **44 clusters**, so a naive call reported less than
  half with no indication. A policy gate over "all clusters" could only infer
  truncation from `clusters.length === limit` — correct, but unable to tell a
  complete result from an exactly-full page. (Their gate depends on the
  envelope's `refreshId` to bind a policy check to the snapshot CI just
  published — that must survive.)
- **`debt-resolve.mjs` is terminal-only.** Their ledger held 34 entries,
  **17 citing files the repo cannot edit** (`.audit-loop/expected-schema.json`
  ×8, per-skill `SKILL.md` ×9). `debt:review --local-only` ranked the
  eight-entry `expected-schema.json` cluster **second by leverage** — not a
  refactor target at all. The only available action *removes* the entry,
  deleting the sole record of a still-open defect. Report
  `e265d10b-cff1-444e-a18b-8585743644ee`.
- **`cycle-cluster-scope.mjs` refuses `.yml` in both directions** — as a
  declared scope path (`would not be admitted (extension)`) and as an
  undeclared edit (`out-of-scope edit`). Their plan's load-bearing deliverable
  was a GitHub Actions workflow, so that cluster could not be audited at all.
- **`arch:drift` prints `Commit: unknown`** while `arch:render` resolves a real
  sha for the same `refresh_id`.
- **The `@duplicate-justification` sweep excludes `tests/*`** silently. They
  derived both this and the "fewer than two unjustified files clears the
  cluster" property from the migration SQL rather than from any documentation.

---

## 2. Design

### 2.1 Ask what already knows

The unifying repair for §1.1 and §1.2a: **before a walk or an allowlist decides
what a repo contains, ask the thing that already knows.** Git owns ownership;
the parser owns its own capability. Both were being guessed by a constant.

- `enumerateFilesWithOwnership(repoRoot, restrictFiles, classify)` wraps the
  existing walker and filters through **one** oracle,
  [`scripts/lib/disowned-paths.mjs`](../../scripts/lib/disowned-paths.mjs) —
  which already carries the batched `git check-ignore --stdin -z` and its
  exit-code contract (`0` = some matched, `1` = none matched and is a *normal
  answer*, anything else including `128` is a real failure). No second
  implementation.
- The predicate is **ignored AND untracked**, not merely ignored: a repo that
  deliberately tracks a path under one of its own ignore patterns still owns it.
- Asked of the **candidates**, never of the repo — materialising the whole
  ignored universe means enumerating `node_modules` past `spawnSync`'s buffer.
- Degradation is **fail-open and loud**: outside a work tree (the duplication
  detector materialises files under a temp root) nothing is classified, nothing
  is excluded, and `degraded: true` says the corpus was *not verified* rather
  than confirmed clean.
- `enumerateFiles` stays the RAW walker. `observed-graph-discovery-spike.mjs`
  exists to measure what the walker sees *before* policy, so filtering there
  would change the thing the spike measures.
- `assessParserAvailability(eligible, availableExtensions)` is pure; the caller
  passes dep-cruiser's own `allExtensions`. `availableExtensions == null` ⇒
  `known: false`, `unparseable: null` — the absence of a measurement, never
  "everything is available".

**Rejected — the band-aid**: adding `.claude-skills` and `.venv` to
`SKIP_DIRS`. It fixes two known names and leaves the class open; a consumer
vendoring anything else rediscovers it. `SKIP_DIRS` keeps `.venv`/`venv`/
`__pycache__` purely as **walk-cost** pruning (a site-packages tree is a
readdir per directory for an answer git already has), documented as such so it
is never mistaken for the correctness mechanism.

**Rejected — over-engineering**: a new verdict reason for the parser gap.
`CoverageSchema` re-validates graph-verdict's rows 1–7 as *config-independent*,
and any threshold-shaped parser rule is config-dependent, so it would have to
sit below `zero_attributed` and never surface. The existing vacuity guards
already cover the extremes (a 100%-TS repo with no transpiler gets
`zero_cruised`). What was missing was the **cause**, not another verdict — so
`extraction.parser` names it, with the remedy, and the verdict stays
`below_floor`.

### 2.2 Three separable fixes for one false green (§1.3)

Any one alone leaves the failure reachable:

1. `formatAuditSummaryLine` refuses the counts-first shape for INCOMPLETE and
   states *how many of how many passes produced output*. `_passes_total` is the
   denominator; without it `_failed_passes` cannot distinguish "2 failed" from
   "2 of 2 failed". Absent denominator prints `total attempted unknown`, never a
   guess.
2. `openai-audit.mjs` sets **exit 3** — not 1, which already means "the CLI
   itself errored" on every other exit path in that file. Set at the CLI
   boundary, **not** in `printAuditResult`, which the orchestrator also calls: a
   test importing `runMultiPassCodeAudit` would otherwise inherit the exit code
   and fail its own runner.
3. `countFindings` folds INCOMPLETE into its **existing** `failed` flag, so one
   predicate still answers "is this round evidence". This is the load-bearing
   one: `audit-loop.mjs` swallows the child's exit code by design.

Retry policy: 429 is budgeted apart from generic transients, because they mean
different things. A 5xx is *that attempt broke*; a 429 is *come back later*.
Exponential with **full** jitter (`base + random() * window`, never a fixed
delay) so N passes rate-limited by one deployment do not wake together and
re-collide. `Retry-After` beats any curve we invent, clamped so a hostile
header cannot wedge a run.

### 2.3 A committed ownership sidecar (§1.6)

`scripts/.sync-owned.json`, written by every sync, listing managed destination
paths and **nothing else** — no digests, no clock, no sha. That makes it a
**category-B** artifact under AGENTS.md's generated-artifact policy: two builds
of one input are byte-identical, so it is committable without churn, and it
changes only when the managed path set changes — a real, reviewable event.

**Rejected**: un-gitignoring `scripts/.sync-manifest.json`. Its `generatedAt` +
`commitSha` are exactly the volatile provenance that put it in category A.

`createUpstreamOwnershipOracle` unions the sidecar with git-ignore state and
case-folds, because Windows and macOS filesystems do. Degraded only when
**neither** source can speak; answering `false` there is the conservative
direction, since over-claiming upstream ownership silently excuses a repo's own
defects.

### 2.4 Scope decisions taken deliberately

- **`.yml`/`.yaml` admitted to `PLAN_REFERENCE_EXTENSIONS`**, alongside
  `sql`/`json` — declarative, and already the kind of file a plan legitimately
  names. Given how much of what this bundle polices *is* CI configuration, a
  plan that cannot name a workflow file is a scope hole, not a safety property.
  Alternation ordering is owned by `toExtensionAlternation` (longest-first), so
  the list stays unordered.
- **`debt:review` partitions, it does not filter.** Upstream-owned entries stay
  visible (they are real debt someone must file) and stay out of leverage
  ranking (nobody here can refactor them). A **mixed** entry stays actionable —
  part of it can be fixed here — and an entry citing **no** file is this repo's
  by default, because absence of evidence must not read as someone else's
  problem.
- **`skills:hydrate` fails in a plain clone** rather than reporting a no-op.
  The primary remedy it names is `npx github:Lbstrydom/claude-engineering-skills .`
  — installing, which works on a GitHub-hosted runner. `--from` / `SKILLS_SOURCE`
  exists for a runner-local checkout, making that coupling deliberate rather
  than rediscovered.
- **`arch:duplicates` over-fetches `limit + 1`** to *detect* truncation instead
  of inferring it. `total` is `null` when truncated: the number is genuinely
  unknown, and reporting the page size as the total is the fabrication the field
  exists to prevent. `refreshId` is untouched.
- **`arch:drift` reads the snapshot's own `commit_sha`** from its `refresh_runs`
  row — not the refresh UUID (which mislabelled a UUID as a commit, round-1 H5)
  and not local HEAD (which can have moved since the snapshot).

---

## 3. Files

| File | Change |
|---|---|
| [`scripts/symbol-index/extract.mjs`](../../scripts/symbol-index/extract.mjs) | `enumerateFilesWithOwnership`; `unresolved`/`disowned` edge buckets; `availableCruiserExtensions`; `warnAboutParserGap`; `.venv`/`venv`/`__pycache__` walk pruning |
| [`scripts/lib/symbol-index/graph-coverage.mjs`](../../scripts/lib/symbol-index/graph-coverage.mjs) | `assessParserAvailability`; `EXTRACTION_EDGE_BUCKETS`; `parser` on the coverage record; defensive bucket sum |
| [`scripts/lib/coverage-schema.mjs`](../../scripts/lib/coverage-schema.mjs) | `parser` block; two optional edge buckets with defaults; `unparseable <= eligible` coherence check |
| [`scripts/lib/robustness.mjs`](../../scripts/lib/robustness.mjs) | `RETRY_429_*`; `retryAttemptsFor`; `retryAfterMs`; `nextRetryDelayMs`; `describeLostWrites` |
| [`scripts/lib/audit/llm-helpers.mjs`](../../scripts/lib/audit/llm-helpers.mjs) | per-category retry budget + delay; retry log names the budget in force |
| [`scripts/lib/audit/findings-pipeline.mjs`](../../scripts/lib/audit/findings-pipeline.mjs) | `formatAuditSummaryLine` |
| [`scripts/lib/audit/run-finalization.mjs`](../../scripts/lib/audit/run-finalization.mjs) | `_passes_total`; lost-write diagnosis lines |
| [`scripts/openai-audit.mjs`](../../scripts/openai-audit.mjs) | summary line; exit 3 at the CLI boundary |
| [`scripts/audit-loop.mjs`](../../scripts/audit-loop.mjs) | INCOMPLETE ⇒ `failed`; round banner; CLI entry guard + test exports |
| [`scripts/lib/schemas.mjs`](../../scripts/lib/schemas.mjs) | `_passes_total` |
| [`scripts/lib/sync-owned-sidecar.mjs`](../../scripts/lib/sync-owned-sidecar.mjs) | new — `buildOwnedSidecar`, `isUpstreamOwned` |
| [`scripts/lib/upstream-ownership.mjs`](../../scripts/lib/upstream-ownership.mjs) | new — `createUpstreamOwnershipOracle`, `loadOwnedSidecar` |
| [`scripts/sync-to-repos.mjs`](../../scripts/sync-to-repos.mjs) | writes the sidecar beside the manifest |
| [`scripts/skills-hydrate.mjs`](../../scripts/skills-hydrate.mjs) | `no-tooling-here`; `--from` / `SKILLS_SOURCE`; `resolveExplicitSource` |
| [`scripts/lib/debt-review-helpers.mjs`](../../scripts/lib/debt-review-helpers.mjs) | `partitionByOwnership` |
| [`scripts/debt-review.mjs`](../../scripts/debt-review.mjs) | ownership partition; upstream-owned section |
| [`scripts/symbol-index/duplicates.mjs`](../../scripts/symbol-index/duplicates.mjs) | `paginate`; `limit`/`returned`/`truncated`/`total`; CLI entry guard |
| [`scripts/symbol-index/drift.mjs`](../../scripts/symbol-index/drift.mjs) | passes the snapshot's `commitSha` |
| [`scripts/lib/store/arch/snapshots.mjs`](../../scripts/lib/store/arch/snapshots.mjs) | `getActiveSnapshot` returns `commitSha` |
| [`scripts/lib/plan-paths.mjs`](../../scripts/lib/plan-paths.mjs) | `yml`/`yaml` |
| [`skills/audit-code/SKILL.md`](../../skills/audit-code/SKILL.md) | the `tests/` pragma exclusion |
| `AGENTS.md`, [`docs/runbooks/consumer-adoption.md`](../runbooks/consumer-adoption.md) | the three resident invariants + the CI / sidecar recipes |

New tests: [`tests/symbol-index-corpus-ownership.test.mjs`](../../tests/symbol-index-corpus-ownership.test.mjs),
[`tests/audit-incomplete-round-honesty.test.mjs`](../../tests/audit-incomplete-round-honesty.test.mjs),
[`tests/sync-owned-sidecar.test.mjs`](../../tests/sync-owned-sidecar.test.mjs),
[`tests/arch-duplicates-pagination.test.mjs`](../../tests/arch-duplicates-pagination.test.mjs).

---

## 4. Acceptance criteria

1. **A gitignored-and-untracked file reaches neither the symbol index nor the
   import graph**, and the owned file beside it still does. Both halves proven
   red-then-green by reverting each filter independently — the index half and
   the edge half fail on different assertions.
2. **A tracked file matching an ignore pattern is still indexed.** The
   direction the guard must not fire in.
3. **Git being unable to answer degrades fail-open and says so** — `degraded:
   true`, `disowned: null` (nothing classified, not "nothing is disowned"), the
   unfiltered walk returned.
4. **A restricted run (`--files`/`--files-from`) never consults git.**
5. **Every dropped edge is counted.** `assertExtractionExhaustive` sums all six
   buckets and still fails when a filter has no bucket; it tolerates an edge
   object read back from an envelope written before a bucket existed (absent ⇒
   0, never `NaN`).
6. **The parser gap is reported with its remedy**, and unavailability that
   cannot be observed reads `known: false` / `unparseable: null`.
7. **`CoverageSchema` accepts both shapes** — new (with `parser` and the two new
   buckets) and legacy (without) — and rejects `unparseable > eligible`.
8. **An INCOMPLETE summary line cannot match the clean-line shape**
   `/^Verdict: \w+ \| H:\d+ M:\d+ L:\d+ \|/`, names *N of M passes*, and says
   `measured NOTHING` only when every pass failed. A real verdict's line is
   byte-identical to the pre-change format.
9. **An INCOMPLETE round cannot converge**, and a genuinely clean round still
   can. The counts on both are identical — that is the point.
10. **429 gets a strictly larger budget and a backoff clearing the old 8s
    ceiling**, never below base, never past the ceiling, jittered, with
    `Retry-After` honoured and clamped. The generic transient curve is
    unchanged.
11. **A lost write names its writer**, and a `42P10`-shaped error is called out
    as store schema drift with `--check-drift` / `--migrate`; a transient loss
    is not.
12. **A plain clone with no tooling fails**, naming the install command and
    `--from`; a plain clone *with* tooling is still the `main-checkout` no-op.
13. **The sidecar is byte-identical across builds** regardless of input order,
    contains no timestamp, records true case, declares case-insensitive
    comparison, and does not claim a consumer's own file.
14. **`partitionByOwnership` keeps a mixed entry actionable** and treats a
    no-file entry as this repo's.
15. **`paginate` distinguishes an exactly-full page from a truncated one**, and
    reports `total: null` when truncated.
16. **`npm test` green** and every deterministic gate in `check` green.

Out of scope, deliberately: fixing the consumer's `bandit_arms` schema (theirs
to migrate — §1.4); publishing the bundle as an installable package beyond the
existing `npx` path (§1.5's larger ask); a verdict reason for the parser gap
(§2.1, rejected with reasons).

---

## 6. What the audit found that the plan did not

Recorded because the pattern matters more than the instances.

**The retry fix was INERT until the Gemini gate caught it.** `_callGPTOnce`
rewrapped every non-abort provider failure as `new Error(msg)`, destroying
`.status` and `.headers`. Measured directly:

| error handed to `callGPT` | `classifyLlmError` | budget | `Retry-After` |
|---|---|---|---|
| the SDK's own 429 | `http-429`, retryable | 4 | 30 000 ms |
| the rewrapped one | `permanent`, **not** retryable | 1 | `null` |

So §2.2's enlarged 429 budget, the jitter and the `Retry-After` handling could
never fire from the audit's own call path — and neither could the **old** 8s
branch, which is why the consumer's round shows six 429 failures and not one
retry line. Acceptance criterion 10 would have been satisfied by unit tests
while the feature did nothing in production. The rewrap now carries
`status`/`code`/`headers`/`cause`, per AGENTS.md's own rule.

**Five instances of one class, in code written to remove that class.** A
comparison normalised on one side, or a validity rule spelled twice:
unsupported sidecar version (R2 M13) → non-string entry, fixed on one side only
(R2 M1 → re-raised R3 M6) → `./` stripped on the query side only (R4 M12) →
document-level validity decided separately (R5 M3/M14) → the gitignore half
still hand-spelled while the sidecar half delegated (Gemini gate). Each fix was
correct; none closed the class, because the class was **two predicates**. Closed
by making `isUsableSidecar` and `comparisonKey` the single oracles both halves
call.

**Three instances of "fixed the named one, left its sibling"**: the
`process.exit(0)` truncation (fixed in `main()`, missed in `--help`), the
`npm run` remedy (fixed in `skills-hydrate.mjs`, reintroduced in a new
`snapshots.mjs` message one round later), and a repo-binding guard added and
then not acted on (R2 H1 → R3 H1, a guard whose failure changed nothing). The
detector-first census is the answer to all three, and running it by hand found
the remaining `write-then-exit(0)` instances in `refresh.mjs` — filed, not
swallowed.

**One vacuous green of my own**: the sidecar determinism test passed because its
fixture contained no case-equivalent pair, so "first spelling wins" was never
exercised (R5 L1).

## 5. Known residue

- **This repo's own graph is still blind to 5 `.ts`/`.tsx` fixture files**
  (0.3% of eligible). Now *reported* rather than silent. Installing `typescript`
  as a devDependency would close it and make our dogfooding representative of a
  TS consumer; not done here because it changes this repo's own graph and
  belongs in its own change.
- **`AGENTS.md` is at 87,226 / 92,000 characters.** `context:check` passes but
  warns the next invariant will not fit. Condensing a dossier section to a
  `docs/` stub is the next move, not shaving these words.
- **`sync-target-path.test.mjs` is flaky under full-suite load** — it spawns a
  real sync whose npm dep-install hits `spawnSync ... ETIMEDOUT`, and the test
  then asserts on a `null` exit code. Passes in isolation (twice, including the
  new sidecar assertions, which are negative-control verified). Pre-existing
  infrastructure flakiness of that suite, not a regression from this change.
- **`skills-artifact-freshness-wiring` fails while the tree is dirty** — it
  compares `skills.manifest.json` against the *committed* `SKILL.md` and both
  are uncommitted. Clears on commit; the pre-push sandbox checks the commit.
