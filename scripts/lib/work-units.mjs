/**
 * @fileoverview Work units — group open findings into things a refactor can
 * actually be pointed at.
 *
 * WHY (measured 2026-08-13). `/ship`'s unremediated-acceptance gate reported
 * **132 rows over 99 distinct `category` strings** for this repo. The category
 * field is very nearly a unique key, so it cannot group anything — yet the
 * meaning IS there: "Error swallowing", "Missing error handling", "Missing Error
 * Handling" and "Error misclassification" are one theme spelled four ways, and
 * two of those differ only in case. A backlog you cannot group is a backlog you
 * work one row at a time, which is why 24 distinct HIGH defects read as 26
 * unrelated obligations.
 *
 * THE SPLIT THAT MAKES THIS SAFE — membership is deterministic, only the LABEL
 * may come from a model:
 *
 *   - **Membership** (which findings are in a unit) is embedding cosine with a
 *     cutoff derived from the repo's own distribution. It must be reproducible,
 *     because the unit key is what you filter, count and diff on. An LLM
 *     deciding membership would mean "work off unit X" names a different set
 *     tomorrow — unusable, and it would move work between units invisibly.
 *   - **The label** is presentation. `Coupling concern` — the modal category
 *     here, 14 rows — is useless as a work-unit name, and no deterministic
 *     normaliser produces a good one across a Node repo, a Django repo and a
 *     Rails repo. That is exactly the job a small model call is good at, and a
 *     wrong label costs a re-render, never a misplaced obligation.
 *
 * This mirrors `arch:refresh`, which puts LLM per-domain prose on top of a
 * deterministic symbol index — and is why `docs/architecture-map.md` is
 * gitignored Category A. Same shape, same classification: the structure is
 * reproducible, the prose is not.
 *
 * NO FIXED COSINE CONSTANT. The cutoff is `μ + kσ` over THIS repo's own
 * same-population similarity background. A hard-coded threshold is a property of
 * corpus × summary style × embedding model, not of the tool — and this tooling
 * syncs into other repos. The architectural-memory bands shipped fixed cutoffs
 * (`reuse ≥0.90 / extend ≥0.85 / justify-divergence ≥0.75`) and fired **zero
 * times in 1,763 consultations** because this pipeline tops out near 0.83. That
 * defect is not repeated here.
 *
 * ABSENCE IS NOT MEMBERSHIP. A finding with no embedding is `unclustered` — it
 * was never compared. It is never folded into a unit and never silently
 * dropped, and the caller is told how many there are, because a group listing
 * that omits them reads as complete.
 *
 * @module scripts/lib/work-units
 */

import { createHash } from 'node:crypto';
import { cosine, greedyReRaiseClusters } from './semantic-suppression.mjs';

/** Standard deviations above the mean that make a pair "the same work". */
export const DEFAULT_CUTOFF_SIGMA = 2;

/**
 * Floor the derived cutoff can never fall below.
 *
 * Not a magic threshold — a degenerate-input guard. A population whose pairwise
 * similarities are almost all identical produces σ≈0, and `μ + kσ` then collapses
 * to roughly μ, which would merge the entire backlog into one "work unit". The
 * floor makes that failure mode inert rather than catastrophic; it binds only
 * when the distribution carries no signal, and `cutoffSource` reports when it did.
 */
export const CUTOFF_FLOOR = 0.5;

/**
 * Derive the similarity cutoff from the population's OWN pairwise distribution.
 *
 * @param {number[]} similarities - pairwise cosines (finite values only)
 * @param {{sigma?: number}} [opts]
 * @returns {{cutoff: number, mean: number, stdev: number, samples: number, source: string}}
 */
export function deriveCutoff(similarities, { sigma = DEFAULT_CUTOFF_SIGMA } = {}) {
  const xs = similarities.filter(Number.isFinite);
  // Two points define no spread; anything less than a handful of pairs gives a
  // σ that is noise. Say so rather than inventing a cutoff from it.
  if (xs.length < 3) {
    return { cutoff: CUTOFF_FLOOR, mean: NaN, stdev: NaN, samples: xs.length, source: 'insufficient-samples' };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  const stdev = Math.sqrt(variance);
  const raw = mean + sigma * stdev;
  const cutoff = Math.max(CUTOFF_FLOOR, Math.min(0.999, raw));
  return {
    cutoff,
    mean,
    stdev,
    samples: xs.length,
    source: raw < CUTOFF_FLOOR ? 'floored' : raw > 0.999 ? 'ceilinged' : 'derived',
  };
}

/** Every pairwise cosine in the population (upper triangle). */
export function pairwiseSimilarities(findings) {
  const out = [];
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const c = cosine(findings[i].embedding, findings[j].embedding);
      if (Number.isFinite(c)) out.push(c);
    }
  }
  return out;
}

/**
 * Stable identity for a work unit: a hash of its SORTED member ids.
 *
 * Keyed on membership, not on the canonical or the label, for two reasons that
 * both matter downstream. It is order-independent, so two runs over the same set
 * agree; and it CHANGES when membership changes, which is precisely the signal a
 * label cache needs to know it is stale. A key derived from the canonical alone
 * would silently keep a label describing a unit that has since grown.
 *
 * @param {string[]} memberIds
 * @returns {string} 16 hex chars
 */
export function workUnitKey(memberIds) {
  const sorted = [...memberIds].map(String).sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Group findings into work units.
 *
 * Delegates membership to `greedyReRaiseClusters` — the architectural-memory
 * consultation banded it `precedent/above-floor-standout` for this intent, and a
 * second clusterer would be a second oracle for "are these the same issue".
 * The only policy this adds is `requireSameFile: false`: suppression is a
 * same-file question ("is this row a reword of that row"), whereas a refactor
 * unit is deliberately cross-file — "store writes that swallow failures" spans
 * `sync-inventory`, `plans-ship` and `stage0-relevance-context`, and grouping it
 * per-file would hide exactly the shape worth fixing in one pass.
 *
 * @param {Array<{id:string, primaryFile?:string, createdAt?:string|number, embedding?:number[], category?:string}>} findings
 * @param {{sigma?: number, cutoff?: number}} [opts] - `cutoff` overrides derivation (tests)
 * @returns {{units: Array<object>, unclustered: object[], cutoff: object}}
 */
export function clusterWorkUnits(findings, { sigma = DEFAULT_CUTOFF_SIGMA, cutoff = null } = {}) {
  const embedded = findings.filter((f) => Array.isArray(f.embedding) && f.embedding.length > 0);
  // Absence of evidence: these were never compared to anything. Reported, never merged.
  const unclustered = findings.filter((f) => !Array.isArray(f.embedding) || f.embedding.length === 0);

  if (embedded.length === 0) {
    return { units: [], unclustered, cutoff: { cutoff: NaN, samples: 0, source: 'no-embeddings' } };
  }

  const derived = cutoff != null
    ? { cutoff, mean: NaN, stdev: NaN, samples: NaN, source: 'caller-supplied' }
    : deriveCutoff(pairwiseSimilarities(embedded), { sigma });

  const clusters = greedyReRaiseClusters(embedded, {
    threshold: derived.cutoff,
    requireSameFile: false,
  });

  const units = clusters.map((c) => {
    const members = [c.canonical, ...c.duplicates];
    const files = [...new Set(members.map((m) => m.primaryFile).filter(Boolean))].sort();
    return {
      key: workUnitKey(members.map((m) => m.id)),
      canonicalId: c.canonical.id,
      size: members.length,
      members,
      files,
      // The deterministic fallback label. `deriveWorkUnitLabels` replaces this
      // with a model-written one when available; it is never blocked on that.
      label: c.canonical.category || files[0] || 'unlabelled',
      labelSource: 'category',
    };
  }).sort((a, b) => b.size - a.size || (a.key < b.key ? -1 : 1));

  return { units, unclustered, cutoff: derived };
}
