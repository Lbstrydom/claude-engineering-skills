# Experiment 4 — cheap final reviewers (kimi-k3, glm-5.2) vs claude-opus-5

**Date**: 2026-07-28 · **Status**: smoke test, n=2 transcripts · **Verdict**: no swap yet — insufficient evidence, not insufficient capability
**Follow-on from**: [`final-review-shadow-adjudication-briefing.md`](final-review-shadow-adjudication-briefing.md) (verdict KEEP, $1.45/run)

> **Read §Result 3 before §Result 2.** Result 2's "schema non-compliance"
> disqualification was **our defect, not the models'** — we never asked for the
> schema. It is kept unedited as the audit trail; Result 3 supersedes it.

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

## Result 3 — schema wired, re-run: both models now comply

The §Verdict below originally said the comparison was invalid because our
request never asked for a schema. That blocker is now fixed: the `openai`
transport sends `response_format: {type:'json_schema', …}` derived from the SAME
`GeminiFinalReviewSchema` Zod source (via `zodToOpenAiJsonSchema` — deliberately
not the Gemini-key-stripped variant), opt-in per descriptor so Azure Foundry,
which shares the adapter, is byte-identical. A router that rejects the field
degrades once to prompt-only rather than failing the gate.

Re-ran all four cells. **Every finding now carries all 7 required fields** —
`id, severity, category, section, detail, risk, recommendation` — 11/11 keys
including `is_quick_fix`/`is_mechanical`/`principle`, against 0/4 before:

| arm | small | r2 | compliance |
|---|---|---|---|
| moonshotai/kimi-k3 | APPROVE, 0 new, 20s | CONCERNS, 2 new, 62s | **all fields present** |
| z-ai/glm-5.2 | CONCERNS, 2 new, 100s | APPROVE, 0 new, 46s | **all fields present** |

No provider issued a downgrade — `json_schema` was accepted on every call.

Content is specific and genuine, not schema-shaped filler. The strongest signal
is **independent convergence**: glm-5.2's top small-transcript finding (the
`buildDiffPathMap` "filter before mapping, not after" contract drift, cited to
the plan's Security Considerations) is the *same defect* claude-opus-5 raised
first on that transcript. kimi-k3 independently escalated the
`verify-anchor-contract.mjs` acceptance-grading gap to HIGH, which Opus also
flagged (as MEDIUM, via a different route).

One quality tell worth recording: glm-5.2 emitted a category string reading
`"…deviating từ"` — a Vietnamese token leaked mid-field. Cosmetic here, but it is
the kind of instability that matters in a field the taxonomy keys on.

## Verdict — schema blocker cleared; still not enough evidence to swap

The original blocker is gone: **both cheap models produce contract-compliant
findings once actually asked to.** The earlier "non-compliant" result was our
defect, not theirs.

What still blocks a swap is evidence, not capability:

- **n=2 transcripts**, with a stated code-drift confound (transcripts are from
  ~2026-07-15; the reviewer reads code at current HEAD).
- **The arms disagree with themselves across transcripts** — each returns
  APPROVE on one and CONCERNS on the other, and they disagree about *which*.
  With 2 data points that is unresolvable.
- No human adjudication of the new findings, so precision is unmeasured. The
  convergence with Opus is encouraging but is 2 findings, not a rate.

**Recommendation**: the routing + schema fixes are worth keeping regardless —
they were repo defects affecting every OpenRouter final review. For the swap
decision, accumulate 8–10 transcripts now that `.audit/` retention is in place,
then re-run all three arms and adjudicate. Cost of that run is ~$5.

## Collection protocol — the window, and why it is a passive one

Re-running at n=8–10 needs real transcripts, and this is the one place where
the repo's **synchronous-swap rule cannot be satisfied**. Stating that plainly
rather than quietly running a collector:

- The rule exists because passive collection killed arm-eval and produced five
  false "window met" reads. It is not being waived.
- But the known-defect corpus (18 curated cases) evaluates the **auditor** role
  — can a model find a planted defect in a diff. The final reviewer's job is to
  review a **deliberation** and judge whether it was sound. A synthesized
  transcript with no real rounds would test the auditor question wearing the
  final reviewer's name, so it is not a valid shortcut.
- Real transcripts only appear as ordinary work happens. Hence: a window.

The slot is legitimately free — the final-review 2nd-gate shadow **closed**
2026-07-28 (verdict KEEP). This reuses that slot; it does not add a sixth
collector.

**Collection is already live and requires no action.** Transcripts now persist
to `.audit/` (commit 208eba2) instead of `/tmp`, which is OS-cleaned and, on
Windows, resolves differently for Bash and Node — the reason the 35-run shadow
window left zero replayable inputs.

**Readiness is counted, never eyeballed** (the lesson from those five false
reads):

```bash
node scripts/final-review-bakeoff.mjs --status
```

Eligibility is deliberately strict: `mode: 'code'` only (a plan-mode transcript
drives a different prompt path), and the referenced plan file must still exist
(an unreplayable transcript would inflate readiness against inputs that cannot
run). Rejections are printed with a reason, never silently dropped.

When it reads READY:

```bash
node scripts/final-review-bakeoff.mjs --run --arms opus,kimi-k3,glm-5.2
```

Below target this **refuses with exit 3** rather than producing a thin result
that reads like a verdict; `--min N` overrides deliberately. The runner records
per-arm verdict, finding count, latency, and — measured, not assumed — schema
compliance, since a regression there is silent (validation is warn-and-keep, so
degraded rows reach the store rather than failing).

**The stopping rule is the half that matters**: adjudicate the findings by hand
**in the same sitting the window fills**. A filled window left unadjudicated is
precisely how the $50.90 shadow experiment became unreadable — 63 of 88 findings
sat unlabelled because the loop had already fixed them and nobody closed the
loop in the store. Counts from this runner are not a quality ranking and must
not be read as one.

## Artifacts

`.audit/smoke-2026-07-28/{opus,kimi-k3,glm-5.2}-{small,r2}.json` (gitignored).
Reproduce: `FINAL_REVIEW_MODEL=<id> node scripts/gemini-review.mjs review <plan> <transcript> --provider openrouter --out <file>`.
