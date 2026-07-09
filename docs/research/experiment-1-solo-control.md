# Experiment 1 — Solo-Control: Pipeline vs. Solo Model Review

**Question**: does a heavyweight multi-model audit pipeline (GPT-5.5 5-pass +
Gemini review, multi-round, adjudication ledger) produce more trustworthy
findings than a single capable model reviewing the same diff once, cold?

**Dates**: main study re-run completed 2026-07-08/09 (post-fix); follow-ups 2026-07-09.
**Structured data**: [`data/experiment-dataset.json`](data/experiment-dataset.json).
**Harness**: `scripts/solo-control-audit.mjs` (offline retro harness — never touches production `audit_findings`).

## Method

- **6 arms** over the **same 14 real commits** (13 usable; one 6.3M-char
  mega-commit excluded as `unscored-by-refusal`, never silently dropped) across
  3 repos (this repo, ai-organiser, a private commercial app):
  - **A** — apparatus: GPT-5.5 5-pass → Gemini review (the production shape)
  - **B** — GLM-5.2 5-pass → +1 GPT-5.5 round → Gemini review
  - **C** — GLM-5.2 5-pass → Gemini review
  - **S-sonnet** — solo Claude Sonnet-5, cold, one 5-pass sweep, no review layer
  - **S-fable** — solo Claude Fable-5, same
  - **S-sonnet-x3** — Sonnet-5 ×3 independent repeats, findings unioned
- **Blind adjudication**: all findings pooled into one shuffled, source-stripped
  sheet (2,314 rows; uniform detail truncation so verbosity can't leak arm
  identity), graded against the code-at-commit.
- **Two cross-family judges**, fully independent: Claude Fable-5 (fresh session)
  and GPT-5.5 (automated `judge-gpt` subcommand). Neither saw the other's labels.
- **Label taxonomy**: `proven` (1.0) / `actionable` (0.6) / `plausible` (0) /
  `false` (0); severity weights LOW=1 / MEDIUM=3 / HIGH=8. HIGH findings need a
  cited proof to be accepted.
- **Eligibility (trust bar)**: falseRate ≤ 0.33 AND (plausible+false) ≤ 0.50 —
  the logic being a reviewer wrong >1-in-3 times can't be trusted without
  re-checking everything, which defeats automating review.
- **Ground truth**: 14 curated seeded defects (`known-defects.json`), 13 valid
  after the KD-013 invalidation (below).

## Headline results

Both judges agree on the core findings (87.2% coarse agreement, 63.8% exact-label,
hard proven-vs-false disagreement only 0.8%):

| Arm | Judge | False-rate | Precision | Value | KD recall (/13) | Verdict |
|---|---|---|---|---|---|---|
| A — apparatus | Claude | 40.8% | .385 | 439 | 5/13 | ineligible |
| A — apparatus | GPT | 39.5% | .397 | 551 | 5/13 | ineligible |
| B — GLM+GPT+Gemini | Claude | 38.4% | .385 | 785 | 5/13 | ineligible |
| B — GLM+GPT+Gemini | GPT | 37.5% | .385 | 899 | **7/13** | ineligible |
| C — GLM+Gemini | Claude | 31.8% | .391 | 444 | 3/13 | eligible |
| C — GLM+Gemini | GPT | 35.6% | .358 | 442 | 5/13 | ineligible |
| S-sonnet | Claude | 33.1% | .428 | 817 | 4/13 | ineligible |
| S-sonnet | GPT | 28.8% | .434 | 1072 | 4/13 | eligible |
| S-fable | Claude | 31.1% | .437 | 879 | 3/13 | eligible |
| S-fable | GPT | 25.8% | .435 | 1099 | 3/13 | eligible |
| S-sonnet ×3 | Claude | **43.3%** | .394 | 492 | 2/13 | ineligible |
| S-sonnet ×3 | GPT | **44.5%** | .384 | 805 | 4/13 | ineligible |

**Six findings:**

1. **The production apparatus fails its own trust bar in both judges** — 39–41%
   of its claims are flatly wrong against the real code.
2. **A single cheap solo pass (S-fable) is *more* trustworthy than the full
   pipeline** — lower false-rate, higher value, both judges.
3. **But it's a real precision/recall tradeoff, not "AI audits are useless"** —
   the pipeline arms still recover more seeded hard bugs in most comparisons.
4. **Repeating the same model ×3 made things WORSE** — highest false-rate of all
   six arms in both judges. Repetition amplifies noise; it does not dedupe signal.
5. **Two arms (C, S-sonnet) sit on the eligibility threshold and flip between
   judges** — the measurement's honest noise floor, not a contradiction.
6. **Arm B has the best hard-bug recall of anything tested** (7/13, GPT judge) —
   better than the production apparatus — while failing the trust bar on noise.

## Follow-up 1 — the Sonnet+Gemini composition (all 13 commits, GPT judge only)

The main study never tested "Sonnet writes → fresh Sonnet audits cold → Gemini
adds one lens." Cost-minimal retro: reuse S-sonnet's existing graded findings
free; spend only on ONE net-new Gemini call per commit.

| Configuration | Rows | Value | Precision | False-rate | KD recall (/12 valid here) |
|---|---|---|---|---|---|
| S-sonnet alone | 456 | 1376 | .455 | 24.3% | 4/12 |
| Arm C (GLM+Gemini) | 223 | 483 | .356 | 34.5% | 5/12 |
| Gemini net-new only | 57 | 201 | **.661** | **10.5%** | 0/12 |
| **Sonnet + Gemini combined** | 513 | **1577** | .474 | 22.8% | 4/12 |

**The additive-vs-corrective distinction (sharpest single insight in the study):**
Gemini's additions are high-quality (better precision and false-rate than
Sonnet's own) and lift every trust metric (+14.6% value) — but across all 57
net-new findings and 12 seeded bugs, Gemini closed **zero** of Sonnet's
hard-bug gaps. Its value is **additive** (finds different real things), not
**corrective** (doesn't fix the author-family's blind spots on the hardest
bugs). Meanwhile GLM catches KD-005/006, which no Claude-containing composition
ever finds — the recall sets are not nested.

## Follow-up 2 — GPT-5.5 vs Gemini as from-scratch generators (5 commits, GPT judge)

Everywhere else, Gemini only ever did the *easier* job ("find what the prior
pass missed") while GPT-5.5 did the harder one (cold 5-pass audit). This
follow-up ran both through the **identical** from-scratch task — the missing
apples-to-apples comparison, and a materiality question the operator raised
directly.

| | GPT-5.5 alone (n=54 HIGH) | Gemini alone (n=68 HIGH) |
|---|---|---|
| proven/actionable/plausible/false | 13/9/4/28 | 19/17/14/18 |
| false-rate | **51.9%** | **26.5%** |
| junk-rate (plaus+false) | 59.3% | 47.1% |
| precision | .341 | .429 |
| eligible | NO | YES |
| KD recall (/5 in-scope) | 2/5 | 1/5 |

**Reading**: used exactly the way GPT is normally used, Gemini is the cleaner
generator on every trust metric. The self-grading caveat (the GPT-5.5 judge
graded its own GPT-alone findings) cuts *in favor* of this conclusion —
self-preference bias would inflate GPT's score, and it still landed worse than
every arm in the main study. This traces the production pipeline's noise to
**GPT's generation layer specifically**, not to Gemini being under-tested.
Explicit non-finding: this does NOT establish "Gemini > Sonnet" — those two
were never compared at equal rigor (5-commit/1-judge vs 13-commit/2-judge).

## The four self-corrections (the credibility backbone)

1. **Diff-chunking measurement bug (root-caused + fixed + full re-run).**
   `chunkDiff()`'s hard-split branch dropped the `diff --git` header on
   continuation fragments, so models misread partial views as whole-file
   deletions — the largest false-positive family in the original run. Fixed
   with synthetic continuation markers (regression-tested); the ENTIRE dataset
   above is post-fix. Confirmed local to the experiment harness — production
   `/audit-code` uses a different chunker and is not implicated.
2. **KD-013 ground-truth invalidation (found by the blind process itself).**
   A curated "known defect" claimed a method call was invalid; a blind judge
   checked the real Obsidian typings and found `Vault.getFileByPath` IS a
   documented public API (`obsidian.d.ts:6386`, since 1.5.7). Independently
   re-verified; excluded from every recall denominator (14 → 13).
3. **Fable-5 pricing correction (an assumption stated as fact, then caught).**
   An early conclusion called S-fable "the cheapest model" from name-pattern
   alone. Real verified pricing: Fable-5 is Anthropic's MOST expensive model
   ($10/$50 per MTok — 5× Sonnet-5, above Opus). The cost-effectiveness
   conclusion was rebuilt on real numbers: S-sonnet, not S-fable, is the
   cost-effective solo pick.
4. **CLI-backend usage under-reporting (found during cost re-scoring).**
   The stored `usage.input_tokens` for Claude-CLI-backend arms is implausible
   (hundreds of tokens recorded for hundreds of large-diff calls) — the
   `claude -p` backend under-reports input tokens. All cost analysis therefore
   re-derives input sizes from git directly; capturing real per-call
   `cost_usd`/`usage` is now a phase of the redesign plan.

## Caveats (not optional decoration)

- N=13 usable commits is pilot-scale — directional, not statistically definitive.
- Frozen-diff parallel design ⇒ the apparatus's unique marginal value is an
  **upper bound** (in production, a solo pass would fix bugs before the pipeline
  saw the diff).
- KD-recall denominators are small (12–13); 1–2 catches swing percentages a lot.
- Both judges are LLMs; cross-family 87% agreement is the strongest available
  mitigation short of a human panel. A partial human ground-truth check on the
  judges' labels is designed into the redesign plan's validation session.
- Both follow-ups are single-judge (GPT-5.5) — strong directional signals, not
  cross-validated at main-study rigor.
