# Arm-eval session 09145de9-5cd1-4b28-8308-b0452f3edc6f

| Field | Value |
|---|---|
| Experiment | brainstorm |
| Phase | prospective |
| Task id | `task-37fa2bb3` |
| Seed (presentation-order RNG) | 2371853983 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-04T20:05:30.234Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

FRAMING: We are NOT trying to run a full academic study. We want cheap TRACTION — a CREDIBLE INITIAL HYPOTHESIS about what is likely going on with LLM code-quality auditing, and a pragmatic way to identify a credible, COST-EFFECTIVE, HIGH-QUALITY solution for code quality. Minimize both LLM spend and human-adjudication time. "Good enough to act on," not "publishable."

WHAT WE HAVE BUILT (context):
- A code-audit "apparatus": a multi-round loop — up to ~3 GPT audit rounds + a Gemini final-review gate, with false-positive suppression across rounds. This is the production path (arm A = GPT-gen -> Gemini review).
- An observation-only A/B/C shadow over real audits: A = GPT+Gemini (baseline), B = OSS-gen -> 1 GPT round -> Gemini, C = OSS-gen -> Gemini. Currently "collecting" (7/12 distinct commit x stage units before it will rank). Runs during real audits, writes to a shared DB. Findings get ledger accept/dismiss labels via the apparatus's own adjudication.
- A brand-new "solo control": clean, cold-diff, SINGLE-ROUND review by the author-class models — Sonnet-5 and Fable-5 (the cheap one) — over the same commits, with NO GPT rounds and NO Gemini gate. This is the null hypothesis the apparatus is justified against: "what does one bare pass of a capable/cheap model catch vs the whole multi-round apparatus?" Backfilling over 5 commits now.
- Planned evaluation: merge all arms' findings for the same commits into a SOURCE-BLINDED, shuffled sheet; a HUMAN adjudicates accept/dismiss + clusters duplicates (no LLM judge, to avoid Claude-judging-Claude bias); then compute per-arm recall-of-accepted, unique-accepted, and apparatus-only-accepted.

THE ASYMMETRY WE JUST NOTICED: the apparatus gets 3 GPT rounds + 2 Gemini passes + suppression; the solo control gets ONE bare pass. So a solo-vs-apparatus comparison conflates MODEL CAPABILITY with ITERATION BUDGET. Single-shot is the realistic "skip the apparatus" counterfactual, but it may understate what a solo model could do with equal iteration.

QUESTIONS:
1. What is the most LIKELY hypothesis about what's going on here, before we have data? (e.g. does multi-round + external-model diversity mostly add recall, mostly suppress false positives, or mostly add noise/cost? Where does the real quality come from — the model, the iteration, the model DIVERSITY, or the adjudication?)
2. Given we want CHEAP credible traction (small N, minimal human time), what is the smallest experimental design + decision rule that would let us act with reasonable confidence? How many commits/findings is "enough" for an initial read? What is the cheapest way to DISENTANGLE the model-capability-vs-iteration-budget confound without running the full matrix?
3. How do we keep it CREDIBLE at small scale — which confounds MUST we control even now (blind adjudication we have; what else — commit selection bias, finding-clustering subjectivity, single-adjudicator bias, ground-truth definition)?
4. What is the likely COST-EFFECTIVE, HIGH-QUALITY answer we should expect to land on for code quality — i.e. what does a good pragmatic setup probably look like (which model, how many rounds, external gate yes/no, when to escalate), and how would we recognize we have credible-enough evidence for it?
5. What is the ONE cheapest high-information experiment to run FIRST?


## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

## Executive synthesis

The most likely story is:

> The apparatus probably improves recall, but inefficiently. Its biggest practical value may be that repeated generation creates more candidate findings and the external gate suppresses the resulting junk. A strong single-pass model may capture most of the material value at much lower cost. The open question is whether the apparatus’s extra accepted findings are genuinely high-value or mostly low-severity residue from more shots on goal.

So do not frame the test as “full apparatus vs one bare solo pass” and overinterpret it. That comparison is operationally useful, because single-shot solo is a real “skip the apparatus” counterfactual, but it confounds:

- base model capability,
- iteration budget,
- model diversity,
- external gating,
- suppression/adjudication effects.

The cheapest credible path is to answer two questions separately:

1. **Is the incumbent first-pass generator worse than the premium solo model?**  
   Use existing round-1 logs if you have them. This is almost free.

2. **Does extra iteration recover the apparatus-only findings?**  
   Add two cold solo passes on the same commits only if the first question does not already make the answer obvious.

---

# 1. Most likely hypothesis before data

## Likely quality drivers, ranked

### 1. Base model capability is probably the largest driver

A capable single-pass reviewer will likely catch a large fraction of useful issues:

- concrete correctness bugs,
- broken assumptions,
- missing edge cases,
- unsafe error handling,
- bad API usage,
- regression risks,
- security/data-integrity footguns,
- meaningful test gaps.

My prior: a strong single pass may catch **70–90% of the material medium/high-value findings** from the full apparatus on ordinary commits.

It will miss more subtle things:

- multi-file contract violations,
- hidden project conventions,
- second-order edge cases,
- interactions across old/new behavior,
- issues in large diffs,
- security or concurrency risks that require adversarial reasoning.

### 2. Iteration adds recall, but with steep diminishing returns

The apparatus gets more attempts. That matters.

But I would expect the curve to look like:

- **round 1:** most of the real value,
- **round 2:** some additional valuable recall,
- **round 3:** smaller marginal gain, more duplicates and speculative findings,
- **later filtering:** necessary because the loop has created noise.

So the apparatus likely wins some recall by having more shots on goal, not necessarily because the whole architecture is intrinsically superior.

### 3. The external gate probably improves precision more than recall

The final external review/gate likely does more of this:

- suppress false positives,
- reject vague/pedantic findings,
- consolidate duplicates,
- normalize severity,
- protect developer trust,

than this:

- discover entirely new issues.

That does not make it useless. If developer attention is expensive, a gate can be highly valuable. But it may be overkill as a default for every diff.

### 4. Model diversity is useful, but conditional

Diversity helps when models have different blind spots. But “different model” is not automatically better.

Likely pattern:

- strong generator + independent verifier: good,
- strong generator + diverse strong verifier: better on risky diffs,
- weak generator + strong gate: may rescue some findings but wastes budget,
- weak generator + weak/no gate: likely poor.

The question is not “is diversity good?” It is:

> Does diversity produce material accepted findings that a cheaper same-model second pass would not?

### 5. Adjudication/suppression improves apparent quality, but can hide cost

Your apparatus’s internal ledger labels are useful operationally, but not neutral enough for evaluation. A system that generates many weak candidates and then suppresses them may look high-quality at the end while still being expensive.

Your planned source-blinded human adjudication is the right correction.

---

# 2. Smallest credible design and decision rule

## Use accepted finding clusters as the unit

Do not score raw findings. Score **clusters** of underlying issues.

A cluster should represent one actionable issue:

- same root cause,
- same affected behavior,
- same likely fix,
- same practical consequence.

Each arm gets credit if it produced a finding that maps to that accepted cluster.

## Minimum arms for a cheap actionable read

You do not need a full matrix. Use this:

### Arm A: full production apparatus

The current multi-round generation + external gate + suppression path.

### Arm R1: incumbent round-1 only

Extract from logs if available.

This is a nearly free “virtual arm” and is very high value because it isolates the first-pass generator from the rest of the apparatus.

### Arm S1: premium solo single pass

One cold pass, same commit/diff context, no gate.

### Arm C1: cheap solo single pass

One cold pass from the cheap plausible default model.

### Optional Arm S3 or C3: solo iteration top-up

Two additional cold independent passes from whichever solo model is the serious replacement candidate.

This is the cheapest way to test the iteration-budget confound.

If quality is the priority, top up the premium solo model.  
If cost is the priority and cheap solo is truly a candidate, top up the cheap model.

## What each comparison tells you

### R1 vs S1

Is this mostly a base-model capability problem?

If S1 beats R1 on material findings and false-positive rate, the apparatus may be compensating for a weaker first pass.

### R1 vs full A

What does iteration + gate + suppression add on top of the incumbent first pass?

If A is much better than R1, the workflow is doing something real.

### S1 vs full A

Operationally: can one good bare pass replace the apparatus for normal commits?

### S3/C3 vs full A

Does equalizing iteration recover the apparatus-only findings?

If yes, the apparatus advantage is mostly iteration budget.  
If no, the apparatus may be getting value from diversity, gating, prompt structure, or workflow.

---

## How many commits/findings is enough?

Do not target only commit count. Target enough accepted clusters.

For a first actionable read:

- **8–12 commit × stage units** is usually enough if they are diverse and produce findings.
- Minimum useful signal: **20 accepted material clusters**.
- Better: **30–50 accepted clusters**.
- Also try to get at least **5–10 medium/high-severity clusters**.
- If 5 commits already produce 30+ accepted clusters, you may have enough for a directional call.
- If 12 commits produce only 8 material accepted clusters, you do not have enough.

Raw findings matter mainly because they drive human workload. Ideally you want enough raw findings to see precision differences, but not so many that adjudication becomes the experiment’s real cost.

## Use a 0/1/2 adjudication scale

Binary accept/dismiss is too coarse because noisy iterative systems can win by producing valid but low-value comments.

Use:

- **0 = dismiss / false positive / unsupported**
- **1 = valid but low-value nit / style / marginal improvement**
- **2 = material defect or meaningful value-add**

Optimize for **2s**, especially medium/high severity.

Report 1s separately so you can see if an arm is winning by nit-spam.

## Core metrics

For each arm:

1. **Material accepted clusters**
   - count of 2-rated clusters.

2. **Medium/high accepted clusters**
   - more important than total accepted.

3. **Observed recall of accepted clusters**
   - accepted clusters found by arm / accepted clusters found by any arm.

4. **Unique accepted clusters**
   - especially full-apparatus-only clusters.

5. **Dismissal burden**
   - dismissed clusters per material accepted cluster.

6. **Severity-weighted utility**
   - simple scoring: high = 5, medium = 2, low = 1, dismiss = negative or tracked separately.

7. **Cost per material accepted cluster**
   - include LLM cost and estimated human triage cost.

## Practical decision rule

Predefine the rule before looking at results.

### Move away from full apparatus as default if a solo/hybrid path gets:

- **≥85–90% of full apparatus medium/high accepted clusters**,
- **no recurring class of serious miss**,
- **zero or at most one high-severity apparatus-only miss**,
- false-positive burden no worse than roughly **1.25–1.5×** the apparatus,
- materially lower total cost/latency, ideally **≤50%** of apparatus cost.

### Keep full apparatus as default if:

- it adds **≥20–30% more medium/high accepted clusters** than the best cheaper path,
- or it uniquely finds multiple high-severity issues,
- and the marginal cost per serious finding is acceptable.

### Most likely outcome

Full apparatus is probably valuable, but not as the default for every commit.

The likely landing zone is:

> single strong pass by default; lightweight verification/gate for surfaced findings; full apparatus only for high-risk diffs or ambiguous cases.

---

# 3. Small-scale credibility controls that matter

You already have the biggest one: **source-blinded human adjudication**.

The additional controls that matter most are:

## 1. Commit selection

Do not select commits because the apparatus looked good or bad.

Use a small stratified sample:

- small / medium / large diffs,
- feature work,
- bug fixes,
- refactors,
- API/integration changes,
- UI/state changes if relevant,
- migrations/schema/data changes,
- auth/billing/security/critical-path code if relevant,
- a few boring low-risk commits.

Even with only 8–12 units, stratification matters.

## 2. Same input context

Each arm should receive the same practical context where possible:

- same diff,
- same surrounding files/context,
- same commit metadata,
- same repo snapshot,
- same instruction about what counts as actionable.

If the apparatus gets richer context, that may be a valid production advantage, but label it explicitly.

## 3. Prompt parity

Do not handicap the solo controls with a weak prompt.

The solo prompt should be production-quality:

- focus on correctness, security, regressions, data loss, test gaps,
- avoid style nits,
- require concrete failure mode,
- require affected code location,
- require why the issue matters,
- require actionable fix direction,
- suppress low-confidence speculation.

Single-pass is a fair constraint. Bad prompting is not.

## 4. Normalize findings before adjudication

Model writing style can leak source identity.

Normalize every finding into a common schema:

- title,
- file/line,
- affected behavior,
- issue mechanism,
- why it matters,
- concrete scenario,
- suggested fix,
- severity,
- confidence.

Remove arm/source identifiers and model-specific phrasing.

Preserve original text in backing data, but keep the adjudication sheet normalized.

## 5. Predefine clustering rules

Cluster before final scoring if possible.

Two findings are the same cluster if they share:

- same root cause,
- same affected behavior,
- same practical fix.

They are separate if:

- one fix would not resolve both,
- they affect different behavior,
- they rely on different failure mechanisms.

## 6. Use targeted second adjudication, not full double review

You do not need two humans on everything.

Cheap credibility upgrade:

Have one human adjudicate all clusters, then a second human reviews only:

- high-severity clusters,
- apparatus-only accepted clusters,
- solo-only accepted clusters,
- ambiguous clusters,
- clusters that would change the decision.

This controls the main single-adjudicator risk without doubling workload.

## 7. Be honest about ground truth

Your ground truth is not “all real bugs in the code.”

It is:

> “Human-accepted, model-surfaced, actionable issue clusters.”

That is fine for traction. You are estimating comparative useful yield, not academic true recall.

---

# 4. Likely cost-effective production setup

The pragmatic setup I would expect you to land on:

## Default path: one strong audit pass

For normal commits:

> one strong model, one strict audit prompt, high actionability threshold.

Report only:

- concrete correctness defects,
- security/data-integrity risks,
- real regression risks,
- meaningful test coverage gaps,
- concurrency/performance issues with specific evidence.

Suppress:

- style advice,
- vague maintainability comments,
- speculative “could possibly” issues,
- generic null-check suggestions,
- low-confidence architecture opinions.

## Then verify only the candidate findings

Instead of always doing a second full audit, run a cheap verifier/gate over the generated findings.

The verifier asks:

- Is this finding supported by the diff?
- Is the failure mode concrete?
- Is it actionable?
- Is severity overstated?
- Is it duplicate?
- Should it be shown, rewritten, or suppressed?

This is cheaper than a full second audit pass and directly attacks false positives.

## Use a second independent pass conditionally

Escalate beyond default when:

- diff is large,
- critical-path files changed,
- auth/payment/data-integrity/concurrency/migration code changed,
- public APIs or contracts changed,
- tests are weak/missing,
- first pass found medium/high issues,
- first pass found nothing but the diff is risky,
- findings are ambiguous,
- release risk is high.

The second pass can be same-model with a different angle, a cheaper breadth pass, or a diverse reviewer if your data shows diversity adds unique material findings.

## Reserve full apparatus for high-risk cases

Keep the full multi-round apparatus for:

- security-sensitive diffs,
- incident/regression fixes,
- large refactors,
- release blockers,
- critical-path changes,
- poorly tested areas,
- cases where solo paths disagree,
- cases where you need high confidence before showing findings.

## Expected end-state

Likely production policy:

1. **Low-risk diff:** cheap or strong single pass, no full gate unless findings appear.
2. **Normal diff:** strong single pass + cheap finding verifier.
3. **Risky diff:** strong pass + independent second pass or external verifier.
4. **Critical diff:** full apparatus.

That gives you most of the quality at much lower steady-state cost.

---

# 5. The one cheapest high-information experiment to run first

Run the **one-pass shootout using existing apparatus round-1 logs**.

## Experiment

For the same commits already in scope, build a source-blinded sheet containing:

1. **Incumbent apparatus round-1 findings only**
   - no later rounds,
   - no external gate,
   - no suppression except basic formatting/dedup for presentation.

2. **Premium solo single-pass findings**
   - cold diff,
   - no gate,
   - same context,
   - production-quality prompt.

3. Optional, if already available:
   - cheap solo single-pass findings,
   - full apparatus final findings.

Human adjudicates clustered findings using the 0/1/2 scale.

## Why this first?

Because it is almost free and isolates the most important question:

> Is the apparatus compensating for a weaker first-pass generator, or is the workflow itself the main source of value?

## Readout

### If premium solo beats incumbent round-1 on material findings and false positives

Then the current apparatus may be adding expensive workflow around a weaker first pass. Next move: test premium solo + cheap verifier, and consider demoting the full apparatus to escalation.

### If incumbent round-1 and premium solo are similar

Then base model capability may not be the main issue. The apparatus workflow may be adding real value. Next move: test whether solo iteration can recover A-only findings.

### If full apparatus beats both single-pass arms by a lot on material findings

Then iteration/gating/diversity is doing real work. But you still need to check whether cheaper solo ×2/×3 can recover the same findings.

## Immediate follow-up if needed

If the one-pass shootout is not decisive, run the **solo iteration top-up**:

- take the strongest plausible solo replacement,
- run two additional cold independent passes on the same commits,
- add only incremental findings to the blinded sheet,
- compare solo ×3 against full apparatus.

That directly answers:

> Is the apparatus advantage mostly iteration budget?

---

## Bottom line

My prior:

- A strong single pass will probably capture most material findings.
- The multi-round apparatus probably adds some recall, but with diminishing returns.
- The external gate mostly buys precision and trust.
- Full apparatus is probably too expensive as the default for every audit.
- The likely best system is **strong single-pass generation + cheap verification + risk-based escalation**.

Act when your pilot shows that the cheaper path captures roughly **85–90% of medium/high accepted clusters**, misses no recurring serious class, and materially reduces cost and false-positive burden.

### output-2

# Cheap Traction on the LLM Code-Audit Apparatus: Combined Pragmatic Read

## 1. Most Likely Hypothesis (Pre-Data)

**The apparatus's value is primarily iteration (repeated sampling), secondarily false-positive suppression, and only marginally model diversity. The marginal cost per additional real finding is probably 3-5x worse than a well-prompted solo model with equal iteration budget.**

### The breakdown

- **Round 1 of any capable model catches 60-75% of accepted findings.** These are the obvious-on-careful-inspection issues: logic errors, missing error handling, API misuse, simple security footguns, maintainability smells. A strong solo single pass is not a toy baseline — it is a serious counterfactual.

- **Rounds 2-3 add recall via stochastic search.** LLM auditing is stochastic: different passes notice different things — alternative edge cases, missed branches, integration issues, weird input/state combinations. Returns diminish sharply: pass 2 adds 15-20%, pass 3 adds <10% with proportionally more noise. This is where iteration genuinely pays, but it's also what the solo control lacks — making the current solo-vs-apparatus comparison conflated.

- **The Gemini gate is primarily a precision filter, not a recall driver.** It suppresses 30-40% of false positives but also kills 5-10% of true positives — especially subtle findings where the verifier lacks context. Its net value is positive but narrow, and **the apparatus's measured quality may be inflated by its own adjudication path** (home-field advantage: its outputs are better aligned with its own gate criteria). The source-blinded human sheet is the right correction.

- **Model diversity (GPT→Gemini cross-review) adds marginal recall** — maybe 5-10% of findings one model class sees and the other doesn't. Real but small, and the most expensive component per marginal finding.

### The asymmetry you noticed is real

A single bare pass is NOT "solo model with 1/5th the budget" — it's "solo model doing its best single pass," which for a capable model is already most of the way there. But it does understate what a solo model could do with equal iteration. The question is whether the apparatus's advantage survives once you give the solo model multiple swings.

### Quality source ranking

1. Diff/context quality and prompt framing
2. Base model capability
3. Independent iteration / repeated sampling
4. Finding schema and dedup/suppression
5. External-model diversity
6. Final gate

The apparatus optimizes items 3-6 but cannot change 1-2. If a solo model with 2-3 passes is already at 85-90% of apparatus recall, the apparatus buys ~10% more at 3-5x cost — likely a bad trade for most diffs.

---

## 2. Smallest Design + Decision Rule

### The core tension to resolve: self-critique vs independent sampling

There are two theories of how iteration helps:

- **Self-critique** (Take A's Solo-2): Round 2 sees round 1's findings, reviews them, finds missed issues. This is sequential refinement — closer to what the apparatus actually does.
- **Independent cold passes** (Take B's S3): 2-3 passes with no cross-talk, unioned. This is stochastic sampling — cleaner scientifically because it isolates "iteration budget" without confounding it with "self-refinement ability."

**Run independent cold passes first.** They give the cleanest signal on the core question: "is the apparatus winning because of better models, or because it gets multiple swings?" If the model is bad at self-critique, a self-critique arm would falsely conclude "iteration doesn't help" when really "self-critique doesn't help but independent sampling would." Independent passes test the pure iteration-budget hypothesis without that confound.

If independent sampling works, self-critique is a cheaper production form worth testing as a follow-up (2 sequential calls vs 3 parallel calls).

### Minimal arms

| Arm | Model | Passes | External Gate | What It Tests |
|-----|-------|--------|---------------|---------------|
| A (existing) | GPT×3 + Gemini | 3+1 sequential w/ suppression | Yes | Full apparatus |
| S1 (existing) | Sonnet or Fable | 1 cold | No | Bare capability |
| **S3 (NEW)** | **Same solo model** | **3 independent cold, unioned** | **No** | **Capability + iteration budget, no diversity** |

Three points define a curve: S1 → S3 → Apparatus tells you the iteration gradient (S1 to S3) and the diversity premium (S3 to apparatus).

### Model choice for S3

If cost is the key question, use **Fable-5** (the cheap one). If quality ceiling is the key question, use **Sonnet-5**. If budget allows, run both — but if forced to pick one, start with whichever you'd actually ship as the default.

### N: how much is enough

**5 commits for a directional read; expand to 8-12 only if ambiguous.** The real threshold is finding density: you want **30-50 accepted issue clusters** across all arms. With 5 commits × 3 arms, if each commit generates 3-8 accepted findings per arm, you're at 45-120 candidate findings — the sweet spot. If commits are sparse (1-2 findings each), bump to 8-10.

Don't exceed 12 commits for this initial read. Marginal information drops fast.

### What to adjudicate

Pool all findings from A, S1, S3. Then:

1. **Normalize** each finding into a concise claim (one-line summary).
2. **Strip source** and shuffle.
3. **Cluster duplicates** source-blind, BEFORE labeling (see clustering rule below).
4. **Human adjudicates each cluster**: Accept / Dismiss / Unclear.
5. **Human assigns own severity** (not the model's): High (correctness/security/data-loss), Medium (plausible bug/regression), Low (minor/clarity/defensive).
6. Map cluster back to arms.

### Key metrics

- **Accepted-cluster recall**: fraction of all accepted clusters this arm found.
- **Apparatus-only accepted clusters**: direct value of keeping the apparatus.
- **Solo-only accepted clusters**: where the apparatus is blind.
- **Cluster-level precision**: accepted / submitted clusters.
- **Cost per accepted cluster** (and per medium/high cluster).
- **Human-review burden**: how many candidate clusters each arm forces downstream inspection of.

### Decision rule

Decide based on **high+medium severity recall**, not all-findings recall. If solo catches 95% of criticals but only 60% of nitpicks, that's a clear "simplify" signal.

```
IF S1 recall(high+medium) ≥ 85-90% of apparatus
   AND S1 misses zero high-severity accepted findings
   AND S1 precision ≤ 1.3x worse than apparatus
→ SHIP SOLO SINGLE-PASS. Maximum savings. Apparatus is overbuilt.

IF S1 recall is 60-80% of apparatus
   AND S3 closes gap to ≥85-90% of apparatus
→ SHIP SOLO MULTI-PASS. Iteration matters; diversity doesn't.

IF S1 recall is 60-80% of apparatus
   AND S3 does NOT close the gap
→ KEEP A TRIMMED APPARATUS for risky diffs. Diversity/gate matters.
   But still cut round 3 and gate only criticals.

IF S3 recall ≈ apparatus BUT S3 precision is materially worse
→ SOLO MULTI-PASS + SELECTIVE EXTERNAL GATE on high-severity findings.

IF S1 < 60% of apparatus even after S3
→ KEEP THE APPARATUS for high-risk diffs. Complexity is justified there.
```

Also check: **if apparatus-only accepted findings are all low severity, the apparatus "wins" but isn't worth the cost.**

---

## 3. Credibility Controls at Small Scale

You have source-blinded adjudication — the biggest one. Here's what else:

### Must-control (non-negotiable)

1. **Commit selection bias.** Don't cherry-pick. Use a predeclared sample: recent chronological, or stratified by size/risk, or "next N eligible real audits." Span: 1 large refactor (>200 lines), 1 small bugfix (<30 lines), 1 feature with new files, 1 config/infra change, 1 security/error-handling-adjacent change. Record diff size, language, risk category, whether tests changed. At small N, one monster commit can dominate.

2. **Same context budget for all arms.** Same files, surrounding lines, commit message, test files, dependency context, prior-stage context. Otherwise you measure context quality, not model quality.

3. **Cold independence for S3.** Each pass gets no previous findings, no hidden apparatus labels, no cross-arm leakage. Fixed prompt family. Same temperature/sampling. You want independent search, not self-revision.

4. **Cluster-level adjudication.** Do NOT adjudicate raw findings independently — verbose-duplicate arms get unfair influence. Write a 3-line clustering rule before adjudication: *"Two findings are duplicates if they reference the same code location (function or line range) AND the same defect category (resource leak, logic error, injection, etc.). Severity differences don't make them non-duplicates."* Cluster BEFORE labeling accept/dismiss.

5. **Severity calibration.** The apparatus may label "critical" what solo labels "important." The human adjudicator must assign **their own severity** to each accepted cluster, independent of what the arm reported. Use the adjudicator's severity for all comparisons.

6. **Pre-declare "accepted" rubric.** Before adjudication, write one paragraph: *Accepted = a maintainer would reasonably consider this a real, actionable code-quality issue worth fixing or explicitly deciding not to fix. Dismiss = incorrect, speculative, purely stylistic, or not actionable.* This prevents post-hoc debates.

### Should-control (strongly recommended)

7. **Adjudicator fatigue and anchoring.** Randomize finding order. Split into two sessions. Have the adjudicator re-label 10% at the end — if they flip on >20%, labels are noisy. Additionally, a second human reviews all high-severity accepted clusters, all uncertain clusters, and a random 10-20% sample. If disagreement is high, data isn't reliable yet.

8. **Arm-specific finding density.** If one arm generates 40 findings and another 8, raw volume will bias the human's perception even blind. Present findings one at a time, not grouped by commit. Don't reveal per-arm counts until after adjudication.

9. **Paired analysis by commit.** Don't treat 100 findings as 100 independent data points. Report per-commit deltas: "Commit X: A found 4 accepted, S1 found 3, S3 found 5." Prevents one noisy commit from fooling you.

10. **Capture pre-gate and post-gate apparatus outputs.** Log raw generated findings, suppressed findings, and final emitted findings for the apparatus. If you only see final output, you cannot tell whether the Gemini gate is helping or hiding value.

### Acknowledged limitation (don't try to fix)

11. **No true ground truth.** You're using human adjudication as proxy. At small N, you can't measure whether the adjudicator is "right." You don't need to. You need **consistency** — the same person applying the same rubric to all arms — not accuracy. A biased-but-consistent adjudicator gives valid *relative* comparisons, which is all you need for "good enough to act on."

---

## 4. Likely Cost-Effective Answer

### Predicted architecture: tiered pipeline, not universal heavy apparatus

```
Cheap/medium model, 1-2 cold passes (primary review)
    → deterministic dedup + severity filter
        → low severity: emit directly
        → medium/high: external-model gate (1 round, different model family)
        → high-risk diff or high-severity: escalate to stronger model or human
```

**Components:**

- **Default reviewer:** Fable-5 for normal diffs (if quality is close enough), Sonnet-5 for medium-risk diffs. 1 cold pass for small/simple, 2 independent cold passes for medium-risk.
- **External gate on medium/high findings ONLY:** Different model family reviews findings the primary marks medium or higher. Cheap (medium+high are ~20-30% of findings) and catches the most damaging false positives. Drop universal gating.
- **Drop:** GPT round 3. Gemini review of low-severity findings. The multi-round suppression loop for non-criticals.
- **Escalation triggers:** large diff, auth/security/payments/data-deletion/concurrency changes, public API modifications, weak tests, release-critical commits, or model confidence is low.

**Expected cost:** ~30-40% of current apparatus. **Expected recall:** ~85-95% of apparatus on high+medium findings, ~75-85% on all findings.

### How to recognize credible-enough evidence

You're done when you can answer: *"If I shipped the cheaper setup tomorrow, what's the worst case?"* — and the answer is: *"I'd miss ~X% of high-severity findings, and the ones I'd miss are [category]."*

**Concrete stop signals:**
- Recall gap on high+medium findings is <10% → ship it.
- Adding any component (round, model) adds <2 accepted high+medium clusters across the test set → that component isn't worth it.
- Precision within 1.3x of best arm → good enough; don't optimize further.
- Apparatus-only wins are mostly low severity → even if apparatus "wins," it's not worth the cost.
- Results hold over 8-12 diverse commits or 30-50 accepted clusters.

**Safer production rollout:** Move default traffic to the cheaper setup, keep the apparatus as an escalation/sampling path, and monitor apparatus-only high-severity deltas for a few weeks. Don't delete the apparatus on day one.

---

## 5. The ONE Cheapest High-Information Experiment to Run FIRST

**Run S3 (3 independent cold solo passes, unioned, no external gate) on the same 5 commits you're already backfilling.**

You already have:
- Apparatus findings (arm A) — done or in progress
- Solo-1 findings — backfilling now

Adding S3 costs **~10 LLM calls** (5 commits × 2 additional passes) and adds maybe 15-25 more findings to the adjudication sheet — marginal human time since you're already adjudicating.

### Why independent cold passes, not self-critique

Self-critique (round 2 sees round 1 and revises) conflates two things: iteration budget AND the model's self-refinement ability. If the model is bad at self-critique, you'd conclude "iteration doesn't help" when really "self-critique doesn't help but independent sampling would." Independent cold passes isolate the pure question: **does giving a solo model multiple swings close the gap to the apparatus?**

If independent sampling works, self-critique is a cheaper production variant worth testing next (2 sequential calls vs 3 parallel). But for the initial read, you want the cleanest signal.

### The curve is immediately actionable

| Curve Shape | What It Means | Action |
|---|---|---|
| S1 ≈ S3 ≈ apparatus | Apparatus is over-engineered | Ship S1. Max savings. |
| S1 → S3 jumps a lot, S3 ≈ apparatus | Iteration is the driver, diversity is marginal | Ship solo multi-pass. |
| S1 → S3 barely moves, S3 << apparatus | Solo model hits a ceiling. Diversity/gate matters. | Keep cross-model step for risky diffs. |
| S1 → S3 jumps, but S3 still << apparatus | Both iteration AND diversity matter | Keep apparatus but optimize (cut round 3, gate only criticals). |
| S3 recall ≈ apparatus but S3 precision much worse | Generation is fine, verification is the gap | Solo multi-pass + selective external gate. |
| Apparatus-only accepted findings are all low severity | Apparatus "wins" but not worth the cost | Ship cheaper setup anyway. |

**Total cost:** ~10 LLM calls + ~30 minutes additional adjudication. This single experiment resolves the core question — "is it the model, the iteration, or the diversity?" — well enough to act on. Everything else is refinement.

### output-3

# Cheap Traction on LLM Code Audit: Apparatus vs Solo

## 1. Most likely hypothesis (prior to data)

Both priors converge on the same core claim: **the multi-round loop is mostly buying noise, and the real quality is coming from either (a) a single strong generation pass or (b) the cross-family gate's false-positive suppression.** Where they disagree is whether the gate is *essential precision infrastructure* or a blunt instrument that also kills valid findings. That disagreement is itself the highest-value thing to resolve.

Stacked priors, in order of where quality actually originates:

1. **Base model capability on round 1** — a single frontier pass on a well-framed diff likely catches ~80-85% of the *meaningful* logic bugs the whole apparatus catches. Forced iteration past round 1 produces diminishing returns on true positives and exponential growth in false positives; models "feel obligated to say something" and descend into pedantry or hallucination.
2. **The cross-family gate (Gemini)** — this is the precision engine. It suppresses hallucinations that bare passes produce. The open question is how many valid nuanced TPs it kills alongside the FPs. This is genuinely uncertain and worth measuring.
3. **Model diversity (GPT-gen → Gemini-review)** — different families have complementary blind spots, but the marginal value of *generation-side* diversity (GPT vs Sonnet as the generator) is probably small compared to the value of the gate.
4. **Iteration / multi-round** — likely the lowest-value, highest-cost component. Rounds 2-3 mostly produce near-duplicates, rephrasings, and incremental elaborations. Without aggressive suppression, they flood the adjudicator.

**Net hypothesis:** The apparatus achieves *comparable recall with higher precision* than solo, but most of that precision is bought by the gate, not by GPT rounds 2-3. The solo control will likely show *different* recall (catching some apparatus misses, missing others) with a noisier precision profile — which is exactly what a gate fixes cheaply. The apparatus is over-engineered for an era when single-pass capability was weaker; today, the loop is solving a problem you may no longer have.

## 2. Smallest experimental design + decision rule

**Do not run the full matrix.** You need two new arms, not eight. Both are cheap and together they factorially disentangle model-capability vs iteration-budget vs gate-value:

| Arm | Generator | Rounds | Gate | Tests |
|---|---|---|---|---|
| **A** (existing) | GPT | 3 | Gemini | Baseline apparatus |
| **Solo** (existing) | Sonnet-5 | 1 | None | Null control |
| **D** (new, cheap) | Sonnet-5 | 1 | Gemini | Value of gate alone |
| **E** (new, cheap) | Sonnet-5 | 3 parallel samples @ temp 0.7, unioned | None | Value of iteration budget without GPT |

- **Arm D** isolates: *is the apparatus's value in GPT iteration, or in the cross-family gate?* (Take A's key experiment.)
- **Arm E** isolates: *does iteration budget matter at all, and can you get it via parallel sampling instead of sequential rounds?* (Take B's key disentangler.) Parallel sampling is cheaper than sequential rounds and avoids the "forced to say something" failure mode.

**N target:** 10-15 commits, yielding ≥40 unique *accepted* findings post-clustering, with at least ~15 critical-severity accepted findings. Below that, you can't distinguish a real gap from clustering noise. 10-15 commits is enough for an operational pivot decision; you are not publishing.

**Decision rule (pre-register before unblinding):**
- If Arm D high-sev recall is within **10pp of Arm A** AND precision within 10pp → kill GPT rounds, adopt Solo-Sonnet + Gemini gate. Done.
- If Arm D lags >15pp on high-sev but Arm E closes the gap → iteration matters; replace the sequential loop with parallel sampling.
- If Arm D lags >15pp on high-sev and Arm E doesn't close it → the GPT generator genuinely matters; investigate further, but only then.
- If Arm D ≈ Arm A but precision is *worse* without the gate (Arm E vs Arm D) → the gate is essential; keep it regardless of what happens to GPT rounds.

## 3. Confounds you MUST control even now

Blind adjudication is correct and necessary. Six others will quietly invalidate your read at N=12:

1. **Commit selection bias.** If commits were chosen because the apparatus flagged them or they're known-buggy, you're sampling from the apparatus's strength distribution. Sample on metadata only (random merged PRs, ≥50 LOC diff, last 30 days). Do not let audit results inform selection.
2. **Severity grading — not optional.** Accept/dismiss alone is insufficient. A model that finds 10 valid nits and misses a race condition looks "better" on raw recall than one that finds the race condition and hallucinates once. Adjudicators must label **Critical/Logic (1), Style/Nit (2), False Positive (0)**. Optimize *only* for recall of 1s and precision overall. Low-sev recall is noise that will mislead you.
3. **Clustering subjectivity is the silent killer.** The adjudicator's clustering decisions *are* your recall numbers — loose clustering makes every arm look redundant; tight clustering makes every arm look unique. Pre-register a clustering rule keyed on (file, line range, defect-type) before unblinding. Cluster against a defect schema, not vibes.
4. **Information parity.** If the apparatus can fetch full files or repo context and the solo model only gets the git diff, the experiment is invalid. Ensure identical context windows across all arms.
5. **Commit typology.** Hand-pick to ensure at least 3 categories: algorithmic/logic (reasoning matters), state/DB migrations (side-effects matter), refactoring/boilerplate (where models hallucinate ghost bugs). Don't let all 10 commits be the same type.
6. **Single-adjudicator drift + fatigue.** At 10-15 commits you'll have hundreds of findings. Adjudicators become more lenient over time. Shuffle across the entire sheet, track accept-rate by adjudication order, and send only low-confidence findings (~15-20%) to a second reviewer. Cheap insurance.

## 4. The likely cost-effective, high-quality answer

Prediction, ~70% confidence:

- **One generation pass** of a capable frontier model (Sonnet-5 or GPT-class — close enough that cost should decide).
- **One cross-family review pass** for false-positive suppression — *but* test whether a ruthless system prompt ("You are a ruthless Staff Engineer. Only flag code that will cause a production outage, security breach, or severe performance regression. If there are none, output an empty array. Do not comment on style.") achieves equivalent FP suppression without the gate. If it does, drop the gate too.
- **No sequential multi-round loop.** If iteration matters at all, get it via parallel sampling (2-3 independent passes, unioned), not sequential rounds that force output.
- **Escalation rule:** if first pass produces >6 findings or findings span >3 files → trigger a second pass or human review. Otherwise stop.
- **Keep ledger labels** flowing back as a weak signal for future filtering — free data.

**Recognizing "credible enough":** when, on the critical-severity bucket, the cheap arm is within 10pp of apparatus recall AND within 10pp precision, on the same commits, AND the adjudicator confirms the cheap arm's misses are predominantly low-severity or edge-case. At that point you have a defensible production change. You do not need a larger sample to stop doing something expensive that isn't earning its keep.

## 5. The ONE cheapest high-information experiment to run FIRST

**Run Arm D — Solo Sonnet-5 (1 pass) + Gemini gate (1 pass) — on the same commits already in flight.**

Why this one first, not Arm E:
- It's the cheapest possible apparatus variant (delete all GPT, keep the gate).
- It directly tests the highest-leverage question: *is the apparatus's value in GPT iteration, or in the cross-family gate?*
- It maps to the production change you'd actually make if it works (delete GPT rounds, swap in Sonnet).
- It reuses existing infrastructure (the Gemini review pass exists; feed it Sonnet output instead of GPT).

**Operational constraints:**
- Backfill over the **same commits already in the solo-control backfill**, not new ones, so all arms cover identical diffs. Same-diff comparison is what gives you clean signal at small N.
- Pause the OSS A/B/C shadow if it's competing for adjudication bandwidth — OSS models are likely adding noise to your baseline at this stage.
- Grade everything Bug(1)/Nit(2)/FP(0). The decision hinges on recall of 1s.

**If Arm D ≈ Arm A on critical-sev recall and precision:** kill the GPT rounds. You have your answer in ~2 days at trivial cost. **If Arm D ≪ Arm A:** *then* run Arm E to isolate whether it's GPT-the-model or iteration-budget-that-matters. Don't pre-spend on that question — it's conditional on Arm D failing.

