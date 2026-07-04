# Arm-eval session 7492c385-725c-4176-958e-7a6c408db4a1

| Field | Value |
|---|---|
| Experiment | brainstorm |
| Phase | prospective |
| Task id | `task-6ebab789` |
| Seed (presentation-order RNG) | 1177611106 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-04T15:34:22.930Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Refinement round. We're converging on adding a solo author-model control (Sonnet-5) to the code-audit experiment, run as an OFFLINE script over the 12 ledger diffs rather than a 4th arm in the shared-stage harness. Please react to and pressure-test THREE sharpened points that emerged, then help me lock the smallest honest design.

POINT 1 — The rigged-ledger confound (the load-bearing one). Our existing accept/dismiss labels were produced BY the external pipeline (GPT+Gemini adjudication). So a solo-Sonnet finding only scores "accepted" if it matches something the external apparatus already raised and accepted. Any REAL bug Sonnet catches that the external arms never surfaced has no baseline to match -> it sits "pending" forever and reads as noise. This means the overlap metric is structurally biased toward the incumbent: S can only ever look like a SUBSET of A. Proposed fix: re-adjudicate the MERGED, BLINDED UNION of findings from all arms (A/B/C/S) with a neutral judge that doesn't know which arm produced each finding. Questions: (a) Is blind union re-adjudication actually necessary, or is it over-building for N=12? (b) Who judges -- a human, or Claude-with-labels-stripped (note: Claude/Sonnet is ALSO the author being tested, so is there a judge-family conflict if Claude judges an arm that includes Claude's own solo output)? (c) Is there a cheaper unbiased proxy than full re-adjudication?

POINT 2 — Two conditions vs one. In-context self-review answers "should the author bother running ANY external audit?" Cold-diff same-model answers "does using a DIFFERENT auditor matter vs just a capable model + audit prompt?" These are different decisions. Both are cheap off the same 12 diffs. Is running BOTH conditions worth the extra adjudication load, or does one dominate for a first pass? Which single one if we must pick?

POINT 3 — Sequential vs parallel counterfactual. In production, self-review happens BEFORE external audit and CHANGES the diff the auditor sees. Running S and A/B/C on the same frozen diff overstates the external arms' marginal value (in reality they'd see post-self-review code). Do we need to model the sequential pipeline (self-review -> fix -> then external audit on the fixed diff), or is it enough to just CAVEAT that our parallel numbers are an upper bound on external-audit marginal value? Modeling it sequentially is a lot more work.

Also weigh in: is a EUR0 static analyzer (Semgrep) a better/complementary null baseline than the author model, or a distraction from the specific question "does the author model reviewing its own work make our external pipeline redundant?"

Give me the smallest honest design that survives these three confounds.


## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

## The Three Confounds, Pressure-Tested and Reconciled

### Point 1 — The Rigged-Ledger Confound

**This is the load-bearing one, and re-adjudication is the bare minimum, not over-building.** Without it, Sonnet can only ever score as a subset of the incumbent pipeline — any real bug it catches that the external arms missed has no "accepted" label to match and reads as noise. The experiment would measure compliance, not accuracy. N=12 is exactly the regime where the "expensive" option is cheap; you'd cut corners at N=1200, not here.

**(a) Necessary, not over-building.** The union of findings across 12 diffs is plausibly 80–250 deduplicated items. That's a few hours of expert time. Affordable.

**(b) Who judges — human, or a different LLM family?** Claude judging Claude is a real conflict, and blinding alone doesn't solve it. Even with labels stripped, Sonnet's findings carry stylistic tells — hedged phrasing, structured severity framings, formulaic root-cause layouts — that a same-family judge may unconsciously recognize or grade differently, in either direction. Using GPT or Gemini as judge re-imports the original pipeline's bias, which is the bias you're trying to escape. If A/B/C/S span GPT/Gemini/Claude, there is no neutral LLM family left. **Human is the only fully honest judge at N=12.** If human is truly infeasible, the fallback is a top-tier model from a strictly different provider family (e.g., GPT-4o), with two mitigations: (i) normalize every finding to a fixed template — location, category, severity, description, suggested fix — before adjudication to strip stylistic tells, and (ii) human spot-check 15–20% to calibrate the judge's neutrality. Report the calibration; don't pretend it's gold.

**Hidden gotcha: deduplication is itself a judging step.** When A flags "integer overflow at L42" and S flags "unbounded transfer amount," are those the same finding? The union size — and therefore every recall number — depends on this call. Make dedup its own pass with a documented rule (e.g., "same location + same root cause = same finding"), and have the judge do dedup and adjudication in one pass so the calls are internally consistent.

**(c) Cheaper unbiased proxy — yes, and it's the right starting point.** Don't re-adjudicate the full union. Instead:

- **Intersection** (both Sonnet and incumbent flagged the same deduplicated finding): auto-accept as true positive. If two independent arms agree, it's real. Optionally spot-check 20% to validate this assumption.
- **Symmetric difference** (Sonnet-only findings AND incumbent-only findings): these are the only items that need neutral adjudication. This is the load-bearing signal — it tells you both "what did Sonnet catch that external missed" AND "what did external catch that Sonnet missed," which is the symmetric comparison the experiment requires.

This cuts the adjudication set roughly in half while preserving the decisive metric. Note: you must adjudicate *both sides* of the symmetric difference, not just Sonnet's novel findings — the incumbent's "accepted" labels are self-certified by the same pipeline you're testing for redundancy, so they may include false positives that inflate the incumbent's recall. If the directional verdict from this partial pass is ambiguous, escalate to full union re-adjudication. But start here.

### Point 2 — Two Conditions vs. One

**Pick in-context self-review. Skip cold-diff for round 1.**

The core question is a *decision*: "If the author model reviews its own work in-context, does that make the external pipeline redundant?" In-context self-review answers this directly — it maximizes ecological validity because it mirrors the actual workflow (author has full conversation history, intent, and working state).

Cold-diff same-model answers a *mechanism* question: "Is the value in the context or in the raw capability?" That's an ablation you only need if round 1's numbers come out counterintuitive or ambiguous and you want to understand *why*. It doesn't change the verdict — if in-context Sonnet catches ~80% of what external catches plus novel real bugs, the decision is made regardless of whether that 80% came from context or capability.

Running both stretches N=12 thin and conflates two different questions. The extra adjudication load is small (findings overlap heavily across conditions, so marginal findings scale sub-linearly), but the real cost is your thinking time and inference complexity. Don't let it delay round 1.

### Point 3 — Sequential vs. Parallel

**Parallel is acceptable for round 1, but with a sharper caveat and a targeted sequential check on the load-bearing subset.**

The parallel design isn't just an upper bound on external's marginal value — it's an upper bound that *biases against the redundancy hypothesis*. If you're trying to show external is redundant, parallel is the worst case for that claim (it inflates external's apparent value because external sees the pre-self-review diff). So a null result in parallel is genuinely informative; a positive result (external still valuable) is uninterpretable without sequential confirmation.

Full sequential modeling is over-building: it requires a multi-step harness, and it introduces a compounding variable — *how* Sonnet's fixes are applied. A sloppy fix might introduce new bugs, skewing external's results in a way that has nothing to do with the core question.

The compromise: **run sequential only on the subset of diffs where Sonnet-solo has at least one adjudicated-true novel finding.** On every other diff, sequential ≈ parallel by definition (no fix to apply, so external sees the same diff either way). On the load-bearing diffs — say 3–6 in practice — apply Sonnet's proposed patches (manually if needed, it's a handful), re-run A/B/C on the patched versions, and report external's residual catch rate. This bounds the sequential work to a tractable subset and gives you a defensible "external marginal value after self-review" number on exactly the cases where it could matter.

For all other diffs, compute the set-theoretic marginal value from parallel data: `External True Positives − (External TPs ∩ Sonnet TPs)`. This is a mathematically honest upper-bound proxy that requires no additional harness engineering.

### The Semgrep Question

**Null row, not an arm. Run it once, report the catch rate, move on.**

Semgrep checks for deterministic syntax errors, known CVE patterns, and hardcoded secrets. Ledger bugs are semantic — invariant violations, reconciliation drift, double-spend paths, off-by-one in accounting. Semgrep will almost certainly catch ~0 of these. Including it as a null row in the results table costs nearly nothing and anchors the claim "you need *some* LLM for this bug class" — but it doesn't bear on "which LLM configuration," which is the actual question. Spending design effort on Semgrep-as-arm is a side-quest.

---

## The Smallest Honest Design

1. **Arm S = in-context Sonnet self-review on the 12 diffs.** Same audit prompt template as external arms, full conversation/intent available. Skip cold-diff for round 1.

2. **Collect findings from A/B/C/S. Normalize each to a fixed template** (location, category, severity, description, suggested fix) to strip stylistic tells before any judging or deduplication.

3. **Deduplicate the union** with a documented rule (same location + same root cause = same finding). This is a judging step — document the calls.

4. **Partition into intersection and symmetric difference.** Auto-accept the intersection as true positive (both arms independently flagged it). Spot-check 20% to validate this assumption.

5. **Blind-adjudicate the symmetric difference** — both Sonnet-only and incumbent-only findings. Strip all model identifiers. Human judge is ideal at N=12. If infeasible: a strictly different-family LLM judge (GPT-4o), with template normalization and 15–20% human spot-check calibration. Report the calibration either way.

6. **Sequential re-run on the subset only.** Identify diffs where S has ≥1 adjudicated-true novel finding. Apply S's patches, re-run A/B/C on the patched versions of just those diffs. Report external's residual recall. All other diffs stay parallel with the set-theoretic marginal-value proxy and an explicit upper-bound caveat.

7. **Semgrep as null row** in the results table. No further analysis.

8. **Report per arm** against the re-adjudicated union as denominator:
   - Precision (fraction of arm's findings that are real)
   - Recall (fraction of union-true findings the arm catches)
   - Marginal recall over S (what this arm catches that S misses)
   - Marginal recall of S over this arm (what S catches that this arm misses)
   - On the sequential subset: external's residual recall *after* S's patches are applied.

9. **The kill metric:** count of adjudicated-true *incumbent-only* findings. If this is zero or trivially low, the external pipeline is redundant. If Sonnet-only true findings are also zero or trivially low, Sonnet is not a sufficient substitute. Both numbers come from the symmetric difference — that's why adjudicating both sides matters.

**What this design does NOT do**, honestly stated: it doesn't isolate capability vs. context (no cold-diff), it doesn't model the sequential pipeline globally (only on the load-bearing subset), it doesn't test generalization beyond 12 diffs, and if you use a cross-family LLM judge it carries residual bias that the 15% spot-check only partially validates. Each is a round-2 question, not a blocker for round 1.

### output-2

# Combined Take: Smallest Honest Design for the Sonnet-5 Control

## The load-bearing problem and how to fix it

Both takes agree the rigged-ledger confound is the one thing that can invalidate the result, and that it's not fixable by just adding Sonnet as another scorer against the existing ledger. The fix is changing the unit of truth from "things the incumbent pipeline already accepted" to a source-agnostic issue set.

**What to re-adjudicate:** Build a blinded clustered union of all raw findings from A/B/C/S. Normalize into atomic findings, cluster duplicates across arms, strip source labels, assign random cluster IDs, and adjudicate each cluster once — not each model message. This converts the burden from "judge every output" to "judge each distinct alleged issue," which for 12 diffs is probably 150–300 clusters — a one-day human job, not over-building.

**Cost-saving shortcut that's actually honest:** You don't need to re-litigate the cases everyone already agreed on. Re-adjudicate the **asymmetric set** — S-only findings and incumbent-only findings S missed — and trust prior GPT+Gemini labels for the overlap set where ≥2 arms raised the same issue and the external pair already accepted it. This cuts the job ~40% and removes exactly the structural bias you care about. The tradeoff: you lose a free estimate of the incumbent's own adjudication error rate. Take it if budget is tight; take full union if it isn't.

**Who judges:** Human. Not negotiable for the Sonnet-containing arms. Claude judging an arm that contains Claude's solo output is a confound a reviewer flags in one read — stylistic tells and self-consistency bias (in either direction) can't be fully blinded away. A human judge who is blind to arm provenance, given the diff + relevant repo context + the normalized finding, is the clean option and is affordable at this scale. If a human is truly impossible, the fallback is a cross-family model not present in {GPT, Gemini, Claude} — report the judge identity as a caveat. Do not use Claude as sole judge of a Claude-containing union.

**Cheapest honest proxy if full union is impossible:** Re-adjudicate only S's unmatched findings (blind, human-judged). Report S's validated catches as a standalone number plus overlap with the incumbent. Label the incumbent-only number explicitly as "incumbent-favoring, not re-adjudicated symmetrically." This is a one-sided bias check, not a full comparison — say so.

## Which Sonnet condition: reconciling the disagreement

The two takes disagree on which condition is primary. This needs explicit resolution because they answer different questions.

- **In-context self-review** answers the operational question: "Should the author model bother running external audit after reviewing its own diff?" It's contaminated by intent leakage — the author knows what it meant to write, which produces reflection-flavored nitpicking plus rationalized defenses of structural errors. A null result is hard to interpret (bad at auditing, or bad at overcoming its own context?).
- **Cold-diff same-model audit** answers the scientific question: "Does a capable model with an audit prompt substitute for a multi-model pipeline?" It's cleaner — controls for model capability, removes author-context contamination, and matches what you'd actually deploy (a separate audit call, not in-session reflection).

**Resolution: run both, make cold-diff primary.** Generation is cheap off the same 12 diffs, and cluster-level adjudication means marginal burden is modest because the two conditions overlap heavily. The delta between them is itself a finding: if in-context catches 30% of what cold-diff catches, you've learned context contamination costs you ~half your audit power. If they're equal, intent leakage isn't a problem here.

If you must pick one: **cold-diff**, because the cleaner question dominates for a first pass, and the in-context null is ambiguous. But note the operational mismatch — cold-diff doesn't directly simulate "author reviews its own work before external audit." If the result matters enough to act on, a follow-up in-context run is warranted before concluding self-review is or isn't sufficient.

One additional requirement from the in-context condition if you run it: **include previously dismissed external findings** in the union, not just accepted ones. Without dismissed findings you can't estimate precision fairly — you can only measure coverage of a pre-filtered set.

## Sequential vs parallel: don't model it yet

Don't model the sequential pipeline (self-review → fix → external audit on revised diff) in v1. It introduces three new confounds — S's patch quality, regressions from fixes, path-dependence of A/B/C's catch — each as hard as the original one. Parallel is the only design that gives clean apples-to-apples arm comparison.

**Frame the parallel result correctly.** Parallel overstates A/B/C's marginal value: in a real sequential pipeline, S would catch-and-fix a subset of bugs before A/B/C see them, so A/B/C's residual catch is strictly ≤ their parallel catch. So **a parallel result showing S catches meaningful unique real bugs is a conservative lower bound on S's true marginal value.** Say this explicitly — the caveat becomes a strength.

**Add a cheap sequential proxy:** the "perfect self-fix preemption" model. Take validated issues found by S, treat them as removed before external audit, and count validated external-only clusters as residual external value. This gives you a useful bound without rewriting code. Report it as:

> "Under an optimistic preemption model where all Sonnet-found issues would be fixed cleanly before external audit, the remaining external-only validated clusters approximate the residual audit value."

**The one case where this framing fails:** if S catches zero unique bugs in the parallel design, the lower-bound framing is uninformative (zero is a lower bound on anything). In that case, note that sequential could only help S, and a v2 sequential run is warranted before concluding S is redundant. Cross that bridge only if you get the null.

## Semgrep: sanity floor, not study arm

Run it with default rules over all 12 diffs. It costs 10 minutes and zero adjudication. It answers a question reviewers will ask: *are these bugs even hard, or would a free linter have caught them?* If Semgrep catches 70% of the union's accepted findings, your experiment is about a thin residual slice and that reframes everything. If it catches ~10%, it confirms the bugs are semantic and the model-vs-model comparison is the right one.

Do not let it become a 5th arm needing formal adjudication. Do not tune rules. Report "Semgrep default rules caught X of Y accepted real-bug findings" in one line, move on. If rule configuration becomes a fairness debate, it's a distraction — drop it to an appendix or omit.

## The locked design

**Stimulus:** 12 frozen ledger diffs. Same diff to every arm.

**Arms:**
- A/B/C (existing outputs, as-is)
- **S-cold** (Sonnet-5, cold-diff, fresh context, audit prompt) — **primary**
- **S-self** (Sonnet-5, in-context self-review) — secondary, run if generation budget permits
- Semgrep default rules — sanity floor, not adjudicated

**Adjudication:**
1. Pool all raw findings from A/B/C/S. Include previously dismissed external findings, not just accepted.
2. Normalize into atomic findings. Cluster duplicates across arms. Strip source labels. Assign random cluster IDs.
3. Re-adjudicate the **asymmetric set** (S-only ∪ incumbent-only-S-missed) with one human judge. Label each cluster: {real bug / style-or-quality / noise}, severity tier, in-scope/diff-relevant, confidence. Trust prior GPT+Gemini labels for the overlap set.
4. If budget allows: re-adjudicate the full union instead. This also gives you the incumbent's self-adjudication error rate for free.

**Metrics, reported in this order:**
1. **S-cold standalone:** K real bugs caught, out of N findings raised.
2. **S-cold unique:** real bugs S caught that no incumbent arm caught. *(This is the headline — the number that would have been "pending forever" under the old design.)*
3. **S-cold overlap:** of those K, how many also caught by ≥1 incumbent arm.
4. **External residual after S (optimistic preemption):** validated clusters found by external union but not by S-cold. Report both count and severity-weighted count. This is the number that answers "is external audit still needed?"
5. **Incumbent-unique that S-cold missed**, with explicit caveat that this number is incumbent-favoring unless full blind union was done.
6. **Overlap matrix:** pairwise and union overlaps across all arms.
7. **Semgrep catch rate** as floor.
8. If S-self was run: same metrics, plus S-cold vs S-self delta.

**Severity-weighting:** Report both unweighted and severity-weighted (e.g., low=1, medium=3, high=10, critical=30). A single high-severity external-only finding matters more than five low-severity lint issues. Use weights as sensitivity analysis, not as the primary number.

**Claims you can make:**
> "On the same frozen diffs, Sonnet cold-diff audit found X validated issue clusters, including Y that the external pipeline did not surface. The external union found Z validated clusters not found by Sonnet. Under a parallel frozen-diff design with optimistic preemption, external audit provided / did not provide substantial residual coverage."

**Claims you cannot make:**
- "This proves the production marginal value of external audit after self-review."
- "This estimates true recall."
- Any claim that ignores the parallel-overstates-external caveat.

**Fallback if adjudication budget is tight:** Run S-cold only. Match against incumbent accepted clusters. Blind and human-adjudicate only S-cold's unmatched findings. Report S-cold standalone + overlap + validated-novel count + incumbent-only count with incumbent-favoring caveat. Label clearly: "Targeted bias audit of Sonnet-unique findings, not a fully symmetric arm comparison." This survives the rigged-ledger confound partially — it detects whether the bias matters, but doesn't eliminate it completely.

### output-3

Below is the combined pressure-test and the smallest design I’d lock.

## Bottom line

Do **not** score the solo author-model control against the existing accepted/dismissed ledger as-is. That would bake in the incumbent pipeline’s worldview and make the solo arm look like a subset by construction.

But also do **not** reopen the entire experiment. The smallest honest fix is a **narrow blinded re-adjudication** of only the findings that matter for the replacement question:

> existing accepted external-pipeline findings + all solo author-model findings, deduped into blinded issue clusters, judged by a human.

Primary condition: **in-context self-review**, if your real decision is “does the author model reviewing its own work make external audit redundant?”

Cold-diff same-model audit is useful, but secondary. Semgrep/static analysis is a cheap appendix/null baseline, not part of the core design.

---

# Point 1 — Rigged-ledger confound

You are right: this is the load-bearing confound.

If the current “accepted” ledger was produced by the external apparatus, then a solo author-model finding can only get credit if it overlaps with something that apparatus already surfaced and accepted. Valid solo-only findings become invisible or “pending,” which biases the comparison toward the incumbent.

So the answer is:

## 1a. Is blind union re-adjudication necessary?

**Yes, but scoped.**

You do **not** need to re-adjudicate the full raw universe of every A/B/C finding, including all previous dismissed items.

You need to re-adjudicate the **blinded union of:**

1. all currently accepted external-pipeline findings; and  
2. all solo author-model findings.

Then canonicalize/dedupe those into atomic issue clusters before judging.

That is enough to answer:

- What valid findings did the external pipeline produce?
- Which of those did the solo author model also find?
- What valid findings did the solo author model find that the external pipeline did not output?
- What false-positive load does the solo model introduce?

Do **not** include all previously dismissed external findings unless you want to audit the prior adjudication system itself. If a previously dismissed external finding is also raised by the solo model, it enters through the solo side and gets judged. Otherwise, it is not necessary for the replacement question.

## 1b. Who judges?

Use a **human technical adjudicator as final judge**, with source labels stripped.

For N=12, this is feasible and avoids the obvious criticism:

> “The model family being tested judged its own outputs.”

Even if source labels are stripped, using the same model family as final judge creates an avoidable optics and bias problem. A model can still favor the phrasing, reasoning style, or bug framing characteristic of its own outputs.

Acceptable workflow:

- LLMs/scripts may help normalize, summarize, cluster, and prepare packets.
- Final validity/severity judgment should be human.
- The human should not know whether a finding came from the external pipeline, solo self-review, cold-diff same-model audit, or static analysis.

Each adjudication packet should include:

- original diff;
- relevant surrounding code;
- task/spec context if available;
- normalized issue statement;
- evidence/failure scenario;
- proposed impact;
- file/line span;
- no source labels.

Judgment labels can be simple:

- valid security/correctness bug;
- valid but minor/low-impact;
- duplicate of another cluster;
- not a bug;
- insufficient evidence / unclear.

If you can afford a second reviewer, use them only for borderline or high-severity cases. One careful human final adjudicator is enough for the minimal design.

## 1c. Is there a cheaper unbiased proxy?

There are two cheaper variants, but only one is really clean.

### Clean cheap version: narrow blinded union

Adjudicate only:

- existing accepted external findings;
- solo author-model findings.

This is the smallest honest version.

### Even cheaper but weaker: differential adjudication

You could judge only the symmetric difference:

- external-only findings;
- solo-only findings;

and assume overlapping findings are valid.

That saves a bit of effort, but it inherits the prior ledger’s validity assumptions and prevents you from cleanly estimating precision. For N=12, I would not bother with this shortcut unless the adjudication load unexpectedly explodes.

My recommendation:

> Do the narrow blinded union. Not the full raw union, not just the symmetric difference.

That fixes the rigged-ledger confound without turning this into a full re-litigation of the original experiment.

---

# Point 2 — Two conditions vs one

The two solo conditions answer genuinely different questions.

## In-context self-review

This answers:

> “If the author model reviews its own work before escalation, does external audit still add value?”

This is the production-relevant question if your workflow is:

> model writes code → model self-reviews → maybe external audit.

It captures both advantages and disadvantages of self-review:

- advantage: the model has task intent and local context;
- disadvantage: it may share its own blind spots and rationalize prior choices.

## Cold-diff same-model audit

This answers:

> “Is the external pipeline valuable because it uses a different auditor, or merely because it gives a capable model a fresh audit prompt?”

This is methodologically cleaner for isolating “different auditor versus same model,” but it is less directly the “author reviewing its own work” scenario.

## Should you run both?

If generation is cheap and adjudication clustering is disciplined, running both is useful. But for the **smallest honest first pass**, pick one primary condition.

My choice:

> Primary: **in-context self-review**.

Reason: your stated decision is whether the **author model reviewing its own work** makes the external pipeline redundant. That is the live operational question.

However, there is one important caveat:

> If the original authoring context is not available or cannot be reconstructed honestly, do not fake “in-context.” In that case, use cold-diff same-model audit and label the result as a same-model auditor control, not true self-review.

So the hierarchy should be:

1. **Primary if feasible:** in-context self-review.
2. **Fallback / secondary:** cold-diff same-model audit.
3. **If you run both:** pre-register in-context as production-primary and cold-diff as diagnostic.

Do not let the cold-diff condition replace the self-review condition unless you are changing the research question from:

> “Does author self-review make external audit redundant?”

to:

> “Does a different external auditor matter versus the same model in a fresh audit role?”

Both are good questions. They are not the same question.

---

# Point 3 — Sequential vs parallel counterfactual

You do **not** need to model the full sequential production pipeline in this round.

A true sequential experiment would require:

1. author-model self-review;
2. fixes proposed;
3. fixes applied;
4. code re-audited by external pipeline;
5. new findings adjudicated.

That introduces many new confounds:

- Did the model actually fix the bug?
- Did the patch compile?
- Did the patch introduce new bugs?
- Are later external findings due to original defects or self-fix regressions?
- Are you evaluating review ability, patching ability, or patch verification?

For N=12, that is too much machinery.

Instead, use frozen-diff parallel evaluation and report a **simulated sequential residual**:

Let:

- `Valid_Ext` = valid external-pipeline clusters after blinded re-adjudication.
- `Valid_S` = valid solo author-model clusters after blinded re-adjudication.

Then:

> Simulated external residual after perfect self-review fixing = `Valid_Ext - Valid_S`.

This tells you:

- which valid external findings would still remain if every solo-found issue had been fixed perfectly;
- which high/critical issues the solo model missed;
- whether external audit still contributes unique validated findings.

But caveat it precisely:

> This is a frozen-diff overlap analysis. It approximates the residual external value under the assumption that all solo-found bugs would be fixed correctly and that those fixes would not introduce new bugs. It does not measure the full sequential production pipeline.

Also avoid saying parallel external value is a strict upper bound. More precise:

> Parallel evaluation likely overstates external audit’s marginal value on original defects that self-review would have fixed, but it does not model failed fixes or new bugs introduced by self-fixes.

That is enough for this refinement round.

If the solo model misses meaningful high-severity external-only bugs, you do not need sequential modeling. External audit is plainly still useful.

If the solo model recovers nearly everything, then a sequential follow-up becomes worth the extra work.

---

# Semgrep / static analyzer baseline

A static analyzer is useful, but not central.

It answers:

> “How much of this would a deterministic, zero-cost-ish static tool catch?”

That is a good sanity check and cost-floor baseline.

But it does **not** answer:

> “Does the author model reviewing its own work make the external pipeline redundant?”

So I would not include it in the main adjudication burden.

Best use:

- run it as an appendix/null baseline;
- map its alerts only onto already-adjudicated clusters;
- report overlap with valid findings;
- do not add every static-analyzer-only alert to the blinded union unless you want a separate static-analysis study.

For the smallest honest design, leave it out of the core. If it is trivial to run, include it as a non-expanding appendix.

---

# Smallest honest design to lock

## Research question

> On the original 12 frozen ledger diffs, would solo author-model self-review have recovered the valid findings delivered by the external pipeline, and would it have contributed valid additional findings?

This is a frozen-diff redundancy screen, not a full sequential ROI study.

---

## Arms

### Required

1. **External incumbent output**  
   Existing accepted findings from the external A/B/C pipeline.

2. **Solo author-model self-review**  
   In-context review of the same frozen diffs, if original context is honestly available.

### Optional secondary

3. **Cold-diff same-model audit**  
   Same model, fresh audit prompt, no authoring context. Diagnostic only.

### Optional appendix

4. **Static analyzer baseline**  
   Mapped only to already-adjudicated clusters.

---

## Solo author-model generation protocol

Use a strict audit schema. Require atomic findings.

Each finding should include:

- title;
- file/line span;
- affected code;
- bug class;
- concrete failure or exploit scenario;
- why this is a real correctness/security issue, not style;
- suggested fix;
- confidence;
- severity.

Also include a spam guard:

- cap findings per diff; or
- require a minimum confidence/severity threshold; or
- instruct the model to omit speculative concerns.

Do not expose existing external findings or accept/dismiss labels.

---

## Adjudication set

For each diff:

1. collect existing accepted external findings;
2. collect all solo author-model findings;
3. optionally collect cold-diff same-model findings;
4. normalize into atomic issue statements;
5. dedupe into clusters;
6. strip source labels;
7. randomize order;
8. human-adjudicate validity and severity.

Do **not** include all previously dismissed external findings.

---

## Metrics

Report raw counts, severity-weighted counts, and per-diff tables.

Core metrics:

1. **Validated external findings**  
   How many incumbent accepted findings survive blinded adjudication?

2. **Solo recall of external-valid findings**  
   Of valid external clusters, how many did the solo author model also find?

3. **External-only residual**  
   Valid external clusters missed by solo.  
   This is the key “external still adds value” number.

4. **Solo-only validated additions**  
   Valid findings found by solo but not output by the external pipeline.

5. **Solo precision**  
   Valid solo clusters / all solo clusters.

6. **Replacement view**  
   If replacing external audit with solo author-model self-review on these frozen diffs:
   - valid findings lost = external-only valid clusters;
   - valid findings gained = solo-only valid clusters;
   - compare by severity.

7. **Simulated sequential residual**  
   External marginal findings after perfect solo-fix assumption:  
   `Valid_Ext - Valid_S`.

Do not over-index on percentages because N=12 is small. Show the actual finding clusters and per-diff distribution.

---

## Decision interpretation

Use severity-aware interpretation.

For example:

- If solo misses any critical/high external-only findings, external audit is not redundant.
- If solo recovers all high/critical findings but misses some lows, external audit may still be useful but could perhaps be narrowed.
- If solo has many validated solo-only findings, the systems are complementary rather than substitutable.
- If solo precision is poor, operational value is lower even if recall is decent.
- If solo matches external on high-severity recall and adds valid findings with acceptable precision, then a sequential follow-up is justified.

---

# Final locked design

I would lock this:

> Run one primary solo author-model condition: **in-context self-review** over the 12 frozen diffs, assuming the original authoring context is available. Build a blinded adjudication set from existing accepted external findings plus all solo findings. Dedupe into issue clusters. Have a human judge validity and severity without source labels. Report external-valid recall, external-only residual, solo-only validated additions, solo precision, and a simulated sequential residual. Treat the result as a frozen-diff redundancy screen, not a full sequential pipeline estimate. Add cold-diff same-model audit only as a secondary diagnostic if adjudication load is acceptable. Keep static analysis out of the core, or include it only as an appendix mapped to already-adjudicated clusters.

That is the smallest honest design that survives the three confounds.

