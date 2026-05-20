/**
 * @fileoverview Named shared redaction adapter for the consistency-mode rig
 * (and any other caller that wants a clean redaction API).
 *
 * Phase 0 of docs/plans/persona-test-consistency-mode.md — resolves
 * Gemini-R2-M2 (security boundary depended on an unnamed redactor) and
 * Gemini-R6-G3 (witness_snapshot JSONB must be deep-redacted before egress).
 *
 * Wraps the existing `redactSecrets` / `SECRET_PATTERNS` from
 * `scripts/lib/secret-patterns.mjs`. This module exists to give consistency
 * mode a clean two-function surface (`redact` / `redactObject`) and to add the
 * recursive object traversal the plan needs — the underlying pattern matrix
 * is still maintained in one place.
 *
 * @module scripts/lib/redact
 */
import { redactSecrets } from './secret-patterns.mjs';

const DEFAULT_MAX_DEPTH = 8;
const MAX_OBJECT_NODES = 50_000;   // hard cap — prevents runaway traversal on cyclic / pathological inputs

/**
 * Redact secrets from a single string.
 *
 * @param {string} text
 * @returns {{ redacted: string, count: number, patternsHit: string[] }}
 */
export function redact(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { redacted: typeof text === 'string' ? text : '', count: 0, patternsHit: [] };
  }
  const { text: redactedText, redacted: patternsHit } = redactSecrets(text);
  return {
    redacted: redactedText,
    count: patternsHit.length,
    patternsHit,
  };
}

/**
 * Deep-redact secrets in an object / array / primitive. Walks JSON-like
 * structures recursively (objects, arrays, strings). Non-string leaves
 * (numbers, booleans, null) are returned unchanged.
 *
 * Always returns a new object — never mutates the input.
 *
 * Bounded by:
 *  - `depth` (default 8) — recursion depth cap; deeper sub-trees are returned untouched
 *  - `MAX_OBJECT_NODES` — total node visit cap; prevents pathological inputs from blocking
 *
 * @param {unknown} value
 * @param {object} [opts]
 * @param {number} [opts.depth] — max recursion depth, default 8
 * @returns {{ redacted: unknown, count: number, patternsHit: string[] }}
 */
export function redactObject(value, opts = {}) {
  const maxDepth = Number.isInteger(opts.depth) && opts.depth >= 0
    ? opts.depth
    : DEFAULT_MAX_DEPTH;
  const patterns = new Set();
  let count = 0;
  let nodesVisited = 0;

  function walk(node, currentDepth) {
    nodesVisited += 1;
    if (nodesVisited > MAX_OBJECT_NODES) return node;
    if (currentDepth > maxDepth) return node;

    if (typeof node === 'string') {
      const r = redact(node);
      if (r.count > 0) {
        count += r.count;
        for (const p of r.patternsHit) patterns.add(p);
        return r.redacted;
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((n) => walk(n, currentDepth + 1));
    }
    if (node !== null && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node)) {
        out[key] = walk(node[key], currentDepth + 1);
      }
      return out;
    }
    return node;
  }

  return {
    redacted: walk(value, 0),
    count,
    patternsHit: [...patterns],
  };
}

// Internal exports for tests — match the project pattern (file-io.mjs, shared.mjs).
export const _internals = Object.freeze({
  DEFAULT_MAX_DEPTH,
  MAX_OBJECT_NODES,
});
