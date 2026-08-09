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

- **`scripts/lib/semantic-suppression.mjs`** — the pure core: `cosine`,
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

**Prospective record-time hook — FLIPPED ON (2026-07-21).** After the
retrospective reconciler was validated on two repos (source + wine-cellar, the
cluster-density trigger returning GREEN), the record-time hook was wired into
`recordFindings` (the `merged` pass) and defaulted ON. It embeds each merged
finding, calls `nearestOpenReRaise`, and drops the ones that are a cosine
re-raise of an existing OPEN finding in another run — so a new audit never
*writes* the duplicate. Kept findings' embeddings are persisted (via the INSERT
`RETURNING`) so they become future match targets.

- **Fail-open end to end** — disabled, cloud-off, no embedding creds, or ANY
  error → every finding is recorded. Only a positive above-threshold same-file
  match suppresses, and only the redundant store row is dropped, never the
  audit's user-facing report.
- **Kill switch**: `AUDIT_SEMANTIC_SUPPRESS_ENABLED=false`.
- **Cost**: one Gemini embed per merged finding when on (~$0.01/round).
- **Live-verified**: a reworded copy of an open finding matched its canonical at
  cosine 0.949 and was suppressed; the DB integration suites pass (a fresh
  container has no embeddings → nothing matches → no interference).
- Guards unchanged: threshold 0.92 (vs 0.85 for measuring), same-file required.

---

# Clustering prototype — do the similar pairs form COMMUNITIES?

**Date**: 2026-08-08
**Trigger**: the memory-health gate became measurable again after the RPC perf
fix (it had been returning `spawn ETIMEDOUT` instead of a number), and its first
real reading fired cluster-density at median **25.5** against a threshold of 5.
**Verdict**: **PROMOTE — with a cohesion guard, not naive connected components.**

## Why this is a different question from the July prototype

The July run measured **pairs** and promoted pairwise re-raise *suppression*
(cos > 0.92, same-file). That is shipped and default-on. This asks the question
pairwise similarity cannot answer: *do those pairs form communities?*

It matters because the two have different payoffs. If the graph is disjoint
duos, pairwise suppression already captures the entire win and a cluster layer
is ceremony. If findings collapse into multi-member communities, then N findings
are one recurring issue, and only a cluster-aware memory can say so — a 10-member
re-raise cluster is not visible as "some pairs".

Run with `node scripts/memory-pgvector-prototype.mjs --clusters` (added here;
the pairwise pass is unchanged). Connected components over the cos > 0.85 graph,
measuring only — a prototype that writes to the store is a promotion.

## Result (cos > 0.85, 200 most-recent open findings per repo)

| | this repo | a private consumer repo |
|---|---|---|
| edges | 32 | 123 |
| components (size > 1) | 17 | 21 |
| findings inside a component | 42 | 82 |
| **collapse ratio** | **2.47 findings/issue** | **3.90 findings/issue** |
| size histogram | 2×10, 3×6, 4×1 | 2×13, 3×3, 4×2, 8×1, 10×1, **21×1** |

Community structure is real and substantial. Examples that are unambiguously one
issue told several ways:

- **4 findings**, 100% of internal pairs linked, minCos 0.857, one file — the
  sync entry-point inventory being duplicated, described four ways.
- **3 findings**, 100% linked, minCos 0.873 — `parseSkill` doing too much,
  described three ways ("exceeds the 50-line guideline" / "roughly 145 lines" /
  "combines filesystem access, newline normalization, YAML parsing").
- **10 findings**, one file — `app.js` is too large, re-raised ten times across
  runs in different words.

## The two failure modes, both caught by measuring cohesion

Connected components **chain** by construction: A~B and B~C put A and C in one
component even when A≁C. That is why every component is reported with the
fraction of its internal pairs that are actually linked, and with `minCos`.
Without it the numbers above would look like 21 clean clusters.

1. **Chaining.** The consumer's largest component is **21 findings at 22%
   density across 21 distinct files** — not one issue. It is a chain through
   "the planned file X is absent" findings.
2. **Template similarity.** Findings whose prose is generated from a template
   cluster on the *template*, not the content. A 3-member component here spans
   three unrelated files and is entirely the adjacency wave's formulaic sentence
   ("X sits inside the `if` at Y…"). These are three genuine, distinct findings
   that merely share boilerplate.

Template similarity is the same family as the control-marker defect migration
`20260720210000` fixed, one level subtler: there the text was byte-identical
machine output, here it is real findings wearing a uniform. **The gate is
already protected from it** — `memory_health_semantic_cluster` requires
same-`primary_file`, which excludes cross-file template matches. This prototype
deliberately dropped that constraint, which is how the failure mode became
visible.

Note the constraint is necessary but not sufficient: the 10-member `app.js`
cluster is same-file at only 40% density and IS one real issue, while the
8-member React-island cluster is 100% dense across 7 files and is also one real
issue. Density alone does not decide; density plus file scope plus a look at the
text does.

## Verdict and recommended next step

The AMBER is real, and a cluster layer buys something pairwise suppression does
not: it names the **~4-findings-to-1-issue** collapse. But naive connected
components at 0.85 is not the production algorithm — it produced a 21-member
blob at 22% density on the first real dataset.

If this is promoted, the shape should be:

1. **Cohesion-guarded components** — reject or split any component below a
   density floor rather than reporting it as an issue. The floor wants
   calibrating on labelled examples, not guessing; note that 40% density was a
   TRUE cluster here, so the floor is not simply "high".
2. **Keep the same-file scope** the suppression and the gate already use, and
   treat cross-file clusters as a separate, lower-confidence class.
3. **Do not raise τ to fix chaining.** At 0.90 the July run already lost 2 real
   trigram pairs; chaining is a topology problem, not a threshold problem.

**Not promoted here, deliberately.** The decision rule is "1 trigger for 2
consecutive weeks → prototype (done); 2+ triggers → build the full pipeline". One
trigger is firing and this is its first *measurable* week — the earlier readings
were a timing-out RPC, not evidence. The honest next step is a second reading
next Monday, not a pipeline built on a single data point.

## Artifacts

- `scripts/memory-pgvector-prototype.mjs --clusters` (re-runnable, read-only)
