/**
 * @fileoverview Shared free-text sensitive-path token scan — extracted
 * (round-12 audit H6 fix) so both structured-extractor.mjs (the extraction
 * boundary) and provider-adapter.mjs (the final provider-call boundary, "not
 * just part of the pipeline" per this round's finding) apply the SAME check,
 * without a circular import between them (structured-extractor.mjs already
 * imports invokeStructured from provider-adapter.mjs).
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/egress-path-scan
 */

import { isPathSensitive } from '../sensitive-egress-gate.mjs';

// Round-14 audit M11 fix — moved here (from structured-extractor.mjs, which
// re-exports it for backward compatibility) so provider-adapter.mjs's
// final-boundary path-scan check can throw the SAME domain-specific error
// class the upstream extraction boundary uses, instead of a plain Error —
// equivalent egress-policy failures are now consistently classified across
// both boundaries, without a circular import between the two.
export class EgressGateError extends Error {
  constructor(message) { super(message); this.name = 'EgressGateError'; }
}

/**
 * Bounded, best-effort scan for path-shaped substrings in free text (prose,
 * not a structured field) — not full NLP-grade path extraction, a
 * defense-in-depth net for the common "the file .env has..." case.
 * @param {string} text
 * @returns {string[]} sensitive path-like tokens found, if any
 */
export function findSensitivePathMentions(text) {
  if (typeof text !== 'string' || !text) return [];
  const tokens = text.match(/[.\w-]+(?:\/[.\w-]+)+|\.\w+rc\b|\.env\S*|id_[rd]sa\S*/g) || [];
  return tokens.filter(isPathSensitive);
}
