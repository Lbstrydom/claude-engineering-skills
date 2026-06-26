/**
 * @fileoverview Pure live-DOM → scorecard attribution (plan v1.1 §4a). Mirrors
 * verify.mjs's pure/`reconcile` vs browser/`runVerify` split: this module is
 * ZERO-browser and fully unit-testable. `runVerify` collects `liveEvidence`
 * (one row per nav OCCURRENCE); this module groups it and merges the verdict
 * into the per-persona scorecard.
 *
 * @module scripts/lib/nav/live-attribution
 */

/** The full scorecard status union (single source of truth). */
export const STATUS = Object.freeze({
  // live-mode verdicts
  PASS: 'pass', MISPLACED: 'misplaced', MISSING: 'missing',
  // static-mode statuses (unchanged)
  OK: 'ok', RED: 'red', UNVERIFIED: 'unverified', UNKNOWN: 'unknown',
});

/** Explicit layer precedence for tie-breaks (NOT JS object-key order — Gemini2-LOW). */
const LAYER_PRECEDENCE = ['primary', 'secondary'];
function layerRank(layer, contract) {
  const i = LAYER_PRECEDENCE.indexOf(layer);
  if (i !== -1) return i;
  // remaining declared layers ranked alphabetically after the known ones
  const rest = Object.keys(contract?.navLayers ?? {}).filter((l) => !LAYER_PRECEDENCE.includes(l)).sort();
  const j = rest.indexOf(layer);
  return j === -1 ? 999 : LAYER_PRECEDENCE.length + j;
}

/**
 * Pick the nearest declared-selector match for one occurrence (pure; extracted
 * for deterministic test — R1-M5). `matches` = [{selector, layer, depth}] where
 * depth is DOM distance from the target (0 = the element itself). Nearest wins;
 * ties resolve by layer precedence.
 * @returns {{selector: string, layer: string}|null}
 */
export function resolveContainer(matches, contract = null) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  let best = null;
  for (const m of matches) {
    if (!m || typeof m.depth !== 'number') continue;
    if (best === null
      || m.depth < best.depth
      || (m.depth === best.depth && layerRank(m.layer, contract) < layerRank(best.layer, contract))) {
      best = m;
    }
  }
  return best ? { selector: best.selector, layer: best.layer } : null;
}

/**
 * Group flat `liveEvidence` (one row per occurrence) by canonical destination id
 * into a plain serializable attribution map (no Map/Set — R1-M2).
 * @param {Array<{target,label,container,layer,state,role}>} liveEvidence
 * @returns {Object<string,{placements:Array,layers:string[],states:string[]}>}
 */
export function attributeLive(liveEvidence) {
  const out = Object.create(null); // null-proto: live-derived dest ids as keys
  for (const e of liveEvidence || []) {
    if (!e || !e.target) continue;
    const id = e.target;
    if (!out[id]) out[id] = { placements: [], _layers: new Set(), _states: new Set() };  // out is null-proto (see init)
    out[id].placements.push({ container: e.container ?? null, layer: e.layer ?? null, state: e.state ?? null, role: e.role ?? null });
    if (e.layer) out[id]._layers.add(e.layer);
    if (e.state) out[id]._states.add(e.state);
  }
  for (const id of Object.keys(out)) {
    out[id].layers = [...out[id]._layers].sort();
    out[id].states = [...out[id]._states].sort();
    delete out[id]._layers; delete out[id]._states;
  }
  return out;
}

/**
 * Capture-completeness aggregation (v1.4). Decides which nav LAYERS we could not
 * verify, so the scorecard/findings can degrade to `unverified` instead of
 * emitting an authoritative verdict on data we failed to capture. Pure.
 *
 * @param {Object<string, Object<string,'visible'|'hidden'|'absent'>>} presenceByState
 *   per-state, per-declared-selector visibility-aware presence.
 * @param {Set<string>|string[]} placedContainers - declared selectors that produced ≥1 placement.
 * @param {Array<{selector:string, layer:string}>} selLayers
 * @returns {{captureStatus: Object<string,'captured'|'empty'|'hidden'|'absent'>, unverifiableLayers: string[], absentDeclared: string[]}}
 */
export function computeCaptureStatus(presenceByState, placedContainers, selLayers = []) {
  const placed = placedContainers instanceof Set ? placedContainers : new Set(placedContainers || []);
  const selectors = [...new Set(selLayers.map((s) => s.selector))];
  // null-proto: keys are contract-derived selectors/layer names — avoid any
  // `__proto__`/`constructor` pollution from an adversarial contract.
  const captureStatus = Object.create(null);
  for (const sel of selectors) {
    let anyVisible = false; let anyHidden = false;
    for (const st of Object.values(presenceByState || {})) {
      const v = st?.[sel];
      if (v === 'visible') anyVisible = true;
      else if (v === 'hidden') anyHidden = true;
    }
    if (placed.has(sel)) captureStatus[sel] = 'captured';
    else if (anyVisible) captureStatus[sel] = 'empty';   // present + visible but no affordance = stall
    else if (anyHidden) captureStatus[sel] = 'hidden';   // present but display:none = responsive variant
    else captureStatus[sel] = 'absent';                  // never present
  }
  // Layer unverifiable iff ANY container is `empty` (stall) OR NO container is `captured`.
  const byLayer = Object.create(null);
  for (const { selector, layer } of selLayers) (byLayer[layer] ||= []).push(captureStatus[selector]);
  const unverifiableLayers = [];
  for (const [layer, statuses] of Object.entries(byLayer)) {
    if (statuses.includes('empty') || !statuses.includes('captured')) unverifiableLayers.push(layer);
  }
  const absentDeclared = selectors.filter((s) => captureStatus[s] === 'absent');
  return { captureStatus, unverifiableLayers, absentDeclared };
}

/**
 * Merge live attribution into scorecard rows (the §4a/Gemini precedence rule).
 * @param {object[]} rows - from personaScorecard (static rows)
 * @param {object} attribution - from attributeLive()
 * @param {object} opts
 * @param {string[]} opts.statesRequested
 * @param {string[]} opts.statesCollected
 * @returns {object[]} rows with live verdicts merged
 */
export function mergeScorecard(rows, attribution, { statesRequested = [], statesCollected = [], unverifiableLayers = [] } = {}) {
  const fullCoverage = statesRequested.length > 0 && statesRequested.every((s) => statesCollected.includes(s));
  const unv = unverifiableLayers instanceof Set ? unverifiableLayers : new Set(unverifiableLayers || []);
  // Match destinations with the SAME slug↔path tolerance reconcile() uses
  // (a live `/pairing` must match a contract slug `pairing`) — build a
  // canon-keyed lookup once.
  const canon = (d) => String(d).replace(/^\//, '');
  const byCanon = Object.create(null); // null-proto: live dest ids as keys (prototype-pollution-safe)
  for (const [k, v] of Object.entries(attribution || {})) {
    const ck = canon(k);
    if (!byCanon[ck]) byCanon[ck] = { placements: [], layers: new Set(), states: new Set() };
    byCanon[ck].placements.push(...v.placements);
    (v.layers || []).forEach((l) => byCanon[ck].layers.add(l));
    (v.states || []).forEach((s) => byCanon[ck].states.add(s));
  }
  return rows.map((r) => {
    const c = byCanon[canon(r.destination)];
    const attr = c ? { placements: c.placements, layers: [...c.layers].sort(), states: [...c.states].sort() } : undefined;
    const placements = attr?.placements ?? [];
    let status;
    let observedLayers = [];
    let states = [];
    // v1.4 capture honesty: a required layer we couldn't capture (stalled, or never
    // observable) can't ground an authoritative misplaced/missing verdict.
    const reqUnverifiable = r.requiredInLayer && unv.has(r.requiredInLayer);
    if (placements.length === 0) {
      if (r.requiredInLayer) {
        // No placement + the required layer is unverifiable → can't assert missing.
        status = reqUnverifiable ? STATUS.UNVERIFIED : (fullCoverage ? STATUS.MISSING : STATUS.UNVERIFIED);
      } else {
        // Unpinned (reachability): no placement + SOME layer unverifiable → the dest
        // could live in an uncaptured layer; can't assert missing (v1.4 H3).
        status = unv.size > 0 ? STATUS.UNVERIFIED : (fullCoverage ? STATUS.MISSING : STATUS.UNVERIFIED);
      }
    } else {
      observedLayers = attr.layers ?? [];
      states = attr.states ?? [];
      if (r.requiredInLayer) {
        if (placements.some((p) => p.layer === r.requiredInLayer)) status = STATUS.PASS;
        // Wrong layer → misplaced ONLY under full coverage with a verifiable required
        // layer; partial coverage OR an unverifiable layer can't assert misplaced (a
        // not-yet-collected state may place it correctly) → unverified.
        else if (reqUnverifiable || !fullCoverage) status = STATUS.UNVERIFIED;
        else status = STATUS.MISPLACED;
      } else {
        status = STATUS.PASS; // reachable via a live link (reachability, not placement — Gemini2-2)
      }
    }
    return { ...r, status, live: true, observedLayers, states };
  });
}
