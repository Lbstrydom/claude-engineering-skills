# Plan: Observed-Graph Discovery Unification (evidence-layer architecture)

- **Date**: 2026-07-17
- **Status**: Draft — blocked on two measurements (see §3). Do NOT start building until they're answered.
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

Neither is answered. (e) is unimplementable if #1 fails and unaffordable if #2
is bad.

1. **Does dep-cruiser cleanly accept an explicit file list of ~3,000 paths?**
   Make-or-break for (e); a ~10-minute spike answers it. If it doesn't, the
   practical equivalent is cruising `repoRoot` with exclusions delegated to a
   real `.gitignore` parser rather than a hardcoded array.
2. **What does a root/full cruise cost on a consumer monorepo?** The parent
   plan's **1.1s is measured on THIS repo — the one repo where the allowlist
   happens to work.** A 40k-file `packages/` tree is not 1.1s. Needs a real
   consumer measurement before anything ships.

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
