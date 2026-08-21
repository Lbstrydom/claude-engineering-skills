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
2. **Unverified overlap.** The near-0% finding-overlap rate must not be read as
   genuine disagreement until per-row `legacyUnlocalizedCount` /
   `tieredUnlocalizedCount` are checked. That check was never done on the
   compared rows, so the interpretability gap the plan itself flagged is still
   open.

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
| `findingOverlapRate` | mean 0%, median 0% — **unverified**, see reason 2 |

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
`AUDIT_TIERED_SHADOW_ENABLED` stays available for anyone who wants to keep
collecting shadow data, **but no further work on this plan's own Phase 14 is
planned**.

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
