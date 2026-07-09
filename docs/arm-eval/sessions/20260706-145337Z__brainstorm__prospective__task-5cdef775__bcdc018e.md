# Arm-eval session bcdc018e-ed89-45e4-85c5-3cfbf7d4f19f

| Field | Value |
|---|---|
| Experiment | brainstorm |
| Phase | prospective |
| Task id | `task-5cdef775` |
| Seed (presentation-order RNG) | 1966267601 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-06T14:53:37.326Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

How should we scope HUMAN BLIND ADJUDICATION severity coverage in a code-audit-effectiveness experiment so the evaluation basis is METHODOLOGICALLY PROPER — specifically not losing the "several MEDIUMs stack into a larger problem" signal — without ballooning into days of human labeling work? We explicitly do NOT want a quick fix; we want a defensible evaluation design. But the constraint is real: one human adjudicator, ideally hours not days.

SETUP (already run, data in hand):
- Ground truth: 13 curated known-defect commits (real historical bugs, each with a fix commit + an expectedFindingRubric describing what a correct finding must say). 1 more excluded (mega-commit).
- Four arms audited the same frozen diffs: A = production apparatus (GPT-5.5 5-pass -> Gemini review), S-sonnet (Sonnet-5 single-shot), S-fable (Fable-5 single-shot, the cheap model), S-sonnet-x3 (Sonnet-5, 3 independent samples at temperature 1.0, unioned).
- The blind sheet: findings from all arms, source-stripped, shuffled, LLM-proposed duplicate clusters (human has merge/split veto). Human grades each cluster with a 4-label proof protocol: proven / actionable / plausible / false; `proof` (file:line) required for HIGH accepted; `matches` links a finding to a known-defect ID.
- Scoring: severity-weighted (LOW=1, MEDIUM=3, HIGH=8), label factors proven=1.0/actionable=0.6/plausible=0/false=0, precision denominator includes plausible+false (noise flooding penalized), hard eligibility ceilings (false-rate <= 0.33, noise-rate <= 0.5), known-defect recall per arm, matchesApparatus rule.

VOLUME REALITY (the tension):
- HIGH-only sheet: 1,165 findings -> 599 human-facing clusters. Feasible in a long session.
- HIGH+MEDIUM: 3,743 findings -> ~1,930 clusters. ~3.2x — days, not hours.
- MEDIUM is where models emit most findings (A:319, S-sonnet:765, S-fable:736, S-x3:758 raw MEDIUMs). Distributions differ by arm — the solo arms emit 2.3x the apparatus's MEDIUM volume, so MEDIUM precision may DIFFER MOST across arms and be exactly where the discriminating signal is.
- One commit (ff20d85e, a large CSS/theming commit) alone contributes ~30% of all clusters.

THE USER'S ARGUMENT (steelman it or refute it): "Several mediums often stack together to pick up a much larger problem. If we don't measure effectiveness at picking up MEDIUMs, we lose the effectiveness comparison." — i.e., compound risk: N related MEDIUM findings in the same subsystem can jointly indicate a HIGH-grade architectural problem; also MEDIUM precision/recall may be where arms genuinely differ (noise-flooding vs discipline).

QUESTIONS:
1. Does HIGH-only adjudication structurally bias the comparison, and in which direction? (e.g., does it favor the noisy high-volume arms or the disciplined low-volume ones? Does the eligibility ceiling already partially capture MEDIUM discipline without grading MEDIUMs?)
2. Is stratified SAMPLING of MEDIUM clusters statistically defensible at this scale (~1,330 MEDIUM clusters, want maybe 150-300 graded)? If so, what stratification is correct: by arm? by commit? by category (security/validation vs style)? by cluster size? What estimator + what confidence do we get?
3. The "MEDIUMs stack" compound-risk argument: is there a way to measure that WITHOUT grading every MEDIUM — e.g., grade only MULTI-FINDING clusters or same-file MEDIUM groups; or ask the adjudicator to flag "part of a larger pattern" during HIGH grading?
4. Known-defect recall already has ground truth independent of adjudication volume (14 rubrics). 4 of the 14 known defects are MEDIUM-severity. Does grading ONLY the findings that plausibly match known defects (any severity) + all HIGH + a MEDIUM sample give the best information-per-labeling-minute?
5. What's the single best design here: (a) HIGH-only now, MEDIUM later if HIGH is inconclusive; (b) full HIGH+MEDIUM, accept days; (c) stratified MEDIUM sample alongside full HIGH — and if (c), exactly how to sample and how to report the uncertainty honestly?


## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

## Bottom line

Use **option (c): full HIGH adjudication + all known-defect candidates at any severity + a pre-registered stratified MEDIUM sample + a small explicit stacked-pattern adjudication layer**.

Do **not** rely on HIGH-only as the primary evaluation. It is methodologically incomplete here because the arms differ most in MEDIUM volume, and your scoring/eligibility rules only penalize noise that is actually adjudicated. But you also do **not** need to adjudicate all ~1,330 MEDIUM clusters. A properly stratified 200–300 MEDIUM-cluster sample, plus targeted pattern review, is defensible and should keep the work in “long session / two sessions” territory rather than days.

---

# 1. Does HIGH-only structurally bias the comparison?

Yes. HIGH-only is structurally non-neutral.

It does not mathematically bias in one universal direction, because the direction depends on the quality of the omitted MEDIUMs:

- If the extra MEDIUMs from the high-volume arms are mostly real/actionable, HIGH-only **undercredits** those arms.
- If the extra MEDIUMs are mostly plausible/false noise, HIGH-only **overcredits** those arms by hiding their largest noise channel.
- If the production apparatus is disciplined partly by suppressing weak MEDIUMs, HIGH-only gives it **no credit** for that discipline.

Given your observed distribution, the most likely practical bias is that HIGH-only **favors high-volume arms by failing to charge them for MEDIUM noise**. But the more defensible statement is:

> HIGH-only suppresses the main empirical uncertainty: whether the additional MEDIUM volume is useful signal or noise.

That is exactly the thing the experiment should measure.

## Eligibility ceilings do not solve it

Your false-rate and noise-rate ceilings only apply to the adjudicated population.

If you adjudicate only HIGHs, then the ceilings test:

> “Is this arm disciplined among findings it called HIGH?”

They do **not** test:

> “Is this arm disciplined as an audit system?”

A model can pass the HIGH false/noise ceiling while dumping hundreds of weak MEDIUM findings. Conversely, a lower-volume arm may lose relative credit because its MEDIUM restraint is never measured.

So HIGH-only can be useful as a partial endpoint, but it should not be the sole basis for an effectiveness comparison.

---

# 2. Is stratified MEDIUM sampling defensible?

Yes. At your scale, stratified sampling is not a shortcut; it is the right methodological tool.

You have roughly:

- 599 HIGH clusters: feasible census.
- ~1,330 MEDIUM clusters: too many for full human adjudication.
- One outlier commit contributing ~30% of clusters.
- Strong arm-level differences in MEDIUM volume.

A 200–300 cluster MEDIUM sample is defensible if:

1. The sampling unit is the **deduplicated cluster**, not the raw finding.
2. Inclusion probabilities are recorded.
3. Estimation uses inverse-probability weighting.
4. Uncertainty is reported honestly.
5. The outlier commit is treated explicitly, not allowed to silently dominate.

---

# 3. Correct stratification

Do not stratify only by arm. Because clusters can be shared across arms, “by arm” alone is wrong. A cluster found by multiple arms is a different statistical object from a one-arm singleton.

Use strata based on the following metadata.

## Primary stratification dimensions

### A. Commit

Commit matters because defect ecology differs by commit.

At minimum:

- `ff20d85e` as its own stratum.
- Other large commits as individual strata if they have enough MEDIUM clusters.
- Smaller commits pooled or lightly stratified.

Report both:

1. Main result weighted to the real experiment population.
2. Sensitivity excluding `ff20d85e`.

If the result changes materially when `ff20d85e` is excluded, that is not a nuisance; it is an important finding.

### B. Arm-incidence bucket

For each MEDIUM cluster, record which arms emitted it.

Useful buckets:

- A-only.
- S1-only.
- S2-only.
- S3-only.
- A plus at least one other arm.
- Shared among non-A arms, not A.
- Shared by three or more arms.

This captures the difference between:

- arm-unique findings, where noise-flooding shows up;
- cross-arm consensus findings, which often have higher prior validity;
- A-only behavior;
- high-volume arm singleton behavior.

### C. Cluster multiplicity / raw duplicate count

Within a cluster, record whether it contains:

- one raw finding,
- multiple raw findings from one arm,
- multiple arms,
- unusually large duplicate volume.

Large clusters and multi-arm clusters are more likely to reflect real issues or recurring model behavior. They are also relevant to the “MEDIUMs stack” argument.

### D. Broad category or subsystem

Use this as a secondary balancing variable, not as the main stratifier unless the categories are reliable.

Broad buckets are enough:

- security / validation / authorization / data integrity;
- runtime correctness / error handling;
- API compatibility / behavior regression;
- UI / styling / theming;
- maintainability / cleanup / style.

Do not create too many tiny category strata; that will make estimates noisy.

---

# 4. Concrete MEDIUM sampling plan

Target **n = 240 MEDIUM clusters**, with acceptable range **200–300**.

A practical design:

## Step 1: Define the MEDIUM population

Start with all deduplicated MEDIUM clusters.

Mark each cluster with:

- commit;
- arm-incidence bucket;
- raw duplicate count;
- files/directories touched;
- broad category if available;
- known-defect candidate flag;
- pattern-candidate flag.

## Step 2: Certainty strata

Adjudicate with probability 1.0:

1. **All MEDIUM clusters that plausibly match a known-defect rubric.**
2. Optionally, all very-high-consensus MEDIUM clusters, if the count is modest.

For example, census all MEDIUM clusters found by 3+ arms if that is only a small number. If that set is large, sample it instead; do not let it blow up the workload.

## Step 3: Stratified random sample from the rest

For the remaining MEDIUM clusters, sample approximately 200–240 clusters using strata:

```text
commit group
× arm-incidence bucket
× singleton/multi-finding status
```

Collapse tiny cells.

Use a mixed allocation:

- partly proportional to stratum size;
- partly equalized across important arm-incidence buckets;
- cap or isolate `ff20d85e` so it does not consume the whole sample.

A reasonable target allocation for n ≈ 240:

- 50–70 clusters from `ff20d85e`, depending on its true MEDIUM population share;
- 170–190 from the other commits;
- ensure at least ~40–60 A-involved MEDIUM clusters;
- ensure enough singleton samples from each high-volume arm to estimate noise;
- include multi-arm/shared clusters at a higher sampling rate than pure proportional sampling would give.

The exact allocation can be precomputed from the actual strata counts. The important point is that every sampled cluster has a known inclusion probability `π_c`.

---

# 5. Estimator and confidence intervals

Use a design-based inverse-probability estimator.

For a sampled MEDIUM cluster `c`, with inclusion probability `π_c`, define:

```text
accepted_value(c) =
  3 × label_factor(c)
```

where:

- proven = 1.0
- actionable = 0.6
- plausible = 0
- false = 0

For arm `a`, estimate MEDIUM accepted score as:

```text
Estimated_MEDIUM_score_a =
Σ over sampled MEDIUM clusters c emitted by arm a:
    accepted_value(c) / π_c
```

Similarly estimate false and noise counts:

```text
Estimated_false_count_a =
Σ I(c emitted by arm a and label=false) / π_c

Estimated_noise_count_a =
Σ I(c emitted by arm a and label ∈ {plausible,false}) / π_c
```

Then compute arm-level MEDIUM false/noise rates using the known total number of MEDIUM clusters emitted by that arm.

For precision, use either:

```text
Estimated accepted weighted score / total emitted MEDIUM weighted opportunity
```

or a ratio estimator such as the Hájek estimator. The Horvitz-Thompson version is simpler and fully design-based; the Hájek ratio is often more stable. Pre-register which one is primary.

## Confidence intervals

Use a stratified bootstrap or design-based variance estimator that preserves:

- commit strata;
- arm-incidence strata;
- shared-cluster structure.

Important: if one sampled cluster was emitted by multiple arms, its label contributes to all those arms. The bootstrap should preserve that paired structure.

Approximate precision:

- n = 150 gives worst-case 95% margin around ±8 percentage points for an overall binary rate.
- n = 200 gives around ±6–7 points.
- n = 300 gives around ±5–6 points.

Because you are stratifying and estimating per-arm rates, practical per-arm intervals will be wider:

- often ±9–15 points depending on effective sample size and design effect.

That is still enough to detect material differences like:

- one arm’s MEDIUM noise rate is 20 points worse;
- one arm fails a noise ceiling robustly;
- a HIGH-only advantage disappears after accounting for MEDIUM noise.

It is not enough to resolve tiny differences like 3–5 percentage points. Report that honestly.

For eligibility ceilings, do not treat sampled estimates as exact. Use categories:

- **robust pass**: upper 95% CI below the ceiling;
- **robust fail**: lower 95% CI above the ceiling;
- **borderline / unresolved**: CI crosses the ceiling.

---

# 6. How to capture the “several MEDIUMs stack” signal

The user’s argument is valid. Several MEDIUM findings can jointly reveal a larger architectural or systemic problem. But grading every MEDIUM is not the only way to capture that.

You should add a **pattern-level adjudication layer**.

Individual finding quality and compound-risk detection are related but distinct endpoints. Treat them separately.

## Construct pattern candidates from the full MEDIUM universe

Before human labeling, mechanically generate candidate pattern groups using all MEDIUM clusters.

A candidate pattern group could be:

```text
same commit
+ same file/directory/subsystem
+ related weakness type or root cause
+ multiple MEDIUM clusters
```

Use rules such as:

- ≥3 MEDIUM clusters in the same commit and directory;
- ≥2 MEDIUM clusters in the same file and broad category;
- ≥3 clusters with high semantic similarity within the same commit;
- clusters spread across multiple files but pointing to the same root cause;
- unusually large raw-finding volume in one subsystem.

Also include high-leverage groups, for example:

```text
leverage =
number of clusters
+ number of distinct files
+ number of raw findings
+ number of arms represented
```

Take:

- all groups above a pre-registered threshold, or
- top 25–40 groups by leverage,
- plus a small random sample of lower-leverage groups as a control.

This keeps the pattern review bounded.

## What the human adjudicator labels

For each candidate pattern group, ask:

1. Are these findings actually related?
2. Do they point to a single larger underlying defect/design problem?
3. Is the combined pattern:
   - proven,
   - actionable,
   - plausible,
   - false/unrelated?
4. Does the combination warrant severity uplift?
   - no uplift;
   - remains MEDIUM;
   - compound HIGH/systemic issue.
5. Which cluster IDs support the pattern?

The adjudicator remains blind to arm identity. After adjudication, you map cluster IDs back to arms.

## How to credit arms for stacked patterns

Define detection pre-registered.

For example, arm `a` detects pattern `g` if either:

```text
arm a emitted one cluster that explicitly described the larger pattern
```

or:

```text
arm a emitted at least 2 accepted/actionable supporting MEDIUM clusters
within the adjudicated pattern group
```

Then report:

- number of accepted stacked patterns detected by each arm;
- number of compound-HIGH patterns detected by each arm;
- false/unrelated pattern rate;
- examples of accepted and rejected pattern claims.

This directly preserves the “MEDIUMs stack” signal without grading all MEDIUMs.

## UI tweak for sampled MEDIUM adjudication

In the MEDIUM sample sheet, group or sort clusters by:

- commit;
- file/directory;
- broad category.

Add a checkbox:

```text
Part of larger pattern? yes/no/unclear
If yes, candidate pattern ID or short note.
```

This allows the human to catch additional stacks during ordinary MEDIUM adjudication.

---

# 7. Known-defect recall: adjudicate all plausible matches at any severity

Yes. This is high value per labeling minute and should be done as a census, not a sample.

Because some known defects are MEDIUM-severity, HIGH-only adjudication would understate known-defect recall.

## Procedure

For each included known-defect rubric:

1. Build a liberal candidate set from all findings, any severity.
2. Use file overlap, changed-line proximity, keywords, root-cause similarity, and semantic retrieval.
3. Err on the side of inclusion.
4. Human adjudicates whether each candidate satisfies the expectedFindingRubric.
5. For each arm and each defect, mark recall = 1 if the arm emitted at least one accepted matching finding.

Use this candidate sweep for **recall**, not as a standalone precision estimate.

For the excluded mega-commit: do not include it in the primary recall denominator if it was excluded from the experiment. Report it separately if useful.

Primary recall denominator should be the included known-defect commits.

---

# 8. Recommended final design

## Primary protocol

### Phase 1 — Full HIGH census

Adjudicate all HIGH clusters.

Population:

```text
all source-blinded HIGH clusters
```

Outputs:

- HIGH precision;
- HIGH false/noise rate;
- HIGH severity-weighted score;
- HIGH known-defect matches;
- examples of proven/actionable/false HIGHs.

This gives you exact HIGH results.

---

### Phase 2 — Known-defect candidate census

Adjudicate all plausible known-defect matches across all severities.

Population:

```text
any finding, any severity, plausibly matching one of the included known-defect rubrics
```

Outputs:

- known-defect recall per arm;
- recall by severity of the original known defect;
- recall by commit;
- whether any arm found the defect only as MEDIUM/LOW.

This protects you from missing the four MEDIUM known defects.

---

### Phase 3 — Stratified MEDIUM sample

Adjudicate ~240 MEDIUM clusters.

Sampling unit:

```text
deduplicated MEDIUM cluster
```

Stratify by:

```text
commit group
× arm-incidence bucket
× singleton/multi-finding status
```

with `ff20d85e` isolated.

Use inverse-probability weighting for estimates.

Outputs:

- estimated MEDIUM accepted score by arm;
- estimated MEDIUM false rate by arm;
- estimated MEDIUM noise rate by arm;
- estimated total severity-weighted score including HIGH exact + MEDIUM estimated;
- eligibility-ceiling results with confidence intervals;
- sensitivity excluding `ff20d85e`.

---

### Phase 4 — Stacked-medium pattern adjudication

Generate 25–40 candidate pattern groups from the full MEDIUM universe.

Adjudicate at the group level.

Outputs:

- compound-risk pattern count by arm;
- compound-HIGH uplift count by arm;
- rejected/unrelated pattern count;
- examples.

This directly addresses the “several MEDIUMs stack into a larger problem” concern.

---

# 9. Reporting structure

Report results in layers, not as a single overclaimed number.

## A. Exact HIGH results

```text
HIGH accepted score
HIGH precision
HIGH false/noise rate
HIGH known-defect recall
```

No sampling uncertainty.

## B. Known-defect recall

```text
Recall over included known defects
Recall over MEDIUM known defects
Recall by arm
Recall by severity emitted by the arm
```

No sampling uncertainty if candidate sweep is sufficiently liberal and fully adjudicated.

## C. Estimated MEDIUM results

```text
MEDIUM accepted score estimate ± 95% CI
MEDIUM false rate estimate ± 95% CI
MEDIUM noise rate estimate ± 95% CI
MEDIUM contribution to total weighted score ± 95% CI
```

Use design-based or stratified bootstrap intervals.

## D. Combined score

```text
Total score =
exact HIGH score
+ estimated MEDIUM score
+ optionally exact LOW/other known-defect recall component if applicable
```

Report uncertainty from MEDIUM sampling.

## E. Eligibility

For each arm:

```text
false-rate ceiling:
  robust pass / robust fail / borderline

noise-rate ceiling:
  robust pass / robust fail / borderline
```

Do not convert a sampled estimate into a fake exact disqualification.

## F. Sensitivity analyses

At minimum:

1. Including all commits.
2. Excluding `ff20d85e`.
3. HIGH-only baseline.
4. HIGH + known-defect recall only.
5. HIGH + sampled MEDIUM.
6. HIGH + sampled MEDIUM + stacked-pattern endpoint.

This shows exactly what MEDIUM adjudication changes.

---

# 10. Why this is better than the alternatives

## Option (a): HIGH-only now, MEDIUM later if inconclusive

Weak. It sounds efficient, but it lets the first-stage conclusion be based on a structurally incomplete outcome.

Use HIGH-only as a reported baseline, not as the primary decision rule.

## Option (b): full HIGH+MEDIUM adjudication

Methodologically clean but operationally excessive. With one adjudicator, ~1,930 clusters is likely days of work and creates fatigue risk, which itself damages adjudication quality.

Full census is not necessary if the sample is designed correctly.

## Option (c): full HIGH + stratified MEDIUM sample

Best tradeoff.

It gives you:

- exact HIGH adjudication;
- exact known-defect recall;
- estimated MEDIUM precision/noise with uncertainty;
- explicit compound-risk measurement;
- bounded human workload;
- defensible inference.

---

# Final recommended design in one sentence

Run a **pre-registered targeted adjudication protocol**: adjudicate **all HIGH clusters**, **all known-defect candidates at any severity**, a **240-cluster stratified MEDIUM sample weighted by inclusion probability**, and **25–40 stacked-MEDIUM pattern groups**, then report exact HIGH/recall results plus MEDIUM estimates with confidence intervals and sensitivity analyses, especially with and without `ff20d85e`.

### output-2

# Scoping MEDIUM Adjudication: A Defensible Design

## 1. Does HIGH-only structurally bias the comparison?

**Yes, and the direction is against the apparatus — but the mechanism matters.**

The volume asymmetry is the signal, not a nuisance to control away. The apparatus emits 319 MEDIUMs; the solo arms emit ~750 each. If the 5-pass-then-review pipeline is doing its job, MEDIUM precision is exactly where the apparatus's discipline advantage concentrates. HIGH-only flattens this difference: a noisy arm and a disciplined arm look equivalent as long as the noisy arm's HIGHs are clean.

The eligibility ceilings do **not** rescue this. In a HIGH-only sheet, false-rate and noise-rate are computed on HIGHs only. An arm can pass both ceilings at HIGH while flooding MEDIUMs with plausible-but-false findings. The ceiling catches HIGH flooding; it has zero capture of MEDIUM noise. This is not partial capture — it is structurally blind to the tier where the volume data says arms differ most.

The counterargument ("MEDIUMs are speculative by definition") is half-right. It justifies treating individual MEDIUMs as lower weight. It does not justify refusing to measure them when the volume differential across arms is 2.3×. An evaluation that ignores the tier where arms differ most is not an effectiveness study — it is a HIGH-effectiveness study. State which one you are running.

---

## 2. Is stratified sampling of MEDIUM clusters defensible?

**Yes, at 250–300 graded clusters out of ~1,330, with honest CI reporting.**

### Sampling unit: cluster, not file

The estimand is per-cluster MEDIUM precision (what fraction of emitted MEDIUM clusters are real). File-based sampling (Take B's proposal) introduces size-bias — files with more MEDIUMs get over-represented — and conflates the precision question with the density question. Sample clusters. Record file membership for each graded cluster so density analyses remain possible post-hoc.

### Stratification: arm × commit, balanced across arms

1. **Arm (balance, not proportional):** The experiment is a four-arm comparison. Equal per-arm allocation is non-negotiable. With 250 clusters, target ~60/arm. Do **not** sample proportionally to arm volume — that gives noisy arms more labels and unequal statistical power.

2. **Commit (stratify, proportional within arm, with ff20d85e isolated):** ff20d85e is 30% of volume and is a CSS/theming commit — plausibly less representative of the security/logic bug landscape. Isolate it as its own stratum. Sample it at a reduced rate (~10% of its clusters, ~40 clusters total). Sample the remaining 12 commits proportionally to their MEDIUM-cluster share within each arm. **Report MEDIUM precision both with and without ff20d85e.** The isolation is a design choice; the dual reporting makes it defensible.

3. **Category and cluster size:** Do not stratify on either. With 4 arms × 13 commits × ~5 categories, cells are too sparse. Use category as a post-stratification (raking) weight in the estimator if the clusters carry category labels. Cluster size correlates with cross-arm agreement (bigger cluster = more arms found it = more likely true positive); stratifying on it biases the precision estimate.

### Estimator and confidence

Per-arm MEDIUM precision, stratified estimator with commit-level weights:

$$\hat{p}_{\text{arm}} = \sum_{c} w_c \cdot \hat{p}_{\text{arm},c}$$

**Effective per-arm n depends on cluster overlap.** Clusters contain findings from multiple arms; grading one cluster can contribute to multiple arms' estimates. With ~250 graded clusters and typical overlap, expect 60–125 effective arm-level observations. At n=60: SE ≈ 0.065, 95% CI ±0.13. At n=125: SE ≈ 0.045, CI ±0.09.

**What this resolves:** Differences >0.18–0.20 at p<0.05 with n=60/arm; differences >0.13–0.15 with n=125/arm. If the apparatus's MEDIUM precision is 0.65 and a solo arm's is 0.45, you will see it. If the gap is 0.55 vs. 0.50, you will not — and you must say so explicitly.

---

## 3. The "MEDIUMs stack" argument: steelman, refutation, and what to actually measure

### Steelman

Five missing input validations in one file are not five MEDIUMs — they indicate a systemic HIGH risk (e.g., no sanitization architecture). If the experiment ignores MEDIUMs, it cannot detect whether an arm surfaced this compound risk, even in pieces.

### Refutation

If five MEDIUMs stack into a HIGH, but the arm emitted them as five isolated findings, **the arm failed the synthesis task**. A core value proposition of an LLM auditor over a regex linter is context synthesis. If the human adjudicator must read five isolated MEDIUMs and mentally deduce the architectural problem, the human is doing the work the tool should have done. Crediting the arm for a HIGH it never articulated is evaluation inflation. The arm should get credit for five MEDIUMs (graded individually), not for a HIGH it failed to name.

### Reconciliation: test stacking on ground truth, not on speculative synthesis

There is one context where stacking is legitimate signal: **known-defect recall**. If one of the 4 MEDIUM-severity known defects was detected by an arm via multiple MEDIUM findings that individually look weak but collectively match the rubric, that is direct, ground-truth-anchored evidence of stacking. The defect exists; the arm found it; the mechanism was multiple MEDIUMs. This requires no extra grading — it falls out of fully grading the MEDIUM-known-defect commits (Layer 2 below).

For speculative stacking (MEDIUMs that might indicate an unnamed HIGH), do not run a separate assay. Instead, record file membership for every MEDIUM cluster in the precision sample. Post-hoc, split graded clusters by "in a MEDIUM-dense file (≥3 MEDIUMs from same arm)" vs. not. If precision is higher in dense files, that is corroborating signal. If not, the stacking claim weakens. This costs zero additional grading time.

**Do not** ask the adjudicator to flag "part of a larger pattern" during HIGH grading — they would be speculating about MEDIUMs they have not seen.

---

## 4. Known-defect recall integration

Recall and precision require different evaluation techniques and different sampling strategies.

- **Recall is absolute:** Did the arms find the 14 known defects? Cross-reference all 3,743 raw findings against the 14 rubrics (LLM script, human has veto). Any finding with a plausible match goes into the blind sheet. The human definitively grades `matches: ID` blind. This is a census of candidates, not a sample — no CI needed.

- **The 4 MEDIUM-severity known defects are the anchor.** An arm can only demonstrate recall on these via MEDIUM findings. Grade **all** MEDIUM clusters from these 4 commits, not just the plausible matches. Why: an arm might find the known MEDIUM defect but also emit 15 false MEDIUMs in the same commit. Grading the full commit's MEDIUMs gives recall AND local precision. Volume is probably 50–100 clusters total — affordable.

- **Precision is a proportion:** What fraction of emitted MEDIUMs are real? The stratified sample answers this with CIs.

---

## 5. The single best design

**Option (c): full HIGH + targeted full MEDIUM + stratified MEDIUM sample.** No separate stacking assay — stacking is tested via ground-truth anchor and post-hoc density split.

### The protocol

| Layer | What | Clusters | Purpose |
|-------|------|----------|---------|
| 1 | All HIGH clusters | 599 | HIGH precision/recall, full enumeration |
| 2 | All MEDIUMs from the 4 MEDIUM-known-defect commits | ~75 | MEDIUM-defect recall + local precision, full enumeration |
| 3 | Stratified MEDIUM precision sample (arm × commit, ff20d85e isolated) | ~250 | Per-arm MEDIUM precision with CI |
| **Total** | | **~924** | |

At 30s/unit: ~7.7 hours. At 45s/unit: ~11.5 hours. Two focused sessions.

### Layer 3 sampling details

- Balance across arms: ~60/arm.
- Within each arm: ff20d85e as its own stratum (~10% of per-arm budget, ~6 clusters), remaining 12 commits sampled proportionally to their MEDIUM-cluster share.
- Exclude clusters already graded in Layer 2.
- Record file membership for every graded cluster (for post-hoc density analysis).

### How to report uncertainty honestly

1. **HIGH precision, recall, false-rate, noise-rate:** Point estimates, no CI. Full enumeration.

2. **MEDIUM-defect recall (4 MEDIUM-severity known defects):** Exact counts from Layer 2. Census of the relevant commits. No CI needed.

3. **Per-arm MEDIUM precision:** Stratified point estimate with 95% CI. Explicit statement: "MEDIUM estimates are sample-based; CI half-width is ±0.09 to ±0.13 depending on effective per-arm n. Differences smaller than 2×SE are not resolvable."

4. **MEDIUM eligibility ceiling:** Three-tier reporting. If point estimate >0.33 and CI excludes 0.33: "fails." If point estimate >0.33 but CI includes 0.33: "elevated but unconfirmed at this sample size." If CI upper bound <0.33: "passes." This is more honest than binary pass/fail on sample data.

5. **Stacking:** Report the ground-truth finding (were any of the 4 MEDIUM known defects detected via multiple weak MEDIUMs?). Report the post-hoc density split (precision in MEDIUM-dense files vs. isolated MEDIUMs) as exploratory, not inferential. If neither shows stacking signal, state that the stacking hypothesis is untested by this design and should not be load-bearing in the motivation.

### What this design gives up

- **Subtle MEDIUM precision differences are not resolvable.** If the real gap is 0.55 vs. 0.50, you report "no significant difference." This is honest. If detecting that gap is essential, you need full MEDIUM grading (option b, days of work).
- **Per-commit MEDIUM precision is not supportable.** With ~60/arm across 13 commits, cells are too sparse. Only arm-level (pooled across commits) estimates hold.
- **ff20d85e MEDIUM precision is weakly estimated** (~6 clusters/arm). Report it separately and flag the uncertainty. The dual reporting (with/without ff20d85e) is the mitigation.
- **Stacking remains partially tested.** If the stacking claim is central to the paper's thesis and neither the ground-truth anchor nor the density split shows signal, you must either invest in full MEDIUM grading or retract the claim from the motivation.

### output-3

# Scoping MEDIUM Adjudication: A Defensible Sampling Design

## 1. Does HIGH-Only Adjudication Structurally Bias the Comparison?

Yes. A HIGH-only evaluation is structurally incomplete and biases the comparison in three specific ways:

**A. It hides MEDIUM noise flooding.** 
The apparatus emits 319 MEDIUMs; the solo arms emit roughly 750 each—a 2.3× volume ratio. HIGH-only adjudication makes these arms look identical on the exact dimension where they differ most. If the solo arms' extra MEDIUMs are mostly false, HIGH-only hides the flooding. If they are real, HIGH-only hides their recall advantage. The hard eligibility ceilings (false-rate ≤ 0.33, noise-rate ≤ 0.5) do not rescue you: computed over graded HIGHs only, they constrain HIGH noise while an arm could pass eligibility while emitting 700 false MEDIUMs. The ceiling becomes vacuous on the axis of maximum variance.

**B. It rewards severity inflation.** 
If one arm expresses a real concern as MEDIUM while another inflates a similar concern to HIGH, a HIGH-only sheet rewards the inflating arm. Your evaluation is conditioned on the models' own severity assignments rather than adjudicated severity.

**C. It amputates 29% of your ground truth.** 
4 of the 14 known defects are MEDIUM-severity. HIGH-only makes those 4 defects invisible to the known-defect recall metric. You cannot report "known-defect recall" with a straight face while silently excluding 29% of the known defects.

**Direction of bias:** HIGH-only favors the high-MEDIUM-volume arms (the solo models) by shielding them from noise-flooding penalties, while simultaneously failing to credit them if their high volume represents actual recall. 

## 2. Is Stratified Sampling of MEDIUM Clusters Defensible?

Yes. Sampling ~250 clusters out of ~1,330 is a 19% sampling fraction. With finite-population correction, this yields manageable confidence intervals—roughly ±0.15 on per-arm MEDIUM precision estimates. This is wide enough that you cannot detect tiny differences, but given the 2.3× volume gap, a <0.15 precision difference would itself be a surprising, reportable finding. 

**Correct Stratification:** 
Do not stratify by "Arm" alone, because the sampling unit is the *cluster*, and clusters can contain findings from multiple arms. Multi-arm clusters are highly efficient because a single human label updates the precision estimates for multiple arms simultaneously. 

Stratify by:
1. **Commit-block (`ff20d85e` vs rest):** Mandatory. One commit drives 30% of clusters. Isolating it prevents domination and allows a pre-registered sensitivity analysis (reporting conclusions with and without `ff20d85e`).
2. **Arm-incidence bucket (A-only, Sonnet-only, Fable-only, X3-only, Multi-arm):** Mandatory. Ensures you capture per-arm discipline and oversample high-value multi-arm clusters.

Avoid stratifying by semantic category or cluster size as primary dimensions; they over-fragment the sample. Record them as metadata for post-hoc subgroup analysis.

**Estimator:**
Store the inclusion probability $\pi_i$ for each sampled cluster. Use a Horvitz-Thompson or Hájek estimator for each arm's MEDIUM precision and noise mass. Propagate uncertainty using a stratified finite-population bootstrap. Treat the eligibility ceiling honestly: if an arm's upper 95% CI bound for noise-rate crosses the ceiling, label it "indeterminate" rather than forcing a hard pass/fail.

## 3. Measuring "Stacking" Without Grading Every MEDIUM

The compound-risk argument (that several MEDIUMs stack into a HIGH-grade architectural problem) is plausible but empirically untested in your data. You should measure it directly without grading all 1,330 MEDIUMs.

**Add a Compound-Pattern Adjudication Layer:**
Before shuffling, mechanically generate candidate pattern groups using metadata: `(commit, file-path-prefix/subsystem, normalized issue class)`. A group becomes a candidate pattern if it has $\ge 3$ distinct MEDIUM clusters, or $\ge 2$ arms independently mentioning the same concern, or $\ge 6$ total raw findings. 

The adjudicator receives a packet of these source-stripped clusters and answers:
1. Do these collectively establish a real, larger architectural issue? (proven / actionable / plausible / false)
2. Is there severity uplift? (remains MEDIUM vs escalates to HIGH-equivalent)
3. Which clusters are supporting evidence?

This requires roughly 50–80 additional holistic grading decisions. It directly tests the stacking hypothesis. If <5% of hotspots escalate to HIGH-equivalent, the stacking argument is refuted for this dataset, and you report that honestly.

## 4. The Known-Defect-Anchored Design

Yes, grading all clusters that plausibly match the 14 known-defect rubrics—regardless of emitted severity—is the single best information-per-labeling-minute addition. 

Known-defect recall is anchored to ground truth, making it far less subjective than free-form precision grading. By LLM-pre-screening all 1,330 MEDIUM clusters for plausible matches to the 4 MEDIUM-severity rubrics (and the 10 HIGH ones), you create a certainty stratum of perhaps 50–120 clusters. Grading this census gives you exact known-defect recall across all 14 rubrics, ensuring the 4 MEDIUM defects are fully represented.

## 5. The Single Best Design: (c) Full HIGH + Stratified MEDIUM Sample + Compound-Pattern Layer

The optimal design is neither HIGH-only nor full HIGH+MEDIUM. It is a four-tier approach that balances exhaustive grading where it matters most with probabilistic sampling where volume is high.

### Step 0: Pre-register the analysis plan
Freeze the sampling frame, strata, estimators, compound-pattern candidate rules, and known-defect inclusion criteria before adjudication begins.

### Step 1: Full HIGH Census (~599 clusters)
Adjudicate every HIGH cluster. This yields exact HIGH precision, false/noise rates, and headline utility with zero sampling uncertainty. (If a cluster contains both HIGH and MEDIUM findings, the MEDIUM finding inherits the cluster's label for free).

### Step 2: Known-Defect Candidate Census (~50–120 clusters)
LLM pre-screens all MEDIUM clusters for plausible matches to the 14 rubrics. Grade every match. This secures exact known-defect recall, covering the 4 MEDIUM-severity ground truth items.

### Step 3: Compound-Pattern Layer (~50–80 groups)
Mechanically group remaining MEDIUMs by commit + subsystem + issue class. Adjudicate holistic severity uplift for groups meeting the candidate threshold. This tests the stacking hypothesis.

### Step 4: Stratified MEDIUM Sample (~225 clusters)
From the remaining MEDIUM clusters, draw a stratified random sample:
- **Strata:** `Commit-block (2) × Arm-incidence (5)` = up to 10 cells (collapse small cells).
- **Allocation:** Proportional, but cap `ff20d85e` at 30% of the sample. Guarantee minimum representation for single-arm buckets; oversample multi-arm clusters.
- **Estimation:** Use weighted estimators with inclusion probabilities. Report per-arm MEDIUM precision with 95% CIs via bootstrap.

### Step 5: Honest Reporting
- **HIGH precision/recall:** Full enumeration.
- **MEDIUM precision:** Stratified estimate ± CI. Explicitly state: "Differences below ~0.15 are not resolvable at this sampling rate."
- **Known-defect recall:** Exact, across all 14 rubrics.
- **Stacking:** "X% of MEDIUM hotspots collectively indicate HIGH-severity problems."
- **Overall score:** Combine exact HIGH totals with estimated MEDIUM totals, propagating CI uncertainty through the severity-weighted sum. Report key conclusions with and without `ff20d85e`.

**Total incremental workload:** ~275–325 clusters over the HIGH-only baseline. This is roughly a 1.5× workload increase (a long day plus a short session), not a 3.2× multi-day endeavor. It yields a methodologically defensible evaluation that captures the discriminating MEDIUM signal without pretending the sample gives exact rankings.

