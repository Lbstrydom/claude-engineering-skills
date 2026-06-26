/**
 * v1.3 #4 — the layer-attribution finding classes run over LIVE evidence
 * (plan §4a). Tier-1 deterministic: plain liveAttribution fixtures, no browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { liveLayerSets, runLiveTaxonomy } from '../scripts/lib/nav/findings.mjs';

const P = (container, layer, state) => ({ container, layer, state, role: null });

describe('liveLayerSets (per-state, v1.3)', () => {
  const attr = {
    wines: { placements: [P('#primary-nav', 'primary', 'mobile'), P('.sub', 'secondary', 'desktop')] },
    grid: { placements: [P('.sub', 'secondary', 'mobile')] },
  };
  it('builds layerData for ONE state only', () => {
    const m = liveLayerSets(attr, { state: 'mobile' });
    assert.deepEqual([...m.layerSets.get('primary')], ['wines']);
    assert.deepEqual([...m.layerSets.get('secondary')], ['grid']);
    assert.equal(m.layerOfAnchor.get('#primary-nav'), 'primary');
    assert.deepEqual([...m.destAnchors.get('wines')], ['#primary-nav']);
  });
  it('a different state yields a different (non-unioned) view', () => {
    const d = liveLayerSets(attr, { state: 'desktop' });
    assert.equal(d.layerSets.has('primary'), false); // wines is primary only at mobile
    assert.deepEqual([...d.layerSets.get('secondary')], ['wines']);
  });
});

describe('runLiveTaxonomy (layer classes over live evidence)', () => {
  it('fires over-exposure (redundancy) for a dest in ≥2 prominent anchors in ONE state, source:live', () => {
    const attr = { wines: { placements: [P('#primary-nav', 'primary', 'm'), P('.sub', 'secondary', 'm')] } };
    const f = runLiveTaxonomy(attr, null, { states: ['m'] });
    const r = f.find((x) => x.class === 'redundancy' && x.destination === 'wines');
    assert.ok(r, 'redundancy must fire');
    assert.equal(r.source, 'live');
  });

  it('fires competing-models when two prominent layers partition disjointly (same state)', () => {
    const attr = {
      a: { placements: [P('#p', 'primary', 'm')] }, b: { placements: [P('#p', 'primary', 'm')] },
      c: { placements: [P('#s', 'secondary', 'm')] }, d: { placements: [P('#s', 'secondary', 'm')] },
    };
    const f = runLiveTaxonomy(attr, null, { states: ['m'] });
    const cm = f.find((x) => x.class === 'competing-models');
    assert.ok(cm, 'competing-models must fire');
    assert.equal(cm.destination, 'primary|secondary');
    assert.equal(cm.source, 'live');
  });

  it('STATE-SCOPING: responsive duplication (primary@mobile + secondary@desktop) does NOT fire (R2-H1)', () => {
    const attr = {
      x: { placements: [P('#primary-nav', 'primary', 'mobile'), P('.sub', 'secondary', 'desktop')] },
      y: { placements: [P('#primary-nav', 'primary', 'mobile'), P('.sub', 'secondary', 'desktop')] },
    };
    const f = runLiveTaxonomy(attr, null, { states: ['mobile', 'desktop'] });
    assert.equal(f.filter((x) => x.class === 'redundancy').length, 0, 'no over-exposure across viewports');
    assert.equal(f.filter((x) => x.class === 'competing-models').length, 0, 'no competing-models across viewports');
  });

  it('same-state two-layer membership DOES fire over-exposure (the genuine case)', () => {
    const attr = { z: { placements: [P('#primary-nav', 'primary', 'mobile'), P('.sub', 'secondary', 'mobile')] } };
    const f = runLiveTaxonomy(attr, null, { states: ['mobile'] });
    assert.ok(f.some((x) => x.class === 'redundancy' && x.destination === 'z'));
  });

  it('fires sequencing for a high-frequency intent reached only via a non-prominent layer', () => {
    const attr = { slow: { placements: [P('#footer', 'footer', 'm')] } };
    const contract = { personas: [{ id: 'p', intents: [{ id: 'i', destination: 'slow', frequency: 'high' }] }] };
    const f = runLiveTaxonomy(attr, contract, { states: ['m'] });
    assert.ok(f.some((x) => x.class === 'sequencing' && x.destination === 'slow'));
  });

  it('dedupes a finding seen in multiple states by (class, destination)', () => {
    const attr = { z: { placements: [
      P('#primary-nav', 'primary', 'mobile'), P('.sub', 'secondary', 'mobile'),
      P('#primary-nav', 'primary', 'desktop'), P('.sub', 'secondary', 'desktop'),
    ] } };
    const f = runLiveTaxonomy(attr, null, { states: ['mobile', 'desktop'] });
    assert.equal(f.filter((x) => x.class === 'redundancy' && x.destination === 'z').length, 1);
  });

  it('does NOT emit static-graph classes (orphan / coverage-gap) from live', () => {
    const attr = { wines: { placements: [P('#primary-nav', 'primary', 'm')] } };
    const f = runLiveTaxonomy(attr, null, { states: ['m'] });
    assert.equal(f.some((x) => ['orphan', 'coverage-gap', 'surprising-mapping', 'anchor-regression'].includes(x.class)), false);
  });

  it('empty/no-evidence → no findings, no throw', () => {
    assert.deepEqual(runLiveTaxonomy({}, null, { states: [] }), []);
    assert.deepEqual(runLiveTaxonomy(null, null, {}), []);
  });
});
