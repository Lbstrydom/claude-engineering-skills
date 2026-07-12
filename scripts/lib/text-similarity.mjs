/**
 * @fileoverview Pure text-similarity primitives. Zero dependencies (no fs,
 * no env reads, no transitive I/O) — safe to import from any "no I/O, no
 * LLM calls" module without breaking that guarantee. Extracted from
 * ledger.mjs (round-15 empirical-verify fix) so deterministic-scorer.mjs
 * could reuse it without pulling in ledger.mjs's transitive shared-cloud-
 * config env read at module-load time.
 * @module scripts/lib/text-similarity
 */

/**
 * Text similarity via token set overlap (Jaccard index).
 * @param {string} a - First text
 * @param {string} b - Second text
 * @returns {number} Similarity score 0-1
 */
export function jaccardSimilarity(a, b) {
  const tokenize = s => new Set((s || '').toLowerCase().replaceAll(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
