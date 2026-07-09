# Experiment 2 — The Other Two Tracks: Arm-Eval & the Model-A/B/C Shadow

The solo-control study (experiment 1) is the headline, but two other experiment
tracks ran alongside it. They cover **different surfaces** and use **different
query subsystems** — a distinction that was itself a recorded learning after they
were conflated once (2026-07-04):

| Track | Surface | Query commands | Status (2026-07-09) |
|---|---|---|---|
| **Arm-eval** (blinded Claude-judge) | `/brainstorm` and `/plan` outputs | `arm-eval-stats` / `arm-eval-decision` | Brainstorm arm: credible result. Plan arm: too thin (1/8). Toggle now OFF. |
| **Model-A/B/C shadow** | `/audit-code` (code-audit findings) | `model-ab-stats` / `model-ab-decision` | Abandoned un-adjudicated (see below). Toggle now OFF. |

## Track A — Arm-eval (brainstorm/plan surfaces)

**Design**: when the per-repo toggle is on, each captured task is ALSO run
through alternative "arms" (different model compositions) in a detached
background session; a blinded Claude judge later grades the arms' outputs
against each other without knowing which arm produced what.

**Learnings that stand (brainstorm surface, ANCHORED review-mode):**

- The **oss-competitive result is credible**: arm F (GLM + GPT) beat the
  baseline by **+0.60** with judge self-consistency **τ = 0.93**. The win is
  substance-driven, not formatting-driven — this was directly stress-tested:
  a `right_sizing` re-judge, run specifically to check whether GLM's win was
  inflated by verbose/pretty formatting, **refuted** that worry (the plain
  baseline turned out to be the padded one; the margin *widened* under strict
  concision scoring).
- The `right_sizing` rubric was subsequently sharpened toward concision for
  brainstorm+plan surfaces (explicitly NOT for audit surfaces, where
  completeness dominates).
- A **historical trap** worth recording: the 2026-07-02 "τ = 0.944
  oss-competitive" verdict was produced under an older auditor+review-mode and
  is NOT the live state — citing it as current would be wrong. The live,
  citable result is the ANCHORED review-mode one above.
- **Plan surface**: only 1 of 8 assignments accumulated before the toggle went
  off — too thin for any conclusion. Recorded as "no data," not "no effect."
- Operational learning: OSS generation (GLM via OpenRouter) **times out on
  large diffs** — a real constraint carried into the redesign plan (GPT remains
  the fallback for oversized diffs).

**Session archives**: `docs/arm-eval/sessions/` (per-session records; tracked in
this source repo as auditable history — in consumer repos the same exports are
local-only runtime output, with the cloud `arm_eval_*` tables authoritative).

## Track B — Model-A/B/C code-audit shadow

**Design**: every real production `/audit-code` run additionally executed arms
B (GLM 5-pass → GPT round → Gemini) and C (GLM 5-pass → Gemini) as
observation-only shadows against the same commit, persisting stage-attributed
findings, per-stage cost, and schema-conformance rates for later human
adjudication.

**What it accumulated (2026-07-04 → 2026-07-09):** 16 distinct assignments,
63 accepted clusters, **1,891 candidate clusters pending human adjudication**,
€26.48 of a €500 cap spent. Decision status at shutdown: `awaiting-adjudication`
— it **never produced a ranking**.

**The deliberate abandonment decision (2026-07-09):** the pending backlog will
NOT be human-adjudicated. Rationale, recorded so the sunk cost isn't re-litigated:

1. **Superseded by a better instrument.** The solo-control experiment answered
   the same underlying question (are the B/C compositions better than the
   apparatus?) with far stronger methodology — seeded ground truth, blind
   source-stripped grading, two cross-family judges — than a raw un-graded
   capture ever could.
2. **The comparison target is being retired.** The shadow compared arms against
   the *current* pipeline shape (arm A = GPT 5-pass + Gemini). The approved
   redesign replaces that shape, so adjudicating 1,891 clusters of
   old-configuration comparisons is low-value labor.
3. The €26.48 spent is sunk either way; the toggle is off in all three repos
   (this repo, wine-cellar-app, ai-organiser) as of 2026-07-09.

**What the shadow still contributed despite never concluding:**

- **Per-stage cost + conformance telemetry** that fed the redesign: e.g., real
  observed per-commit stage costs (GPT round ≈ $0.70–0.73 vs GLM 5-pass ≈
  $0.25–0.28 vs Gemini review ≈ $0.13–0.14 on the same commit) and
  schema-conformance rates (GLM ≈ 0.60, GPT ≈ 0.80, Gemini = 1.00) — early,
  independent corroboration of both the cost asymmetry and the
  structured-output reliability gap the redesign has to engineer around.
- **A production bug found and fixed**: a shadow-arm egress-gate refusal could
  crash (rethrow past) the *primary* audit, destroying successful results —
  root-caused to the shadow catch blocks in `openai-audit.mjs`, fixed via
  `classifyShadowFailure()` (never rethrows; logs + marks refusals), synced to
  consumers, regression-tested.
- The infrastructure itself (arm attribution view `model_ab_finding_scores`,
  the toggle, budget caps, worksheet-first adjudication CLI) is **reused by the
  redesign plan** as the prospective-shadow-validation mechanism — the
  instrument outlives the experiment.

## Cross-track methodological learnings

- **Two signals from the same capture are one observation** — corroboration
  requires tracing inputs to independent sources (recorded after nearly
  double-counting agreement between same-source signals).
- **Toggles are standing decisions**: the accumulation phase ran under an
  explicit "never pass the kill switch on audits" rule so the data stream
  stayed unbroken until deliberately ended. The end (2026-07-09) was equally
  explicit — off in all repos, recorded here.
- **Worksheet-first human adjudication**: raw JSON queues are not a human
  review surface; every adjudication CLI grew a `--worksheet` markdown renderer
  with paste-ready commands (and never `<angle-bracket>` placeholders, which
  PowerShell can't even paste). This convention carries directly into the
  redesign's validation session.
