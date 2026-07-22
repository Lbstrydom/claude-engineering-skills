# Plan: Observed-Graph Discovery Unification (evidence-layer architecture)

- **Date**: 2026-07-17
- **Status**: Complete — **#1 RESOLVED 2026-07-22, and it inverts the premise**:
  the "68% invisible" figure was never a production defect. It was a
  **measurement artifact of the spike tool itself**, and production coverage
  on ai-organiser has been ~99% the whole time. Full diagnosis in §3.1a below;
  short version: `observed-graph-discovery-spike.mjs` imported
  `dependency-cruiser` at its own top level, which — because Node resolves a
  bare specifier relative to the IMPORTING FILE, not `--repo` — always bound
  to claude-engineering-skills' own install (18.0.0), regardless of which repo
  was being measured. This repo has no `typescript` dependency, and
  dependency-cruiser's TypeScript-awareness is gated on `typescript` being
  resolvable as a *sibling* of wherever dependency-cruiser itself lives
  (`tryImportAvailable`, checked via `createRequire(import.meta.url)` from
  inside dependency-cruiser's own source). So every spike run silently lost
  TS-aware parsing and mis-resolved extensionless relative imports — for
  every repo it was pointed at, not just ai-organiser. Production was never
  exposed to this: the synced `extract.mjs` lives *inside* the consumer, so
  its own bare `dependency-cruiser` import resolves the consumer's own
  install (ai-organiser's is 17.3.10, with `typescript` as a real sibling) —
  confirmed by running that exact synced script directly against ai-organiser
  and measuring **99.2%** coverage, not 32%. The spike is now fixed to load
  the TARGET repo's own dependency-cruiser install (mirroring what the synced
  script actually experiences); re-measuring with the fix shows **0 semantic
  diffs and 99.4% coverage** on ai-organiser (up from 10 diffs / 32.8%), with
  0 diffs unchanged on the other two repos. See §3.1a for the full evidence
  trail, §3.1b for what this changes about (e)'s justification, and the
  fixed spike + `tests/observed-graph-discovery-spike.test.mjs` for the
  regression guard.
  - **§4 null-domain accounting — DONE** (unaffected by this finding; shipped
    2026-07-18 via [observed-graph-coverage-honesty.md](observed-graph-coverage-honesty.md)
    Phases 1-5, Gemini APPROVE).
  - **#2 — SUPERSEDED by a runtime budget (§3.2)**, also unaffected. No longer
    a blocker.
  - **(e) unified discovery is now UNMOTIVATED by the evidence that justified
    it.** §3.1b: the existing, un-unified allowlist path already measures
    ~99% coverage on the one repo whose number drove this whole plan. Do not
    build (e) on the strength of the old 68% figure — it no longer exists.
  - **Why `Complete` and not `Draft`/`Blocked`, given (e)+(d) were never
    built**: this plan's own §3 was explicit that (e) must be *measured
    before building*, not built on spec. That measurement is done, and its
    answer is "not currently justified" — a real, actionable conclusion, not
    an unresolved blocker. Leaving this open indefinitely would misrepresent
    an answered question as a pending one. If a future consumer's coverage
    reading genuinely goes `degraded` (§4's shipped instrumentation is what
    would show that), re-open a fresh plan grounded in that measurement
    rather than resurrecting this one on the old 68% figure.
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

**#1 is RESOLVED (2026-07-22, see §3.1a) — but not the way §3.1 concluded.**
The n=3 refutation recorded in §3.1 was itself measured with a broken tool:
the spike bound to the WRONG repo's `dependency-cruiser` install regardless of
`--repo`, so it never actually exercised TS-aware resolution on any target.
Production was unaffected the whole time. **#2 is SUPERSEDED by a runtime
budget (§3.2)**, unaffected by this and still not a blocker.

> Two stale "answered" headers have now stood at the top of this section in
> sequence — first "#1 answered: yes" (n=2, overturned by ai-organiser), then
> "#1 refuted" (n=3, itself an artifact). Both are corrected in place rather
> than quietly, for the same reason each time: a stale green (or red) summary
> above an accurate body is how a wrong conclusion gets re-adopted by whoever
> reads only the heading. Read §3.1a before trusting either.

1. **Does dep-cruiser cleanly accept an explicit file list of ~3,000 paths?**
   Make-or-break for (e); a ~10-minute spike answers it. If it doesn't, the
   practical equivalent is cruising `repoRoot` with exclusions delegated to a
   real `.gitignore` parser rather than a hardcoded array.
2. ~~**What does a root/full cruise cost on a consumer monorepo?**~~
   **SUPERSEDED 2026-07-18 — replaced by a runtime budget (see §3.2).** The
   original framing required measuring a repo that does not exist, so it could
   never be satisfied. It is now a decidable gate, because the coverage
   contract that makes it decidable has shipped.

### 3.1 Spike results (2026-07-18) — SUPERSEDED, kept for the audit trail

> **Superseded 2026-07-22 by §3.1a.** Everything below this notice was
> measured with the pre-fix spike, which (unknown at the time) always bound
> `dependency-cruiser` to claude-engineering-skills' own install regardless of
> `--repo`. The **numbers in this section are artifacts**, not evidence about
> ai-organiser or any other consumer. Kept verbatim rather than deleted or
> silently corrected, because the methodology dead-ends this section records
> (the `..`-prefix scare, the semantic-vs-input partition) are real lessons
> that a future re-measurement should not have to re-learn — but do not cite
> the 68%/945/1389 figures below as a live fact. Jump to §3.1a for what
> actually holds.

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

### 3.1a The real diagnosis (2026-07-22) — #1 RESOLVED

**Reproduced first**, against the un-fixed spike, to confirm §3.1 was still
live before touching anything: identical to 2026-07-18 — 10 semantic diffs,
32.8% coverage (461/1407) on ai-organiser, byte-identical across `tsConfig`,
`enhancedResolveOptions.extensions`, and no-options runs (matching
[observed-graph-coverage-honesty.md](observed-graph-coverage-honesty.md) §8's
"byte-identical" finding — that finding was correct; it just hadn't identified
the actual variable).

**The variable no one had controlled for: which `dependency-cruiser` package
tree `cruise()` came from.** `extract.mjs` calls the JS API via a bare
`import { cruise } from 'dependency-cruiser'`. Node resolves a bare specifier
relative to the **importing file's own location**, walking up its
`node_modules` ancestry — never relative to `--repo`, never relative to
`process.cwd()`. For the synced production script, the importing file lives
*inside the consumer repo* (`<consumer>/scripts/.claude-skills/symbol-index/
extract.mjs`), so this is invisible: it always resolves the consumer's own
install. The **spike**, however, lives in `claude-engineering-skills/scripts/
spikes/`, so its top-level import always resolved `claude-engineering-skills/
node_modules/dependency-cruiser` (**18.0.0**) — no matter what `--repo` was
passed. wine-cellar-app happens to *also* pin `^18.0.0`, so this coincidence
never showed up as a version mismatch there; ai-organiser pins `^17.3.10`
(never bumped to match, since our `requiredDeps` sync only adds missing
deps — it doesn't force-update ones a consumer already has).

**Why the version boundary matters**: dependency-cruiser's TypeScript-
awareness is a `TRANSPILER2AVAILABLE.typescript` flag computed by
`tryImportAvailable('typescript', …)`
(`src/extract/transpile/meta.mjs`), which does
`createRequire(import.meta.url).resolve('typescript')` — resolved relative to
**dependency-cruiser's own installed location**, not the repo it is cruising.
Confirmed directly:

```
$ node -e "const {createRequire}=require('module'); const {pathToFileURL}=require('url');
  const req = createRequire(pathToFileURL('…/claude-engineering-skills/node_modules/
    dependency-cruiser/src/extract/transpile/try-import-available.mjs').href);
  req.resolve('typescript')"
FAILS: Cannot find module 'typescript'
```

claude-engineering-skills has **no `typescript` dependency at all** (it's a
plain ESM/JS repo). So dependency-cruiser resolved from here always falls
back to non-TS-aware parsing — for `.ts`/`.tsx` files it silently loses
extensionless relative-import resolution — **regardless of tsConfig or
enhancedResolveOptions**, which is exactly the "byte-identical across options"
result §8 measured and correctly could not explain further at the time.

**Direct A/B, same target list, same `cruiseOpts`, only the package tree
changed** (`src/services/presentationIr/irToHtml.ts`, ai-organiser):

| dependency-cruiser install | `typescript` resolvable? | irToHtml deps | couldNotResolve |
|---|---|---|---|
| ai-organiser's own (17.3.10) | yes (sibling) | 9 | **0** |
| claude-engineering-skills' (18.0.0) | no | 10 | **10 (all)** |

**Production was never exposed to this.** Ran the real, unmodified,
synced `extract.mjs` directly against ai-organiser (read-only — it only
prints JSON lines to stdout, no DB writes):

```
[extract] scanning 2503 files (mode=full)
[extract] coverage: 1398/1409 eligible source files cruised (99.2%) in 5895ms
```

**99.2%, not 32.8%.** Of the 11 "uncruised" files, 5 were my own throwaway
diagnostic scripts (inflating the denominator); the real gap is **6 files**,
all repo-root-level config/tooling (`esbuild.config.mjs`, `eslint.config.mjs`,
`playwright.config.ts`, `vitest.config.ts`, `version-bump.mjs`,
`test-nested-tags-implementation.js`) — files outside every
`COMMON_SOURCE_DIRS` entry, which is exactly the §4 null-domain gap already
measured and reported, not a new defect.

**Fix**: `scripts/spikes/observed-graph-discovery-spike.mjs` no longer
imports `dependency-cruiser` at its own top level. `findPackageDir` walks up
`node_modules` from an arbitrary starting directory (mirroring Node's own
resolution algorithm), and `loadCruiseFn(repoRoot)` dynamically imports the
**target repo's own** `dependency-cruiser` entry point — the same tree the
synced `extract.mjs` would actually use in that repo. Both are exported and
covered by `tests/observed-graph-discovery-spike.test.mjs` (fixture
`node_modules` trees, no real dependency-cruiser/typescript install needed —
Tier 1, deterministic).

**Re-measured with the fixed spike, all three repos:**

| Target | dependency-cruiser used | M1 semantic diffs | Coverage |
|---|---|---|---|
| claude-engineering-skills | 18.0.0 (own) | 0 | 971/993 (97.8%) |
| wine-cellar-app (consumer) | 18.0.0 (own) | 0 | 2452/2475 (99.1%) |
| ai-organiser (consumer) | **17.3.10 (own — was silently 18.0.0)** | **0** (was 10) | **1398/1406 (99.4%)** (was 32.8%) |

Every remaining "missed" file across all three is the same, already-
understood §4 class: root-level config/tooling outside `COMMON_SOURCE_DIRS`.
No repo shows a genuine TS-resolution defect once the spike measures the
right package tree.

**Exit criterion met**: this is exit-criterion (a) from §7c of
observed-graph-coverage-honesty.md ("a fix with a regression test") — except
the fix landed in the measurement tool, not in a resolver configuration,
because that is where the actual defect lived. §7c's investigation is closed
by this section; there is no remaining ai-organiser resolution defect to
diagnose.

### 3.1b What this changes about (e)

**(e) unified discovery was motivated entirely by the 68%-invisible figure.**
That figure no longer exists. The **existing, un-unified, allowlist-driven**
baseline (`COMMON_SOURCE_DIRS`, unchanged) already measures ~98-99% coverage
on all three repos measured — including ai-organiser, the repo whose number
drove this plan's urgency. The remaining gap on every repo is root-level
files outside the allowlist's directory conventions — a real but much
smaller and differently-shaped problem than "two layers of the pipeline
catastrophically disagree about the repo's contents."

This does not retroactively make (e) wrong to build — a repo with a genuinely
unconventional layout (no `src`/`scripts`/`tests`, e.g. a bare `packages/*`
monorepo with idiosyncratic subpackage names) could still hit the original
`COMMON_SOURCE_DIRS` blindness this plan's §1 diagnoses, and §4's null-domain
accounting (already shipped) will now SURFACE that as a `degraded` coverage
number rather than hiding it. But **do not build (e) on the strength of the
old 68% number** — that evidence is gone. If (e) is still wanted, it needs a
fresh justification grounded in a real observed `degraded` coverage reading
on an actual consumer, which §4's shipped instrumentation will produce the
moment a repo needs it. Until then, this plan's core work is **not blocked**
(that was #1's role) but also **not currently justified by measured need** —
a different state than either "blocked" or "ready to build."

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

**Update 2026-07-22 — superseded by §3.1a.** At the time this was written, (e)
was understood to remain blocked on #1 (TS resolution failing upstream of
discovery). §3.1a found that "failure" was the spike measuring the wrong
`dependency-cruiser` install; production's actual resolution was never
broken, and the coverage-honesty §7c investigation is now closed by §3.1a
rather than left open. **Removing #2 as a blocker did not make (e) ready on
its own** — that reasoning holds — but the reason (e) isn't currently being
built is no longer "#1 blocks it." See §3.1b: (e) is unblocked, but also
no longer justified by the evidence that originally motivated it.

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
