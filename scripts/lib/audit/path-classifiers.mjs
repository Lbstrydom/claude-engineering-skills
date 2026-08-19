/**
 * @fileoverview Shared path classifiers — test-file and doc-example-file
 * detection, used by the dead-code orphan wave and the event-wiring wave.
 *
 * Extracted byte-identical from orphan-introduced.mjs (values and matching
 * logic unchanged) so both waves import one implementation instead of two
 * copies drifting apart (docs/plans/event-wiring-symmetry.md, Gemini G2 fix).
 *
 * @module scripts/lib/audit/path-classifiers
 */

/**
 * Version bump whenever TEST_PATH_PATTERNS / DOC_EXAMPLE_PATH_PATTERNS change,
 * so a consumer's content cache (e.g. event-wiring's corpus cache, D11) knows
 * to invalidate a corpus whose baked-in `runtime` classifications were
 * computed under stale patterns (docs/plans/event-wiring-symmetry.md, Gemini
 * round-2 G3 fix).
 */
export const PATH_CLASSIFIER_VERSION = 1;

// Deep-frozen — the outer object AND its nested arrays (audit-code L1 fix,
// pre-existing in the original orphan-introduced.mjs but worth closing now
// that this module has more than one consumer). A mutable nested array let
// any importer silently corrupt shared classifier config for every caller.
const TEST_PATH_PATTERNS = Object.freeze({
  prefixes: Object.freeze(['tests/', 'test/']),
  segmentContains: Object.freeze(['/tests/', '/test/', '/__tests__/']),
  suffixRegex: /\.(test|spec)\.[a-z]+$/i,
});

const DOC_EXAMPLE_PATH_PATTERNS = Object.freeze({
  prefixes: Object.freeze(['docs/']),
});

export { TEST_PATH_PATTERNS, DOC_EXAMPLE_PATH_PATTERNS };

/** Test-file classifier — see orphan-introduced.mjs's original docstring for rationale. */
export function isTestFile(p) {
  if (!p || typeof p !== 'string') return false;
  const n = p.replaceAll('\\', '/');
  for (const prefix of TEST_PATH_PATTERNS.prefixes) {
    if (n.startsWith(prefix)) return true;
  }
  for (const segment of TEST_PATH_PATTERNS.segmentContains) {
    if (n.includes(segment)) return true;
  }
  return TEST_PATH_PATTERNS.suffixRegex.test(n);
}

/** Doc-embedded example/snapshot classifier — see orphan-introduced.mjs's original docstring. */
export function isDocExampleFile(p) {
  if (!p || typeof p !== 'string') return false;
  const n = p.replaceAll('\\', '/');
  return DOC_EXAMPLE_PATH_PATTERNS.prefixes.some(prefix => n.startsWith(prefix));
}
