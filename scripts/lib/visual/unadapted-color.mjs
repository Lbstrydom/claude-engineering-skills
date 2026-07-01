/**
 * @fileoverview Theme-safety PIECE 2 (advisory, single-render) — "a color that
 * didn't adapt." Flags a native form control whose TEXT color was left to the UA
 * default (`ButtonText` etc.) while the author styled the BOX (background/border):
 * fine on light, black-on-dark in dark mode. Mirrors reconcile-tokens.mjs — a pure
 * producer over extract.mjs evidence; NEVER gates (report-only, not in
 * GATE_ELIGIBLE_CLASSES). Plan: docs/plans/visual-audit-theme-safety-v1.md.
 *
 * Origin-based (not "no declaration"): the winning `color` declaration's origin is
 * `user-agent` (author set no color — locally/inherited/companion; any author color
 * wins over UA → origin=author → not flagged), AND a VISIBLE author box color exists.
 * v1 scope = native form controls only (button/select/input/textarea) — the UA sets
 * their `color` directly, so the node's OWN declarations suffice (no inherited-chain).
 *
 * @module scripts/lib/visual/unadapted-color
 */
import { resolveProvenance } from './provenance-resolver.mjs';
import { isTextBearingFormControl } from './theme-safety-scope.mjs';

/** A rendered, in-flow node (not display:none/hidden/zero-rect). */
function isVisible(node) {
  return node?.displayed === true && !node?.isImage;
}

/** In v1 runtime scope: a visible, text-bearing native form control. */
function inScope(node) {
  return isTextBearingFormControl(node) && isVisible(node);
}

/** The properties the detector actually resolves provenance for. */
const AUDITED_PROPS = new Set([
  'color', 'background', 'background-color', 'border', 'border-color', 'border-width', 'border-top-color',
]);

/** Do this node's declarations carry the provenance the detector needs (`origin` on
 *  an AUDITED property)? Guards the silent-clean gap (audit H1/H3): a node whose
 *  color/box declarations lack `origin` (e.g. a partial extraction regression) can't
 *  be evaluated → NOT "evidence", so coverage counts it honestly rather than clean. */
function hasProvenanceEvidence(node) {
  const decls = node?.declarations || [];
  return decls.some((d) => d && d.origin != null && AUDITED_PROPS.has(String(d.property || '').toLowerCase()));
}

/** rgba(…,0) / transparent → not a visible paint. */
function isTransparent(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || s === 'transparent') return true;
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/]/).map((x) => x.trim());
    if (parts.length >= 4 && Number.parseFloat(parts[3]) === 0) return true;
  }
  return false;
}

function pxOf(v) {
  const m = String(v || '').match(/^(-?[\d.]+)px$/);
  return m ? Number.parseFloat(m[1]) : 0;
}

/**
 * Does the author supply a VISIBLE box color on this control? (plan decision 2)
 * A background-color of author origin that isn't transparent, OR a border of
 * author origin with a real (non-currentColor) color and width>0.
 */
function hasAuthorBox(node) {
  const decls = node.declarations || [];
  const c = node.computed || {};
  const bg = resolveProvenance(decls, 'background-color');
  if (bg?.origin === 'author' && !isTransparent(c['background-color'])) return true;
  const bd = resolveProvenance(decls, 'border-top-color');
  const bw = pxOf(c['border-top-width']);
  if (bd?.origin === 'author' && bw > 0) {
    const val = String(bd.winningValue || '').trim().toLowerCase();
    if (val !== 'currentcolor' && !isTransparent(val) && !isTransparent(c['border-top-color'])) return true;
  }
  return false;
}

/**
 * Emit `unadapted_text_color` partials for form controls with a UA-default text
 * color on an author-styled box. Report-only (advisory).
 * @param {object[]} nodes - per-state extract nodes
 * @returns {object[]} partial findings
 */
export function runUnadaptedColor(nodes) {
  const out = [];
  for (const node of nodes || []) {
    if (!inScope(node)) continue;
    const decls = node.declarations || [];
    if (!hasProvenanceEvidence(node)) continue; // no provenance evidence → coverage miss, not a finding
    // Author didn't set the text color: the winning `color` declaration is the UA's
    // (origin user-agent), or nothing set it at all (null on a form control the UA colors).
    const colorOrigin = resolveProvenance(decls, 'color')?.origin ?? null;
    const authorSetColor = colorOrigin === 'author';
    if (authorSetColor) continue;
    if (!hasAuthorBox(node)) continue;
    const c = node.computed || {};
    out.push({
      class: 'unadapted_text_color',
      surfaceId: node.surfaceId ?? null,
      nodeKey: node.nodeKey || node.auditInstanceId || null,
      property: 'color',
      expected: 'an author-set (theme-adapting) text color',
      actual: `${c['color'] || '?'} (UA default) on an author-styled ${node.tag}${node.textSnippet ? ` "${node.textSnippet}"` : ''}`,
      evidence: [],
      reportOnly: true,
      severity: 'P2',
    });
  }
  return out;
}

/**
 * Capture-honesty coverage over the form controls (plan decision 6). Total loss
 * (`eligible>0 && withEvidence===0`) → the caller degrades the surface to
 * `unverified`; partial loss → a warning. A per-node "no declarations → skip" must
 * never aggregate into "checked, found nothing."
 * @param {object[]} nodes
 * @returns {{ eligible: number, withEvidence: number }}
 */
export function assessColorCoverage(nodes) {
  let eligible = 0;
  let withEvidence = 0;
  for (const node of nodes || []) {
    if (!inScope(node)) continue;
    eligible++;
    if (hasProvenanceEvidence(node)) withEvidence++; // require `origin`, not mere presence (H1)
  }
  return { eligible, withEvidence };
}
