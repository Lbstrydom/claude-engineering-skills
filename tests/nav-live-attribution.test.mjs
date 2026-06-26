/**
 * v1.1 Cluster A — pure live-DOM attribution + scorecard merge (plan §4a).
 * Tier-1 deterministic seam: NO browser. Fixtures are plain liveEvidence arrays.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attributeLive, mergeScorecard, resolveContainer, STATUS } from '../scripts/lib/nav/live-attribution.mjs';
import { extractTarget, normalizeLiveTarget } from '../scripts/lib/nav/verify.mjs';

describe('normalizeLiveTarget origin + slug (R1-H, v1.2)', () => {
  const base = 'https://app.example.com/?view=today';
  it('drops an external-origin absolute URL (no false internal match)', () => {
    assert.equal(normalizeLiveTarget('https://docs.other.com/wines', base), null);
  });
  it('keeps a same-origin absolute URL', () => {
    assert.equal(normalizeLiveTarget('https://app.example.com/wines', base), '/wines');
  });
  it('returns a bare slug verbatim (data-nav-view value)', () => {
    assert.equal(normalizeLiveTarget('today', base), 'today');
  });
  it('resolves a query-param view route', () => {
    assert.equal(normalizeLiveTarget('?view=grid', base), 'grid');
  });
  it('strips a hash-router prefix', () => {
    assert.equal(normalizeLiveTarget('#/wines', base), '/wines');
  });
});

describe('extractTarget (pure, v1.2)', () => {
  it('resolves a data-nav-view button (no href) — the core fix', () => {
    assert.equal(extractTarget({ dataAttrs: { 'nav-view': 'today', 'nav-id': 'today' } }), 'today');
  });
  it('ignores data-nav-id (suffix id ∉ set) and data-auto (false-suffix)', () => {
    assert.equal(extractTarget({ dataAttrs: { 'nav-id': 'x', auto: 'y' } }), null);
  });
  it('prefers a usable href over data-*', () => {
    assert.equal(extractTarget({ href: '/wines', dataAttrs: { view: 'grid' } }), '/wines');
  });
  it('falls through a bare-anchor href to data-* (no regression)', () => {
    assert.equal(extractTarget({ href: '#', dataAttrs: { view: 'today' } }), 'today');
  });
  it('keeps a hash-router href (#/wines)', () => {
    assert.equal(extractTarget({ href: '#/wines' }), '#/wines');
  });
  it('rejects javascript:/mailto: hrefs, falls through', () => {
    assert.equal(extractTarget({ href: 'javascript:void(0)', dataAttrs: { route: 'r' } }), 'r');
  });
  it('returns null for a targetless element', () => {
    assert.equal(extractTarget({ href: null, dataAttrs: { 'nav-id': 'x' } }), null);
  });
  it('priority order: view > target > route > page > tab', () => {
    assert.equal(extractTarget({ dataAttrs: { tab: 't', view: 'v', route: 'r' } }), 'v');
  });
});

const contract = { version: 1, navLayers: { primary: ['#primary-nav'], secondary: ['.sub-tabs-row'] } };

describe('resolveContainer (nearest-wins, R3-M2)', () => {
  it('picks the nearest matched ancestor', () => {
    const r = resolveContainer([{ selector: '.sub-tabs-row', layer: 'secondary', depth: 3 }, { selector: '#primary-nav', layer: 'primary', depth: 1 }], contract);
    assert.deepEqual(r, { selector: '#primary-nav', layer: 'primary' });
  });
  it('breaks a depth tie by explicit layer precedence (primary > secondary)', () => {
    const r = resolveContainer([{ selector: '.sub-tabs-row', layer: 'secondary', depth: 2 }, { selector: '#primary-nav', layer: 'primary', depth: 2 }], contract);
    assert.equal(r.layer, 'primary');
  });
  it('returns null when no selector matched', () => {
    assert.equal(resolveContainer([], contract), null);
  });
});

describe('attributeLive (occurrence-level, serializable — Gemini-1/R1-M2)', () => {
  it('keeps EVERY occurrence (a target linked twice → two placements)', () => {
    const ev = [
      { target: 'wines', container: '#primary-nav', layer: 'primary', state: 'desktop', role: 'navigation' },
      { target: 'wines', container: null, layer: null, state: 'desktop', role: null }, // footer link
    ];
    const a = attributeLive(ev);
    assert.equal(a.wines.placements.length, 2);
    assert.deepEqual(a.wines.layers, ['primary']);
  });
  it('returns plain JSON-serializable objects (no Map/Set)', () => {
    const a = attributeLive([{ target: 'x', container: '#primary-nav', layer: 'primary', state: 'mobile' }]);
    assert.equal(JSON.parse(JSON.stringify(a)).x.placements[0].layer, 'primary');
  });
});

describe('mergeScorecard verdicts (the §4a/Gemini precedence rule)', () => {
  const rows = [{ persona: 'p', intent: 'browse', destination: 'wines', requiredInLayer: 'primary' }];
  const full = { statesRequested: ['mobile', 'desktop'], statesCollected: ['mobile', 'desktop'] };

  it('pass when a placement is in the required layer (any state)', () => {
    const attr = attributeLive([{ target: 'wines', container: '#primary-nav', layer: 'primary', state: 'mobile' }]);
    assert.equal(mergeScorecard(rows, attr, full)[0].status, STATUS.PASS);
  });
  it('misplaced when live but never in the required layer (Gemini-2)', () => {
    const attr = attributeLive([{ target: 'wines', container: '.sub-tabs-row', layer: 'secondary', state: 'desktop' }]);
    assert.equal(mergeScorecard(rows, attr, full)[0].status, STATUS.MISPLACED);
  });
  it('misplaced when live only OUTSIDE any declared layer (container null)', () => {
    const attr = attributeLive([{ target: 'wines', container: null, layer: null, state: 'desktop' }]);
    assert.equal(mergeScorecard(rows, attr, full)[0].status, STATUS.MISPLACED);
  });
  it('missing when no live placement AND full coverage', () => {
    assert.equal(mergeScorecard(rows, {}, full)[0].status, STATUS.MISSING);
  });
  it('unverified (NOT missing) when a requested state failed (partial coverage — Gemini2-1)', () => {
    const partial = { statesRequested: ['mobile', 'desktop'], statesCollected: ['mobile'] };
    assert.equal(mergeScorecard(rows, {}, partial)[0].status, STATUS.UNVERIFIED);
  });
  it('pass for an UNPINNED intent reached via any live link (reachability — Gemini2-2)', () => {
    const unpinned = [{ persona: 'p', intent: 'x', destination: 'wines', requiredInLayer: null }];
    const attr = attributeLive([{ target: 'wines', container: null, layer: null, state: 'mobile' }]);
    assert.equal(mergeScorecard(unpinned, attr, full)[0].status, STATUS.PASS);
  });
  it('pass counts a placement in the required layer in ANY ONE state (union)', () => {
    const attr = attributeLive([
      { target: 'wines', container: '.sub-tabs-row', layer: 'secondary', state: 'desktop' },
      { target: 'wines', container: '#primary-nav', layer: 'primary', state: 'mobile' },
    ]);
    assert.equal(mergeScorecard(rows, attr, full)[0].status, STATUS.PASS);
  });
});
