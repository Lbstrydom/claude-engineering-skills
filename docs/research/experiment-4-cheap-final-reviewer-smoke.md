# Experiment 4 — cheap final reviewers (kimi-k3, glm-5.2) vs claude-opus-5

**Date**: 2026-07-28 · **Status**: smoke test, n=2 transcripts · **Verdict**: do not swap
**Follow-on from**: [`final-review-shadow-adjudication-briefing.md`](final-review-shadow-adjudication-briefing.md) (verdict KEEP, $1.45/run)

## Why

The shadow A/B closed KEEP — the findings were real — but at $50.90 for 35 runs
the cost was the open question. OpenRouter list prices suggested a large saving:

| model | in $/M | out $/M | that same 35-run window |
|---|---|---|---|
| claude-opus-5 | 15 | 75 | **$50.90** (actual) |
| moonshotai/kimi-k3 | 3 | 15 | ~$10.2 |
| z-ai/glm-5.2 | 0.77 | 2.42 | ~$2.4 |

The window's own transcripts are gone (see §Method), so this is a **head-to-head
on fresh runs over surviving inputs**, not a comparison against the $50.90
baseline. It cannot be, and no amount of re-running makes it one.

## Method

Two surviving code-mode transcripts, same plan, same three arms:

- `cycle-union-1784300000-transcript.json` — ~54K token context ("small")
- `cycle-union-r2-transcript.json` — ~106K token context ("r2")

**Confound, stated up front**: the transcripts date from ~2026-07-15 but the
final reviewer reads code files from disk at *current* HEAD. Every arm gets the
same mismatch, so the relative comparison holds; absolute findings may be
artifacts of reviewing a plan against code that moved under it.

## Result 1 — the timeouts were OpenRouter routing, not the models

First attempts looked like model flakiness and were nothing of the kind:

| arm | first attempt | after routing fix |
|---|---|---|
| kimi-k3 (r2) | timeout at 120s, then at **420s** | **61s** |
| kimi-k3 (small) | 229s | **34s** |
| glm-5.2 (r2) | 115s (at the 120s edge) | **48s** |
| glm-5.2 (small) | timeout at **300s** | **62s** |

GLM passing the *big* transcript and failing the *small* one is what gave it
away — that is not a context-length story. OpenRouter serves one model id from
many backends and picks per request:

- `moonshotai/kimi-k3` is offered by **Nebius at 8,000 context** and by others at
  1M. A 54K-token review routed there cannot succeed.
- `z-ai/glm-5.2` is offered by **AkashML at 96,890** — under the 106K review.
- Same request, no pinning: **Moonshot AI 15.5s vs Fireworks 5.0s**, 3× apart.

**The load-bearing one is reasoning tokens.** kimi-k3 is a reasoning model, and
reasoning tokens count against `max_tokens`: in a 600-token budget it spent
**597 thinking** and emitted almost no answer. At `MAX_OUTPUT_TOKENS` (32,000) on
a ~39 tok/s backend that is **~830s of pure reasoning before the first byte of
JSON** — exactly the timeouts observed.

Fix applied to the `openrouter` descriptor in `gemini-review.mjs` (OpenRouter-only
body fields; ignored by other OpenAI-compatible gateways, undefined elsewhere):

```js
provider: { require_parameters: true, sort: 'throughput' },
reasoning: { effort: 'low' },
```

This is worth keeping regardless of the swap decision — **any** OpenRouter route
in this repo was subject to the same lottery.

## Result 2 — the actual finding: schema non-compliance

With routing fixed, all three arms complete and all three return **different
shapes**. The contract (`GeminiFinalReviewSchema`) requires
`id, severity, category, section, detail, risk, recommendation`:

| arm | keys returned | compliant |
|---|---|---|
| claude-opus-5 | all 7 + `is_quick_fix`, `is_mechanical`, `principle` | **yes** |
| moonshotai/kimi-k3 | `id, severity, file, title, description, evidence` | **no** |
| z-ai/glm-5.2 | `id, title, severity, description, evidence_basis, cited_lines` | **no** |

Both cheap models invent a plausible schema instead of filling ours. The
consequences are silent, which is what makes this disqualifying rather than
merely annoying:

- `category` is absent → the R2+ suppression ledger and finding taxonomy key on
  it; every finding lands uncategorised.
- `section` is absent → the finding cannot be located.
- `risk` / `recommendation` absent → downstream consumers get nothing.
- Zod validation here is **warn-and-keep**, not reject, so these rows flow into
  the findings store as degraded records rather than failing loudly.

A swap on today's code would not produce "cheaper reviews." It would produce
**quietly unusable findings**, and the store would fill with them.

Worth recording: kimi-k3's *analysis* was competent. Its one small-transcript
finding correctly identified that `buildDiffPathMap` enforces `maxMapEntries`
against unfiltered sections, with specific reasoning about the documented
deviation. The reasoning is plausible; the envelope is not.

## Counts, for completeness

| arm | small | r2 |
|---|---|---|
| claude-opus-5 | CONCERNS_REMAINING, 4 new, 82s | CONCERNS_REMAINING, 3 new, 63s |
| moonshotai/kimi-k3 | APPROVE, 1 new, 34s | CONCERNS, 2 new, 61s |
| z-ai/glm-5.2 | CONCERNS, 2 new, 62s | APPROVE, 0 new, 48s |

Do not read these as a quality ranking. n=2, the arms disagree with *themselves*
across transcripts (GLM: 2 findings then 0; kimi: APPROVE then CONCERNS), and the
oracle-matching recall ceiling recorded in the model-eval runbook applies. The
only signal firm enough to act on is the schema result, which is categorical and
reproduced on every run.

## Verdict — do not swap; the blocker is fixable

Not "the cheap models are worse." **The comparison is not yet valid**, because
our request never asks for a schema — the `openai` adapter only appends *"Output
strictly valid JSON"* to the system prompt and hopes. Opus complies because the
anthropic transport forces a `submit_review` **tool call** with the real schema.
The cheap arms were never given the contract they are being judged against.

To make a real decision, send `response_format: {type: 'json_schema', json_schema: …}`
on the openai transport for providers advertising `structured_outputs`
(`require_parameters: true` already filters to them — Fireworks, Together, Morph
for kimi-k3; CoreWeave, StreamLake, Baidu, Alibaba for glm-5.2). Then re-run.

**Until then the honest state is: routing fixed, comparison invalid, no swap.**
At n=2 with a stated code-drift confound this could not have justified a swap
anyway — it is a smoke test, and it found a real defect in our own adapter rather
than a verdict about the models.

## Artifacts

`.audit/smoke-2026-07-28/{opus,kimi-k3,glm-5.2}-{small,r2}.json` (gitignored).
Reproduce: `FINAL_REVIEW_MODEL=<id> node scripts/gemini-review.mjs review <plan> <transcript> --provider openrouter --out <file>`.
