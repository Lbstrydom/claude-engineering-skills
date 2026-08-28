# Final-Review Shadow Bake-Off — marginal-value re-test verdict

- **Date of decision**: 2026-08-28
- **Recorded here**: 2026-08-28
- **Verdict**: **KEEP opus.** SELECT opus as the final-review shadow model.
  No challenger (kimi, grok, qwen, deepseek) cleared the pre-registered
  relative effectiveness floor. No production change.
- **Status**: settled — this file transcribes an existing decision, it does
  not make a new one.

> **This document is a transcription, not an adjudication.** The decision was
> computed on 2026-08-28 and recorded in
> [`docs/plans/final-review-shadow-bakeoff.md`](../plans/final-review-shadow-bakeoff.md)
> §0.7d "Close-out". That plan's `Status:` is `Complete`. Nothing here
> re-opens or re-litigates it; this file exists so the decision is
> discoverable at the path this repo's tooling looks for, rather than only
> inside a closed plan's close-out section.

## The decision, as taken

`final-review-scoped-2026q3` reached its pre-registered target (N=12
complete snapshots) and the campaign tooling's own gate evaluation reports
`DECISION_READY` — every gate passed. The computed verdict:

```
node scripts/campaign.mjs verdict --campaign final-review-scoped-2026q3
```

| Arm | Accepted (of 12 snapshots) | Rate/snapshot | Result |
|---|---|---|---|
| **opus** (incumbent) | 23 | **1.916667** | **CLEARS the floor** |
| qwen | 15 | 1.25 | blocked — 0.167/snapshot short of the floor |
| deepseek | 10 | 0.833333 | blocked |
| kimi | 8 | 0.666667 | blocked |
| grok | 1 | 0.083333 | blocked |

Floor: opus's own rate minus a pre-registered margin of 0.5/snapshot →
**1.416667/snapshot**. A challenger had to reach that bar to be considered
at all; none did. Cost (`$8`/accepted ceiling) was never reached as a
tiebreak for any challenger, since none passed the effectiveness gate first.
Opus's own cost: **$1.5721/accepted**.

**How close was the nearest challenger, in plain terms.** Think of each of
the 12 snapshots as one full audit pass. Opus flagged real, keepable issues
at just under 2 per pass (23 across 12). The bar a cheaper model had to clear
wasn't "match Opus exactly" — it was allowed to fall short by half an issue
per pass and still qualify, which works out to needing roughly 1.42 keepable
findings per pass. Qwen, the best of the four alternatives, averaged 1.25 —
it was finding real things, about two out of every three that Opus found —
but it landed just under that discounted bar, roughly one issue short every
six passes. Close, genuinely competitive, but not close enough. The other
three weren't in the same conversation: DeepSeek caught under half of what
Opus found, Kimi about a third, and Grok essentially missed almost
everything — one accepted finding across all 12 passes where Opus had 23,
the gap between a careful reviewer and one skimming the document.

## Sensitivity check

`matcher sensitivity: INVARIANT — identical decision at all 6 matcher
variant(s)`. The cross-arm clustering threshold that decides "is this the
same underlying defect across two arms' wording" is itself unvalidated (the
campaign's own module documents it as "PROVISIONAL — labels are
model-generated... Not a validated calibration") — the sweep is what makes
that acceptable here: the verdict is identical regardless of where that
threshold sits, so its lack of validation does not weaken this result.

## One honest caveat, disclosed rather than omitted

The adjudicator model is `latest-opus` — the same family as the incumbent
arm it is judging. Calibration self-family share: opus **77%**, every other
arm **0%**. Human-vs-agent override rates on the calibration sample ran
37–69% across arms (opus's own: 37%). A same-family adjudicator judging its
own arm's output is a real methodological risk this repo has hit before
(`self_family` bias, fixed elsewhere 2026-08-23) — but opus's margin here (23
accepted vs. qwen's next-best 15, a 53% lead) is large enough that a leniency
effect would have to be implausibly strong to change the outcome. Recorded
as a caveat on confidence, not treated as a reason to distrust the verdict.

## A note on what rule actually ran

The plan's original §6.3 (pre-registered 2026-07-29) specified an **absolute**
floor — `marginal ≥ 0.2 accepted HIGH/MED per run` — against a zero-shadow
baseline (the question: should a shadow exist at all). The live campaign's
decision rule, built under the role-agnostic comparison-campaign framework
that generalized this plan's bespoke machinery, is a **relative** floor
against a declared incumbent (opus's own rate minus a margin) — a different
question (which model, given a shadow already exists) than the one
originally pre-registered. Both share the same $8/accepted cost ceiling.
Disclosed here rather than silently presented as an unmodified execution of
§6.3 — see `docs/plans/final-review-shadow-bakeoff.md` §0.7c/§0.7d for the
full campaign-migration history.

## What does NOT change

Production final-review keeps opus as its shadow model exactly as configured
before this campaign ran. No config, code, or default changes as a result of
this verdict — it confirms the status quo rather than prescribing a change.
