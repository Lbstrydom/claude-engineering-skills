# Plan: Comparison-Tooling Consolidation

- **Date**: 2026-08-16 (revised same day — see *Post-gate revision* below)
- **Status**: Complete — all clusters (A/A′, B, C, D) implemented, individually
  audited to convergence, and the mandatory consolidated Gemini gate over the
  full union diff returned `APPROVE` (round 2, 0 wrongly-dismissed, coherence
  `Strong`). See the Implementation Log at the bottom.
- **Author**: Claude + Louis
- **Scope**: backend (two CLI entry points, their lib modules, their test suites)
  — **plus**, as of the post-gate revision, the arm-count and role-coverage
  flexibility axes (Clusters A′ and D).
- **Target domain(s)**: `scripts`, `shared-lib`
- **Predecessor**: [`role-agnostic-comparison-core.md`](./role-agnostic-comparison-core.md)
  (Clusters A–C, shipped `916147a0..a0c72290`). That plan built the shared core
  correctly; this one pays the debt its own audit rounds kept deferring.

## Audit trail

**Original gate** (D1/D2/D3, Clusters A–C as first drafted):

| Gate | Rounds | Result |
|---|---|---|
| GPT (`/audit-plan`) | **5 of 5 (absolute cap)** | H 2→2→4→2→3, M 3→3→0→3→2, L 0→1→0→0→0. **25 findings, 25 accepted as fix-now — zero dismissals, zero deferrals, zero rebuttals (100% every round).** |
| Gemini (`--mode plan`, mandatory) | **3** (2-round cap + one genuine-bug exception) | R1 `CONCERNS` — 4 findings **+ 1 over-engineering flag**, coherence `Adequate`. R2 `CONCERNS` — 2 findings, coherence **`Strong`**, 0 over-eng. R3 **`APPROVE`** — **0 new, 0 wrongly-dismissed, 0 over-engineering**, coherence `Strong`. **7 of 7 accepted.** |

**Post-gate revision re-audit** (D1c, D6, D7/Cluster D — the arm-count and
role-coverage material added after the original gate, 2026-08-16):

| Round | H / M / L | Character | Acceptance |
|---|---|---|---|
| R1 | 4 / 3 / 0 | Every finding on genuinely new (post-gate) content — the role-executor contract, the Phase-7 scope boundary, the extraction-list omission, the promotion exit-code ambiguity, the redaction-derivation gap, the module-contract test's string-search weakness, the aggregate-shape ambiguity | 7/7 accepted (100%) |
| R2 | 5 / 2 / 0 | Mostly REGRESSIONS in round-1's own fixes (an untagged result union, a real blinding-alias regression caught before it shipped, a self-contradictory D7 heading) plus one genuinely new gap (arm-set invariant weaker than it looked) | 6/6 accepted (100%) |
| R3 | 7 / 2 / 0 | A mix of layering violations (lib importing an entry point), unrepresentable types (required fields with nothing to populate on early failure), and — the sharpest class — **self-contradictions between this plan's own sections** (a close-out gate that would refuse the plan's own truncation-order recommendation; a "pure" claim contradicting the same paragraph's own dependency table) | 9/9 accepted (100%) |

**Gemini (`--mode plan`, mandatory) on the post-gate content** — 3 rounds (2-round
cap + one genuine-bug exception):

| Round | Verdict | Findings |
|---|---|---|
| R1 | `CONCERNS` | G1 — the role-generic `EXECUTORS` registry took `corpus` as a per-call parameter while D7c required it fetched once per run; unresolvable without either breaking genericity or breaking fetch-once. Fixed: two-phase `{prepareContext?, executeArm}` interface. |
| R2 | `CONCERNS` | G1 — the round-3 GPT fix's "adoption is a durable write" was false: `promoteFromLog` writes the STORE, never the SOURCE log, so a re-run without `--adopt-legacy` re-reads the same unresolved entries. Fixed: an appended, idempotent adoption receipt, folded by `readLog()` on every future read. G2 — `scoreAgainstGroundTruth` cannot populate the mandatory `usage` field; the token/cost accounting happens inside its per-row `extractStructured` calls and never escapes. Fixed: extended to sum and return it. G3 — `campaign/promote.mjs → lib/store/campaign.mjs` is `shared-lib → stores`, a real, currently-nonexistent, unpermitted cross-domain edge D2a's own table introduces; the "every edge is intra-domain" claim missed the one file that touches a store. Fixed: a file-specific domain rule reusing the existing `model-eval` domain (already permits `stores`), never widening `shared-lib` itself. |
| R3 | **`APPROVE`** | **0 new, 0 wrongly-dismissed.** |

**Why round 3 was warranted past the 2-round cap**: both R1 and R2 findings
were concrete design/correctness defects (an unrepresentable interface
contract, a false durability claim, a real unpermitted cross-domain edge) —
the documented genuine-bug exception, not rigor pressure or
implementation-completeness. All 4 findings across 2 rounds accepted, 0
dismissed, 0 deferred.

**Stop decision: GPT round 3, the documented default cap — not extended.**
Acceptance was 100% every round, which by the doctrine's own rule argues FOR
continuing (a round accepted wholesale is not rigor pressure). The reason to
stop anyway: round 3's *character* shifted from "new gaps in new content" and
"regressions in the immediately-prior fix" toward **self-contradictions
between increasingly many prior fixes** — a signal that the ungated material
had reached a size where further additions were as likely to manufacture a
new internal inconsistency as to close a real one. Three rounds gave the
arm-count and role-coverage material the same depth of scrutiny the original
D1/D2/D3 content received (5 rounds, but starting from a smaller, single-axis
surface); continuing past the default cap is reserved for a concrete net-new
design bug forcing it, and none was outstanding at the end of R3 — every
finding across all three rounds was fixed, none deferred. Proceeding to the
mandatory Gemini gate over the full plan (original + post-gate content) next.

**Total: 32 findings across both gates, 32 accepted, 0 dismissed, 0 deferred, 0 rebutted.**

> ### ⚠ Post-gate revision (2026-08-16, after the rebase onto `c5cbb252`)
>
> **What the 32/32 gate covers**: D1/D2/D3 and Clusters A, B, C as originally
> written. Nothing below invalidates them.
>
> **What is NEW and has NOT been through either gate** — treat as unaudited
> until `/audit-plan` runs again:
> - **D1c** (arm-count invariant) and **D6** (telemetry no-silent-zero), folded
>   into Cluster A because they share D1's root cause and its file set.
> - **D7** and **Cluster D** (role executability) — a genuinely new axis
>   neither this plan nor its predecessor covered.
> - Every re-pinned citation in §1 (see below).
>
> **Why the citations moved.** This plan was authored on a branch whose commits
> were rewritten by a rebase onto `main`. Its pin, `e70cb2bf`, is **orphaned** —
> it exists as a dangling object but is not reachable from `main`. Every
> `file:line (e70cb2bf)` reference has been re-pinned to **`c5cbb252`** and
> re-measured. This is exactly the decay
> [`verification-discipline.md`](../audit/shared-references/verification-discipline.md) §1
> names: the old refs still *resolved*, they just pointed at the wrong lines —
> `:913` landed on a bare `}`. **The findings all survived re-measurement; only
> the coordinates were wrong.** Re-derive rather than trust, on every future
> read of this document.
>
> **One finding got worse under re-measurement, and that is the argument for
> Cluster A′.** Incident (c) dropped **2** arms when first measured. Re-run on
> `c5cbb252` it drops **4** (`grok, qwen, deepseek, gemini-control`), because a
> concurrent session added two arms in between. The defect scales with arm
> count: every arm added widens the silent miss. See §1's re-measurement block.

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

**Measured 2026-08-16** (`wc -l`, re-measured on **`c5cbb252`**; a parenthesised
value is the original `e70cb2bf` reading, kept so the drift stays visible rather
than being silently overwritten):

| File | Lines | vs. repo median |
|---|---:|---:|
| `scripts/bakeoff-collect.mjs` | **1435** (was 1424) | **7.4×** |
| `scripts/campaign.mjs` | 1338 | **6.9×** |
| `tests/model-eval-core.test.mjs` | 1266 | 6.6× |
| `tests/campaign-adjudication.test.mjs` | 1080 | 5.6× |
| `tests/audit-store-durability-call-site.test.mjs` | 877 | 4.5× |
| `scripts/lib/store/model-eval.mjs` | 621 | 3.2× |
| `scripts/model-eval-auditor.mjs` | 594 | 3.1× |

Median for `scripts/lib/**/*.mjs` is **194 lines over 488 files** (was 193/487;
the extra file is `comparison/model-family.mjs`)
(`find scripts/lib -name '*.mjs' -exec wc -l {} +`). The repo already knows what
its own module size looks like; two files are outliers by an order of magnitude.
The ratios are unchanged to one decimal place — the honest reading being that
the argument never rested on the exact integers.

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

> Every `file:line` below is pinned to **`c5cbb252`** (re-pinned from the
> orphaned `e70cb2bf` — see the post-gate revision note), and every figure carries
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
`aggregateMatched(complete)` at `scripts/bakeoff-collect.mjs:924 (c5cbb252)`
**without forwarding them**. Measured against the committed scoped campaign:

```
scoped campaign REAL arms      : opus, kimi, grok, qwen, deepseek, gemini-control
what aggregateMatched iterates : opus, solo-opus, kimi   (defaultArms -> LEGACY_ARMS)
arms SILENTLY MISSED           : grok, qwen, deepseek, gemini-control
phantom arms hunted            : solo-opus
```

> **RE-MEASURED on `c5cbb252`, and it got worse — this is Cluster A′'s whole
> argument.** At `e70cb2bf` this dropped **two of four** arms
> (`grok, gemini-control`). It now drops **four of six**, because a concurrent
> session added `qwen` and `deepseek` to the same committed campaign in between.
> Nothing about the defect changed; the *campaign* changed, and the defect
> widened to match. **The size of the silent miss is a function of the arm
> count**, so it grows every time the comparison does the thing it exists to do.
> A fix that only forwards the parameter at this one call site leaves that
> property intact — which is why D1c generalises it to an invariant.

The matched-view aggregation — a reported campaign metric — drops four of six
arms and hunts one that does not exist. Same class as incident (b), one call
frame deeper, never caught, because the failure mode is a *plausible number*
rather than an error. `zeroFindingArms(e)` at
`scripts/bakeoff-collect.mjs:1086 (c5cbb252)` takes the same default and is
exposed identically.

**This is the load-bearing argument for the whole plan.** The structure is not
merely inelegant; it has produced two defects of one class, and the second was
invisible to 17 rounds of audit *because reading a 1435-line file is how you
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
// scripts/bakeoff-collect.mjs:417 (c5cbb252)
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
  **Made explicit (round-3 gate, H5): both cases land in the SAME
  `unjudgeable` bucket** — `campaignId: null` (predates campaign declaration)
  and `campaignId` **declared but unresolvable** (deleted/malformed campaign
  reference) are both "cannot judge", distinguished only by their **reason
  code** (`no-campaign-id` vs. `campaign-unresolvable`), never by routing to
  different outcomes. §D1b's `PromotionResult` table's `skippedUnjudgeable`
  covers BOTH — a round-2 test-matrix row that filed a declared-but-unresolvable
  entry under `failedJudgeable` (a write failure) directly contradicted this
  rule and is corrected in §8's matrix below.
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
| **`printProgress`'s exit code** | **zero, always.** A readout reporting unjudgeable entries has succeeded at reporting; it is not a gate |
| **`promoteFromLog`'s exit code** | **the STRUCTURED RESULT below determines it — see the exhaustive rule** |
| Legacy adoption | when `--adopt-legacy` reinterprets the `null` group, the readout **says so on its own line** — an adopted interpretation must never look like a native one |

**`promoteFromLog`'s structured result, and the exit rule made exhaustive
(post-gate fix, H4).** The round-1 gate correctly flagged that "Only
`promoteFromLog` refuses (non-zero)" is ambiguous read on its own — it can be
(mis)implemented as "refuses whenever unjudgeable entries are present", which
is the exact permanent-denial-of-service shape §D1a's own prose rejects two
paragraphs above this table. Removing the ambiguity means defining the return
shape, not just the words:

```
PromotionResult = {
  promoted:          EntryId[],
  skippedUnjudgeable: Array<{entryId, reason}>,   // legacy, no campaignId — D1a
  failedJudgeable:    Array<{entryId, error}>,    // a REAL, actionable failure
}
```

**Exit rule, exhaustive over that shape**: `exitCode = failedJudgeable.length
> 0 ? 1 : 0`. **`skippedUnjudgeable` NEVER appears in the exit-code decision,
under any count, including "only unjudgeable entries present, zero promoted."**
That is precisely the case D1a's prose already requires to exit zero, and
writing the rule against the structured result rather than against prose is
what makes an implementer's reading of "refuses" unambiguous. The CLI readout
still prints `skippedUnjudgeable`'s count and reasons — visibility, not
failure, is the answer to "how do I know legacy history is piling up."

The exit-code row is the one worth being explicit about: making a *readout* fail
because history is unjudgeable would push an operator to stop running it, which
is how the invisible-spend incident happened in the first place. Making
`promoteFromLog` fail on the same condition would be the identical mistake one
command over.

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
  one campaign's entries before summarising (`bakeoff-collect.mjs:961
  (c5cbb252)`), for exactly this reason. D1b makes that filtering the *contract*
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

  **The in-memory stamp is correct for THIS run; it was wrongly claimed durable
  across future ones (Gemini gate, G1).** `nullGroup.map(...)` is a real,
  correct transformation for the CURRENT invocation's `summarise`/
  `promoteFromLog` calls — that part was never wrong. What was wrong: a
  round-3 fix claimed re-running promotion later would see the entry as
  "an ordinary judgeable entry… on disk." It would not — `promoteFromLog`
  writes the STORE, never the SOURCE log
  (`.audit/bakeoff-log.jsonl`), so a later run reading that file with no
  `--adopt-legacy` sees the identical `campaignId: null` entry it started
  with. **The log stays append-only** (mutating historical entries in place
  is the wrong fix for an audit log) — so durability is an **appended
  receipt**, not a rewrite:

  ```
  --adopt-legacy + --campaign X
    ↳ nullGroup.map(e => ({ ...e, campaignId: X, adopted: true }))  (unchanged, this run)
    ↳ ALSO appends one receipt per adopted entry to the log:
        { type: 'adoption-receipt', entryId, campaignId: X, adoptedAt }
  ```

  `readLog()` folds receipts over their target entries **before**
  `scopeForEntry` ever sees them: an entry with a matching receipt resolves
  under the receipted `campaignId` on every SUBSEQUENT run, with no
  `--adopt-legacy` flag required again — the adoption is a recorded historical
  fact, not a per-invocation reinterpretation. A duplicate receipt for the
  same `entryId` is a no-op (idempotent by construction: folding the same
  receipt twice yields the same resolved entry). This is the actual mechanism
  the round-3 fix's "durable, idempotent" claim needed and did not have.
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
// scripts/bakeoff-collect.mjs:415 (c5cbb252) — already returns a scope VALUE
export function scopeForEntry(entry) { … return { arms, expectedScope }; }
// …and every caller immediately takes it apart again:
return isComplete(entry, scope.arms, scope.expectedScope);   // :430 (c5cbb252)
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

### D1c — The arm set is 1..n, and that is an INVARIANT, not a fixed list (NEW — ungated)

> **Post-gate addition.** Not covered by the 32/32 audit. Folded into D1 rather
> than filed separately because it is the *same root cause* (`defaultArms()`
> supplying an arm set nobody asked for) reaching a different set of readers,
> and it lands in the same files D1 already opens. Splitting it out would mean
> touching `summarise` twice.

D1 stops a *wrong* arm set being substituted. D1c stops a *hardcoded* one being
assumed. The operating requirement, stated as a property rather than a count:

> **Any code that iterates arms must iterate the set the resolved scope
> declares — never a literal, never a fixed arity.** Adding the (n+1)th arm to a
> campaign must require zero production-code edits.

That is not aspirational; it is already 90% true, and the exceptions are
enumerable. **Measured on `c5cbb252`** — the generic surfaces are genuinely
generic (`campaign/verdict.mjs`, `comparison/spend.mjs`, `comparison/cost.mjs`,
`dashboard/collect-campaigns.mjs` and `dashboard/sections/campaigns.mjs` are all
`Object.entries`/`armIds`-driven, no fixed widths, no literals). The violations
are concentrated in one readout block:

| Site | Defect | Consequence |
|---|---|---|
| `bakeoff-collect.mjs:860-862` | `e.arms.opus`/`e.arms.kimi` literals feed `primaryTotal` | Only 2 of 6 declared arms contribute. **`primaryTotal` is also dead** — written twice, read nowhere in the repo. |
| `bakeoff-collect.mjs:868` | `primaryDivergence.push(Math.abs(p1 - p2))` with both sides `?? 0` | **Fabricates a metric.** See D6 — this is the telemetry defect, not merely an arm defect. |
| `bakeoff-collect.mjs:884-889` | `e.arms['solo-opus']?.primaryDistinct` literal | Reports *"N snapshot(s) unpaired — one Opus sample missing"* for a campaign that never declared that arm. Degrades honestly (no false zero) but the message is wrong. |
| `bakeoff-collect.mjs:921-923` | `opusUnique`/`kimiUnique`/`soloFindings` legacy projection | Deliberate back-compat view, derived from the generic maps. **Not load-bearing** — consumed only by tests. Retain, but it must not gain a new consumer. |

**The fix is the invariant, not four patches.** Patching four sites leaves the
fifth to be written next year. `summarise` receives a `ResolvedScope` under D1;
every tally in it derives its key set from `scope.arms` and nothing else. The
legacy projection stays as an explicitly-labelled *view* over the generic maps.

**A fifth site, and it is the one that matters most for running evals
repeatedly: `PROVIDER_TERMS`** (`scripts/lib/store/campaign.mjs:54-58`). The
adjudication blinding redacts `armIds` and `armModels` dynamically, then also
scrubs a **static vendor list** (`openai, anthropic, gemini, claude, openrouter,
moonshotai, moonshot, deepseek, qwen, zhipu, mistral, llama, grok, kimi, opus,
sonnet, haiku, gpt, glm`). Add an arm from a vendor not on that list — Cohere,
Nova, whoever ships next — and **that vendor's name survives into the blind
adjudication payload.**

This is filed here, in A′, rather than with the role work, because it is the
sharpest possible violation of D1c's own invariant: *adding an arm must be one
edit*. Today it is two, the second one is invisible from the file you are
editing, and **forgetting it degrades blinding silently** — no error, no failed
test, just a slightly less blind adjudication feeding the metric the whole
campaign turns on. For a system whose entire purpose is to be run again with
different arms, a recurring manual step that silently corrupts the evidence when
skipped is the worst available failure mode.

**The fix, made a real contract rather than a gesture (post-gate fix, M1).**
The round-1 gate was right that "the provider segment is right there in the id"
does not hold universally — **measured against the live committed campaign**:

```
moonshotai/kimi-k2-thinking   → clean vendor/model slug (OpenRouter convention)
qwen/qwen3.8-max              → clean vendor/model slug
deepseek/deepseek-v4-pro      → clean vendor/model slug
claude-opus                   → NO slash — first-party, needs a parser, not a split
grok-4.6                      → NO slash — xAI direct, no vendor segment at all
gemini-pro-latest             → NO slash — first-party sentinel
```

Three shapes, three sources, tried in order — **`resolveProviderIdentity(model)`**
in `scripts/lib/store/campaign.mjs`, called once per declared arm at
**arm-declaration load** — a wording fix, not a mechanism change (round-3 gate,
H1): the earlier draft said "manifest load", but `PROVIDER_TERMS`/this
resolver lives in `store/campaign.mjs`, which the **passive** campaign path
(`final_review_shadow`) uses directly — D7 states explicitly that path
**never touches `comparison/manifest.mjs`**. Calling it "manifest load" would
have implied the fix only covers the synchronous path, which is backwards:
this fix is Cluster A′/Phase 1′ scope specifically **because** it closes the
passive path's own defect — the one the arm-count section opened with.

> **This is a boundary, not a gap (round-4 findings H2/H11, raised twice —
> stated explicitly here so a third round doesn't re-raise it a third time).**
> `comparison/manifest.mjs` performs NO redaction or blind adjudication of any
> kind today (verified: no call to `buildModelRedactor` anywhere on that path)
> — there is nothing there for `resolveProviderIdentity` to protect yet. The
> fail-closed refusal covers every path that EXISTS and emits provider
> identity, which today is exactly one: the passive `final_review_shadow`
> path this fix targets. Should a later phase wire blind adjudication onto
> the synchronous manifest path, THAT phase must route through
> `resolveProviderIdentity`/`armRedactionTerms` rather than reinventing
> coverage — tracked as a requirement on whichever phase does that, not a
> defect in this one.

1. **First-party parsers already in this repo** — `parseClaudeModel` /
   `parseGeminiModel` / `parseOpenAIModel` (`model-resolver.mjs`). A match
   yields the canonical `provider` field they already expose (`anthropic` /
   `google` / `openai`) — reusing an existing, tested parser rather than a
   second regex.
2. **The OpenRouter `vendor/model` slug** — the segment before the first `/`,
   lowercased. Covers gateway ids by construction.
3. **A small static residue** for known bare ids no parser or slug covers
   (`grok-*` → `xai`), kept explicit and short rather than guessed at.

**Unresolvable is a REFUSAL, not a silent gap.** If none of the three sources
resolve an identity for a declared arm, blind-comparison setup **fails at
manifest load** — the same fail-closed posture `resolveAndClassify`
(`sensitive-paths.mjs`) already applies to path classification. A campaign
with an unredactable arm is not run half-blind; it is not run. **The refusal
message names the escape hatch**: declare an explicit `redactionTerms: string[]`
on that arm (validated non-empty) rather than silently extending the static
residue table — the operator who knows the vendor states it once, on the
one arm that needs it, instead of a maintainer growing a table for everyone.

**A canonical `provider` is a ROUTING identity, not a REDACTION lexicon — and
collapsing the two is a real blinding regression the round-2 gate caught**
(post-gate fix, H3). `resolveProviderIdentity` returning `'anthropic'` and
redacting only the word `anthropic` would have **dropped `claude`, `opus`,
`sonnet`, `haiku` (all narrative aliases the EXISTING static list already
redacts) and `gemini`, `gpt` the same way** — an adjudicator reading "Claude
found three issues" would see the model's name in the supposedly-blind prose.
The fix is a small **alias lexicon keyed by canonical provider**, not a
per-arm table (this is the load-bearing difference from the table this whole
section replaces — a handful of PROVIDERS, not N arms):

```
PROVIDER_ALIASES = {
  anthropic: ['anthropic', 'claude', 'opus', 'sonnet', 'haiku'],
  google:    ['google', 'gemini'],
  openai:    ['openai', 'gpt'],
  // an OpenRouter-slug or static-residue provider redacts on ITS OWN name —
  // 'moonshotai', 'deepseek', 'qwen', 'xai' carry no separate narrative alias
  // today; this map is where a future one is added, once, for every arm that
  // provider covers, rather than per-arm.
}
```

- **`resolveProviderIdentity(model)` is unchanged** (still the 3 ordered
  sources) — it answers "which provider", not "which words".
- **The redaction term SET for a resolved arm is `PROVIDER_ALIASES[provider]
  ?? [provider]`** — curated aliases when they exist, the bare provider name
  otherwise. This is where a genuinely new alias (a model nicknamed
  differently in prose than its routing id) gets added: to the map, once, not
  discovered missing in a live adjudication.
- **An arm with an explicit `redactionTerms` override uses exactly that set**,
  bypassing derivation entirely — the escape hatch named above.

  **`redactionTerms` needs a home, and the home is ONE place both paths already
  share (round-3 gate, H1).** `ArmSchema` (`scripts/lib/comparison/arms.mjs`)
  is imported by BOTH `campaign/config.mjs`'s `CampaignConfigSchema` (the
  passive path) and `comparison/manifest.mjs`'s `ComparisonManifestSchema`
  (the synchronous path) — confirmed by import, not assumed. Adding
  `redactionTerms: z.array(z.string().min(1)).min(1).optional()` to
  `ArmSchema` itself means **one schema change closes the gap for both
  mechanisms simultaneously**, exactly the "one contract, not two copies"
  discipline `checkArmSetSemantics`'s own docstring already states as this
  module's reason to exist. Validation (non-empty strings, `.strict()`
  already rejects unknown keys elsewhere) is structural, at the same schema
  boundary every other arm field is checked at — no new validation layer.
  Persistence: the term set is derived at redaction-construction time from
  the parsed arm object already in hand (`arm.redactionTerms ??
  PROVIDER_ALIASES[resolveProviderIdentity(arm.model)] ?? …`); nothing new is
  written to any store — the override is a config-time value, re-derived
  identically on every read, same as every other derived value in this plan.

**Term generation is boundary-aware**, not a bare substring scrub: every term
from every source (derived alias, residue, or explicit override) becomes
`\b${escaped}\b` (case-insensitive), so `qwen` matches the word `qwen` and not
a substring of an unrelated token — the same class of over-redaction bug the
existing `meta` exclusion was hand-written to avoid, generalised into the
generator rather than left as a one-off exception.

**The static residue and its hand-won exclusions are KEPT, not replaced** —
this adds derivation *alongside* them:

```
STATIC_RESIDUE = ['xai']             # bare ids with no parseable/slug identity
STATIC_EXCLUSIONS = ['meta']         # deliberately NEVER auto-redacted —
                                      # matches inside "metadata"; would corrupt
                                      # the adjudicator's prose (existing, kept)
```

**Canaries (required, not optional):**

| Case | Expected |
|---|---|
| a vendor not in ANY source (e.g. a hypothetical `cohere/command-r`) | resolves via source 2 (slug) — the case this whole fix exists for |
| a genuinely unresolvable id, no `redactionTerms` override | **manifest load REFUSES**, naming the arm and the escape hatch |
| a genuinely unresolvable id WITH an explicit `redactionTerms` override | accepted; those exact terms redact |
| **`anthropic`-routed arm — assert `claude`, `opus`, `sonnet`, `haiku` ALL still redact, not just `anthropic`** | the regression this fix exists to prevent, asserted directly rather than trusted |
| mixed-CASE **declared arm model strings** — `qwen/qwen3.8-max`, `QWEN/Qwen3.8-Max`, `Qwen/QWEN3.8-MAX` (round-4 finding M1's correction: this canary is about `resolveProviderIdentity`'s CONFIG-INPUT normalisation, not about which words redact in adjudicator PROSE) | all resolve to provider `qwen` |
| once resolved, the derived term redacts case-insensitively in prose (`QWEN`, `Qwen`, `qwen`) | all redact |
| a HYPHENATED COMPOUND in prose, e.g. `qwen-turbo` (a different model's name, not a case variant of the bare provider term) | does **not** redact as a bare `qwen` match — hyphen is a token-continuation character under this file's boundary convention (same rule that keeps `claude-opus-4-8-preview` matching as ONE unit), so a compound word is a DIFFERENT token, not an under-redaction |
| prose containing `metadata`, `megawatt` (contains no vendor substring but shares characters with residue-adjacent terms) | **not** redacted — the boundary-aware canary |
| the existing `meta`-in-"metadata" case | still not redacted (regression cover for the exclusion this fix must not break) |

**Enforcement — a derived-set invariant, deliberately NOT a golden file, and
STRONGER than key equality (post-gate fix, M2).** A golden fixture pins one
arm set, so it must be edited whenever an arm is added — and an edited golden
proves only that someone edited it. But the round-2 gate correctly found that
key-set equality alone is a **weaker property than it looks**: an
implementation could pre-create every key in `scope.arms` and mark each
"represented" while silently discarding a real arm's actual findings/cost —
passing a key-presence check by construction, independent of whether any data
attribution happened at all. The oracle must be **independent of the
implementation's own key-construction loop**, not derived from the same
iteration:

**Disjoint per-n fixtures, not one formula stretched across all n (round-3
gate, M1 — the round-2 pseudocode referenced a nonexistent `arm[1]` at n=1,
and required `arm[n-1]` to be simultaneously the honest-zero AND the unpaired
arm at n=2, which is the same index playing two contradictory roles):**

```
n=1: arm[0] only.
  entries = [{arm[0]: N findings, cost C}]                     # a normal measured arm
  assert keys(result.totals.uniqueByArm) == ids(scope.arms)     # exact key-set, still checked
  assert result.totals.uniqueByArm[arm[0].id] == N              # the arithmetic case: no
                                                                 # off-by-one on a 1-element set

n=2: arm[0] measured-nonzero, arm[1] measured-ZERO. No unpaired arm at n=2 —
     there is no third role to seat, and inventing one would re-introduce the
     contradiction this fix exists to remove.
  entries = [{arm[0]: N findings, cost C}, {arm[1]: 0 findings, cost 0}]
  assert keys(result.totals.uniqueByArm) == ids(scope.arms)
  assert result.totals.uniqueByArm[arm[0].id] == N
  assert result.totals.uniqueByArm[arm[1].id] == 0                # a MEASURED zero,
                                                                    # distinct from 'unknown'

n=6 (the live campaign's own arm count): all three roles, three DISTINCT arms.
  entries = [{arm[0]: N findings, cost C}, {arm[1]: 0 findings, cost 0},
             {arm[2..4]: ordinary measured}]                       # arm[5] has NO entry
  assert keys(result.totals.uniqueByArm) == ids(scope.arms)        # exact, all 6 present
  assert result.totals.uniqueByArm[arm[0].id] == N
  assert result.totals.uniqueByArm[arm[1].id] == 0
  assert result.totals.<...>[arm[5].id].status == 'unknown'        # honestly unpaired,
                                                                     # per D6's AggregateResult
```

Adding an arm changes the input and the expectation together, so the test never
needs editing and cannot go stale. This single assertion — now checking
per-arm VALUES, not just the key set — covers incident (c), the `:860-889`
block, and the fragile test in D3's matrix — all three are the same property
violated in three places.

> **`n = 1` is included on purpose.** `checkArmSetSemantics` requires ≥2 *scored*
> arms for a campaign, so n=1 is not a legal campaign — but it IS a legal input
> to these pure functions, and it is the case where an off-by-one or an
> `arms[0]`/`arms[1]` assumption shows up. Testing the arithmetic at n=1 is not
> the same as permitting a 1-arm comparison.

### D6 — A metric with no measurement is `unknown`, never `0` (NEW — ungated)

> **Post-gate addition.** This is the telemetry axis, and it is a *different*
> failure from D1/D1c even though it surfaces at the same lines. D1c is "the
> wrong arms were counted"; D6 is "nothing was measured and the readout printed
> a number anyway".

**Measured, executed, on `c5cbb252`.** Two complete snapshots from a campaign
declaring `grok`/`qwen`/`deepseek` (no `opus`, no `kimi`):

```
complete snapshots        : 2          ← positive control: the block DID run
primaryDivergence samples : [0, 0]     → readout: "mean 0.0, max 0"
opusDivergence samples    : []         | unpaired: 2   ← refuses to fabricate
```

`printProgress` renders that first line as *"Gemini self-divergence (P1 vs P2):
mean 0.0, max 0 — same model, same transcript, two runs."* **That is the
strongest agreement claim the readout can make, manufactured entirely from
absent data.**

**The rule already exists in this repo — it is written in the comment between
the two blocks** (`bakeoff-collect.mjs:881-883`):

> *"A snapshot missing either side is COUNTED AS UNPAIRED, never as a zero — a
> zero here would read as 'Opus agreed with itself perfectly', which is the
> strongest possible claim and exactly what absent data cannot support."*

Applied to `opusDivergence` fifteen lines below. Violated by `primaryDivergence`
immediately above it. **The rule is correct, stated, and unenforced** — which is
the entire finding, and why the remedy is a contract rather than a third patch.

This is the fourth instance of one shape. Each was found separately and fixed
locally: per-run cost `NULL` on all 128 rows for the column's entire life; a
hardcoded `0` in telemetry read as a measurement; `labelled: 0` from
`write-code-outcomes` reading as success; and now `mean 0.0`. **They share a
single cause — a missing measurement rendered as a legitimate value** — and the
repo has already built the right answer several times without generalising it
(`costEvidence: 'unknown'`, `costStatus: 'unpriced'`, `opusDivergenceUnpaired`,
`arch:coverage-gate`'s `unknown` verdict, this plan's own D1a `unjudgeable`).

**The contract, at the write boundary — ONE discriminated shape, not four
prose options (post-gate fix, M3).** The round-1 gate was right that "absent
or `unknown`, `—` in rendering, empty arrays, and a count beside it" reads as
four compatible-sounding representations that a future caller can each
implement differently. There is exactly one return type, and every divergence
aggregate in `summary.mjs` returns it:

```
AggregateResult =
  | { status: 'measured', value: number, observationCount: number, unpairedCount: number }
  | { status: 'unknown', observationCount: 0, unpairedCount: number, reason: string }
```

- **`status` is discriminated, not inferred from `value` being present.** A
  consumer switches on `status`; `value` does not exist on the `unknown` branch
  — not `null`, not `0`, absent from the object, so a renderer that forgets to
  check `status` gets `undefined` (loud) rather than a silently wrong number.
- **`observationCount > 0` is the ONLY condition under which `status:
  'measured'` may be returned.** Zero observations is `unknown` by
  construction — this is the rule as a type invariant, not a convention a
  caller has to remember.
- **`unpairedCount` travels on BOTH branches** (`opusDivergenceUnpaired`'s
  existing shape, generalised) — a "measured" aggregate can still have
  unpaired snapshots alongside the ones that contributed.
- **Per-declared-arm results are a map whose key set equals `scope.arms`
  exactly** — `Record<ArmId, AggregateResult>` (or the equivalent per-metric
  shape), asserted by the same derived-set invariant D1c already requires, so
  "present, or explicitly unpaired" from D1c's own text has one concrete
  representation rather than being restated loosely here.
- **A renderer switches EXHAUSTIVELY on `status`** — `'measured'` → the
  formatted `value`; `'unknown'` → `—` plus `reason`. No third branch, no
  default case that silently prints `value ?? 0`.
- **`primaryTotal` is deleted**, not fixed: a dead metric cannot be honest, and
  keeping it invites a future reader to start trusting it.

**Enforcement**: `bakeoff/summary.mjs` is pure under D2a, so every one of these
is a unit assertion with no rig. Required cases: measured-zero (`status:
'measured', value: 0` — a real, meaningful zero, distinct from `unknown`),
`unknown` with `observationCount: 0`, and a partially-unpaired measured result
— asserted for both serialization (the shape itself) and rendering (the
renderer's exhaustive switch), so a change to either side alone still fails.
That is cheap precisely because D2 made the module pure, which is the
dependency worth noting between the clusters.

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
(c5cbb252)` imports exactly:

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
| `bakeoff/arms.mjs` | `resolveArms`, `deriveArms`, `transportForModel`, `scopeForEntry` | `bakeoff/scope`, `lib/campaign/config`, **`lib/campaign/lock`** (round-4 finding M1 — `computeCollectLock`'s own real dependency, the table under-specified it, not the code), `lib/comparison/*` | any `scripts/*.mjs` entry point; `bakeoff/spawn`, `bakeoff/log` | reads `.campaigns/` |
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
  ```

  **"Every edge in the D2a table is intra-domain" was FALSE for one edge, and
  the Gemini gate caught it (G3).** `campaign/promote.mjs → lib/store/campaign.mjs`
  is `shared-lib → stores` — measured: `lib/store/**` resolves to the `stores`
  domain, not `shared-lib`, and `shared-lib`'s own `allowedDeps`
  (`["claude-hooks", "findings", "plan"]`) does not include `stores`. This is a
  **real, currently-nonexistent** cross-domain edge (confirmed: no file under
  `campaign/**`/`comparison/**` imports `lib/store/**` today) — D2a's own table
  introduces it, and the blanket "intra-domain by construction" claim missed
  the one file in this whole plan that actually touches a store.
  - **Widening `shared-lib`'s `allowedDeps` to include `stores` is REJECTED**
    — `shared-lib` is used far beyond this plan's files, and opening store
    access for everything under it to get ONE file through is exactly the
    broad, uncontrolled widening a domain boundary exists to prevent.
  - **A brand-new domain for one file is also rejected as heavier than
    needed.** `promote.mjs` alone gets a **file-specific, more-specific-pattern
    rule**, reusing the **existing** `model-eval` domain (already permits
    `stores` — no new domain, no new `allowedDeps` entry at all):
    ```jsonc
    // MORE SPECIFIC than the campaign/** rule below — ordering is significant,
    // and this line must precede it, same convention as the bakeoff/** rule
    // above the scripts/lib/** catch-all.
    { "pattern": "scripts/lib/campaign/promote.mjs", "domain": "model-eval" }
    { "pattern": "scripts/lib/campaign/**", "domain": "shared-lib" }   // unchanged, pre-existing
    ```
  - **Consequence for the module-contract graph checker** (below): the edge
    `campaign/promote.mjs → lib/store/campaign.mjs` is now an INTER-domain
    edge the domain map explicitly permits (`model-eval`'s `allowedDeps`
    already lists `stores`), while `arm-vocabulary-layering` (domain-level)
    now correctly SEES and validates it — the one edge D2a's module-level
    checker cannot substitute for, because domain-level enforcement is exactly
    what a cross-domain edge needs.

- **Consequence, stated rather than glossed: `arm-vocabulary-layering` CANNOT
  enforce the D2a table.** It checks *domain*-level edges; D2a is a *module*-level
  contract inside a single domain. The R5 claim of mechanical enforcement was
  false. The honest replacement operates at module granularity:
  - **`tests/bakeoff-module-contract.test.mjs`** (new, Phase 2) — **a resolved
    local-module GRAPH check, not a string search (post-gate fix, M2).** The
    round-1 gate was right that "parses import statements" is bypassable
    (re-export, a new intermediary module, a dynamic import) and doesn't prove
    the graph is acyclic. The checker:
    1. **Builds the edge set** from every `import`/`export … from` statement
       (both count — a re-export is still a dependency) AND every **literal**
       `import('./literal/path.mjs')` dynamic import, resolved to repo-relative
       paths (no string matching on unresolved specifiers).
    2. **A non-literal dynamic import inside a restricted module** (`spawn`,
       `summary`, `promote` — the modules D2a forbids specific edges from) is
       **itself a failure**, unless paired with an explicit
       `// module-contract:exempt reason=<why>` pragma, reviewed like any other
       suppression this repo uses (`@duplicate-justification`'s sibling pattern).
       A dynamic import with a computed path is exactly how a forbidden edge
       hides from a static string search.
    3. **Asserts every edge against the D2a allow-list, read from ONE
       machine-readable source, never re-typed into the test (round-3 gate,
       M2).** "Table-driven from D2a's own table" was underspecified — a
       Markdown table is prose, and a test consuming it either duplicates the
       allow-list (drifts from the prose silently) or parses a
       human-formatted table (couples the test to document layout). The fix:
       **`scripts/lib/bakeoff/module-contract.mjs` (create, Phase 2)
       exports the allow-list as a plain JS data structure** —
       `Record<modulePath, {mayImport: string[], mustNotImport: string[],
       sideEffects: 'pure'|'reads-log'|'writes-store'|'spawns'|'writes-stdout'}>`,
       one entry per D2a row. **D2a's Markdown table is generated FROM this
       module** (a small script, or written by hand and asserted equal to the
       module's own `Object.entries` in a Tier-1 test) — the module is the
       source of truth, the prose is its rendering, never the reverse. The
       graph checker imports the module directly; no parsing of this
       document, ever.
    4. **Asserts the resolved subgraph (`bakeoff/**` + the three new
       `campaign/*.mjs`) is ACYCLIC** — a cycle is a failure independent of
       whether any single edge is individually on the allow-list, closing the
       gap the round-1 gate named directly.
    5. Failure messages **name the file, the import line, and the specific
       D2a rule violated** — deterministic and actionable, not a stack trace
       from a generic graph library.

    Static, small, fails at push like everything else here — the graph is
    ~9 files, not a general-purpose architecture linter.
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
    — and `promote.mjs` loses a file-reading side effect. **Wording fix
    (round-3 gate, M2)**: "pure transform" overstated it — the D2a table two
    sections below correctly lists `promote.mjs`'s side effect as **writes
    the store**, which this paragraph's "pure" contradicted. The precise
    claim is narrower and is what actually matters for the cycle: `promote.mjs`
    is **pure with respect to the LOG** (no longer reads it — that's the
    parameter-passing change above) while remaining an impure store-writing
    service, exactly as D2a's table already states. That is smaller than the
    declaration it replaces, and it removes the cycle instead of blessing it.
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
derived from the actual `describe` blocks — **re-verified line-by-line on
`c5cbb252`: all nine still land correctly**, so Phase 4 is unaffected by the
rebase. The mapping is a
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

**Phase 1 CREATES two suites, fully populated — not split with Phase 4 (round-4
finding M5/M6/M7, superseding the R2/M3 split below).** The R2 draft split
Phase 1's creation from Phase 4's extension specifically to keep Phase 1's own
diff small (Phase 1 creating only the LEGACY_ARMS/D1-contract subset, Phase 4
adding the rest). Executing Phase 1, that split turned out to cost MORE than it
saved: every block this table names for "Phase 4" (`resolveArms`,
`transportForModel`, D4 rerolls, collect-time lock, `isComplete` ×2,
`zeroFindingArms`, counting rules, `armCostUsd`, `summarise surfaces every
arm`) calls a function whose SIGNATURE Phase 1 itself changes (the
`ResolvedScope` threading) — so leaving them in `tests/final-review-
bakeoff.test.mjs` until Phase 4 would mean Phase 1 ships with those tests
BROKEN (calling the old loose-parameter signature) for one to three phases,
or duplicating a temporary shim nobody wants to write twice. Phase 1 therefore
moves ALL of it at once — verified: `tests/bakeoff-arms.test.mjs` and
`tests/bakeoff-summary.test.mjs` are fully populated after Phase 1, every
`describe` block the matrix names for either file already lives there, and
`tests/final-review-bakeoff.test.mjs` retains exactly the three "stays" blocks
below plus `cloud run wiring (buildArmArgs)` (correct to still be there —
`buildArmArgs` itself does not move until Phase 2 creates `spawn.mjs`).
**Phase 4's job for these two files is therefore NONE** — it moves straight to
creating the four NEW files this table names (`bakeoff-spawn.test.mjs`,
`campaign-adjudicate.test.mjs`, `campaign-cited-source.test.mjs`,
`campaign-promote.test.mjs`) and trimming `tests/campaign-adjudication.test.mjs`
to its `LIVE:`-only block, exactly as this section already specified for
those four.

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

| Invariant | Guarding block (verified present at `c5cbb252`) |
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

### D7 — Two roles reach n-arm synchronous parity; final-review stays passive, by name (NEW — ungated; retitled post-gate, H1)

> **Post-gate addition, and the largest one.** Neither this plan nor its
> predecessor covered *role executability*. The predecessor built the role
> **vocabulary**; it did not make the vocabulary runnable. This decision is
> Cluster D and is deliberately last.

**The requirement**: choose any of the three LLM roles in the audit chain, and
compare 1..n models for it, without hand-editing a table.

**Measured state on `c5cbb252`** — the vocabulary is unusually well-modelled
(`ROLES`, the eligible/supported split, `assertRoleCoverage` proving every role
has exactly one owning mechanism). Execution is not:

| Role | Runnable? | n-arm? | Evidence |
|---|---|---|---|
| `final_review_shadow` | **Yes** — live, spend-bearing, 6 arms | Yes | Runs on `CampaignConfigSchema` via `bakeoff-collect.mjs`. **Does not use `comparison/manifest.mjs` at all.** Its manifest support exists in `controls.mjs` and has **no CLI consumer** — schema-reachable, execution-unreachable. |
| `auditor` | **Yes** | **Yes** — the only n-arm manifest driver | `model-eval-auditor.mjs` `runManifestDriver`. Role hardcoded at **8 production sites**; a `final_review_shadow` manifest parses and is then rejected. Declared `control`/`replicate` arms are validated but **never executed**. |
| `adjudicator` | **No** | No | No controls schema (`CONTROLS_BY_ROLE` omits it); `parseComparisonManifest` refuses it as a stated v1 boundary; `model-eval-adjudicator.mjs` exists but has **no `--manifest` and no arm concept** (1-candidate-vs-1-baseline); **never executed** in any tier; and its live-shadow path is transport-limited to 3 providers. |

**Three structural walls, not one missing schema** — worth stating plainly
because "add adjudicator controls" sounds like a small change and is not:

1. **The store enforces the split.** `store/model-eval.mjs` validates `role`
   against `SWAP_ELIGIBLE_ROLES` (`auditor|adjudicator`), so
   `model_eval_comparisons` can **never** hold a `final_review_shadow` row —
   that role persists through `store/campaign.mjs` instead. Unifying at the CLI
   without addressing this hits a wall at the persistence layer.
2. **Widening the campaign collector is FORBIDDEN.** `CAMPAIGN_ELIGIBLE_ROLES`
   is a one-value enum on purpose: AGENTS.md's model-swap-eval section states
   *"Do not add a sixth collector"*, and the predecessor's D3 caps how many
   passive collectors this repo may have. So the unification **must not** go via
   `bakeoff-collect.mjs`.
3. **Blinding vocabulary is vendor-keyed.** `store/campaign.mjs`'s
   `PROVIDER_TERMS` is a static vendor list (`deepseek, qwen, grok, kimi, opus,
   glm, …`). `armIds`/`armModels` are redacted dynamically, so this is
   defence-in-depth — but **an arm from an unlisted vendor leaks that vendor's
   name into the blind adjudication payload**. Adding a vendor is therefore
   currently a two-edit operation, which is the shape D1c exists to eliminate.

**The decision, stated precisely because the round-2 gate caught an overclaim
in the first draft's own heading (post-gate fix, H1): this plan closes the
`auditor`↔`adjudicator` gap; it does NOT make `final_review_shadow` driveable
by the manifest.** The first draft's heading — "one driver for three roles" —
was flatly inconsistent with its own body, which correctly scoped
`final_review_shadow` OUT. Corrected: **the synchronous manifest driver
reaches n-arm parity across the two roles that operate synchronously
(`auditor`, `adjudicator`); the passive campaign collector remains
`final_review_shadow`'s ONLY execution path, unconditionally, for the
duration of this plan.** Whether `final_review_shadow` ever gets synchronous
execution is a real, separate, and currently open question — not a promise
D7 makes, and not something the census in D7e is scoped to grant either: D7e
decides where evidence is **stored**, not what a driver can **execute**. If
synchronous final-review execution is ever wanted, it needs its own
`RoleExecutor` and its own corpus definition (§D7c's port makes that
extension mechanical, but extending it is out of scope here) — named
explicitly rather than discovered as a gap during Phase 6, which is exactly
how the overclaim above was found.

Direction matters and this is the only direction that satisfies both
constraints. It respects the collector cap (wall 2 — nothing is added to the
passive side), and it matches what the capability is actually *for*: choosing a
layer and running a comparison is **synchronous, operator-initiated** work —
which is the swap-eval's job description — not organic accumulation over
commits, which is the campaign's. `model-eval-auditor.mjs` already proves the
shape works for n arms; the work is generalising it off one hardcoded role
rather than inventing a mechanism.

**Scope of Cluster D, smallest-first, each independently valuable:**

- **D7a — de-hardcode the existing driver, AND fix the layering direction
  (round-3 gate, H2).** Lift the 8 `'auditor'` literals in
  `model-eval-auditor.mjs` into a role parameter. The round-3 gate correctly
  caught that "the entry point becomes a thin shim over `runManifestDriver`"
  never said WHERE `runManifestDriver` lives once lifted — leaving it in the
  top-level script would make `executors.mjs` (D7c, a lib module) import FROM
  an entry point to reach it, inverting this plan's own repeatedly-enforced
  `entry point → lib, never the reverse` rule.
  - **`runManifestDriver` moves to `scripts/lib/model-eval/manifest-driver.mjs`**
    (create) — role-generic, imports `EXECUTORS` (D7c) and the manifest/scope
    machinery already in `comparison/**`.
  - `scripts/model-eval-auditor.mjs` becomes a thin argv shim: parse flags,
    call the lib function, print/exit. Same shape D2's `bakeoff-collect.mjs`/
    `campaign.mjs` reduction already establishes elsewhere in this plan — D7a
    is that same pattern applied to a third entry point.
  - **Same fix for the adjudicator side**: `scoreAgainstGroundTruth` and its
    `toRawContext` helper move from `scripts/model-eval-adjudicator.mjs`
    (a top-level script) into a NEW `scripts/lib/model-eval/adjudicator-executor.mjs`
    (create) — bodies move verbatim, D2's own rule. `model-eval-adjudicator.mjs`
    imports the lib function for its existing 1-vs-1 CLI path (unchanged
    behaviour); `EXECUTORS.adjudicator` (D7c) imports the SAME lib function —
    neither imports the other's entry point.
- **D7b — `adjudicator` controls schema, enumerated (post-gate fix, M1).** "The
  narrow, honest version" was a promise with no table — the round-2 gate
  correctly asked for the dials, not the adjective. `AdjudicatorControlsSchema`
  mirrors `AuditorControlsSchema`'s existing pattern (`...COMMON_SHAPE` plus a
  small role-specific tail), every field traced to what
  `model-eval-adjudicator.mjs` already configures today:

  | Field | Zod 4 shape | Source / default | Maps to (existing CLI) |
  |---|---|---|---|
  | `reasoningEffort`, `promptTemplateId`, `outputSchemaId`, `maxOutputTokens`, `toolPolicy`, `temperature`, `preflight?` | `COMMON_SHAPE` (unchanged) | shared with every role — no new definition | passed through to `extractStructured`'s route/prompt construction, same as `auditor` today |
  | `tier` | `z.enum(['screen', 'promotion'])` | **required**, no default (mirrors `--tier`'s existing hard requirement — `main()` exits 1 without it) | `--tier` |
  | `thresholdsPath` | `z.string().min(1).optional()` | defaults to `DEFAULT_THRESHOLDS_PATH` (`config/adjudicator-thresholds.json`) when absent | `--thresholds` |
  | `baseline` | `CandidateSpecSchema.optional()` (reuse the existing spec shape `resolveCandidateRoute` already parses) | defaults to `DEFAULT_BASELINE_CANDIDATE_SPEC` (`{kind:'sentinel', value:'latest-pro'}`) when absent | `--baseline` |
  | `groundTruthLimit` | `z.number().int().positive().optional()` | defaults to `GROUND_TRUTH_LIMIT_DEFAULT` (`store/model-ab.mjs`) | not currently a flag — new, because a manifest run needs it fixed and declared (D7c's "one page, fetched once" rule), not implicitly whatever today's default happens to be |

  **What this schema does NOT add**: no per-arm override of `tier`/`baseline`/
  `thresholdsPath` — these are comparison-level dials by the same rule
  `reasoningEffort` already enforces for every role (lesson (b): arms must
  share one dial or the comparison measures the setting, not the model).
  `groundTruthLimit` is the one field with no existing CLI flag, and it is
  added ONLY because D7c's fixed-corpus requirement makes an implicit default
  unsafe for a multi-run comparison in a way it was not for a single
  `--candidate` invocation — named here rather than discovered as a gap during
  Phase 6.

  `SUPPORTED_ROLES` then equals `ROLES`, and `assertRoleCoverage` starts
  asserting something about production rather than about test fixtures.

  **Tests (Phase 6 exit condition)**: parse/round-trip for the schema itself;
  a manifest-to-executor propagation test asserting `tier`/`baseline`/
  `thresholdsPath`/`groundTruthLimit` from a parsed manifest reach
  `EXECUTORS.adjudicator`'s actual call into `scoreAgainstGroundTruth` —
  proving the wiring, not just the schema.
- **D7c — n-arm adjudicator execution, against a NAMED, DISPATCHED port
  (post-gate fixes H1 round 1 + H2 round 2).** "Extend the driver" was not a
  contract — round 1's gate correctly called this out. Round 2's gate then
  found the port itself underspecified: an untagged union mixing auditor
  findings and adjudicator verdicts, no named dispatch module, no
  `arm.model → route` resolution, no cohort-completeness rule for a failed
  arm. All four, closed:

  **1. The result type is an ATTEMPT union, not a success-shaped record with
  bolted-on failure fields (round-3 gate, H3).** The round-2 fix required
  `result`/`usage`/`provenance` unconditionally — but a route-resolution
  failure or a failed spawn happens **before any provider call**, so none of
  those three exist yet at that point. Requiring them made the type
  unrepresentable for exactly the failure modes D7c's own cohort-completeness
  rule depends on. The union now branches on attempt outcome FIRST, and only
  the success branch carries a role result:

  ```
  ExecutorAttempt =
    | { outcome: 'ok', result: RoleResult,
        usage: {inputTokens: number, outputTokens: number, costUsd: number|null} | null,
        provenance: {model, route, promptTemplateId, capturedAt} }
    | { outcome: 'retryable', reason: string, attempt: number }
    | { outcome: 'terminal', reason: string, partialUsage?: {inputTokens, outputTokens, costUsd} }
  ```

  **`usage`'s nullability, corrected against implementation (round-4 gate
  H6/H21) — TWO independent levels, not one.** `costUsd: number|null` is the
  same null-means-unpriced-never-false-zero policy `model-pricing.mjs`
  enforces everywhere else (a provider that reports no usage, or a model with
  no pricing-table entry, must never read as a free/zero call). `usage` ITSELF
  is `|null` at the outer level, distinct from a nullable `costUsd` inside a
  present object: the auditor executor's mechanism (a spawned child process
  running the single-`--candidate` CLI path) does not instrument per-arm token
  usage at all today — `usage: null` means "not tracked by this mechanism",
  which is not the same fact as "tracked and unpriced" (`costUsd: null` inside
  a real `{inputTokens, outputTokens, ...}` object, as the adjudicator executor
  produces). Collapsing these two into one `null` would lose exactly the
  distinction AGENTS.md's "a hardcoded 0 in telemetry reads as a measurement"
  rule exists to preserve, generalised one level up.

  `usage` and `provenance` are **only reachable through the `'ok'` branch** —
  a caller cannot accidentally read cost off a failed attempt, because the
  type does not offer one. `partialUsage` on `'terminal'` is optional and
  named as such: a 4xx before any tokens were spent has none; a terminal
  failure AFTER a partial response (rare, but real) can still report what was
  metered.

  **`RoleResult` is discriminated on `role`, and BOTH branches carry the SAME
  metrics shape — corrected against implementation (round-4 gate H1/H16), not
  the `findings: NormalizedFinding[]` this section originally claimed for the
  auditor branch.** Grep found zero other references to `NormalizedFinding`
  anywhere in this plan; the actual auditor mechanism
  (`runScreenTier`/`runPromotionTier` in `scripts/model-eval-auditor.mjs`)
  returns `{verdict, nextAction, metrics: {recall, falsePositiveRate, f1},
  evidence, cost}` — the IDENTICAL metrics shape `scoreAgainstGroundTruth`
  (adjudicator) returns, since both roles are graded through the same
  `computeVerdict` contract. **`recall` and `f1` are nullable, not the
  non-null numbers this section originally declared** — verified against
  `scoreBinaryClassification` (`deterministic-scorer.mjs`): both derive from a
  ZERO-DENOMINATOR case (no positive ground-truth rows in the sampled page)
  and the scorer returns `null` rather than `NaN` or a guessed value for
  exactly that reason. `MetricsSchema` in `verdict.mjs`
  (`z.record(z.string(), z.number().finite().nullable())`) already accepts
  this — the type declared here was stricter than the schema that actually
  validates it, which is backwards:

  ```
  RoleResult =
    | { role: 'auditor',     metrics: {recall: number|null, falsePositiveRate: number|null, f1: number|null}, verdict: string, nextAction: string, evidence: object }
    | { role: 'adjudicator', metrics: {recall: number|null, falsePositiveRate: number|null, f1: number|null}, verdict: string, nextAction: string, evidence: object }
  ```

  **`scoreAgainstGroundTruth` must be EXTENDED to bubble up `usage`, or the
  `'ok'` branch is unrepresentable for the adjudicator role (Gemini gate,
  G2).** Real gap, correctly caught: the function calls `extractStructured`
  **once per ground-truth row internally**, and today returns only the three
  metrics — none of those N calls' token/cost usage escapes the function. D7a
  already moves and generalises this function (its layering fix, above); this
  is a bounded EXTENSION of that same edit, not new unplanned scope:
  - `scoreAgainstGroundTruth` sums `{inputTokens, outputTokens, costUsd}`
    across its internal `extractStructured` calls and returns it alongside
    the existing metrics: `{recall, falsePositiveRate, f1, usage}`.
  - **`provenance` is NOT blocked the same way — it was never inside
    `scoreAgainstGroundTruth` to begin with.** `route` is already a parameter
    the caller (`executeArm`) holds before calling in; `promptTemplateId`
    comes from the already-resolved `controls`; `capturedAt` is the call
    timestamp. `executeArm` constructs `provenance` itself, from values already
    in hand — no plumbing through `scoreAgainstGroundTruth` needed for this
    field, only for `usage`.
  - Test (Phase 6 exit condition, additive to the existing integration test):
    a fixture with 2 ground-truth rows asserts the returned `usage` is the SUM
    of both rows' token counts, not just the last row's or a single row's.

  A caller switches on `result.role` inside the `'ok'` branch, never on which
  field happens to be present — the exact ambiguity the round-2 gate named,
  now closed on the correct payload shape.

  **2. Dispatch is a NAMED registry, TWO-PHASE — not a single per-arm
  function (Gemini gate, G1).** The round-3 shape,
  `EXECUTORS: Record<Role, (arm, controls, corpus) => Promise<ExecutorAttempt>>`,
  was self-contradictory: it took `corpus` as a per-call parameter while D7c's
  own text required the corpus be **"fetched once per manifest run and reused
  for every arm."** Something has to fetch it once, BEFORE the per-arm loop —
  but the driver is role-generic and has no business knowing an adjudicator
  fetches `getAdjudicatorGroundTruth` rows while an auditor fetches nothing
  comparable at all. A single-phase signature forces a choice between
  breaking genericity (the driver hardcodes a role-specific fetch) or breaking
  "fetch once" (each arm call fetches its own copy). Split into two phases,
  exactly the shape the round-3 `repoId`-reuse fix already established for a
  single value, generalised to whatever run-level setup a role needs:

  ```
  EXECUTORS: Record<Role, {
    prepareContext?: (manifest, repoIdentity) => Promise<Context>,   // once per RUN
    executeArm: (arm, controls, context) => Promise<ExecutorAttempt>, // once per ARM
  }>
  ```

  - `scripts/lib/model-eval/executors.mjs` exports `EXECUTORS`. D7a's
    role-generic `runManifestDriver(role, manifest)` resolves `repoIdentity`
    once (as it already does), calls `EXECUTORS[role].prepareContext?.(manifest,
    repoIdentity)` **once**, then loops scored arms calling `executeArm(arm,
    controls, context)` — the driver stays generic because it never
    interprets `context`'s shape, only passes it through. `assertRoleCoverage`
    (already proving vocabulary↔mechanism coverage) gets a THIRD check here:
    every `SUPPORTED_ROLES` entry must have an `EXECUTORS` key with a
    (possibly no-op) `executeArm`.
  - `EXECUTORS.auditor` has **no `prepareContext`** (`undefined` — the driver
    treats it as a no-op `context = undefined`) — the existing per-arm spawn
    needs no run-level setup beyond what it already resolves per call. D7a's
    role lift wraps the existing spawn as `executeArm`, does not rewrite it.
  - `EXECUTORS.adjudicator.prepareContext` fetches
    `getAdjudicatorGroundTruth({repoId: repoIdentity.repoUuid, …}).rows`
    **once** and returns `{rows}` as `context` — satisfying "fetch once,
    reuse for every arm" literally, not just in prose. `executeArm(arm,
    controls, {rows})` then calls `scoreAgainstGroundTruth({route, rows})`
    **from its lib home, `model-eval/adjudicator-executor.mjs`** (D7a's
    layering fix — never the top-level script) — reusing the existing
    `extractStructured`/`scoreBinaryClassification` pipeline verbatim, once
    per declared arm rather than once for a single `--candidate`.

  **3. `arm.model` reaches a route through the EXISTING resolver, not a new
  one**: `resolveCandidateRoute({role, candidateSpec: {kind:'concrete',
  value: arm.model}, env})` (`model-eval/route-catalog.mjs:125`) — the same
  function `model-eval-adjudicator.mjs` already calls for its single
  `--candidate`. `executeArm` calls it once per arm; no new resolution logic.

  **4. The fixed corpus is `getAdjudicatorGroundTruth({repoId, …}).rows`**
  (`store/model-ab.mjs:584`) — the same labeled-row set the existing 1-vs-1
  path already scores against, fetched by `prepareContext` above and passed
  as `context` to every `executeArm` call — arms are scored against identical
  rows by construction, not by convention.

  **`repoId` is threaded, not re-derived (round-3 gate, H4).** The round-2
  draft left `repoId` unsourced. `runManifestDriver` **already** resolves it
  today — `const repoIdentity = resolveRepoIdentity()` runs once, for the
  auditor path's own `upsertComparison` call. The fix is reuse, not new
  machinery: the SAME resolved `repoIdentity` feeds both `upsertComparison`
  and `prepareContext` — one resolution, shared, never re-derived per arm.
  Unresolvable repo identity fails the SAME way an unresolvable campaign
  already does elsewhere in this plan: at load, before any arm runs, named.

  **Provenance is the query parameters actually used, not invented snapshot
  machinery.** The round-3 recommendation's fuller ask — an immutable
  corpus-snapshot digest with ordered row fingerprints — is **declined as
  disproportionate** to what "one page, fetched once" needs: `getAdjudicatorGroundTruth`
  already accepts `{repoId, limit, cursor, sinceDecidedAt}`, and recording
  those four values alongside the fetched rows (in the manifest run's
  provenance, not a new store concept) is sufficient to answer "what corpus
  did this comparison actually score against" — a digest over the rows
  themselves is precision this fixed-page-per-run design does not need and
  would be inventing state to solve a question the query parameters already
  answer. **An empty corpus (zero rows returned) is a refusal**, not a
  0-observation `unknown` result under D6's rule — an adjudicator comparison
  with nothing to score is not a degenerate-but-valid outcome, it is a setup
  error, and it fails the same way an unresolvable repo identity does.

  **5. Persistence and scoring reuse the existing pipeline unchanged**:
  `scoreBinaryClassification` → `computeVerdict` → `model_eval_runs` via
  `createEvalRun`/`updateEvalRunTerminal`. D7c adds an arms loop around step 1
  of the existing 5-step pipeline; it does not touch steps 2–5.

  **6. Retryable vs. terminal**, and **cohort completeness on a terminal
  failure (round-2 gate, H2)**: `classifyLlmError` (already imported by the
  shared provider seam) — a 429/5xx retries per arm independently; a 4xx
  (model id, malformed manifest) is terminal for that arm. **A terminal arm
  failure does NOT abort the cohort or block verdict generation** — it
  follows D6's own no-silent-zero rule, applied to execution rather than
  telemetry: the failed arm's outcome is `'terminal'` with a reason (never
  silently dropped, never retried into a false completion), and the readout
  NAMES it excluded from the verdict rather than pretending an (n-1)-arm
  comparison was the n-arm one requested. This mirrors D5a's per-arm resume
  semantics already established for the auditor role — the same "a comparison
  degrades honestly rather than fails wholesale" posture D1a/D6 already commit
  to elsewhere in this plan.

  **"Persists" has one precise boundary, corrected against implementation
  (round-5 gate H2/H11): a `model_eval_runs` ROW exists only for a failure
  AFTER route resolution succeeded** — a route-resolution failure (bad model
  id, unrecognized sentinel) is a PREFLIGHT rejection, mirroring
  `model-eval-auditor.mjs`'s own single-candidate path exactly: its
  `RunPreflightError` branch in `main()` is caught and reported BEFORE
  `createEvalRun` is ever called there too, so a config error never mints a
  "running" row it would then have to walk back. The terminal outcome is
  never silently dropped either way — a route-resolution failure is visible
  in the driver's own `--out` JSON summary and in stderr, the same place a
  preflight failure on the single-candidate CLI path is visible (its own
  non-zero exit + stderr, no run row). "Persisted to the store" and "made
  visible to the operator" are two different guarantees; this plan commits to
  the second unconditionally and the first only once a run row exists to
  update.

  **7. Persistence was a real gap, not an implementation detail — closed
  post-implementation (round-4 gate H13).** The auditor executor gets
  `model_eval_runs` persistence for free (its `executeArm` SPAWNS
  `model-eval-auditor.mjs`'s own single-candidate CLI, which already calls
  `createEvalRun`/`updateEvalRunTerminal` when handed `--comparison-id`/
  `--arm-id`/`--attempt`). `adjudicatorExecuteArm` runs IN-PROCESS — it has no
  child CLI invocation to inherit persistence from — so it must call the SAME
  store functions itself, and initially did not: an adjudicator manifest's arm
  results existed only in the driver's ephemeral `--out` JSON, with nothing in
  `model_eval_runs` for `maxComparisonArmAttempt` (D5a's resume reducer) to
  find on a re-run. Fixed: `adjudicatorExecuteArm` calls `createEvalRun`
  (status `running`) after route resolution succeeds, then
  `updateEvalRunTerminal` on both the success and failure path.
  **This surfaced a second, harder requirement**: `updateEvalRunTerminal`'s
  own schema (`refineVerdictPair`) REQUIRES a non-null `verdict`/`nextAction`
  on `status:'completed'` — a metrics-only row is not just incomplete, the
  store rejects it outright. So `adjudicatorExecuteArm` now also calls
  `computeVerdict` per arm (`mode:'oracle', tier:'screen'`, mirroring
  `model-eval-adjudicator.mjs`'s own screen-tier call), scored against every
  row `prepareContext` fetched (no slice-down to `minSampleSize` — the
  fetched page is already the fixed, declared corpus for the whole cohort).
  Threshold-config resolution (`manifest.controls.thresholdsPath` override, a
  module-local default mirroring `model-eval-adjudicator.mjs`'s own
  `DEFAULT_THRESHOLDS_PATH` pattern) moved into `prepareContext`, run once per
  manifest rather than once per arm. `RoleResult.adjudicator` gained
  `verdict`/`nextAction`/`evidence` fields to match — it is now
  STRUCTURALLY IDENTICAL to `RoleResult.auditor`'s shape, which makes sense:
  both are graded through the same `computeVerdict` contract.

  **Integration test (Phase 6 exit condition, not optional)**: a
  manifest-driven test with a **deterministic fixture ground-truth set**
  (2-3 rows, fixed labels) traces `CLI → runManifestDriver → EXECUTORS.adjudicator
  → scoreBinaryClassification → model_eval_runs`, asserting the persisted row
  shape for 2 arms against the same fixed rows, **plus one arm forced to a
  terminal failure**, asserting the cohort still produces a verdict over the
  surviving arm with the failed one named in the result.
- **D7d — the store seam, decided against PRE-REGISTERED criteria.** See D7e
  below: the question is posed precisely, and the rule that answers it is fixed
  *before* the evidence arrives.

#### D7e — Role and MODE are orthogonal axes, and the decision rule is pre-registered (NEW — ungated)

**The reframing that matters for doing this repeatedly.** An earlier draft of
D7d asked "should the two persistence paths unify?" and answered "we'll decide
later; keeping them separate is a valid outcome." Both halves were wrong, and
the second is the more dangerous:

- **A decision gate with no stated criteria decides after seeing the data**,
  which is what pre-registration exists to prevent and what this repo enforces
  everywhere else (the campaign's own decision rule, the N=12 stopping rule,
  `TIERED_SHADOW_CONTRACT_EPOCH`). Writing "either outcome is valid" with no rule
  is not scope discipline; it is a licence to pick whichever answer is cheaper
  on the day. AGENTS.md's own test applies: **a defer is honest as a scope
  boundary or as documented debt, never because the correct fix is larger.**
- **"Unify the stores?" is the wrong question.** The real structure is two
  *orthogonal* axes, and the current design conflates them.

**The two axes:**

| Axis | Values | What it determines |
|---|---|---|
| **Role** | `auditor` · `adjudicator` · `final_review_shadow` | *What* is being compared — which LLM seat in the audit chain |
| **Mode** | `passive` (accumulate over real work) · `synchronous` (score a fixed corpus on demand) | *How* the evidence is gathered |

Today role **determines** mode, and that binding is a historical accident rather
than a design: `final_review_shadow` runs passively because that is how the
bake-off happened to start; `auditor` runs synchronously because that is how the
model-swap question happened to be framed. **Nothing in either role's nature
requires its mode.** A synchronous final-review eval over a corpus of transcripts
is perfectly coherent; so is passively accumulating auditor comparisons as real
audits run.

**Why this matters specifically for doing evals repeatedly.** If role keeps
determining mode, then every future eval inherits its tooling from an accident:
the operator must remember which of two CLIs, two config formats, two stores and
two readouts applies to the seat they happen to be testing — and *"how did Opus
do as a final reviewer"* versus *"how did Opus do as an auditor"* cannot be put
side by side, because the two answers are computed by different machines. That
is the stated requirement — three layers, n arms, easily — failing at the second
word. **Two systems sharing a vocabulary is not one system.**

**The target shape** (already most of the way built — this names it, it does not
invent it): **one comparison core, two mode envelopes.**

```
shared core   : arms · controls · per-arm runs · per-arm spend · findings · adjudication
passive env.  : cohortDigest · contractEpoch · targetN/stoppingRule · per-snapshot completeness
synchronous   : tier · oracle corpus · per-case scoring
```

The overlap is the *evidence*; the differences are *framing metadata*. That is
exactly the split `role-agnostic-comparison-core` already made in the schema
layer — D7e asks only whether the **store** follows it.

**PRE-REGISTERED DECISION RULE for D7d.** Fixed now, applied mechanically when
D7a–c land. No judgement call at decision time:

1. **Enumerate** every field each readout actually reads — the campaign
   standings/watermark, the swap-eval verdict, and the dashboard collector.
2. **Classify** each field as *shared core*, *passive-only*, or
   *synchronous-only*.
3. **UNIFY** (widen the `model_eval_*` role constraint; one store, two envelopes)
   **iff every field classifies cleanly** — i.e. no field is required by both
   modes with *incompatible semantics*.
4. **KEEP SEPARATE iff at least one field is required by both with incompatible
   semantics** — and that field must be **named in the verdict**, not gestured
   at. A "keep separate" conclusion that cannot name its blocking field is a
   failed analysis, not a valid outcome.
5. Either way, **record the field census in this plan**. It is the artifact that
   makes the decision re-checkable, and it is worth more than the verdict.

**Phase 7's deliverable is the census + verdict + a short ADR — never a
migration (post-gate fix, H2).** The round-1 gate correctly rejected calling
this "an implementation phase" while giving it zero implementation scope: on
UNIFY, there is no schema, no migration/backfill/rollback plan, no dual-read or
cutover strategy, no dashboard change, and no historical-row treatment anywhere
in this document — the honest size of that work is comparable to a second
`role-agnostic-comparison-core`-sized plan, not a bullet inside this one.
So, stated as a hard boundary rather than left implicit:

- **If the verdict is UNIFY**, Phase 7 ends by **filing a new, separate plan**
  — `docs/plans/comparison-store-unification.md` (planned), exact name decided
  when Phase 7 actually runs — scoped to the migration, and that plan goes
  through its own `/audit-plan` gate before any schema or `model_eval_*`
  constraint changes. Phase 7 itself makes **zero** production changes on
  this branch.
- **If the verdict is KEEP SEPARATE**, Phase 7's remaining deliverable is the
  **durable interface contract** the round-1 gate asked for: a documented
  field-level mapping showing how the shared-core fields the census identified
  stay comparable across both envelopes (same units, same severity vocabulary,
  same arm-identity scheme) even though they persist separately. That contract
  is a doc + an assertion in `tests/comparison-core.test.mjs` that both
  envelopes' shared-field shapes agree — not a schema change.
- **Cluster D's fix-gate therefore closes on either branch without a migration
  landing in THIS plan.** A migration is out of scope for this plan by
  construction, not by omission.

> **Predicted outcome, recorded in advance so the prediction is falsifiable.**
> On the current reading the overlap looks large and the differences look like
> pure framing metadata, so I expect **UNIFY**. Writing that down now means the
> census can prove me wrong — which is the point of predicting before measuring
> rather than after. If the census returns "keep separate", the named blocking
> field is a real finding about the two evidence models, not a shrug.

**Right-sizing.** D7e adds no build scope: it replaces an unstated decision with
a stated one, and step 1–2's census is a read of code that will already be open.
The over-built alternative — collapsing the two envelopes into one schema
regardless of what the census finds — is explicitly rejected: a one-sitting eval
has no meaningful cohort epoch, and forcing one on it would be coupling two
lifecycles to avoid one conditional.

> **Right-sizing note.** D7 is *not* "build a universal comparison framework".
> D7a is a parameter lift over code that already works. D7b/c make the third
> role reach parity with the second. D7d is explicitly a *decision*, not a
> build. The over-built version — one store schema, one CLI, one config format
> for all three roles regardless of what they persist — is rejected: two of the
> three roles have genuinely different evidence shapes (a campaign accumulates
> snapshots over time; a swap-eval scores a fixed corpus once), and collapsing
> them would be decoupling nothing while coupling two lifecycles.

#### D7e — Phase 7 deliverable: the field census, applied (post-implementation, Cluster D)

**Third reader does not exist.** D7e's rule step 1 says "enumerate every field
each readout actually reads — the campaign standings/watermark, the swap-eval
verdict, and the dashboard collector." Checked directly against
`scripts/build-dashboard.mjs` (273 lines): it builds a reference page, a
telemetry page, and an audit-run page — **zero references to
`model_eval_runs`, `model_eval_comparisons`, or any `campaign_*` table**. The
"dashboard collector" as a third READER of this evidence is aspirational (an
open question in this plan's own predecessor brainstorm session, `docs/plans/`
`role-agnostic-comparison-core.md`'s design discussion), not real code. The
census below therefore compares the two readers that exist: the campaign's
`loadCohortEvidence`/`evaluateCampaign` (`scripts/lib/store/campaign.mjs`,
`scripts/lib/campaign/verdict.mjs`) and the swap-eval's `model_eval_runs`/
`model_eval_comparisons` (migrations `20260711120000_model_eval_runs.sql`,
`20260815120000_model_eval_comparison.sql`, read by
`scripts/lib/store/model-eval.mjs`). If a real dashboard collector is ever
built reading BOTH stores, re-run this census against it — this is a bound on
what step 1 could examine, not a shortcut around it.

**Field census** (steps 1-2 — enumerate + classify):

| Field | Campaign (passive) | Swap-eval (synchronous) | Class |
|---|---|---|---|
| arm identity | `armIds` / `acceptedPerArm` keys — an `id` inside a committed `.campaigns/*.json` | `arm_id` column, `model_eval_runs.comparison_id` scoped | shared core |
| per-arm cost | `spend`/`cost.perArm` — summed across ALL attempts of a snapshot, per arm | `cost` jsonb per run row | shared core (same concept: money spent per arm; aggregation granularity differs but both derive from the SAME per-call usage events) |
| attempt/retry | no explicit "attempt" column on the evidence bundle (bake-off receipts track it at the log layer, not exposed here) | `attempt` int + `superseded_at` — explicit, first-class | synchronous-only (D5a's per-arm retry is a Cluster A/B mechanism the campaign evidence layer never surfaced as a field; this is a genuine asymmetry, not a naming difference) |
| **verdict** | `{outcome: 'SELECT'\|'INCONCLUSIVE', armId, reason}` — an **N-way selection**: which ONE of potentially many scored arms wins, decided by `evaluateCost`'s tiebreak over every arm that cleared the floor | `verdict: 'keep'\|'switch'\|'inconclusive'\|'manual_review_required'` (`verdict.mjs`) — a **binary switch/keep decision** for ONE candidate against the incumbent/baseline; there is no `armId` because there is no field of arms to pick from, only "replace the incumbent with this candidate, or don't" | **shared core, INCOMPATIBLE SEMANTICS** — see verdict below |
| status/state | `state` (`deriveState`) — COHORT-level lifecycle (`COLLECTING`/`DECISION_READY`/…), a function of `nComplete` vs `targetN` and the gate set | `status` column — RUN-level lifecycle (`completed`/`failed_preflight`/`failed_egress`/`failed_provider`/`running`/`pending_shadow`) | different granularity, not classified as conflicting — a unified schema could carry both (run rows + a derived comparison-level state), the same shape the campaign itself already has (`snapshots` + `state`) |
| completeness | `matrix`/`nComplete`/`targetN`/`cohortSuperseded` — an epoch-gated, N-of-M-snapshots completeness rule (D1's whole subject) | none — a swap-eval run either produced a result or it didn't; there is no "N of M" cohort to be incomplete | passive-only |
| calibration / clustering | `calibration`, `clustering` — blind-adjudication sampling and cross-arm finding dedup, both meaningless without multiple organic snapshots to sample/cluster across | none | passive-only |
| tier / judge tier | none — the campaign has no "screen vs promotion" concept, arms just run | `tier` (`screen`\|`promotion`), `judge_tier` (`A`\|`B`\|`C`) | synchronous-only |
| corpus / harness provenance | none (the campaign's "corpus" is real production audit runs, not a fixed labeled set) | `corpus_version`, `harness_sha`, `thresholds_version` | synchronous-only |
| next action | none | `next_action` (`promote_to_full`\|`reject`\|`eligible_for_shadow`\|`none`) — meaningful only against a fixed keep/switch decision | synchronous-only |

**Verdict (step 3/4): KEEP SEPARATE. Named blocking field: `verdict`.**

The prediction recorded above this section was UNIFY; the census falsifies it
— exactly the outcome pre-registration exists to make legible rather than
argued around. `verdict` is required by BOTH modes (it is the terminal answer
either evidence model exists to produce) and its semantics genuinely diverge:
the campaign's verdict is a **selection** over a field of N arms (`armId`
identifies the winner); the swap-eval's verdict is a **replacement decision**
for ONE candidate against a fixed incumbent (there is no field to select
from — `keep` and `switch` are not "arm A won", they are "the status quo
holds" or "the status quo changes"). A unified `verdict` column would need a
sixth value meaning "N-way SELECT" that swap-eval never produces, or the
swap-eval's binary decision would need to fake an `armId` it has no basis for
— either direction manufactures a distinction neither evidence model actually
has. This is precisely D7e's own worked example of what "incompatible
semantics" means, not a borderline call.

**Phase 7's deliverable (per D7e's own contract for this branch): the durable
field-level interface contract, not a migration.** `docs/plans/`
`comparison-store-unification.md` is **NOT filed** — UNIFY's exit condition
does not apply. The contract:

- **Shared core fields** (arm identity, per-arm cost) **stay comparable**
  across both envelopes: same arm-id string space (`ArmSchema.id`, shared by
  both `scripts/lib/comparison/arms.mjs` and the campaign's own arm schema),
  same currency/unit for cost (`totalUsd` in `CostRowSchema`, `costUsd` on the
  campaign side — different field names, same USD unit and same null-means-
  unpriced-never-false-zero policy, verified via `model-pricing.mjs`'s single
  pricing table on both sides — D2c/D7c both compose the SAME
  `costFromUsage`).
- **`verdict` stays UNCOMPARABLE by design** — a reader needing "did this
  arm/candidate come out ahead" must branch on WHICH mode produced the row
  (`campaign_events`/`model_eval_comparisons` vs. `model_eval_runs`) and
  interpret the verdict vocabulary that mode defines; there is no single
  cross-mode "verdict" query. This is the field a future dashboard (real,
  reading both stores) must design around explicitly, not paper over.
- **Assertion**: `tests/comparison-core.test.mjs`'s
  `branch: d7d=keep-separate` block (§6 flat file table, conditional on this
  verdict) asserts the shared-core fields' SHAPE agreement — same arm-id
  pattern, same cost-row schema — without asserting verdict comparability,
  which this census establishes does not hold.

---

## 3. Right-sizing gate

- **The band-aid**: forward `arms` at line 924 and close incident (c). Rejected —
  fixes one instance, leaves the generator and the other exposed reader. **The
  re-measurement makes this sharper**: the same defect widened from 2 dropped
  arms to 4 without anyone touching the code, purely because the campaign grew.
  A one-line forward leaves that scaling property completely intact.
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
| `scripts/lib/bakeoff/module-contract.mjs` | create | **Round-3 fix, M2.** D2a's allow-list as a machine-readable data module — the single source `bakeoff-module-contract.test.mjs` consumes; D2a's Markdown table is generated from/asserted against it, never re-typed |
| `scripts/lib/bakeoff/scope.mjs` | create | **Pure** `ResolvedScope` shape + `assertResolvedScope` + `UnresolvedScopeError`/`ScopeMismatchError`. No I/O (D2a) |
| `tests/final-review-bakeoff.test.mjs` | modify | Retains the 3 entry-point blocks (D3 matrix); everything else moves out |
| `tests/bakeoff-arms.test.mjs` | create | Arm resolution, no-campaign refusal (D1), **hosts the `LEGACY_ARMS` fixture** |
| `tests/bakeoff-summary.test.mjs` | create | **Scope-threading regression: the incident-(c) repro** + the 6 summary blocks |
| `tests/bakeoff-spawn.test.mjs` | create | `buildArmArgs` cloud-run wiring (D3 matrix) |
| `tests/campaign-adjudicate.test.mjs` | create | Blinding / worksheet / verdict / clustering (D3a-pinned) |
| `tests/campaign-cited-source.test.mjs` | create | Cited-source resolution (D3a-pinned) |
| `tests/campaign-promote.test.mjs` | create | Promotion, receipts, `--force` append (D3a-pinned) |
| `tests/campaign-adjudication.test.mjs` | modify | Retains the LIVE DB-gated block plus the D1c `resolveProviderIdentity`/`armRedactionTerms` block (not in the original D3 matrix; added by Cluster A) |
| `tests/model-eval-core.test.mjs` | delete | Split 7 ways per D3 (independent cluster) — every block moved out, nothing left to modify |
| `tests/model-eval-verdict.test.mjs` | create | D3 split — `verdict` block |
| `tests/model-eval-route-catalog.test.mjs` | create | D3 split — `route-catalog` block |
| `tests/model-eval-deterministic-scorer.test.mjs` | create | D3 split — `deterministic-scorer` blocks |
| `tests/model-eval-structured-extractor.test.mjs` | create | D3 split — `structured-extractor` block |
| `tests/model-eval-cost.test.mjs` | create | D3 split — `cost` block |
| `tests/model-eval-config-schema.test.mjs` | create | D3 split — `config/schema` block |
| `tests/model-eval-store.test.mjs` | create | D3 split — `store/model-eval` block |
| `.audit-loop/domain-map.json` | modify | **Required** (measured): `{pattern, domain:"shared-lib"}` for `scripts/lib/bakeoff/**` above the `scripts/lib/**` catch-all; **plus (Gemini gate, G3)** `{pattern, domain:"model-eval"}` for `scripts/lib/campaign/promote.mjs` specifically, ABOVE the existing `campaign/**` → `shared-lib` rule — the one file in this plan whose store-writing edge is genuinely cross-domain. No new `allowedDeps` entries; `model-eval`'s already permit `stores` (D2b) |
| `docs/plans/comparison-tooling-consolidation.md` | modify | This plan, corrected by its own audit |
| `scripts/model-eval-auditor.mjs` | modify | **D7a (NEW)** — lift 8 hardcoded `'auditor'` literals into a role parameter; reduce to a thin argv shim (round-3 fix, H2) |
| `scripts/lib/model-eval/manifest-driver.mjs` | create | **D7a (NEW, round-3 fix H2)** — `runManifestDriver` moves here from the entry point, so `executors.mjs` (a lib module) never imports a top-level script |
| `scripts/model-eval-adjudicator.mjs` | modify | **D7a (NEW, round-3 fix H2)** — `scoreAgainstGroundTruth`/`toRawContext` move OUT to the lib module below; existing 1-vs-1 behaviour unchanged. **Also gains its own `--manifest` flag** (not in the original D7a text — implementing revealed only `model-eval-auditor.mjs` had one, and an adjudicator manifest routed through the "auditor" script by name would be a real operational confusion; CLI parity with the auditor entry point, same mutual-exclusivity contract) |
| `scripts/lib/model-eval/adjudicator-executor.mjs` | create | **D7a/D7c (NEW, round-3 fix H2)** — `scoreAgainstGroundTruth`/`toRawContext`, moved verbatim except **extended to sum + return `usage`** (D7c, Gemini gate G2 — the `'ok'`-branch `ExecutorAttempt` needs it); imported by BOTH the CLI wrapper above and `EXECUTORS.adjudicator` below — neither imports the other's entry point |
| `scripts/lib/model-eval/executors.mjs` | create | **D7c (NEW)** — the `EXECUTORS` registry; `runManifestDriver` looks up `EXECUTORS[role]` once per manifest run. Includes a THIRD, deliberately-inert `final_review_shadow` entry (`{}` — no `executeArm`) so `SUPPORTED_ROLES` <-> `EXECUTORS` coverage is checkable without making that role driveable — verified necessary by an existing CLI test (`tests/model-eval-auditor-manifest.test.mjs`) that pinned "refuses at PREFLIGHT, before any store write" for exactly this role |
| `scripts/lib/comparison/controls.mjs` | modify | **D7b (NEW)** — add the `adjudicator` controls schema; `SUPPORTED_ROLES` then equals `ROLES` |
| `scripts/lib/comparison/manifest.mjs` | **untouched — corrected from "modify" (D7b)** | Verified before editing: `parseComparisonManifest`'s v1-boundary refusal is entirely DERIVED from `controls.mjs`'s `isRoleSupported`/`SUPPORTED_ROLES` (`manifest.mjs` imports both, never re-implements the check). Registering `adjudicator` in `CONTROLS_BY_ROLE` (controls.mjs) is therefore the WHOLE fix — `manifest.mjs` needed zero code changes. The plan's own claim that this file needed editing was unverified against the actual derivation; caught before writing a no-op edit. |
| `tests/model-eval-adjudicator-manifest.test.mjs` | create | **D7c (NEW)** — n-arm adjudicator manifest driving, including the forced-terminal-failure cohort case (round-3 fix, H3) |
| `tests/manifest-driver.test.mjs` | create | **D7a (NEW, round-3 fix H2)** — coverage for the lifted, now-role-generic `runManifestDriver` |
| `tests/adjudicator-executor.test.mjs` | create | **D7a (NEW, round-3 fix H2)** — coverage for the moved `scoreAgainstGroundTruth`, both callers (CLI + `EXECUTORS`) exercised |
| `tests/bakeoff-summary.test.mjs` | *(already listed)* | **+ D1c/D6 (NEW)** — the derived-set invariant at n ∈ {1,2,6} and the per-aggregate no-silent-zero assertions |
| `scripts/lib/store/campaign.mjs` | modify | **D1c (NEW, Phase 1′)** — derive `PROVIDER_TERMS` from declared arms' model strings; add `resolveProviderIdentity` + `PROVIDER_ALIASES` |
| `scripts/lib/comparison/arms.mjs` | modify | **D1c (NEW, Phase 1′, round-3 fix H1)** — add optional `redactionTerms` to `ArmSchema`, shared by both the passive campaign and manifest paths |
| `tests/campaign-adjudication.test.mjs` | *(already listed)* | **+ D1c (NEW)** — blinding-derivation regression for the new/unlisted-vendor case |
| `tests/campaign-citation-budget.test.mjs` | modify | **Phase 3, discovered during implementation.** A pre-existing suite that imported `centredWindow`/`resolveCitedSources` from `scripts/campaign.mjs`; redirected to `scripts/lib/campaign/cited-source.mjs`, their real D2 home |
| `scripts/plan-file-coverage-check.mjs` | create | **Post-gate fix, H3 — Phase 0.** Close-out tool: diffs the changed-file set against this plan's own §6 table |
| `tests/plan-file-coverage-check.test.mjs` | create | **Post-gate fix, H3 — Phase 0.** Coverage for the checker above |
| `tests/comparison-core.test.mjs` [`branch: d7d=keep-separate`] | modify | **D7e, Phase 7 — CONDITIONAL.** Only touched if the census verdict is KEEP SEPARATE (the shared-field interface-contract assertion). Absent from the diff, correctly, if the verdict is UNIFY. |
| `tests/bakeoff-per-arm-retry.test.mjs` | modify | **Phase 1, discovered during implementation (round-3 gate finding).** Calls the re-signatured `selectRetryArmIds` with a hand-built `{arms, expectedScope}` object lacking `campaignId`; migrated to a `createResolvedScope` fixture |
| `tests/cross-model-buckets.test.mjs` | modify | **Phase 1, discovered during implementation.** Calls `aggregateMatched` with no scope argument at all, now mandatory; migrated with a `createResolvedScope` fixture |

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
  invariants they guard; create the close-out coverage checker.** Read-only
  over production code. **Verified during execution**: all five named blocks
  (`blind worksheet DTO`, `redaction leak canary`, `worksheet identity`,
  `cited sources`, `receipt filename parsing`/`promotion attempt resolution`)
  are already at or above the bar their invariant requires — exact-equality
  assertions, negative controls, degenerate-input coverage (NaN/Infinity/
  oversized single lines), token-boundary canaries. No strengthening needed;
  this step closes as a read, not a write. **Also creates
  `scripts/plan-file-coverage-check.mjs`** (post-gate fix, H3) — the close-out
  tool that derives the requirements-extraction file set from the diff instead
  of a hand-maintained list.
  **Phase-scoping mechanism, refined during implementation (supersedes the
  gated "add a `Phase` column to §6" design, H6): the checker derives phase
  membership from THIS section's own `Files:` lists, not a redundant column
  on §6.** §6b's per-phase bullets already enumerate every file each phase
  touches — that is the exhaustive, single source; a parallel column on §6
  would be a second copy of the same fact, exactly the "two copies of one
  contract" shape this plan corrects everywhere else (D2b/M2's own fix). §6
  stays the flat aggregate view; `--phases` scoping reads §6b directly.
  Files: `scripts/plan-file-coverage-check.mjs` (create),
  `tests/plan-file-coverage-check.test.mjs` (create),
  `docs/plans/comparison-tooling-consolidation.md` (this plan — this
  refinement note).
- **Phase 1 — Kill the defect class (D1).** **Creates `scripts/lib/bakeoff/scope.mjs`**
  — the pure `ResolvedScope` shape, `assertResolvedScope`, `assertScopeMatches`,
  `UnresolvedScopeError`, `ScopeMismatchError`. The four readers (still in the
  CLI at this point) take a `ResolvedScope` whole and import their validation
  from it; delete `defaultArms`/`defaultExpectedScope`/`_resetDefaultArms`;
  `resolveArms` refuses with no campaign; `LEGACY_ARMS` moves to the test
  fixture. **Discovered during implementation**: two OTHER test files call the
  same re-signatured functions (`selectRetryArmIds`, `aggregateMatched`) with
  the old loose-parameter convention — `tests/bakeoff-per-arm-retry.test.mjs`
  (a hand-built `{arms, expectedScope}` object with no `campaignId`, which
  `assertResolvedScope` now correctly refuses) and `tests/cross-model-
  buckets.test.mjs` (`aggregateMatched` called with no scope argument at all,
  now mandatory). Both are fixed in place with a `createResolvedScope`
  fixture — not scope creep, but the load-bearing consequence D1 always
  implied: EVERY caller of a re-signatured function must be found, not just
  the ones already listed. Files: `scripts/lib/bakeoff/scope.mjs` (create),
  `scripts/bakeoff-collect.mjs`, `tests/final-review-bakeoff.test.mjs`,
  `tests/bakeoff-arms.test.mjs` (create), `tests/bakeoff-summary.test.mjs` (create),
  `tests/bakeoff-per-arm-retry.test.mjs`, `tests/cross-model-buckets.test.mjs`.

  > **Why `scope.mjs` is created HERE and not in Phase 2 (R3/H1).** Cluster A
  > claims to be independently shippable *and* to deliver the D1 architecture,
  > but the R2 draft had Phase 2 create `scope.mjs` — so Phase 1 would have had
  > to host scope validation temporarily in the CLI and move it one phase later,
  > contradicting D1's own statement that `scope.mjs` canonically owns it.
  > `scope.mjs` is pure and imports nothing, so it has no reason to wait for the
  > decomposition: it is the *definition* D1 needs, not part of the relocation.

- **Phase 1′ — Arm-set invariant + telemetry honesty (D1c, D6). NEW, ungated.**
  Same commit range as Phase 1, same files (see Cluster A′'s ordering argument).
  Replace the `opus`/`kimi`/`solo-opus` literals at `bakeoff-collect.mjs:860-889`
  with `scope.arms`-derived tallies; **delete `primaryTotal`** (dead — written
  twice, read nowhere); make `primaryDivergence` count unpaired snapshots the
  way `opusDivergence` already does; make the renderer print `—` rather than
  `0.0` for an aggregate over zero observations. Add the derived-set invariant
  (n ∈ {1, 2, 6}) and the per-aggregate "no silent zero" assertions.
  **Also derives `PROVIDER_TERMS` from the declared arms' model strings**
  (keeping the static residue and the deliberate `meta` exclusion), so adding an
  arm cannot silently degrade adjudication blinding. This is ADDITIVE to the
  existing hand-maintained `PROVIDER_TERMS` vocabulary, never a replacement for
  it — `resolveProviderIdentity`/`PROVIDER_ALIASES`/`armRedactionTerms` close
  the gap for a vendor that vocabulary has never heard of, fail-closed (an
  arm with no resolvable provider and no `redactionTerms` override refuses to
  build the redactor at all). `redactionTerms` is a new optional field on
  `ArmSchema` (`scripts/lib/comparison/arms.mjs`) per D1c's own design —
  `buildModelRedactor`'s signature changes from loose `{armIds, armModels}` to
  `{arms}`, so its one production caller (`scripts/campaign.mjs`'s
  `adjudicate` command) is updated in the same commit.
  Files: `scripts/bakeoff-collect.mjs`, `scripts/lib/store/campaign.mjs`,
  `scripts/campaign.mjs`, `scripts/lib/comparison/arms.mjs`,
  `tests/bakeoff-summary.test.mjs`, `tests/campaign-adjudication.test.mjs`.

- **Phase 2 — Decompose `bakeoff-collect.mjs` (D2/D2a).** The **remaining five**
  bakeoff modules (`arms`, `log`, `spawn`, `summary`, `progress` — `scope.mjs`
  already exists from Phase 1, so D2's six modules are 1 + 5, not 5); entry
  point reduced to argv + dispatch (1494 → 424 lines).
  **Three necessary deviations from pure relocation, all forced by the D2a
  boundary itself (discovered during implementation) — each documented in
  the moved module's own file, not repeated here**: (1) `spawn.mjs`'s
  `runArm` returns the raw spawn outcome only (`{ok, outPath}` /
  `{error}`), never calling `readArmResult` itself, since `spawn.mjs` cannot
  import `summary.mjs` — the entry point composes the two; (2)
  `summary.mjs`'s `entriesToSpendSnapshots` takes a `ResolvedScope`
  directly (was `declaredArms`) and calls `isComplete(e, scope)`, since it
  cannot import `bakeoff/arms.mjs`'s `scopeForEntry`; (3) `progress.mjs`'s
  `printProgress` takes an already-resolved `{ok, scope}`/`{ok:false,
  message}` outcome, never a raw campaign id, for the same reason — the
  entry point now resolves once via `resolveArms` and reuses the result
  rather than the old code's redundant re-resolution on the
  post-collection call site. `LEGACY_ARMS` completes its Phase-1-started
  move: no longer even exported from `bakeoff-collect.mjs`, inlined as a
  literal fixture in `tests/bakeoff-arms.test.mjs`.
  **Also, discovered during implementation: `scripts/campaign.mjs`'s own
  pre-existing `resolveArms`/`readLog` import (one entry point importing
  another) redirects to the new lib modules directly, and a latent bug is
  fixed in the same pass — `loadCampaign()` still read the pre-D1 shape of
  `resolveArms`'s return value, silently undefined since Phase 1 changed
  it, dead code today only because nothing consumed that field, but fixed
  rather than left latent.** `buildArmArgs`'s own test block moves from
  `tests/final-review-bakeoff.test.mjs` into a new `tests/bakeoff-
  spawn.test.mjs` in this SAME phase — never split a test from its own
  implementation across a phase boundary (superseding the D3 matrix's
  original "Phase 4" placement, which assumed the function would still be
  entry-point-local at that point; see the D3 section's own revised note).
  Files: `scripts/lib/bakeoff/arms.mjs` (create),
  `scripts/lib/bakeoff/log.mjs` (create), `scripts/lib/bakeoff/spawn.mjs`
  (create), `scripts/lib/bakeoff/summary.mjs` (create),
  `scripts/lib/bakeoff/progress.mjs` (create),
  `scripts/lib/bakeoff/module-contract.mjs` (create),
  `tests/bakeoff-module-contract.test.mjs` (create),
  `tests/bakeoff-spawn.test.mjs` (create), `scripts/bakeoff-collect.mjs`
  (modify), `scripts/campaign.mjs` (modify), `.audit-loop/domain-map.json`
  (modify). **Also (cross-phase, self-dogfooding fix — see the note above
  this bullet's OWN prose tripped this exact hazard twice)**:
  `scripts/plan-file-coverage-check.mjs` (modify — Phase 0's path-detection
  heuristic tightened from "contains a dot" to "contains a slash or a
  recognised file extension", after a backtick-quoted property-access
  expression inside this very bullet's explanatory prose was mistaken for a
  phantom missing file), `tests/plan-file-coverage-check.test.mjs` (modify
  — regression coverage for the fix).
- **Phase 3 — Decompose `campaign.mjs` (D2/D2a).** Three modules; same shape
  (1350 → 703 lines). `repoId()` — `campaign.mjs`-local but pure
  lib-composition — moves alongside `promoteFromLog` (which needs it and
  `promote.mjs` may not import the CLI to get it back); the CLI's remaining
  caller (`verbDeclareInconclusive`) imports it from there.
  **One necessary deviation, the SAME class of fix D2b's own text already
  states for this exact module**: `promoteFromLog` takes `entries` as a
  parameter (never `readLog()` internally — D2b's documented fix for the
  cycle this decomposition would otherwise introduce) and no longer prints
  the cloud-off notice itself (`cloudOffNotice` is a CLI-flavoured helper
  with several other callers in `campaign.mjs`; importing it here would be
  the exact "lib module reaching back into the entry point" edge D2 exists
  to eliminate) — it returns `{cloud:false}` and `verbReconcile` renders it,
  same as every other verb.
  **§D1b's legacy-adoption receipt protocol is DEFERRED to "Out of Scope
  (Future)" (re-prioritisation, not a technical blocker)** — round-4
  findings H3/H4/M12 found the feature designed in an earlier gate round but
  never assigned a Files line, and this plan's own text briefly scheduled
  its implementation into Phases 2/3 during that triage. On reaching this
  phase, implementing a genuinely new feature (idempotent receipt writes,
  conflict-on-mismatch detection, a new `--adopt-legacy` flag, log-fold
  logic, and their own test coverage) on top of an already-large D2
  decomposition was reprioritised against `/cycle --autonomous`'s
  scope-and-ship mandate: D1's "no campaign, no run" behaviour is already
  correct and complete without it — a pre-campaign log entry stays
  correctly `unjudgeable` (D1a), which is honest, not broken. See §"Out of
  Scope (Future)" below. Files: `scripts/lib/campaign/adjudicate.mjs`
  (create), `scripts/lib/campaign/cited-source.mjs` (create),
  `scripts/lib/campaign/promote.mjs` (create), `scripts/campaign.mjs`
  (modify), `tests/campaign-adjudication.test.mjs` (extended — the D1c
  redaction canaries only; no receipt-protocol tests, since the feature
  itself is deferred), `tests/campaign-citation-budget.test.mjs` (modify —
  import redirect only, since `centredWindow`/`resolveCitedSources` now live
  in the cited-source module above).
- **Phase 4 — Split the campaign suite (D3).** Verbatim assertion moves, per
  the matrix. **Neither `tests/bakeoff-arms.test.mjs`/`tests/bakeoff-
  summary.test.mjs` NOR `tests/bakeoff-spawn.test.mjs` are touched here** —
  all three were already fully populated in Phases 1/2 (round-4 finding
  M5/M6/M7; see the D3 matrix's revised split note above, and Phase 2's own
  Files line — `buildArmArgs`'s tests moved in the SAME commit that moved
  `buildArmArgs` itself into `scripts/lib/bakeoff/spawn.mjs`, never split
  across a phase boundary from its own implementation). This phase creates
  only the three NEW campaign test files. Files:
  `tests/campaign-adjudicate.test.mjs` (create — blind DTO, redaction canary,
  worksheet identity, calibration sample, verdict, self_family, clustering),
  `tests/campaign-cited-source.test.mjs` (create — cited sources),
  `tests/campaign-promote.test.mjs` (create — receipt filename parsing,
  bake-off log promotion, --force resolution, isArmRetried),
  `scripts/bakeoff-collect.mjs` (modify — removed the now-dead
  `UnresolvedScopeError`/`ScopeMismatchError`/`EXPERIMENT_TAG`/`buildArmArgs`
  re-export barrel; every consumer already imports these directly from their
  real homes, verified by grep before deletion — the barrel's removal is this
  phase's exit condition per D3),
  `tests/final-review-bakeoff.test.mjs` (**already retains only 2
  entry-point blocks, not the 3 this bullet originally named** —
  `findEligibleTranscripts`, `assessWindow`; `verifyPreflightArtifact` moved
  to `tests/bakeoff-spawn.test.mjs` in Phase 2, earlier than this bullet
  assumed, per the same "moves with its implementation" rule documented in
  that file's own header — stale prose fixed here, not a new move; the file
  itself is not touched in this phase),
  `tests/campaign-adjudication.test.mjs`
  (modify — retains the LIVE DB-gated block **plus** the D1c
  `resolveProviderIdentity`/`armRedactionTerms` block, which is not part of
  the original D3 matrix (added by Cluster A after D3 was written) and tests
  the store's own campaign module directly (scripts/lib/store/campaign.mjs,
  already in this cluster's derived scope via Phase 1′) rather than any of
  the three new campaign/* modules, so it stays here rather than being forced
  into a file whose module boundary it does not share).
- **Phase 5 — Split `model-eval-core.test.mjs` (D3, independent).** Files:
  `tests/model-eval-core.test.mjs` (**delete** — "modify" in §6's flat table
  undersold it: after all 8 `describe` blocks move out per the D3 matrix,
  lines 1-14 are bare imports with nothing left to import them, so a
  near-empty shell is worse than no file), `tests/model-eval-verdict.test.mjs`
  (create — also imports parseThresholdConfig from the config schema module
  (scripts/lib/model-eval/config/schema.mjs) for a boundary-consistency test
  that cross-checks the verdict module's own schema against it),
  `tests/model-eval-route-catalog.test.mjs` (create — also imports
  VerdictInputSchema from the verdict module (scripts/lib/model-eval/verdict.mjs)
  for the same reason, in reverse),
  `tests/model-eval-deterministic-scorer.test.mjs` (create),
  `tests/model-eval-structured-extractor.test.mjs` (create),
  `tests/model-eval-cost.test.mjs` (create),
  `tests/model-eval-config-schema.test.mjs` (create),
  `tests/model-eval-store.test.mjs` (create). **Plus (revision)**:
  convert the live-config-pinning assertions to frozen fixtures, following
  `tests/comparison-core.test.mjs`'s existing pattern.
  **Relocated during Phase 1 (post-gate correction, round-4 finding M19):**
  these assertions no longer live in `tests/final-review-bakeoff.test.mjs` —
  Phase 1 moved `deriveArms`/`transportForModel`/`resolveArms`/collect-time-
  lock coverage to `tests/bakeoff-arms.test.mjs` (see Phase 1's own Files
  line), earlier than this bullet originally assumed, so the target is now
  `tests/bakeoff-arms.test.mjs`'s `'the derived arms are BYTE-IDENTICAL…'`,
  `'the control arm is COLLECTED but not scored…'`, and `'derives from the
  NEW scoped campaign…'` tests (the ones asserting live committed-campaign
  file content directly) — named by title, not by line, since the file did
  not exist at plan-gate time to pin a commit-anchored line against.
- **Phase 6 — Role executability (D7a–c). NEW, ungated.** Lift the 8 hardcoded
  `'auditor'` literals in `model-eval-auditor.mjs` into a role parameter;
  extract `runManifestDriver` to `lib/model-eval/manifest-driver.mjs` and
  `scoreAgainstGroundTruth`/`toRawContext` to
  `lib/model-eval/adjudicator-executor.mjs` (round-3 fix, H2 — layering);
  add the `adjudicator` controls schema to `controls.mjs` and admit it in
  `manifest.mjs`; create the `EXECUTORS` registry
  (`lib/model-eval/executors.mjs`, two-phase `prepareContext`/`executeArm`
  per the Gemini-gate fix, G1) so the manifest driver can run n adjudicator
  arms. Files: `scripts/model-eval-auditor.mjs` (modify — thin shim),
  `scripts/model-eval-adjudicator.mjs` (modify — thin CLI wrapper, also gains
  its own --manifest flag),
  `scripts/lib/model-eval/manifest-driver.mjs` (create),
  `scripts/lib/model-eval/adjudicator-executor.mjs` (create),
  `scripts/lib/model-eval/executors.mjs` (create),
  `scripts/lib/comparison/controls.mjs` (modify),
  `tests/comparison-core.test.mjs` (modify),
  `tests/manifest-driver.test.mjs` (create),
  `tests/adjudicator-executor.test.mjs` (create),
  `tests/model-eval-adjudicator-manifest.test.mjs` (create),
  `tests/model-eval-auditor-manifest.test.mjs` (modify — the role-generic
  driver's refusal message changed from a hardcoded 'role must be "auditor"'
  to a registry-derived one; the test's own assertion updated to match, same
  refuse-at-load/exit-2 behaviour unchanged),
  `tests/arm-vocabulary-layering.test.mjs` (modify — round-4 gate finding:
  `git ls-files` lists a working-tree-deleted-but-unstaged file (this phase's
  own `tests/model-eval-core.test.mjs` deletion, Phase 5), and
  dependency-cruiser's stat() on a listed-but-absent path crashed the whole
  layering oracle rather than reporting a violation; `trackedMjs()` now
  filters to paths that still exist on disk — a general robustness fix this
  cluster's own deletion surfaced, not specific to model-eval-core.test.mjs).
  (the comparison manifest-schema module needed NO change — its v1-boundary
  refusal is entirely derived from controls.mjs, verified before editing;
  see §6's own corrected row.)
- **Phase 7 — The store-seam decision (D7d/D7e). NEW, ungated. A BOUNDED
  DISCOVERY DELIVERABLE, never a migration (post-gate fix, H2).** Run D7e's
  field census: enumerate every field the campaign standings, the swap-eval
  verdict and the dashboard collector each read; classify each as shared-core /
  passive-only / synchronous-only; apply D7e's rule. **UNIFY** if every field
  classifies cleanly; **KEEP SEPARATE** only if a field is required by both
  modes with incompatible semantics — and that field must be named. Record the
  census in this plan regardless of verdict. **Output is one of two things,
  never a schema change on this branch**: on UNIFY, a filed follow-up plan
  (scoped to migration, its own `/audit-plan` gate, own schema/backfill/
  rollback/dashboard scope); on KEEP SEPARATE, a documented field-level
  interface contract plus a `comparison-core.test.mjs` assertion that the two
  envelopes' shared fields stay comparable. Predicted outcome is UNIFY,
  recorded in advance so the census can falsify it. **No `scripts/lib/store/**`
  file is a Phase 7 file under either branch.** Files:
  `docs/plans/comparison-tooling-consolidation.md` (modify — census + verdict
  + ADR, unconditional), `tests/comparison-core.test.mjs`
  `[branch: d7d=keep-separate]` (modify — only when the verdict is KEEP
  SEPARATE; absent from the diff on the UNIFY branch, correctly).
- **Close-out — the executable list, in order (R4/M2).** The R3 draft named the
  right *ordering* in §6a and then omitted most of those commands here, leaving
  a team to reconcile a ledger against a shorter checklist. They now match:

  **The extraction file list is DERIVED, not hand-maintained (post-gate fix,
  H3).** A hand-typed `--files` list is exactly the class of defect this plan
  exists to eliminate — the round-1 gate found it had already happened once:
  the list omitted `scripts/lib/store/campaign.mjs` (Phase 1′'s
  `PROVIDER_TERMS` edit) and all three Phase 6 files
  (`model-eval-auditor.mjs`, `comparison/controls.mjs`, `comparison/manifest.mjs`).
  Reconciling against a narrowed extraction commits a ledger that does not
  cover every changed invariant-bearing file, silently.

  **Two DIFFERENT derived sets, over the SAME diff, in sequence — never one set
  doing both jobs (post-gate fix, H4).** The round-2 gate correctly found that
  a single `scripts/**/*.mjs`-only `CHANGED` set cannot ALSO validate against
  §6's table, because that table lists 7+ test files, this plan document, and
  `.audit-loop/domain-map.json` — none of which a `.mjs`-only filter admits.
  Checking coverage and deriving the extraction subset are two different
  questions asked of two different projections of one diff:

  ```bash
  npm run arch:refresh            # retag moved symbols (Class A)
  npm run arch:coverage-gate      # its freshness gate

  # ONE full diff — every tracked file category, no filter. `PLAN_BASE` is
  # this plan's own starting commit. `D` is INCLUDED (round-4 finding M17):
  # ACMR alone drops deleted paths, so a phase whose Files: line names a file
  # under `(delete)` (Cluster C's test-file consolidation, Phase 7's UNIFY
  # branch) would never see that deletion counted as coverage — the required
  # path just silently never appears in `$FULL_DIFF` and `checkCoverage`
  # reports it missing instead of confirming the deletion happened.
  FULL_DIFF=$(git diff --name-only --diff-filter=ACMRD "$PLAN_BASE"...HEAD)

  # STEP 1 — coverage, over the FULL diff against §6's table, SCOPED to the
  # phases actually completed (round-3 fix, H6 — the unscoped version would
  # refuse §9's own independently-shippable A/A′-only release). Fails on
  # either-side-only entries WITHIN that scope: a file in the diff but not the
  # table, or an in-scope mandatory row not in the diff. `--phases` is the
  # completed-phase list for THIS release (all 9 for a full-plan close-out);
  # `--branch` still narrows Phase 7's two mutually exclusive rows within it.
  node scripts/plan-file-coverage-check.mjs \
    --plan docs/plans/comparison-tooling-consolidation.md \
    --diff "$FULL_DIFF" \
    --phases "<comma-separated completed phases, e.g. 0,1,1′ for an A+A′-only release>" \
    --branch "d7d=<unify|keep-separate|not-yet-decided>"   # only meaningful once phase 7 is in --phases

  # STEP 2 — ONLY AFTER STEP 1 SUCCEEDS, derive the requirements-extraction
  # SUBSET (source .mjs, never test files) from the SAME validated diff.
  # This is a narrowing filter on an already-verified-complete set, not a
  # second independent derivation — coverage is proven before extraction ever
  # sees a file list.
  EXTRACT_SET=$(printf '%s\n' "$FULL_DIFF" | grep -E '^scripts/.*\.mjs$' | grep -v '\.test\.mjs$')

  node scripts/requirements.mjs extract --files "$EXTRACT_SET"
  node scripts/requirements.mjs reconcile        # → .requirements/ledger.json (Class B)
  npm run requirements:map && npm run requirements:map:check
  npm run skills:regenerate && npm run skills:check      # expected: no-op, asserted
  npm run plans:index && npm run plans:index:check
  npm run db:enrolment:gate
  npm test                        # includes arm-vocabulary-layering
  npm run check
  ```

  > **`scripts/plan-file-coverage-check.mjs` does not exist yet — creating it is
  > in-scope for Phase 0, not a close-out-time surprise.** It is a small,
  > reusable script: diff the supplied file list against every `modify`/
  > `create` row in a plan's §6 File-Level Plan table; a row tagged with a
  > `branch:` qualifier (Phase 7's two rows) is required only when
  > `--branch` names it as taken, optional-and-ignored otherwise; fail on any
  > unqualified either-side-only entry. Small enough to be worth having for
  > every future plan's close-out, not just this one — the argument encoding
  > (`--diff`, `--branch key=value`) and the branch-qualifier row syntax are
  > BOTH Phase 0 deliverables, specified now rather than improvised at
  > close-out time. Files: `scripts/plan-file-coverage-check.mjs` (create),
  > `tests/plan-file-coverage-check.test.mjs` (create) — with a required test
  > case for the Phase-7-branch-row scenario specifically, since that is the
  > one case a naive "every row is mandatory" implementation gets wrong.

  **The checker as specified above would REFUSE the plan's own §9 truncation
  order (round-3 gate, H6) — a real self-contradiction, not a hypothetical
  one.** §9 says Cluster A/A′ ships independently and Clusters B/C/D may be
  dropped. An A-only release's diff necessarily omits every Phase 2–7 row, and
  the "fail on any unqualified either-side-only entry" rule above admits no
  concept of "this row belongs to a cluster that was never in scope" — it
  would refuse the exact partial release §9 recommends as a valid outcome.

  **The fix is a fourth Phase 0 deliverable, not a new subsystem — and,
  refined during implementation, not a redundant table column either.**
  §6b's own per-phase `Files:` lists already name every file each phase
  touches (every row resolves to exactly one phase — the partition-check
  already asserts every phase belongs to exactly one cluster), so the checker
  derives phase membership by parsing §6b directly rather than requiring a
  second, parallel `Phase` column on §6 that would need to agree with it
  forever. The checker takes **`--phases <completed-phase-list>`** (e.g.
  `0,1,1′` for an A+A′-only release) instead of assuming the whole table is
  mandatory: a file is **required** iff its owning phase (per §6b) is in the
  supplied list, **forbidden** (diff contains it, list doesn't cover it) iff
  its phase is absent from the list, and the `--branch` qualifier from before
  still narrows Phase 7's two rows within whichever list includes phase 7.
  The all-clusters invocation (`--phases 0,1,1′,2,3,4,5,6,7`) is simply the
  full-list case — no separate mode, one mechanism.

  Required Phase 0 test cases, beyond the Phase-7-branch-row one already
  specified: an A-only release (`--phases 0,1`) passes; the same diff
  evaluated with `--phases 0,1,1′,2,3,4,5,6,7` (i.e., claiming full-plan
  completion against a partial diff) correctly FAILS — proving the checker
  cannot be fooled into
  certifying more than what actually shipped.

  **`scripts/plan-file-coverage-check.mjs` is a NEW top-level CLI, so it
  carries the repo's standard CLI contract (round-3 gate, H7) — this was
  simply omitted, not a judgement call**: `--selfcheck-relocation` (the
  established `if (process.argv.includes('--selfcheck-relocation')) {
  console.log('OK'); process.exit(0); }` guard at the head of `main()`, per
  every other CLI in `CLI_SMOKE_SET`); `assertKnownFlags` over
  `{--plan, --diff, --phases, --branch}` so a typo'd flag refuses rather than
  silently no-ops; and the standard `emit`/non-zero-exit envelope
  (`cli-io.mjs`) for both success and failure output, never a bare
  `console.log`. Required Phase 0 tests, additive to the ones already
  specified: `--selfcheck-relocation` prints `OK` and exits 0; an unknown
  flag refuses via `assertKnownFlags`; a missing/malformed `--plan` or
  `--diff` fails with a named reason, not a stack trace; an invalid `--branch`
  or `--phases` value fails the same way.

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
| **NEW — the plan grew after its own gate, which is how a gated artifact becomes an ungated one wearing a gate's badge.** | The gate table names precisely which decisions carry the 32/32 and which do not, and every new section is banner-marked `NEW — ungated`. **`/audit-plan` must run again before Cluster A′ or D is executed** — the original gate cannot vouch for text it never saw. Clusters A/B/C as originally written are unaffected and may proceed on the existing gate. |
| **NEW — Cluster D adds a third role to schemas two roles currently share.** A regression here breaks `auditor` (live) or `final_review_shadow` (live, spend-bearing) while adding `adjudicator` (never run). | D7a is a pure parameter lift with the existing suite as its control. D7b adds a *new key* to `CONTROLS_BY_ROLE` rather than altering existing ones — `SUPPORTED_ROLES` is derived, so the blast radius is assertable. `assertRoleCoverage` already fails closed on a role with no owning mechanism, and `tests/comparison-controls-parity.test.mjs` already asserts the two live roles' rules independently. |
| **NEW — the vendor-blinding list is a second hardcoded table** (`PROVIDER_TERMS`). An arm from an unlisted vendor leaks its vendor name into a blind adjudication payload. | **Moved INTO Cluster A′** (D1c) on reflection — an earlier draft filed it with D7, which was wrong: it is the sharpest violation of D1c's own "adding an arm is one edit" invariant, and it is the one violation that *silently corrupts evidence* rather than merely miscounting. Derive the terms from the declared arms' model strings; keep the hand-won static residue (including the deliberate `meta` exclusion). Mitigating context, not an excuse: `armIds`/`armModels` are already redacted dynamically, so the leak is the *vendor word*, not the arm identity. |
| **NEW — D7d could be decided post-hoc to fit whatever the evidence makes cheap.** | **D7e pre-registers the decision rule and the predicted outcome (UNIFY) before the evidence exists**, and requires a "keep separate" verdict to NAME its blocking field. A conclusion that cannot name one is a failed analysis, not a valid outcome. This is the same discipline the campaign's own decision rule and stopping rule already carry. |

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

**`promoteFromLog`'s exit rule gets its own mixed-batch matrix (post-gate fix,
H4)**, since the exit-code ambiguity the round-1 gate found is precisely a case
where single-condition tests can each pass while the exhaustive rule is still
wrong:

| Batch composition | `PromotionResult` shape | Exit code |
|---|---|---|
| all modern, all promote clean | `promoted: [n], skippedUnjudgeable: [], failedJudgeable: []` | 0 |
| modern + legacy, no `campaignId` (reason `no-campaign-id`), no failures | `promoted: [n], skippedUnjudgeable: [m], failedJudgeable: []` | **0** — this is the exact case the ambiguity risked getting wrong |
| modern + an entry whose **declared** `campaignId` is now unresolvable (reason `campaign-unresolvable`) | `skippedUnjudgeable: [1]` | **0 — corrected (round-3 gate, H5)**: an unresolvable campaign is `unjudgeable` per D1a's own rule (both reason codes share the bucket), NOT a write failure. A round-2 draft mislabeled this row as `failedJudgeable`, directly contradicting D1a's own text two sections earlier. |
| modern + a JUDGEABLE entry (resolvable campaign, correct shape) that errors on the actual write | `failedJudgeable: [1]` | 1 — the real write-failure case the row above was wrongly standing in for |
| ALL entries unjudgeable, zero promoted | `promoted: [], skippedUnjudgeable: [n], failedJudgeable: []` | **0** — the permanent-DoS case D1a's prose forbids, asserted directly |
| mixed, with `--adopt-legacy --campaign X` reinterpreting some of the legacy group | adopted entries move from `skippedUnjudgeable` to `promoted`, AND an adoption receipt is appended to the log | 0 (if no failures) — **corrected (Gemini gate, G1): the STORE row is durable; the SOURCE LOG is not, unless a receipt says so.** The round-3 "durable write" claim was false as written — `promoteFromLog`'s write goes to the STORE, but `.audit/bakeoff-log.jsonl` itself is never rewritten, so a re-run WITHOUT `--adopt-legacy` reads the exact same `campaignId: null` entries again. See D1b's fix below for the actual mechanism. |
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

### D1c/D6 — why NOT golden files (NEW — ungated)

The instinct for "make sure the arms fire and the telemetry is right" is a
golden fixture. It is the wrong instrument here, for a reason this plan has
already had to learn twice:

- **A golden pins one arm set**, so it must be hand-edited on every arm change.
  An edited golden proves that someone edited it. `tests/final-review-bakeoff.test.mjs:688`
  is exactly this failure already — it pins the complete 6-arm set against a
  *mutable* config, and a 7th arm breaks it with no defect present.
- **A golden over telemetry pins the numbers**, which are legitimately different
  every run. It would either be so loose it asserts nothing, or so tight it
  fails on noise.

The two replacements assert *properties*, so adding an arm changes input and
expectation together and neither test needs editing:

| Concern | Instrument | Why it cannot go stale |
|---|---|---|
| Do the right arms fire? | **Derived-set invariant** — the iterated key set equals `ids(scope.arms)`, checked at n ∈ {1, 2, 6} | Both sides derive from the same scope; there is no literal to update |
| Is the telemetry honest? | **No-silent-zero, per aggregate** — an aggregate over zero observations is `unknown`/absent, and its non-observation count travels beside it | Asserts a *shape* (a number vs. an absence), not a value |

**Both must be seen to fail first.** Written against pre-fix code, the
derived-set invariant fails on incident (c) and on `:860-889`; the no-silent-zero
assertion fails on `primaryDivergence`'s `[0,0]`. Red-then-green, one defect at a
time — and the negative control already exists in the same function
(`opusDivergence` correctly reports `[] / unpaired: 2` on identical data), so the
assertion has a proven-correct sibling to be measured against rather than a
hand-written expectation.

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
- **Cluster A′** — Phase 1′ (D1c + D6) — fix-gate: yes — **NEW, ungated**
  - **Runs WITH Cluster A, in the same commit range, not after it.** The
    hardcoded readouts (`:860-889`) and the fabricated divergence live *inside*
    `summarise`, which is the same function D1 re-signatures and which Cluster B
    then **moves** to `bakeoff/summary.mjs`. Three orderings were considered:
    fix-then-move touches every line twice; move-then-fix decomposes code known
    to be wrong and then rewrites it in its new home, defeating B's
    "bodies move verbatim" safety argument; **fix-with-A is the only ordering
    where each line is written once.**
  - Independently shippable *with* A. Its own defect (D6's fabricated metric) is
    live and operator-visible today.
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
  - **Added by the revision**: C also converts D3's live-config-pinning
    assertions to frozen fixtures — `tests/final-review-bakeoff.test.mjs:688`
    pins the complete 6-arm set against the *mutable committed campaign*, so a
    7th arm breaks it. `tests/comparison-core.test.mjs` already models the
    correct pattern (frozen `HISTORICAL_SUBSET` + assert the live config
    *differs*); this is copying it, not inventing it.
- **Cluster D** — Phases 6–7 (D7a–d, role executability) — fix-gate: yes — **NEW, ungated**
  - Coupling and **why it is last**: D7a lifts a role parameter through
    `model-eval-auditor.mjs`, and D7b/c add a third role to `controls.mjs` /
    `manifest.mjs`. Both are far cheaper against **decomposed** modules than
    against a 1435-line entry point — and adding a third role to a machine that
    can still silently substitute an arm set (pre-A) would be building on the
    exact defect A exists to remove. **D depends on A and B; it does not depend
    on C.**
  - D7d/D7e is a **decision gate, not an implementation phase**, and its rule is
    **pre-registered in D7e** rather than settled on the day. It consumes the
    evidence D7a–c produce, applies a fixed classification test, and must NAME a
    blocking field to conclude "keep separate". The predicted outcome (UNIFY) is
    recorded in advance so the census can falsify it.
- **Final gate**: mandatory consolidated Gemini review over the union diff A–D.

**Partition check** (the property `/cycle` re-validates at execution time, and
the one the revision most easily breaks): the nine phases are 0, 1, 1′, 2, 3, 4,
5, 6, 7. Cluster A owns 0–1; A′ owns 1′; B owns 2–3; C owns 4–5; D owns 6–7.
**Every phase is in exactly one cluster; none is omitted or duplicated; the
ranges are contiguous and ascending.** Clusters are named by *phase*, not by
decision id, because that is what makes the block machine-derivable — a
decision-labelled cluster has no `Files:` to resolve scope from.

### Truncation order (what to drop if this is cut short)

Stated explicitly because four clusters is more than one sitting, and an
abandoned middle is worse than an abandoned tail:

| Drop | Cost of dropping |
|---|---|
| **Cluster D** first | No live defect goes unfixed. `adjudicator` stays unrunnable — which is its status today, so this is status quo, not a regression. |
| **Cluster C** next | Test-file size debt persists; the fragile `:688` assertion stays fragile. No production behaviour affected. |
| **Cluster B** next | The two CLIs stay outliers. The *defects* are already fixed by A/A′; only reviewability is lost — which is the property this plan argues matters, but it is not a correctness loss. |
| **A + A′** | **Never drop.** Two live defects (incident (c), the fabricated divergence metric), both operator-visible, both currently growing with arm count. |

**A and A′ together are the minimum shippable unit of this plan.**

## Out of Scope (Future)

**§D1b — the legacy-adoption receipt protocol (`--adopt-legacy`).** Designed
in an earlier gate round (the append-only `{type:'adoption-receipt', entryId,
campaignId, adoptedAt}` record, idempotent on the tuple `(entryId,
campaignId)` — a conflicting receipt for the same entry under a different
campaignId is refused, never a silent no-op) but never assigned a Files line
in §6b, so it shipped as prose with no implementation phase (round-4 findings
H3/H4/M12). Phase 3's own text briefly scheduled it into Phases 2/3 during
that triage; on actually reaching those phases, building a genuinely new
feature (idempotent writes, conflict detection, a new CLI flag, log-fold
logic, and its own test coverage) on top of an already-large D2 decomposition
was reprioritised out, in favour of shipping the decomposition itself.

**Independence, stated per the triage rule (AGENTS.md, `/audit-plan` Step 3):
this plan's correctness does not rest on §D1b.** D1's "no campaign, no run"
behaviour is already correct and complete without it — a pre-campaign log
entry (no `campaignId`, predating campaign declaration) stays correctly
`unjudgeable` (D1a), which is honest, not broken; it simply never counts
toward N and is never silently adopted. §D1b is a pure operator-convenience
feature for RE-INTERPRETING that already-honest state, not a fix for an
incorrect one.

**Revisit trigger**: an operator actually wants to adopt a batch of
pre-campaign log entries into a named campaign (this has not yet happened in
practice — every real collection to date has run under a declared campaign
from the start). Implementation: `--adopt-legacy` on `campaign.mjs reconcile`
→ `lib/campaign/promote.mjs` (which already owns `promoteFromLog`, the
natural home for the write half); `scripts/lib/bakeoff/log.mjs` (which
already owns `readLog()`) folds the receipt on read. Both files already
exist post-Phase-2/3, so implementing this later is additive, not a further
decomposition.

## Corrections

**`scripts/lib/model-eval/executors.mjs::auditorExecuteArm` — the
`_controls` provenance claim (2026-08-17).** This plan's Cluster D shipped
the parameter as `_controls` (underscore-prefixed, discarded) with a comment
claiming the gap was pre-existing debt from a "round-5 gate H3/H12" finding,
attributed to the predecessor plan (`role-agnostic-comparison-core.md`). That
citation does not exist: exhaustive grep of this document (every `R5`/`H3`
occurrence — `R5/H1`, `R5/H2`, `R5/H3` [an unrelated `Symbol`-construction
topic], `R5/H4`, `R5/M2` — no `H12` anywhere), `role-agnostic-comparison-
core.md` (round 5: `M4/M5` on xAI-preflight parity; round 6: `H2/H3/H4` on
`verdict.mjs` bugs — nothing matching), and a full scan of
`list-unremediated-acceptances`/`list-unlocked-fixes` across all repos and
ages, found no durable record of this decision anywhere — it existed only as
the source comment, invisible to anyone not reading that exact file (the
class of gap AGENTS.md's "Contracts across the prose↔code seam" section
warns about, generalized from prose→code to comment→ledger). A fresh GPT
audit pass caught the live gap the same day; the actual fix and its full
design history live in
[`docs/plans/auditor-controls-execution-wiring.md`](auditor-controls-execution-wiring.md)
— tracked in a plan document, which survives someone editing or deleting a
source comment, rather than in the comment itself.

---

## Implementation Log

### 2026-08-16

- **Completed**: All four clusters (A/A′, B, C, D) implemented, each audited
  to convergence (in-cluster HIGH/MEDIUM == 0), plus the mandatory
  consolidated Gemini gate over the full union diff — verdict `APPROVE`
  (round 2 of 2; round 1 was `CONCERNS_REMAINING` with 5 wrongly-dismissed
  findings, 2 of which were real and fixed, 3 rebutted with evidence and
  accepted by round 2). Full close-out sequence green (`arch:refresh`,
  `arch:coverage-gate`, `plan-file-coverage-check` at `ok:true`, requirements
  extract/reconcile/map, `skills:regenerate`+check, `plans:index`+check,
  `db:enrolment:gate`, `npm test` 12737/0/26).
- **Remaining**: §D1b (legacy-adoption receipts) formally deferred to
  "Out of Scope (Future)" — this plan's own correctness does not depend on
  it. D7's own scope boundary (auditor/adjudicator manifest-driven parity;
  `final_review_shadow` deliberately stays passive-only) is by design, not a
  gap.
- **Deviations from the plan as gated**:
  - D7e's field census returned **KEEP SEPARATE** (named blocking field:
    `verdict`), falsifying the plan's own pre-registered UNIFY prediction —
    the census is the point; see §"D7e — Phase 7 deliverable" for the full
    field table and reasoning.
  - `scripts/lib/comparison/manifest.mjs` needed **zero** code changes for
    D7b (its v1-boundary refusal is entirely derived from `controls.mjs`) —
    the plan's own "modify" claim was corrected before writing a no-op edit.
  - The `RoleResult`/`ExecutorAttempt` type text was corrected against real
    code in three places (auditor branch is `metrics`, not
    `findings: NormalizedFinding[]`; `recall`/`f1` are nullable; `usage`
    itself is nullable, distinct from a nullable `costUsd` inside it) — none
    of these were grounded in the functions they described when first
    written.
  - Two genuinely new implementation gaps surfaced only during Cluster D's
    own audit (not present in the plan's original design, found by
    implementing it): adjudicator manifest arms were not persisted to
    `model_eval_runs` at all (silently defeating D5a's resume mechanism for
    that role — fixed), and the CLI's `--tier` had no reconciliation against
    a manifest's own declared `controls.tier` (fixed with a fail-closed
    cross-check).
  - Two pre-existing, verbatim-relocated defects were judged in-scope by
    impact (not authorship) and fixed during the consolidated gate's
    deliberation: `readLog()` silently dropped a mid-file JSONL corruption
    exactly like a tolerated torn-final-line (now a visible stderr warning,
    the two cases distinguished); `repoId()`'s catch-all conflated
    cloud-off/unregistered with a real operational failure (now logged
    distinctly).
