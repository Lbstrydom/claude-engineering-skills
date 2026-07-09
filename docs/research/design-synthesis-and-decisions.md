# Design Synthesis — From Evidence to the Approved Redesign

**Date**: 2026-07-09. **Output**:
[`docs/plans/tiered-recall-audit-pipeline.md`](../plans/tiered-recall-audit-pipeline.md)
(Status: Approved). This doc records *how* the evidence became that design —
the reasoning chain matters as much as the result for any write-up.

## Step 1 — The utility-function correction

The single most consequential move in the whole arc was not a measurement but a
clarification: the experiment's trust-bar framing (disqualify any arm >33%
false) was optimizing **precision**, while the operator's real objective —
stated explicitly when reviewing results — is **recall-weighted**: *"false
positives are the price of information; the real output is code quality at a
reasonable burn rate and cost."* Re-scoring under that objective
([`analysis-cost-rescoring.md`](analysis-cost-rescoring.md)) rehabilitated the
high-recall/noisy arms and reframed the design question from *"which single
reviewer is cleanest"* to *"which portfolio maximizes union recall, given a
triage funnel that makes the noise affordable."*

Key derived principle: **the generator doesn't need to be trustworthy — the
funnel does.** Trust is a property the pipeline *produces* (via deterministic
verification, tiered triage, and adjudication), not one the generator must
arrive with.

## Step 2 — The cross-family brainstorm round (1 round, deliberate)

The redesign strawman was deliberately sent to GPT-5.5 and Gemini 3.1 Pro for
adversarial review before planning — partly on principle (a single-session
author redesigning the audit pipeline from their own reasoning is exactly the
"author reviews own framing" failure mode this research documents), and partly
because the field records show plan-stage audits are the *highest-yield* use of
external review (~$0.40 for 14 substantive fixes in one recorded case).

**What the external models converged on independently** (strong signal):
- The evidence-tax design ("quote the exact diff line") **structurally cannot
  represent errors of absence** — and the named Claude blind-spot classes ARE
  absences. Both models flagged it; both proposed variants of the fix
  (anchor blocks + an explicit omission/commission type split).
- Portfolio fragility: GLM+Sonnet's union recall could be overfit to the
  13-commit benchmark; GLM may be distilled from Claude/GPT outputs, so
  "orthogonal reasoning" is an assumption to monitor, not a fact.

**What each added uniquely**: GPT — negative-space evidence contracts,
risk-weighted (not random) dismissal sampling, a ~120-row stratified human
validation design, GPT-as-triggered-specialist rather than deletion. Gemini —
the contrarian-divergence validation design (spend human hours only where the
cheap triager *disagrees* with the expensive judges), the anchor-block
formulation, cross-model correlation monitoring.

**What both missed** (the author's synthesis added): wrong dismissals
**compound through the R2+ suppression ledger** (a one-time triage error becomes
a persistent recall hole); nobody priced the guards their own fixes added (the
cost budget must include the oversight paths or the "lean" claim is
unfalsifiable); and known omission classes can be **converted into commissions**
via positive obligation checks ("shape changed at quotable line X → verify the
version bump exists").

## Step 3 — The validation-circularity problem and its resolution

The keystone risk in the whole design: a cheap Stage-1 triager validated by
agreement with the LLM judges measures **conformity, not correctness** (the
judges' own labels were never human-verified). Resolution (merging both
external proposals): a single ~2–4-hour human session over a
**contrarian-stratified sample** — only rows where the cheap triager disagrees
with the two-judge consensus, plus all KD-linked rows, all HIGH dismissals, all
omission-type dismissals, and a random calibration tail — measuring
**false-dismissal rate per stratum** rather than global agreement. The same
session doubles as the first human ground-truth check on the original judges
(closing a standing rigor gap from experiment 1). Machine-readable manifest
with pre-registered thresholds (≤5% false-dismissal on HIGH/omission strata,
≤10% overall) gates the production wiring.

## Step 4 — The plan-audit trail as evidence for its own thesis

The plan went through `/audit-plan`: **2 GPT rounds + 3 Gemini gate rounds, 26
findings, zero disputes, zero wrongly-dismissed reversals** — and the findings'
character is itself data:

- GPT R1 (9H/6M) caught, among others, the plan violating the repo's own
  documented "scope by impact, not authorship" invariant with its blame-based
  dismissal design, and the bandit's missing counterfactual (a `skip` arm that
  can never learn).
- GPT R2 (4H/4M, HIGH count −56%) caught the author's own round-1 fix
  contradicting a documented purity contract the author had *correctly cited
  one round earlier* — the single cleanest demonstration in the whole arc that
  fix rounds introduce their own defects.
- Gemini rounds 1–3 (4, 4, 3 findings, declining severity) caught: internal
  contradictions between phases written in different passes; a genuine silent
  data-loss bug (merge-before-verify could discard a valid finding when a
  hallucinated sibling was chosen as canonical); the plan's own flagship
  blind-spot checks accidentally classified out of their strongest oversight
  guarantee; and a **logically inverted** FX-conversion rule that guaranteed
  the exact historical corruption it claimed to prevent.
- The Gemini cap (2 rounds) was exceeded once under the documented
  "genuine-bug exception," then the loop was stopped at round 3 despite a
  remaining `CONCERNS` — with declining counts/severity recorded as the
  convergence signal — rather than chaining exceptions indefinitely.

**The meta-point for a write-up**: the process that produced the plan is a live
instance of the thesis the research supports — external, cross-family review
reliably catches author blind spots *including in the author's fixes to prior
findings*, while round caps + character-based stop rules keep the loop from
becoming the infinite-refinement failure mode the field records document.

## The final design in one paragraph

Cheap, recall-maximizing discovery (GLM-5.2 5-pass + one Sonnet cold pass = the
empirical max-union portfolio; GPT-5.5 retained as triggered
specialist/sentinel with a bandit-learned firing rate and a forced exploration
sample for counterfactuals) feeding a three-tier trust-producing funnel:
Stage 0 deterministic verification (content-verified anchors, two-check
pre-existing tagging, run-level generator-failure tracking, all findings as
provenance-preserving envelopes), Stage 1 cheap-model triage with asymmetric
dismissal authority (validated empirically before wiring; dismissals only with
citable deterministic disproof, routed to the reopenable ledger path), Stage 2
Gemini as adjudicator-plus-bounded-clean-challenge (its empirically-proven
role), all governed by an end-to-end euros+minutes-per-accepted-HIGH metric
with per-call cost capture, and validated prospectively in shadow on 10–15
real commits before any production flip.
