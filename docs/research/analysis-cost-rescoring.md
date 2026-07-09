# Analysis — Cost Re-Scoring Under the Real Utility Function

**Date**: 2026-07-09. **Inputs**: experiment-1's graded sheets + blind maps
(existing data, zero new model spend), exact diff sizes re-extracted via git,
verified real per-MTok pricing.

## Why the re-scoring happened

The experiment's eligibility rule (false-rate ≤ 33%) encodes a
**precision-weighted** utility function. The operator's actual utility function
— made explicit mid-review — is **recall-weighted and cost-governed**: false
positives are an accepted "price of information" as long as triage burden and
euro cost stay bounded; the objective is *fundamental bugs caught per euro*.
Under that objective the original rankings change materially.

## Verified pricing basis ($/MTok, checked against provider pages — NOT internal
static tables, which were stale)

| Model | Input | Output |
|---|---|---|
| GLM-5.2 (OpenRouter) | 0.90 | 3.08 |
| Claude Haiku 4.5 | 1 | 5 |
| Claude Sonnet 5 (intro) | 2 | 10 |
| Gemini 3.1 Pro (≤200k) | 2 | 12 |
| Claude Opus 4.8 | 5 | 25 |
| GPT-5.5 (standard) | 5 | 30 |
| Claude Fable 5 | 10 | 50 |

## Cost model

Exact diff chars (re-extracted per commit via git — the stored `usage` fields
were unreliable, see experiment-1 correction #4) × pass counts per arm
composition × real pricing; output tokens estimated from Sonnet's real
per-call output usage (~9,310 tokens/call) applied uniformly. **Weakest input**:
that uniform output estimate — reasoning tokens bill as output and vary by
model/effort. Input-side rankings are solid; the output-cost split is
directional. (Fixing this properly — per-call `cost_usd` capture — is Phase 4
of the redesign plan.)

## Results

**$ per known-defect caught** (the recall-weighted ranking):

| Rank | Arm | $/KD | KD recall | Total cost (13 commits) |
|---|---|---|---|---|
| 1 | **C — GLM+Gemini** | **$2.62** | 5/13 | $13.09 |
| 2 | S-sonnet solo | $5.78 | 4/13 | $23.14 |
| 3 | Sonnet+Gemini | $7.13 | 4/12 | $28.53 |
| 4 | Gemini alone (5-commit) | $7.20 | 1/5 | $7.20 |
| 5 | GPT alone (5-commit) | $8.99 | 2/5 | $17.99 |
| 6 | B — GLM+GPT+Gemini | $11.50 | 7/13 | $80.48 |
| 7 | A — production apparatus | $14.56 | 5/13 | $72.78 |
| 8 | S-sonnet ×3 | $17.35 | 4/13 | $69.42 |
| 9 | S-fable | $38.56 | 3/13 | $115.69 |

**$ per 100 precision-weighted value points**: Sonnet+Gemini $1.81 < S-sonnet
$2.16 < C $2.96 < … < A $13.21 (the production apparatus is LAST on both axes).

**Two findings that changed the conclusion:**

1. **Arm C, not Sonnet+Gemini, is the recall-per-euro standout** — it matches
   the production apparatus's hard-bug recall at ~1/6 the cost and beats
   everything on $/KD by 2×+. Arm B's extra GPT round buys 2 more KDs at ~6×
   the price per bug.
2. **Output/reasoning tokens, not input size, dominate cost** (estimated 5–6×
   the input cost at GPT's $30/MTok output pricing). The "GPT is getting
   expensive" pressure that started this whole investigation traces to
   reasoning-token output pricing on a noisy generator — which means the cost
   levers are *which model's output meter runs* and *reasoning effort*, not
   diff truncation.

## The portfolio/union analysis (computed from the graded sheets)

Per-arm KD catch sets (GPT judge) and triage burden:

| Arm | Rows raised (13 commits) | Rows per accepted finding | KD set |
|---|---|---|---|
| A | 221 | 2.0 | 006,007,008,009,011 |
| B | 425 | 2.1 | 005,006,007,008,010,011,012 |
| C | 223 | 2.2 | 005,006,007,008,011 |
| S-sonnet | 456 | 1.8 | 007,008,009,011 |
| S-fable | 490 | 1.9 | 007,008,011 |
| S-sonnet×3 | 499 | 2.0 | 007,008,010,011 |

**Three structural facts:**

1. **Triage efficiency is flat (~2 raised rows per accepted finding) across ALL
   arms.** No arm is noisier *per unit of value* — triage cost scales with raw
   volume. This is what makes "cheap high-recall discovery + cheap triage"
   architecturally coherent: the funnel's per-row cost, not the generator's
   noise ratio, is the controllable variable.
2. **B misses KD-009; solo Sonnet catches it.** The union **B + one Sonnet pass
   = 8 KDs = every defect ANY tested configuration ever caught.** The
   max-recall portfolio is not any single arm.
3. **Judge noise on KD attribution is real**: the Claude judge credits B with 5
   KDs where GPT credits 7. Don't build a business case on ±2 in these
   denominators; build it on set relationships (which are stable).

## What this analysis fed forward

Directly shaped the redesign plan's discovery portfolio (GLM + Sonnet as
`required` generators = the max-union pair; GPT demoted to triggered
specialist/sentinel), its Stage-1 cheap-triage bet (flat rows-per-accepted makes
per-row triage cost the lever), and its Phase 4 (real per-call cost capture, so
the next comparison uses actuals instead of this model's estimates).
