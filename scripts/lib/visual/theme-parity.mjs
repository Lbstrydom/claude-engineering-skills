/**
 * @fileoverview Tier 2 — theme parity (plan §2 decision 3, §2a TIER 2, Gemini-G2-3)
 * plus the contrast byproduct (§2b-G). Pure.
 *
 *   - runThemeParity: join the SAME node (by nodeKey) across two themes, compare
 *     MUST-MATCH in-flow geometry (equality within tolerance) — but ONLY for nodes
 *     rendered in BOTH themes (a `display:none`-in-one-theme node is a legitimate
 *     theme-conditional element, not drift). A may-differ color/background that is
 *     a hardcoded literal identical across both themes → `theme_unmapped_token`
 *     (it can't adapt — the dark-on-dark class).
 *   - runContrast: per node per theme, compute text contrast over the resolved
 *     effective backdrop; below the declared ratio (and backdrop resolved) →
 *     `contrast_failure`. Unverified backdrops never fire.
 *
 * @module scripts/lib/visual/theme-parity
 */
import { normalizeLength, normalizeColor } from './tokens.mjs';
import { resolveProvenance } from './provenance-resolver.mjs';
import { resolveEffectiveBackground } from './effective-background.mjs';
import { textContrast } from './contrast.mjs';

const MAY_DIFFER_COLOR_PROPS = ['color', 'background-color', 'border-top-color'];
const DECORATIVE_TAGS = new Set(['use', 'path', 'g', 'defs', 'symbol', 'stop', 'lineargradient', 'radialgradient', 'clippath', 'mask', 'marker', 'pattern']);

/**
 * @param {Record<string, object[]>} nodesByTheme - themeName → evidence nodes (one device)
 * @param {object} contract
 * @returns {object[]} partial findings
 */
export function runThemeParity(nodesByTheme, contract) {
  // Deterministic + fail-closed pair resolution (audit R1-H2 + R2-H2 + R3-H3):
  // delegated to assessThemePairResolution — the ONE resolution rule, shared with
  // the CLI's honesty surfacing so "no findings" on a mismatch is never silent
  // (the CLI reports the non-`ok` status as unverified). v1 limit unchanged:
  // only the first two themes are compared (3-theme pairwise is a plan
  // Out-of-Scope).
  const resolution = assessThemePairResolution(nodesByTheme, contract);
  if (resolution.status !== 'ok') return []; // unassessable — surfaced via the assessor, not silence
  const [tA, tB] = resolution.pair;
  const aByKey = indexByKey(nodesByTheme[tA]);
  const bByKey = indexByKey(nodesByTheme[tB]);
  const geomProps = contract?.propertyPolicy?.mustMatchGeometry ?? ['width', 'height', 'padding', 'margin'];
  const tol = contract?.tolerances?.geometryPx ?? 1;
  const out = [];

  for (const [key, a] of aByKey) {
    const b = bByKey.get(key);
    if (!b) continue;
    const bothDisplayed = a.displayed !== false && b.displayed !== false;

    // MUST-MATCH geometry — only when rendered in both themes (Gemini-G2-3).
    if (bothDisplayed) {
      for (const prop of expandGeometry(geomProps)) {
        const av = normalizeLength((a.computed || {})[prop]);
        const bv = normalizeLength((b.computed || {})[prop]);
        if (av == null || bv == null) continue;
        if (Math.abs(parseFloat(av) - parseFloat(bv)) > tol) {
          out.push(mk('theme_geometry_drift', a, prop, `${tA}=${av} (parity within ${tol}px)`, `${tB}=${bv}`, [tA, tB]));
        }
      }
    }

    // MAY-DIFFER-IF-TOKENED: a literal color identical across themes can't remap.
    if (DECORATIVE_TAGS.has(a.tag)) continue; // SVG-internal nodes don't carry meaningful paint
    for (const prop of MAY_DIFFER_COLOR_PROPS) {
      // `color` inherits — reporting it on every descendant re-counts one frozen
      // literal N times (shakedown noise #4). Only flag `color` on text-bearing
      // nodes (the node that actually paints the glyphs).
      if (prop === 'color' && a.hasText === false) continue;
      if (prop === 'border-top-color' && !borderPaintedTop(a.computed)) continue;
      const av = normalizeColor((a.computed || {})[prop]);
      const bv = normalizeColor((b.computed || {})[prop]);
      if (av == null || bv == null) continue;
      if (av !== bv) continue; // it DID change across themes → fine
      if (av === '0,0,0,0') continue; // transparent — nothing to adapt
      const prov = a.matched?.[prop] ?? (Array.isArray(a.declarations) ? resolveProvenance(a.declarations, prop) : null);
      if (prov?.usesToken) continue; // tokened + same value across themes is a deliberate theme-agnostic token
      out.push(mk('theme_unmapped_token', a, prop, 'value should adapt across themes (token-mapped)', `literal ${av} identical in ${tA} & ${tB}`, [tA, tB]));
    }
  }
  return out;
}

/**
 * @param {object[]} nodes - evidence nodes for ONE device×theme (text nodes carry color + backgroundStack)
 * @param {object} contract
 * @returns {object[]} partial findings ({class:'contrast_failure'})
 */
export function runContrast(nodes, contract) {
  const minRatio = contract?.tolerances?.contrastRatio ?? 4.5;
  const out = [];
  for (const node of nodes || []) {
    if (node?.displayed === false) continue;
    if (node.hasText === false) continue; // only text nodes
    const fg = normalizeColor((node.computed || {}).color);
    if (!fg) continue;
    const bg = resolveEffectiveBackground(node.backgroundStack, { theme: node.theme });
    if (bg.status !== 'resolved') continue; // unverified backdrop → never gate (G2-M1/G1)
    const ratio = textContrast(fg, bg.color);
    if (ratio == null) continue;
    if (ratio < minRatio) {
      out.push(mk('contrast_failure', node, 'color', `≥ ${minRatio}:1`, `${ratio}:1 over ${bg.color}`, []));
    }
  }
  return out;
}

function indexByKey(nodes) {
  // Within-theme duplicate keys are AMBIGUOUS (audit R1-H1): the depth-8 nodeKey can
  // collide on repeated deep structures even inside one contracted surface, and a
  // wrong cross-theme match corrupts every parity comparison built on it. Drop both
  // occupants (coverage miss, never a fabricated finding) — same guard as the v2
  // livePath index.
  const m = new Map();
  const dup = new Set();
  for (const n of nodes || []) {
    if (!n?.nodeKey) continue;
    if (m.has(n.nodeKey)) { dup.add(n.nodeKey); continue; }
    m.set(n.nodeKey, n);
  }
  for (const k of dup) m.delete(k);
  return m;
}

/**
 * Coverage honesty for the contracted parity join (audit R2-H1): `indexByKey`
 * drops within-theme duplicate nodeKeys to prevent fabricated cross-theme
 * matches — but a silent drop removes gate-eligible parity checks from
 * coverage, which must be SURFACED, not swallowed. Pure assessor (mirrors
 * `assessColorCoverage`): the CLI turns a non-zero count into a per-check
 * `unverified` warning, never a silent clean.
 * @param {Record<string, object[]>} nodesByTheme - themeName → nodes (one device)
 * @returns {{ambiguousKeys:number, byTheme:Record<string, number>}}
 */
export function assessParityKeyAmbiguity(nodesByTheme) {
  const byTheme = {};
  let total = 0;
  for (const [theme, nodes] of Object.entries(nodesByTheme || {})) {
    const seen = new Set();
    const dup = new Set();
    for (const n of nodes || []) {
      if (!n?.nodeKey) continue;
      if (seen.has(n.nodeKey)) dup.add(n.nodeKey);
      seen.add(n.nodeKey);
    }
    if (dup.size > 0) { byTheme[theme] = dup.size; total += dup.size; }
  }
  return { ambiguousKeys: total, byTheme };
}

// ── Theme-safety v2 — contrast parity-delta over the full-DOM sweep ─────────
// Plan: docs/plans/visual-audit-theme-safety-v2.md. Advisory (report-only,
// NOT in GATE_ELIGIBLE_CLASSES). Scope-disjoint from the absolute checks:
// this producer receives ONLY `scope:'fullDom'` nodes (decision 1), so it can
// never duplicate or contaminate the contracted-surface `contrast_failure`.

/**
 * Index full-DOM nodes by their un-truncated `livePath` — the v2 join identity
 * (plan §2a / Gemini-H1: the depth-8 `nodeKey` collides on repeated deep
 * structures, so a full-DOM join on it would drop most of the page). A
 * `livePath` duplicated WITHIN one theme is ambiguous — a wrong cross-theme
 * match would fabricate a delta — so both occupants are dropped (coverage
 * miss, never a finding).
 * @param {object[]} nodes
 * @returns {Map<string, object>}
 */
function indexByLivePath(nodes) {
  const m = new Map();
  const dup = new Set();
  for (const n of nodes || []) {
    const p = n?.livePath;
    if (typeof p !== 'string' || !p) continue;
    if (m.has(p)) { dup.add(p); continue; }
    m.set(p, n);
  }
  for (const p of dup) m.delete(p);
  // Dropped-ambiguity count is part of the coverage contract (audit R3-H2): a
  // silent drop would make join ambiguity indistinguishable from clean.
  return { map: m, ambiguous: dup.size };
}

/** The ordered two-theme pair from the CONTRACT (single source of theme order —
 *  never `Object.keys(nodesByTheme)`, which is non-deterministic). `null` when
 *  the contract doesn't declare exactly two themes (v2 is a two-theme detector;
 *  coverage reports `unsupported_theme_count`, plan decision 3). */
function contractThemePair(contract) {
  const names = (contract?.themes || []).map((t) => t?.name).filter(Boolean);
  // Two DISTINCT names required (audit R1: schema doesn't enforce theme-name
  // uniqueness; a duplicated name would self-join one theme against itself).
  return names.length === 2 && names[0] !== names[1] ? names : null;
}

/** A joined pair both rendered and text-bearing in BOTH themes? (per-node
 *  eligibility shared by the detector and the coverage assessor). `hasText`
 *  must be EXPLICITLY true — an absent/unknown text state must not fabricate
 *  a delta (audit R1: absence-as-eligible was too permissive). */
function pairEligible(a, b) {
  if (!a || !b) return false;
  if (a.displayed === false || b.displayed === false) return false;
  if (a.hasText !== true || b.hasText !== true) return false;
  if (DECORATIVE_TAGS.has(a.tag)) return false;
  return true;
}

/** Defense-in-depth (audit R1): the delta is documented as fullDom-only, but the
 *  producer must enforce that boundary itself rather than trust the caller's
 *  filter — a contracted node slipping in would double-report against the
 *  gate-eligible absolute checks. */
function onlyFullDom(nodes) {
  return (nodes || []).filter((n) => n?.scope === 'fullDom');
}

/**
 * Two-theme contrast parity-delta: flag a node whose text contrast PASSES in
 * one theme and FAILS in the other — the fingerprint of "a color that didn't
 * adapt" (a decorative low-contrast element fails in BOTH themes → no delta).
 * @param {Record<string, object[]>} fullDomNodesByTheme - themeName → `scope:'fullDom'` nodes (one device)
 * @param {object} contract
 * @returns {object[]} partial findings ({class:'contrast_parity_delta'}, reportOnly)
 */
export function runContrastParityDelta(fullDomNodesByTheme, contract) {
  const pair = contractThemePair(contract);
  if (!pair) return []; // not assessable — assessParityCoverage reports unsupported_theme_count
  const [tA, tB] = pair;
  const minRatio = contract?.tolerances?.contrastRatio ?? 4.5;
  const { map: aByPath } = indexByLivePath(onlyFullDom(fullDomNodesByTheme?.[tA]));
  const { map: bByPath } = indexByLivePath(onlyFullDom(fullDomNodesByTheme?.[tB]));
  const out = [];
  for (const [livePath, a] of aByPath) {
    const b = bByPath.get(livePath);
    if (!pairEligible(a, b)) continue; // one-theme-only = theme-conditional → skip
    const bgA = resolveEffectiveBackground(a.backgroundStack, { theme: tA });
    const bgB = resolveEffectiveBackground(b.backgroundStack, { theme: tB });
    if (bgA.status !== 'resolved' || bgB.status !== 'resolved') continue; // unverified backdrop → never a false delta
    const fgA = normalizeColor((a.computed || {}).color);
    const fgB = normalizeColor((b.computed || {}).color);
    if (!fgA || !fgB) continue;
    const rA = textContrast(fgA, bgA.color);
    const rB = textContrast(fgB, bgB.color);
    if (rA == null || rB == null) continue;
    const passA = rA >= minRatio;
    const passB = rB >= minRatio;
    if (passA === passB) continue; // both pass, or both fail (decorative) → no delta
    const failing = passA ? tB : tA;
    out.push({
      class: 'contrast_parity_delta',
      surfaceId: a.surfaceId ?? null,
      nodeKey: a.nodeKey ?? null,
      device: a.device ?? null,
      theme: failing, // the theme where the color didn't adapt
      property: 'color',
      // Canonical VisualFinding shape only (Gemini-r2-M1): ratios in expected/
      // actual, livePath + colors in evidence — no custom top-level props.
      expected: `≥ ${minRatio}:1 in both themes`,
      actual: `${rA}:1 ${tA} vs ${rB}:1 ${tB} — fails only in ${failing}`,
      evidence: [livePath, `fg:${tA}=${fgA}`, `fg:${tB}=${fgB}`, `bg:${tA}=${bgA.color}`, `bg:${tB}=${bgB.color}`],
      reportOnly: true,
      severity: 'P2',
    });
  }
  return out;
}

/**
 * Capture-honesty coverage for the parity-delta (plan decision 4 — scope-aware,
 * one explicit contract). Union-level node counts alone cannot prove the
 * requested full-DOM sweep RAN, so this also reads the per-state capture stats.
 * @param {object} args
 * @param {Record<string, object[]>} args.nodesByTheme - themeName → `scope:'fullDom'` nodes (one device)
 * @param {object} args.contract
 * @param {Array<{fullDomRequested?:boolean, emitted?:number, displayedTextCandidatesAfterSkip?:number, device?:string, theme?:string}>} [args.captureStatsByState]
 * @returns {{status:'assessable'|'unverified', reason?:string, themePair:string[], scopeStats:object[], eligible?:number, withEvidence?:number}}
 */
export function assessParityCoverage({ nodesByTheme, contract, captureStatsByState } = {}) {
  const pair = contractThemePair(contract);
  if (!pair) {
    return { status: 'unverified', reason: 'unsupported_theme_count', themePair: (contract?.themes || []).map((t) => t?.name).filter(Boolean), scopeStats: [] };
  }
  // Scope-aware capture check (R1-H1): full-DOM requested but a state emitted 0
  // nodes DESPITE having displayed text candidates after the contracted skip →
  // the sweep didn't actually run for that state; degrade, never read clean.
  // (0 candidates = legitimately nothing to assess, NOT a degrade — R2-M3.)
  const scopeStats = [];
  for (const s of captureStatsByState || []) {
    if (s?.fullDomRequested && (s.emitted ?? 0) === 0 && (s.displayedTextCandidatesAfterSkip ?? 0) > 0) {
      scopeStats.push({ device: s.device ?? null, theme: s.theme ?? null, reason: 'fulldom_capture_empty' });
    }
  }
  if (scopeStats.length > 0) {
    return { status: 'unverified', reason: 'fulldom_capture_empty', themePair: pair, scopeStats };
  }
  const [tA, tB] = pair;
  const idxA = indexByLivePath(onlyFullDom(nodesByTheme?.[tA]));
  const idxB = indexByLivePath(onlyFullDom(nodesByTheme?.[tB]));
  // Join ambiguity is COVERAGE data, not a silent no-finding (audit R3-H2): every
  // dropped duplicate livePath removed a node from the join.
  const ambiguousPaths = idxA.ambiguous + idxB.ambiguous;
  let joined = 0;
  let eligible = 0;
  let withEvidence = 0;
  for (const [livePath, a] of idxA.map) {
    const b = idxB.map.get(livePath);
    if (b) joined++;
    if (!pairEligible(a, b)) continue;
    eligible++;
    const bgA = resolveEffectiveBackground(a.backgroundStack, { theme: tA });
    const bgB = resolveEffectiveBackground(b.backgroundStack, { theme: tB });
    if (bgA.status === 'resolved' && bgB.status === 'resolved') withEvidence++;
  }
  if (eligible > 0 && withEvidence === 0) {
    return { status: 'unverified', reason: 'no_resolvable_backdrops', themePair: pair, scopeStats, eligible, withEvidence, ambiguousPaths };
  }
  // Total ambiguity loss: joinable candidates existed but ALL were dropped as
  // duplicates → nothing was actually assessed; degrade, never read clean.
  if (eligible === 0 && ambiguousPaths > 0) {
    return { status: 'unverified', reason: 'all_candidates_ambiguous', themePair: pair, scopeStats, eligible, withEvidence, ambiguousPaths };
  }
  // Structural join failure (arm-eval queue finding 93d107d7): both themes
  // captured candidates but ZERO livePaths matched — e.g. a theme-conditional
  // element high in the DOM shifted every subsequent nth-of-type index. Nothing
  // was actually compared; "0 findings" here is a false clean, not a pass.
  if (joined === 0 && idxA.map.size > 0 && idxB.map.size > 0) {
    return { status: 'unverified', reason: 'no_joinable_candidates', themePair: pair, scopeStats, eligible, withEvidence, ambiguousPaths };
  }
  return { status: 'assessable', themePair: pair, scopeStats, eligible, withEvidence, ambiguousPaths };
}

/**
 * Machine-readable theme-pair resolution state for the CONTRACTED parity tier
 * (audit R3-H3): `runThemeParity` fails closed by emitting no findings on a
 * contract/capture mismatch, but "no findings" alone is indistinguishable from
 * "parity ran clean". The CLI surfaces a non-`ok` status as an unverified
 * warning in the verify result — the unassessable state exists in the output,
 * not just a log line. Pure.
 * @param {Record<string, object[]>} nodesByTheme - themeName → nodes (one device)
 * @param {object} contract
 * @returns {{status:'ok'|'single_theme'|'contract_capture_mismatch', pair:string[]|null, declaredThemes:string[], capturedThemes:string[]}}
 */
export function assessThemePairResolution(nodesByTheme, contract) {
  const captured = Object.keys(nodesByTheme || {});
  const declaredAll = [...new Set((contract?.themes || []).map((t) => t?.name).filter(Boolean))];
  if (captured.length < 2) {
    return { status: 'single_theme', pair: null, declaredThemes: declaredAll, capturedThemes: captured };
  }
  const declared = declaredAll.filter((n) => captured.includes(n));
  if (declaredAll.length >= 2 && declared.length < 2) {
    return { status: 'contract_capture_mismatch', pair: null, declaredThemes: declaredAll, capturedThemes: captured };
  }
  const pair = (declared.length >= 2 ? declared : captured).slice(0, 2);
  return { status: 'ok', pair, declaredThemes: declaredAll, capturedThemes: captured };
}

/** Don't reconcile an invisible top border (color computes even at width 0). */
function borderPaintedTop(computed = {}) {
  const style = String(computed['border-top-style'] || 'none').trim();
  const w = parseFloat(computed['border-top-width']);
  return style !== 'none' && style !== 'hidden' && Number.isFinite(w) && w > 0;
}

/** Expand padding/margin shorthand policy entries into the longhands we measure. */
function expandGeometry(props) {
  const out = [];
  for (const p of props) {
    if (p === 'padding') out.push('padding-top', 'padding-right', 'padding-bottom', 'padding-left');
    else if (p === 'margin') out.push('margin-top', 'margin-right', 'margin-bottom', 'margin-left');
    else if (p === 'grid-template') out.push('grid-template-columns', 'grid-template-rows');
    else out.push(p);
  }
  return out;
}

function mk(cls, node, property, expected, actual, extraEvidence) {
  return {
    class: cls,
    surfaceId: node.surfaceId ?? null,
    nodeKey: node.nodeKey ?? null,
    device: node.device ?? null,
    theme: node.theme ?? null,
    property,
    expected,
    actual,
    evidence: [node.nodeKey ? `${node.surfaceId}/${node.nodeKey}` : '', ...(extraEvidence || [])].filter(Boolean),
  };
}
