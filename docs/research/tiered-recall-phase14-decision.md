# Tiered-recall pipeline — Phase-14 production-flip decision

- **Date of decision**: 2026-08-17
- **Recorded here**: 2026-08-21
- **Verdict**: **DO NOT FLIP.** Close Phase 14 without setting
  `tieredAuditConfig.pipelineEnabled` to production; hand any future
  tiered-vs-legacy production decision to the comparison-campaign framework.
- **Status**: settled — this file transcribes an existing decision, it does not
  make a new one.

> **This document is a transcription, not an adjudication.** The decision was
> taken on 2026-08-17 and recorded in
> [`docs/plans/tiered-recall-audit-pipeline.md`](../plans/tiered-recall-audit-pipeline.md)
> §"Close-out 2026-08-17", committed as `e9305550`
> (*"docs(plans): close tiered-recall-audit-pipeline; sync two other plan
> closures"*). That plan's `Status:` is `Complete`. Nothing here re-opens or
> re-litigates it; this file exists so the decision is discoverable at the path
> the tooling looks for, rather than only inside a closed plan's close-out
> section.

## The decision, as taken

Close the plan **without** flipping to production, for two reasons drawn from
the 2026-08-17 measurement:

1. **Live reliability.** The tiered pipeline's required GLM discovery step
   failed outright — timeout or output truncation — far more often than it
   completed, and the pre-existing OpenRouter hardening
   (`require_parameters: true`, retry + backoff) did not close it. A pipeline
   that falls back to legacy or fails on the majority of eligible runs is not a
   production-ready replacement for the always-on 5-pass path, whatever it
   costs on the runs that do complete.
2. **Unverified overlap at the time.** The near-0% finding-overlap rate could
   not yet be read as genuine disagreement until per-row
   `legacyUnlocalizedCount` / `tieredUnlocalizedCount` were checked. That check
   was done on 2026-08-21 — see "Interpretability gap closed" below — and it
   does not change the verdict, but it does resolve what the 0% actually means.

Rather than keep extending this plan's bespoke instrument
(`tiered-shadow-compare.mjs`, `tiered-shadow-summary.mjs`) to chase GLM
reliability and the overlap check, the production-flip evaluation was **handed
to the general-purpose comparison-campaign framework** (`campaign.mjs`'s
role-agnostic `EXECUTORS` registry, native provider routes, per-arm retry,
antisymmetry/same-family checks) shipped by
[`role-agnostic-comparison-core.md`](../plans/role-agnostic-comparison-core.md)
and [`comparison-tooling-consolidation.md`](../plans/comparison-tooling-consolidation.md).

## Evidence at the time of the decision (2026-08-17)

From `npm run audit:tiered-shadow-report` against the live store:

| Metric | Value |
|---|---|
| `comparedRuns` (epoch `v7-multi-hunk-selector-2026-07-27`) | 27 — window (10–15) met |
| `totalRuns` | 415 |
| `excludedStaleEpoch` | 42 (pre-`v7`, correctly excluded) |
| `excludedFallback` | 34 |
| `shadowFailures` | 210 — dominated by GLM discovery timeout (117) + truncation (63) |
| `costDeltaUsd` | mean −$0.224, median −$0.142 (tiered cheaper on completing runs) |
| `latencyDeltaSec` | mean +93.2s, median +107.4s (tiered slower) |
| `findingOverlapRate` | mean 0%, median 0% — unverified at the time; resolved 2026-08-21, see below |

Re-read on 2026-08-21 (read-only, no spend), `comparedRuns` had risen to **33**.
That does not change the verdict: the two reasons above are about reliability
and interpretability, neither of which more rows addresses.

## What stays live

Not an abandonment of the shipped work — Clusters A–F remain in the codebase,
unconditionally available: the `EvidenceAnchorV2` evidence-contract schema,
Stage 0's deterministic verify/blame/impact checks, the ledger-routing fix,
the cost-budget / `UsageEvent` instrumentation, and the verified-line location
fix for tiered findings.

`runLegacyProductionAudit` remains the default production path.
`AUDIT_TIERED_SHADOW_ENABLED` was turned **off** on 2026-08-21 (see
"Interpretability gap closed" below) — the mechanism stays in the codebase and
can be re-enabled with one env-var change, but it was left running with no
identified consumer for over three weeks after this close-out, and **no
further work on this plan's own Phase 14 is planned**.

## Consequence recorded on 2026-08-21 — the repo-context legacy pin retires

`scripts/lib/audit/legacy-production-audit.mjs` was pinned to a frozen
`composeLegacy()` repo-context composition on 2026-08-21
([`docs/plans/repo-context-budget-honesty.md`](../plans/repo-context-budget-honesty.md) §2, §8)
so its prompt bytes could not move while the tiered-shadow cohort was believed
to be awaiting adjudication.

**That premise was stale when it was written.** The adjudication had already
happened four days earlier, in the close-out transcribed above. The pin's
author read `tiered-shadow-report.mjs`'s *"time for the Phase-14 review"* line
— a generic threshold trigger that fires on `comparedRuns` alone and has no
knowledge of the plan's status — as if it described repo state, and did not
read the plan. The tool was reporting a threshold; the decision had been made.

With the decision recorded here, the retirement predicate in
`tests/repo-context-legacy-pin.test.mjs` fires by design, and the pin, the
frozen composition and that guard test are all removed in the same commit that
adds this file. The generalisable lesson is in the plan's own risk register: a
threshold trigger is not an adjudication, and a plan's `Status:` line is the
cheaper thing to read first.

## Interpretability gap closed on 2026-08-21

Reason 2 above was left open at close-out: a near-0% overlap rate is
uninformative if neither side's findings were localized enough to compare in
the first place — matching a genuinely-shared defect requires both sides to
name roughly the same place, and an unlocalized finding cannot do that no
matter how the matcher works.

**Method.** Queried the live `tiered_shadow_observations` table directly
(read-only, no spend), reproducing the `comparedRuns` predicate's SHAPE +
POPULATION check (both eligible-count fields present, at least one side
non-empty) without the epoch gate — a superset of the report's exact
epoch-filtered 33, at 60 rows, spanning both the pre-fix and post-fix
(`v6-verified-line-2026-07-26`, `v7-multi-hunk-selector-2026-07-27`) epochs.
Per row, compared `legacyFindingCount` against `legacyUnlocalizedCount` and
`tieredFindingCount` against `tieredUnlocalizedCount`.

**Result — the null hypothesis is false.**

| | rows with ≥1 finding | rows where ALL findings are unlocalized |
|---|---|---|
| Legacy | 41 | 41 (100%) |
| Tiered | 55 | 5 (9%) |

Legacy is unlocalized on every single row with findings — expected and
permanent, per the plan's own declared-scope decision
(`docs/plans/tiered-recall-audit-pipeline.md` §"Declined for the legacy 5-pass
audit"): the legacy path has no diff/hunk-verification substrate, so a
self-reported line there would carry the exact unverifiable-hallucination risk
the location-verification work exists to avoid. That was never going to
change and isn't evidence of anything about the overlap rate.

Tiered is the opposite of what "0% overlap is just missing data" would
predict: 50 of 55 rows (91%) have **at least one properly line-verified
finding** — the `v6`/`v7` location-resolution fix worked, and the majority of
comparison rows had real, verified anchors on the tiered side to match
against.

**Conclusion.** The 0% overlap rate is not an artifact of unlocalized data —
the tiered side had verifiable locations to compare in the large majority of
rows and still matched nothing. That points at the overlap **matcher**
(comparing model-authored prose findings across two structurally different
pipelines) rather than a data-availability gap — the same class of problem
this repo has already hit and fixed elsewhere: exact-text matching between two
LLMs' independently-phrased findings essentially never matches even when the
underlying defect is the same (0 of 48 pairs in the final-review-shadow
bake-off before a file-set + Jaccard matcher replaced it). This does not
reopen the "no flip" verdict — reliability (reason 1) was already sufficient
on its own — but it does mean a future revisit of this pipeline should treat
the overlap number as **uninterpretable under the current matcher**, not as
evidence of low true agreement, and should not spend effort re-verifying
localization before addressing the matcher itself.

**Consequence**: `AUDIT_TIERED_SHADOW_ENABLED` turned off the same day (see
"What stays live" above) — reason 2 is now answered rather than open, reason 1
(reliability) was never in question, and the shadow had no identified consumer
regardless of what the interpretability check would have found.

### Scope of the turn-off — machine state, not repo state

`AUDIT_TIERED_SHADOW_ENABLED` lives in the operator's `~/.audit-loop.env`,
which is not committed, so turning it off does not turn it off for a consumer
repo or another machine. `config.mjs`'s committed default was already
`false`, so nothing in the repo needed to change for the default to be right.
Verified effective rather than assumed: `tieredAuditConfig.shadowEnabled ===
false`, `pipelineEnabled === false`, variable set in no source. The 33
collected rows survive in `tiered_shadow_observations` — this stops
accumulation, not history.

### The trigger line that caused the 2026-08-21 confusion is fixed at source

`tiered-shadow-report.mjs` and the dashboard's tiered-shadow section both
printed *"window met — time for the Phase-14 production-flip review"* keyed on
`comparedRuns` alone. That line cannot know the review happened, so it said
the same thing forever — and it is what convinced a reader that this closed
decision was still open, at the cost of a frozen second composition path and a
self-expiring guard test built around it.

Both surfaces now consult `phase14Decided()` **first** and report the closure.
One shared oracle in `lib/audit/tiered-shadow-summary.mjs`, not an
`existsSync` per surface — two spellings of one predicate is how a fix lands
on one and misses the other. Existence-only by design: parsing a verdict out of
prose would make a headline depend on markdown phrasing. Module-relative, never
cwd, or the probe silently reports "not decided" from another directory and
resurrects the line it exists to suppress.

> **A correction, recorded because the shape matters.** An earlier draft of
> this addendum declared reason 2 "closed UNRESOLVED — nobody is going to run
> that check". That was written the same day the check was actually run, by a
> concurrent session, with the result above. It was an assertion about the
> future in place of a measurement — the same error, in the same document, as
> the threshold-trigger misreading it was trying to document. The evidence-based
> section above is the record; this note is why it replaced the other one.

