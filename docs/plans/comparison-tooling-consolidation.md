# Plan: Comparison-Tooling Consolidation

- **Date**: 2026-08-16
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend (two CLI entry points, their lib modules, their test suites)
- **Target domain(s)**: `scripts`, `shared-lib`
- **Predecessor**: [`role-agnostic-comparison-core.md`](./role-agnostic-comparison-core.md)
  (Clusters A–C, shipped `916147a0..e70cb2bf`). That plan built the shared core
  correctly; this one pays the debt its own audit rounds kept deferring.

## Audit trail

| Gate | Rounds | Result |
|---|---|---|
| GPT (`/audit-plan`) | **5 of 5 (absolute cap)** | H 2→2→4→2→3, M 3→3→0→3→2, L 0→1→0→0→0. **25 findings, 25 accepted as fix-now — zero dismissals, zero deferrals, zero rebuttals (100% every round).** |
| Gemini (`--mode plan`, mandatory) | **3** (2-round cap + one genuine-bug exception) | R1 `CONCERNS` — 4 findings **+ 1 over-engineering flag**, coherence `Adequate`. R2 `CONCERNS` — 2 findings, coherence **`Strong`**, 0 over-eng. R3 **`APPROVE`** — **0 new, 0 wrongly-dismissed, 0 over-engineering**, coherence `Strong`. **7 of 7 accepted.** |

**Total: 32 findings across both gates, 32 accepted, 0 dismissed, 0 deferred, 0 rebutted.**

> **Why a 3rd Gemini round.** The cap is 2; R2's two findings were both concrete
> *design* defects (an enforcement mechanism that would have been silently inert,
> and a promotion path that could never succeed), which is the documented
> genuine-bug exception rather than rigor pressure. It was also warranted
> empirically: **each of my last two fix-rounds had introduced a fresh defect the
> next round caught**, so a material change deserved verification rather than
> assumption. R3 returned `APPROVE` with nothing outstanding.
>
> **Both R2 findings were caught by reading the repo, not by argument** — and one
> of them falsified two of my own claims at once: `allowedDeps` is a top-level
> block that no rule carries (so the proposed JSON would have been ignored), and
> `campaign/**` + `comparison/**` already share the `shared-lib` domain (so
> `arm-vocabulary-layering` operates at a granularity that **cannot** enforce
> this plan's module table at all). The claim of mechanical enforcement is
> withdrawn and replaced with a test that works at module level.

**Stop decision**: the absolute 5-round cap, not convergence. Acceptance never
fell below 100%, and R5's findings were still concrete design defects rather
than rigor pressure — by the skill's own rule the loop was still productive when
the cap ended it. Recorded plainly because "we stopped because we ran out of
rounds" and "we stopped because the plan was done" are different facts.

**What the rounds actually bought** — each round largely audited the *previous*
round's fixes, which is the propagation pattern the skill documents, and it
repeatedly caught the author contradicting himself:

| Round | The finding that mattered |
|---|---|
| R1 | "Required parameters make an omitted scope unrepresentable" — **false in JS**; and two loose params can be mixed across campaigns |
| R2 | Adding `campaignId` makes a mismatch *observable*, not *detected* — nothing said where it is **compared** |
| R3 | Cluster A claimed to deliver D1 while `scope.mjs` was created a phase later; D1 and D1a **contradicted each other** on unjudgeable entries |
| R4 | R3's own fix authorised a **dependency cycle** (`campaign → bakeoff` against `bakeoff/arms → campaign/config`) |
| R5 | The R4 brand **cannot** restrict construction to `arms.mjs` (the claim is withdrawn); Phases 2–3 would have **broken every existing test import** |

Three of those five are the plan falsifying its own prior round. That is the
argument for having run the loop past the default cap.

---

## 1. Context Summary

### Why now, stated as a measurement rather than a feeling

The predecessor plan shipped through **17 audit rounds** across three clusters.
In essentially every round, one finding was raised and deliberately deferred:
*oversized, multi-responsibility modules*. It appears as Cluster B R1/H6, R2/H5,
R3/M12–M17, R4/M2, R5/H4, R6/M2, and again in Cluster C. Each individual
deferral was correct — splitting a module mid-fix-gate is out of proportion to
the bug being fixed that round. **Six correct deferrals in a row is the
definition of debt that is now due**, and deferring a seventh time would be the
band-aid AGENTS.md names.

**Measured 2026-08-16** (`wc -l`, on `e70cb2bf`):

| File | Lines | vs. repo median |
|---|---:|---:|
| `scripts/bakeoff-collect.mjs` | 1424 | **7.4×** |
| `scripts/campaign.mjs` | 1338 | **6.9×** |
| `tests/model-eval-core.test.mjs` | 1266 | 6.6× |
| `tests/campaign-adjudication.test.mjs` | 1080 | 5.6× |
| `tests/audit-store-durability-call-site.test.mjs` | 877 | 4.5× |
| `scripts/lib/store/model-eval.mjs` | 621 | 3.2× |
| `scripts/model-eval-auditor.mjs` | 594 | 3.1× |

Median for `scripts/lib/**/*.mjs` is **193 lines over 487 files**
(`find scripts/lib -name '*.mjs' -exec wc -l {} +`). The repo already knows what
its own module size looks like; two files are outliers by an order of magnitude.

### The fault is not "files are big". It is a fallback used as a default parameter.

Size is the symptom that got reported. The **defect-generating** structure is
narrower and provable:

```js
export function summarise(entries, target = DEFAULT_TARGET,
                          arms = defaultArms(), expectedScope = defaultExpectedScope()) { … }
export function aggregateMatched(complete, arms = defaultArms()) { … }
export function zeroFindingArms(entry, arms = defaultArms()) { … }
export function isComplete(entry, arms = defaultArms(), expectedScope = defaultExpectedScope()) { … }
```

`defaultArms()` resolves the ambient campaign and, **on any failure, silently
returns the frozen `LEGACY_ARMS` table**. So "the caller forgot to thread the
campaign scope through" and "this is a legacy pre-campaign repo" produce the
same value, at every one of four call sites, with no error anywhere.

That has already caused one measured production incident and is causing a second
right now.

### Code Trace — measured, not inferred (2026-08-16)

> Every `file:line` below is pinned to **`e70cb2bf`**, and every figure carries
> the command that produced it. Re-derive rather than trust: line numbers decay
> into wrong-but-resolving references, which is the failure this repo's
> verification discipline names.

**Symbols in the affected neighbourhood** (`get-neighbourhood`, 2026-08-16):
`resolveArms` returned `recommendation: precedent`, `bandReason:
above-floor-cluster` — the strongest duplication signal — alongside
`deriveArms`, `defaultArms`, `_resetDefaultArms`, `transportForModel`,
`buildArmArgs`, `runArm`, `armCostUsd`, all in `scripts/bakeoff-collect.mjs`.
**This plan extends/relocates that existing cluster; it introduces no sibling
implementation beside it.** That is the D2 module boundary, derived from the
index rather than invented.

**(a) `defaultArms()` returns the legacy table in this repo today.**

```
resolveArms({}) throws: 2 campaigns found; pass --campaign <id>. …
defaultArms() === LEGACY_ARMS: true
defaultArms() ids: opus, solo-opus, kimi
```

Two committed campaigns make `resolveArms({})` throw *by design* (ambiguity is
never resolved by guessing). `defaultArms()` catches that throw and degrades to
`LEGACY_ARMS`. The degraded value is not marked, logged, or distinguishable
downstream.

**(b) Incident 1 — already fixed, symptomatically.** On 2026-08-14 `isComplete(entry)`
took that default and judged the scoped campaign's snapshots against
`opus, solo-opus, kimi`. The scoped campaign has no `solo-opus`, so a snapshot
whose four real arms all ran was judged INCOMPLETE **permanently** — N could
never advance and all twelve snapshots would have been paid for and counted
zero. The fix (`scopeForEntry`) threads explicit arms into `isComplete` at its
call sites. It did not remove the implicit default that made the mistake
possible.

**(c) Incident 2 — live, unreported, found by writing this plan.**
`summarise()` accepts correctly-scoped `arms`, then calls
`aggregateMatched(complete)` at `scripts/bakeoff-collect.mjs:913 (e70cb2bf)`
**without forwarding them**. Measured against the committed scoped campaign:

```
scoped campaign REAL arms      : opus, kimi, grok, gemini-control
what aggregateMatched iterates : opus, solo-opus, kimi   (defaultArms -> LEGACY_ARMS)
arms SILENTLY MISSED by the matched view: grok, gemini-control
phantom arms it looks for that do not exist: solo-opus
```

The matched-view aggregation — a reported campaign metric — drops two of four
arms and hunts one that does not exist. Same class as incident (b), one call
frame deeper, never caught, because the failure mode is a *plausible number*
rather than an error. `zeroFindingArms(e)` at
`scripts/bakeoff-collect.mjs:1075 (e70cb2bf)` takes the same default and is
exposed identically.

**This is the load-bearing argument for the whole plan.** The structure is not
merely inelegant; it has produced two defects of one class, and the second was
invisible to 17 rounds of audit *because reading a 1424-line file is how you
miss a parameter that is not passed*.

### `LEGACY_ARMS` — a claim I made and then falsified

I previously told the operator this table was a compatibility path for
"every consumer repo that has not adopted campaigns". **That is false, and the
measurement is one command:**

```
node scripts/sync-to-repos.mjs --dry-run | grep -c "\.claude-skills/bakeoff-collect\.mjs"
→ 0
```

`scripts/bakeoff-collect.mjs` is **not in `CORE_ENTRY`** and is not pulled in
transitively — it never ships to any consumer. (`scripts/lib/campaign/verdict.mjs`
and `scripts/lib/dashboard/collect-campaigns.mjs` *do* ship; the CLI does not.)
So the table has **no external compatibility obligation whatsoever**. Its only
live role in the only repo that runs it is being the silent wrong answer in (a).

This dissolves the one genuinely open question from the pre-plan discussion —
whether consumers must be migrated before the fallback can go. There are no
consumers. Nothing has to be migrated.

### D1a — …but "no consumers" is about CODE, not DATA (R2/H2)

The sync measurement proves no *external* migration is needed. It proves nothing
about **persisted local state**, and the audit was right that the first two
drafts conflated the two. The bake-off log is a real input surface —
`scopeForEntry(entry)` and `promoteFromLog` both read it — and today a
**historical entry with no `campaignId` silently resolves to `LEGACY_ARMS`**:

```js
// scripts/bakeoff-collect.mjs:405 (e70cb2bf)
if (!campaignId) return { arms: defaultArms(), expectedScope: defaultExpectedScope() };
```

**I cannot measure my way out of this one, and that is itself the finding.**
`.audit/bakeoff-log.jsonl` is a **gitignored runtime artifact** — absent from
this checkout, and its historical shape differs per machine. Any claim of the
form "all entries already carry a campaignId" would be an assertion about
mutable state I have not read, which is precisely the class of claim this repo's
verification discipline forbids. So the plan states a **policy that is correct
whether or not such entries exist**:

- **A log entry with no `campaignId` becomes `unjudgeable`, and is NAMED.**
  `scopeForEntry` returns `null` with a reason; readers report *"cannot judge:
  entry predates campaign declaration"* and **count it separately**, never
  folding it into a total.
- **This is the existing rule, extended — not a new one.** `scopeForEntry`
  already returns `null` for an *unresolvable* campaign, on the stated grounds
  that *"cannot judge and an arm did not run are different facts and must not
  share a message."* Keeping a silent fallback for the no-id case while
  refusing the unresolvable case was the inconsistency; D1 removes it.
- **Escape hatch, explicit rather than implicit**: an operator who knows what
  legacy entries belong to passes `--campaign <id>` to interpret them under a
  named campaign. A guess becomes a declared decision, which is the whole
  posture of `resolveArms`.
- **`promoteFromLog` reports rather than drops — and must NOT deadlock
  (Gemini R2/H).** The R5 wording ("refuse", non-zero whenever unjudgeable
  entries are present) was a **permanent denial of service**: legacy no-id
  entries never go away, so every future promotion of a perfectly valid modern
  campaign would fail forever on unrelated history. That trades a silent
  under-count for a stuck pipeline, which is worse — a command that can never
  succeed is a command people stop running, and *that* is how the invisible-spend
  incident started. The contract instead:
  - **Promote every judgeable entry.** Unjudgeable ones are **skipped and listed
    by id on every run** — persistent visibility is what answers the
    denominator-shrink concern, not failure.
  - **Exit non-zero only when a *judgeable* entry fails to promote** — a real,
    actionable failure of the operation actually requested.
  - **Exit zero when the only thing outstanding is unjudgeable history**, with
    the count and reason on stdout. The operator can adopt it deliberately
    (`--adopt-legacy`) or leave it; both are valid steady states, and neither is
    an error to be re-reported forever.

**Behaviour change, stated plainly**: historical pre-campaign entries stop being
summarised under a substituted arm set and start being reported as unjudgeable.
That is a visible change in the readout, and it is the honest direction — the
alternative is what produced incident (b).

#### D1b — Where "unjudgeable" and "must match" meet (R3/H2)

The two rules as written collided, and the audit was right to call it
unexecutable: **D1** says every summary function receives a non-null
`ResolvedScope` and asserts that *every* input entry carries that campaign id,
while **D1a** says a no-id entry is `unjudgeable` and *counted separately*. Under
D1 alone such an entry raises `ScopeMismatchError`; under D1a alone it is a
tallied fact. Both cannot be true at the same call.

They are reconciled by **partitioning before summarising**, never inside it:

```
resolveScopeForEntries(entries) →
  { scope: ResolvedScope, judgeable: Entry[], unjudgeable: Array<{entry, reason}> }
```

- **Scope resolution returns a tagged result, not a bare value or a bare null.**
  `{ok: true, scope}` | `{ok: false, reason}` — so "no campaign declared",
  "campaign unresolvable", and "resolved fine" are three distinguishable
  outcomes rather than two collapsed into `null`.
- **The partition is the orchestration point**, and it lives in the *reader*
  (`progress.mjs` / the CLI command), not in `summary.mjs`. It is the only place
  that sees both the raw entry list and the resolved scope.
- **`summarise`/`aggregateMatched`/`zeroFindingArms` therefore only ever receive
  `judgeable`** — entries already known to match. `assertScopeMatches` inside
  them is retained as a **structural backstop for a programming error**, not as
  the mechanism that handles legacy data. That distinction is the whole fix: one
  is a bug, the other is a data state.
- **`unjudgeable` is carried into the readout as its own count with its reason**,
  never silently dropped and never folded into `incomplete` — an unjudgeable
  entry and an incomplete one license different actions.

**The observable contract, because these numbers are campaign accounting
(R4/M3).** Classifying an entry is half a contract; what a consumer *sees* is
the other half, and downstream readers exist (the dashboard collector, the
stopping rule):

**Ownership, stated once and not alternated (R5/H1).** Earlier rounds named
*both* `progress.mjs` and "the CLI" as the partition owner, and put
`unjudgeable` on `summarise()`'s return while also saying `summarise()` only
ever receives judgeable entries — a straight contradiction, and `progress.mjs`
is forbidden from importing `arms.mjs` so it could not resolve scope anyway.
Resolved:

- **The CLI entry point owns the partition.** It is the only layer permitted to
  import `arms.mjs` (the resolver), and it already imports both subsystems.
- **`summarise()` is pure over judgeable entries and returns judgeable stats
  only.** It never sees, counts, or reports an unjudgeable entry.
- **The `unjudgeable` set travels beside the summary, not inside it** — the CLI
  hands both to `progress.mjs`, which renders them together. `progress.mjs`
  therefore needs no resolver, and the forbidden import stays forbidden.

| Surface | Contract |
|---|---|
| **readout envelope** (CLI-composed, **not** `summarise()`'s return) | `unjudgeable: {count, byReason: {reason: [entryId…]}}` — **excluded from `complete`, `incomplete`, `target` and `remaining`**, so every existing ratio keeps its current denominator |
| CLI readout | one line per reason with counts and ids, phrased as *"cannot judge"*, never merged into the incomplete list |
| **Exit code** | **zero.** A readout reporting unjudgeable entries has succeeded at reporting; it is not a gate. Only `promoteFromLog` refuses (non-zero), because promotion is an action on the data rather than a description of it |
| Legacy adoption | when `--adopt-legacy` reinterprets the `null` group, the readout **says so on its own line** — an adopted interpretation must never look like a native one |

The exit-code row is the one worth being explicit about: making a *readout* fail
because history is unjudgeable would push an operator to stop running it, which
is how the invisible-spend incident happened in the first place.

`summary.mjs` stays pure under this: the partition needs the scope and the
entries, both already in hand, and performs no I/O.

**A persistent log holds MANY campaigns, and one scope cannot summarise them
(R4/H1).** The R3 shape returned a single `scope` for a whole log — but a
long-lived bake-off log naturally contains entries from several valid campaigns
(**this repo has two committed today**), and every summary function is required
to reject a heterogeneous set. So resolution is **per campaign, never per log**:

```
groupByCampaign(entries) → Map<campaignId|null, Entry[]>
  ↳ for each declared campaignId: resolveScope(campaignId) → judgeable group
  ↳ the null-key group                                     → unjudgeable (D1a)
```

- **The reader iterates campaigns and summarises each group under its own
  scope.** This is not a new behaviour: `printProgress` **already** filters to
  one campaign's entries before summarising (`bakeoff-collect.mjs:958
  (e70cb2bf)`), for exactly this reason. D1b makes that filtering the *contract*
  rather than one caller's precaution.
- **`--campaign <id>` has one meaning, stated: it SELECTS.** It restricts the
  operation to that campaign's entries; entries of other declared campaigns are
  **excluded from the run, not reinterpreted and not an error** (they are
  another campaign's evidence, and silently rescoping them is incident (b)).
  Its *only* reinterpreting power is over the `null`-key group — legacy
  entries with no `campaignId` — and only when combined with `--adopt-legacy`,
  so that adopting historical evidence is a distinct, deliberate act rather than
  a side effect of naming a campaign.

  **Adoption STAMPS at the partition; it is not a flag consulted downstream
  (Gemini/H).** As first written this was unimplementable: an adopted entry
  still has `campaignId: null`, so the moment it reached `summarise()` the
  `assertScopeMatches` backstop (`entry.campaignId === scope.campaignId`) would
  throw — the plan's own two mechanisms would have collided on the one path that
  exists to use both. The fix is that adoption is a **transformation performed
  by the partitioner**, at the only point that holds both the entries and the
  resolved scope:

  ```
  --adopt-legacy + --campaign X
    ↳ nullGroup.map(e => ({ ...e, campaignId: X, adopted: true }))
    ↳ these join the judgeable set and satisfy assertScopeMatches naturally
  ```

  Downstream code needs **no adoption awareness whatsoever** — `summarise()`
  sees ordinary matching entries and stays pure. The `adopted: true` marker
  exists solely so the readout can disclose the reinterpretation (per the
  observable-contract table); nothing branches on it. Without `--adopt-legacy`
  the null group is never stamped and remains `unjudgeable`.
- **With no `--campaign` and more than one campaign present, the command
  refuses** — the same ambiguity refusal `resolveArms` already makes. It does
  not pick, and it does not silently summarise all of them.

---

## 2. Proposed Architecture

### D1 — One validated scope VALUE, passed whole; `defaultArms()` and `LEGACY_ARMS` are retired

**The root fix, and the reason the two incidents cannot recur.**

> **Revised in R1 (H1), and the revision makes this smaller, not larger.** The
> first draft said "make `arms` and `expectedScope` **required parameters**" and
> claimed that made an omitted scope *unrepresentable*. That claim was false in
> two ways the audit was right to reject: these are `.mjs` functions, so a caller
> can still pass `undefined` and get an incidental `TypeError` deep inside a loop
> rather than an intentional refusal; and **two independent parameters can be
> mixed from two different campaigns**, which no arity rule detects. Removing a
> default expression is not a contract.

The contract already half-exists and is being *destructured apart* at every call
site — which is precisely what permits the mismatch:

```js
// scripts/bakeoff-collect.mjs:404 (e70cb2bf) — already returns a scope VALUE
export function scopeForEntry(entry) { … return { arms, expectedScope }; }
// …and every caller immediately takes it apart again:
return isComplete(entry, scope.arms, scope.expectedScope);   // :419 (e70cb2bf)
```

So D1 promotes that existing shape into the contract rather than inventing a
type beside it:

- **`ResolvedScope` is the only way to obtain arms.** `{campaignId, arms,
  expectedScope}`, returned **only** by the resolver
  (`resolveArms`/`scopeForEntry`).
- **`isComplete`, `summarise`, `aggregateMatched`, `zeroFindingArms` take that
  one value**, never its parts. A caller cannot assemble a half-scope, because
  there is no longer a shape to assemble it from.
- **Validated at the public boundary**, not trusted: absent, malformed, or
  duplicate-arm-id scope raises a **named** `UnresolvedScopeError` that the CLI
  maps to a non-zero exit — the same refusal-rather-than-guess posture
  `resolveArms` already takes on ambiguity.

**R2/H1 — an id makes a mismatch observable; it does not detect one.** The R1
revision added `campaignId` and then never said where it is *compared*, so a
scope for campaign A could still be handed to `isComplete(entryFromB, scope)`.
Two additions close that, and they are the difference between a contract and a
label:

- **Every operation that receives BOTH an entry-set and a scope asserts identity
  against its own input**, and refuses on mismatch with a named
  `ScopeMismatchError`:
  - `isComplete(entry, scope)` → `entry.campaignId === scope.campaignId`.
  - `summarise(entries, scope)` / `aggregateMatched(entries, scope)` /
    `zeroFindingArms(entry, scope)` → **every** entry must match. A
    heterogeneous entry set is refused, not silently summarised — that is the
    literal shape of incident (b), where one campaign's snapshots were judged by
    another's arms.
- **`Object.freeze` is shallow, and the audit was right to say so**: freezing
  the record leaves `arms` mutable. `ResolvedScope` is frozen **deeply** —
  record, `arms` array, and each arm object — so a downstream reader cannot
  quietly rewrite the arm set it was handed.

**R2/M1 — the pure/impure split, because a "types only" import does not exist in
`.mjs`.** The R1 table claimed `spawn.mjs` imports `arms.mjs` *"(types only)"*
and that `summary.mjs` is pure *while importing* the resolver that reads
`.campaigns/`. Both were incoherent — there is no type-only import at runtime,
and importing a config-reading module makes the importer impure by construction.
The shape that actually holds:

| Module | Role | I/O |
|---|---|---|
| `bakeoff/scope.mjs` | `ResolvedScope` shape, `createResolvedScope`, `assertResolvedScope`, `assertScopeMatches`, both error classes | **none — pure** |
| `bakeoff/arms.mjs` | the resolver: reads `.campaigns/`, derives arms, **returns** a `ResolvedScope` | reads config |

**R4/M1 — structural validation cannot prove provenance, so the claim needed
teeth.** D1 says `ResolvedScope` is "the only way to obtain arms", but the
validation specified was structural only (present, well-formed, no duplicate arm
ids). Any caller could hand-build `{campaignId: 'A', arms: alteredArms,
expectedScope: altered}`, pass every check, and satisfy `assertScopeMatches` for
campaign-A entries. Deep-freezing stops later *mutation*; it does not establish
*derivation*. The central claim was therefore false as written.

**There is no provenance brand. R4 proposed one; it is WITHDRAWN (Gemini
over-engineering flag).** The history is kept because the reasoning is the
useful part:

- **R4/M1** observed that structural validation cannot prove a scope was derived
  from config, and proposed a module-private `Symbol` stamped by
  `createResolvedScope`.
- **R5/H3** showed the brand cannot restrict construction to `arms.mjs` — the
  constructor must be exported for `arms.mjs` to call it, so anything can import
  it. The claim was narrowed to "produced by the sanctioned constructor".
- **The Gemini gate then flagged the narrowed version as theatre, and that is
  correct.** Follow it through: the brand's only remaining catch is a
  hand-written `{campaignId: 'A', arms: [...]}` literal — but writing that means
  *explicitly authoring an arm set*, which is a deliberate act. **Both incidents
  were caused by arms arriving IMPLICITLY** (`defaultArms()` supplying them
  silently). Once D1 deletes the implicit default, arms cannot be obtained by
  accident at all — so the brand defends against a threat the rest of the design
  has already eliminated, at the cost of ceremony on every construction.

`scope.mjs` therefore exports a plain **`createResolvedScope(campaignId, arms,
expectedScope)`** that validates structurally and **deep-freezes** — one place
that guarantees the freeze, no `Symbol`, no provenance claim. `assertResolvedScope`
checks shape only, and says so.

> Recorded because rejecting the over-built cliff is as much a part of this
> repo's design rule as rejecting the band-aid, and it is the easier of the two
> to talk yourself out of when you authored the thing being cut.

`summary.mjs` and `spawn.mjs` import **`scope.mjs` only**. They therefore stay
genuinely pure/side-effect-bounded, no phantom type-only import is needed, and
the module that *owns* the definition is not the module that performs the I/O.
Canonical validation lives in `scope.mjs` (structural) and is invoked by
`arms.mjs` at construction (the config-backed boundary), so there is exactly one
place each check happens.
- `defaultArms()`, `defaultExpectedScope()`, `_resetDefaultArms()` are **deleted**.
  Their entire purpose was to supply the implicit default this decision removes.
- `resolveArms({})` with **no campaign** becomes a refusal, exactly as ambiguity
  already is. The existing comment's own reasoning generalises without
  amendment: *"which campaign ran is not a detail a spend-bearing runner may
  decide on the operator's behalf"* — that is equally true of "no campaign at
  all". One rule, both cases, no fallback.
- `LEGACY_ARMS` **moves into `tests/bakeoff-arms.test.mjs`** as a frozen
  expected-value fixture — the same destination §D3's matrix and §6b Phase 1
  give it, alongside the `deriveArms` byte-identity block that is its only
  consumer. (Earlier drafts said `final-review-bakeoff.test.mjs` here and
  `bakeoff-arms.test.mjs` there; the matrix is authoritative and this prose was
  the stale copy — Gemini/L.) That fixture is its one honest remaining role:
  proving the Phase-2 config-derived arms are byte-identical to the table they
  replaced. A frozen expectation belongs in the test that asserts it, not in the
  production module as a live fallback that happens to also be asserted.

**Why not the band-aid.** The minimal fix for incident (c) is one word —
forward `arms` at line 913. Rejected: it fixes the instance and leaves the
generator. There are four defaulted parameters across four exported functions;
the next person to add a fifth reader inherits the same trap, and the failure
stays a plausible number rather than an error.

**Why not the over-built version.** Still no resolver injection, no ambient
context, no DI container — those decouple things that are not coupled, and the
call graph is shallow (one scope per invocation). `ResolvedScope` is a frozen
record returned by a function that already returns that record. The abstraction
count does not go up; the number of ways to hold it wrong goes down.

**Migration is bounded and mechanical**: 4 signatures, and by measurement 8 call
sites, of which 6 already pass explicit scope and 2 are the defects.

### D2 — Decompose the two outlier CLIs into the layout this repo already uses

`scripts/*.mjs` are thin entry points; `scripts/lib/**` are focused modules.
That is stated in AGENTS.md and holds for 487 files. These two never got it.

The seams are not invented for this plan — they are the clusters the
architectural-memory consultation returned (`resolveArms`, `deriveArms`,
`transportForModel`, `buildArmArgs`, `runArm`, `armCostUsd` all scored
`precedent / above-floor-cluster` in one neighbourhood):

| New module | Moves from | Responsibility |
|---|---|---|
| `scripts/lib/bakeoff/arms.mjs` | `bakeoff-collect.mjs` | `resolveArms`, `deriveArms`, `transportForModel`, scope resolution |
| `scripts/lib/bakeoff/spawn.mjs` | `bakeoff-collect.mjs` | `buildArmArgs`, `runArm`, subprocess/env shaping |
| `scripts/lib/bakeoff/log.mjs` | `bakeoff-collect.mjs` | log read/append, entry shape, receipts |
| `scripts/lib/bakeoff/summary.mjs` | `bakeoff-collect.mjs` | `summarise`, `aggregateMatched`, `zeroFindingArms`, `armCostUsd` |
| `scripts/lib/bakeoff/progress.mjs` | `bakeoff-collect.mjs` | `printProgress` and its rendering |
| `scripts/lib/campaign/adjudicate.mjs` | `campaign.mjs` | worksheet build, blinding, verdict normalisation |
| `scripts/lib/campaign/cited-source.mjs` | `campaign.mjs` | `centredWindow`, `citedLineOf`, `resolveCitedSources` |
| `scripts/lib/campaign/promote.mjs` | `campaign.mjs` | `promoteFromLog`, `isArmRetried`, reconcile mechanics |

Entry points keep argv parsing, command dispatch, and process exit — nothing else.

**This is relocation, not redesign.** Function bodies move verbatim except where
D1 changes a signature. That is what makes the diff reviewable and the risk low;
a decomposition that also rewrites logic cannot be reviewed as either.

#### D2a — The dependency contract (added in R1/H2; a label is not a boundary)

R1 correctly flagged that responsibility labels do not constrain imports, and
that the original file plan hid an unresolved question behind the words *"follow
moved imports **if any** resolve through the CLI"*. **Resolved by measurement
rather than left conditional** — `scripts/lib/dashboard/collect-campaigns.mjs
(e70cb2bf)` imports exactly:

```
../campaign/config.mjs · ../campaign/verdict.mjs · ../comparison/spend.mjs
../store/campaign.mjs  · ../store/repo.mjs       · ../config.mjs
```

**No lib module imports either CLI entry point**, so the dashboard needs **no
change at all** and that file-plan row is deleted. The leak the finding feared
does not exist today — and D2b below is what stops the decomposition creating it.

**The one-way rule**, which the repo already enforces mechanically rather than by
convention: `entry point → lib`, never the reverse; sibling lib modules may
depend only *downward* in this list.

| Module | Exports | May import | Must NOT import | Side effects |
|---|---|---|---|---|
| `bakeoff/scope.mjs` | `ResolvedScope`, **`createResolvedScope`**, `assertResolvedScope`, `assertScopeMatches`, `UnresolvedScopeError`, `ScopeMismatchError` | *(nothing in this repo)* | everything else here | **none — pure** |
| `bakeoff/arms.mjs` | `resolveArms`, `deriveArms`, `transportForModel`, `scopeForEntry` | `bakeoff/scope`, `lib/campaign/config`, `lib/comparison/*` | any `scripts/*.mjs` entry point; `bakeoff/spawn`, `bakeoff/log` | reads `.campaigns/` |
| `bakeoff/log.mjs` | log read/append, receipt shape | `lib/file-io` | any entry point; `bakeoff/spawn`, `bakeoff/summary` | reads+appends the bake-off log |
| `bakeoff/spawn.mjs` | `buildArmArgs`, `runArm` | `bakeoff/scope` | any entry point; **`bakeoff/arms`**; `bakeoff/summary`, `bakeoff/progress` | **spawns child processes** |
| `bakeoff/summary.mjs` | `isComplete`, `summarise`, `aggregateMatched`, `zeroFindingArms`, `armCostUsd` | `bakeoff/scope`, `lib/comparison/spend` | any entry point; **`bakeoff/arms`**; `bakeoff/spawn`, `bakeoff/log` | **pure** |
| `bakeoff/progress.mjs` | `printProgress` | `bakeoff/summary`, `bakeoff/log` | any entry point; `bakeoff/spawn` | writes stdout |
| `campaign/cited-source.mjs` | `centredWindow`, `citedLineOf`, `resolveCitedSources` | `lib/comparison/paths` | any entry point | reads repo files at a revision |
| `campaign/adjudicate.mjs` | worksheet build, blinding, verdict normalisation | `campaign/cited-source`, `lib/campaign/config` | any entry point; `campaign/promote` | none (provider call stays in the CLI) |
| `campaign/promote.mjs` | `promoteFromLog(entries, …)`, `isArmRetried` | `lib/store/campaign` | any entry point; **`bakeoff/**` (R4/H2 — no cycle)**; `campaign/adjudicate` | **writes the store**; does NOT read the log |

`bakeoff/summary.mjs` being **pure** is load-bearing: it is where both incidents
happened, and a module that spawns nothing and writes nothing can be tested
exhaustively without a rig.

#### D2b — The rule is enforced, not documented

A dependency table nobody checks is a comment. **The R5 draft claimed the domain
map would enforce this one. Read against the real file, that claim was wrong
twice over (Gemini R2/M) — both errors are corrected here.**

**Error 1 — the JSON shape was invented.** R5 wrote `allowedDeps` *inside* the
rule object. Measured against `.audit-loop/domain-map.json`: `allowedDeps` is a
**top-level block keyed by domain**, and **no rule carries it** — a rule is
`{"pattern", "domain"}` and nothing else. The proposed JSON would have been
silently ignored, producing exactly the decorative boundary this section exists
to prevent.

**Error 2 — and the domain layer is the wrong granularity anyway.** Measured:
`scripts/lib/campaign/**` and `scripts/lib/comparison/**` **both resolve to the
existing `shared-lib` domain**, not to domains of their own. So:

- Giving `bakeoff/**` its own domain would invent a boundary **its own siblings
  do not have**, turning `bakeoff/arms -> campaign/config` into a cross-domain
  edge needing a declaration the equivalent `comparison -> campaign` edge has
  never needed. `bakeoff/**` therefore joins **`shared-lib`**:

  ```jsonc
  // rules[] — pattern + domain ONLY, matching every existing rule's shape.
  // Placed above the scripts/lib/** catch-all; ordering is significant.
  { "pattern": "scripts/lib/bakeoff/**", "domain": "shared-lib" }
  // No allowedDeps entry: bakeoff, campaign and comparison are ONE domain,
  // so every edge in the D2a table is INTRA-domain by construction.
  ```

- **Consequence, stated rather than glossed: `arm-vocabulary-layering` CANNOT
  enforce the D2a table.** It checks *domain*-level edges; D2a is a *module*-level
  contract inside a single domain. The R5 claim of mechanical enforcement was
  false. The honest replacement operates at module granularity:
  - **`tests/bakeoff-module-contract.test.mjs`** (new, Phase 2) parses each
    `scripts/lib/bakeoff/*.mjs`'s `import` statements and asserts the forbidden
    edges are absent — `summary`/`spawn` must not import `arms`; no lib module
    may import a `scripts/*.mjs` entry point; `campaign/promote` must not import
    `bakeoff/**`. Static, small, fails at push like everything else here.
  - The domain rule still earns its place for what it genuinely does: it keeps
    `bakeoff/**` off the `scripts/lib/**` catch-all — the defect that split
    `lib/cross-skill/**` from `cross-skill.mjs` and produced 10 violations.
  - `arm-vocabulary-layering` stays a Phase 2/3 exit condition for the
    domain-level guarantee it really provides.
- **BOTH ends of the new cross-subsystem edge are declared (R3/H3).** The table
  above introduces `campaign/promote.mjs → bakeoff/log.mjs`, and the R2 draft
  scheduled only the *bakeoff* rule — so the **existing `scripts/lib/campaign/**`
  rule would have needed `bakeoff` in its `allowedDeps` and did not get it**.
  That is this plan committing, in its own text, the exact one-sided error
  AGENTS.md records: *"retagging a module changes every edge INTO it — the
  second half is the one that gets forgotten, because it is invisible from the
  file you are editing."*

  **R4/H2 — and declaring that edge was itself wrong.** Adding `bakeoff` to
  `campaign`'s `allowedDeps` would have legitimised a **cycle**:
  `bakeoff/arms.mjs` imports `lib/campaign/config.mjs` (a `bakeoff → campaign`
  edge) while `campaign/promote.mjs → bakeoff/log.mjs` runs the other way — and
  the same paragraph declared `bakeoff → campaign` forbidden, so the plan
  required and prohibited one direction at once. **The R3 `allowedDeps` addition
  is REVERTED.** The edge is removed rather than declared, by inverting it:
  - **`campaign/promote.mjs` takes log entries as a PARAMETER** — it does not
    read them. `promoteFromLog(entries, …)` receives data; the **CLI entry
    point**, which already imports both subsystems and is the only layer
    permitted to, does `promoteFromLog(readLog(), …)`.
  - Net effect: **one permitted direction only — `bakeoff/** → campaign/config`**
    — and `promote.mjs` loses a file-reading side effect, becoming a pure
    transform over data it is handed. That is smaller than the declaration it
    replaces, and it removes the cycle instead of blessing it.
  - `scripts/lib/campaign/**`'s existing `allowedDeps` is left **unchanged**;
    only the new `scripts/lib/bakeoff/**` rule is added.
- **`tests/arm-vocabulary-layering.test.mjs`** re-derives the whole violation set
  from the import graph and runs in `npm test`, so a forbidden edge — **in either
  direction** — fails at push. Per AGENTS.md this is the check that must be run
  mechanically; a retag's inbound half is invisible to grep. **Running it is a
  Phase 2/3 exit condition, not a close-out afterthought**, because it is the
  only mechanism that can prove the two declarations above are complete.

### D3 — Test suites split along D2's seams, by an enumerated matrix

Assertions move **verbatim**. A split that edits assertions is a rewrite wearing
a refactor's clothes, and the suite is the only thing proving D1/D2 changed no
behaviour.

**The migration matrix (R1/M1 — enumerated, not described).** Destinations are
derived from the actual `describe` blocks at `e70cb2bf`, so the mapping is a
measurement rather than an intention. Line numbers are the block's opening
`describe(`.

`tests/final-review-bakeoff.test.mjs` (754) →

| `describe` block (line) | Destination | Module under test |
|---|---|---|
| `resolveArms — selection is a refusal…` (668) | `tests/bakeoff-arms.test.mjs` | `bakeoff/arms` |
| `deriveArms — the refactor must change no request` (552) | `tests/bakeoff-arms.test.mjs` | `bakeoff/arms` (**hosts the `LEGACY_ARMS` fixture** — see below) |
| `transportForModel…` (595) | `tests/bakeoff-arms.test.mjs` | `bakeoff/arms` |
| `D4 — rerolls are classified before spend` (618) | `tests/bakeoff-arms.test.mjs` | `bakeoff/arms` |
| `collect-time lock` (649) | `tests/bakeoff-arms.test.mjs` | `bakeoff/arms` |
| `isComplete — scope-binding eligibility (KD-6)` (195) | `tests/bakeoff-summary.test.mjs` | `bakeoff/summary` |
| `contract epoch + solo arm (isComplete)` (141) | `tests/bakeoff-summary.test.mjs` | `bakeoff/summary` |
| `zeroFindingArms` (109) | `tests/bakeoff-summary.test.mjs` | `bakeoff/summary` |
| `counting rules shared by the two Opus samples` (239) | `tests/bakeoff-summary.test.mjs` | `bakeoff/summary` |
| `armCostUsd — spend is measured, never partially guessed` (269) | `tests/bakeoff-summary.test.mjs` | `bakeoff/summary` |
| `summarise surfaces every arm` (319) | `tests/bakeoff-summary.test.mjs` | `bakeoff/summary` |
| `cloud run wiring (buildArmArgs)` (484) | `tests/bakeoff-spawn.test.mjs` | `bakeoff/spawn` |
| `findEligibleTranscripts` (37) · `assessWindow` (83) · `verifyPreflightArtifact` (430) | **stay** in `tests/final-review-bakeoff.test.mjs` | entry-point behaviour |

`tests/campaign-adjudication.test.mjs` (1080) →

| `describe` block (line) | Destination | Module under test |
|---|---|---|
| `blind worksheet DTO` (41) · `redaction leak canary` (65) · `worksheet identity` (190) · `calibration sample` (211) · `adjudication verdict` (445) · `self_family` (512) · `clustering` (524) | `tests/campaign-adjudicate.test.mjs` | `campaign/adjudicate` |
| `cited sources` (292) | `tests/campaign-cited-source.test.mjs` | `campaign/cited-source` |
| `receipt filename parsing` (602) · `bake-off log promotion` (640) · `promotion attempt resolution (--force)` (704) · `isArmRetried` (737) | `tests/campaign-promote.test.mjs` | `campaign/promote` |
| the `LIVE:` DB-gated block | **stays** in `tests/campaign-adjudication.test.mjs` | end-to-end + schema |

`tests/model-eval-core.test.mjs` (1266) → one file per already-separate module:
`verdict` (15), `route-catalog` (270), `deterministic-scorer` (405 + 752),
`structured-extractor` (526), `cost` (624), `config/schema` (959),
`store/model-eval` (987).

> **This split is INDEPENDENT of D1/D2** and is called out as such: every module
> it tests already exists and none is moved by this plan. It is the same debt
> class, it is mechanical, and it is therefore its own cluster — if the plan is
> truncated it drops cleanly without affecting the defect fix.

**Every entry point keeps one end-to-end CLI suite.** Unit tests moving to
module-local files must not leave the CLI's own contract (argv, exit codes,
dispatch) untested — that is why the three blocks above are marked *stay*.

**`LEGACY_ARMS` fixture ownership is Phase 1, not Phase 4** (R1/M1 asked; the
ambiguity was real). It moves into `tests/bakeoff-arms.test.mjs` **in Phase 1**,
alongside the `deriveArms` byte-identity block that is its only consumer,
because Phase 1 is what deletes it from production. Phase 4 then has nothing to
decide about it.

**Phase 1 CREATES two suites; Phase 4 EXTENDS them (R2/M3).** The R1 draft had
Phase 1 creating `bakeoff-arms`/`bakeoff-summary` *and* Phase 4 listing the same
two files as created, which left the implementer to guess between duplication,
a partial move, and placeholder files. The split is:

| Phase | `tests/bakeoff-arms.test.mjs` | `tests/bakeoff-summary.test.mjs` |
|---|---|---|
| **1** | **created**, containing ONLY: the `LEGACY_ARMS` fixture + its `deriveArms` byte-identity block (moved), the no-campaign refusal, and the D1 contract table above | **created**, containing ONLY: the incident-(c) scope-threading regression + the D1 contract cases |
| **4** | **extended** with the remaining `arms` blocks from the matrix (`resolveArms`, `transportForModel`, D4 rerolls, collect-time lock) | **extended** with the remaining `summary` blocks (`isComplete` ×2, `zeroFindingArms`, counting rules, `armCostUsd`, `summarise surfaces every arm`) |

Consequently **the "existing suite passes unmodified" guarantee is scoped
precisely**: it governs Phases 2–3 (pure relocation), where no test file is
touched at all. Phase 1 deliberately changes tests — it is a behaviour change —
and Phase 4 moves blocks verbatim between files. Those are three different
guarantees and conflating them is what made the R1 wording ambiguous.

**…and that guarantee is only achievable via a temporary re-export barrel
(R5/H2).** The two rules as written could not both hold: Phase 2 moves the named
exports out of `scripts/bakeoff-collect.mjs`, but every existing test imports
them *from that path*, and Phase 4 is the first phase permitted to repoint an
import — so Phases 2–3 would have broken the suite they are required to leave
passing. The missing step:

- **Phase 2/3 leave the entry point re-exporting every moved symbol** from its
  new home (`export { summarise, isComplete, … } from './lib/bakeoff/summary.mjs'`).
  The suite compiles and passes untouched, which is exactly the evidence the
  relocation needs.
- **Phase 4 repoints the test imports to the new modules and deletes the
  re-exports in the same phase**, so the barrel is a scaffold with a scheduled
  removal rather than permanent API surface.
- **Precedent, not invention**: this repo already uses the pattern deliberately —
  `scripts/shared.mjs` remains "a backwards-compatible barrel" after its split,
  and `campaign/verdict.mjs` re-exports `armSpend` after the Phase-3 move for
  the same reason.
- **The barrel's removal is a Phase 4 exit condition.** A scaffold nobody takes
  down becomes the second import path this plan exists to eliminate.

### D3a — Characterization checklist for the sensitive relocations (R1/M2)

"The suite passes unmodified" is the safety argument for D2, but it only proves
what the suite actually asserts. Four moved paths carry contracts where a silent
regression is a **security or accounting** failure, not a test failure — so they
are pinned by name, **verified to exist before the move is attempted**, and run
before *and* after each relocation:

| Invariant | Guarding block (verified present at `e70cb2bf`) |
|---|---|
| Blind worksheets exclude model/provider/arm identity | `blind worksheet DTO` (41), `redaction leak canary` (65) — **37 blind/redact assertions measured** in this file |
| Worksheet row ids are deterministic (HMAC) and stable | `worksheet identity` (190) |
| Cited-source failures normalise and never reach the provider | `cited sources` (292) |
| `--force` APPENDS a retry and never overwrites | `promotion attempt resolution (--force)` (704) |
| Receipt identifiers stay root-confined | `receipt filename parsing` (602) |

If any of these is found to be weaker than the invariant it is supposed to
guard, **strengthening it is Phase 0 work that precedes the move** — moving code
whose contract is unguarded is how a relocation silently ships a regression.

### What this plan deliberately does NOT do

Stated explicitly, because four items I raised in discussion did not survive
their own measurement, and silently dropping them would be dishonest:

- **`isJsonbSafeValueInner` is NOT redesigned.** It is dense because it is
  correct — six audit rounds of hardening against real, individually-measured
  bypasses (non-enumerable properties, accessor indices, sparse holes, symbol
  keys, `Date` subclasses, cycles). Its own audit history shows it is unusually
  sensitive to refactoring, and it is a **security boundary** on the write path
  to `jsonb`. The expected value of rewriting a working, exhaustively-tested
  validator for readability is negative. Revisit only if a *behavioural* defect
  is found in it.
- **The `priced|unpriced` ↔ `available|unavailable` vocabulary seam stays.** It
  is a documented 3-line translation in `toArmSpend`, with independent callers
  and tests on each side. Unifying it means touching two subsystems' test suites
  for a readability gain — the over-engineering cliff.
- **No standalone comment-hygiene sweep.** Audit-round narration ("Cluster B
  fix-gate (R3)…") is noise, but a repo-wide comment diff is high-churn,
  zero-behaviour, and hostile to review. Instead: **a function whose body moves
  under D2 gets its comment reduced to invariants in the same commit** — free,
  because the diff exists anyway. Comments elsewhere are left alone.
- **`model-eval-auditor.mjs` (594) and `scripts/lib/store/model-eval.mjs` (621)
  are NOT split.** 3× the median is not the 7× outlier this plan is about, and
  both are internally coherent. Splitting them would be refactoring by metric
  rather than by pain.

---

## 3. Right-sizing gate

- **The band-aid**: forward `arms` at line 913 and close incident (c). Rejected —
  fixes one instance, leaves the generator and the other exposed reader.
- **The over-built version**: a scope-context object threaded everywhere, plus
  rewriting the JSONB validator, plus a vocabulary migration, plus a comment
  sweep. Rejected — three of those four are unforced, and one is a security
  boundary that currently works.
- **Why this is the smallest true function of the problem**: two incidents share
  one cause (an implicit default). D1 makes that cause unrepresentable. D2/D3
  are the relocation that makes the *next* missing-parameter visible on review,
  which is the property that failed here — the bug survived 17 audits because
  nobody reads line 913 of a 1424-line file. Everything not serving those two
  properties is listed above as excluded, with a reason.

---

## 4. Security Considerations

- **No new egress, no new credential path, no new external input.** Every module
  is a relocation of code already in the trust boundary.
- **`isJsonbSafeValueInner` is untouched** (see non-goals) — the one genuine
  security boundary in the affected area is explicitly out of scope precisely
  *because* it is one.
- **D1 changes a spend-bearing refusal**: `resolveArms` with no campaign now
  refuses instead of collecting three legacy arms. The direction is safe — it
  converts a silent unintended spend into an explicit refusal — but it IS a
  behaviour change and is called out in the risk register rather than buried.
- **Sensitive-path handling is unchanged**; `comparison/paths.mjs` is not touched.

---

## 5. Sustainability Notes

The property this plan buys is **reviewability**: after D2, a missing scope
argument is visible in a 150-line module in the same review that introduces it.
That is the mechanism that failed, and no amount of additional audit rounds
substitutes for it — 17 rounds did not find incident (c).

Second-order: `npm run arch:refresh` will re-tag the moved symbols. Per
AGENTS.md, **retagging changes edges in BOTH directions** — the layering test
(`tests/arm-vocabulary-layering.test.mjs`) re-derives the full violation set and
runs in `npm test`, so an inbound-edge break fails at push rather than silently.

---

## 6. File-Level Plan

| File | Intent | Purpose |
|---|---|---|
| `scripts/lib/bakeoff/arms.mjs` | create | Arm resolution + derivation + transport (D2) |
| `scripts/lib/bakeoff/spawn.mjs` | create | Arg construction + subprocess execution (D2) |
| `scripts/lib/bakeoff/log.mjs` | create | Bake-off log read/append/receipts (D2) |
| `scripts/lib/bakeoff/summary.mjs` | create | Completeness + aggregation + spend (D1 signatures, D2 move) |
| `scripts/lib/bakeoff/progress.mjs` | create | Progress rendering (D2) |
| `scripts/lib/campaign/adjudicate.mjs` | create | Worksheet/blinding/verdict normalisation (D2) |
| `scripts/lib/campaign/cited-source.mjs` | create | Cited-source windowing (D2) |
| `scripts/lib/campaign/promote.mjs` | create | Log→spine promotion, retry marking (D2) |
| `scripts/bakeoff-collect.mjs` | modify | Reduce to argv + dispatch; delete `defaultArms`/`LEGACY_ARMS` (D1) |
| `scripts/campaign.mjs` | modify | Reduce to argv + dispatch |
| `tests/bakeoff-module-contract.test.mjs` | create | Static import-shape guard for the D2a table — the module-granularity enforcement the domain map cannot provide (Gemini R2/M) |
| `scripts/lib/bakeoff/scope.mjs` | create | **Pure** `ResolvedScope` shape + `assertResolvedScope` + `UnresolvedScopeError`/`ScopeMismatchError`. No I/O (D2a) |
| `tests/final-review-bakeoff.test.mjs` | modify | Retains the 3 entry-point blocks (D3 matrix); everything else moves out |
| `tests/bakeoff-arms.test.mjs` | create | Arm resolution, no-campaign refusal (D1), **hosts the `LEGACY_ARMS` fixture** |
| `tests/bakeoff-summary.test.mjs` | create | **Scope-threading regression: the incident-(c) repro** + the 6 summary blocks |
| `tests/bakeoff-spawn.test.mjs` | create | `buildArmArgs` cloud-run wiring (D3 matrix) |
| `tests/campaign-adjudicate.test.mjs` | create | Blinding / worksheet / verdict / clustering (D3a-pinned) |
| `tests/campaign-cited-source.test.mjs` | create | Cited-source resolution (D3a-pinned) |
| `tests/campaign-promote.test.mjs` | create | Promotion, receipts, `--force` append (D3a-pinned) |
| `tests/campaign-adjudication.test.mjs` | modify | Retains the LIVE DB-gated block only |
| `tests/model-eval-core.test.mjs` | modify | Split 7 ways per D3 (independent cluster) |
| `.audit-loop/domain-map.json` | modify | **Required** (measured): one `{pattern, domain:"shared-lib"}` rule for `scripts/lib/bakeoff/**` above the `scripts/lib/**` catch-all. **No `allowedDeps` entry** — rules do not carry that key and the siblings share the domain (D2b) |
| `docs/plans/comparison-tooling-consolidation.md` | modify | This plan, corrected by its own audit |

Deleted from the original draft: a `scripts/lib/dashboard/collect-campaigns.mjs`
row that said *"follow moved imports if any resolve through the CLI"*. Measured
(D2a): it imports no CLI entry point, so it needs no change. An unresolved
conditional in a file plan is a decision handed to the implementer.

### 6a. Generated-artifact ledger (R1/M3)

The close-out runs commands that write files. AGENTS.md requires every generated
artifact be classified **A (volatile → gitignored)** or **B (deterministic →
committed AND freshness-verified)**; leaving the implementer to discover which
files are expected in the diff is how a "messy middle" artifact appears.

| Command | Output | Class | Committed? | Freshness check |
|---|---|---|---|---|
| `npm run arch:refresh` | cloud `symbol_index` + `.audit-loop/domain-deps-observed.json` | **A** | no (gitignored) | `npm run arch:coverage-gate` |
| `npm run arch:render` | `docs/architecture-map.md` | **A** | no — timestamp + sha + LLM summaries | none (regenerate on demand) |
| `npm run skills:regenerate` | `.claude/skills/**`, `skills.manifest.json` | **B** | **yes** | `npm run skills:check` |
| `npm run plans:index` | `docs/plans/README.md` | **B** | **yes** | `npm run plans:index:check` |
| **`requirements.mjs extract --files <created+moved+the 2 entry points>`** | `.requirements/candidates.json` | **A** | no (gitignored intermediate) | — |
| **`requirements.mjs reconcile`** | **`.requirements/ledger.json`** | **B** | **yes** | consumed by `/audit-code`'s rubric |
| `npm run requirements:map` | `docs/requirements-map.md` | **B** | **yes** | `npm run requirements:map:check` |

**The two `requirements` rows above `map` are the R3/H4 fix, and the ordering is
the point.** The R2 draft scheduled only `requirements:map`, which *renders* the
map **from** `.requirements/ledger.json` — so running it alone would have
regenerated a map from a ledger that never learned about the eight new modules,
producing a freshly-timestamped artifact that is confidently incomplete. The
repo context already reports target files pending extraction, so the ledger is
known-partial *before* this plan adds to it. `extract → reconcile → map` is the
documented order and the only one that leaves the invariant index true.

**Scope note**: extraction runs over the created and moved surfaces
(`scripts/lib/bakeoff/**`, the three new `scripts/lib/campaign/*.mjs`) **and the
two modified entry points** — not the whole repo. This plan is not the vehicle
for closing the repo-wide extraction backlog, and conflating the two would make
its diff unreviewable.

**The entry points are included deliberately (R5/M2).** The R4 list said
`<created+moved>` and so excluded `scripts/bakeoff-collect.mjs` and
`scripts/campaign.mjs` on the reasoning that they are merely "reduced to argv +
dispatch". But this plan **changes their observable behaviour**: campaign
selection and the new no-campaign refusal, `UnresolvedScopeError`/
`ScopeMismatchError` surfacing as non-zero exits, `--adopt-legacy`, the
unjudgeable readout, and ownership of the partition. Those are exactly the
behavioural invariants the ledger exists to record; extracting the libraries
while skipping the CLIs would reconcile a ledger that is silent on every
operator-visible change this plan makes.

**Expected diff for this plan specifically**: `docs/plans/README.md` (this plan's
own row) and `.audit-loop/domain-map.json` (D2b). `skills:regenerate` is expected
to be a **no-op** — no `skills/**` source changes — and `skills:check` asserts
that rather than assuming it. `arch:refresh` **must** run because D2 relocates
symbols, but produces no committed change.

### 6b. Implementation Phases

- **Phase 0 — Verify the D3a characterization blocks are as strong as the
  invariants they guard.** Read-only; strengthen any that are not, *before* any
  code moves. Files: the three test files named in D3a.
- **Phase 1 — Kill the defect class (D1).** **Creates `scripts/lib/bakeoff/scope.mjs`**
  — the pure `ResolvedScope` shape, `assertResolvedScope`, `assertScopeMatches`,
  `UnresolvedScopeError`, `ScopeMismatchError`. The four readers (still in the
  CLI at this point) take a `ResolvedScope` whole and import their validation
  from it; delete `defaultArms`/`defaultExpectedScope`/`_resetDefaultArms`;
  `resolveArms` refuses with no campaign; `LEGACY_ARMS` moves to the test
  fixture. Files: `scripts/lib/bakeoff/scope.mjs` (create),
  `scripts/bakeoff-collect.mjs`, `tests/final-review-bakeoff.test.mjs`,
  `tests/bakeoff-arms.test.mjs` (create), `tests/bakeoff-summary.test.mjs` (create).

  > **Why `scope.mjs` is created HERE and not in Phase 2 (R3/H1).** Cluster A
  > claims to be independently shippable *and* to deliver the D1 architecture,
  > but the R2 draft had Phase 2 create `scope.mjs` — so Phase 1 would have had
  > to host scope validation temporarily in the CLI and move it one phase later,
  > contradicting D1's own statement that `scope.mjs` canonically owns it.
  > `scope.mjs` is pure and imports nothing, so it has no reason to wait for the
  > decomposition: it is the *definition* D1 needs, not part of the relocation.

- **Phase 2 — Decompose `bakeoff-collect.mjs` (D2/D2a).** The **remaining five**
  bakeoff modules (`arms`, `log`, `spawn`, `summary`, `progress` — `scope.mjs`
  already exists from Phase 1, so D2's six modules are 1 + 5, not 5); entry
  point reduced to argv + dispatch. Files: those five `scripts/lib/bakeoff/*.mjs`,
  `scripts/bakeoff-collect.mjs`, `.audit-loop/domain-map.json`.
- **Phase 3 — Decompose `campaign.mjs` (D2/D2a).** Three modules; same shape.
  Files: the three `scripts/lib/campaign/*.mjs`, `scripts/campaign.mjs`.
- **Phase 4 — Split the bakeoff + campaign suites (D3).** Verbatim assertion
  moves, per the matrix. Files: the 6 created test files + the 2 retained.
- **Phase 5 — Split `model-eval-core.test.mjs` (D3, independent).** Files:
  `tests/model-eval-core.test.mjs` + 7 created suites.
- **Close-out — the executable list, in order (R4/M2).** The R3 draft named the
  right *ordering* in §6a and then omitted most of those commands here, leaving
  a team to reconcile a ledger against a shorter checklist. They now match:

  ```bash
  npm run arch:refresh            # retag moved symbols (Class A)
  npm run arch:coverage-gate      # its freshness gate
  # created + moved libs AND the two modified entry points (R5/M2, Gemini/L)
  node scripts/requirements.mjs extract --files "scripts/lib/bakeoff/scope.mjs,scripts/lib/bakeoff/arms.mjs,scripts/lib/bakeoff/log.mjs,scripts/lib/bakeoff/spawn.mjs,scripts/lib/bakeoff/summary.mjs,scripts/lib/bakeoff/progress.mjs,scripts/lib/campaign/adjudicate.mjs,scripts/lib/campaign/cited-source.mjs,scripts/lib/campaign/promote.mjs,scripts/bakeoff-collect.mjs,scripts/campaign.mjs"
  node scripts/requirements.mjs reconcile        # → .requirements/ledger.json (Class B)
  npm run requirements:map && npm run requirements:map:check
  npm run skills:regenerate && npm run skills:check      # expected: no-op, asserted
  npm run plans:index && npm run plans:index:check
  npm run db:enrolment:gate
  npm test                        # includes arm-vocabulary-layering
  npm run check
  ```

  Expected committed diff: `docs/plans/README.md`, `.audit-loop/domain-map.json`,
  `.requirements/ledger.json`, `docs/requirements-map.md` — and nothing else.

---

## 7. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| **A relocation silently changes behaviour.** Eight modules move; a dropped line is invisible in a large diff. | Bodies move verbatim; signatures change only where D1 requires. The existing suites are the control and must pass **unmodified** through Phases 2–3 — a suite edited in the same commit as a move cannot prove the move was faithful. |
| **D1's no-campaign refusal breaks a real workflow.** | Measured: `bakeoff-collect.mjs` ships to no consumer, and this repo has two committed campaigns, so the `code:'none'` branch is already unreachable here. Blast radius is a hypothetical future campaign-less repo, which now gets an explicit refusal naming the fix. |
| **Retagging breaks layering in the invisible (inbound) direction.** | `tests/arm-vocabulary-layering.test.mjs` re-derives the whole violation set and runs in `npm test`. Do not verify by grep. |
| **The plan becomes a rewrite under audit pressure.** Audit rounds will propose improving the code being moved. | The non-goals section is the pre-registered answer: in-scope is *relocation + D1*. A genuine defect found in moved code is fixed; a readability improvement is declined and recorded. |
| **Deferred**: JSONB validator redesign, vocabulary unification, comment sweep, the 3× files. | Each named in §2 with its reason; none blocks the two properties this plan buys. |

---

## 8. Testing Strategy

- **Tier 1 (test-first)** for D1: the scope contract and the no-campaign refusal
  are deterministic and pure.

**The refusal boundary is the contract, so it is tested as one (R2/M2).** The
first draft asserted only the incident-(c) regression plus a no-campaign refusal,
which would have proved little more than "the defaults are gone". Required:

| Case | Expected |
|---|---|
| scope absent / `undefined` | `UnresolvedScopeError`, **not** a `TypeError` from inside a loop |
| scope structurally malformed (missing `arms`, `arms` not an array) | `UnresolvedScopeError` |
| duplicate arm ids within one scope | `UnresolvedScopeError` |
| **entry from campaign B + scope from campaign A** | `ScopeMismatchError` — the hole an id alone leaves open |
| **heterogeneous entry set** (two campaigns, one scope) | `ScopeMismatchError` |
| mutation attempt on `scope.arms` (deep freeze) | throws / no-ops; the reader cannot rewrite its own arm set |
| entry with **no `campaignId`** (D1a) | `unjudgeable` + a reason, counted separately — never silently scoped |
| each error surfaced through the **CLI** | non-zero exit **and** a message naming the campaign, not a stack trace |

The last row is the one that is easy to skip and the only one an operator ever
sees: a named error class that the CLI stringifies into an anonymous crash has
not delivered the contract.
- **The incident-(c) regression is the headline test, and it must fail first.**
  Assert that the matched-view aggregation iterates *the campaign's* arms:
  with the scoped campaign it must see `grok` and `gemini-control` and must not
  look for `solo-opus`. Written against the pre-fix code it fails; that is the
  red-then-green this repo requires before a guard is trusted.
- **Negative control**: the legacy three-arm campaign's readout is unchanged —
  D1 must not alter a correctly-scoped call, only make an unscoped one
  impossible.
- **Phases 2–4 are guarded by the existing suite passing unmodified.** For a
  pure relocation that is the whole safety argument; a green suite over
  untouched assertions is the only evidence that "verbatim" was true.
- **Not tested**: provider responses. No whole-provider mock.

---

## 9. Execution Clustering

- **Cluster A** — Phases 0–1 — fix-gate: yes
  - Coupling: Phase 0 establishes that the contracts Phase 1 must not break are
    actually asserted somewhere; running it in a later cluster would mean the
    defect fix ships before its own safety net is confirmed. The `ResolvedScope`
    change, the deletions and the fixture move are then one atomic edit — a
    partial application leaves callers reading a function that no longer has a
    default.
  - This cluster contains a **live defect fix** and is independently shippable.
    If every later cluster is abandoned, this one must still land.
- **Cluster B** — Phases 2–3 — fix-gate: yes
  - Coupling: both decompositions are the same mechanical move against the same
    layout rule, both are governed by the D2a table, and both retag domains in
    one `arch:refresh` — so the inbound/outbound layering check runs once over
    the whole retag rather than twice over halves of it.
- **Cluster C** — Phases 4–5 — fix-gate: final
  - Coupling: Phase 4's split must follow the module boundaries B creates;
    splitting first would mean splitting against boundaries that do not exist
    yet. **Phase 5 is genuinely independent of A/B** (it tests modules this plan
    never moves) and is grouped here only because it is the same mechanical
    operation on the same kind of artifact — it may be dropped without affecting
    any other cluster.
- **Final gate**: mandatory consolidated Gemini review over the union diff A–C.
