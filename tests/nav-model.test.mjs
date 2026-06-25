/**
 * Cluster A — model: anchor attribution via render-containment (plan §2.3).
 * Tier-1 deterministic seam.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../scripts/lib/nav/model.mjs';

const contract = {
  version: 1,
  navLayers: { primary: ['PrimarySidebar'], secondary: ['SettingsContext'] },
  personas: [],
};

function edge(over) {
  return {
    entryPoint: 'NavItem', layer: 'content', anchor: null,
    affordanceType: 'link', label: 'Wines', destination: '/wines',
    confidence: 'high', sourceLoc: 'x.tsx:1', ...over,
  };
}

describe('buildModel anchor attribution', () => {
  it('attributes the edge to the nearest declared-anchor ANCESTOR through composition', () => {
    // PrimarySidebar -> NavGroup -> NavItem (which emits the <a>)
    const sources = [{
      path: 'nav.tsx',
      content: `
export function PrimarySidebar(){ return <NavGroup/>; }
export function NavGroup(){ return <NavItem/>; }
export function NavItem(){ return <a href="/wines">Wines</a>; }`,
    }];
    const model = buildModel([edge()], { contract, sources });
    const d = model.destinations.get('/wines');
    assert.ok(d.anchors.has('PrimarySidebar'), 'should attribute to PrimarySidebar via containment');
    assert.equal(d.layers.has('primary'), true);
  });

  it('downgrades confidence for deep composition chains', () => {
    const sources = [{
      path: 'nav.tsx',
      content: `
export function PrimarySidebar(){ return <A/>; }
export function A(){ return <B/>; }
export function B(){ return <NavItem/>; }
export function NavItem(){ return <a href="/wines">Wines</a>; }`,
    }];
    const model = buildModel([edge()], { contract, sources });
    assert.equal(model.edges[0].confidence, 'medium'); // depth >= 2 downgrades high→medium
  });

  it('leaves anchor null when no declared anchor renders the emitter', () => {
    const sources = [{ path: 'x.tsx', content: `export function Random(){ return <a href="/wines"/>; }` }];
    const model = buildModel([edge({ entryPoint: 'Random' })], { contract, sources });
    assert.equal(model.destinations.get('/wines').anchors.size, 0);
  });

  it('attributes ALL declared-anchor ancestors, not just the nearest (audit H8)', () => {
    // NavItem is rendered under BOTH PrimarySidebar and SettingsContext.
    const sources = [{
      path: 'nav.tsx',
      content: `
export function PrimarySidebar(){ return <NavItem/>; }
export function SettingsContext(){ return <NavItem/>; }
export function NavItem(){ return <a href="/wines">Wines</a>; }`,
    }];
    const model = buildModel([edge()], { contract, sources });
    const d = model.destinations.get('/wines');
    assert.ok(d.anchors.has('PrimarySidebar'));
    assert.ok(d.anchors.has('SettingsContext'));
  });

  it('seeds zero-inbound discovered routes (audit H3/H10)', () => {
    const model = buildModel([], { contract, destinations: [{ id: '/lonely' }] });
    assert.ok(model.destinations.has('/lonely'));
    assert.equal(model.destinations.get('/lonely').inDegree, 0);
  });

  it('computes in-degree and affordance histogram', () => {
    const model = buildModel(
      [edge(), edge({ affordanceType: 'navigate-call', entryPoint: 'PrimarySidebar' })],
      { contract, sources: [] }
    );
    const d = model.destinations.get('/wines');
    assert.equal(d.inDegree, 2);
    assert.equal(d.affordanceTypes.has('link'), true);
    assert.equal(d.affordanceTypes.has('navigate-call'), true);
  });
});
