/**
 * Cluster A — findings taxonomy (plan §4a.C). Each guarded class has a positive
 * AND a negative fixture: the negative proves the FP guard suppresses the trap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../scripts/lib/nav/model.mjs';
import { runTaxonomy, personaScorecard } from '../scripts/lib/nav/findings.mjs';

const contract = {
  version: 1,
  navLayers: { primary: ['PrimarySidebar'], secondary: ['SettingsContext'] },
  personas: [{
    id: 'admin',
    intents: [
      { id: 'revoke', destination: '/admin/users/:param', approvedAnchors: ['PrimarySidebar'], requiredInLayer: 'primary', frequency: 'high', source: 'declared' },
    ],
  }],
};

function model(edges, sources = [], destinations = []) {
  return buildModel(edges, { contract, sources, destinations });
}
function edge(over) {
  return { entryPoint: 'X', layer: 'content', anchor: null, affordanceType: 'link', label: null, destination: '/wines', confidence: 'high', sourceLoc: 'x:1', ...over };
}

describe('orphan (class 3) + FP guard', () => {
  it('flags a discovered product route with zero inbound edges', () => {
    // /secret-report is in the discovered inventory but has no inbound edge —
    // the model must seed it (audit H3/H10) so orphan detection can fire.
    const m = model([edge()], [], [{ id: '/secret-report' }]);
    const f = runTaxonomy(m, { contract });
    assert.ok(f.some((x) => x.class === 'orphan' && x.destination === '/secret-report'));
  });

  it('SUPPRESSES orphan for a utility route (FP guard)', () => {
    const m = model([], [], [{ id: '/oauth/callback' }]);
    const f = runTaxonomy(m, { contract });
    assert.equal(f.some((x) => x.class === 'orphan' && x.destination === '/oauth/callback'), false);
  });

  it('SUPPRESSES orphan when navMeta.deepLinkOnly is set (FP guard)', () => {
    const m = model([], [], [{ id: '/share/:param' }]);
    const routeMeta = new Map([['/share/:param', { deepLinkOnly: true }]]);
    const f = runTaxonomy(m, { contract, routeMeta });
    assert.equal(f.some((x) => x.class === 'orphan'), false);
  });
});

describe('coverage gap (class 2) — gate-eligible', () => {
  it('flags a declared intent reached but NOT from its required layer (functional anchors)', () => {
    // /admin/users IS reached, but from SettingsContext (secondary), not primary.
    const m = model([edge({ destination: '/admin/users/:param', anchor: 'SettingsContext' })]);
    const f = runTaxonomy(m, { contract });
    const cg = f.find((x) => x.class === 'coverage-gap');
    assert.ok(cg, 'expected coverage-gap');
    assert.equal(cg.gateEligible, true);
    assert.equal(cg.severity, 'P1');
  });

  it('degrades to an ADVISORY note (not per-persona FP gates) when no anchors are attributable', () => {
    // vanilla-style: edge attributed to nothing → anchor model non-functional.
    const m = model([edge({ destination: '/admin/users/:param', entryPoint: 'SomeButton' })]);
    const f = runTaxonomy(m, { contract });
    assert.equal(f.some((x) => x.class === 'coverage-gap'), false);
    const note = f.find((x) => x.class === 'anchor-attribution-unavailable');
    assert.ok(note, 'expected the anchor-attribution-unavailable advisory');
    assert.equal(note.gateEligible, false);
  });

  it('does NOT flag when reachable in the required layer', () => {
    const m = model([edge({ destination: '/admin/users/:param', anchor: 'PrimarySidebar' })]);
    const f = runTaxonomy(m, { contract });
    assert.equal(f.some((x) => x.class === 'coverage-gap'), false);
  });
});

describe('anchor-reachability regression (class 10) — gate-eligible', () => {
  it('flags when a declared intent loses its approved anchor vs base', () => {
    const base = model([edge({ destination: '/admin/users/:param', anchor: 'PrimarySidebar' })]);
    // head: /admin/users lost PrimarySidebar; a second edge keeps anchors functional.
    const head = model([
      edge({ destination: '/admin/users/:param', anchor: null, entryPoint: 'ObscureMenu' }),
      edge({ destination: '/wines', anchor: 'PrimarySidebar' }),
    ]);
    const f = runTaxonomy(head, { contract, baseModel: base });
    const reg = f.find((x) => x.class === 'anchor-regression');
    assert.ok(reg, 'expected a regression finding');
    assert.equal(reg.severity, 'P0');
    assert.equal(reg.gateEligible, true);
  });

  it('does NOT flag when the anchor is retained', () => {
    const sources = [{ path: 'n.tsx', content: `export function PrimarySidebar(){ return <a href="/admin/users/1"/>; }` }];
    const base = model([edge({ destination: '/admin/users/:param', entryPoint: 'PrimarySidebar' })], sources);
    const head = model([edge({ destination: '/admin/users/:param', entryPoint: 'PrimarySidebar' })], sources);
    const f = runTaxonomy(head, { contract, baseModel: base });
    assert.equal(f.some((x) => x.class === 'anchor-regression'), false);
  });
});

describe('dynamic-nav (data-driven) handling (feedback)', () => {
  const contractWithLayers = {
    version: 1, navLayers: { primary: ['#primary-nav'] },
    personas: [{ id: 'p', intents: [{ id: 'i', destination: 'today', approvedAnchors: ['#primary-nav'], requiredInLayer: 'primary', frequency: 'high', source: 'declared' }] }],
  };
  function dynModel(discoveredIds, edges = []) {
    return buildModel(edges, { contract: contractWithLayers, sources: [], destinations: discoveredIds.map((id) => ({ id })) });
  }

  it('rolls up many zero-inbound discovered views into ONE dynamic-nav advisory (not N orphans)', () => {
    const m = dynModel(['today', 'grid', 'wines', 'pairing', 'history', 'journal'], [edge({ destination: 'wines', anchor: '#primary-nav' })]);
    const f = runTaxonomy(m, { contract: contractWithLayers });
    assert.equal(f.filter((x) => x.class === 'orphan').length, 0, 'no per-view orphans');
    assert.ok(f.some((x) => x.class === 'dynamic-nav-detected'));
  });

  it('coverage for a reached-but-unanchored intent is P3 advisory, NOT a P1 gate', () => {
    // 'today' reached (inDegree>0) but via a dynamic edge with no anchor.
    const m = buildModel([edge({ destination: 'today', anchor: null, entryPoint: 'x' }), edge({ destination: 'wines', anchor: '#primary-nav' })],
      { contract: contractWithLayers, sources: [], destinations: [{ id: 'today' }, { id: 'wines' }] });
    const f = runTaxonomy(m, { contract: contractWithLayers });
    assert.ok(!f.some((x) => x.class === 'coverage-gap' && x.gateEligible), 'no false P1 gate');
    assert.ok(f.some((x) => x.class === 'coverage-unverified'), 'expected the advisory instead');
  });

  it('scorecard marks a reached-but-unanchored intent unverified (not red)', () => {
    const m = buildModel([edge({ destination: 'today', anchor: null }), edge({ destination: 'wines', anchor: '#primary-nav' })],
      { contract: contractWithLayers, sources: [], destinations: [{ id: 'today' }, { id: 'wines' }] });
    const { rows } = personaScorecard(m, contractWithLayers);
    assert.equal(rows[0].status, 'unverified');
  });

  it('dead-end is suppressed when a primary nav layer exists', () => {
    const m = dynModel(['today', 'grid'], [edge({ destination: 'today', anchor: '#primary-nav' })]);
    const f = runTaxonomy(m, { contract: contractWithLayers });
    assert.equal(f.some((x) => x.class === 'dead-end'), false);
  });
});

describe('label inconsistency (class 5) + null-label guard', () => {
  it('flags one label mapping to two destinations', () => {
    const m = model([edge({ label: 'Home', destination: '/a' }), edge({ label: 'Home', destination: '/b' })]);
    const f = runTaxonomy(m, { contract });
    assert.ok(f.some((x) => x.class === 'label-inconsistency'));
  });
  it('skips null labels (FP guard)', () => {
    const m = model([edge({ label: null, destination: '/a' }), edge({ label: null, destination: '/b' })]);
    const f = runTaxonomy(m, { contract });
    assert.equal(f.some((x) => x.class === 'label-inconsistency'), false);
  });
});

describe('only declared-intent classes are gate-eligible', () => {
  it('advisory classes are never gateEligible', () => {
    const m = model([edge({ label: 'Home', destination: '/a' }), edge({ label: 'Home', destination: '/b' })]);
    const f = runTaxonomy(m, { contract });
    for (const x of f) {
      if (!['coverage-gap', 'anchor-regression'].includes(x.class)) assert.equal(x.gateEligible, false);
    }
  });
});
