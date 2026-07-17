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
| **DeepSeek V3.2** | Front-runner. **Cheapest** ($0.14/$0.28) and served by **16 providers on OpenRouter** → automatic failover. Strong coding lineage. | Throughput varies 4–57 tok/s across providers; pin/prefer a fast provider. |
| **Qwen3.6 Flash** | Cheap ($0.19/$1.13), reliable tool use, 1M context. Qwen3-family structured output is well-supported (OpenRouter Response Healing cut Qwen3-235B JSON defects 99.8%). | Slightly pricier than DeepSeek; grade its FP rate. |
| **Qwen3.6 Plus** | Strongest agentic-coding open model per July-2026 rankings; 1M context. | Priciest of the three; only worth it if quality clearly beats the cheaper two. |

Deliberately **not** shortlisted: another single-host OSS model with no
failover (repeats GLM's structural weakness), and anything requiring a new
provider integration (the role already speaks OpenRouter).

## The structural restriction this role lives under (flagged 2026-07-17)

The discovery-generator slot is **the most constrained model slot in the
entire architecture**, and that constraint — not bad luck — is why an OSS
model ended up in a `required` role unmeasured. Every frontier lineage is
already committed to a role whose independence the experiment depends on:

| Lineage | Already committed as | Why it can't fill the second required slot |
|---|---|---|
| **Anthropic** (Sonnet/Opus) | Required generator #1 — AND usually the *author* of the code under audit | A second Anthropic slot destroys the portfolio's disjoint-findings premise and compounds the author-model self-review bias (experiment-1's subject) |
| **OpenAI** (GPT) | The **legacy baseline** the tiered pipeline is being compared against — and already wired as a deliberately *optional/exploratory* discovery arm (`gptCall`, `discovery-portfolio.mjs:95,128`; unwired `gptCall: null` in the pipeline today) | A GPT required generator confounds the very tiered-vs-legacy comparison the window exists to produce. The existing code's own role assignment (`optional`, never `required`) encodes this |
| **Google** (Gemini) | **Stage-2 adjudicator** + the plan/code final gates | A Gemini generator would have Gemini adjudicating its own findings — the no-self-review doctrine, violated at the pipeline's most load-bearing gate |

So the second required slot is forced into a **fourth lineage** — i.e. the
OSS pool — and the OSS pool is reached through aggregators or direct OSS
APIs with structurally weaker SLAs than the three frontier providers. **The
36%-availability finding is the predictable price of that corner, not an
anomaly.** Any replacement candidate lives under the same restriction: the
shortlist can only ever contain fourth-lineage models.

Two softeners, verified in code, that keep the corner livable:

1. **The OpenRouter dependency is config-soft, not code-hard.**
   `OPENROUTER_BASE_URL` (`config.mjs:182`) points the `ossCall` seam at any
   OpenAI-compatible endpoint — including a candidate's *direct* API (e.g.
   DeepSeek's), which matters because reviews note OSS models via OpenRouter
   sometimes underperform the same model accessed directly, and our observed
   stalls may be OpenRouter *routing*, not the model.
2. **"Required ROLE, pooled MODELS" is available natively.** OpenRouter's
   `models: []` fallback array (max 3 entries) tries each model sequentially
   on any error — downtime, rate limit, context, moderation — and bills only
   the one that answers. That converts the fourth-lineage slot from "one
   fragile model is required" to "one of a vetted pool is required" with a
   **request-body change, zero orchestration code**. This is the right-sized
   availability fix and should be part of the gate-1 evaluation design
   (e.g. `models: ['deepseek/deepseek-v3.2', 'qwen/qwen3.6-flash']`).

And one **deployment restriction with no softener**: under the **Azure work
profile** there is no OpenRouter/OSS access at all (`openrouterApiKey` null →
`ossCall` never constructed → the required generator fails every run). The
tiered pipeline as designed **structurally cannot run in that environment**
— it degrades safely to the legacy path (production falls back; the shadow
now records `tiered_unavailable` cheaply), but permanently. The Phase-14
production-flip decision must therefore be scoped as **public-profile-only**
unless the portfolio premise is redesigned for restricted environments; a
flip that assumed universal availability would strand the corporate profile
on a "production" path that can never execute there.

## Two orthogonal fixes, not one

The failure taxonomy splits cleanly, and the fixes are independent:

1. **The stalls (the 64%)** → a provider-routing and/or model change — see
   the 2026-07-17 amendment below, which corrects this document's original
   "single-host" diagnosis and adds a pinned-GLM control arm to gate 1.
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


## Amendment (2026-07-17, same day): the disqualification is confounded — corrected before any switch

Operator challenge: *"are we penalising GLM because of OpenRouter?"* Digging
into it exposed a **factual error above and a confound across all three
axes**. Recorded here rather than silently rewritten:

1. **The "single-host (`z-ai`) stalls" claim above is WRONG.** OpenRouter's
   live endpoint data shows `z-ai/glm-5.2` served by **~26 providers across
   ~20 brands** (DeepInfra, GMI Cloud, Novita, Fireworks, Baidu, SiliconFlow,
   Together, Cloudflare, …). Worse for measurement validity: the fleet is
   split between **fp8 hosts** (incl. Z.ai's own first-party route), **fp4
   hosts** (DeepInfra, Wafer, Decart, Parasail, Inceptron), and hosts that
   disclose no quantization at all.
2. **Our call shape never controlled any of this.** `ossStructuredCall`
   sends NO `provider` preferences — no `order`, no `quantizations` filter,
   no `require_parameters`. Every GLM measurement we have (the 36%
   availability, experiment-3's 80.9% FP rate, the fence-wrapped/non-JSON
   replies the code itself live-verified as coming from "SEVERAL providers,
   not one consistent one") was taken against an **unfiltered, partly
   fp4-quantized, behaviourally heterogeneous fleet**. The quality axis in
   particular may have graded a quantized GLM, not GLM.
3. **Direct z.ai does NOT dominate either.** Z.ai first-party sticker is
   **$1.40/$4.40** per 1M — ~3× OpenRouter's realized input price (which is
   low precisely because it routes to cheap quantized hosts) and ~10× DeepSeek
   V3.2. Direct also means: a new key/account/billing with Zhipu, **direct
   egress of code payloads to a single China-based provider** (a governance
   axis OpenRouter's US-host routing partially mitigates), and losing
   OpenRouter's Response Healing + `models:[]` fallback. Direct z.ai is a
   diagnostic arm, not an obvious destination.

**The cheap, decisive control that answers the operator's question WITHOUT
leaving OpenRouter**: pin GLM to its first-party fp8 route via provider
preferences on the existing seam —
`provider: { order: ['z-ai'], quantizations: ['fp8'], require_parameters: true }`
— same key, same egress gate, same billing. Gate 1 therefore becomes a
**controlled screen**:

| Arm | What it isolates |
|---|---|
| (a) GLM-5.2 pinned z-ai/fp8 via OpenRouter | model vs router-fleet confound — the direct answer to "are we penalising it?" |
| (b) GLM-5.2 direct z.ai | only if (a) is inconclusive (isolates OpenRouter's proxy layer itself) |
| (c) DeepSeek V3.2, Qwen3.6 Flash (unpinned + pinned-fast-provider) | the replacement candidates, measured under the SAME controls |

Decision rule: if (a) still stalls, the problem is GLM/z.ai capacity and
**switching is justified with confidence**. If (a) is clean, GLM's
availability axis is un-disqualified, and gate 2 re-grades its FP rate **on
the fp8 route** (experiment-3's 80.9% may be a quantization artifact —
unknown until measured). Axis 3 (cost) stands regardless: even exonerated,
GLM-via-z.ai is the most expensive candidate for a per-audit role.

**Bottom line recorded**: we are NOT yet confident that moving is better; we
are confident the current GLM configuration is unusable, and the three-arm
gate-1 screen (a few dollars, ~30 calls/arm) settles model-vs-router before
any default changes. The `required→optional` interim demotion stands either
way — it is routing-agnostic.

### Additional sources (amendment)
- [GLM-5.2 API Access Compared: Z.ai vs OpenRouter vs Hosts — DigitalApplied](https://www.digitalapplied.com/blog/glm-5-2-api-access-providers-price-comparison-2026)
- [Where to Run GLM-5.2: Every Provider Compared (2026) — Developers Digest](https://www.developersdigest.tech/blog/glm-5-2-free-and-cheap-access-2026)
- [GLM 5.2 — API Pricing & Benchmarks | OpenRouter](https://openrouter.ai/z-ai/glm-5.2)
- Internal: `scripts/lib/oss-structured-output.mjs` (no `provider` preferences sent; multi-provider fence-wrapping live-verified 2026-07-15).
