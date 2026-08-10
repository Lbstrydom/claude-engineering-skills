# Plan: Model-Eval / Pricing Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Re-verified**: 2026-08-10 (against `d5e66d35`, first-hand source read)
- **Status**: Complete
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). Small
> cluster (9 entries) across `model-eval/cost.mjs`,
> `model-eval/deterministic-scorer.mjs`, `model-eval/verdict.mjs`,
> `model-pricing.mjs`, and `store/model-eval.mjs`.

---

## 0. Re-verification (2026-08-10)

Every entry was re-read against current source before implementation, per
this repo's own rule that *an audit finding about untouched code is a
hypothesis until executed*. **7 of 9 confirmed; 1 refuted; 1 declined on the
merits.** Line numbers below are pinned to `d5e66d35`.

| topicId | sev | verdict | evidence at `d5e66d35` |
|---|---|---|---|
| `r15h1jsonbfinite` | HIGH | **CONFIRMED** | `store/model-eval.mjs:79` — `t === 'number'` returns true for `NaN`/`Infinity` |
| `r15h2costrowagg` | HIGH | **CONFIRMED** | `model-eval/cost.mjs:94-102` — sum-check guarded by `phaseValues.every(p => p.usd != null)` |
| `adbda8c8` | HIGH | **CONFIRMED** | `model-pricing.mjs:131` — bare `familyPricing[key]` vs. `Object.hasOwn` on line 129 |
| `62d7faf3cd80` | HIGH | **CONFIRMED** | `deterministic-scorer.mjs:200-210` per-expected greedy; `:104-105` basename fallback |
| `c5808479` | MED | **CONFIRMED** | `model-pricing.mjs:159-192` — no `unmeterable` guard vs. sibling `costForBudget:219` |
| `r15m2phaseenum` | MED | **CONFIRMED** | `model-eval/cost.mjs:80` — `z.record(z.string(), …)` vs. the enum on line 17 |
| `r15m3tokendry` | MED | **CONFIRMED** | `model-eval/cost.mjs:147` local `isValidTokenCount` ≡ `model-pricing.mjs:105` `isValidCount` |
| `f68a6dbc` | HIGH | ~~REFUTED~~ → **STANDS** (2026-08-10) | refutation withdrawn — answered a paraphrase, not the entry; measured headroom is 1.0x. §0.1 |
| `r15m7godmodules` | MED | **DECLINED** (ledger entry resolved 2026-08-10) | see §0.2 |

### 0.1 `f68a6dbc` — REFUTATION WITHDRAWN 2026-08-10, finding stands

> **Correction (2026-08-10, after shipping).** The refutation below is wrong,
> and was wrong when written: it answers a claim the debt entry does not make.
> The ledger text for `f68a6dbc` reads *"the fixed fallback is presented as a
> conservative overestimate for every unpriced model, but its import-time
> validation only proves it exceeds prices currently present … It cannot
> establish that the fallback safely bounds future or otherwise unpriced
> models."* That is about the fallback's **adequacy as a bound**. What §0.1
> refuted instead was "a silent default" — a paraphrase introduced by this
> plan's own summary bullet, not by the entry. Refuting the paraphrase left the
> actual claim untested.
>
> Tested now, and it is worse than unproven — the margin is **exactly zero**:
>
> ```
> FALLBACK_PRICE_USD           = { input: 15, output: 75 }
> max listed price (claude-opus) = { input: 15, output: 75 }   headroom 1.0x / 1.0x
> ```
>
> The import-time loop throws only on `px.input > FALLBACK.input`, so a tie
> passes. `costForBudget` on an unlisted model reserves at the fallback rate; if
> that model is priced above Opus — the ordinary case for a new frontier
> release, which is precisely what an unpriced id usually *is* — the
> "conservative over-estimate" **under-reserves**, the one direction this
> function exists to make impossible. Measured: an unlisted model at 1M/1M
> reserves $90, while a real $20/$100 model costs $120.
>
> The entry is therefore **NOT closed** and is not resolvable by argument. The
> honest fix is to stop hand-picking the constant: derive the floor from the
> table (`max(listed) × margin`) so it cannot silently come to rest at a tie,
> and make the invariant strict (`>=` rejected, not just `>`). Tracked as open
> debt `f68a6dbc`; see [`model-comparison-campaigns.md`](model-comparison-campaigns.md),
> whose cost ceilings rest on this exact premise.

### 0.1a The original (withdrawn) refutation, kept for the record

Claim: *"the fail-fast validation loop only iterates models that already exist
in `OSS_PRICING`/`familyPricing` today, so it structurally cannot catch a
future unlisted model falling through to a silent default."*

The loop (`model-pricing.mjs:96-100`) validates exactly one invariant —
`FALLBACK_PRICE_USD` dominates every **listed** price — and it does that
completely, at import, including for prices added later. An **unlisted** model
has no price to compare against, so there is nothing for this loop to check;
the claim asks it to validate a value that does not exist.

The premise's real payload — *"falling through to a silent default"* — is
false in both consumers:

- `costFromUsage` (`:169-175`) returns `totalUsd: null, priced: false` for an
  unpriced model. Honest null, never 0.
- `costForBudget` (`:232`) returns `estimated: true`, and that flag is
  **persisted, not dropped** — `audit-shadow.mjs:222` and `:493` write it into
  the spend-ledger reservation rows.

There is no silent default to catch. No change.

### 0.2 `r15m7godmodules` — declined on the merits, no change

Claim: the `model-eval/` files are "multi-concern with accreted round-N
commentary", `verdict.mjs` cited at 404 lines / 7 round-refs.

> **Two corrections (2026-08-10).** The figure below said verdict.mjs has
> "exactly ONE export"; it has **three** — one exported function
> (`computeVerdict`) plus two exported consts. The regex behind that count only
> matched `export function`. And the entry cites **four** files, of which only
> verdict.mjs had been measured before declining. All four measured now; the
> conclusion is unchanged, and the evidence is no longer one file standing in
> for four:
>
> | file | lines | exports | fns | comment |
> |---|---|---|---|---|
> | `verdict.mjs` | 405 | 3 | 6 | 41% |
> | `route-catalog.mjs` | 377 | 4 | 9 | 44% |
> | `structured-extractor.mjs` | 296 | 6 | 7 | 46% |
> | `deterministic-scorer.mjs` | 339 | 3 | 6 | 51% |
>
> None exceeds ~400 lines or 6 exports. Note `deterministic-scorer.mjs` grew
> 227 → 339 under *this* change, so the decline is made against the larger file,
> not a convenient earlier one.

Measured (`verdict.mjs`, 2026-08-10): **405 lines, 6 functions, 3 exports** —
one function (`computeVerdict`) and two consts; the other five functions are its
private helpers. That is a cohesive single-purpose module, not a multi-concern
one. 168 of 405 lines (41%) are comment — this repo's documented house style, and the round-N refs
are the *why* behind individual guards, i.e. the institutional memory that
makes a later reader stop before "simplifying" a load-bearing check.

Splitting a one-export module on line count, or stripping its provenance
comments, is the over-engineering cliff AGENTS.md names: an abstraction no
current requirement needs, paid for by deleting the rationale. Declined; not
deferred. Revisit only if a *second* concern actually lands in the file.

---

## 1. Fixes

Ordered by the plan's own instruction to take the data-integrity gap first.

### 1.1 `r15h1jsonbfinite` — `store/model-eval.mjs` (HIGH, do first)

`isJsonbSafeValue` accepts any `typeof v === 'number'`, so `NaN`/`Infinity`
pass the jsonb-write safety check. `JSON.stringify(NaN)` emits `null` — the
value is silently *changed*, not rejected, which is precisely the silent-data-
loss class this seam exists to catch (AGENTS.md, "jsonb-safe write seam").

**Fix**: split the numeric branch — `if (t === 'number') return Number.isFinite(v);`

**Test placement — the original §4 was wrong** (Gemini gate R1). The 2026-07-26
draft said to extend `tests/store-jsonb-array-serialization.test.mjs` as "the
existing guard for this exact seam". It is not: that file imports only
`db/query.mjs`'s `_builders`/`pgArray` and tests **SQL-builder** array
serialization — a DB-driver concern, not a Zod schema-boundary one. The actual
existing guard for *this* seam is `tests/model-eval-core.test.mjs:765-767`,
which already drives `isJsonbSafeValue` through
`_internals.CreateEvalRunBundleSchema` with circular and function-valued
payloads. The `NaN`/`Infinity` cases belong beside those, and nothing is added
to the driver test.

### 1.2 `r15h2costrowagg` — `model-eval/cost.mjs` (HIGH)

The `superRefine` sum-check runs only when *every* `byPhase` entry is priced,
so a row asserting `costStatus: 'available'` while carrying an `'unavailable'`
phase entry is schema-valid and never reconciled. `assembleCostRows` cannot
currently emit that shape, but `CostRowSchema` is **exported** and is the
validator for rows composed or deserialized elsewhere — its job is to reject
the contradiction regardless of who built the row.

**Fix**: when `costStatus === 'available'`, require *both* that every phase
entry is priced *and* that the phases sum to `totalUsd`. Fail closed.

**Reconciliation semantics** (audit-plan R1 M5 — the plan said "sum to" without
defining equality). Keep the **existing** comparison verbatim:
`Math.abs(sum - totalUsd) > 1e-9`, an absolute tolerance. Rationale, stated so
the next reader does not "tighten" it: these are per-run LLM costs bounded in
practice below ~$10, where an f64 has ~1e-15 absolute resolution, so 1e-9
absorbs addition-order rounding with ~6 orders of magnitude of margin while
still catching any real mismatch (the smallest meaningful discrepancy is a
whole phase, ≥1e-6). Migrating to integer micro-USD is a larger change to the
persisted representation that no current requirement needs — explicitly not
done here.

Legal value matrix, complete over both statuses (all already enforced by the
existing refinements except the row marked NEW):

| `costStatus` | `totalUsd` | every phase `status` | phase sum |
|---|---|---|---|
| `available` | non-null, finite, ≥0 | must all be `available` (**NEW**) | must equal `totalUsd` ±1e-9 (**NEW**: was skipped when any phase unpriced) |
| `unavailable` | must be `null` | unconstrained | not checked (nothing to sum) |

### 1.3 `adbda8c8` — `model-pricing.mjs` (HIGH)

`familyPricing[key] || familyPricing[modelId] || null` uses bare bracket
access, unlike the `Object.hasOwn(OSS_PRICING, …)` guard three lines above.
A model id colliding with an `Object.prototype` key (`constructor`,
`toString`, `valueOf`) returns a truthy non-price, which then reads
`px.input === undefined` and yields a `NaN` cost reported as `priced: true`.

**Fix**: `Object.hasOwn` guards on both family lookups, matching the adjacent
pattern.

### 1.4 `62d7faf3cd80` — `deterministic-scorer.mjs` (HIGH)

Two defects in `scoreDefectLocalization`:

1. **Per-expected greedy** (`:200-210`) — iterates `expectedRubrics` in array
   order and lets each take its best still-unused candidate. An early rubric
   can consume a candidate that a later rubric matches far better, depressing
   `recall`/`f1`, and the result depends on rubric ordering.
2. **Collision-prone basename fallback** (`:104-105`) — `basename(f) ===
   basename(candidate.file)` ranks equal to a full-path match, so
   `src/a/config.js` and `src/b/config.js` are interchangeable.

**Rejected fix — descending-global-score greedy** (proposed in this plan's
first draft; killed by audit-plan R1 H1, whose counterexample executes). Greedy
by score is *not* maximum-cardinality. With eligible edges A→X=1, A→Y=1,
B→X=1 and B→Y below threshold, greedy takes A→X first and leaves B unmatched
(1 match) where A→Y + B→X matches both (2). Since `correct` — and therefore
`recall`/`precision`/`f1` — is exactly the match count, greedy under-reports
candidate quality, and the specific under-report depends on tie order. Ordering
by score merely moves the arbitrariness; it does not remove it.

**Fix — maximum-cardinality bipartite matching.** `correct` is the size of a
matching, so compute a *maximum* one: Kuhn's augmenting-path algorithm over the
eligible-edge graph (an edge exists iff `matchScore` returns non-null, i.e.
file match AND score ≥ threshold).

- **Correctness**: maximum cardinality is a property of the graph, so `correct`
  and every derived metric are **invariant under permutation** of either input
  array — the guarantee the previous per-expected greedy never had and
  score-ordered greedy still would not have.
- **Determinism**: each rubric's adjacency is sorted by the lexicographic tuple
  **(pathClass asc, score desc, candidateIndex asc)**, where `pathClass` is
  `0` for a full-path match and `1` for basename-only. Rubrics are processed in
  index order. Same input → same assignment, every time.
- **Objective, stated exactly** (audit-plan R2 M2 *and* R3 H1 — the draft
  over-claimed twice, and the second narrowing was still false). The objective
  is **maximum cardinality, full stop.** Path class is a first-choice
  preference in adjacency order and a determinism device — **not** a guarantee
  at any scope. R3 H1's counterexample executes: with r1={exact x, basename y}
  and r2={exact x, exact z}, processing r1 first assigns r1→x, then r2's
  augmenting path rematches r1→y, yielding one exact edge where the
  equal-cardinality alternative (r1→x, r2→z) has two. Local ordering is not a
  global objective, and no wording makes it one.

  **Correction (Gemini gate R1, `wrongly_dismissed` — and it was right).** The
  paragraph here previously argued this optimization "reaches no output"
  because `mismatches` reports unmatched *expected indices*, which an
  exact-vs-basename swap supposedly cannot change. **That is false.** When two
  rubrics contend for one candidate — r1 reaching it by basename only, r2 by
  exact path — both assignments have cardinality 1, but they produce *different*
  `mismatches`: matching r1 reports **r2** as missed. So the harm is real, and
  it is specifically a **misleading diagnostic**: the evaluation tells a human
  the model missed the exact-path defect when it did not.

  The metrics claim does survive — `correct`, `precision`, `recall`, `f1`,
  `extraCount` are all functions of the match *count* and are unaffected. The
  defect is confined to *which* rubric is named as missed.

  **Fix the report, not the optimum.** A min-cost-flow solver would pick one
  arbitration and hide the contention; it cannot make the choice *meaningful*,
  because both matchings are genuinely maximal. Instead, make `mismatches`
  distinguish the two cases it currently conflates:

  | condition | `reason` |
  |---|---|
  | the rubric had **no eligible edge at all** | `no-matching-candidate-output` (unchanged — a real miss) |
  | the rubric had eligible edges, all taken by other rubrics | `candidate-consumed-by-another-rubric` (**NEW**) |

  This is ~5 lines, needs no solver, and is strictly *more* informative than
  any arbitration: it surfaces the contention instead of silently resolving it
  one way and calling the loser a miss. Combined with the unambiguous-basename
  rule below, a wrong-file credit becomes impossible and a contended match
  becomes visible.

  **Ambiguity is measured per SIDE, not across both** — measuring it across the
  union would delete the fallback's only real use case. A moved file is
  `src/old/thing.js` in the rubric and `src/new/thing.js` in the candidate: two
  distinct paths sharing a basename, so a union-scoped test would call it
  ambiguous and drop exactly the edge the fallback exists to create. The test
  is instead: a basename is ambiguous if it maps to **≥2 distinct candidate
  file paths**, or to **≥2 distinct rubric file paths**. Both sides are counted
  by distinct PATH, symmetrically — ambiguity asks "does this basename identify
  one file?", so two findings on one file, or two rubrics naming one file, are
  not collisions (audit-code R2 M4 / R3 M3, one on each side). The moved file is
  unambiguous on both sides → edge kept. The `src/a/config.js` vs
  `src/b/config.js` collision is ambiguous on the candidate side → no basename
  edge, while the correct candidate still matches by exact path.

- **The collision is fixed at edge construction instead — which is what
  `62d7faf3cd80` actually asked for.** Ordering was always the wrong lever: it
  decides *which* ambiguous edge wins, when the defect is that an ambiguous
  edge exists at all. So a basename-only edge is created **only when that
  basename is unambiguous** — it resolves to exactly one file in the candidate
  set *and* one in the rubric's `files` list. `src/a/config.js` vs
  `src/b/config.js` therefore produces **no** basename edge in either
  direction, and cannot be credited as a match at all, rather than being
  credited to whichever the algorithm reached first. Full-path edges are
  unaffected. This is ~5 lines, is independent of the matching algorithm, and
  removes the arbitrariness rather than ranking it.
- **Cost**: `O(V·E)` — with the existing per-side cap of 500 and pair cap of
  20,000, at most 500 × 20,000 = 1e7 edge visits, no new dependency, no
  `O(n³)` assignment solver. A full max-*weight* solver is not warranted:
  weight does not enter any reported metric, only tie-breaking, which the
  tuple above already settles deterministically.

**Bound enforcement** (audit-plan R1 M6). Already a precondition and it stays
one — `MAX_SCORING_ITEMS` (500/side) and `MAX_SCORING_PAIRS` (20,000) are
validated at `deterministic-scorer.mjs:172-186`, which throws an actionable
error **before** any pairing work. The new code must build its edge list
*after* those checks so the bound continues to gate edge materialization, not
merely the scoring loop. No new limit is introduced; this fix inherits the
existing one.

### 1.5 `c5808479` — `model-pricing.mjs` (MED)

`costFromUsage` has no missing-usage guard, unlike sibling `costForBudget`
(`:219`). `costFromUsage(null, 'qwen/qwen3-coder')` sanitizes to 0 tokens and
returns `priced: true, totalUsd: 0` — a **false report of successful $0
pricing**, indistinguishable from a genuinely free call.

**Fix**: mirror `costForBudget`'s `unmeterable` computation, and return
`totalUsd/inputUsd/outputUsd: null` when unmeterable. A flag alone would be
the band-aid: the fabricated `$0` would still ship to anyone reading
`totalUsd`.

**Return contract, stated in full** (audit-plan R1 H3 — the draft changed the
nullability without defining the result). Two **orthogonal** predicates, never
collapsed into one:

| field | meaning | source of truth |
|---|---|---|
| `priced` | the *model* has a known price | `priceFor(modelId) !== null` |
| `unmeterable` | the *usage* is not trustworthy | `!usage \|\| usage.usageMissing === true \|\| !isValidCount(rawIn) \|\| !isValidCount(rawOut)` — byte-identical to `costForBudget:219` |

> **Dismissed — Gemini gate R1 LOW2**, which claimed `costFromUsage` "does not
> currently return `inputUsd` or `outputUsd` in its success path". It does, in
> **both** branches (`model-pricing.mjs:171-174` unpriced, `:182-191` priced).
> Executed against the installed module: priced → `{"totalUsd":0.00028,
> "inputUsd":0.0002,"outputUsd":0.00008,…}`; unpriced → all three `null`. The
> finding is factually wrong; no change.

`totalUsd`/`inputUsd`/`outputUsd` are **non-null iff `priced && !unmeterable`**;
otherwise all three are `null`. All four combinations are legal and
distinguishable: an unpriced-but-metered call reports real token counts with
null money; a priced-but-unmetered call reports null money rather than `$0`.
Token counts (`inputTokens`/`outputTokens`/`cacheWriteTokens`/
`cacheReadTokens`) remain the sanitized numbers in every case — they describe
what was *observed*, not what was billable, and callers already rely on that.

**Zero vs. absent** is the whole point of the change: `{input_tokens: 0,
output_tokens: 0}` is meterable (`unmeterable: false`, `totalUsd: 0` — a true
zero), while `null`, `{}`, a one-sided object, or a non-numeric/negative field
is `unmeterable: true, totalUsd: null`.

**Exhaustive call-site inventory** (audit-plan R1 H3 asked for one; this is
`git grep costFromUsage` over `*.mjs`/`*.js`/`*.md`, every hit classified — 4
call sites, all other hits are comments or the definition):

| call site | today | after |
|---|---|---|
| `lib/model-eval/cost.mjs:127` | already derives `usageStatus` itself and nulls `costUsd` when missing | **no change** — its `usageStatus === 'captured'` test is already equivalent to `!unmeterable` |
| `lib/audit/usage-event.mjs:73` | `totalUsd ?? 0` + `priced ? 'estimated' : 'unavailable'` ⇒ reports a false `estimated $0` | **change** — route `unmeterable` to the existing `'unavailable'` state |
| `scripts/bakeoff-collect.mjs:197` | `usd += r.totalUsd` ⇒ `null` adds as 0 | **change** — treat unmeterable like unpriced; arm total becomes `null` |
| `lib/audit/legacy-production-audit.mjs:3148` | prices a locally-reduced aggregate | **no change** — its token fields are `reduce((s,r)=>s+(…??0),0)`, provably finite numbers, so `unmeterable` cannot be true |

**Consequential caller updates (in scope by impact, not authorship).** Nulling
the USD fields is only honest if callers stop coercing the null back to 0:

- `scripts/lib/audit/usage-event.mjs:73-77` — `costAmountUsd = totalUsd ?? 0`
  with `usageReliability = priced ? 'estimated' : 'unavailable'` would report
  an unmeterable call as `estimated $0`. Route `unmeterable` to the existing
  `'unavailable'` state **and stop fabricating the amount** (audit-plan R2 H1:
  relabelling alone leaves `costAmountUsd: 0` on disk, indistinguishable from a
  true zero — a band-aid that satisfies the letter of the fix and none of it):
  - `UsageEventSchema.costAmountUsd` and `.costAmountEurAtRecordedFx` become
    `z.number().min(0).nullable()`;
  - `costAmountUsd = (priced.priced && !priced.unmeterable) ? priced.totalUsd
    : null`, and `costAmountEurAtRecordedFx: toEur(costAmountUsd)` — `toEur`
    already passes null through (`model-pricing.mjs:243`), so the `?? 0`
    fabrication on line 88 goes too.
  - The `selfReportedCostUsd` branch (`:67-71`) is untouched: a backend-reported
    cost is `'exact'` by construction and never unmeterable.

  **No migration, and the aggregate is already correct.** `UsageEvent` is not
  bound to any DB column (`git grep cost_amount_usd` over `supabase/` and
  `scripts/` → no hits); it is an in-memory/JSON record. Its one aggregating
  consumer, `computeCostReport` (`lib/audit/cost-budget.mjs:63-66`), **already**
  branches on `usageReliability === 'unavailable'` *first*, `continue`s past
  such events, and tallies `unavailableCostEventCount` — with an existing test
  at `tests/cost-budget.test.mjs:251-259` asserting the unavailable event's 0 is
  never summed as confirmed cost. So nulling the field cannot under-count the
  spend total: the only reader already refuses to read it. This is the reason
  the fix is 4 lines and not an end-to-end money-contract migration.

  **Complete money-field consumer inventory** (audit-plan R3 H2 — "not a
  complete consumer inventory" was a fair charge against the previous
  paragraph, which traced only the DB and the aggregator). `git grep` over the
  whole repo excluding `docs/` for `costAmountUsd`, `costAmountEurAtRecordedFx`,
  `armCostUsd`, `unavailableCostEventCount`, classified by reader kind:

  | reader | kind | numeric assumption? |
  |---|---|---|
  | `usage-event.mjs:25,29,74,87,88` | producer + schema | the change itself |
  | `cost-budget.mjs:63-65` | aggregation | **no** — branches on `usageReliability` and `continue`s before touching either field |
  | `tiered-shadow-compare.mjs:480` | aggregation | **no** — reads `unavailableCostEventCount` (a count), never the money |
  | `bakeoff-collect.mjs:188-209` | producer + aggregation | **no** — `armCostUsd` already returns `usd: null` today for an unpriced model, so every existing consumer of `readArmResult().costUsd` already handles null; this adds a second reason for an already-reachable null, not a new nullable |
  | `tests/cost-budget.test.mjs` | assertions | updated with the change |

  **No presentation, serializer, or dashboard reader exists** — there is no
  currency formatter, report renderer, or collector anywhere that reads these
  fields, so there is no `null → "$NaN"` surface to guard. And because
  `z.number().min(0)` → `z.number().min(0).nullable()` is a **widening**, every
  historical serialized event still parses on load (`tests/cost-budget.test.mjs:205`
  exercises that load path); only newly-written events can carry null, and the
  sole aggregator already skips exactly those.
- `scripts/bakeoff-collect.mjs:197-200` — `usd += r.totalUsd` would add `null`
  as 0. Treat unmeterable like unpriced: the arm total becomes `null`.
- `scripts/lib/audit/legacy-production-audit.mjs:3148` — audited, **no change
  needed**: it prices a locally-reduced aggregate whose token fields are always
  finite numbers, so `unmeterable` cannot be true there.

### 1.6 `r15m2phaseenum` — `model-eval/cost.mjs` (MED)

`byPhase: z.record(z.string(), …)` accepts any key while the phase enum sits
inline on line 17.

**The obvious fix is wrong** (audit-plan R1 H2, verified by execution against
the installed zod 4.4.3). In Zod 4 `z.record(enumSchema, v)` is **exhaustive** —
it requires *every* enum member to be present:

```
z.record(z.enum(['generation','extraction','judge']), z.number())
  .safeParse({ generation: 1 })   // → REJECTED (invalid_type)
z.partialRecord(same…).safeParse({ generation: 1 })  // → ACCEPTED
z.partialRecord(same…).safeParse({ bogus: 1 })       // → REJECTED
```

`byPhase` **is legitimately sparse**: `assembleCostRows` only creates a key for
a phase that actually produced usage events (`cost.mjs:188`), so a run with
generation-only events yields `{generation: …}`. The naive swap would reject
valid rows — and would immediately fail the *existing* tests at
`tests/model-eval-core.test.mjs:704-705`, which assert on two-phase and
one-phase `byPhase` maps with no `judge` key.

**Fix**: `byPhase: z.partialRecord(PhaseEnum, CostPhaseEntrySchema)` — constrains
keys to the enum without requiring all of them. Extract `PhaseEnum` as a named
const and reuse it for the `phase` field on line 17 (the SSoT half of the
original finding).

### 1.7 `r15m3tokendry` — `model-eval/cost.mjs` (MED)

Local `isValidTokenCount` (`:147`) is byte-equivalent to `model-pricing.mjs`'s
exported `isValidCount` (`:105`), from a module `cost.mjs` **already imports**.
**Fix**: delete the local copy, import the shared one.

---

## 2. File plan

| File | Change |
|---|---|
| `scripts/lib/store/model-eval.mjs` | §1.1 finite-number check |
| `scripts/lib/model-eval/cost.mjs` | §1.2 sum-check fail-closed; §1.6 `PhaseEnum`; §1.7 import `isValidCount` |
| `scripts/lib/model-pricing.mjs` | §1.3 `Object.hasOwn`; §1.5 `unmeterable` |
| `scripts/lib/model-eval/deterministic-scorer.mjs` | §1.4 global-order assignment + path-match rank |
| `scripts/lib/audit/usage-event.mjs` | §1.5 consequential — `unmeterable` → `'unavailable'` + nullable money fields |
| `tests/cost-budget.test.mjs` | §1.5 guard — unmeterable event emits null money, not `$0` |
| `scripts/bakeoff-collect.mjs` | §1.5 consequential — unmeterable arm total → `null` |
| `tests/model-eval-core.test.mjs` | §1.1 guard — see the placement note below |
| `tests/audit-arms.test.mjs` | §1.3, §1.5 guards (existing pricing suite) |
| `tests/model-eval-core.test.mjs` | §1.2, §1.4, §1.6, §1.7 guards (existing model-eval suite) |

Not touched: `scripts/lib/model-eval/verdict.mjs` (§0.2 declined),
`model-pricing.mjs:96-100` fail-fast loop (§0.1 refuted).

### 2.1 Persisted-data compatibility (audit-plan R1 H4)

The finding is the right question — §4 asserted "no persisted-state change"
while tightening a validator the plan itself describes as guarding
deserialized rows. Answered by inventory rather than assertion.

**`CostRowSchema.parse` has exactly one call site: `cost.mjs:197`, inside
`assembleCostRows` — a WRITE path.** There is no read-path parse, so no stored
row is ever re-validated by this schema and no historical row can become
unreadable. Full consumer inventory (`git grep CostRowSchema|assembleCostRows`):

| consumer | how it touches a cost row | affected? |
|---|---|---|
| `cost.mjs:197` | `CostRowSchema.parse` on freshly-assembled rows | **write path** — the only parse |
| `model-eval-auditor.mjs:236-260` | consumes the returned rows, embeds them as `cost.byRow` in the run bundle (jsonb) | no — writes what the schema just validated; never re-parses |
| `lib/solo-control/scoring.mjs:198` | reads a `{totalUsd, costStatus}`-shaped object | no — duck-typed, never calls `.parse` |
| `lib/model-ab-decision.mjs:176-243` | aggregates `model_ab_arm_cost` DB rows | no — a **different** row shape, not `CostRowSchema` |

Neither tightening can reject `assembleCostRows`' own future output either:
it emits `costStatus:'available'` only when no phase is unpriced (`:199-200`),
which is precisely the new §1.2 precondition, and `z.partialRecord` accepts the
sparse maps it builds. So the change is **write-path-only and self-consistent**;
§4's "no persisted-state change" stands, now with evidence instead of assertion.

## 3. Acceptance criteria

1. `isJsonbSafeValue(NaN)` and `isJsonbSafeValue(Infinity)` are `false`; a
   bundle carrying `NaN` in a jsonb-bound record is **rejected at the schema
   boundary**, not silently written as `null`.
2. `CostRowSchema.parse` **throws** on `costStatus:'available'` with any
   `byPhase` entry of `status:'unavailable'`, and on a `totalUsd` that does not
   equal the phase sum.
3. `CostRowSchema.parse` **throws** on a `byPhase` key outside
   `generation|extraction|judge`, **and still accepts a sparse map** — a
   generation-only row, and a generation+extraction row with no `judge`, both
   parse (the Zod-4 exhaustiveness trap of §1.6).
4. `priceFor('constructor')`, `priceFor('toString')`, `priceFor('valueOf')`
   each return `null`.
5. `costFromUsage(null, <priced model>)` returns `unmeterable: true` and
   `totalUsd: null` — never `priced:true, totalUsd:0`. Same for `{}`, a
   one-sided usage object, and a non-numeric/negative token field. A
   genuinely-zero usage `{input_tokens:0, output_tokens:0}` stays
   `unmeterable: false, totalUsd: 0` (a true zero is not "missing"). A
   fully-valid usage object returns `unmeterable: false` with a cost
   **byte-identical to before this change** (no regression in the priced path).
6. `buildUsageEvent` (usage-event.mjs) tags an unmeterable call
   `usageReliability: 'unavailable'` **and emits `costAmountUsd: null`,
   `costAmountEurAtRecordedFx: null`** — asserting the label alone is not
   sufficient to pass this criterion. A priced+meterable call still emits a
   finite number, and a `selfReportedCostUsd` call still emits `'exact'` with
   its reported number. `armCostUsd` (bakeoff-collect.mjs) returns `usd: null`
   when any call is unmeterable.
7. `scoreDefectLocalization` returns a **maximum-cardinality** matching:
   - the R1 H1 counterexample (A→X, A→Y, B→X eligible; B→Y not) scores
     `correct: 2`, not 1;
   - metrics are identical under permutation of `candidateOutputs` **and** of
     `expectedRubrics`;
   - a rubric whose only eligible candidates were taken by other rubrics is
     reported as `candidate-consumed-by-another-rubric`, **not** as
     `no-matching-candidate-output` — the evaluation never tells a human the
     model missed a defect it actually reported;
   - an **ambiguous basename produces no edge**: with candidates in both
     `src/a/config.js` and `src/b/config.js` and a rubric naming only
     `src/b/config.js`, the `src/a` candidate is **not** credited — the
     wrong-file match is impossible, not merely deprioritised. An unambiguous
     basename still matches (the fallback keeps working for a moved file);
   - the existing 500-per-side / 20,000-pair precondition still throws
     **before** any edge is built.
8. `cost.mjs` contains no local token-validity helper; `isValidCount` is
   imported from `model-pricing.mjs`.
9. `npm test` green — no suite skipped, no SKIP-count movement.

## 3.5 Deferred findings (audit-code R1–R6)

Six `/audit-code` rounds ran. Everything in-scope was fixed (§1 plus the
round-by-round hardening recorded in the source comments). These remain open,
each deferred on **independence** — the shipped change does not call or depend
on the cited path — never on authorship. Anything below that is merely
"pre-existing" but load-bearing for this change was fixed, not deferred.

| finding | rounds | why the shipped change does not ride on it |
|---|---|---|
| **Validate-then-persist TOCTOU** — the guard validates a live object; the DB seam serializes it again later, so a value mutated in between is written unvalidated | R4 H1, R5 H3, R6 H1 | Generic to **every** Zod boundary in the repo, not to this seam: any `.parse()` returns while the caller still holds the mutable input. Closing it means persisting the validated *serialized representation*, which changes the `db/query.mjs` jsonb write contract that AGENTS.md governs ("pass jsonb values raw — the seam handles it") — a different plan. The fix here strictly *shrinks* the reachable surface (no serializer is invoked, no accessor is read, only stock Dates and plain data pass), so it cannot enlarge this exposure. Re-raised three rounds with no new evidence. |
| **`tryBuildUsageEvent` swallows every error** and returns `null` with no reason or counter | R1, R3, R4, R6 | Documented, deliberate fail-open for ADVISORY telemetry (its own docstring: a malformed payload "must degrade to a dropped event, NEVER throw up through a Stage-1/Stage-2 call and abort the audit"). It is a 5-line `try/catch` **delegating** to `buildUsageEvent`, so this change lands inside it unchanged. Adding a dropped-event counter is a real improvement and a separate, observability-shaped change. |
| **Oversized test module** (`model-eval-core.test.mjs`, ~70K chars) | R1, R3, R4, R6 | Splitting it is a test-layout refactor touching no production code. Note the tension: the Gemini plan gate specifically directed the jsonb tests *into* this file (§1.1) as the correct seam-owner, so shrinking it is not a decision to take mid-change. |
| **Oversized `bakeoff-collect.mjs`** (CLI + policy + pricing + orchestration) | R3, R4 | 8 lines of a ~700-line module were touched, in one function (`armCostUsd`). Its correctness does not depend on the module's other concerns. |
| **4× cross-domain imports** — `model-ab store`/`arm-eval` → `audit-arms.mjs`; `dashboard`/`solo-control` → `model-ab-decision.mjs` | R1–R6 | **None of these four files is in this diff.** They are standing architecture-pass findings about the domain graph, surfaced on every run in this area regardless of the change. The repo already tracks them via `domain-map.json` `allowedDeps`. |
| **`OSS_PRICING` shallow-frozen; `priceFor` returns live references** | R1 M3 | `Object.freeze` is one level deep, so nested price records stay mutable — true before and after. The `Object.hasOwn` fix changes *which key* is looked up, not whether a reference is returned; no new mutation path. |
| **Empty `modelSentinel`/`resolvedModel` accepted** (`max(100)`, no `min(1)`) | R1 M6 | Untouched fields. The money-honesty contract keys on `usageReliability` and the price lookup, neither of which reads these. |
| `[Adjacency] ADJACENCY_INCOMPLETE` | R2–R6 | Not a finding — the wave's own control-state marker (`maxContainers=20` coverage cap), listed in `control_marker_prefixes` precisely so it is not counted as signal. |

## 4. Rollback

Additive/defensive changes only. Every fix is covered by extending an
**existing** suite rather than adding a test file — `r15h1jsonbfinite` by
`tests/store-jsonb-array-serialization.test.mjs` (the existing guard for this
exact seam), pricing by `tests/audit-arms.test.mjs`, model-eval by
`tests/model-eval-core.test.mjs`. Revert is a clean `git revert` of the single
commit; no migration, no schema change, no persisted-state change.

---

## Appendix — original triage entry table

**`scripts/lib/model-eval/cost.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `r15h2costrowagg` | HIGH | model-eval/cost.mjs:81-103 sum-check skipped when any byPhase entry unpriced |
| `r15m2phaseenum` | MEDIUM | model-eval/cost.mjs:80 byPhase record unconstrained vs phase enum |
| `r15m3tokendry` | MEDIUM | model-eval/cost.mjs:147 local isValidTokenCount duplicates model-pricing.mjs isValidCount, never imported |

**`scripts/lib/model-eval/deterministic-scorer.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `62d7faf3cd80` | HIGH | model-eval/deterministic-scorer.mjs:200-210,104-105 greedy match + basename fallback collision-prone |

**`scripts/lib/model-eval/verdict.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `r15m7godmodules` | MEDIUM | model-eval files still multi-concern, no dedicated cleanup occurred |

**`scripts/lib/model-pricing.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `adbda8c8` | HIGH | model-pricing.mjs:108-109 no Object.hasOwn guard on bracket lookup |
| `c5808479` | MEDIUM | model-pricing.mjs:128-149 costFromUsage no usageMissing/isValidCount check |
| `f68a6dbc` | HIGH | model-pricing.mjs:70-78 fail-fast loop cannot validate future/unlisted models |

**`scripts/lib/store/model-eval.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `r15h1jsonbfinite` | HIGH | store/model-eval.mjs:79 isJsonbSafeValue returns true for any number without Number.isFinite check, NaN/Infinity pass |
