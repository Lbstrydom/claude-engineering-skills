/**
 * v1.1 Cluster A — deterministic collector test (R1-M5): drive a committed static
 * HTML fixture via Playwright `file://` (no external URL) and assert the multi-
 * state container attribution. Skips cleanly when chromium is unavailable.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import { runVerify } from '../scripts/lib/nav/verify.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const fixtureUrl = url.pathToFileURL(path.join(__dirname, 'fixtures', 'nav-live', 'sample.html')).href;

// Minimal static model whose destinations cover the fixture links (?view= slugs).
const model = { destinations: new Map([['today', {}], ['wines', {}], ['pairing', {}], ['grid', {}], ['drinksoon', {}]]) };
const contract = {
  version: 1,
  navLayers: { primary: ['#primary-nav', '#desktop-sidebar'], secondary: ['.sub-tabs-row'] },
  personas: [{ id: 'p', intents: [
    { id: 'today', destination: 'today', requiredInLayer: 'primary' },
    { id: 'grid', destination: 'grid', requiredInLayer: 'secondary' },
  ] }],
};

let available = true;
before(async () => {
  try { const { chromium } = await import('playwright'); const b = await chromium.launch({ headless: true }); await b.close(); }
  catch { available = false; }
});

describe('collectLiveNav via file:// fixture', () => {
  it('attributes targets to the nearest DECLARED container, across viewports', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const report = await runVerify({ url: fixtureUrl, model, contract, breakpoints: ['mobile', 'desktop'], hydrateMs: 300, timeoutMs: 15000 });
    assert.equal(report.ok, true, report.reason || '');
    assert.deepEqual(report.statesCollected.sort(), ['desktop', 'mobile']);

    const attr = report.liveAttribution;
    // grid lives in .sub-tabs-row (secondary) in both states.
    assert.ok(attr['grid'].layers.includes('secondary'));
    // today is in #primary-nav (primary) — visible at the mobile bottom nav.
    assert.ok(attr['today'].layers.includes('primary'));
    // wines appears in primary (sidebar/bottom-nav) AND outside any nav (footer) —
    // every occurrence kept, so ≥2 placements and 'primary' present.
    assert.ok(attr['wines'].placements.length >= 2);
    assert.ok(attr['wines'].layers.includes('primary'));
  });
});
