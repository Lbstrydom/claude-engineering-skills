/**
 * @fileoverview Taxonomy orchestration (plan §2a/§7) — runs the four tiers over
 * extract.mjs evidence, stamps severity + gateEligible + source on each partial,
 * dedups, and folds in static (no-browser) diagnostics + the inferred-clustering
 * fallback. Single place that decides what can gate.
 *
 * @module scripts/lib/visual/findings
 */
import { GATE_ELIGIBLE_CLASSES } from './schema.mjs';
import { runReconcileTokens } from './reconcile-tokens.mjs';
import { runThemeParity, runContrast } from './theme-parity.mjs';
import { runLayoutPhysics } from './layout-physics.mjs';
import { runSignifiers } from './signifiers.mjs';
import { inferClusters } from './tokens.mjs';

/** Default severity per finding class. */
export const SEVERITY_BY_CLASS = {
  token_violation: 'P1',
  theme_geometry_drift: 'P2',
  theme_unmapped_token: 'P1',
  contrast_failure: 'P1',
  layout_overflow: 'P2',
  content_clipping: 'P1',
  unexpected_overlap: 'P2',
  image_distortion: 'P2',
  missing_visible_focus: 'P1',
  state_has_no_visual_delta: 'P2',
  disabled_not_signified: 'P2',
  component_inconsistency: 'info',
  token_unreferenced: 'info',
  token_undefined_reference: 'info',
  token_duplicate_definition: 'info',
};

/**
 * Finalize partial findings — stamp severity, gateEligible, source; dedup.
 * @param {object[]} partials
 * @param {{source?:'static'|'live'}} [opts]
 * @returns {object[]}
 */
export function finalizeFindings(partials, { source = 'live' } = {}) {
  const seen = new Set();
  const out = [];
  for (const p of partials || []) {
    const cls = p.class;
    const key = `${cls}|${p.surfaceId ?? ''}|${p.nodeKey ?? ''}|${p.device ?? ''}|${p.theme ?? ''}|${p.property ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      class: cls,
      severity: p.severity ?? SEVERITY_BY_CLASS[cls] ?? 'P2',
      surfaceId: p.surfaceId ?? null,
      nodeKey: p.nodeKey ?? null,
      device: p.device ?? null,
      theme: p.theme ?? null,
      property: p.property ?? null,
      expected: p.expected ?? null,
      actual: p.actual ?? null,
      evidence: p.evidence ?? [],
      gateEligible: GATE_ELIGIBLE_CLASSES.has(cls) && p.reportOnly !== true,
      source: p.source ?? source,
    });
  }
  return out;
}

/**
 * Assemble the full live finding set from per-state evidence.
 * @param {object} args
 * @param {Array<{device:string, theme:string, viewportWidth:number, nodes:object[]}>} args.perState
 * @param {object} args.allowedSet
 * @param {object} args.tokenIndex
 * @param {object} args.contract
 * @returns {object[]} finalized live findings
 */
export function assembleLiveFindings({ perState, allowedSet, tokenIndex, contract }) {
  const partials = [];

  for (const state of perState || []) {
    const nodes = state.nodes || [];
    partials.push(...runReconcileTokens(nodes, tokenIndex, allowedSet, contract));
    partials.push(...runContrast(nodes, contract));
    partials.push(...runLayoutPhysics(nodes, contract, { viewportWidth: state.viewportWidth }));
    partials.push(...runSignifiers(nodes));
  }

  // Theme parity: group states by device, pair themes.
  const byDevice = new Map();
  for (const state of perState || []) {
    const m = byDevice.get(state.device) || {};
    m[state.theme] = state.nodes || [];
    byDevice.set(state.device, m);
  }
  for (const [, nodesByTheme] of byDevice) {
    partials.push(...runThemeParity(nodesByTheme, contract));
  }

  // Inferred clustering fallback (report-only) when no tokens declared.
  if (allowedSet?.inferredMode) {
    const observed = [];
    for (const state of perState || []) {
      for (const node of state.nodes || []) {
        const c = node.computed || {};
        if (c['border-top-left-radius']) observed.push({ family: 'radius', value: c['border-top-left-radius'] });
        if (c['padding-top']) observed.push({ family: 'spacing', value: c['padding-top'] });
        if (c['font-size']) observed.push({ family: 'fontSize', value: c['font-size'] });
      }
    }
    for (const outlier of inferClusters(observed)) {
      partials.push({
        class: 'token_violation',
        property: outlier.family,
        expected: 'dominant inferred cluster',
        actual: `${outlier.value} (used by ${(outlier.share * 100).toFixed(0)}% — inferred outlier)`,
        evidence: [],
        reportOnly: true, // inferred → never gates (plan §2 decision 2)
        severity: 'info',
      });
    }
  }

  return finalizeFindings(partials, { source: 'live' });
}
