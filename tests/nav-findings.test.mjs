/**
 * Cluster A — findings taxonomy (plan §4a.C). Each guarded class has a positive
 * AND a negative fixture: the negative proves the FP guard suppresses the trap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../scripts/lib/nav/model.mjs';
import { runTaxonomy } from '../scripts/lib/nav/findings.mjs';

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
  it('flags a declared intent not reachable in its required layer', () => {
    const m = model([edge({ destination: '/admin/users/:param', entryPoint: 'SomeButton' })]);
    const f = runTaxonomy(m, { contract });
    const cg = f.find((x) => x.class === 'coverage-gap');
    assert.ok(cg);
    assert.equal(cg.gateEligible, true);
    assert.equal(cg.severity, 'P1');
  });

  it('does NOT flag when reachable in the required layer', () => {
    // edge emitted by PrimarySidebar → attributed to primary layer
    const sources = [{ path: 'n.tsx', content: `export function PrimarySidebar(){ return <a href="/admin/users/1"/>; }` }];
    const m = model([edge({ destination: '/admin/users/:param', entryPoint: 'PrimarySidebar' })], sources);
    const f = runTaxonomy(m, { contract });
    assert.equal(f.some((x) => x.class === 'coverage-gap'), false);
  });
});

describe('anchor-reachability regression (class 10) — gate-eligible', () => {
  it('flags when a declared intent loses its approved anchor vs base', () => {
    const base = model([edge({ destination: '/admin/users/:param', entryPoint: 'PrimarySidebar' })],
      [{ path: 'n.tsx', content: `export function PrimarySidebar(){ return <a href="/admin/users/1"/>; }` }]);
    const head = model([edge({ destination: '/admin/users/:param', entryPoint: 'ObscureMenu' })]);
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
