/**
 * @fileoverview Stratified sampling + known-defect candidate matching for the
 * MEDIUM-severity adjudication tier (audit-effectiveness experiment, Phase 4).
 *
 * Full HIGH-only adjudication is methodologically biased (both external models
 * in `/brainstorm --with-gemini`, 2026-07-06, independently rejected it): the
 * solo arms emit ~2.3x the apparatus's MEDIUM volume, so excluding MEDIUM hides
 * exactly the tier where arm discipline differs most. But full HIGH+MEDIUM
 * (~1930 clusters) is too large for one human. The converged design: full HIGH
 * (unchanged) + ALL known-defect candidates at ANY severity (recall-biased —
 * protects the one ground-truth metric from a severity cutoff) + a stratified,
 * capped, seeded sample of the remaining MEDIUM-only clusters, with inclusion
 * probabilities persisted so scoring.mjs can Horvitz-Thompson-weight the sample
 * back to a population estimate with an honest confidence interval.
 *
 * Plan: docs/plans/audit-effectiveness-experiment.md (Phase 4, §12.1/§12.2).
 *
 * @module scripts/lib/solo-control/stratified-sample
 */

import { mulberry32, seededShuffleCopy } from '../rng.mjs';

/**
 * Does `finding` (commit + file) plausibly match a known defect? RECALL-BIASED
 * by design: matches on commit + file-path overlap ONLY — not category, not
 * severity, not text similarity. Cast wide; the human dismisses a false-positive
 * candidate in seconds during adjudication, but a missed true match silently
 * corrupts the one metric with real ground truth (known-defect recall).
 *
 * @param {{commit:string, file?:string}} finding
 * @param {Array<{id:string, buggyCommit:string, files:string[]}>} knownDefects
 * @returns {string|null} the matching KD id, or null.
 */
export function matchesKnownDefect(finding, knownDefects) {
  const ffile = String(finding.file || '').replace(/\\/g, '/');
  for (const kd of knownDefects || []) {
    if (finding.commit !== kd.buggyCommit) continue;
    for (const kf of kd.files || []) {
      const kfile = String(kf).replace(/\\/g, '/');
      if (ffile === kfile || ffile.endsWith(`/${kfile}`) || kfile.endsWith(`/${ffile}`)) return kd.id;
    }
  }
  return null;
}

/**
 * Stratified, capped, seeded sample of MEDIUM-only clusters (clusters with NO
 * high/kd-candidate member — those are already auto-included on the sheet by
 * the caller). Strata = (commit, multiArm): the commit dimension prevents one
 * large commit from dominating the sample budget (found live: a single 361K-char
 * commit contributed ~30% of all clusters); the multiArm dimension (found-by-
 * multiple-arms "consensus" clusters vs single-arm "solo-only" clusters) is kept
 * separately represented because it's exactly the axis the noise-flooding-vs-
 * discipline question turns on.
 *
 * @param {Array<{clusterKey:string, commit:string, arms:Set<string>}>} clusters
 * @param {{targetSize:number, capFraction?:number, seed:number}} opts
 * @returns {Map<string, {commit:string, multiArm:boolean, inclusionProb:number}>}
 *   sampled cluster key -> stratum + inclusion probability (for HT weighting).
 */
export function stratifiedMediumSample(clusters, { targetSize, capFraction = 0.15, seed }) {
  if (!Array.isArray(clusters) || clusters.length === 0 || !(targetSize > 0)) return new Map();
  const rng = mulberry32(seed >>> 0);
  const capPerCommit = Math.max(1, Math.ceil(targetSize * capFraction));

  const byCommit = new Map();
  for (const c of clusters) {
    if (!byCommit.has(c.commit)) byCommit.set(c.commit, []);
    byCommit.get(c.commit).push(c);
  }

  // Proportional allocation with a per-commit cap, then true up to EXACTLY
  // min(targetSize, total) in both directions — rounding can both undershoot
  // (capped-away shortfall, redistributed over commits with headroom) AND
  // overshoot (each commit's Math.round() can independently round up, summing
  // past target even though no single commit exceeded its cap). Simple
  // largest-remainder-style 2-pass in each direction — sufficient at the scale
  // this runs at (a handful to a few dozen commits); "transparent sampling
  // probabilities, not classical elegance" per the brainstorm's own framing.
  const commits = [...byCommit.keys()];
  const total = clusters.length;
  const targetTotal = Math.min(targetSize, total);
  const alloc = new Map(commits.map((c) => {
    const avail = byCommit.get(c).length;
    return [c, Math.min(avail, capPerCommit, Math.round((avail / total) * targetSize))];
  }));
  let allocatedSum = [...alloc.values()].reduce((a, b) => a + b, 0);
  let shortfall = targetTotal - allocatedSum;
  let guard = 0;
  while (shortfall > 0 && guard++ < 50) {
    const room = commits
      .map((c) => ({ c, room: Math.min(byCommit.get(c).length, capPerCommit) - alloc.get(c) }))
      .filter((x) => x.room > 0)
      .sort((a, b) => b.room - a.room);
    if (room.length === 0) break;
    for (const { c } of room) {
      if (shortfall <= 0) break;
      alloc.set(c, alloc.get(c) + 1);
      shortfall--;
    }
  }
  let overshoot = -shortfall; // shortfall went negative → allocatedSum (post-redistribution) exceeds target
  guard = 0;
  while (overshoot > 0 && guard++ < 50) {
    const trimmable = commits
      .map((c) => ({ c, n: alloc.get(c) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n); // trim from the largest allocations first
    if (trimmable.length === 0) break;
    for (const { c } of trimmable) {
      if (overshoot <= 0) break;
      alloc.set(c, alloc.get(c) - 1);
      overshoot--;
    }
  }

  const sampled = new Map();
  for (const c of commits) {
    const pool = byCommit.get(c);
    const n = alloc.get(c) || 0;
    if (n === 0) continue;
    const multi = pool.filter((x) => x.arms.size > 1);
    const single = pool.filter((x) => x.arms.size <= 1);
    const nMulti = multi.length > 0 ? Math.max(1, Math.round(n * (multi.length / pool.length))) : 0;
    const nSingle = Math.max(0, n - nMulti);
    for (const [stratumPool, stratumN, multiArm] of [[multi, Math.min(nMulti, multi.length), true], [single, Math.min(nSingle, single.length), false]]) {
      if (stratumN <= 0 || stratumPool.length === 0) continue;
      const picked = seededShuffleCopy(stratumPool, rng).slice(0, stratumN);
      const inclusionProb = picked.length / stratumPool.length;
      for (const p of picked) sampled.set(p.clusterKey, { commit: c, multiArm, inclusionProb });
    }
  }
  return sampled;
}
