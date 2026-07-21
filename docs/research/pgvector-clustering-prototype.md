# pgvector similarity clustering — prototype result

**Date**: 2026-07-21
**Trigger**: memory-health cluster-density fired consistently. The decision rule
(AGENTS.md "Memory-Health Gate") prescribes: *"prototype pgvector similarity
first (cheapest win), re-measure."* This is that measurement.
**Verdict**: **PROMOTE.** Semantic clustering recovers substantial re-raise
signal that trigram — and the flat fingerprint-dedup — both miss.

## The question

The memory-health cluster-density metric uses `pg_trgm` (trigram) similarity on
`detail_snapshot`. Its blind spot: a real finding re-raised across rounds with
**different wording** gets a fresh fingerprint AND low trigram overlap, so it
neither dedups nor clusters — the churn signal leaks. Does semantic similarity
(cosine over `VECTOR(768)` Gemini embeddings) catch those same-meaning /
different-words re-raises?

## Method

`scripts/memory-pgvector-prototype.mjs` + the `finding_embeddings` table
(migration `20260721120000`). Over the **same** open-finding population the
memory-health metric clusters (30-day window, control-markers excluded,
dismissed/fixed excluded, 200-most-recent cap):

1. Embed each `detail_snapshot` (Gemini `gemini-embedding-001`, dim 768,
   secret-redacted by `embedText`).
2. Count cross-fingerprint pairs under trigram (>0.5) and cosine (0.80/0.85/0.90).
3. Cross-tabulate: pairs semantic catches that trigram **misses**, and vice versa.

Run: `Lbstrydom/claude-engineering-skills`, 200 findings, 19 900 candidate pairs.

## Result

| Cosine τ | semantic pairs | **sem ∧ ¬trg** (trigram misses) | trg ∧ ¬sem |
|---|---|---|---|
| 0.80 | 227 | 206 | 0 |
| **0.85** | **96** | **75** | **0** |
| 0.90 | 40 | 21 | 2 |

Trigram baseline (the live metric): **21** similar-pairs.

At **cos > 0.85, semantic is a strict superset of trigram** (nothing trigram
finds is missed) while catching **75 additional genuine re-raise pairs** — 3.5×
the trigram signal. Every sampled `sem ∧ ¬trg` pair was same-file and a genuine
reword. Examples (cos / trg):

- **0.965 / 0.498** — ``scripts/security-triage.mjs` is absent. The present
  Phase-1/2 modules export the planned libra…` vs `The planned CLI file
  `scripts/security-triage.mjs` does not exist. The present Phase 1/2 module…`
- **0.951 / 0.474** — two wordings of the `tests/gate-contract-ratchet.test.mjs`
  absent finding.
- **0.934 / 0.482** — ``familyOfFinding()` lowercases `finding.property`…`
  (code-quoted) vs `familyOfFinding lowercases finding.property…` (prose).

Trigram sits *just under* its 0.5 cutoff on these (~0.47–0.50) precisely because
the wording differs; cosine sees they mean the same thing.

## Interpretation

The cluster-density AMBER was reading a **real** signal — finding-churn — and
trigram was *under*-counting it, not over-counting it. Semantic clustering makes
the churn measurable: ~75 of the open findings on this repo are reworded
re-raises of an existing finding that neither the fingerprint nor the trigram
metric collapses.

`cos ≈ 0.85` is the promising operating point (superset of trigram, high
recall, examples all genuine). `0.80` catches 206 more but risks over-clustering
topically-related-but-distinct findings; `0.90` starts missing 2 trigram pairs.

## Recommended next step (promotion — separate change)

Not built here (a prototype measures; it doesn't ship a gate). The promotion:

1. **Threshold calibration on a labeled sample** — hand-label ~50 `sem ∧ ¬trg`
   pairs as genuine-reraise vs distinct, pick τ maximising precision at high
   recall. The examples suggest 0.85 but the metric shouldn't gate on an
   unlabeled guess (the same rigor the trigram thresholds got).
2. **A `finding_semantic_clusters` RPC** mirroring `memory_health_metrics`, and a
   new trigger metric (semantic cluster density) alongside — or replacing — the
   trigram one.
3. **Embedding freshness** — `finding_embeddings.snapshot_hash` already re-embeds
   only on change; the promotion wires embedding into the finalize path so it's
   not a separate batch.
4. **Dedup application** — the higher-value use: at raise time, suppress a
   finding whose embedding is cos > τ to an open finding (semantic re-raise
   suppression), closing the churn at the source rather than only measuring it.

## Artifacts

- `supabase/migrations/20260721120000_finding_embeddings_prototype.sql`
- `scripts/memory-pgvector-prototype.mjs` (re-runnable: `node
  scripts/memory-pgvector-prototype.mjs --repo <name>`; idempotent embeds)

## PROMOTED — semantic re-raise suppression (2026-07-21)

The prototype's recommended highest-value use is built and validated.

- **`scripts/lib/audit/semantic-suppression.mjs`** — the pure core: `cosine`,
  `decideReRaise` (the conservative suppress/keep decision), `greedyReRaiseClusters`
  (oldest-is-canonical, order-independent), and `nearestOpenReRaise` (the pgvector
  `<=>` store query). Guarded by `tests/semantic-suppression.test.mjs` (10 cases).
- **`scripts/semantic-suppress.mjs`** — the RETROSPECTIVE reconciler. Embeds open
  findings, clusters same-file cosine re-raises, KEEPS the oldest canonical, and
  dismisses the reworded repeats (`semantic-duplicate` ruling). **Dry-run by
  default; `--apply` mutates; every dismissal names its canonical and is verified
  against the store.**
- **`semanticSuppressConfig`** (config.mjs) — the prospective (record-time) hook's
  switches: `enabled` (OFF by default), `threshold` (0.92 — deliberately far above
  the 0.85 used for *measuring*, because a false suppression drops a store row),
  `requireSameFile` (the biggest false-suppression guard).

**What it dedups, and what it does NOT.** It removes the redundant *learning-store
row*; it never hides the finding from the audit's own user-facing report. A false
suppression costs a duplicate row, never a missed bug — that asymmetry is the
whole safety argument.

**Validation (real data).** wine-cellar: 2 clusters / 3 dupes (`_parseSessionId`
`Number.parseInt` in three wordings; the migration selector in two).
claude-engineering-skills: `--apply` dismissed 23 reworded re-raises across 17
clusters (the security-triage planned-file-absent churn), keeping 17 canonicals.
Cluster-density median 13.5 → 5.5; the source repo fell to 4 pairs, **below the
threshold of 5** — the AMBER cleared where suppression ran, honestly (canonicals
kept, only reworded repeats removed).

**Deferred (the validation-before-default convention).** The prospective
record-time hook — wiring `nearestOpenReRaise` into the finding-record path so a
new run never *writes* a duplicate — is left OFF (`semanticSuppressConfig.enabled`)
until the reconciler's results are trusted across more repos, exactly as the
tiered pipeline shipped off and shadow-validated before any flip. The core it
needs (`nearestOpenReRaise` + `decideReRaise`) is built and tested here.
