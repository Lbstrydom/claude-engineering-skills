# Arm-eval session 37900af4-f756-4425-bd6f-2684a3467cb0

| Field | Value |
|---|---|
| Experiment | brainstorm |
| Phase | prospective |
| Task id | `task-54c840db` |
| Seed (presentation-order RNG) | 2874088198 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-04T15:30:39.397Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Should the model-A/B/C code-audit experiment add a "true base case" arm: the AUTHOR coding model (Sonnet 5, sometimes Fable 5) reviewing its own diff SOLO, with no separate GPT/OSS/Gemini audit pipeline?

Context: We run an observation-only shadow experiment over the code-audit and audit-plan stages. Three arms today, all heavyweight EXTERNAL-auditor pipelines:
- A (baseline/control): GPT-gen audit -> Gemini review. This is the production pipeline.
- B: OSS-gen audit -> 1 GPT round -> Gemini review. Question: "does the GPT round earn its keep?"
- C: OSS-gen audit -> Gemini review (no GPT). Question: "can OSS+Gemini replace GPT+Gemini?"
Gate: needs 12 distinct (commit x stage) shadow units before it ranks; currently at 7/12. Budget EUR5.56 / EUR300 spent. Findings are adjudicated in a ledger (accepted/dismissed); a separate user-visible effectiveness view (persona-correlated ground truth) is currently empty.

The gap I noticed: ALL THREE arms are external auditors compared against EACH OTHER. None measures the counterfactual "what does the author model catch reviewing its own code with NO external audit" -- which is the actual NULL HYPOTHESIS the entire audit apparatus is justified against. If Sonnet-solo self-review catches ~80% of what the GPT+Gemini pipeline catches, the whole external-audit cost is hard to justify; if it catches ~30%, the pipeline is clearly earning its keep.

Questions:
1. Is it worth adding a solo author-model control arm NOW, mid-collection at 7/12, or does that corrupt/reset the existing A/B/C paired comparison? Should it be a parallel independent experiment instead of a 4th arm?
2. How to design it as a FAIR control: the author model already SAW/WROTE the code, so self-review is not blind -- is that a fatal confound or exactly the realistic counterfactual (a dev's own model reviewing its own PR)? Should the "author" model be given the diff cold as if it were a third party, or genuinely self-review in-context?
3. Run BOTH Sonnet-5-solo AND Fable-5-solo (extra token burn, two more arms) or default everything to Sonnet-5 and only spot-check Fable? What's the marginal information value of Fable vs the cost?
4. Failure modes: author self-review bias, non-blindness, ledger/adjudication attribution (the solo arm produces findings that need the same accept/dismiss labeling to be comparable), and whether a solo arm even FITS the shared-stage execution model (arms currently share oss-gen + gpt-round compute; a solo arm shares nothing -- is that a schema problem?).
5. What's the smallest honest version of this that answers the null-hypothesis question without over-building?


## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

# Add the true base case now — as a paired, non-ranking sidecar

## Bottom line

Add **D: AUTHOR-solo cold-diff review** on the same 12 commit×stage units. Do not reset A/B/C. Do not let D participate in the A/B/C ranking gate. Backfill units 1–7 if the diffs and repo snapshots are reproducible; if not, start D at unit 8 and continue past 12 until D has its own 12 paired observations. Budget is negligible (single model, single pass, ~EUR10–20); the real risk is analytical confusion, not cost.

The two experiments answer different questions and should be framed separately:

| | Experiment 1 (A/B/C) | Experiment 2 (D sidecar) |
|---|---|---|
| **Question** | Which *external* auditor pipeline is best? | Is the external apparatus needed *at all*? |
| **Gate** | 12 units, ranking unchanged | 12 paired units, reports lift vs A/B/C |
| **Arms** | A, B, C | D only |

D's findings enter the same ledger with the same adjudication, but D is analyzed as a baseline, not as a fourth competitor in the bakeoff.

---

## 1. Why add now, and why not fold into the ranking

Waiting until A/B/C finishes risks optimizing a pipeline whose necessity hasn't been established. But folding D into the A/B/C ranking muddies the framing: "which external pipeline is best" and "do we need external pipelines" are different questions, and keeping them separate prevents misreads later.

The A/B/C pipelines are independent per unit, so adding D mid-collection does not mechanically corrupt their paired comparison. The concern is purely interpretive — and it's solved by labeling D as a sidecar, not a ranking arm.

**Backfill if possible.** If you have the exact diffs, repo snapshots, stage inputs, and prompt envelopes for units 1–7, run D on those now to get a full 12-paired set once the A/B/C gate completes. If the inputs aren't reproducible, do not fake it — mark D as starting at unit 8 and continue collecting until it reaches 12 paired observations.

---

## 2. Cold diff is the right null, and non-blindness is the point

Two candidate designs:

| Design | Question | Verdict |
|---|---|---|
| **Cold diff** — fresh invocation, diff + repo context + audit instructions, no generation transcript, no external findings | "Does the apparatus catch more than the author-model-as-reviewer?" | **Primary control** |
| **Warm in-context** — same model retains generation session, asked to review its own work | "Does memory of writing the code help?" | Reserve for follow-up if cold-solo lands in the ambiguous middle (50–70%) |

The external apparatus receives a cold diff. The fair comparison is cold-diff-solo vs cold-diff-external-pipeline: same input, different reviewer stack. That's clean.

Non-blindness is not a fatal confound — it's the measurement. The author model shares training-distribution priors with itself and may systematically miss the same class of bugs. That is *exactly* the failure mode the external apparatus exists to catch. Cold review removes session-level bias (the model doesn't "remember" writing it) but does not eliminate style-blindness at the weights level. Don't pretend otherwise — document it.

**Prompt neutrally.** Don't say "you wrote this code." Say: "Review this diff for correctness, regressions, security issues, missing edge cases, and test gaps. Produce only actionable findings using the standard audit finding schema." Give it the same context and tool access the external auditors get. Do not cripple it with a tiny token budget — the point is to test whether heavyweight audit earns its keep against a *fair* solo reviewer, not a strawman.

**Important subtlety to document explicitly:** Arms B/C start from an oss-gen audit; D gets nothing. So D-vs-B/C conflates "author model vs external model" with "no starting audit vs oss-gen starting audit." This is *correct* for the null — the question is whether the *entire apparatus* (including oss-gen) earns its keep. But document it so nobody later misreads D-vs-B as isolating the GPT round (that's B-vs-C).

---

## 3. Match the actual author model per unit; Fable is a spot-check, not a full arm

**Default rule:** If the code was authored by Sonnet 5, run Sonnet-5-solo. If it was authored by Fable 5, run Fable-5-solo. This measures the true counterfactual: "what would the actual author model have caught reviewing its own work?"

Since Sonnet authored most units, Sonnet is your primary baseline. Fable data will be sparse and descriptive — that's fine for now.

Do **not** run both Sonnet-solo and Fable-solo on every unit. That doubles cost, halves per-arm unit count, and answers a question you don't need yet: "is the self-review gap model-specific?" That question only matters if:

- Fable authors a meaningful fraction of production diffs, or
- Sonnet-solo lands in the ambiguous 40–70% band where you can't tell if the result is a Sonnet artifact or a general pattern.

If Sonnet-solo catches 25% or 85% of the best external arm's accepted findings, Fable adds no information.

---

## 4. Failure modes — ranked by severity

### 1. Adjudication bias (highest risk)

If the adjudicator knows which arm produced a finding, they'll unconsciously weight external-pipeline findings as more trustworthy. **Must blind the adjudicator to arm identity.** Strip arm labels, shuffle findings across arms, label with opaque IDs. This is the single most important design decision. If full blinding isn't feasible, at minimum randomize display order and hide arm labels during first-pass adjudication.

### 2. The denominator problem (high, currently unaddressed)

"Catch rate" needs a ground-truth denominator. Your effectiveness view (persona-correlated ground truth) is currently empty — without it, you can only compare *accepted findings count*, not *recall*. If D produces fewer total findings, you can't distinguish "caught less" from "found different issues."

Two options:
- **Ideal:** Populate the effectiveness view (ground-truth issue set) for all 12 units before the comparison is meaningful.
- **Pragmatic fallback:** Use the *accepted union* across A/B/C/D as a proxy denominator. Compute each arm's recall against that union. Not perfect ground truth, but far better than comparing arms only to each other's outputs.

Pick one and commit to it before looking at results.

### 3. Solo arm produces different-but-valid findings (measured, not a failure)

A solo arm may be worse overall but still catch issues external pipelines miss. Measure both directions:
- Findings unique to D (issues only the author model catches)
- Findings unique to A/B/C (issues only external pipelines catch)
- Total accepted union per unit

This matters if you later consider hybrid designs (e.g., solo prefilter + external audit on flagged diffs).

### 4. Self-review style-blindness (real but *measured* confound)

The author model shares priors with itself and may miss the same class of bugs. This is the confound the external apparatus is supposed to catch. You are not confounded; you are measuring the confound. Cold review removes session-level memory but not weights-level preference overlap. Document this.

### 5. Schema fit (nuisance, not blocker)

D shares no pipeline nodes with A/B/C (no oss-gen, no GPT, no Gemini). If your schema requires every arm to have those artifacts, the schema is overfit to the current pipelines. Make `oss_gen_audit` and `gpt_round` nullable/empty for D. The findings schema is what's shared, and that's all that matters for the ledger.

---

## 5. Smallest honest version

### Arm D: AUTHOR-solo cold-diff control

For each commit×stage unit:

1. Use the same diff/repo snapshot as A/B/C
2. Invoke the **actual author model** for that unit (Sonnet or Fable, whichever wrote it)
3. Give it the standard audit instructions and finding schema
4. No A/B/C outputs, no external findings, no original coding transcript
5. Findings go into the same ledger
6. Blind adjudicate accepted/dismissed (arm identity hidden)
7. Compare against A/B/C using the metrics below

No Fable cross-coverage. No in-context variant. No second-stage reviewer. No parallel experiment. ~12 units of single-model single-pass review.

### Minimal metrics

| Metric | What it tells you |
|---|---|
| **Accepted findings by arm** | Raw precision comparison |
| **Severity-weighted accepted findings** | Does the apparatus catch *important* issues, or just more nits? |
| **External lift over D** | `accepted_unique_findings_A_not_in_D` — the core business question |
| **D recall vs accepted union** | `accepted_D / accepted_union` — how much does solo miss? |
| **Cost per incremental accepted finding** | `(cost_A − cost_D) / accepted_unique_findings_A_not_in_D` — the ROI metric |

### Pre-registered interpretation bands

Decide these *before* looking at results:

| Solo catch rate (severity-weighted, vs best external arm) | Interpretation | Action |
|---|---|---|
| **< 40%** | External apparatus clearly justified | Keep current pipeline, optimize within A/B/C |
| **40–70%** | Ambiguous | Run larger paired experiment + Fable spot-check + consider warm in-context variant |
| **> 70%** | External apparatus questionable | Consider replacing, downsampling, or reserving external audit for risky diffs only |

A heavyweight audit that finds one extra low-severity nit at 20× cost is a different conclusion from one that finds a critical bug the author model missed. The severity-weighted lift metric is what makes that distinction.

---

## Immediate action list

1. **Do not reset A/B/C.** The 7/12 gate and ranking are intact.
2. **Add D as a non-ranking sidecar.** Same units, same ledger, separate analysis frame.
3. **Backfill units 1–7** if diffs/snapshots are reproducible; otherwise start at unit 8.
4. **Use the actual author model per unit** (Sonnet-authored → Sonnet-solo, Fable-authored → Fable-solo).
5. **Blind the adjudicator** to arm identity. This is non-negotiable.
6. **Commit to a denominator** before results: effectiveness view if you can populate it, accepted union as fallback.
7. **Report external incremental lift over D** alongside the A/B/C ranking. That's the missing null hypothesis.

### output-2

## Combined take

Yes, the missing base case is real and important. But do **not** mutate the current A/B/C experiment into a normal 4-arm ranker mid-flight.

The sharp recommendation:

> Add a **solo author-model review control** as a **sidecar / parallel matched experiment** on the same `commit × stage` units, adjudicated in the same ledger, but analyzed separately from the A/B/C ranking.

This preserves the current external-auditor comparison while finally answering the economic null hypothesis:

> “What does the heavyweight external audit apparatus buy over simply asking the author coding model to review the diff by itself?”

---

# 1. Add it now? Yes — but not as a naïve 4th ranker arm

Do **not** reset A/B/C. Do **not** change the current 12-unit gate. Do **not** let the new control contaminate the production/baseline comparison.

Instead:

- Let A/B/C continue exactly as planned to 12/12.
- Add a standalone solo-review sidecar using the same unit key: `commit × stage`.
- Backfill the first 7 units if you still have the exact inputs.
- Run it alongside units 8–12 going forward.
- Analyze it only once you have matched coverage.

The cleanest design is:

| Unit | A | B | C | Solo author-model control |
|---|---:|---:|---:|---:|
| 1–7 | already run | already run | already run | backfilled |
| 8–12 | normal | normal | normal | run in parallel |

If you cannot backfill the first 7, do not compare solo results from units 8–12 against A/B/C results from units 1–12 as if they were equivalent. Instead continue the solo sidecar until you have enough overlapping units.

So the answer is:

> Add it now operationally, but treat it as a separate matched null-hypothesis experiment, not as a fourth arm in the current ranker.

---

# 2. Fair control: hot self-review or cold diff review?

There are two different estimands:

## A. Realistic operational null

“What if, instead of external audit, we asked the author model to review its own work?”

For this question, non-blindness is not a fatal confound. It is the realistic counterfactual. A developer reviewing their own PR is not blind either.

## B. Capability baseline

“How good is the same model as an auditor when given the diff fresh?”

For this question, a cold review is fairer and more reproducible.

For the current experiment, use the **cold matched solo review** as the smallest honest version:

- fresh call,
- same author-model family if possible,
- original task/request,
- diff,
- relevant repo context,
- stage context,
- no external audit artifacts,
- no prior findings,
- no A/B/C outputs.

Why cold?

- It can be backfilled for the first 7 units.
- It is reproducible.
- It is comparable to the external auditor arms, which are also reviewing artifacts rather than continuing the original authoring trajectory.
- It avoids context-window self-rationalization from the model’s own recent generation path.

But label it honestly. This is not “hot in-conversation self-review.” It is:

> “solo same-author-model cold review.”

If later you want to test the actual product UX, run a small follow-up:

- hot self-review immediately after authoring,
- cold same-model review,
- external pipeline,
- same adjudication.

Do not mix hot and cold results without metadata.

---

# 3. Run primary-model solo and secondary-model solo?

Do **not** add two full solo arms now.

The marginal information value is low at `n=12`, and the real cost is not tokens; it is adjudication burden and interpretability.

Use one solo control.

Best rule:

> The solo reviewer should be the model that would realistically perform the self-review in production.

Practical policy:

- If the primary author model writes most diffs, use the primary author model for the solo arm.
- If a diff was actually authored by the secondary model and that matters operationally, use the matched secondary model for that unit and record it in metadata.
- Do not try to estimate primary-vs-secondary solo audit quality from this experiment.
- Only spot-check the secondary model later if the primary solo control looks surprisingly competitive with the external pipeline.

Reasoning:

- If the stronger/default author model solo review catches very little, the external pipeline is justified; testing the weaker/less common model adds little.
- If the stronger/default author model catches 80–90% of accepted external findings, then testing the secondary model becomes important because solo review may be a viable replacement or pre-filter.
- At 12 units, a full factorial author/reviewer model comparison will be noisy and overbuilt.

So the MVP is:

> One solo control, defaulting to the primary author model, with matched-author metadata where relevant. No full second solo arm yet.

---

# 4. Failure modes and mitigations

## Failure mode: author self-review bias

Yes, the solo reviewer may miss issues because it is reviewing its own work or same-model work.

That is not a reason to avoid the control. That is exactly what you need to measure.

Key metric:

> What accepted findings does the external pipeline find that solo review misses?

Do not focus only on raw finding counts. Use:

- accepted findings,
- severity-weighted accepted findings,
- external-only findings,
- solo-only findings,
- false positives,
- cost per accepted finding,
- latency per accepted finding.

---

## Failure mode: non-blindness

For cold solo review, give it the task and diff, but not the external audit artifacts.

Forbidden inputs:

- A/B/C outputs,
- generated audit reports from other arms,
- review-round text from other arms,
- previous adjudication results,
- accepted/dismissed ledger labels.

Record metadata:

```json
{
  "arm": "solo_author_model_control",
  "review_mode": "cold_same_author_model_review",
  "author_model_class": "primary_or_secondary",
  "reviewer_model_class": "primary_or_secondary",
  "saw_original_task_context": true,
  "saw_diff": true,
  "saw_external_audit_artifacts": false,
  "same_conversation_as_authoring": false
}
```

If you later run hot self-review, make that a separate mode:

```json
{
  "review_mode": "hot_in_context_self_review"
}
```

---

## Failure mode: ledger/adjudication attribution bias

This is the biggest practical risk.

The solo arm must go through the same adjudication process as A/B/C.

Recommended flow:

1. Collect raw findings from all arms.
2. Normalize them into the same finding schema.
3. Cluster semantically equivalent findings across arms.
4. Adjudicate finding clusters, ideally with source arm hidden.
5. Mark each cluster:
   - accepted/dismissed,
   - severity,
   - affected area,
   - arms that found it.
6. Unmask arm attribution only after adjudication.

The useful artifact is a found-by matrix:

| Finding cluster | Accepted? | Severity | A | B | C | Solo |
|---|---:|---|---:|---:|---:|---:|
| Bug 1 | yes | high | ✅ | ✅ | ❌ | ❌ |
| Bug 2 | yes | medium | ❌ | ✅ | ✅ | ✅ |
| Bug 3 | no | low | ❌ | ❌ | ✅ | ✅ |
| Bug 4 | yes | high | ❌ | ❌ | ❌ | ✅ |

This lets you measure overlap and incremental value instead of just counting duplicated reports.

---

## Failure mode: solo arm does not fit shared-stage execution

That is fine. Do not force it into the existing shared execution graph.

The existing arms share intermediate compute. The solo control shares nothing except the experiment unit and input bundle.

Model it as an independent pipeline:

```yaml
arm: solo_author_model_control
unit: commit_sha × stage
inputs:
  - original_task_context
  - diff
  - relevant_repo_context
  - stage_context
excluded_inputs:
  - external_audit_outputs
  - other_arm_findings
  - adjudication_results
outputs:
  - normalized_findings
```

This is a schema issue, not a conceptual blocker.

The join point is the ledger, not the execution DAG.

---

## Failure mode: accepted/dismissed ledger is not perfect ground truth

Correct. Right now, you are measuring accepted adjudicated finding yield, not true production defect prevention.

That is still useful, but be precise about the claim.

Current claim:

> “Solo review recovered X% of accepted audit finding clusters under our adjudication process.”

Not yet:

> “Solo review prevented X% of real production defects.”

Once the user-visible/persona-correlated effectiveness view has data, you can re-score historical findings by actual downstream impact.

---

# 5. Smallest honest version

The smallest honest version is:

## Add one standalone solo-review sidecar

Do not touch A/B/C.

### Inputs

For each `commit × stage` unit:

- original task/request,
- diff,
- relevant surrounding code/repo context,
- stage context,
- same output schema as the other arms.

### Exclusions

The solo arm must not see:

- external audit reports,
- intermediate review rounds,
- other arms’ findings,
- adjudication decisions.

### Execution

- Backfill units 1–7 if possible.
- Run units 8–12 going forward.
- If backfill is impossible, collect until solo has enough matched overlap.

### Adjudication

- Inject findings into the same ledger.
- Deduplicate/cluster across arms.
- Blind adjudicate if possible.
- Unmask source arms after accept/dismiss/severity labeling.

### Metrics

Primary metrics:

1. **Solo recall against accepted union**

   Of all accepted finding clusters found by any arm, what fraction did solo review find?

2. **Solo recall against production baseline**

   Of accepted findings found by the current production pipeline, what fraction did solo review also find?

3. **External incremental yield over solo**

   Accepted findings found by A/B/C or production baseline but missed by solo.

4. **Solo unique yield**

   Accepted findings found only by solo.

5. **False-positive burden**

   Dismissed findings per arm.

6. **Severity-weighted value**

   External-only high/critical findings matter much more than low-severity nits.

7. **Cost/latency**

   Cost and runtime per accepted or severity-weighted accepted finding.

---

# Decision interpretation

Use severity-weighted accepted findings, not just counts.

Rough guide:

- If solo catches **~80%+** of accepted severity-weighted findings and external-only findings are mostly low value, the external pipeline may be overbuilt.
- If solo catches **~30–50%** and external-only findings include meaningful medium/high defects, the external pipeline is probably earning its keep.
- If solo finds many unique accepted issues, the best system may be self-review plus external review, not one or the other.
- If solo has high false positives, its apparent low token cost may be offset by human adjudication cost.

---

# Suggested solo-review prompt

```text
You are reviewing a code diff for correctness, security, maintainability, and integration risk.

You are given:
- the original task/request,
- the relevant code diff,
- necessary surrounding context,
- the audit stage being evaluated.

Do not assume the implementation is correct. Look for concrete issues that could cause bugs, regressions, security problems, data loss, incorrect behavior, brittle behavior, or maintainability hazards.

Return only actionable findings. For each finding include:
- title
- severity: low / medium / high / critical
- affected file/function
- explanation
- why it matters
- suggested fix
- confidence

Avoid stylistic comments unless they create real risk.
Do not invent issues not supported by the diff.
```

For the cold MVP, avoid pretending the model is literally continuing the original authorship session. If you later test hot self-review, use a separate prompt/mode such as:

```text
You previously authored this change. Now review your own diff critically before it is accepted.
```

But keep that as a separately labeled condition.

---

# Final recommendation

Add the true base case, but as a **sidecar null-hypothesis control**, not as a normal fourth arm in the active A/B/C ranker.

Concretely:

> Run one cold solo review using the relevant author-model class on the same `commit × stage` units, backfill the first 7 if possible, adjudicate through the same blinded ledger, and compare accepted severity-weighted finding overlap and incremental yield against the external pipelines.

Do not reset A/B/C. Do not add a full second solo model arm yet. Do not overbuild the execution schema. The join point is the adjudication ledger.

This gives you the answer you actually need:

> Is the external audit apparatus buying enough accepted, severity-weighted defect discovery over solo author-model review to justify its cost, latency, and complexity?

### output-3

# The Missing Control IS the Experiment

You have three treatments and zero controls. Every arm is a variant of "expensive external pipeline." The questions "does the GPT round earn its keep?" (B vs C) and "can OSS replace GPT?" (C vs A) are second-order. The first-order question — *does any of this earn its keep vs. letting the author model re-read its own diff?* — is unmeasured. Ship a ranking of A/B/C without this baseline and you get "which external pipeline is best" while remaining unable to tell stakeholders whether external auditing is worth anything at all.

This isn't a nice-to-have arm. It's the arm that gives the other three meaning. And it's the cheapest arm to run — one model call per unit vs. multi-step pipelines.

---

## 1. Add now as Arm D; backfill the 7

Adding an arm cannot corrupt the A/B/C comparison — those arms ran identically on the same 7 units. Because this is a paired (commit × stage) shadow design, you must evaluate D on the *same* 12 units. A parallel independent experiment sacrifices within-unit pairing and doubles cost for no statistical gain — commit complexity varies wildly, and without blocking on the same diffs, any D-vs-ABC difference is confounded with difficulty variance.

**Backfill logistics:** Shadow observation implies you logged the inputs. If the 7 diffs are stored and replayable, backfill D for near-zero logistics cost and run all 4 arms on the remaining 5. You get 12 paired quad-arm units — the cleanest possible within-unit design.

**Critical caveat:** If the author model's generation context (system prompt, conversation history, tool calls) is discarded, a retroactive "self-review" on the stored diff is actually the cold-review variant, not true in-context self-review. Check what you stored. This determines which variant of D you're actually running on the backfilled 7, and you should label it honestly.

If the 7 diffs are *not* replayable: don't restart. The A/B/C data on those 7 is valid for the A/B/C question. Run D on the 5 new units paired, accept n=5 for the D comparison, and note it's underpowered.

---

## 2. Run BOTH cold and in-context — but only one as primary

This is the sharpest disagreement in the design space, and it's worth resolving explicitly rather than picking one blindly.

**In-context self-review** (model reviews its own diff with the context it had when writing it — diff + PR description + relevant files, but NOT internal chain-of-thought, since a production self-review step wouldn't replay private reasoning) is the **ecologically valid null**. A developer's model reviewing its own PR is non-blind by definition. The anchoring bias, the confirmation bias, the "I wrote this so it's fine" effect — those are the *result you're measuring*, not artifacts to eliminate. If self-review is biased, the pipeline is justified. If it isn't, maybe the pipeline isn't. A developer doesn't forget their code and then re-review it cold; they review what they just wrote with everything they know.

**Cold same-model review** (author model gets its own diff as if it were a stranger's, fresh session, no memory, same auditor prompt as the external arms) is the **fair-capability null**. The external pipelines receive the diff cold — if you want to isolate "can this model audit code at all?" from "does generation context blind it?", you need the cold variant. If cold >> in-context, you've found that "same model, fresh session" is a cheap audit improvement. Interesting, but follow-up.

**Resolution: Run in-context as primary D.** It's the actual production counterfactual — the thing the audit apparatus is justified against. Don't "make it fair" by blinding it; you'd be testing a scenario that doesn't occur in practice. But **also run cold on a 3-unit subset** (cheap — three extra single-call units) to decompose the bias effect from the capability effect. If cold and in-context produce nearly identical results, you know the model isn't blinded by its own context and the distinction doesn't matter. If they diverge sharply, you've generated a follow-up question and a quantified bias estimate for free.

**One fairness concern worth noting, not obsessing over:** In arms A/B/C, do the external auditors know which model authored the code (from style, naming conventions, diff metadata)? If so, they're not fully blind either. The asymmetry between "D is non-blind to self" and "A/B/C may be semi-blind to author identity" is real but minor — document it, move on.

---

## 3. Match the author model to the diff; default to Sonnet

The null is "the **author** model reviewing **its own** diff." If some diffs were authored by Fable-5 and you run Sonnet-5-solo on them, you're testing "Sonnet reviews Fable's code" — just another external auditor.

Look at your composition:
- **Fable-authored diffs ≤2 of 12:** Run Sonnet-solo on all, spot-check Fable-solo on those 1–2, note the limitation. Fine.
- **Fable-authored diffs ≥4 of 12 (≥⅓):** You must run Fable-solo on those units, otherwise you're systematically mismeasuring the null for a third of your sample.

**Don't run both Sonnet-solo and Fable-solo on all 12.** Your compute budget is underutilized (€5.56 / €300), but your **human adjudication budget** is not — every new arm generates distinct findings requiring manual accept/dismiss labeling. Use Sonnet-solo as the ceiling for the null hypothesis: if the most capable author model can't replace the pipeline, Fable certainly can't. Only if Sonnet-solo proves the pipeline is a waste should you test whether Fable can do it even cheaper.

Cost framing people get wrong: a solo self-review is one model call per unit. D is the cheapest arm in the experiment. Don't let token-cost anxiety block the most cost-efficient arm.

---

## 4. Failure modes, ranked by danger

**Most dangerous — adjudication bias.** The ledger adjudicator labels findings accept/dismiss. If they know a finding came from "the self-review arm," they'll subconsciously expect it to be worse (or better) and label accordingly. This contaminates the comparison. **Blind the adjudicator to arm source.** Findings enter the ledger with arm identity stripped or coded. Same adjudicator, same criteria, no arm labels. This applies to ALL arms but is most acute for D because the prior expectation ("self-review is weak") is strongest.

**Second — the empty effectiveness view.** You have a ledger of accept/dismiss but no ground truth on whether "accepted" findings correspond to actual bugs. The entire experiment — all four arms — measures finding-overlap, not bug-detection-accuracy. This limitation applies equally to all arms, so the D comparison is valid *relative* to the others. But state it explicitly: "We measure whether arms converge on the same findings, not whether those findings are real bugs." The effectiveness view, when populated, retroactively validates all four arms. **Prioritize populating it over adding more arms or variants.**

**Third — schema/plumbing.** Arms A/B/C share oss-gen and gpt-round compute stages. D shares nothing. Don't force D into the shared-stage execution model. From a DAG perspective, D is a parallel node branching straight off the root "Diff" and going straight to "Findings." Run it standalone, output in the same ledger format (same finding schema, same severity fields). Comparability lives in the output schema, not the input pipeline. This is a 2-hour plumbing problem.

**Fourth — cost attribution distortion.** A/B/C share compute, so their per-arm cost isn't fully attributable. D's cost is fully attributable (one call). If you compute "EUR per finding caught," D will look artificially cheap if you use D's true marginal cost but A/B/C's average cost. Use **marginal cost** for all arms — "what would you stop spending if you dropped this arm?" For A/B/C, dropping one arm may not eliminate shared-compute costs. Be explicit about this.

**Not actually dangerous — self-review bias.** Anchoring, confirmation, ego, context momentum. This is the measured quantity, not a failure. If self-review is biased, the pipeline is justified. Document it as a finding.

---

## 5. The smallest honest version

1. **One new arm (D):** Sonnet-5 in-context self-review. Diff + PR context. No internal CoT replay. One model call per unit.
2. **Run on all 12 units.** Backfill the 7 if diffs are stored; label honestly as cold-review if authoring context wasn't preserved. If not replayable, run on 5 new paired and accept n=5 underpowered.
3. **3-unit cold-review subset:** Same model, fresh session, same auditor prompt as external arms. Decomposes bias from capability. Three extra single-call units.
4. **Match author model to diff.** If ≥4 units are Fable-authored, add Fable-solo on those specific units. Otherwise spot-check and note it.
5. **Blind adjudication.** Strip arm identity before the ledger. Same adjudicator, same criteria, no arm labels. This is non-negotiable.
6. **Two metrics only:**
   - *Primary:* Recall of D relative to the union of A/B/C accepted findings. "What fraction of externally-caught, adjudicated-accepted findings does solo self-review also catch?"
   - *Secondary:* D-exclusive findings. "Does solo catch anything the external arms missed?" If yes — especially if adjudicated-accepted — D reframes from "baseline" to "complementary signal."
7. **Don't build:** a separate parallel experiment, a new effectiveness view just for D, any schema changes to shared-stage execution, or full Fable-solo on all 12. D writes to the existing ledger format and that's it.

**Pre-registered decision rule:** If D catches ≥70% of the A/B/C union's accepted findings → the external pipeline's marginal value is questionable; run a cost-effectiveness follow-up. If D catches ≤40% → the pipeline is clearly earning its keep; stop questioning it and refocus on A/B/C optimization. In between → you need more data or the effectiveness view to resolve it.

---

**One sentence:** Add D now — backfilled, blind-adjudicated, author-model-matched, in-context self-review with a 3-unit cold subset — because it's the cheapest arm, it answers the only question that matters, and without it your A/B/C ranking is three answers looking for a question.

