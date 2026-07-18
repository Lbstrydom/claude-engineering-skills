# Plan: Observed-Graph Discovery Unification (evidence-layer architecture)

- **Date**: 2026-07-17
- **Status**: Draft — measured 2026-07-18 across all three repos (§3.1), and the
  results **moved the plan's premise**, not just its unknowns. #1 is **NOT**
  answered: an n=2 "yes" was refuted by ai-organiser (10 semantic diffs). The
  cause is bigger than (e) — **extensionless TypeScript imports resolve in
  NEITHER mode**, a second silent-blindness generator upstream of the
  `COMMON_SOURCE_DIRS` one this plan was written to fix. Design (e) cannot fix a
  resolution defect; fixing TS resolution is now a **prerequisite**, not a
  follow-on. #2 is unanswerable as written (cost does not track repo size, the
  measurement carries ~60% run-to-run spread, and the adversarial repo does not
  exist) — it needs a stated threshold, not a bigger repo.
  **Updated 2026-07-18 (evening)**: the two recommendations below were both
  acted on by [observed-graph-coverage-honesty.md](observed-graph-coverage-honesty.md),
  which shipped Phases 1-5 (Gemini APPROVE).
  - **§4 null-domain accounting — DONE.** The silent skip is now a counted,
    bucketed, surfaced drop. It was indeed higher value per unit of risk than
    (e), and it shipped while (e) remains blocked.
  - **#2 — SUPERSEDED by a runtime budget (§3.2)**, exactly the "stated
    threshold, not a bigger repo" this status called for. No longer a blocker.
  - **#1 — still the blocker, and now the ONLY one.** Extensionless TS
    resolution failure is unfixed; diagnosing it is that plan's §7c,
    deliberately off its critical path. (e) stays blocked on it.
- **Author**: Claude + Louis
- **Scope**: backend (`scripts/symbol-index/extract.mjs` discovery seam; syncs to consumer repos)

## Why this exists as a separate plan

It is the **follow-on to
[domain-map-reconciliation.md](domain-map-reconciliation.md) item 3**, which
ships a deliberate *interim* patch (adding `'tests'` to `COMMON_SOURCE_DIRS`).
That patch fixes one instance and leaves the generator intact — by design, and
knowingly.

This is a separate file **specifically so the follow-on survives**: `/ship`
archives any `Status: Complete` plan into `docs/completed/`, so leaving this
work as a section inside the reconciliation plan would file it away the moment
the reconciliation lands. The parent plan is free to complete and archive; this
one stays in `docs/plans/` until the work is actually done or explicitly
dropped.

## 1. The problem

`extract.mjs` hands dependency-cruiser a hardcoded `COMMON_SOURCE_DIRS`
allowlist (no `tests`), with a dead `if (targets.length === 0) targets =
[repoRoot]` fallback that only fires when a repo matches *nothing* on the list
— i.e. never, in the common case. The result is a **silent-blindness
generator**: any repo using `e2e/`, `spec/`, `cypress/`, `integration/`,
singular `test/`, or a monorepo layout gets a smaller import graph that reads
as authoritative. No warning. Our own `tests` domain — the largest in the repo
at 380 files — produced zero observed edges for months.

**Root cause is ownership, not the list.** Three walkers privately answer
"what is this repo made of?":

| Walker | Layer | Sees |
|---|---|---|
| `enumerateFiles` (extract.mjs) | symbol index | whole repo, minus `SKIP_DIRS` + extension allowlist |
| `listRepoPaths` (adapter-contract.mjs) | arch-intent inventory | whole repo via `git ls-files` ∪ untracked |
| `COMMON_SOURCE_DIRS` → dep-cruiser | **import graph** | an arbitrary convention allowlist |

Nothing reconciles them; nothing ever put their numbers side by side. That is
precisely how the reconciliation plan came to record "tests → 7 domains, 129
edges" (inventory layer) while the import layer saw **zero** — a
two-layer disagreement that silently corrupted a planning document.

## 2. Target design — (e) + (d)-as-assertion

Origin: `/brainstorm --with-gemini` session `1784284437663`, 2026-07-17
(GPT-5.6 + Gemini-pro + Claude). Full options table and rejected alternatives
live in the parent plan's "The discovery architecture" section.

1. **(e) Unified discovery** — feed the symbol layer's file inventory to
   dep-cruiser as its explicit target list, rather than letting it guess the
   repo layout. The layers then cannot disagree about what exists, and
   discovery stays independent of `domain-map.json`.
2. **(d) Coverage invariant, as a TEST not a warning** — *"every indexable
   source file is either cruised or has an explicit, recorded exclusion
   reason."*

**Both halves, or neither.** (e) alone is **unfalsifiable**: parity is a
guarantee by construction, so if the unified walker is itself wrong (bad
extension filter, a `.gitignore` rule swallowing a real source dir), both
layers are *identically* blind and the cross-layer disagreement that would
have exposed it is gone **by design**. The invariant is the half that would
have caught this bug.

> **Warning ≠ gate — the evidence is in this repo.** One reviewer argued (d)
> is "log-spam shifting burden to the consumer". That holds against a *log
> line* and collapses against an *assertion*. The dead `ship` rule
> (reconciliation item 9) survived exactly because its only signal was a
> dashboard warning nobody read; it was fixed the day it became a failing
> test. Do not implement (d) as a warning.

**Rejected — do not revisit**: deriving cruise targets from
`domain-map.json`. Unanimous across all three models. It makes evidence
contingent on intent — a domain the map forgets becomes a domain the graph
*cannot see* — destroying the independence that makes the observed layer worth
having. The observed graph exists to CONTRADICT declared intent.

## 3. Blocking unknowns — measure BEFORE building

**#1 is NOT answered — it was refuted at n=3 (see §3.1). #2 is SUPERSEDED by a
runtime budget (§3.2), and is no longer a blocker.** (e) is unimplementable if
#1 fails and unaffordable if #2 is bad.

> The "#1 is ANSWERED: yes" that stood at the top of this section was written
> when two repos agreed. The third refuted it. The header is corrected here
> rather than quietly, because a stale green summary above an accurate body is
> how a refuted conclusion gets re-adopted by whoever reads only the heading.

1. **Does dep-cruiser cleanly accept an explicit file list of ~3,000 paths?**
   Make-or-break for (e); a ~10-minute spike answers it. If it doesn't, the
   practical equivalent is cruising `repoRoot` with exclusions delegated to a
   real `.gitignore` parser rather than a hardcoded array.
2. ~~**What does a root/full cruise cost on a consumer monorepo?**~~
   **SUPERSEDED 2026-07-18 — replaced by a runtime budget (see §3.2).** The
   original framing required measuring a repo that does not exist, so it could
   never be satisfied. It is now a decidable gate, because the coverage
   contract that makes it decidable has shipped.

### 3.1 Spike results (2026-07-18)

Measured by [`scripts/spikes/observed-graph-discovery-spike.mjs`](../../scripts/spikes/observed-graph-discovery-spike.mjs)
(read-only; builds nothing). Re-run with `--repo <path>` for a new target.

**#1 was mis-framed, and the correction matters.** `extract.mjs` calls the
dependency-cruiser **JS API** (`cruise(targets, opts)`), not the CLI — an
in-process call takes a JS array, so the failure mode that "~3,000 paths"
implies (argv / command-line length) **cannot occur**. The real question is
whether explicit-file mode changes **resolution semantics**, which "did it
throw?" cannot answer.

| Target | M1 semantic diffs | M2 root cruise | Coverage delta |
|---|---|---|---|
| claude-engineering-skills | 0 | 0.95s · 921 modules · +2MB | 22 / 891 invisible (2%) |
| wine-cellar-app (consumer) | 0 | 4.1–5.6s · 2531 modules · +79–117MB | 23 / 2427 invisible (1%) |
| ai-organiser (consumer) | **10** | 6.9–11.2s · **485** modules · +215–309MB | **945 / 1389 invisible (68%)** |

> **Confirmed under `cwd == repoRoot` (2026-07-18).** The first measurements ran
> the spike from this repo with `--repo <other>`, which makes dep-cruiser emit
> cwd-relative (`../ai-organiser/src/…`) module paths — and `extract.mjs:336`
> drops `..`-prefixed edges, so the figures could have been artifacts. Re-run
> from inside each consumer: **every coverage number and every M1 verdict is
> byte-identical** (945/1389 and 23/2427). `path.resolve` had normalised the
> prefix away before the arithmetic. The timing spread widened slightly on the
> re-runs, which only reinforces #2 below.

- **#1 → NOT ANSWERED. An n=2 "yes" did not survive n=3.** The first two repos
  agreed, and this section previously recorded "#1 answered: yes, (e) is
  feasible" on that basis. **ai-organiser refutes it.** Do not restore that
  conclusion without re-measuring across all three.
- **The disagreement is NOT explicit-vs-directory — it is that resolution
  itself is failing.** Probed directly on `src/services/presentationIr/irToHtml.ts`
  (both the file and every import target are present in the explicit input list,
  and the repo has no tsconfig `paths` aliases):

  | mode | result |
  |---|---|
  | explicit file list | 10 deps, every relative TS import `couldNotResolve: true` |
  | root cruise | **0 deps for the same file** |

  Extensionless TypeScript relative imports (`../../core/result` →
  `src/core/result.ts`) resolve in neither mode. `cruiseOpts` in `extract.mjs`
  passes no `tsConfig` and no TS-aware `enhancedResolveOptions`, so a TS repo
  with extensionless imports under-resolves silently. This repo is `.mjs` with
  explicit extensions and never hits it.
- **Consequence for this plan's premise.** §1 diagnoses ONE silent-blindness
  generator (the `COMMON_SOURCE_DIRS` allowlist). There is a **second, upstream
  of it**: even for files the cruiser *is* handed, TS resolution fails. Design
  (e) feeds MORE files to a resolver that still cannot resolve them — it would
  raise ai-organiser's module count while leaving the edges wrong. **Unified
  discovery does not fix, and cannot fix, a resolution defect.** Fixing TS
  resolution is a prerequisite for (e) being worth building, not a follow-on.
  > Methodology note, twice-earned: the spike's first version counted every
  > differing edge as semantic and would have manufactured a blocker on repos 1-2;
  > corrected to partition semantic-vs-input by the edge's SOURCE file. That
  > partition is still incomplete — it does not classify by TARGET resolvability,
  > which is what this ai-organiser case turned out to be. Any re-measurement
  > must check `couldNotResolve` on both sides, not just edge-set equality.
- **#2 → still open, and now known to be UNANSWERABLE AS WRITTEN.** Three
  findings, each of which independently breaks the "measure a big consumer"
  framing:
  1. **Cost does not track repo size.** ai-organiser has **485** modules and
     costs *more* than wine-cellar-app's **2530** (6.9–11.2s vs 4.06s;
     215–309MB vs 117MB). Extrapolating by file or module count is invalid, so
     a 40k-file measurement would not generalise either.
  2. **The measurement is noisy.** Root cruises of the same unchanged repo:
     ai-organiser 6.9s / 7.7s / 11.2s (+215 to +309MB), wine-cellar-app 4.1s /
     5.6s (+79 to +117MB) — a ~60% spread on ai-organiser and ~37% on
     wine-cellar, with peak memory varying by a similar factor. Any threshold
     must be stated over repeated runs; a single number is not reproducible
     enough to gate on.
  3. **The adversarial case is not reachable.** There are exactly two consumers
     (`sync-to-repos.mjs`): wine-cellar-app and ai-organiser. Both are now
     measured. The "~40k-file `packages/` tree" is hypothetical — so "needs a
     real consumer measurement" cannot be satisfied, and gating on it blocks
     the plan indefinitely on a repo that does not exist.

  **The missing pass threshold, not the missing repo, is the real blocker** —
  and it is the one that can actually be fixed. Replace #2's framing with a
  stated budget over repeated runs on the largest ACTUAL consumer (plus an
  `arch:refresh` wall-clock regression budget), and #2 becomes decidable today.
  For a tool that ships to repos we will never see, the durable answer is
  runtime honesty rather than pre-measurement: a cruise that exceeds budget
  should report the graph as `unverified` (the capture-honesty pattern
  nav-audit v1.4 / visual-audit already use), never emit a smaller graph that
  reads as authoritative. §4 is the reporting channel that makes this possible.
- **§4 quantified.** The "observed but unclassified" problem is real and
  measurable today: 22 files here and 23 in the consumer are symbol-indexed but
  contribute **zero** observed edges with nothing warning — including that
  consumer's entire `extension/` tree (a browser-extension subsystem invisible
  to the import layer, because `extension` is not in `COMMON_SOURCE_DIRS`).

### 3.2 #2 restated as a runtime budget (2026-07-18 — the replacement)

Owned and delivered by [`observed-graph-coverage-honesty.md`](observed-graph-coverage-honesty.md)
Phase 6. §3.1 established that #2 as written is unanswerable: cost does not
track repo size, the measurement carries a ~60% spread, and the adversarial
40k-file consumer does not exist. Three findings, all pointing the same way —
**the missing pass threshold, not the missing repo, was the blocker.**

The replacement is the one §3.1 itself argued for: *for a tool that ships to
repos we will never see, the durable answer is runtime honesty rather than
pre-measurement.* That is now built, not aspirational:

| Was | Is |
|---|---|
| "measure a hypothetical monorepo before shipping" | `maxCruiseMs` (soft, default 120s) → verdict `degraded` / `budget_exceeded` |
| an unstated pass threshold | `coverage.floor` (default 0.90) → `degraded` / `below_floor` |
| a cruise that never returns | `hardTimeoutMs` (default 300s), enforced at the `refresh.mjs` process boundary → `unverified` / `extraction_timeout` |
| a smaller graph that reads authoritative | `arch:coverage-gate` exit 2; dashboard 🟡; never green |

**#2's gate condition, stated so it can be checked:** a cruise on the largest
ACTUAL consumer must complete inside `hardTimeoutMs` **over repeated runs**
(≥3, because §3.1 measured a ~60% spread and a single number is not
reproducible enough to gate on), and report `verified`. Both current consumers
already satisfy this by a wide margin — the slowest observed root cruise was
11.2s against a 300s hard timeout, ~27× headroom.

**Why this is not merely deferring the question.** The original #2 asked "will
(e) be affordable on a repo we have not seen?" — unanswerable by construction.
The runtime budget answers the question that actually matters on that repo:
*if it is not affordable there, does the tool say so, or does it quietly emit a
smaller graph?* It now says so, on that repo, at run time, with a named reason.
A budget overrun degrades the verdict; it does not silently shrink the graph.

**What this does NOT unblock.** (e) remains blocked on **#1**, which §3.1
refuted at n=3: TS resolution fails upstream of discovery, so feeding more
files to the resolver would raise the module count while leaving the edges
wrong. Diagnosing that is
[`observed-graph-coverage-honesty.md`](observed-graph-coverage-honesty.md) §7c,
deliberately off that plan's critical path. **Removing #2 as a blocker does not
make (e) ready — it removes an unsatisfiable gate so the real blocker is the
only one left.**

## 4. Independent first step — null-domain accounting

> **DELIVERED 2026-07-18** by [`observed-graph-coverage-honesty.md`](observed-graph-coverage-honesty.md)
> (Phases 1-5, Clusters A-B, Gemini APPROVE). The silent skip at
> `observed-deps.mjs` is now a counted, bucketed drop — `untaggedFrom` /
> `untaggedTo` / `untaggedBoth`, exhaustively reconciled against the persisted
> edge count, surfaced in the envelope, on stderr, in the dashboard, and in the
> gate. The prediction below held: this was higher value per unit of risk than
> (e), and it shipped while (e) is still blocked on #1.
>
> Live on this repo: `31 domains, 135 edges · dropped: 1 untagged, 489
> same-domain · extraction 876/898`. The section is kept for its reasoning, not
> as outstanding work.

**Do this first; it does not depend on §2 or §3.** Files resolving to a null
domain are currently *skipped silently* when the observed graph is built. So a
consumer with no `tests/**` rule **recreates this exact blindness one layer
down, after we've fixed it here**. Report them as **"observed but
unclassified"** rather than dropping them.

Small, independent of the discovery redesign, and it converts a silent skip
into a signal — arguably higher value per unit of risk than (e) itself.

## 5. Non-goals

- Not a blocker for the reconciliation plan. Item 3's interim patch is correct
  and self-contained; this plan changes no map entry item 3 writes.
- No change to `domain-map.json` semantics — this is purely the evidence
  layer's discovery seam.
