# Plan: Observed-Graph Discovery Unification (evidence-layer architecture)

- **Date**: 2026-07-17
- **Status**: Draft — §3 measurement #1 ANSWERED 2026-07-18 (yes, design (e) is
  feasible — 0 semantic diffs on 2 repos; see §3.1). **Still blocked on #2**: the
  root-cruise cost is measured only on two small repos (0.95s / 4.06s), NOT on
  the ~40k-file monorepo §3 names as the adversarial case, and the scaling
  observed (2.7× modules → 4.3× time, ~50× peak memory) is the open risk. Do NOT
  start building until #2 has a real measurement.
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

**#1 is ANSWERED (2026-07-18): yes. #2 is partially measured and still open.**
(e) is unimplementable if #1 fails and unaffordable if #2 is bad.

1. **Does dep-cruiser cleanly accept an explicit file list of ~3,000 paths?**
   Make-or-break for (e); a ~10-minute spike answers it. If it doesn't, the
   practical equivalent is cruising `repoRoot` with exclusions delegated to a
   real `.gitignore` parser rather than a hardcoded array.
2. **What does a root/full cruise cost on a consumer monorepo?** The parent
   plan's **1.1s is measured on THIS repo — the one repo where the allowlist
   happens to work.** A 40k-file `packages/` tree is not 1.1s. Needs a real
   consumer measurement before anything ships.

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
| claude-engineering-skills | **0** | 0.95s · 921 modules · +2MB | 22 / 891 invisible |
| wine-cellar-app (consumer) | **0** | 4.06s · 2530 modules · +117MB | 23 / 2426 invisible |

- **#1 → YES, (e) is feasible.** Zero semantic differences on both repos: every
  edge derived from a file *both* runs saw is identical. The handful of
  differing edges are **input-set** differences (the symbol walker's `SKIP_DIRS`
  excludes `.claude/`, so those files were never in the explicit list) — which
  is this plan's own thesis, i.e. evidence FOR the design, not an obstacle.
  > Recorded because it nearly went the other way: the spike's first version
  > counted every differing edge as semantic and reported **"not equivalent —
  > (e) blocked"**. That would have manufactured a blocker that does not exist.
  > Any future re-measurement must keep the semantic-vs-input partition.
- **#2 → still open, deliberately unverdicted.** The spike prints the number and
  refuses a pass/fail, because this plan sets no numeric threshold
  ("unaffordable if bad") and **neither repo measured resembles the ~40k-file
  `packages/` tree §3 names as the adversarial case.** The scaling is the part
  to weigh: 2.7× the modules cost **4.3×** the time and ~50× the peak memory.
  Extrapolating that curve to 40k files is the open risk. **Do not treat #2 as
  answered by these two data points.**
- **§4 quantified.** The "observed but unclassified" problem is real and
  measurable today: 22 files here and 23 in the consumer are symbol-indexed but
  contribute **zero** observed edges with nothing warning — including that
  consumer's entire `extension/` tree (a browser-extension subsystem invisible
  to the import layer, because `extension` is not in `COMMON_SOURCE_DIRS`).

## 4. Independent first step — null-domain accounting

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
