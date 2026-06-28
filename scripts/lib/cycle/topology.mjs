/**
 * @fileoverview Deploy-topology honesty seam for `/cycle` (GREEN ≠ REALIZED, Cluster C —
 * plan: docs/completed/green-not-realized.md §2a/#7). The failure it addresses: when a repo deploys
 * from main with no preview environment, `/cycle` Step 5's persona-test can only run POST-merge,
 * so it cannot PREVENT a bad UX from reaching prod — yet the green cycle reads as if it gated.
 *
 * The fix is config, NOT sniffing (both brainstorm models rejected auto-detecting deploy-from-main
 * as the over-engineering cliff). A repo declares its topology via `previewGateMode`; `/cycle` Step 5
 * CALLS this pure helper (the testable artifact) instead of re-implementing the decision in prose —
 * prose guidance is itself green-but-not-realized.
 *
 * @module scripts/lib/cycle/topology
 */

/** The three honest topology states (NOT a boolean — "no preview" and "not configured" differ). */
export const PREVIEW_GATE_MODES = Object.freeze(['pre_merge_required', 'post_merge_warning', 'not_applicable']);

/**
 * Resolve what `/cycle` Step 5 must do about preview gating, from declared config.
 *
 * @param {{previewGateMode?: string}} [config]
 * @returns {{mode: string, action: 'halt'|'warn'|'none', message: string}}
 *   - `pre_merge_required` → `halt`: a preview deploy exists and MUST gate; halt before merge until a
 *     preview `--url` is supplied and persona-test passes against it.
 *   - `post_merge_warning` → `warn`: deploys from main / no preview; persona-test is post-hoc and
 *     cannot prevent prod exposure — proceed but surface that loudly.
 *   - `not_applicable` (default) OR any unrecognised value → `none`: silent (opt-in; unknown degrades
 *     to the safe no-op rather than inventing a gate).
 */
export function resolvePreviewGate(config = {}) {
  const raw = config && typeof config === 'object' ? config.previewGateMode : undefined;
  const mode = PREVIEW_GATE_MODES.includes(raw) ? raw : 'not_applicable';
  switch (mode) {
    case 'pre_merge_required':
      return {
        mode,
        action: 'halt',
        message: 'Preview gate REQUIRED: halt before merge — supply a preview `--url` and run persona-test against it so a UX regression is caught BEFORE it reaches prod.',
      };
    case 'post_merge_warning':
      return {
        mode,
        action: 'warn',
        message: 'persona-test is POST-HOC here (deploy-from-main / no preview env): it runs after merge and CANNOT prevent prod exposure. Treat its findings as fast-follow, not a gate.',
      };
    default:
      return { mode: 'not_applicable', action: 'none', message: '' };
  }
}
