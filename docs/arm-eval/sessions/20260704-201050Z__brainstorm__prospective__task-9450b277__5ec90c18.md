# Arm-eval session 5ec90c18-65fc-4f07-8735-d411aae6be4c

| Field | Value |
|---|---|
| Experiment | brainstorm |
| Phase | prospective |
| Task id | `task-9450b277` |
| Seed (presentation-order RNG) | 726799559 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-04T20:10:50.240Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

DEBATE ROUND. You largely AGREED in round 1 (apparatus buys recall-through-iteration; run a same-model-x3 arm; drop the apparatus if iterated-solo hits ~80-85% accepted recall cheaper). Agreement is cheap — now find the real DISAGREEMENTS. React directly to the other model's position AND to Claude's three additions. Be specific and take a side; do not just agree-and-add.

Claude's three additions to attack or defend:
1. Do the cheapest thing FIRST — mine the EXISTING adjudicated ledger (hundreds of already-labeled arm-A findings tagged by stage/round): decompose accepted findings by round (1 vs 2-3) and by origin (GPT vs Gemini gate). Zero new LLM spend. Claude claims this may answer "where does quality come from" before any new experiment is worth running.
2. "Accepted" by a human skimming a finding measures PLAUSIBILITY, not truth. Claude says: verify the ~10 highest-severity accepted findings against reality (read the path / 5-line repro) to calibrate whether accept-labels track real defects — else every recall number is theatre.
3. The experiment's OUTPUT should be a per-class, precision-weighted ROUTING TABLE (cheap-solo for nits, escalate to apparatus only for the risk classes where it adds unique high-severity recall), NOT a single global "winner." And in a dev-loop tool the dominant COST is human-minutes-on-false-positives + latency, not tokens — so PRECISION, not recall, should headline the decision rule.

SPECIFIC TENSIONS TO RESOLVE (pick sides):
A. Cheapest credible FIRST step: a retrospective query of existing labels (Claude) vs a new same-model-x3 experiment (both of you)? Can the retrospective query actually disentangle iteration-from-capability, or is it fatally confounded by survivorship (we only have labels for what the apparatus surfaced)?
B. Should PRECISION or RECALL headline the decision rule for a dev-loop tool?
C. Gemini said use a cheap LLM to pre-cluster findings before the human; Claude said that clusterer becomes the load-bearing judge of the unique-vs-overlap metric. Who is right, and what is the minimal safe version?
D. Is single-adjudicator + a 10-20% second-rater check (GPT) enough, or is single-adjudicator bias fatal to credibility at this N?


## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

# Combined Take: What to Actually Do, and Why the Round-1 Consensus Was Premature

## The core correction

Round-1 agreed too fast: "run same-model-x3, drop the apparatus if it hits ~80-85% accepted recall cheaper." That rule is under-specified in four ways that matter:

1. **Accepted ≠ true.** Without verification, 80-85% accepted recall could mean 80-85% of plausible hallucinations. Apparatuses generate *convincing* findings — that's what they're optimized for. A human skim measures plausibility, not defect reality.
2. **Global recall hides class-specific value.** The apparatus might be worthless for style nits and essential for concurrency bugs. A global winner forces a bad average.
3. **Token cost ≠ real cost.** In a dev-loop tool, human review-minutes on false positives and latency dominate. A tool that saves $0.20 in tokens while wasting five engineer minutes is a bad tool.
4. **Same-model-x3 is not the cheapest credible first step.** We already have hundreds of adjudicated findings tagged by stage and origin. Spending new LLM calls before mining that ledger is backwards.

---

## Tension A: Retrospective ledger first — yes, but it can't answer the causal question alone

**Side: Run the retrospective first, but pre-commit to the experiment regardless of its result.**

Claude is right that it's free and high-leverage. The retrospective can answer:

- What fraction of accepted findings first appeared in round 2-3 vs round 1?
- Does acceptance rate collapse in later stages (precision decay)?
- Does one gate model originate high-severity findings while the other mostly vetoes?
- Are later-round findings materially different (security/concurrency) or just more nits?

If rounds 2-3 contribute <15% of accepted findings, the apparatus case dies immediately and the experiment becomes unnecessary. That's a real possibility the retrospective can settle for free.

**But the retrospective is fatally confounded for the deeper question.** The ledger only records what the apparatus *surfaced* — not what it suppressed. Round 2-3 outputs are structurally conditioned on round 1's output (sequential dependency). You have zero data on findings the gating model filtered out, or that round 2 refined away. So:

- "Round 1 contributed most findings" is *expected* under the dependency structure, not evidence against iteration value.
- "Round 2-3 added high-severity findings" tells you the apparatus has internal marginal yield, but not whether solo-model-x3-independent would match it.

**Resolution:** Retrospective is necessary and free, so it goes first. But its null result is confounded and its positive result is insufficient. Pre-commit to the targeted same-model-x3 experiment (see Step 3) regardless.

---

## Tension B: Precision or recall as headline?

**Side: Neither. Headline should be "recall at a fixed precision floor," per defect class, severity-weighted.**

Claude is right that precision matters for adoption: a noisy tool gets ignored, and once trust collapses, theoretical recall is moot. But making raw precision the headline optimizes toward a trivially satisfiable failure mode — a tool that reports 1 finding (always real) has 100% precision and near-zero recall. False confidence is worse than noise; you can triage noise, but you can't un-miss a defect you never saw.

The correct framing: **maximize recall subject to precision ≥ floor (e.g., 70%), per defect class, weighted by severity.** This captures the cost concern (the floor prevents FP-driven abandonment) while preventing the precision-optimization trap. Precision is a *constraint*; recall is the *objective*; severity is the *weight*; defect class is the *partition*.

For high-severity classes (security, data loss, concurrency, auth), you may lower the precision floor — the expected cost of a miss dominates. For low-severity classes (style, docs), you raise the floor — the expected cost of review dominates. This is the routing table, not a global winner.

---

## Tension C: Pre-clustering — presentation only, no merge authority

**Side: Claude is right that a cheap LLM clusterer with merge/drop authority is dangerous. Gemini's instinct to use it for labor-saving is right only if it has zero write power.**

The risk: the clusterer becomes the load-bearing judge of the core unique-vs-overlap metric. Clustering errors attack exactly where the decision is most fragile:

- Merging distinct bugs → apparatus looks less useful
- Splitting duplicates → apparatus looks more useful
- Textual similarity misses semantically identical findings
- Semantic similarity collapses distinct root causes

**Minimal safe version:**

1. **Presentation-only clustering, zero deduplication authority.** The cheap LLM assigns findings to display groups. The human sees every finding. Duplicates in the same cluster are dismissed in 2 seconds instead of 20. Mis-grouping costs seconds, not recall points.
2. **Blind the clusterer and the human to arm identity** (solo vs apparatus, round 1 vs 2-3, GPT vs Gemini) to prevent subconscious bias toward the fancier system.
3. **Report results under strict and liberal matching bands** (same file/function/root-cause vs same failure mode). If the conclusion flips under matching policy, your conclusion is not stable.
4. **Manually verify every "apparatus-unique high-severity" finding.** No automated clusterer is allowed to create the headline claim.

The clusterer is scaffolding for human attention, not a judge of the metric.

---

## Tension D: Single adjudicator + 10-20% second rater — sufficient *only* with a reality check and stratified sampling

**Side: Single adjudicator is fine for bulk labeling. A random 10-20% second-rater check is mostly theatre. The reality check on high-severity findings is the non-negotiable.**

At N=50-200 findings, single-adjudicator is statistically adequate for catching *random* error. But the real risk is *shared systematic bias* — both raters accept findings that "look like real bugs" (plausible code paths, familiar vulnerability patterns). Inter-rater agreement measures *consistency*, not *correctness*. A second rater who shares the same blind spot will agree on wrong answers.

**The fix is two-layered:**

**Layer 1 — Stratified, adversarial second-rater sample (not random):**
- All high-severity accepted findings
- All apparatus-unique accepted findings
- Sample of rejected findings (especially later-round rejections — check for false negatives)
- Sample of cluster boundaries / duplicate decisions
- Cases near the accept/reject threshold

**Layer 2 — Reality check (Claude's addition #2, non-negotiable):**
For the top findings, require:
1. Path exists
2. Cited code behavior exists
3. Concrete failure mode is real
4. Repro or reasoning chain is valid
5. Severity is not inflated
6. Issue is reachable, not merely hypothetical

Audit set: top 10 highest-severity accepted + all criticals (if fewer than 10) + several apparatus-unique accepted + several solo-unique accepted (if available) + a few rejected-but-plausible high-severity findings (to catch false negatives).

**Decision rule:** If <70% of "accepted high-severity" findings survive real verification, the entire recall number is plausibility-theatre. Re-rate everything with a stricter bar before drawing conclusions.

The second rater is a guardrail for sloppy errors. The reality check is calibration against ground truth. Don't confuse them.

---

## What to actually do (sequence)

### Step 1: Ledger analysis — zero new LLM calls

Produce:

| Cut | What it tells you |
|---|---|
| Accepted findings by round (count + severity-weighted) | Does iteration contribute? |
| Acceptance rate by round | Where is precision decay? |
| Accepted unique yield by round (post-manual-dedup) | Marginal value of later stages |
| Class distribution by round | Are later rounds adding security/concurrency or just nits? |
| Origin/gate analysis | Does one model originate value while the other vetoes? |
| Rejection concentration | Where does the apparatus waste human attention? |

**Possible outcomes:**
- Late rounds add little accepted value → apparatus dies for dev-loop use; same-model-x3 may not be worth running.
- Late rounds add low-severity value → route only low-cost classes to solo; apparatus not justified globally.
- Late rounds add high-severity unique findings → run same-model-x3 *on those classes only*.
- One gate dominates accepted high-severity → test model substitution, not apparatus complexity.

### Step 2: Truth audit — before any recall claim

Verify the audit set described above. If the accepted-to-real conversion rate is poor, tighten adjudication before running any new experiment. Every recall number computed on unverified accept-labels is theatre.

### Step 3: Targeted same-model-x3 — only where the ledger shows marginal value

Do not run same-model-x3 globally. Run it only for the classes/stages where the ledger suggests the apparatus produces marginal yield. The key comparators are not just solo vs apparatus:

1. **Solo x1** (baseline)
2. **Same-model x3 independent samples** (tests: more draws)
3. **Same-model iterative x3 with self-critique** (tests: iteration without multi-model)
4. **Current apparatus** (tests: full pipeline)

This separates four confounded variables: more samples, iteration, cross-model diversity, and gating/scaffolding. "Iteration" and "more draws" are not the same thing, and the round-1 consensus conflated them.

### Step 4: Output — per-class routing table, not a global winner

The decision artifact is:

| Finding class | Default route | Escalate when | Precision floor | Rationale |
|---|---|---|---|---|
| Style/nits | cheap solo | never | high | review cost > miss cost |
| Docs/comments | cheap solo | never | high | low severity, high miss tolerance |
| Simple correctness | solo + one retry | critical path touched | medium | moderate value |
| Security/auth | apparatus | reachable / privilege boundary | low (accept noise) | miss cost catastrophic |
| Concurrency | apparatus | shared mutable state / async | low | subtle interactions need iteration |
| Migrations/data loss | apparatus | risky diffs | low | high blast radius |
| Performance | solo first | hot path / algorithmic change | medium | speculative perf FPs are costly |
| API compatibility | apparatus (public) / solo (internal) | public interface | medium | high user impact |

Each row includes: expected precision, expected severity-weighted true-positive yield per human minute, latency, confidence interval.

**The decision rule is not "drop the apparatus if same-model-x3 hits 80-85% accepted recall cheaper."** It is:

> Keep the apparatus only for defect classes where manually-verified, severity-weighted true-positive yield per human review minute exceeds the cheap-solo baseline by a meaningful margin. Drop it everywhere else.

---

## Where this combined take breaks from round-1 consensus

| Round-1 consensus | Correction |
|---|---|
| Run same-model-x3 next | Mine the ledger first; run same-model-x3 only where the ledger shows marginal value |
| 80-85% accepted recall → drop apparatus | Recall must be verified, not just accepted; decision is per-class, not global |
| Token cost comparison | Human-minutes + latency dominate, not tokens |
| Clustering to reduce review set | Presentation-only, no merge authority; blind to arm identity |
| Single adjudicator + 10% check | Stratified adversarial sampling + reality check on high-severity tail; random 10% is theatre |
| "Iteration" as one thing | Separate more-draws from iterative-critique from multi-model-diversity |

### output-2

# The Combined Take: Where the Apparatus Lives or Dies

## A. Retrospective First? No — It's a Parallel Side-Quest, Not a Gate

Claude's instinct to mine the existing ledger is understandable — zero new spend, existing labels. But **the survivorship confound is fatal for the core question**, and both prior takes saw this from different angles without fully reckoning with it.

The ledger records *when the apparatus surfaced accepted findings*, not *when findings were discoverable*. If a gate killed a real defect in round 1 that round 2-3 would have independently surfaced, the ledger credits iteration. If a solo model would have found the same round-1 finding with a self-correction pass, the ledger credits the apparatus. There is no counterfactual arm in the data. **Retrospective data without a control group doesn't narrow the question — it manufactures false confidence in either direction.**

One narrow exception worth exploiting for free: the **GPT-vs-Gemini gate decomposition** is a within-adjudication-layer comparison, not confounded by survivorship in the same way. If one gate's findings have a 2x higher accept rate, that's a direct signal about gate quality. Run that query in parallel — it costs nothing and may inform the experiment design — but do not let it gate the experiment.

**Decision: Run the same-model-x3 experiment immediately as the primary. Run the GPT-vs-Gemini ledger decomposition in parallel as a free side-quest. Do not treat retrospective round-decomposition as a go/no-go gate — it cannot answer the question it's being asked.**

## B. Precision Headlines — But the Routing Table Is Wrong; Fork the Deployment

Claude is right that precision is the binding constraint for a dev-loop tool: developer trust is non-renewable, and three false positives in a PR review permanently kills the tool. But the **per-class routing table is a logistical trap**. You don't know a finding's severity class until *after* the model has analyzed it. Running solo + apparatus sequentially destroys latency; running them concurrently destroys the cost savings the routing was supposed to deliver. The routing table optimizes a theoretical cost function that doesn't survive contact with a CI/CD pipeline.

The cleaner answer is a **deployment fork**:

1. **Dev-loop (PRs):** High-precision, low-latency solo model only. The apparatus is banned here regardless of its recall advantage — human-minutes and latency are the dominant costs, and the trust budget is too scarce to risk on a 70% precision apparatus.
2. **Nightly async:** Run the heavy apparatus here, where latency is zero and human-interruption cost is zero. Findings surface in a separate queue, reviewed with lower urgency.

This resolves the tension cleanly: the apparatus earns its keep on unique high-severity recall in the async lane, and the solo model owns the dev-loop lane on precision. No dynamic routing needed.

**On the metric itself:** Raw precision is necessary but insufficient. The headline should be **minutes-to-first-real-bug** — how long a developer spends reviewing output before hitting an actionable defect. This penalizes false positives (wasted minutes), rewards true positives ranked early, and captures **ranking quality**, which neither precision nor recall measures. A tool with 70% precision that puts real findings first beats a tool with 85% precision that buries them on page 3. Set a per-class recall floor for the nightly lane (e.g., ≥80% for high-severity classes) so the apparatus doesn't get cut for bleeding recall on the classes that matter.

## C. The Pre-Clusterer: Deterministic First, Expensive Model Second, Manual for the Scoring Sample

A cheap LLM clusterer is reckless. If it aggressively merges distinct SQL injection variants in the same file, it suppresses the apparatus's unique recall. If it fails to merge semantically identical bugs described differently, it inflates recall. **The clusterer becomes the load-bearing judge of the metric you're optimizing — and it's the cheapest, least-reliable component in the pipeline.**

The minimal safe version is a **three-tier dedup**:

1. **Tier 1 (deterministic):** Group by `[File] + [Function]` — zero LLM involvement, zero error.
2. **Tier 2 (expensive model, within deterministic groups only):** Use your *smartest* model, not a cheap one, with a strict prompt: *"Do these two findings describe the exact same defect mechanism? If one is fixed, does the other disappear?"* This limits the expensive model's scope to small, bounded comparisons.
3. **Tier 3 (manual):** For the 20-30 highest-severity findings — the ones that drive the decision — deduplicate manually. No model touches the scoring sample for the findings that matter most.

A cheap LLM may still be used for **presentation only** (grouping findings for the human adjudicator's convenience in the UI), but its output must never feed the recall calculation. UX corruption is tolerable; metric corruption is fatal.

## D. Adjudicator Bias: Double-Blind the Disjoint Set, Auto-Accept the Overlap

Single-adjudicator + 10-20% second-rater is a training-set labeling practice, not a product A/B test practice. The entire ROI of the apparatus hangs on the **disjoint set** — the bugs the apparatus found that the solo model missed, and vice versa. That's where confirmation bias is most dangerous: the adjudicator knows the apparatus is "supposed to be smarter" and will squint and accept marginal findings. A 20% concordance check detects random disagreement, not **systematic shared bias** — if both raters share the same mental model, they'll agree on wrong answers and the concordance rate will look pristine while measuring nothing.

The efficient solution focuses adjudication effort where the delta lives:

1. **Auto-accept overlaps:** If both arms found the same finding (deterministically matched), it's heavily validated. No human review needed.
2. **Double-blind the disjoint sets only:** Strip all origin metadata (formatting, depth, reasoning style). Have two **independent** adjudicators — people who have not seen the apparatus's internal reasoning — review only the findings unique to each arm.
3. **On disagreement, throw it out:** Don't arbitrate; drop the finding from both arms' recall counts. This is conservative and penalizes the apparatus if its unique findings are ambiguous — which is the correct prior for a tool asking for continued investment.
4. **Full double-adjudication on 100% of high-severity findings in the disjoint set.** The N is small enough that this is cheap, and the cost of bias here is maximal.

**The independence requirement is non-negotiable.** If the adjudicator built the apparatus or has seen its internal reasoning, no amount of double-rating fixes the structural bias. Genuinely independent evaluators, blind to source, evaluating only the margins that determine the decision.

## Claude's Addition 2: Verify Against Reality — Stratified, With a Hallucination Penalty

Verifying only the top-10 highest-severity findings calibrates the **easy end** of the distribution. High-severity findings are most likely to be real and most obvious to verify. The failure mode — humans rubber-stamping plausible-looking output — concentrates in the **medium-severity band**, where the repro is ambiguous, the impact is debatable, and the adjudicator is least motivated to dig.

**Verify a stratified sample of 15:**
- Top-5 severity (smoke test — these should be real)
- 5 random medium-severity (where plausibility-inflation lives)
- 5 random low-severity (where the precision tax accumulates)

If the medium band has <60% real-defect rate, your accepted-recall numbers are theatre across the entire distribution, not just at the top.

**For high-severity findings in the disjoint set, mandate a 5-line repro or failing unit test.** If a finding cannot be reproduced, it is not merely "unaccepted" — it is logged as a **Severe Hallucination Penalty** that actively subtracts from the apparatus's score. High-plausibility, high-severity false positives are the most expensive outputs in the world: they force senior engineers to waste hours chasing ghosts, and they poison the trust budget for every subsequent real finding. The apparatus must be penalized for generating them, not merely fail to be credited.

---

**The decision rule, in one line:** Fork deployment (solo for PRs, apparatus for nightly async); measure minutes-to-first-real-bug with a per-class recall floor on the nightly lane; double-blind the disjoint set with independent adjudicators; verify a stratified 15 against reality with a hallucination penalty on unreproducible high-severity findings. Kill the apparatus if it doesn't add ≥15% unique high-severity recall over solo at ≥70% precision in the nightly lane.

### output-3

## Combined take: use the ledger as a cheap kill-switch, not as evidence; then run same-model-x3 if the apparatus survives sanity checks.

The sharper position is:

> The existing ledger should be mined first, but only under a very narrow mandate. It can falsify the apparatus cheaply; it cannot validate it. The first credible causal test is still the same-model-x3 experiment.

That resolves the main disagreement. One side is too dismissive of the ledger; the other is too generous about what it can prove. The right move is: spend hours, not a week, extracting the obvious retrospective signals. If they look bad, stop. If they look promising, run the new experiment.

The product decision should not be “apparatus wins” versus “solo wins.” It should be:

> For which defect classes does the apparatus produce unique, verified, high-value findings at acceptable precision, latency, and human-review cost?

That yields a routing table, not a global champion.

---

# A. Cheapest credible first step: retrospective ledger or same-model-x3?

## Side: ledger first operationally; same-model-x3 first causally.

The retrospective ledger is not useless. But it is not a causal answer.

It can answer:

- Do later rounds produce any accepted findings?
- Are later-round findings higher severity or mostly nits?
- Does the gate/origin stage contribute anything beyond formatting?
- Does human rejection rate explode in later rounds?
- Are accepted findings concentrated in a few defect classes?
- Is the apparatus producing a lot of duplicate-looking output?

Those are valuable, zero-new-spend questions.

But it cannot answer the core causal question:

> Did the apparatus find things because of multi-stage/multi-agent structure, or because the system simply asked again with more context?

The ledger is survivorship-confounded. It only contains what the apparatus surfaced. It does not show what a same-model solo system would have found in three independent passes. It also entangles origin, gating, accumulated context, prompt framing, and output polish.

So the right position is:

- **Do the ledger pull first as a preflight.**
- **Do not let it replace same-model-x3.**
- **Time-box it tightly.**

If the retrospective query becomes a week-long archaeology project, it is a trap. If it is a half-day SQL/reporting pass, it is obviously worth doing.

## Minimal ledger pull

Run only these queries:

1. **Accepted unique findings by round**
   - round 1 vs rounds 2–3.
2. **Accepted unique findings by severity/class/round**
   - especially high-severity and risk-sensitive classes.
3. **Rejected/accepted ratio by round**
   - proxy for human burden.
4. **Duplicate-adjusted unique yield**
   - not raw finding count.
5. **Origin/stage contribution**
   - proposer, critic, gate, synthesis, etc.
6. **Late-round marginal value**
   - what appears only after iteration?

Interpretation:

- If late rounds add mostly low-severity nits or duplicates, the apparatus is probably overbuilt.
- If late rounds add unique security/data-loss/concurrency findings, the apparatus has a plausible reason to survive.
- If rejection rate rises sharply in later rounds, the apparatus may be buying recall with developer attention.
- If accepted high-severity findings fail the truth audit, the whole benchmark is suspect.

But none of this proves the apparatus beats same-model-x3. It only tells you whether the apparatus is worth testing.

---

# B. Precision or recall for a dev-loop tool?

## Side: precision headlines; recall is a severity-specific guardrail.

For an inline developer tool, recall-first is the wrong framing.

The dominant cost is not tokens. It is:

- human review minutes;
- interruption cost;
- false-positive fatigue;
- latency;
- trust loss;
- missed severe defects.

A high-recall tool with mediocre precision gets ignored. Developers do not experience “80% recall.” They experience “this thing keeps wasting my time.”

So the headline metric should be:

> severity-weighted true actionable findings per human-minute, subject to class-specific precision and recall floors.

More bluntly:

- For nits/style/docs: require extremely high precision or suppress entirely.
- For ordinary correctness: optimize precision and latency.
- For security/auth/data-loss/concurrency: allow more cost, but still demand verified truth.
- For release-gate or batch audit mode: recall can matter more.
- For inline PR comments: precision dominates.

A useful rule:

> Keep the apparatus only where it adds unique verified high-severity findings that cheaper routes miss, without violating precision and latency budgets.

If same-model-x3 has slightly lower recall but materially higher precision and lower human burden for normal code review, it should replace the apparatus in the dev loop.

---

# C. Cheap model pre-clustering before the human?

## Side: the warning is right. Clustering can assist sorting, but it must not become the overlap judge.

This is a real landmine.

The experiment’s key metric is often:

> Did two arms find the same underlying defect, or did one arm find a genuinely unique issue?

If a cheap semantic clusterer collapses distinct findings, it undercounts unique yield. If it splits duplicates, it inflates unique yield. Either error can flip the conclusion.

So the unsafe version is:

> cluster findings automatically, show one representative to the human, and treat the cluster as ground truth.

That invalidates the unique-vs-overlap metric.

## Minimal safe version

Use deterministic/locality grouping first:

- same file;
- same function;
- same line range;
- same symbol;
- same test/migration/API endpoint;
- same error path.

Then let a tool propose candidate duplicate groups, but under strict limits:

1. It may not hide findings.
2. It may not decide deduplication.
3. The human must see all members of routing-relevant clusters.
4. Cross-arm duplicate decisions must be human-confirmed.
5. High-severity and borderline duplicate decisions get second review.
6. Report sensitivity:
   - conservative dedupe: only same root cause collapsed;
   - aggressive dedupe: likely duplicates collapsed.

For the primary metric, use conservative human-confirmed dedupe. Optional semantic clustering can reduce UI pain, but it cannot be load-bearing.

---

# D. Is single-adjudicator plus 10–20% second-rater check enough?

## Side: enough for low-risk operational decisions; not enough for high-severity claims unless reality-checked.

Single-adjudicator bias is not automatically fatal, but it becomes fatal if:

- the adjudicator sees arm identity;
- outputs retain recognizable style;
- there is no explicit rubric;
- duplicate decisions are unaudited;
- high-severity findings are accepted by plausibility alone;
- the second-rater sample is random but misses the important cases.

The right split:

## Low/medium severity

Single primary adjudicator is acceptable if:

- blinded to arm/stage/model identity;
- output formatting is normalized;
- order is randomized;
- rubric is explicit;
- second-rater audit is stratified;
- disagreement rates are reported.

## High severity / routing-decisive findings

Single skimming is not enough.

These require:

- second human review, or at least senior review;
- reality check against code;
- path trace or minimal repro where possible;
- severity calibration;
- duplicate/root-cause confirmation.

A 10–20% second-rater check is fine only if it is stratified toward:

- high severity;
- borderline accept/reject;
- cross-arm duplicate decisions;
- later-round apparatus findings;
- classes where the routing decision is close;
- findings that drive the apparatus’s claimed advantage.

Do not use another model as the reliability rater. It can assist formatting or contradiction spotting, but not credibility.

---

# Reaction to Addition #1: “Mine the existing ledger first.”

## Defend the action; reject the implied conclusion.

Yes, mine it first. No, it will not answer “where quality comes from” in the causal sense.

The ledger can reveal:

- internal marginal yield;
- class/severity distribution;
- obvious apparatus waste;
- late-round value or lack thereof;
- rejection burden;
- duplicate inflation.

But it cannot disentangle:

- iteration vs model capability;
- gate effects vs generation quality;
- accumulated context vs independent discovery;
- output polish vs actual correctness;
- what solo-x3 would have found but the apparatus missed.

So the ledger is a **cheap kill-switch**, not a verdict.

Decision rule:

- If the ledger shows no late-round high-value yield, kill or sharply narrow the apparatus before new spend.
- If the ledger shows meaningful late-round high-severity yield, run same-model-x3.
- If the ledger is ambiguous, run same-model-x3.
- If the ledger takes more than a day to extract, stop and run the experiment.

---

# Reaction to Addition #2: “Accepted means plausibility, not truth.”

## Strongly defend. This is the most important correction.

Accepted labels from skim review are not ground truth. They often measure:

- plausibility;
- clarity;
- formatting;
- confidence;
- reviewer priors;
- severity theater.

A model can produce a finding that is specific, well-written, and completely false.

So before treating accepted findings as recall targets, calibrate truth.

## Minimal truth audit

Verify:

1. top 10 highest-severity accepted findings;
2. 10 random accepted findings;
3. 5–10 rejected but high-severity-looking findings, if feasible.

For each, classify:

- true actionable defect;
- real issue but overstated;
- plausible but unproven;
- false positive;
- duplicate/known issue;
- style/preference/non-bug.

Verification should check:

- does the path/function exist?
- is the cited behavior real?
- is the data/control path plausible?
- can a minimal repro or trace be produced?
- is the impact real?
- would a maintainer patch it?

If top-severity accepted findings do not survive reality checking, then “accepted recall” is mostly theatre.

---

# Reaction to Addition #3: routing table, not global winner.

## Strongly defend. This is the product answer.

A single global winner is the wrong output.

The apparatus may be bad globally but valuable for:

- auth and permission boundaries;
- security vulnerabilities;
- data migration/data loss;
- concurrency and distributed-state bugs;
- API compatibility;
- complex business logic regressions;
- release-gate architectural review.

It may be wasteful for:

- nits;
- style comments;
- simple local correctness;
- docs polish;
- obvious test suggestions;
- routine PR review.

The output should be a routing table like:

| Class | Default route | Escalate when | Primary metric |
|---|---|---|---|
| Style/nits/docs | suppress or cheap solo | rarely | very high precision |
| Simple correctness | cheap solo | low confidence or critical file | precision + latency |
| Tests | cheap solo | core subsystem or release gate | usefulness per human-minute |
| Security/auth | apparatus | auth boundary, permissions, public surface | verified recall floor |
| Data loss/migration | apparatus | schema/data migration/storage touched | verified high-severity yield |
| Concurrency/async | apparatus or specialist prompt | shared state, locks, async, distributed flow | unique true positives |
| API compatibility | apparatus in batch/release mode | public API or dependency boundary | severity-weighted yield |
| Architecture/design | apparatus, not inline | release review or large diff | human-reviewed usefulness |

The apparatus should not be universally kept or universally dropped. It should be routed.

---

# The experiment to actually run

## Phase 0: zero/low-spend sanity

Time-box to one day.

1. Pull existing ledger statistics.
2. Deduplicate obvious repeats.
3. Break down accepted/rejected by round, class, severity, origin/stage.
4. Truth-audit top severe accepted findings.
5. Estimate human burden if review-time data exists.

Outcome:

- If high-severity accepted findings are mostly false: fix adjudication before any experiment.
- If later rounds add no meaningful verified value: narrow or kill apparatus.
- If later rounds add plausible high-value findings: proceed.

## Phase 1: causal comparison

Run the same tasks through:

- current apparatus;
- strongest single model, three independent or iterated passes;
- cheap solo one-pass baseline;
- optional cheap solo three-pass baseline.

Keep constant:

- input context;
- repository/PR sample;
- defect taxonomy;
- output schema;
- severity rubric;
- time budget where applicable.

## Phase 2: blinded adjudication

Requirements:

- strip arm/stage identity;
- normalize output style;
- randomize order;
- use explicit rubric;
- use deterministic locality grouping;
- human-confirm cross-arm duplicates;
- second-review stratified samples;
- reality-check high-severity findings.

Primary labels should distinguish:

- true actionable defect;
- plausible but unverified;
- false positive;
- duplicate;
- non-bug/preference;
- severity overstated.

## Phase 3: decision metrics

Do not headline global accepted recall.

Report per class/severity:

1. verified precision;
2. unique verified yield over cheaper arms;
3. human-minutes per true actionable finding;
4. latency;
5. duplicate burden;
6. false-positive rate;
7. severity-weighted value;
8. recall proxy against union of verified findings.

The decision rule:

> Use the cheapest route that satisfies the precision floor and latency budget, escalating only where the apparatus adds unique verified high-severity yield or meets a recall floor cheaper routes miss.

---

# Bottom line

The real disagreements resolve this way:

1. **Retrospective ledger:** run it first, but only as a time-boxed sanity check. It can kill the apparatus; it cannot vindicate it. Same-model-x3 remains the first credible causal test.

2. **Precision vs recall:** precision headlines for dev-loop use. Recall is a guardrail for high-risk classes, not the global north star.

3. **Clustering:** automatic semantic clustering is unsafe if it decides uniqueness. Use deterministic locality grouping plus human-confirmed dedupe. Optional model-assisted clustering may only assist, never hide or decide.

4. **Adjudication:** single primary adjudication is acceptable for low-risk findings if blinded and audited. For high-severity or routing-decisive findings, plausibility labels are insufficient; require reality checks and second review.

Final stance:

> Mine the ledger today. Truth-audit the scary accepted findings. If the apparatus still looks worth defending, run same-model-x3. Then ship a precision-weighted routing table, not a global winner.

