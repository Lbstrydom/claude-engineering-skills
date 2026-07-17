# Experiment 4 — Discovery-generator model: GLM-5.2 disqualified; replacement shortlist

**Date**: 2026-07-17
**Author**: Claude + Louis Strydom
**Status**: Decision recorded. GLM-5.2 disqualified as a **`required`** discovery
generator on three independent axes. Replacement not yet committed — a
two-gate evaluation (availability screen → quality harness) is specified
below and must run before the default `AUDIT_DISCOVERY_MODEL` changes.

## What forced this

The tiered-recall pipeline's discovery portfolio runs two `required`
generators (`scripts/lib/audit/discovery-portfolio.mjs:112-113`): **GLM-5.2**
via OpenRouter (`z-ai/glm-5.2`, `config.mjs:429`) and **Claude Sonnet** via
the Anthropic API. If *either* fails, the whole tiered run is unusable — so
the portfolio's availability is the product of the two.

The 2026-07-17 no-legacy-fallback work (`docs/plans/shadow-no-legacy-fallback.md`)
made shadow failures cheap and honest, which finally let the failure
distribution be read cleanly from `.audit/tiered-shadow-log.jsonl`. It is
not a "generator reliability" problem in general. It is a **GLM** problem.

## The evidence (57 live shadow records + one prior experiment)

### Axis 1 — availability (this experiment)

Per-generator outcomes, over the 39 records that persist them:

| Generator | Succeeded | Failed | Success rate |
|---|---|---|---|
| **GLM-5.2** (OpenRouter) | 14 | 25 | **36%** |
| **Claude Sonnet** (Anthropic) | 36 | 3 | **92%** |

- **38 of 47** failure rows name GLM as a failed generator.
- Portfolio ceiling = `0.36 × 0.92 = 33%`, matching the observed ~26%
  completion rate almost exactly. Gemini flagged this multiplicative trap in
  the `/brainstorm` round ("you are multiplying your failure probabilities…
  your pipeline fails by mathematical definition") — the data confirms it.
- The GLM failures are **stalls, not slowness**: the OpenRouter heartbeats
  march in perfect 15s increments to the 120s ceiling with no completion,
  then retry and do it again (observed directly, 2026-07-16). Raising the
  timeout only buys a more expensive failure. The
  `oss-call-policy.json` calibration note ("recalibrate if either operation
  still times out routinely") is therefore a **trap** for this cause — and we
  could not calibrate honestly anyway: `generatorOutcomes` records
  `{model, role, status, findingCount}` and **no latency**, so there is no
  distribution to calibrate against (instrumentation gap, below).
- **Sonnet is not a remaining blocker.** All 8 "no tool call" Sonnet failures
  are dated 2026-07-14 and were fixed the same day by the `max_tokens`
  4000→16000 change (`9dea866`). Zero since. (Earlier session notes that
  listed them as "remaining" were reading the log without date-bucketing —
  the recurring failure mode this window keeps making.)

### Axis 2 — finding quality (prior verdict of record)

`docs/research/experiment-3-model-swap-glm-vs-gpt.md` (2026-07-13, real Tier-A
blind judging, $1.87) evaluated GLM-5.2 in the **auditor** role and returned
`keep GPT-5.6`. GLM's **false-positive rate was 80.9%** (vs GPT's 67.6%). The
recall column is untrustworthy per that doc's oracle-matching ceiling, but the
FP rate is the contract, and it is high. A discovery generator that produces
mostly noise makes Stage 0/1/2 do more work to reject more junk.

### Axis 3 — cost (surfaced during this research)

Realized OpenRouter pricing per 1M tokens (in/out), July 2026:

| Model | Input | Output | Note |
|---|---|---|---|
| **GLM-5.2** | $0.45 | **$3.31** | the incumbent — and the *most expensive* |
| Qwen3.6 Plus | $0.33 | $1.95 | |
| Qwen3.6 Flash | $0.19 | $1.13 | |
| DeepSeek V3.2 | **$0.14** | **$0.28** | ~12× cheaper output than GLM |
| DeepSeek V4 Pro | $0.44 | $0.87 | |

The discovery generator runs on **every** audit. GLM is the priciest option
for the role, on top of failing it 64% of the time.

**Three independent disqualifiers. GLM-5.2 is not a defensible `required`
generator.** Note the nuance for the record: GLM-5.2 actually *leads* several
open-weight coding benchmarks (Artificial Analysis 51.1, SWE-Bench Pro 62.1).
Its intrinsic capability is not the issue — its **availability via
OpenRouter**, its **FP rate in our specific role**, and its **cost** are. A
capable model that stalls two runs in three cannot anchor a `required` slot.

## Replacement shortlist

The role's contract (from `config.mjs`/`tiered-pipeline.mjs`): an
**OpenRouter-hosted** model id (raw, not a model-resolver sentinel — the
resolver has no OSS tier), called via `ossStructuredCall` with a JSON-schema
`response_format`, cheap enough to run per-audit, and — the whole point —
**reliably available**.

| Candidate | Why it's on the list | Watch-out |
|---|---|---|
| **DeepSeek V3.2** | Front-runner. **Cheapest** ($0.14/$0.28) and served by **16 providers on OpenRouter** → automatic failover, the direct antidote to GLM's single-host (`z-ai`) stalls. Strong coding lineage. | Throughput varies 4–57 tok/s across providers; pin/prefer a fast provider. |
| **Qwen3.6 Flash** | Cheap ($0.19/$1.13), reliable tool use, 1M context. Qwen3-family structured output is well-supported (OpenRouter Response Healing cut Qwen3-235B JSON defects 99.8%). | Slightly pricier than DeepSeek; grade its FP rate. |
| **Qwen3.6 Plus** | Strongest agentic-coding open model per July-2026 rankings; 1M context. | Priciest of the three; only worth it if quality clearly beats the cheaper two. |

Deliberately **not** shortlisted: another single-host OSS model with no
failover (repeats GLM's structural weakness), and anything requiring a new
provider integration (the role already speaks OpenRouter).

## Two orthogonal fixes, not one

The failure taxonomy splits cleanly, and the fixes are independent:

1. **The stalls (the 64%)** → a model/provider change. This is the decision
   this document forces. DeepSeek's multi-provider failover is the specific
   availability lever, not just "a better model".
2. **The non-JSON failures (3 of the 41)** → **OpenRouter's Response Healing
   plugin**, orthogonal to model choice (Qwen3-235B: 99.8% JSON-defect
   reduction; <1ms added latency). Worth enabling regardless of which model
   wins gate 2 below — it hardens the `ossStructuredCall` seam for *any* OSS
   generator.

## The evaluation that must run before committing — two gates

My finding is about **availability**; the existing model-swap-eval-harness
measures **quality** (recall/FP). Neither alone is sufficient, and — noted as
a gap — the harness today covers the **auditor** and **adjudicator** roles,
**not** the discovery/generator role. So:

- **Gate 1 — availability screen (cheap, new, do first).** Hammer each
  candidate's OpenRouter endpoint N≈30 times with a representative discovery
  payload and the real `ossStructuredCall` schema; measure stall rate,
  p50/p95 latency, and JSON-validity rate. A candidate that can't clear,
  say, 90% availability is out **before** any quality spend — the same
  fail-fast discipline that would have caught GLM a month earlier. This screen
  is the missing instrument; building it also closes the per-generator-latency
  telemetry gap above.
- **Gate 2 — quality (existing harness, extended to this role).** Only
  candidates that pass gate 1 go to a blind Tier-A grade of finding
  quality/FP against a curated corpus, mirroring experiment-3's method.

Front-runner going in: **DeepSeek V3.2** (cheapest, most failover, strong
lineage). But the gates decide, not this document.

## Immediate, reversible mitigation (independent of the swap)

Until a replacement passes both gates, **demote GLM from `required` to
`optional`** (`discovery-portfolio.mjs:112`). One line. It lifts portfolio
availability from ~33% to ~92% immediately (Sonnet already works), converting
most runs into a Sonnet-only cohort. This changes what the shadow measures
("Sonnet vs legacy", not "portfolio vs legacy") — a real trade recorded here
so the window's cohorts are read correctly: the two-model cohort still
accumulates, just on its own slower schedule, and Sonnet-only runs are a
separate labelled cohort, never pooled into the portfolio-vs-legacy
denominator.

## Decision

1. **GLM-5.2 is disqualified** as a `required` discovery generator
   (availability 36% + FP 80.9% + highest cost). Recorded.
2. **Do not** silently swap in a new default. Run the two-gate evaluation;
   `AUDIT_DISCOVERY_MODEL` is env-overridable, so candidates can be trialled
   without a code change.
3. **Front-runner**: DeepSeek V3.2, on failover + cost + lineage — subject to
   the gates.
4. **Enable OpenRouter Response Healing** on the `ossStructuredCall` seam
   regardless of the winner (fixes the non-JSON class for any OSS model).
5. **Interim**: demote GLM to `optional` so the window stops being ceilinged
   at 33% while the evaluation runs.

## Sources

- [Best Open-Source LLMs (Updated July 2026) — AceCloud](https://acecloud.ai/blog/best-open-source-llms/)
- [The Best Open-Source LLMs for Agentic Coding in 2026 — MindStudio](https://www.mindstudio.ai/blog/best-open-source-llms-agentic-coding-2026)
- [Qwen3.6 Plus — API Pricing & Benchmarks | OpenRouter](https://openrouter.ai/qwen/qwen3.6-plus)
- [LLM API Pricing Comparison & Cost Guide (Jul 2026) — CostGoat](https://costgoat.com/compare/llm-api)
- [GLM-5.2 vs DeepSeek V4 vs Qwen3: Open-Weights Coding Showdown — Developers Digest](https://www.developersdigest.tech/blog/glm-5-2-vs-deepseek-v4-vs-qwen3-open-weights-coding-showdown)
- [The Open Weight Models that Matter: June 2026 — OpenRouter Blog](https://openrouter.ai/blog/insights/the-open-weight-models-that-matter-june-2026/)
- [Structured Outputs — OpenRouter Docs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Response Healing: Reduce JSON Defects by 80%+ — OpenRouter](https://openrouter.ai/announcements/response-healing-reduce-json-defects-by-80percent)
- [Is OpenRouter Reliable? An Honest Review for Production Use (2026) — ofox.ai](https://ofox.ai/blog/is-openrouter-reliable-honest-review-2026/)
- Internal: `docs/research/experiment-3-model-swap-glm-vs-gpt.md`; `.audit/tiered-shadow-log.jsonl`; `docs/plans/shadow-no-legacy-fallback.md`.
