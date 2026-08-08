# Plan: Final-Review Shadow Bake-Off (marginal-value re-test)

- **Date**: 2026-07-29
- **Status**: In Progress (activated 2026-07-31 — see §0 Activation Addendum)
- **Author**: Claude + Louis

> ## ⏸ PARKED 2026-07-29 — read this before implementing anything below
>
> This plan is **fully audited and deliberately not being executed.** It passed
> 3 GPT rounds + 2 Gemini rounds with 29/29 findings fixed, and the audit trail
> below is worth keeping. What the audit could not evaluate is whether the plan
> should exist **at this size**.
>
> **The economics are inverted.** The decision under test is worth ~$20–30/month
> (the Opus shadow's run cost). The instrument this plan specifies — six tables,
> migrations, a journaled run lifecycle, a blinded-worksheet tool, a labelled
> calibration corpus with a 0.95 recall pass mark, a 12-row verification matrix
> — is plausibly a week of solo engineering before run 1. Every audit finding was
> individually valid; none of them could ask "is the whole apparatus
> proportionate?" That is this repo's own rigor-pressure failure mode expressed
> as infrastructure instead of findings, and it is exactly the
> band-aid-vs-over-engineering fork AGENTS.md's right-sizing rule names.
>
> **Catch rate is also not the binding constraint.** Only 3 of 10 accepted
> shadow findings ever got a real code fix; 63 were never adjudicated at all;
> `remediation_state` is NULL nearly everywhere. The loop already accepts more
> real defects than it closes, so optimising *which reviewer finds them* improves
> the number that is not the problem.
>
> **What was done instead** (2026-07-29):
> 1. Fix-time attribution + finding-time state capture — extracted as
>    no-regrets work, valuable in ordinary runs regardless of any experiment.
> 2. `FINAL_REVIEW_SHADOW=claude-opus` re-enabled locally. The pre-registered
>    verdict was KEEP and the shadow had drifted OFF; that was drift, not a
>    decision.
> 3. A **zero-code Kimi smoke test**, which the §3.1-style investigation showed
>    was already possible: the `openrouter` descriptor
>    ([gemini-review.mjs:891](../../scripts/gemini-review.mjs)) already carries
>    the mandated `require_parameters`/`sort`/`reasoning.effort` pins. Result on
>    this plan's own transcript: Kimi K2-thinking produced a parseable CONCERNS
>    verdict in 92s for **~$0.044** (vs Gemini ~$0.15, Opus ~$1.45), correctly
>    comprehended the deliberation, and raised 3 findings — but **zero overlap**
>    with Gemini's 3, and all of its were "specify X more precisely" rather than
>    consistency/logic defects. Viable reviewer; different kind of output.
>
> **Un-park trigger**: the cheap path produces a genuine surprise — e.g. a
> switched-to-cheap shadow visibly missing defects the loop used to catch, or a
> disagreement about marginal value that config-level evidence cannot settle.
> Then this document is how to get an answer that is not confidently wrong.
>
> **Do NOT run this plan with the Phase 0 instrumentation skipped.** That
> recreates the unreadable-tail failure of the closed experiment: you would pay
> for the runs and be unable to trust the numbers. Full instrument or cheap
> smoke — nothing in between.

---

## 0. ACTIVATION ADDENDUM (2026-07-31) — the trigger fired; this is what runs

**Pre-registered before snapshot 2. Snapshot 1's data already existed when this
was written and is declared below rather than discovered — the honest reading of
"pre-registered" here is *the rule was fixed before the data that decides it*,
with the one pre-existing point disclosed.**

### 0.1 Why the trigger fired

The banner's un-park condition was "a disagreement about marginal value that
config-level evidence cannot settle." That is now exactly the state:

- Tail labelling ([`final-review-tail-labelling-2026-07-31.md`](../research/final-review-tail-labelling-2026-07-31.md))
  put Opus at **~1.1 accepted HIGH/MED per run at ~$1.07 each** — no longer the
  "probably noise" that justified parking.
- Kimi has **n=2, zero unique accepted**. Not bad; *unmeasured*.
- The operator question is explicitly permutational — Gemini alone vs +Opus vs
  +Kimi vs Kimi-primary — and no amount of config-level evidence answers it.

### 0.2 What Cluster A already built, so this is now cheap

The parked instrument's cost was the reason for parking. Most of it is done or
no longer needed:

| Parked Phase 0 item | Status now |
|---|---|
| Fix-time attribution write-back | **Built** — `/ship` Step 6.7 + `final-review-{adjudicate,record-fix}` |
| Outcome classification over both axes | **Built** — `classifyFinalReviewOutcome` |
| Blinded worksheet | **Built** — `final-review-stats --worksheet` |
| Six bakeoff tables + migrations | **Not needed** — `audit_findings.bucket` + `source_model` already separate the arms per run |
| Labelled clustering corpus, ≥0.95 recall | **Not needed** — real primary↔shadow overlap measured at **~2%** (1 of 92). Clustering was sized for a problem that does not exist at this base rate; human-glance of same-file pairs suffices |
| Journaled run lifecycle | **Not needed** — no new tables to keep consistent |

**This is the right-sizing the banner demanded, not a skipped instrument.** The
one Phase-0 item that mattered (attribution) exists; the expensive item
(clustering) was justified by an assumed overlap rate that measurement falsified.

### 0.3 Protocol — TWO invocations per snapshot, four arms

Gemini is fixed as primary. Per real final review, on the **same transcript
file**:

1. **Invocation 1 — the real gate**: Gemini primary + **Opus** shadow, with
   `--run-id`. This is today's config; it gates nothing differently.
2. **Invocation 2 — out-of-band**: same transcript, `FINAL_REVIEW_SHADOW=openrouter`
   + `FINAL_REVIEW_SHADOW_MODEL=moonshotai/kimi-k2-thinking`.

Four arms per snapshot: **P₁, P₂** (Gemini sampled twice — the self-shadow arm,
for free), **Opus**, **Kimi**.

The same-snapshot requirement is the whole design. Alternating shadows across
different reviews measures diff difficulty, not models — that was the parked
plan's §3 finding and it still binds.

### 0.4 What each arm answers

| Question | Read as |
|---|---|
| Opus marginal over Gemini | Opus-unique vs P₁, accepted |
| Kimi marginal over Gemini | Kimi-unique vs P₂, accepted |
| **Kimi vs Opus head-to-head** | their unique sets on identical input |
| Gemini vs Kimi as *reviewers* | P findings vs Kimi findings — the quality evidence a Kimi-**primary** decision would need, **without risking the gate** |
| "Is a 2nd reviewer just a reroll?" | P₁ vs P₂ divergence. High → buy a retry loop, not a model |

**Kimi-as-primary is deliberately NOT an arm.** The primary gates builds; it
faces a stricter non-inferiority bar and is a separate decision. Row 4 gives it
evidence for free.

### 0.5 Decision rule — inherited, NOT re-invented

§6.3's ordered table applies unchanged: gate at `marginal ≥ 0.2 accepted
HIGH/MED per run`, ceiling `≤$8 per accepted cluster`, cheapest qualifying arm
wins, `INCONCLUSIVE` if N < 12 or the merged/split sensitivity flips it.

Opus's measured position: **1.1/run at $1.07** — clears both. So the live
questions are narrow: *does Kimi clear 0.2, and what fraction of Opus's 1.1 does
it cover?*

**N = 12 snapshots** (lowered from 15 on 2026-08-03), or a committed end date,
whichever first. Terminates either way — bounded and synchronous, not a third
passive collector.

> **Why 12, and why not 8** (recorded before any result under contract epoch
> `e2` was read — the only point §6.0b permits adjusting N). Per-snapshot cost
> rose: a third arm (`solo-opus`) was added, and matched reasoning effort made
> the OpenRouter arm ~5x slower. 8 was considered and **rejected**: §6.3 row 1
> makes `N < 12` terminal INCONCLUSIVE, so 8 buys a cheaper campaign that
> answers nothing. 12 is the smallest N that still yields a verdict **without
> amending the decision rule** — §0.5's "inherited, NOT re-invented" holds, and
> row 1 is untouched. The reduction saves spend; it adds no confidence, and
> §6.5 applies unchanged.

### 0.6 Snapshot 1 (pre-existing, declared)

Transcript `audit-code-1785428132` (Cluster A code audit, 3 GPT rounds):

| Arm | Result |
|---|---|
| P₁ (gate) | APPROVE, 0 new |
| P₂ (invocation 2's primary) | CONCERNS, 2 |
| Opus shadow | **4 shadow-only** |
| Kimi shadow | **0** |

Two Gemini samples disagreeing 0-vs-2 on identical input is the stochastic-recall
effect visible at n=1. Not evidence yet — one snapshot, and P₁/P₂ divergence is
exactly what arms 1-2 exist to quantify.

### 0.6b How N is tracked — a query, never a tally

**§0.7 below started as a hand-maintained markdown table, and that was a
defect.** Asking "how do we know when we reach 15?" exposed two things:

1. **It rots.** A count the stopping rule depends on, kept current by
   remembering to type it, is the exact mechanism behind this repo's five prior
   false "window met" reads (AGENTS.md, Model Swap-In Evaluation Harness).
2. **The runs were not in the store at all.** A standalone `gemini-review`
   invocation with no `--run-id` has no `audit_runs` row to attach to —
   snapshots 2–3 persisted `final_review_shadow_model = NULL` and zero findings.
   The table was the *only* record, checkable against nothing.

Fixed by making collection itself write the count:

```bash
node scripts/bakeoff-collect.mjs --transcript .audit/bakeoff/t.json --plan docs/plans/final-review-shadow-bakeoff.md --mode plan
node scripts/bakeoff-collect.mjs --progress
```

*(Invoked directly rather than via an `npm run` alias: `package.json` was being
edited by a concurrent session at the time, and adding a script there would have
bundled that session's staged work into this commit. Add the aliases later if
the direct form grates.)*

[`scripts/bakeoff-collect.mjs`](../../scripts/bakeoff-collect.mjs) runs **both
arms** on one transcript and appends one machine-written line to
`.audit/bakeoff-log.jsonl` (Category A — gitignored accumulating run data).
Four properties make the count trustworthy:

- **Snapshot identity is the transcript's CONTENT hash**, so a copy or rename is
  the same snapshot, and edited content is correctly a new one.
- **Re-running a complete snapshot is a no-op** (verified), so N cannot be
  inflated by repetition.
- **A snapshot counts only when EVERY arm reports `shadowState: 'ran'`.** A
  skipped or errored arm leaves it `incomplete` and excluded — so "an arm never
  ran" can never read as "that arm found nothing". The anti-green rule applied
  to the counter itself.
- `--progress` prints `N/target` plus the incomplete count, and states in the
  output that raw uniques are **not** the verdict.

The three existing snapshots were **backfilled from their saved result files**,
not re-typed from the table below, and independently reproduced it
(opus 10 / kimi 0).

### 0.6c Input supply — where transcripts live, and why they survive

*(Added 2026-08-08, after the counter stalled at 1/12 for five days with no
transcript to collect.)*

A trustworthy counter does not help if nothing reaches it. Two defects were
starving this campaign, both fixed:

1. **Transcripts were written to `/tmp`.** [208eba20](https://github.com/Lbstrydom/claude-engineering-skills/commit/208eba20)
   (2026-07-28) diagnosed this — `/tmp` is OS-cleaned, and on Windows Bash's
   `/tmp` and Node's `/tmp` are different directories — but fixed only the
   *invocation* line in `audit-code/SKILL.md`. The **build** instruction lives in
   the shared reference, which still said `/tmp`, and `/audit-plan` said `/tmp`
   in both places. Measured on 2026-08-07: 113 transcripts existed on this
   machine, **108 of them outside the repo** in two temp directories nothing
   scans, and the newest one there belonged to a *different repo* (consumer
   sessions share one Windows temp dir). Fixed at the canonical
   [`docs/audit/shared-references/gemini-gate.md`](../audit/shared-references/gemini-gate.md)
   — editing a synced copy is reverted by `sync-shared-audit-refs`, which is how
   the half-fix survived.
2. **`audit:clean` deleted the survivors.** `.audit/*-transcript.json` matched a
   TRANSIENT pattern with a 14-day age gate, so the correct location was also
   the swept one. Transcripts are now a **retained class** in
   [`scripts/audit-clean.mjs`](../../scripts/audit-clean.mjs): the newest **25**
   survive at any age, the tail is still pruned, and the sweep prints what it
   retained (a silent retention reads as "found nothing"). 25 = a 12-snapshot
   campaign plus headroom for incompletes and replacements; at observed sizes
   (5–230KB) that ceiling is ~1–3MB.

The same change widened the pattern to `-transcript(-<suffix>)?.json`. The
Step-7.1 re-review transcripts (`-transcript-v2.json`) and mode-suffixed ones
(`-transcript-code.json`) never matched the old regex, so they were pruned by
**nothing** — the cap only bounds what it matches, and an exemption without a
widened match would have swapped one unbounded class for another.

Guard: [`tests/audit-clean-retention.test.mjs`](../../tests/audit-clean-retention.test.mjs)
(window split + CLI sink; the sink keeps an aged ledger of the same age as a
negative control, so "nothing was deleted at all" cannot pass as retention).

### 0.6d Cloud persistence — `--run-id`, and why replays are tagged

*(2026-08-08.)* `bakeoff-collect` now mints one `audit_runs` row **per arm** and
passes `--run-id`, so each arm's findings reach the store and surface in the
ordinary `final-review-stats --worksheet` flow. Without it `runShadowAndPersist`
returns at `if (!runId) return` and the entire cloud write is a silent no-op —
the reason snapshots 2-3 hold `final_review_shadow_model = NULL`.

One row per **arm**, not per snapshot: the run-level final-review columns are
single-valued, so three arms sharing a row would leave whichever finished last
as the record of all three.

Replay rows carry `audit_runs.experiment_tag = 'final-review-bakeoff'`
(migration `20260808120000`). This is load-bearing arithmetic, not tidiness:
§6.3 scores **accepted HIGH/MED per RUN**, and that denominator is `COUNT(*)`
over this repo's runs. Twelve snapshots x three arms adds 36 rows; measured
after the first four snapshots, the organic denominator held at **47** while 12
replay runs were excluded and reported separately. Untagged, the same 12 would
have read as a 20% drop in Opus's per-run rate caused entirely by measuring it.

**The registration failure mode is now loud.** The first real run of this path
had a wrong import specifier, every mint threw into the best-effort handler, and
the collection proceeded with `runId: null` — reproducing the exact defect the
change was written to remove, invisibly. The collector now refuses to let "every
arm ran, nothing persisted" pass quietly.

### 0.7 Collection log

*(Human-readable mirror. `.audit/bakeoff-log.jsonl` is authoritative — if the
two ever disagree, believe the log.)*

Appended per snapshot. `unique` = raised by that arm and no other, before
adjudication; `accepted` is filled in at labelling time.

| # | transcript | P₁ | P₂ | Opus unique | Kimi unique | notes |
|---|---|---|---|---|---|---|
| 1 | `audit-code-1785428132` | 0 | 2 | 4 | 0 | pre-existing; declared §0.6 |
| 2 | `audit-plan-1785374489` | 1 | 1 | 2 | 0 | both P samples CONCERNS/1 |
| 3 | `audit-plan-1785325355` | 3 | 4 | 4 | 0 | P₂ verdict REJECT vs P₁ CONCERNS |

**N=3 running totals** — Opus unique **10**, Kimi unique **0**, P₁ 4 / P₂ 7.

> **These three are PRE-EPOCH and no longer count** (noted 2026-08-08). They
> were collected before `e2-matched-reasoning-effort` and carry no
> `contractEpoch` stamp, so `isComplete()` rejects them and the campaign
> restarted: `--progress` reads **1/12**, not 3/12. The observations below stand
> as history — in particular "Kimi has produced zero unique across three
> snapshots" describes the pre-`e2` contract, and under `e2` Kimi has produced
> shadow-only findings (3, then 1) on the one snapshot collected since. Read the
> log, not this table.

Three observations, all provisional at N=3 and none yet adjudicated:

1. **Kimi has produced zero unique findings across three snapshots.** It is not
   silent — it returns parseable CONCERNS/REJECT verdicts and agrees with the
   primary's findings — but on identical input it has added nothing the primary
   did not already have. If this holds, Kimi fails the §6.3 gate
   (`marginal ≥ 0.2/run`) outright and the cheap-shadow hypothesis dies cheaply,
   which is exactly what this design is for.
2. **Opus has produced unique findings on all three (4, 2, 4).** Consistent with
   the labelled tail's ~1.1 accepted HIGH/MED per run, though these are raw
   uniques, not yet accepted.
3. **P₁ vs P₂ diverge on every snapshot** (0/2, 1/1, 3/4 — and snapshot 3 gave
   different *verdicts*, CONCERNS vs REJECT, on identical input). The
   stochastic-recall arm is live: some of what a shadow "adds" may be
   reproducible by sampling the primary twice at ~$0.10 rather than $1.21. This
   is the arm most likely to change the architecture, and it costs nothing extra
   to keep measuring.

> **Update 2026-08-08 — four snapshots collected; the Kimi reading REVERSED.**
> Counter reads **5/12** (`node scripts/bakeoff-collect.mjs --progress`; per-arm
> numbers live in the log, deliberately not re-typed here). Kimi produced
> shadow-only findings on **every** `e2` snapshot — 1, 3, 7, 1, 2 — against
> Opus's 7, 5, 3, 5, 5. Observation 1 above ("Kimi has produced zero unique
> across three snapshots... the cheap-shadow hypothesis dies cheaply") described
> the **pre-epoch** contract only, and does not survive matched reasoning
> effort. Nothing here is adjudicated, so this is a statement about raw
> uniqueness and not about value; the ~40% dismissal rate from tail labelling
> applies to both arms. But the direction of the live question has flipped from
> "does Kimi clear 0.2 at all" to "how much of Opus's rate does it cover".

### 0.7b Adjudication, 2026-08-08 — and why raw uniqueness misled twice

21 bake-off shadow-only HIGH/MED findings adjudicated. **Blind to arm**: the
findings were rendered into a worksheet with `source_model` withheld and ordered
by a hash shuffle (insert order is arm-ordered — opus always runs first), and
the key was opened only after every verdict was written. The model-A/B queue is
already blinded for this reason (`store/model-ab.mjs`: "source_model
deliberately NOT selected"); this queue was not, and it is the queue that
decides an arm comparison.

**Verified, not judged.** Each finding was checked against current code rather
than re-judged — a stated defect is usually a claim an instrument can settle,
and LLM re-judgement of historical findings is a known-confounded instrument
here (52% agreement with a human on a prior calibration). Two findings resisted
that treatment and are recorded as `judgement`, deliberately unlabelled.

| arm | n | accepted | dismissed | judgement | accepted HIGH/MED per snapshot |
|---|---|---|---|---|---|
| opus | 13 | 6 | 6 | 1 | **1.50** |
| kimi | 8 | 1 | 6 | 1 | **0.25** |

Denominator is **4** snapshots, not 5: the 2026-08-03 snapshot predates the
`--run-id` wiring, so its findings never reached the store and cannot be
adjudicated.

**Raw uniqueness pointed the wrong way, twice.** Pre-epoch it said Kimi found
nothing (§0.7 obs. 1) — wrong, an artifact of unmatched reasoning effort. Under
`e2` it said Kimi was productive (14 uniques to Opus's 25) — also wrong: Kimi's
dismissal rate is **6/7 = 86%** against Opus's **5/12 = 42%**. §0.7's own
warning ("Raw uniqueness is not value") is now measured rather than asserted.
Opus's 42% also lands within a point of the ~40% the tail-labelling pass
predicted, which is a small independent check on that instrument.

**Do not read a verdict from this.** §6.3 row 1 makes `N < 12` terminal
INCONCLUSIVE, and this is N=4. The arithmetic is currently perverse in a way
that makes the stopping rule worth honouring: both arms clear the `≥0.2/run`
gate, and per accepted cluster Kimi is *cheaper* (~$0.18 vs ~$0.69, both far
under the $8 ceiling), so a naive application of "cheapest qualifying arm wins"
selects the arm that found **one seventh** as many real defects. Kimi's 0.25
rests on a single accepted finding; one more dismissal puts it at the gate edge.
That is exactly the shape N=12 exists to protect against.

**Six distinct defects were confirmed** (F07/F09 are the same defect found on
two snapshots), and they are now open work rather than an unlabelled queue: a
convergence oracle with no production caller (HIGH, x2), a mandatory gate whose
default fixture rev can never exit 0, an exclusion-bucket double-count, an
unvalidated pass-granting exemption loader, a second live-provider path
filtering egress through a weaker authority than the documented one, and a
mandatory-pill date policy that exists only as a JSON comment. Plan:
[`gate-honesty-adjudicated-defects.md`](gate-honesty-adjudicated-defects.md).

> **Corrected 2026-08-08, same day — seven was wrong, and so was the rate.**
> F14 ("a script-keyed exemption silently covers a newly appended command") was
> **accepted here and is false**. `check-gate-poison-pills.mjs:168` (`561c18f0`)
> guards it with `commandCount.get(g.script) === 1`: a script-level exemption
> stops applying to *every* command the moment a second appears, so the result
> is a loud failure, not a silent inheritance. Measured: all 17 current
> exemptions key single-command scripts.
>
> It was caught by Phase 1 of the plan that would have implemented the fix —
> reading the *consumer* rather than the exemption *keys*. The mis-adjudication
> is the precise failure "verify against current code, don't judge" exists to
> prevent, committed while applying that rule. Label corrected in the store;
> the table above carries the corrected figures (opus 6 accepted / **1.50** per
> snapshot, was 7 / 1.75). Kimi is unaffected.
>
> Worth keeping rather than quietly restating: an adjudication pass that
> verified 20 of 21 findings correctly still shipped one wrong label, and only a
> *second* pass over the same code found it. One reading is not a measurement.

**Still unadjudicated**: 10 bake-off LOW (LOW does not score) and 25 organic
shadow-only (13 MEDIUM, 12 LOW) — a separate, older population.

**Not yet done for these snapshots**: adjudication of the LOW tail. Raw uniqueness is not value —
the §6.3 gate scores *accepted* HIGH/MED clusters, and the tail-labelling pass
showed roughly 40% of raw shadow findings get dismissed. Snapshots 2-3 findings
persist under their own `source_model`; label them via the ordinary
`final-review-stats --worksheet` flow before reading anything into the totals.

> **Audit trail** — `/audit-plan` (SID `audit-plan-1785325355`). **GPT 3 rounds**
> (H:6→6→4, M:3→2→2; 23 findings, **all valid, all in-scope, all fixed — zero
> dismissed, zero deferred, no rebuttal round required**). Stopped at the
> 3-round cap with HIGH still falling 33%, because the residual character had
> shifted to implementation-completeness (retry policy, cross-repo plumbing),
> which belongs to the code audit's artifact. **Gemini final gate 2 rounds**
> (R1 CONCERNS, 3 findings — retired-arm selector disqualification, flaky-arm
> cost subsidy, missing void write-path — all fixed; R2 CONCERNS, 3 findings —
> missing `terminal_state` column, a trailing §6.0 contradiction, arm fields on
> the wrong table — all fixed, then **stopped at the 2-round Gemini cap** per
> the parameter-placement + rising-praise stop signals). Final
> `arch_coherence: Strong`; `claude_bias_detected: false`;
> `gpt_false_positive_count: 0`; deliberation fair both rounds.
>
> **Three findings changed the design rather than polishing it**, and all three
> were defects that would have produced a *confidently wrong* result:
> (1) **R1-H2** — the plan's own risk table asserted cluster errors bias against
> KEEP; false *splits* in fact inflate `marginal` and bias **toward** KEEP,
> i.e. toward the incumbent this experiment exists to judge.
> (2) **R3-M2** — the mechanism readout compared `exclusive(S1)` against
> `exclusive(S2)`/`exclusive(S3)`, which is **definitionally incapable** of the
> test: a cluster exclusive to S2 contains no S1 finding by construction, so
> the stochastic-recall hypothesis would have returned a null result for every
> possible dataset.
> (3) **Gemini R1-M1** — excluding failed-attempt spend from the cost ratio
> **subsidised a flaky arm**, since its parse failures void whole runs while
> none of that waste reached its own efficiency number.
>
> Residual: none open. Precision beyond this point is deferred to `/audit-code`
> against the Phase 0 implementation.
- **Scope**: backend
- **Stack**: js-ts + postgres
- **Target domain(s)**: `audit-orchestration`, `stores`
- **Supersedes measurement in**: [`final-review-shadow-reviewer.md`](./final-review-shadow-reviewer.md)
  (that experiment is CLOSED; this plan does not reopen it, it measures the
  variable that one could not)

---

## 1. Context Summary

**What the closed experiment established.** `FINAL_REVIEW_SHADOW=claude-opus`
ran blind and in parallel with the Gemini primary final reviewer for 35 runs at
$50.90. Ten human-`accepted` shadow-only findings of HIGH/MEDIUM severity
cleared a pre-registered floor of 7, so the verdict was KEEP. A post-hoc sweep
of 30 previously-unadjudicated findings then confirmed 21 were real and since
fixed, of which **16 carry an in-code comment crediting the shadow** ("shadow
finding", "shadow catch", one by fingerprint) and **2 credit the non-shadow
path**. Full write-up:
[`final-review-shadow-adjudication-briefing.md`](../research/final-review-shadow-adjudication-briefing.md).

**What it did NOT establish — the reason this plan exists.** "The shadow found
it" is not "the system would otherwise have missed it." Three instrument
defects are recorded in AGENTS.md's close-out and all three bear on the
decision now being made:

1. **The pre-registered rule could fire both ways.** KEEP was a count floor;
   DROP was a ratio. Both were live simultaneously, so the rule as written
   could not adjudicate itself.
2. **Fixes landed before adjudication.** `user_action` stayed null, credit
   reached a source comment instead of the ledger, and the tail read as noise
   until a manual sweep recovered it.
3. **Marginal value was never measured.** Within-run overlap against the GPT
   audit passes was 0 files across 19 both-run cases, but file identity is the
   wrong unit (two reviewers can describe one defect in different files) and
   cross-run re-raises were confirmed yet never quantified.

**The 16-vs-2 credit split is a prior, not evidence.** It is survivorship-biased
— only *fixed* findings acquire a crediting comment — so it justifies sizing
this experiment as confirmation rather than open exploration, and nothing more.

**External review.** `/brainstorm` SID `1785324821475` (GPT-5.6 + Gemini-pro,
focal artifact = the briefing). Both converged independently on: fix attribution
first, measure counterfactuals forward on a frozen snapshot, cluster findings by
defect rather than counting raw findings, and do not swap the primary while the
shadow question is open. Gemini contributed the **self-shadow** arm (§3, S1) —
the observation that the alternative to a *diverse* shadow is not *no* shadow
but **the same model sampled twice**, which no other participant raised and
which is the cheapest way this experiment can invalidate the whole architecture.

### 1.1 Decision under test

> Does a second final-review pass earn its keep **on top of the Gemini
> primary** — and if so, is the mechanism model **tier**, reviewer
> **diversity**, or merely **stochastic recall**?

---

## 2. Non-goals (explicit scope boundary)

- **Not** a new passive collector. This is a bounded synchronous campaign that
  terminates at N=15 regardless of outcome (§6). AGENTS.md's "do not add a
  sixth collector" rule is satisfied by that termination condition, not by
  argument.
- **Not** a primary-reviewer swap. That is Phase 3 (§7), conditional and
  deliberately un-pre-committed.
- **Not** a re-litigation of the closed KEEP verdict. That verdict stands on
  what it measured.
- **Not** an LLM re-judgement of historical findings. Prior attempt scored 52%
  agreement / 29% recall against human labels; code read today cannot separate
  "never a defect" from "fixed during the loop". Every measurement here is
  captured forward, on the snapshot that produced it.

---

## 3. Arms

One primary baseline plus three shadow candidates. **All four arms run on every
snapshot.** This is forced by the metric, not a budget preference: `unique to
arm C` is undefined on a run where arms A and B did not see identical input.
Alternating arms across runs cannot produce the numbers in §4.

| Arm | Reviewer | Hypothesis it tests | ~cost/run |
|---|---|---|---|
| **P** | Gemini pro, current settings | Baseline. Not a candidate. | ~$0.15 |
| **S1** | Gemini pro, divergence lever on | Value is **stochastic recall** (a second roll of the dice) | ~$0.15 |
| **S2** | Kimi K2 via OpenRouter | Value is reviewer **diversity** | ~$0.10 |
| **S3** | Claude Opus (incumbent) | Value is model **tier** | ~$1.45 |

Retaining S3 is what makes the run answer the original question. A three-way
without the incumbent measures which *replacement* is best while assuming the
thing under test.

**Budget**: ~$1.85/run × 15 = **~$28**. The binding constraint is adjudication
time: ~10 min/run ≈ **2.5 hours**. Every protocol decision in §5 is subordinate
to protecting that number.

### 3.1 S1's divergence lever — VERIFY BEFORE BUILDING

S1 requires two Gemini passes that actually differ. **Whether the review call
exposes temperature is unverified as of this draft.** If it does not, S1 needs
another lever (independent sampling, prompt-block reordering) or the arm is
unbuildable — and since S1 is the arm most likely to invalidate the architecture
cheaply, its absence changes the shape of the whole result. Resolve this in
Phase 0 before any spend.

---

## 3.2 The snapshot contract (R1-H1)

"Freeze the review snapshot" is not implementable as prose. The measurement is
only valid if every arm received **byte-identical input**, so the snapshot is
defined as an artifact, not an intention:

**A `ReviewSnapshot` is the fully-assembled review payload** — the exact bytes
this repo already hands a final reviewer (diff + evidence + prompt), captured
once and replayed to all four arms. It records:

| Field | Why |
|---|---|
| `repoId` (the store's canonical `audit_repos` id) + `sourceRunId` | The population spans two repos; without an immutable repo identity a candidate's origin is only inferable from paths inside the payload (R3-H2) |
| `arrivalSeq` (monotonic, assigned by the shared store on enrolment) | Establishes the cross-repo arrival order §6.0b's no-cherry-picking rule depends on — `commitSha` and wall-clock cannot order two repos |
| `payloadHash` (sha256 of the assembled payload) | The identity all arms are asserted against |
| `payloadPath` (archived copy under `.audit/bakeoff/<runId>/`) | A hash alone is not recoverable evidence; the reviewed content may be uncommitted |
| `commitSha` + `worktreeDirty` | Provenance; a dirty tree is allowed but must be *recorded*, not assumed clean |
| `promptVersion`, `schemaVersion` | A prompt edit mid-campaign changes what the arms were asked |

Per-arm `resolvedModel` / `resolvedProvider` / `params` are deliberately **NOT**
snapshot fields (Gemini gate R2-L1): a snapshot is the one byte-identical input
broadcast to every arm, so embedding four sets of arm-specific resolution
metadata in it would break that 1-to-many relationship and give the same fact
two homes. They live on `bakeoff_arm_executions` (§5.5) alone.

**Invariant**: each arm's invocation asserts `payloadHash` before sending; a
mismatch **voids the run** (§6.4). The payload is assembled ONCE per run, never
re-derived per arm — re-derivation is how "identical input" silently stops
being identical.

*Right-sizing note vs the R1-H1 recommendation*: deliberately narrower than the
proposed manifest of file lists, exclusion decisions and tool versions. The
assembled payload is downstream of all of those — if it is byte-identical
across arms, the upstream detail cannot differ in a way that affects the
result. A per-file manifest would be a second source of truth for the same
fact.

---

## 4. Metrics — two measures, defined before data exists

The closed rule's fatal defect was conflating two questions into one threshold.
They are separated here:

- **`marginal(X)`** = accepted HIGH/MED **defect clusters** raised by arm X but
  **not by P**, per run. Answers *"does adding any shadow on top of Gemini
  pay?"* — **this is the gate.**
- **`exclusive(X)`** = accepted HIGH/MED clusters raised by X and by **no other
  arm**. Answers *"which shadow, and why does it work?"* — **this is the
  selector and the mechanism readout.**

**The unit is the defect cluster, never the raw finding.** One bug described by
three reviewers is one catch. Clustering procedure in §5.3.

**Severity is scored on the human's adjudication of the cluster, and the
reviewer's own severity claim is never used as a filter (R1-H3).** An earlier
draft bulk-dismissed reviewer-declared LOW findings to bound adjudication time.
That silently broke arm comparability: arms calibrate severity differently, so
an arm that correctly finds a MEDIUM defect but labels it LOW would lose credit
while another arm gets the same defect reviewed. **Every cluster in the
measurement population receives a human severity.** Adjudication load is bounded
by clustering first (which collapses the 4× raw volume) and, if still too large,
by **reducing N — never by pre-filtering the population on a reviewer's own
label.** If N must fall below 12, the campaign is re-scoped and re-committed
before run 1 rather than silently under-powered.

---

## 5. Phase 0 — instrumentation (zero API cost; nothing runs until all four land)

### 5.1 Fix-time attribution write-back

Set `user_action` when the fix lands, plus same-run pass-finding refs. This
implements an existing ruling (AGENTS.md shadow close-out: *"set `user_action`
at fix time; record same-run pass-finding refs"*) rather than proposing a new
one. Credit must be **selected by the maintainer**, never inferred from "a file
changed after a shadow finding" — that reconstructs causality by guesswork,
which is the failure this plan exists to end. A fix may legitimately credit two
arms jointly.

### 5.2 Finding-time state capture

Each finding records commit sha + file hash **at generation time**. This
permanently decouples adjudication from remediation latency — the confound that
made the last tail unreadable. Partially present already (`audit_runs.commit_sha`,
evidence anchors carry `headSha`); the gap is a per-finding snapshot ref.

### 5.3 Cross-arm clustering — high-recall candidates, then human confirm (R1-H2)

`finding_embeddings` + pgvector + `semantic-suppression.mjs` already answer "are
these two findings the same defect?" Reuse the machinery — but **not its
threshold or its posture.**

**The error this corrects.** An earlier draft proposed pairs at cosine 0.85 and
had the human confirm only what was proposed, and claimed in the risk table that
clustering errors "bias against KEEP — the conservative direction." **That was
wrong, and it was wrong in the direction that flatters the incumbent.** The two
error modes are not symmetric in effect:

| Error | Effect on the metric | Direction |
|---|---|---|
| **False split** — P and a shadow describe one defect, never proposed as a pair | Counts as a shadow-unique cluster that isn't | **Inflates `marginal` → biases toward KEEP** |
| **False merge** — two genuinely distinct defects collapsed | Erases real marginal value | Biases toward DROP |

Suppression tuning optimises *precision* (don't wrongly silence a finding).
This measurement needs **recall** (don't miss a match), because a missed match
is a false split. Inheriting the suppression threshold would inherit the wrong
objective.

**Procedure.** Candidate generation is deliberately over-inclusive, using
multiple independent signals — embedding nearest-neighbours at a **lowered**
threshold (calibrated in Phase 0, not inherited), shared file/line-range or
evidence anchor, and shared normalised rule/category. Every finding that ends in
a **singleton cluster while another arm has any finding on the same file** is
queued for explicit human review as a possible missed match. The human confirms
every merge AND every survived singleton in that queue.

**Calibration is a Phase 0 deliverable with a pass mark, not an intention
(R2-M2).** Build a labelled pair set — ~60 pairs drawn from historical
cross-reviewer findings in the store plus synthetic cross-*file* restatements of
one defect (the case the same-file singleton queue structurally cannot catch).
Pass mark: **≥0.95 recall on true cross-arm matches**, with the candidate queue
staying under **40 pairs per run** (the feasibility ceiling for a 10-minute
adjudication). If both cannot hold simultaneously, the queue cap yields and N
falls — recall is the property the metric depends on. The chosen threshold and
its measured recall are recorded with the verdict.

**The pair universe is intra-arm as well as cross-arm (R3-M1).** Cross-arm
matching alone lets a verbose arm report one underlying defect twice and collect
**two** marginal clusters when neither duplicate has a cross-arm counterpart —
inflating exactly the number the decision turns on, in favour of whichever arm
is chattiest. Candidate generation and the review queue therefore cover
same-arm pairs too, and the projection collapses every confirmed same-defect
finding regardless of which arm produced it (all members are retained for
attribution evidence). Calibration (below) carries an intra-arm stratum.

Clustering decisions are recorded as a versioned dataset (finding pair →
merged/split/uncertain + who decided), so the sensitivity of the final verdict
to clustering can be re-derived rather than trusted.

**Pre-registered sensitivity check**: after adjudication, recompute the §6.3
decision under (a) all `uncertain` pairs merged and (b) all split. **If the two
recomputations disagree on the verdict, the result is reported as
inconclusive** — not resolved by picking one.

### 5.4 Blinded worksheet (R1-M2)

Merge all arms → cluster → blind → maintainer adjudicates → unblind → auto-tally
per arm. Extend the existing `final-review-stats --worksheet` surface. Real
values in operator docs, never `<angle-brackets>` (PowerShell reserves `<`; this
repo has been bitten twice).

"Strip arm labels" is not sufficient blinding. The contract:

- **Opaque ids** for findings and clusters; the arm↔finding mapping is stored
  in a separate artifact the adjudicator-facing payload never references.
- **Deterministic redaction** of explicit self-identification (model/provider
  names, "as Gemini I…", request ids, token metadata).
- **Randomised presentation order**, seeded per run and recorded, so order
  carries no arm information.
- Adjudication writes **only to opaque ids**; unblinding is a separate step
  authorised only after the worksheet is finalised and integrity-checked.
- A test proves that no arm label, model name, or provider string survives into
  the adjudicator payload.

**Accepted residual, stated rather than promised away**: prose style is a real
identity leak that redaction cannot remove — a maintainer who has read Opus
output for 35 runs may recognise it. Two things bound the damage: adjudication
judges the *defect* (is this real, what severity), not the writing, and the
`uncertain`-pair sensitivity check in §5.3 would expose a verdict that only
survives under one reading. This residual is **not** claimed to be eliminated.

### 5.5 Persistence contract (R1-H6)

§5.1 says a fix "may legitimately credit two arms jointly" while proposing a
scalar `user_action`. Those contradict: a scalar cannot express joint credit.
The minimum shape that can:

| Record | Key facts | Cardinality |
|---|---|---|
| `bakeoff_runs` | runId, snapshot fields (§3.2), seed, status (`valid`/`void`+reason) | 1 per run |
| `bakeoff_arm_executions` | runId, arm, resolvedModel, resolvedProvider, params, cost, tokens, latency, **`terminal_state`** | 4 per run |
| `bakeoff_findings` | armExecutionId, opaque id, raw severity, payload | N per execution |
| `bakeoff_clusters` | runId, opaque id, human severity, accept/dismiss | N per run |
| `bakeoff_candidate_pairs` | findingA ↔ findingB, generating signal(s), decision (`merged`/`split`/`uncertain`), decidedBy, clusteringVersion | **the identity evidence** (R2-H2) |
| `bakeoff_cluster_members` | clusterId ↔ findingId | the **resolved projection**, derived from confirmed pairs |
| `bakeoff_remediations` | (repoId, commit sha), clusterIds addressed | 1 per fix; may address several clusters |
| `bakeoff_attributions` | remediationId, clusterId, armExecutionId | **many-to-many** — this is what carries joint credit (R2-M1) |

**`terminal_state` is load-bearing, not decoration (Gemini gate R2-H1).** It
takes exactly the §6.0c enum (`ok` / `parse_invalid` / `route_invalid` /
`timeout` / `transport_error` / `provider_5xx` / `rate_limited` /
`quota_exhausted` / `cancelled`). §6.3's failure-cost attribution asks "which
arm caused this void" — a `parseOk` boolean cannot answer that for a `timeout`
or a `route_invalid`, so the attribution rule would have been unimplementable
against the schema that carried it.

**Why pairs and membership are separate records (R2-H2).** §5.3's evidence is a
*pairwise* decision: one finding can be merged with one peer and explicitly
split from another while still landing in a single confirmed cluster, and the
`uncertain` pairs must survive for the sensitivity recomputation. A membership
row cannot express either. So pairs are the durable evidence; membership is a
deterministic projection, recomputable from the pair set at any time.

**The projection, stated precisely (R3-H1).** Vertex set = **every finding in
the run**. Edge set = confirmed `merged` pairs only. Persist one cluster per
connected component **including one-vertex components**. An earlier draft
derived membership from the pair graph alone, which silently dropped every
finding with no merged edge — i.e. **every shadow-only finding, the primary
input to `marginal`.** The metric's own numerator would have been unpersistable.
`split` and `uncertain` pairs are durable evidence but never baseline edges; the
two §5.3 sensitivity projections re-run over the same full vertex set with
`uncertain` added as edges (merged case) or omitted (split case).

Three integrity boundaries: a finding belongs to exactly one **resolved**
cluster; an attribution names a `(remediation, cluster)` pair that exists; and
the referenced `armExecution` must have a finding in that cluster — a fix cannot
credit an arm that never raised it (V5). Enforced at the write seam, transactionally.

Migrations follow the repo's existing conventions (unqualified names, ledger
tracked, `db:local:regen` for `expected-schema.json`). jsonb payload columns are
passed raw through the `db/query.mjs` write seam — never hand-`JSON.stringify`d;
a genuine `text[]` opts out with `pgArray()`.

### 5.6 Run lifecycle — how V7 is actually delivered (R2-H5)

V7 asserts "DB error mid-run → void, no partial cluster state". A filesystem
archive and a multi-table write cannot be committed atomically together, so the
outcome needs a stated ordering, not an implication:

1. **Journal first.** Write an attempt journal (runId, snapshot fields, arm set)
   via the existing atomic same-directory-temp-then-rename seam
   (`atomicWriteFileSync`). Same contract as the install transaction journal.
2. **Stage artifacts.** Archive the payload and each arm's raw output as staged
   files through the same atomic seam. Filesystem writes precede any DB write,
   so a crash leaves recoverable evidence and no database state.
3. **One transaction.** A single DB transaction creates the run, arm executions,
   findings, candidate pairs, resolved clusters, and the status transition to
   `valid`. Any failure rolls back all of it.
4. **Two terminal write paths, not one (Gemini gate R1-M2).** The success path
   above writes run + executions + findings + pairs + clusters + `status:valid`.
   A **detected** failure (`payloadHash` mismatch → V1, route mismatch → V8,
   `parse_invalid`, retry exhaustion) takes a distinct **void transaction**:
   write the `bakeoff_runs` row with `status:void:<reason>` **and every
   completed `bakeoff_arm_executions` row**, omitting findings, pairs and
   clusters. Persisting the executions is what makes §6.3's failure-cost
   attribution possible at all — a void run whose spend was never recorded
   cannot be charged to the arm that caused it.
5. **"Absence is void" applies only to UNHANDLED crashes.** An earlier draft
   stated it as the general rule, which contradicted §5.5's `void+reason` status
   and V1/V8's requirement to record *which* void occurred. Corrected: a
   detected failure is explicitly recorded (step 4); only a process/DB crash
   with no row at all falls back to absence-as-void, with the orphaned journal +
   staged files as its audit trail.
6. **Reconciliation on start**: an orphaned journal with no `bakeoff_runs` row
   at all is reported as `void:crash`, its cost recovered from the staged
   artifacts where possible, and its snapshot re-enrolled as a replacement
   (§6.0 step 4).

*Right-sizing note vs the R1-H6 recommendation*: no immutable event log, no
separate snapshot-evidence service, no versioned persistence framework. Six
tables for a 15-run campaign with a fixed end date. The two many-to-many joins
are the only structurally load-bearing part — everything else could be a flat
table without endangering the result.

---

## 6. Phase 1 — run protocol and stopping rule

### 6.0 Arm eligibility — resolved before spend, not during (R1-H4)

An earlier draft simultaneously asserted "nothing runs until all four
instrumentation items land", "all 15 runs execute all four arms", and "S1 may be
unbuildable". Choosing among those *after* seeing data would recreate exactly
the post-hoc ambiguity this plan exists to end. The state machine, fixed now:

1. **Phase 0 gate.** S1's divergence lever (§3.1) either validates — a concrete,
   independently-varying configuration demonstrated on ≥3 throwaway snapshots —
   or it does not.
2. **If it validates** → the four-arm protocol runs as written.
3. **If it does not** → the protocol is **formally revised to three arms and
   re-committed to this document before run 1**, with an explicit note that the
   result is silent on the stochastic-recall hypothesis. It is *not* run as
   "four arms, one of which we'll call void later".
4. **Cohort accounting — one model, no exceptions (R2-H3).** The **comparison
   cohort** is the set of snapshots completed by *every arm eligible at that
   snapshot*. A **failed attempt** (any arm unparseable, or a `payloadHash` /
   route mismatch) is **operationally failed and excluded from every metric
   denominator**. Its **spend is charged to the arm(s) whose `terminal_state`
   caused the void** and enters their cost-per-cluster numerator (§6.3); only
   genuinely unattributable spend (assembler bug, operator abort) falls back to
   general campaign cost. A replacement snapshot restores cohort size.
   *(Gemini gate R2-M1: this sentence previously still read "never enters
   cost-per-cluster", contradicting the §6.3 fix made one round earlier — the
   flaky-arm subsidy would have survived in the step the operator actually
   follows.)*
   **Replacement budget: 5**; on exhaustion the campaign reports at the N it
   reached, with the shortfall stated. An earlier draft said a void run
   "remains in every other arm's denominator", which cannot be true of a run
   excluded from the N=15 cohort.
5. **Mid-campaign arm retirement** — trigger is **execution failure only**
   (parse/route failure in >20% of that arm's attempts), never the §6.4
   determinism measure, which is end-of-cohort by construction (R3-H3).
   Retirement is a **protocol change, not a silent continuation**: it is
   committed to this document with its trigger, and the write-up reports
   **both** cohorts — full-arm up to retirement, reduced-arm after. Runs are
   never retrospectively re-scored under a different arm set.
   **A retired arm is disqualified from the selector** (Gemini gate R1-H1):
   excluded from §6.3 rows 4–5 and reported observationally only. Without this,
   an arm too unreliable to finish the campaign could clear 0.2/run and
   $8/cluster **on its own abbreviated cohort** and be selected as the KEEP
   winner — rewarding the flakiness that shortened its exposure.
6. **Terminal procedure for `S1 = unmeasured`** (§6.4 determinism void, decided
   once, after the cohort closes — R3-H3). S1's raw outputs and clustering
   evidence are **retained for audit** and its findings remain in the baseline
   clusters (removing them would re-partition clusters other arms are scored
   on). But S1 is **excluded from §6.3 rows 3–5 and from the selector**, and the
   §6.3 mechanism readout reports `coverage(S1 → ·) = unmeasured`. P/S2/S3 are
   evaluated on the unchanged cohort — no denominator changes, because the
   cohort was defined by *execution completeness*, which S1 satisfied.
   **An unmeasured S1 does not by itself make the campaign inconclusive**; it
   makes the result silent on the stochastic-recall hypothesis, which is
   recorded as a stated limitation in the verdict.
7. **A retired or unmeasured S1 does not change the DROP branch.** §6.3 row 3
   tests all *eligible* arms; if none clears, the verdict is DROP regardless of
   how many arms were eligible — with the reduced coverage recorded.

### 6.0c Arm execution — terminal states and retry policy (R3-H4)

§6.3 counts retries in realised cost, so retries need a contract. Each arm
invocation produces **immutable per-attempt records** and exactly one terminal
state:

| Terminal state | Retryable? |
|---|---|
| `ok` (parseable) | — |
| `parse_invalid` (returned, unreadable) | **No** — a content failure, not a transport one; voids the run (§6.0 step 4) |
| `route_invalid` (resolved provider ≠ committed config) | **No** — voids the run (§6.2) |
| `timeout` / `transport_error` / `provider_5xx` / `rate_limited` | **Yes**, bounded |
| `quota_exhausted` | No — halts the campaign, reports at actual N |
| `cancelled` | No |

**Bounded retry**: max 2 retries per attempt, exponential backoff with jitter,
hard per-run deadline. Every retry re-asserts the identical `payloadHash` and
committed arm config before sending, and carries a correlation key so an
ambiguous success after a client disconnect is reconciled rather than
double-counted. **All attempts' cost is recorded**, including failed ones —
that is what §6.3 means by realised cost. A run exhausting the retry budget on
any arm is a failed attempt (§6.0 step 4), replaced from the budget of 5.

### 6.0b Snapshot enrolment — how the 15 are chosen (R2-H6)

§3.2 fixes what a snapshot *is*; without an enrolment rule it does not fix
*which* snapshots the campaign sees, leaving the sample open to unconscious
cherry-picking (a shadow looks best on exactly the reviews a maintainer finds
interesting). Pre-registered:

- **Population**: every eligible final-review invocation in this repo and
  `wine-cellar-app` occurring after a committed start timestamp, in **arrival
  order** as established by `arrivalSeq` (§3.2). No discretionary selection, no
  substitution of a "better" snapshot.
- **Cross-repo mechanics (R3-H2, right-sized)**: both repos already share ONE
  store via `AUDIT_DB_URL`, and the synced bundle already runs in both — so the
  campaign needs no new submission channel or authenticated transport. It needs
  exactly two things the store does not carry today: `repoId` + `arrivalSeq`
  stamped **at enrolment**, by the store, so ordering is centrally assigned
  rather than locally guessed. Each repo's own sensitive-path gate applies to
  its own payloads before enrolment (a refusal is an objective exclusion below).
  Remediation commits stay in their own repo; `bakeoff_remediations` records
  `(repoId, sha)`.
- **Objective exclusions**, decided before the payload is sent: a payload
  exceeding any arm's context budget; a review whose diff contains a
  sensitive path (the egress gate refuses it); a zero-diff/no-op review.
- **Every skipped or deferred candidate is recorded with its reason**, and the
  skip list ships with the verdict. An unrecorded skip invalidates the cohort.
- **Enrolment stops at 15 valid cohorts** or at a committed end timestamp,
  whichever comes first — a campaign that cannot fill 15 reports at its actual
  N rather than extending until the numbers improve.
- **Workload control** (§6.1 step 3) adjusts N or per-snapshot scope **only
  before run 1**, never mid-campaign.

### 6.1 Per run

1. Freeze the review snapshot.
2. Run P, S1, S2, S3 independently. No arm sees another's output.
3. **Adjudicate before fixing** — same sitting, blinded worksheet. **Every
   parseable finding is clustered and every cluster receives a human
   accept/dismiss + human severity (R2-H1).** Reviewer-declared severity is
   never a filter and never reaches the adjudicator. Only clusters the human
   labels accepted HIGH/MED enter §4's metrics. An earlier draft said "HIGH/MED
   only, LOW bulk-dismissed" here, which silently re-armed the arm-comparability
   bias §4 exists to prevent — and was circular besides, since a human must
   adjudicate a cluster before it can be called LOW. Workload is controlled by
   the pre-registered enrolment bound (§6.0b), never by filtering the
   population.
4. Implement fixes, recording fix-time attribution (§5.1).

### 6.2 S2 OpenRouter routing contract (R1-H5)

`provider:{require_parameters:true, sort:…}` + `reasoning:{effort:…}` is a
**placeholder, not a pin** — parameter support and a sort preference do not fix
which backend answers. Recording the resolved backend *detects* variance after
the fact; it does not stop the campaign measuring a mixture. One model id maps
to many backends with incompatible context limits, picked per request, and
reasoning tokens count against `max_tokens`.
[experiment-4](../research/experiment-4-cheap-final-reviewer-smoke.md) is this
repo's own record of that failure.

**Resolve in Phase 0 and commit as versioned config before run 1:**

| Field | Requirement |
|---|---|
| Model id | Exact, **including version suffix** — never dropped unverified (`gemini-3-flash`-class 404s are the precedent) |
| `provider.only` | Explicit backend allowlist — the actual pin, not `sort` |
| `provider.allow_fallbacks` | `false`. A silent reroute is the failure mode |
| `provider.require_parameters` | `true` |
| `reasoning.effort` | Fixed concrete value, identical across all runs |
| max input / output / reasoning budget | Fixed; recorded per call |

**Assertion, not observation**: each response's resolved provider + model is
compared to the committed config. **A mismatch voids the run** (§6.0 step 5)
rather than being logged and kept. Phase 0 must demonstrate ≥3 consecutive
invocations resolving to the committed route before the arm is eligible; if the
required route cannot be held, **S2 is dropped in Phase 0** — not carried in
and explained away afterwards.

### 6.3 Pre-registered decision rule (single gate, single selector, exhaustive)

Evaluated as an **ordered decision table** — every combination has exactly one
terminal outcome, and the economic ceiling is applied **before** the selector
rather than after it (R2-H4; an earlier draft's prose let step 3 retain an arm
the ceiling had already excluded):

| # | Condition | Outcome |
|---|---|---|
| 1 | Cohort N < 12 after the replacement budget | **INCONCLUSIVE** — report at actual N, no keep/drop claim |
| 2 | §5.3 sensitivity recomputation flips the verdict | **INCONCLUSIVE** (§5.3) |
| 3 | No eligible shadow arm reaches `marginal ≥ 0.2/run` | **DROP shadows entirely**; optimise the single primary |
| 4 | ≥1 arm clears 0.2/run, but **none** is ≤ $8/marginal-cluster | **EFFECTIVE BUT NOT RETAINED** — terminal for this campaign; revisitable on a price change without re-running |
| 5 | ≥1 arm clears **both** 0.2/run and ≤$8/cluster | **KEEP** the cheapest such arm |

Rows are evaluated top-down; the first match is terminal. The production
architecture retains **at most one** shadow — a product constraint, stated so
row 5 cannot be read as permitting two.

**Cost is realised, not list price (R1-M1).** Cost per marginal accepted cluster
= (that arm's **recorded actual** per-call cost summed across the comparison
cohort, including retries and reasoning tokens, **plus its attributed
failed-run cost** — see below) ÷ (its marginal accepted clusters). Denominator
is the cohort size from §6.0 step 4, identical for every arm.

**Failure cost is attributed to its cause, not socialised (Gemini gate R1-M1).**
An earlier draft booked failed-attempt spend as undifferentiated "campaign
cost", excluded from every ratio. That **subsidises a flaky arm**: its parse
failures void the *whole* run — burning all four arms' spend on a snapshot that
yields no data — yet none of that waste reached its own efficiency number, so a
chronically unreliable arm could out-price a stable one while staying just under
the 20% retirement threshold. So: **the full cost of a replaced run is charged
to the arm(s) whose terminal state caused the void** (`parse_invalid`,
`route_invalid`, retry-budget exhaustion), split evenly if more than one arm
failed on the same snapshot. Only genuinely unattributable spend
(`payloadHash` mismatch from an assembler bug, an operator abort) stays as
campaign cost outside every ratio.

Tie-break inside row 5, deterministic: (1) lower realised cost per marginal
cluster, (2) higher `exclusive` count, (3) lower p95 added latency, (4)
incumbent (S3) retained. A zero denominator cannot occur inside rows 4–5 — an
arm reaching them has ≥3 marginal clusters by construction.

**Mechanism readout (reported in every outcome, gates nothing) — R3-M2.** An
earlier draft compared `exclusive(S1)` against `exclusive(S2)`/`exclusive(S3)`
to test "does S1 recover what the others uniquely find". **That comparison is
definitionally incapable of answering it**: a cluster *exclusive* to S2 contains
no S1 finding by construction, so S1 can never be observed recovering one. The
test would have failed for every possible dataset — a null result manufactured
by the metric, not by the world.

The measurable form is **directional coverage over marginal (not exclusive)
clusters**:

```
coverage(S1 → S2) = |marginal(S2) ∩ clustersRaisedBy(S1)| / |marginal(S2)|
coverage(S1 → S3) = |marginal(S3) ∩ clustersRaisedBy(S1)| / |marginal(S3)|
```

`marginal(X)` (raised by X, not by P) can legitimately contain an S1 finding, so
the intersection is non-vacuous. High coverage ⇒ a second Gemini sample already
reaches what the diverse/premium arms reach ⇒ the mechanism is **stochastic
recall, not diversity**, and a retry loop supersedes the shadow architecture
regardless of which row fired. Zero denominator (`marginal(X)` empty) is
reported as `n/a`, never as 0% coverage. `exclusive` is retained only as the
row-5 tie-break it is actually capable of supporting.

0.2/run is the *same* floor as the closed experiment, now applied to the
strictly harder unique count. Both it and the $8 ceiling are fixed here, before
data.

### 6.4 Determinism void condition — operational form (R2-M2)

If S1 did not actually vary from P, it tested nothing, and reporting it as "no
diversity value" would be a false negative dressed as a result. "≥90% identical"
is not measurable as written (raw text? recall? Jaccard?), so:

- **Measure**: directional cluster overlap — the fraction of P's confirmed
  clusters that also contain an S1 finding, computed over the comparison cohort.
- **Void threshold**: ≥0.90, evaluated **once at the end** of the cohort, not
  per run.
- **Minimum evidence**: at least 20 P clusters across the cohort. Below that the
  measure is `unmeasured`, not `passed`.
- **Zero-set rule**: if S1 produced no findings at all, that is `void:no_output`
  (an execution failure per §6.0), **never** overlap 0.0 read as "maximally
  diverse".

A void arm is **reported as unmeasured**, never as zero value. The same
reporting rule applies to any arm retired under §6.0 step 5.

### 6.5 Statistical honesty

N=15 with single-digit cluster counts is an **operating decision, not a
statistical inference**. This sentence is part of the pre-registration
specifically so no later reader upgrades it.

---

## 7. Phase 2–3

**Phase 2 — decide and stop.** Verdict to `docs/research/`, written in the same
sitting as the final run. The campaign ends at N=15 whatever the outcome.

**Phase 3 — cheap primary (conditional, not pre-committed).** Only if a shadow
survives Phase 2. Uses the built-but-never-run adjudicator-role eval harness,
carrying its known **oracle-matching recall ceiling**: scoring credits only the
one curated defect per entry while real models find other genuine bugs, so
recall is a floor, not the deciding metric — FP rate and cost decide. A cheap
*primary* faces a stricter non-inferiority bar than a cheap shadow because it is
the loop's safety floor rather than a bonus pass.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| S1's divergence lever does not exist | Resolve in Phase 0 before spend (§3.1); if unbuildable, report S1 as unmeasured and note the result is silent on the stochastic-recall hypothesis |
| Adjudicator fatigue at 4× finding volume degrades label quality | Clustering collapses duplicates before the human sees them; if still infeasible, **N or per-snapshot scope falls (§6.0b) — the population is never filtered** (R2-H1) |
| **Cluster false-splits inflate `marginal` and bias toward KEEP** (R1-H2 — an earlier draft of this row asserted the opposite and was wrong) | High-recall candidate generation across multiple signals + a mandatory review queue for cross-arm singletons + the pre-registered merged/split sensitivity recomputation, which reports **inconclusive** rather than picking a reading (§5.3) |
| Fix-before-adjudicate discipline slips on a busy day | Finding-time state capture (§5.2) is the backstop; adjudication remains valid later |
| OpenRouter backend variance confounds S2 | Hard pins + per-call backend recording (§6.2) |
| Reading the 16-vs-2 credit prior as evidence | Stated as survivorship-biased in §1; it sizes the experiment, it does not substitute for it |

---

## 9. Acceptance criteria

1. This document is **committed before run 1** — a pre-registration written
   after data exists is not one. The §6.0 three-arm revision, if triggered, is
   committed before run 1 too.
2. All N valid runs execute all eligible arms against one asserted
   `payloadHash` per run.
3. Every accepted HIGH/MED finding belongs to exactly one confirmed cluster with
   recorded arm membership, and every cross-arm singleton passed the §5.3 review
   queue.
4. The §6.3 rule is applied as written, including the DROP and
   "effective-but-not-retained" branches. If the data says drop, the output is
   "drop" — a rule that can only confirm the incumbent is not a rule.
5. Verdict written to `docs/research/` in the same sitting as the final run,
   including the §5.3 sensitivity recomputation.

### 9.1 Phase 0 verification matrix (R1-M3)

"Exercised by tests" names no behaviour. Each row must pass before run 1;
each names the invariant, not just the field.

| # | Invariant | Setup | Expected | On failure |
|---|---|---|---|---|
| V1 | Snapshot identity is asserted, not assumed | Mutate the payload between arm 2 and arm 3 | Run marked `void:payload_mismatch`; no findings persisted for that run | Run replaced (§6.0.5) |
| V2 | Payload assembled once, not per arm | Instrument the assembler | Exactly 1 assembly call per run | Blocks run 1 |
| V3 | Blinding holds | Adjudicator payload for a run with all arms | No model name, provider string, arm label or arm-correlated ordering present | Blocks run 1 |
| V4 | Attribution can express joint credit | Attribute one remediation to two arms | Both rows persist and re-read | Blocks run 1 |
| V5 | Attribution cannot fabricate credit | Attribute to an arm with no member in the cluster | Rejected at the write seam | Blocks run 1 |
| V6 | Malformed arm output is a void, not a silent zero | Arm returns unparseable text | Run void + replaced; **never** recorded as "arm found nothing" | Blocks run 1 |
| V7 | Persisted-write failure is loud | Force a DB error mid-run | Run void; no partial cluster state survives | Blocks run 1 |
| V8 | Route mismatch voids | S2 resolves to a non-allowlisted backend | Run void:`route_mismatch` | Blocks run 1 |
| V9 | Cross-arm singleton queue is populated | Two arms report the same defect in different words below the embedding threshold | Both surface in the §5.3 review queue | Blocks run 1 |
| V10 | Sensitivity recomputation runs | Fixture with ≥1 `uncertain` pair | Both merged and split verdicts computed and reported | Blocks the write-up |
| V11 | Snapshot survives a dirty tree | Run with uncommitted changes | `worktreeDirty:true` recorded; payload archived and replayable | Blocks run 1 |
| V12 | Schema round-trips | Apply migrations up, regen `expected-schema.json` | Drift check clean | Blocks run 1 |

V6 and V7 are the [gate-honesty](../runbooks/pre-ship-empirical-verify.md)
cases for this campaign: **the branches that can emit a clean/zero result are
where to be adversarial.** "Arm found nothing" and "arm could not be read" must
never be the same recorded state.
