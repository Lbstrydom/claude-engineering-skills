/**
 * @fileoverview Pure helpers for the symbol-index pipeline.
 * No I/O, no DB, no LLM. Imported by extract / summarise / embed / refresh
 * and by tests.
 *
 * @module scripts/lib/symbol-index
 */

import crypto from 'node:crypto';

/**
 * Normalise a symbol signature so trivial whitespace / formatting changes
 * don't perturb the hash.
 *
 * @param {string} signature
 * @returns {string}
 */
export function normaliseSignature(signature) {
  if (!signature) return '';
  return String(signature)
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}(),;:=])\s*/g, '$1')
    .trim();
}

/**
 * Normalise a body text so cosmetic whitespace + comment-only edits don't
 * trigger re-summarisation.
 *
 * @param {string} bodyText
 * @returns {string}
 */
export function normaliseBody(bodyText) {
  if (!bodyText) return '';
  return String(bodyText)
    // Strip block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Strip line comments (best-effort; doesn't handle URLs gracefully but ok for hash purposes)
    .replace(/^[ \t]*\/\/.*$/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute the cache-key hash for a symbol. Composes name + normalised
 * signature + sha256(normalised body) per R1 M1 fix.
 *
 * @param {{symbolName: string, signature: string, bodyText: string}} input
 * @returns {string} hex sha256
 */
export function signatureHash({ symbolName, signature, bodyText }) {
  const normSig = normaliseSignature(signature);
  const normBody = normaliseBody(bodyText);
  const bodyHash = crypto.createHash('sha256').update(normBody).digest('hex');
  return crypto
    .createHash('sha256')
    .update(`${symbolName}|${normSig}|${bodyHash}`)
    .digest('hex');
}

/**
 * The exact template `compose()` emits. Kept as a named constant so
 * COMPOSE_VERSION can hash it — see below.
 *
 * SHAPE: `<kind> <symbolName>\n<purposeSummary>`
 *
 * The file path and signature were REMOVED (2026-07-20, measured). They are
 * not natural language, and a query is compared against this whole string, so
 * they dilute the semantic signal the summary carries. Measured over four
 * probe symbols, mean cosine of a normalized intent against its own symbol:
 *
 *   `<kind> <name> in <path>\n<summary>\n<signature>`  (old)   0.7401
 *   `<summary>` alone                                          0.7970
 *   `<kind> <name>\n<summary>`                        (this)   0.7944
 *   `<summary>\n<signature>`                                   0.7590
 *
 * Summary-alone scored a marginal 0.0026 higher on intent queries, but it
 * DISCARDS the symbol name, and name-based lookup is a real use case this
 * index serves. Measured on "atomicWriteFileSync" / "where is
 * atomicWriteFileSync defined" / "the atomicWriteFileSync helper", keeping the
 * name is worth +0.06–0.08 (0.7544–0.7821 → 0.8140–0.8583) at a cost of
 * 0.0026 on intent queries. Keeping the name is the right trade.
 *
 * CAVEAT (honest): hard-negative similarity also rises under this template
 * (+~0.036 mean) alongside positives (+0.054), so the net separation gain is
 * roughly +0.018 — real but modest. The template fix is NOT a substitute for
 * the query-side genre normalization, which carries the dominant term.
 *
 * Moved here (was a local, unexported function in `embed.mjs`) so
 * `duplication-detector.mjs` can reuse the EXACT composition indexed symbols
 * were embedded with, without importing `embed.mjs` itself — `embed.mjs` is a
 * CLI entry point with an unconditional top-level `main()` call (reads stdin),
 * so importing it as a module for one pure function would trigger that CLI
 * behaviour as a side effect.
 *
 * @param {{kind:string, symbolName:string, purposeSummary?:string}} s
 * @returns {string}
 */
export function compose(s) {
  const summary = s.purposeSummary || '';
  return `${s.kind} ${s.symbolName}\n${summary}`;
}

/**
 * Content hash of the composition template (plan §2.1 C6).
 *
 * This is deliberately NOT a hand-bumped constant. Any edit to `compose()`
 * changes the text every embedding is built from, which silently invalidates
 * both the cached query vectors and any band calibration derived against the
 * old distribution. Hashing the function source makes that mechanical: change
 * the template, and the version changes with it, with no human in the loop.
 *
 * The two values this binds together — the composition and the thresholds
 * calibrated against it — previously sat ~70 lines apart in this file with
 * nothing connecting them. Two coupled values drifting apart with nothing
 * enforcing the link is the exact defect the recalibration plan exists to fix;
 * re-introducing a "remember to bump this" convention would rebuild it one
 * layer up.
 */
export const COMPOSE_VERSION = crypto.createHash('sha256')
  .update(compose.toString())
  .digest('hex')
  .slice(0, 12);

/**
 * Chunk an array into batches of size `n`.
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[][]}
 */
export function chunkBatches(arr, n) {
  if (!Array.isArray(arr) || n <= 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 * Returns 0 for null/empty/length-mismatched inputs.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Node-side neighbourhood ranking — fallback when the RPC isn't available
 * (e.g. cloud-off mode in tests). Combines hop_score (paths) with cosine
 * similarity (intent embedding).
 *
 * @param {object[]} records - each {filePath, embedding, ...rest}
 * @param {number[]} intentEmbedding
 * @param {string[]} targetPaths
 * @param {number} k
 * @returns {object[]} top-k records with `score`, `hopScore`, `similarityScore`
 */
export function rankNeighbourhood(records, intentEmbedding, targetPaths, k = 50) {
  const targets = new Set((targetPaths || []).map(s => String(s).replace(/\\/g, '/')));
  const scored = records.map(r => {
    const filePath = String(r.filePath || '').replace(/\\/g, '/');
    const hopScore = targets.has(filePath) ? 1.0 : 0.0;

    // MUST mirror the RPC's null contract (plan §2.1 C3). This is a SECOND,
    // in-process implementation of the same formula, and it reproduced the
    // identical `ELSE 0` defect: an absent embedding degraded to an empty
    // vector, `cosineSimilarity` returned 0, and that fabricated 0 flowed into
    // banding as an authoritative "considered and rejected" verdict. Fixing
    // only the SQL would have left the bug live on this path.
    const hasEmbedding = Array.isArray(r.embedding) && r.embedding.length > 0
      && Array.isArray(intentEmbedding) && intentEmbedding.length > 0;
    const similarityScore = hasEmbedding
      ? cosineSimilarity(r.embedding, intentEmbedding)
      : null;

    // Ranking coalesces; banding does not. See the migration comment for why
    // the two jobs must not share one number.
    const rankingScore = hopScore * 0.4 + (similarityScore ?? 0) * 0.6;
    return { ...r, hopScore, similarityScore, scored: hasEmbedding, score: rankingScore, rankingScore };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.symbolName || '').localeCompare(String(b.symbolName || ''));
  });
  return scored.slice(0, k);
}

/**
 * REMOVED 2026-07-20: `recommendationFromSimilarity(similarity)`.
 *
 * It mapped a score onto `reuse` (≥0.90) / `extend` (≥0.85) /
 * `justify-divergence` (≥0.75) / `review`. Those cutoffs were unreachable —
 * the highest similarity this pipeline has ever produced is 0.8294 — which is
 * why the consultation returned `review` for all 1,763 of its decisions.
 *
 * Banding now lives in `arch-memory/background-calibration.mjs::bandTopResult`,
 * against a floor computed PER REPO from that repo's own embedding background
 * (μ+3σ), because a threshold is a property of the corpus rather than of the
 * tool — and this file syncs to every consumer.
 *
 * Deleted rather than deprecated on purpose. A function that still returns
 * `reuse`/`extend` — bands the system can no longer emit — is precisely the
 * kind of plausible-looking artifact that caused the original defect: someone
 * would call it, get a confident answer, and never learn it was fiction. The
 * import is gone from `neighbourhood-query.mjs`; git history is the archive.
 */
