/**
 * @fileoverview Per-repo, unsupervised band calibration from the repo's OWN index.
 *
 * Plan: docs/plans/arch-memory-band-recalibration.md §2.1 C4-REVISED / C7-REVISED.
 *
 * WHY THIS EXISTS. The bands were hardcoded at 0.90/0.85/0.75 and never fired
 * once in 1,763 consultations — they were unreachable for the actual pipeline.
 * The obvious fix, deriving better numbers from our labelled probe set, would
 * have repeated the mistake: `scripts/lib/config.mjs` and `symbol-index.mjs`
 * are BOTH synced to consumer repos, so a derived `0.73` would ship a constant
 * calibrated against this repo (3,478 Node-CLI symbols, terse Haiku summaries)
 * to a wine app with entirely different vocabulary and symbol density.
 *
 * A threshold is not a property of the tool. It is a property of
 *   repo corpus × summary style × embedding model × compose template × normalizer.
 *
 * So the FORMULA ships and the VALUE is computed per repo:
 *
 *   floor = μ + kσ  over pairwise cosine similarity of a random sample of the
 *                   repo's own symbol embeddings
 *
 * A dense, repetitive corpus has a high μ and its bar rises automatically; a
 * diverse one gets a lower bar. No labelled probes required.
 *
 * VALIDATED BEFORE ADOPTION on the one repo that could falsify it:
 *   supervised   p95 of hard-negative best-hits (10 authored probes) → 0.7162
 *   unsupervised μ+3σ over 7,140 background pairs (120 symbols)      → 0.7146
 * Agreement to 0.0016 (0.2%). Caveat recorded rather than glossed: both share
 * the embedding model and corpus, so this is partial corroboration, not
 * independent confirmation.
 *
 * K IS EMPIRICAL, NOT CONVENTIONAL. μ+4σ = 0.7584 on this repo, ABOVE the
 * observed true-positive range (0.73–0.83) — it would suppress real matches.
 * Do not raise DEFAULT_K because 4 feels safer.
 *
 * WHAT THIS CANNOT DO. An unsupervised floor establishes where scores stop
 * being noise. It cannot establish semantic correctness: a score distribution
 * holds no ground truth about whether an intent SHOULD map to a symbol. So the
 * floor licenses "worth a look", never "this is the right symbol" — which is
 * why the bands collapse to `precedent` rather than reuse/extend (C7-REVISED).
 *
 * @module scripts/lib/arch-memory/background-calibration
 */

/** Empirically chosen — see the k-sensitivity note above. */
export const DEFAULT_K = 3;

/** How many symbol vectors to sample. n(n-1)/2 pairs, so 120 → 7,140. */
export const DEFAULT_SAMPLE_SIZE = 120;

/**
 * The gap between the best and second-best hit. REPORTED, NOT GATED.
 *
 * It was originally a second gate: a match had to be above the floor AND
 * distinctive, on the reasoning that cosine suffers hubness — in a repo where
 * every symbol says "wine", an absolute 0.72 may be background.
 *
 * THE LIVE RUN FALSIFIED THAT for this application. Querying "add a function
 * that finds similar existing symbols" returned 0.8480 / 0.8370 / 0.8086 —
 * three genuinely related symbols — and the cliff test rejected the top hit as
 * `not-distinctive` because the runner-up was 0.011 behind.
 *
 * That inverts the use case. This is a DUPLICATION DETECTOR: several similar
 * symbols existing is the STRONGEST reuse signal, not the weakest. A cliff
 * gate systematically suppresses exactly the clusters the tool exists to find.
 *
 * The hubness concern it was meant to address is already covered by the floor:
 * when everything in a corpus is similar, μ rises and μ+kσ rises with it. The
 * floor IS the hubness guard, making the cliff redundant as well as harmful.
 *
 * Retained as reported metadata because it is genuinely informative to a
 * reader — a lone standout and a tight cluster are different situations, even
 * though both are actionable.
 */
export const CLIFF_REPORTING_THRESHOLD = 0.03;

/**
 * How close a below-floor score must be to the floor to count as a
 * near-miss rather than a clear miss (arch-audit-pipeline-observability-
 * hardening.md item 8 / this plan's own C5, "review is split, not
 * flattened"). C5's original design pre-dated C7-REVISED's retirement of
 * `reuse`/`extend`/`justify-divergence` and was never carried forward onto
 * the single-floor model that replaced it (Implementation Log, 2026-07-20:
 * "the floor-relative equivalent is unbuilt") — every below-floor score
 * collapsed to one identical `below-noise-floor` reason regardless of
 * distance, discarding exactly the near-miss evidence that motivated C5.
 * The 0.05 margin is the value C5's own table used for `review-near`.
 */
export const NEAR_FLOOR_MARGIN = 0.05;

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Background similarity statistics over a sample of the repo's own embeddings.
 *
 * Returns `null` (never a fabricated zero) when there is not enough data to say
 * anything — the caller must treat that as "uncalibrated", not as "floor 0".
 *
 * @param {number[][]} vectors
 * @returns {{mean:number, sd:number, n:number, pairs:number, p50:number, p95:number, p99:number, max:number}|null}
 */
export function computeBackgroundStats(vectors) {
  const vecs = (vectors || []).filter(v => Array.isArray(v) && v.length > 0);
  // Two vectors give one pair — nowhere near enough to estimate a spread.
  if (vecs.length < 20) return null;

  const sims = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const s = cosineSimilarity(vecs[i], vecs[j]);
      if (Number.isFinite(s)) sims.push(s);
    }
  }
  if (sims.length < 100) return null;

  sims.sort((a, b) => a - b);
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length);
  const q = (p) => sims[Math.min(sims.length - 1, Math.floor(p * sims.length))];

  return {
    mean, sd,
    n: vecs.length,
    pairs: sims.length,
    p50: q(0.50), p95: q(0.95), p99: q(0.99),
    max: sims[sims.length - 1],
  };
}

/**
 * The noise floor for this repo. `null` stats → `null` floor → uncalibrated.
 * @returns {number|null}
 */
export function floorFromStats(stats, k = DEFAULT_K) {
  if (!stats || !Number.isFinite(stats.mean) || !Number.isFinite(stats.sd)) return null;
  if (!Number.isFinite(k) || k <= 0) return null;
  return stats.mean + k * stats.sd;
}

/**
 * Band a ranked result set (C7-REVISED).
 *
 * TWO actionable states, not four. `reuse`/`extend` are retired: the derived
 * cutoffs were 0.01 apart against ~0.008 run-to-run variance, so a 0.724 would
 * be `reuse` on Tuesday and `extend` on Wednesday. The partition was also never
 * sound — whether to reuse unchanged or extend depends on dependency direction,
 * API shape, ownership and debt, none of which a cosine distance expresses.
 *
 * @param {{similarityScore:number|null}[]} ranked - descending by rank
 * @param {{floor:number|null, normalizationMode?:'llm'|'fallback'}} calibration
 * @returns {{band:'unscored'|'review'|'precedent', reason:string, cliff:number|null}}
 */
export function bandTopResult(ranked, calibration) {
  const rows = Array.isArray(ranked) ? ranked : [];
  const top = rows[0];

  if (!top || top.similarityScore === null || top.similarityScore === undefined
      || !Number.isFinite(top.similarityScore)) {
    return { band: 'unscored', reason: 'no-embedding', cliff: null };
  }

  // FALLBACK NORMALIZATION IS OUT OF CALIBRATION (plan §2.1 C4).
  //
  // When the LLM normalizer is unavailable — provider error, timeout, egress
  // refusal — the query falls back to `deterministicNormalize`, which is regex
  // munging rather than a rewrite. That produces a DIFFERENT text distribution
  // from the LLM-normalized text the floor was calibrated against, so scoring
  // one against the other compares across distributions.
  //
  // Measured on the same intent: fallback text scored 0.5828 where LLM
  // normalization scored 0.8446 — well below the ~0.71 floor, so in practice it
  // abstains anyway. But that is a property of the text happening to score
  // lower, NOT a guarantee. Without this cap nothing stops a fallback query
  // clearing the floor and emitting a confident `precedent` from a measurement
  // the calibration does not describe — the exact failure class this plan
  // exists to remove.
  //
  // The fallback is not hypothetical: the `cli` backend timed out repeatedly
  // before the normalizer pinned `{backend:'sdk'}`.
  if (calibration?.normalizationMode === 'fallback') {
    return { band: 'review', reason: 'fallback-normalization-uncalibrated', cliff: null };
  }

  const floor = calibration?.floor;
  if (floor === null || floor === undefined || !Number.isFinite(floor)) {
    // Uncalibrated is NOT a licence to guess. This is the honest default a
    // fresh consumer repo gets, and it matches the tool's behaviour before any
    // of this work — an accurate label rather than a fabricated verdict.
    return { band: 'review', reason: 'uncalibrated-repo', cliff: null };
  }

  const second = rows.find((r, i) => i > 0 && Number.isFinite(r?.similarityScore));
  const cliff = second ? top.similarityScore - second.similarityScore : null;

  if (top.similarityScore < floor) {
    // Floor-relative split (C5 / item 8): a score within NEAR_FLOOR_MARGIN of
    // the floor is a near-miss worth flagging distinctly from a clear miss —
    // both remain band:'review' (no consumer that switches on `band` alone
    // is affected), but `reason` now preserves the distinction a future
    // recalibration could use instead of discarding it into one bucket.
    const distanceBelowFloor = floor - top.similarityScore;
    // Epsilon guards the inclusive boundary against float subtraction noise
    // (e.g. 0.7146 - (0.7146 - 0.05) computes to 0.050000000000000044, not
    // exactly 0.05) — a score genuinely AT the margin must not flip to the
    // far bucket over a rounding artifact.
    const reason = distanceBelowFloor <= NEAR_FLOOR_MARGIN + 1e-9
      ? 'below-noise-floor-near'
      : 'below-noise-floor';
    return { band: 'review', reason, cliff, cluster: false };
  }

  // The floor is the ONLY gate. The cliff is reported, never gating — see
  // CLIFF_REPORTING_THRESHOLD for why gating on it suppressed the very
  // duplicate-clusters this tool exists to surface.
  const cluster = cliff !== null && cliff <= CLIFF_REPORTING_THRESHOLD;
  return {
    band: 'precedent',
    // A tight cluster is MORE actionable, not less: several existing symbols
    // occupy this space, so the case for reusing one of them is stronger.
    reason: cluster ? 'above-floor-cluster' : 'above-floor-standout',
    cliff,
    cluster,
  };
}
