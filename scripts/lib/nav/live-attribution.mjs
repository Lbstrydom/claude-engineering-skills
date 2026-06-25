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
  const out = {};
  for (const e of liveEvidence || []) {
    if (!e || !e.target) continue;
    const id = e.target;
    if (!out[id]) out[id] = { placements: [], _layers: new Set(), _states: new Set() };
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
 * Merge live attribution into scorecard rows (the §4a/Gemini precedence rule).
 * @param {object[]} rows - from personaScorecard (static rows)
 * @param {object} attribution - from attributeLive()
 * @param {object} opts
 * @param {string[]} opts.statesRequested
 * @param {string[]} opts.statesCollected
 * @returns {object[]} rows with live verdicts merged
 */
export function mergeScorecard(rows, attribution, { statesRequested = [], statesCollected = [] } = {}) {
  const fullCoverage = statesRequested.length > 0 && statesRequested.every((s) => statesCollected.includes(s));
  // Match destinations with the SAME slug↔path tolerance reconcile() uses
  // (a live `/pairing` must match a contract slug `pairing`) — build a
  // canon-keyed lookup once.
  const canon = (d) => String(d).replace(/^\//, '');
  const byCanon = {};
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
    if (placements.length === 0) {
      // No live placement: assert `missing` ONLY under full coverage (Gemini2-1);
      // a partial run can't distinguish absent from unobserved.
      status = fullCoverage ? STATUS.MISSING : STATUS.UNVERIFIED;
    } else {
      observedLayers = attr.layers ?? [];
      states = attr.states ?? [];
      if (r.requiredInLayer) {
        status = placements.some((p) => p.layer === r.requiredInLayer) ? STATUS.PASS : STATUS.MISPLACED;
      } else {
        status = STATUS.PASS; // reachable via a live link (reachability, not placement — Gemini2-2)
      }
    }
    return { ...r, status, live: true, observedLayers, states };
  });
}
