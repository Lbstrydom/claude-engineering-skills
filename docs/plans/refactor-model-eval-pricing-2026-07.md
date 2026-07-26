# Plan: Model-Eval / Pricing Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Draft
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). Small
> cluster (9 entries) across `model-eval/cost.mjs`,
> `model-eval/deterministic-scorer.mjs`, `model-eval/verdict.mjs`,
> `model-pricing.mjs`, and `store/model-eval.mjs`. Verified against current
> source 2026-07-26.

---

- `r15h2costrowagg` — `cost.mjs`'s schema `superRefine` sum-check is
  *skipped* whenever any `byPhase` entry is unpriced, so a row can have
  `costStatus: 'available'` at the top level while a phase entry is
  `'unavailable'` and no consistency check ever runs. **Fix**: require the
  sum-check to run (and fail closed) whenever `costStatus === 'available'`
  regardless of individual phase pricing status.
- `r15m2phaseenum` — `byPhase: z.record(z.string(), ...)` accepts any string
  key, not constrained to the actual phase enum already defined a few lines
  above in the same file. One-line fix: `z.record(PhaseEnum, ...)`.
- `r15m3tokendry` — `cost.mjs` defines its own local `isValidTokenCount`
  instead of importing `model-pricing.mjs`'s existing `isValidCount` — two
  parallel implementations of the same validation, one of which isn't even
  imported. **Fix**: delete the local copy, import the shared one (DRY,
  and matches this repo's own explicit "#1 DRY" principle).
- `adbda8c8` — `model-pricing.mjs`'s pricing lookup (`familyPricing[key] ||
  familyPricing[modelId] || null`) uses plain bracket access with no
  `Object.hasOwn` guard, unlike the adjacent `OSS_PRICING` check in the same
  function — a prototype-pollution-adjacent inconsistency more than an
  exploitable bug, but worth matching the existing safer pattern.
- `c5808479` — `costFromUsage` has no `usageMissing`/`isValidCount` guard
  (unlike its sibling `costForBudget`), so missing usage silently sanitizes
  to 0 tokens and reports `priced: true, totalUsd: 0` — a **false report of
  successful $0 pricing** rather than "couldn't price this."
- `f68a6dbc` — the model-pricing fail-fast validation loop only iterates
  models that already exist in `OSS_PRICING`/`familyPricing` today, so it
  structurally cannot catch a *future* unlisted model falling through to a
  silent default.
- `62d7faf3cd80` — `deterministic-scorer.mjs`'s finding-matcher is a greedy
  best-match-per-expected loop (not a global optimum) plus a
  collision-prone basename fallback.
- `r15m7godmodules` — the `model-eval/` files remain multi-concern with
  accreted round-N commentary (`verdict.mjs` 404 lines/7 round-refs,
  `route-catalog.mjs` 376/10, `structured-extractor.mjs` 295/5,
  `deterministic-scorer.mjs` 227/5) — no dedicated cleanup pass has
  happened since the module-eval harness was built.
- `r15h1jsonbfinite` — `store/model-eval.mjs`'s `isJsonbSafeValue()` returns
  `true` for *any* `typeof v === 'number'`, so `NaN`/`Infinity` pass the
  jsonb-write safety check that the rest of this repo's "jsonb-safe write
  seam" doctrine (AGENTS.md) exists specifically to catch. **Fix this one
  first** — it's the one entry in this cluster that's a real data-integrity
  gap in a documented-as-load-bearing seam, not just a code-quality item.

---

## Full entry table


**`scripts/lib/model-eval/cost.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `r15h2costrowagg` | HIGH | model-eval/cost.mjs:81-103 sum-check skipped when any byPhase entry unpriced |
| `r15m2phaseenum` | MEDIUM | model-eval/cost.mjs:80 byPhase record unconstrained vs phase enum |
| `r15m3tokendry` | MEDIUM | model-eval/cost.mjs:147 local isValidTokenCount duplicates model-pricing.mjs isValidCount, never imported |

**`scripts/lib/model-eval/deterministic-scorer.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `62d7faf3cd80` | HIGH | model-eval/deterministic-scorer.mjs:200-210,104-105 greedy match + basename fallback collision-prone |

**`scripts/lib/model-eval/verdict.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `r15m7godmodules` | MEDIUM | model-eval files still multi-concern, no dedicated cleanup occurred |

**`scripts/lib/model-pricing.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `adbda8c8` | HIGH | model-pricing.mjs:108-109 no Object.hasOwn guard on bracket lookup |
| `c5808479` | MEDIUM | model-pricing.mjs:128-149 costFromUsage no usageMissing/isValidCount check |
| `f68a6dbc` | HIGH | model-pricing.mjs:70-78 fail-fast loop cannot validate future/unlisted models |

**`scripts/lib/store/model-eval.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `r15h1jsonbfinite` | HIGH | store/model-eval.mjs:79 isJsonbSafeValue returns true for any number without Number.isFinite check, NaN/Infinity pass |

## Rollback

Additive/defensive changes only; `r15h1jsonbfinite`'s fix should be covered
by extending `tests/store-jsonb-array-serialization.test.mjs` (the existing
guard for this exact seam) rather than a new test file.
