/**
 * @fileoverview The 10-class nav findings taxonomy (plan §4a.C). Each finding
 * carries P0–P3 severity, the destination, evidence, confidence, and a one-line
 * "offered vs needed" verdict. Only classes 2 (coverage gap) and 10 (anchor
 * regression) — declared-intent regressions — are hard-gate-eligible; all others
 * are advisory (plan §4/§5).
 *
 * FP guards are first-class: each class names the trap it neutralises so the
 * negative-fixture test can prove the guard suppresses it.
 *
 * @module scripts/lib/nav/findings
 */
import { isUtilityRoute } from './contract.mjs';
import { mergeScorecard, STATUS } from './live-attribution.mjs';

const PROMINENT_LAYERS = new Set(['primary', 'secondary']);

/**
 * @param {object} model - from buildModel()
 * @param {object} args
 * @param {object|null} args.contract
 * @param {Map<string, object>} [args.routeMeta] - destination id → navMeta fields (deepLinkOnly/utility/terminal/abVariant)
 * @param {object|null} [args.baseModel] - prior model for regression (class 10)
 * @returns {Array<{class: string, severity: 'P0'|'P1'|'P2'|'P3', destination: string, evidence: string[], confidence: string, gateEligible: boolean, verdict: string}>}
 */
export function runTaxonomy(model, { contract = null, routeMeta = new Map(), baseModel = null } = {}) {
  const findings = [];
  const dests = model.destinations;

  // Is anchor attribution FUNCTIONAL for this app? (i.e. did the contract's
  // declared anchors actually match any edges?) On vanilla/template apps with no
  // exported nav components and no declared DOM-container anchors, NOTHING gets a
  // layer — so coverage-gap/anchor-regression would be all false positives
  // (feedback #1/#5). When non-functional, those classes degrade to a SINGLE
  // advisory note instead of per-persona FP gates.
  const anchorsFunctional = [...dests.values()].some((d) => d.anchors.size > 0);
  const hasPrimaryLayer = Object.values(contract?.navLayers ?? {}).some((a) => Array.isArray(a) && a.length)
    && Object.keys(contract?.navLayers ?? {}).includes('primary');

  // 1 — redundancy / over-exposure
  for (const d of dests.values()) {
    const prominentAnchors = [...d.anchors].filter((a) => PROMINENT_LAYERS.has(model.layerOfAnchor.get(a)));
    if (prominentAnchors.length >= 2) {
      const justified = isHighFrequencyIntent(contract, d.id);
      findings.push(mk(justified ? 'P3' : 'P2', 'redundancy', d.id,
        [`reachable from ${prominentAnchors.length} prominent anchors: ${prominentAnchors.join(', ')}`],
        confidenceOf(d), false,
        justified ? 'offered redundantly but justified by declared high-frequency intent'
                  : 'offered from multiple prime anchors — burns nav real estate'));
    }
  }

  // 2 — coverage gap (declared intent not in its required layer) — GATE-ELIGIBLE,
  // but ONLY when anchor attribution is functional (else it's all FP — feedback #1/#5).
  if (!anchorsFunctional && declaredIntents(contract).some((i) => i.requiredInLayer)) {
    findings.push(mk('P3', 'anchor-attribution-unavailable', '(all)',
      ['no edge was attributed to a declared nav anchor — coverage-gap/regression not evaluated. Declare DOM-container anchors (e.g. `#primary-nav`) in navLayers for vanilla/template apps, or component anchors for React.'],
      'high', false,
      'cannot judge offered-vs-needed: the nav-layer model does not fit this app yet'));
  } else if (anchorsFunctional) {
    for (const intent of declaredIntents(contract)) {
      if (!intent.requiredInLayer) continue;
      const d = dests.get(intent.destination);
      if (!d || d.inDegree === 0) continue; // destination not discovered/reached → recall miss, not a coverage gap
      const anchors = [...d.anchors];
      const reachableInLayer = anchors.some((a) => model.layerOfAnchor.get(a) === intent.requiredInLayer);
      if (reachableInLayer) continue;
      if (anchors.length === 0) {
        // Reached, but via dynamic nav we couldn't attribute to any anchor — we
        // CANNOT assert it's missing from the required layer (it usually isn't).
        // Advisory, NOT a gate (feedback #1/#5 — the data-driven-nav case).
        findings.push(mk('P3', 'coverage-unverified', intent.destination,
          [`declared intent '${intent.id}' is reached, but its nav anchor is dynamic/undeterminable statically — run --verify <url> to confirm it's in '${intent.requiredInLayer}'`],
          'low', false,
          `likely offered (reached at runtime) but static analysis can't place the layer`));
      } else {
        // Reached from a real anchor, just not the required layer — genuine gap.
        findings.push(mk('P1', 'coverage-gap', intent.destination,
          [`declared intent '${intent.id}' reached from ${anchors.join('/')} but not a '${intent.requiredInLayer}' anchor`],
          'high', true,
          `needed in ${intent.requiredInLayer} for the persona but not offered there`));
      }
    }
  }

  // 3 — orphan (zero inbound) — guarded by deepLinkOnly/utility classification.
  // Dynamic-nav guard (feedback): when a large fraction of DISCOVERED destinations
  // have zero static inbound edges, the app drives nav from data (data-view /
  // switchView(var)) and per-view orphan findings are unreliable — roll them up
  // into ONE advisory pointing at --verify, rather than N false orphans.
  const discovered = [...dests.values()].filter((d) => d.discovered);
  const zeroIn = discovered.filter((d) => d.inDegree === 0 && !isUtilityRoute(d.id) && !(routeMeta.get(d.id)?.deepLinkOnly || routeMeta.get(d.id)?.utility));
  const dynamicDominated = discovered.length >= 5 && zeroIn.length / discovered.length > 0.4;
  if (dynamicDominated) {
    findings.push(mk('P3', 'dynamic-nav-detected', `(${zeroIn.length} views)`,
      [`${zeroIn.length} of ${discovered.length} discovered views have no static inbound edge (e.g. ${zeroIn.slice(0, 4).map((d) => d.id).join(', ')}…) — this app drives nav from data (data-view/switchView(var)). Static orphan/coverage findings are unreliable here; run --verify <url> to confirm reachability.`],
      'medium', false,
      'data-driven nav: static recall is limited — use --verify'));
  } else {
    for (const d of dests.values()) {
      if (d.inDegree > 0) continue;
      const meta = routeMeta.get(d.id) ?? {};
      if (meta.deepLinkOnly || meta.utility || isUtilityRoute(d.id)) continue; // FP guard
      findings.push(mk('P2', 'orphan', d.id,
        ['no inbound navigation edges'], 'medium', false,
        'a destination exists but nothing offers it'));
    }
  }

  // 4 — dead-end (a destination/view that emits no outbound nav). SUPPRESSED when
  // the app has a global/persistent primary nav layer — then no view is terminal,
  // so this would be all FP (feedback #6).
  if (!hasPrimaryLayer) {
    const emitters = new Set(model.edges.map((e) => e.entryPoint));
    for (const d of dests.values()) {
      const meta = routeMeta.get(d.id) ?? {};
      if (meta.terminal) continue; // FP guard: declared wizard-final
      const viewName = d.id.replace(/^.*[/#]/, '');
      if (viewName && !emitters.has(viewName) && d.inDegree > 0 && /[A-Za-z]/.test(viewName) && !d.id.includes('/')) {
        findings.push(mk('P3', 'dead-end', d.id,
          ['view offers no onward navigation'], 'low', false,
          'reachable but offers no next action'));
      }
    }
  }

  // 5 — semantic/label inconsistency (same label → different destinations)
  const labelToDest = new Map();
  for (const e of model.edges) {
    if (!e.label) continue; // FP guard: skip unresolved labels
    if (!labelToDest.has(e.label)) labelToDest.set(e.label, new Set());
    labelToDest.get(e.label).add(e.destination);
  }
  for (const [label, ds] of labelToDest) {
    if (ds.size >= 2) {
      findings.push(mk('P3', 'label-inconsistency', [...ds][0],
        [`label "${label}" maps to ${ds.size} destinations: ${[...ds].join(', ')}`], 'medium', false,
        'one label offers different destinations — ambiguous'));
    }
  }

  // 6 — surprising mapping (label tokens absent from destination id)
  for (const e of model.edges) {
    if (!e.label || e.destination === '<dynamic>') continue;
    const tokens = e.label.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
    if (tokens.length && !tokens.some((t) => e.destination.toLowerCase().includes(t))) {
      findings.push(mk('P3', 'surprising-mapping', e.destination,
        [`label "${e.label}" does not match destination ${e.destination}`], 'low', false,
        'control label does not match where it leads'));
    }
  }

  // 7 — competing nav models (≥2 prominent layers partitioning destinations disjointly)
  const layerSets = layerDestinationSets(model);
  const prominent = [...layerSets.entries()].filter(([l]) => PROMINENT_LAYERS.has(l));
  if (prominent.length >= 2) {
    const [[la, sa], [lb, sb]] = prominent;
    const overlap = [...sa].filter((x) => sb.has(x));
    if (sa.size >= 2 && sb.size >= 2 && overlap.length === 0) {
      findings.push(mk('P2', 'competing-models', `${la}|${lb}`,
        [`layers '${la}' and '${lb}' group destinations disjointly`], 'medium', false,
        'two nav systems organise the app differently — unreconciled'));
    }
  }

  // 8 — sequencing/prominence (high-freq intent only via low-prominence affordance)
  for (const intent of declaredIntents(contract)) {
    if (intent.frequency !== 'high') continue;
    const d = dests.get(intent.destination);
    if (!d) continue;
    const hasProminent = [...d.anchors].some((a) => PROMINENT_LAYERS.has(model.layerOfAnchor.get(a)));
    if (!hasProminent) {
      findings.push(mk('P2', 'sequencing', intent.destination,
        [`high-frequency intent '${intent.id}' reachable only via low-prominence affordances`], 'medium', false,
        'most-needed destination is not most-prominent (Hick)'));
    }
  }

  // 9 — state/onboarding overlap (≥2 onboarding affordances to same destination)
  const onboardingByDest = new Map();
  for (const e of model.edges) {
    const isOnboarding = /onboard|getting.?started|welcome/i.test(e.label ?? '');
    if (!isOnboarding) continue;
    if (!onboardingByDest.has(e.destination)) onboardingByDest.set(e.destination, []);
    onboardingByDest.get(e.destination).push(e);
  }
  for (const [dest, es] of onboardingByDest) {
    const variants = new Set(es.map((e) => routeMeta.get(dest)?.abVariant ?? null));
    if (es.length >= 2 && variants.size <= 1) { // FP guard: declared A/B variants
      findings.push(mk('P3', 'onboarding-overlap', dest,
        [`${es.length} onboarding affordances target ${dest}`], 'low', false,
        'multiple surfaces for the same onboarding job can disagree'));
    }
  }

  // 10 — anchor-reachability regression — GATE-ELIGIBLE (needs base model + functional anchors)
  if (baseModel && anchorsFunctional) {
    for (const intent of declaredIntents(contract)) {
      const before = baseModel.destinations.get(intent.destination);
      const after = dests.get(intent.destination);
      if (!before) continue;
      for (const approved of intent.approvedAnchors) {
        const had = before.anchors.has(approved);
        const has = after && after.anchors.has(approved);
        if (had && !has) {
          findings.push(mk('P0', 'anchor-regression', intent.destination,
            [`declared intent '${intent.id}' lost approved anchor '${approved}'`], 'high', true,
            `a path the persona needs was removed`));
        }
      }
    }
  }

  return findings;
}

const PROMINENT_FOR_SCORECARD = new Set(['primary', 'secondary']);

/**
 * Per-(persona,intent) reachability scorecard (plan §3). Shared by the CLI report
 * and the dashboard panel. Returns `anchorsFunctional:false` when the nav-layer
 * model doesn't fit the app (so callers can show the honest caveat, not red FPs).
 * @param {object} model
 * @param {object|null} contract
 * @returns {{anchorsFunctional: boolean, rows: object[]}}
 */
export function personaScorecard(model, contract, opts = {}) {
  const anchorsFunctional = [...model.destinations.values()].some((d) => d.anchors.size > 0);
  const rows = [];
  for (const p of contract?.personas ?? []) {
    for (const intent of p.intents ?? []) {
      const d = model.destinations.get(intent.destination);
      const observedAnchors = d ? [...d.anchors] : [];
      const inProminent = observedAnchors.some((a) => PROMINENT_FOR_SCORECARD.has(model.layerOfAnchor.get(a)));
      const requiredOk = !intent.requiredInLayer
        || observedAnchors.some((a) => model.layerOfAnchor.get(a) === intent.requiredInLayer);
      const reached = !!d && d.inDegree > 0;
      let status;
      if (!anchorsFunctional) status = 'unknown';                       // model doesn't fit this app
      else if (requiredOk && (intent.frequency !== 'high' || inProminent)) status = 'ok';
      else if (observedAnchors.length > 0) status = 'red';              // reached from a REAL anchor, wrong layer → genuine gap
      else status = 'unverified';                                       // no static anchor (dynamic nav / not statically reached) — can't assert
      rows.push({
        persona: p.id, intent: intent.id, destination: intent.destination,
        expectedAnchors: intent.approvedAnchors, observedAnchors,
        requiredInLayer: intent.requiredInLayer, frequency: intent.frequency,
        source: intent.source, reached, status,
      });
    }
  }
  // Live mode (plan v1.1 §4a): when --verify supplied a live-DOM attribution map,
  // the live verdict REPLACES the static status (pass/misplaced/missing).
  if (opts.liveAttribution) {
    const merged = mergeScorecard(rows, opts.liveAttribution, {
      statesRequested: opts.statesRequested ?? [],
      statesCollected: opts.statesCollected ?? [],
    });
    return { anchorsFunctional, rows: merged, live: true };
  }
  return { anchorsFunctional, rows };
}

function mk(severity, klass, destination, evidence, confidence, gateEligible, verdict) {
  return { class: klass, severity, destination: String(destination), evidence, confidence, gateEligible, verdict };
}

function declaredIntents(contract) {
  if (!contract?.personas) return [];
  return contract.personas.flatMap((p) => (p.intents ?? []).map((i) => ({ ...i, personaId: p.id })));
}

function isHighFrequencyIntent(contract, destId) {
  return declaredIntents(contract).some((i) => i.destination === destId && i.frequency === 'high');
}

function confidenceOf(dest) {
  // Worst-case confidence across the destination's edges.
  if (dest.edges.some((e) => e.confidence === 'low')) return 'low';
  if (dest.edges.some((e) => e.confidence === 'medium')) return 'medium';
  return 'high';
}

function layerDestinationSets(model) {
  const map = new Map();
  for (const e of model.edges) {
    if (!map.has(e.layer)) map.set(e.layer, new Set());
    map.get(e.layer).add(e.destination);
  }
  return map;
}
