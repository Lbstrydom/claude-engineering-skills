---
summary: The 10 finding classes with predicate, required evidence, FP guard, and gate-eligibility.
---

# Findings Taxonomy

`scripts/lib/nav/findings.mjs::runTaxonomy()`. Each finding carries
`{class, severity (P0–P3), destination, evidence[], confidence, gateEligible,
verdict}`. The `verdict` is the one-line "offered vs needed" judgement.

**Only classes 2 (coverage-gap) and 10 (anchor-regression) are gate-eligible** —
declared-intent regressions. Everything else is advisory (surfaced as a PR
comment / dashboard drift, never a hard fail).

| # | Class (sev) | Predicate | Evidence | FP guard |
|---|---|---|---|---|
| 1 | redundancy (P2–P3) | in-degree ≥2 across ≥2 prominent anchors | the prominent anchors | justified if a declared `frequency:"high"` intent targets it |
| 2 | **coverage-gap (P1)** | declared intent's destination not reachable in its `requiredInLayer` | intent + observed anchors | declared intents only |
| 3 | orphan (P2) | destination in-degree 0 | absence of inbound edges | suppressed if `navMeta.deepLinkOnly`/`utility` or a known utility route |
| 4 | dead-end (P3) | a view destination emits no onward nav | outbound count 0 | suppressed if `navMeta.terminal` |
| 5 | label-inconsistency (P3) | one label → ≥2 destinations | the conflicting edges | skips `label:null` edges |
| 6 | surprising-mapping (P3) | label tokens absent from destination id | edge | low-confidence, advisory only |
| 7 | competing-models (P2) | ≥2 prominent layers partition destinations disjointly | per-layer destination sets | needs ≥2 declared prominent layers |
| 8 | sequencing (P2) | high-frequency intent reachable only via low-prominence affordance | intent + best affordance | uses affordance prominence, never taps |
| 9 | onboarding-overlap (P3) | ≥2 onboarding affordances to one destination | the overlapping edges | suppressed for declared A/B variants |
| 10 | **anchor-regression (P0–P1)** | declared intent lost an approved anchor vs the base graph | before/after anchor edge | diff-scoped; base graph recomputed at merge-base |

## Confidence

Each finding inherits the worst-case confidence of its supporting edges. Low-
confidence edges (computed targets, deep/conditional composition chains, opaque
destinations) **never hard-gate** even when their class is gate-eligible.

## Why so few gate-eligible

The gate is intentionally narrow: a CI failure must mean "a path a declared
persona needs was removed or buried," nothing softer. Advisory findings inform
review without blocking legitimate IA changes — the lesson from the brainstorm
that a raw graph-diff gate gets disabled within a week.
