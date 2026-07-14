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
 * Build a stable text representation for embedding: identity + summary +
 * signature. Moved here (was a local, unexported function in `embed.mjs`)
 * so `duplication-detector.mjs` can reuse the EXACT composition indexed
 * symbols were embedded with, without importing `embed.mjs` itself —
 * `embed.mjs` is a CLI entry point with an unconditional top-level
 * `main()` call (reads stdin), so importing it as a module for one pure
 * function would trigger that CLI behaviour as a side effect.
 *
 * @param {{kind:string, symbolName:string, filePath:string, purposeSummary?:string, signature?:string}} s
 * @returns {string}
 */
export function compose(s) {
  const summary = s.purposeSummary || '';
  return `${s.kind} ${s.symbolName} in ${s.filePath}\n` +
         `${summary}\n` +
         `${s.signature || ''}`;
}

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
    const sim = cosineSimilarity(r.embedding || [], intentEmbedding || []);
    const similarityScore = sim;
    const score = hopScore * 0.4 + sim * 0.6;
    return { ...r, hopScore, similarityScore, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.symbolName || '').localeCompare(String(b.symbolName || ''));
  });
  return scored.slice(0, k);
}

/**
 * Recommendation tag based on similarity score (per frontend plan).
 * @param {number} similarity
 * @returns {'reuse'|'extend'|'justify-divergence'|'review'}
 */
export function recommendationFromSimilarity(similarity) {
  if (similarity >= 0.90) return 'reuse';
  if (similarity >= 0.85) return 'extend';
  if (similarity >= 0.75) return 'justify-divergence';
  return 'review';
}
