/**
 * @fileoverview Core finding identity (semanticId) + barrel re-exports.
 *
 * Core: content-addressable finding hashing (semanticId).
 * Re-exports: format, tracker, outcomes, tasks (backward compat for all 14+ importers).
 *
 * @module scripts/lib/findings
 */

import crypto from 'node:crypto';
import { normalizePath } from './file-io.mjs';

// ── Semantic Hashing ───────────────────────────────────────────────────────

/**
 * Content-addressable finding ID — deterministic, model-agnostic.
 * Same issue keeps the same ID regardless of which model raised it.
 *
 * Phase C: dispatches on `classification.sourceKind`. Tool findings (LINTER,
 * TYPE_CHECKER) use `file:rule:message` identity — stable across line-number
 * shifts when unrelated lines are added above. Model findings keep the
 * original content-hash identity.
 *
 * @param {object} f - Finding with category, section, detail (+ optional classification)
 * @returns {string} 8-char hex hash
 */
export function semanticId(f) {
  const kind = f.classification?.sourceKind;
  if (kind === 'LINTER' || kind === 'TYPE_CHECKER') {
    const [file] = (f.section || '').split(':');
    const rule = f.principle || 'unknown';
    const msgSnippet = (f.detail || '').slice(0, 60).toLowerCase().trim();
    return crypto.createHash('sha256')
      .update(`${normalizePath(file)}|${rule}|${msgSnippet}`)
      .digest('hex')
      .slice(0, 8);
  }
  const content = `${f.category}|${f.section}|${f.detail}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

// ── Barrel Re-exports (backward compat) ─────────────────────────────────────
// All 14+ importers of findings.mjs continue working unchanged.

export { formatFindings } from './findings-format.mjs';

export {
  FalsePositiveTracker,
  extractDimensions, buildPatternKey,
  applyLazyDecay, effectiveSampleSize, recordWithDecay
} from './findings-tracker.mjs';

export {
  setRepoProfileCache,
  appendOutcome, batchAppendOutcomes, loadOutcomes, compactOutcomes,
  computePassEffectiveness, computePassEWR
} from './findings-outcomes.mjs';
