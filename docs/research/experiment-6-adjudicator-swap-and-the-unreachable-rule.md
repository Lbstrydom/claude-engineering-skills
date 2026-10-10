# Experiment 6 — Gemini 3.8 Flash vs Pro for the final-review role, and the rule that could never fire

**Date**: 2026-09-07 · **Role**: adjudicator / final reviewer · **Question**: should
`gemini-3.8-flash` replace `gemini-pro-latest` as the production final reviewer?

**Verdict: switch to `gemini-3.8-flash`, on cost and gate-authority grounds, with
quality equivalence explicitly UNMEASURED and recorded as such.**

That is a weaker claim than it sounds, and the reasoning matters more than the
decision — because the decision is worth $27/month and the reasoning is what
stops the seventh dead instrument.

---

## 1. What was measured

Store `d5a9d07b91225a93` (db `audit_loop`), repo
`6461a693-6690-4bf3-98ee-14c0385cc357` (`Lbstrydom/claude-engineering-skills`).
Every figure below is `measured` unless labelled otherwise.

### 1.1 The offline eval — and why it cannot decide this

Screen tier, `model-eval-adjudicator.mjs`, on a balanced sample drawn from the
**decontaminated** corpus (see §2), n=50, 25 `true_positive` / 25 `false_positive`:

| arm | recall | FPR | F1 | cost | tokens (in/out) |
|---|---|---|---|---|---|
| `gemini-3.8-flash` | 0.440 | 0.360 | **0.4889** | $0.140 | 4,621 / 36,394 |
| `gemini-pro-latest` | 0.680 | 0.760 | **0.5574** | $0.287 | 4,621 / 23,175 |
| **always-`true_positive`** | 1.000 | 1.000 | **0.6667** | $0 | — |

**Neither arm beats a classifier that reads nothing.** The bar to clear was
0.7167 (best degenerate + the 0.05 margin); they came in at 0.49 and 0.56.

This is not a finding about either model. It is a finding about the instrument,
and it is consistent with the independent result in
[experiment-5](./experiment-5-adjudicator-eval-instrument-verdict.md): the eval
prompt carries **92 input tokens** against a production mean of **58,043**
*(n=220)* — a ~620x evidence gap — and appending the cited file's full source
moved the false-accept rate **not at all** (paired, n=17). The task the harness
scores is not the task the gate performs.

Both runs are in `model_eval_runs`, `superseded_at IS NULL`:
`f22d0f0c` (flash, n=10 pinned) and the n=50 pair as scratch measurements.

### 1.2 Cost — the number the decision actually turns on

Production final review, from `audit_runs` telemetry *(n=220, 2026-07-26 →
08-28)*: mean **58,043 input / 8,655 output** tokens.

At the corrected rate card (`9e4e4d23`; flash $0.75/$3.75, pro $2.00/$12.00
tiered ≤200k):

```
per review     pro $0.2199     flash $0.0760     delta $0.1440   (derived)
326 graded reviews / 52 days  ->  monthly delta  $27.08          (derived)
```

**The parked bake-off's "$20–30/mo" was not a guess — it is this number**, and it
has been the right answer for months.
[`final-review-shadow-bakeoff.md`](../plans/final-review-shadow-bakeoff.md) was
audited to completion and parked for costing more than the decision it would
settle. That judgement was correct and remains correct.

Flash is **65% cheaper**, against a pre-registered threshold of 30% (§3).

### 1.3 What the gate actually does

| `gemini_verdict` | n |
|---|---|
| `APPROVE` | 180 |
| `CONCERNS` | 114 |
| `CONCERNS_REMAINING` | 24 |
| `REJECT` | 8 |
| **total graded** | **326** |

44.8% of graded runs raise concerns or reject, so the gate is **not** a rubber
stamp at run level. That is a different question from per-finding correctness and
must not be read as answering it.

---

## 2. The label defect that invalidated four prior attempts

`adjudication_outcome` is **triage, not truth**:

| label source | n | what it records |
|---|---|---|
| `adjudication_outcome`, loop-written (`user_action IS NULL`) | **2,879 (83%)** | the loop grading its own findings via the R2+ ledger |
| `adjudication_outcome`, human-marked | 581 (17%) | a person's disposition |
| `remediation_state = 'fixed'` | 2,101 | someone changed code |
| …carrying a `fix_commit_sha` | 465 | traceable to git |
| `remediation_state = 'verified'` | 51 | none carry a sha |

`getAdjudicatorGroundTruth` mapped `dismissed → false_positive`. **97 of 1,085
dismissals (8.9%) carry a signal that the claim was NOT false** — a `sustain`
ruling (51), remediation planned/fixed/regressed (35), a semantic-duplicate
suppression whose own rationale says the canonical stays open (17), out-of-scope
auto-deferral (11). Two of the six negatives in the scored sample had been
**sustained in deliberation and then fixed**: the model was penalised for being
right.

8.9% is a **floor, not an estimate** — 854 of the 1,085 carry no rationale and
cannot be tested in either direction.

Fixed in `0d82efa3`: the four classes are excluded at the query, `humanLabel` is
renamed `triageLabel`, and the removals are counted (`excludedContaminated`)
so an exclusion can never silently shrink a corpus.

**This is the durable output of the week.** It is a correctness fix, not a
decision instrument — it stops future measurements lying; it does not make the
swap decision measurable.

---

## 3. The rule that already existed and could never fire

`scripts/lib/model-eval/config/adjudicator-thresholds.json` has carried
**`switchIfCostImprovesByPct: 30`** since it was written — versioned, with its own
`calibrationNote`. Flash beats it by more than 2x.

It has never fired, and could not have:

1. It sits in the **promotion** tier's `comparative` thresholds, reachable only
   through a Tier A/B run.
2. Tier A/B requires candidate, baseline and judge to be mutually independent
   lineages. Flash and Pro are both `google:*`; with no independent judge route
   the computed tier is **C**.
3. Tier C is schema-enforced never to emit `switch`.
4. And until `8018e0bc` the harness could not run at all — it passed a
   `repo_uuid` where `audit_repos.id` was required and reported
   `insufficient_ground_truth: 0 rows` against 3,413.

**A rule wired to an instrument instead of to a decision is worse than no rule**,
because it looks like governance. That — not absent doctrine — is the recurring
failure behind six stalled initiatives (arm-eval, model-A/B/C, solo-control, the
bake-off, the tiered-pipeline shadow, and this one).

---

## 4. The gate's authority lives in prose, not code

Load-bearing for the decision, and found while writing this.

- **`audit-loop.mjs`**: `isConverged` is `counts.high === 0 && counts.medium <= 2`
  over **GPT** findings ([audit-loop.mjs:96](../../scripts/audit-loop.mjs)). The
  final review runs afterwards, in Step 7, and its own failure handler prints
  *"This is non-blocking — audit results are still valid."* The verdict is
  bannered and persisted. **Nothing mechanical reads it.**
- **`skills/audit-code/SKILL.md`**: *"`APPROVE` → done. `CONCERNS` → deliberate,
  fix, re-run Gemini. `REJECT` → present to user."*

So the gate is **procedurally blocking and mechanically advisory**: it blocks
only while an agent follows prose, and whether it did is unverifiable after the
fact. This is exactly the prose↔code seam AGENTS.md warns about, in the one place
where it decides how much a model swap can cost us.

An earlier draft of this analysis claimed 32/326 runs "produce a verdict that
changes what ships." **That was wrong** — no code acts on those verdicts. A human
may.

---

## 5. Decision

**Switch to `gemini-3.8-flash`.**

| basis | status |
|---|---|
| Cost improvement 65% vs a pre-registered 30% threshold | **met** *(measured)* |
| Quality equivalence | **NOT ESTABLISHED — and not establishable with current evidence** |
| Gate authority | **advisory in code**; blocking only by prose convention |
| Reversibility | one value; prior configuration recoverable |

**Enacted** as the committed default in `config.mjs` (`latest-pro` →
`latest-flash`), not as a local `.env` override — a gitignored override would
have left the recorded decision taking effect on exactly one machine. A
**sentinel**, per the model-resolution anti-pattern: it tracks the current flash
tier the way `latest-pro` tracked pro, so the floating-ness is unchanged rather
than newly introduced. **Consumers share this bundle**, so wine-cellar-app,
ai-organiser and storyline inherit the switch on their next sync; the reasoning
in §5 applies to them identically, but the blast radius is stated here rather
than discovered later. Revert = restore `'latest-pro'` on that one line.

The quality column is the honest one. Nothing measured here says flash is as good
as pro at final review, and nothing says it is worse. The offline instrument
cannot distinguish either from a constant, and the production path has no
per-finding ground truth (see
[`final-review-self-scoring-gate.md`](../plans/final-review-self-scoring-gate.md),
NO-GO: 98.78% of dismissals are never revisited).

**Why that is acceptable here and would not be for a blocking gate**: the gate
does not mechanically stop anything, its output is advisory input to a human or
an agent, and the switch is reversible in one variable. Were it an autonomous
blocking gate, operational conformance alone would **not** authorize a cost-only
swap and this verdict would be `retain`.

**Revisit triggers** — any one reopens this:
- the final review becomes mechanically blocking (a code path reads `gemini_verdict`);
- a Tier A/B route becomes available (a genuinely independent judge lineage);
- per-finding ground truth appears at scale (labelled outcomes, not triage);
- the promotional flash pricing ends **2026-12-31**, when $0.75/$3.75 becomes
  $1.50/$7.50 and the delta roughly halves.

## 6. What was NOT built, and why

| Considered | Disposition |
|---|---|
| Feature B — persist + grade `gpt_false_positive_count` | **Dropped.** It compares the gate's claim against *dismissals*, i.e. the 83% self-graded column. Would have re-created the §2 defect one layer up. |
| A "finding truth" oracle ranking commit-fix > human > triage | **Rejected.** Those are different kinds of evidence, not ordered strengths: an out-of-scope dismissal says nothing about truth; a fix commit may be cosmetic. Authority and action are not proof. |
| Action Rate / Recurrence Leakage | **Rejected.** The first needs both models on one input — a shadow collector, banned by name. The second needs dismissals to recur; they are terminal here (0 reopens ever follow a dismissal). |
| A 100-run static fixture for proxy checks | **Rejected.** That is the parked bake-off's corpus renamed. Also: 0 failures in 100 trials bounds the rate at ~3% (95%), not <1%. |
| Post-hoc degradation detection as insurance | **Rejected.** A revert path contains *detected* degradation; it is not insurance against the invisible kind. |

Total spend reaching this verdict: **~$0.77** (~$0.64 eval runs, $0.128 two
brainstorm rounds) — under one month of the delta it settles, which is the only
reason it was worth doing at all.

## 7. The generalisable lesson

Six initiatives died trying to measure whether the audit apparatus earns its
cost. Every one of them scored against `adjudication_outcome` believing it was
ground truth, and every one of them attached its decision rule to an instrument
rather than to the moment a decision is made.

**When a decision recurs and no ground truth exists, the durable artifact is a
dated record of what could not be measured — not another instrument to measure
it with.** The next swap should read §5's table, check the revisit triggers, and
either apply the threshold or record why it did not.

The open question worth spending on is not "which model is better at this gate".
It is **"is this gate doing anything"** — answerable by ablation, needing no
labels, no collector and no fixture, and the only proposal on the table that
*saves* money to run.

## 8. Naming debt this exposed (noted, not fixed)

The role is provider-agnostic in BEHAVIOUR — `FINAL_REVIEW_PROVIDER`,
`selectProvider()`, `--provider`, an Opus fallback, a `grok-4.6` shadow arm — but
vendor-named in almost every identifier. A future non-Google reviewer would leave
`gemini_verdict` holding a Claude verdict, which is the same defect class as
`humanLabel` being 86% not-human (renamed `triageLabel` in `0d82efa3`).

Measured surface, so the trade is explicit rather than guessed:

| identifier | files | verdict |
|---|---|---|
| `gemini-review.mjs` (script path) | **172** | **Do not rename.** Synced SKILL.md files name tooling BY PATH, so a rename breaks every consumer until re-sync. Cost far exceeds the benefit. |
| `gemini_verdict` (column) | 25 + a migration | **Do not rename.** Needs a migration and a compatibility window for a cosmetic gain. |
| `GEMINI_REVIEW_MODEL`, `GEMINI_REVIEW_TIMEOUT_MS` | 6, 18 | **Worth aliasing.** These are what a human types and reasons about. |
| `geminiConfig` | 5 | Follows the env vars if they move. |

The cheap, coherent fix is not a new convention — it is **finishing the one that
already exists**: `FINAL_REVIEW_PROVIDER`, `FINAL_REVIEW_SHADOW`,
`FINAL_REVIEW_HARD_DEADLINE_MS` and `CLAUDE_FINAL_REVIEW_MODEL` are already
role-named, and these two env vars are the stragglers. Accept
`FINAL_REVIEW_MODEL` / `FINAL_REVIEW_TIMEOUT_MS` as the documented names with the
`GEMINI_*` spellings kept as working aliases, deprecated in docs only. Non-
breaking, ~24 files, no migration, no consumer break.

Deliberately deferred: the payoff is legibility, and it should be scoped as its
own change rather than smuggled into a model swap.

---

## 9. Reversal — 2026-10-10: the final reviewer runs the best available Gemini

**Decision (owner):** the committed default returns to `latest-pro`, Google's
always-newest Pro alias, resolved at runtime and never a pinned id. This
supersedes §5 for the final-review role only. The GPT auditor (`latest-gpt`,
the balanced `gpt-6.1-sol`; [experiment-7](./experiment-7-gpt-sol-auditor-swap.md))
is deliberately unchanged, and so is the premium `astra` tier, which stays
excluded on cost.

**Why this is not a contradiction of §5:** §5 was a cost decision, and it was
explicit that quality equivalence was *not established*. With quality
unmeasurable either way (§1.1), choosing between "cheaper" and "most capable"
was a policy preference rather than an empirical result. The owner chose
capability for the one gate that reviews everything else's work. That gate
runs about once per audited change, so the cost is the §1.2 delta: about
$27/month *(derived, at July–August volume)* plus the higher per-review latency.

**Enacted as:**
- the committed default in `scripts/lib/final-review-config.mjs`, so it takes
  effect on every machine and every consumer at their next sync, not only on a
  local `~/.audit-loop.env` line;
- a `FINAL_REVIEW_MODEL` override, which still wins: a tenant or consumer can
  opt down to `latest-flash`.

§5's revisit triggers still apply in reverse. If the final review ever becomes
mechanically blocking, or a genuinely independent judge lineage appears, revisit
both the model and its lineage.
