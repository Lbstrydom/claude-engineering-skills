/**
 * v1.3 #3 — bounded collapsed-menu activation pass. Drives a committed fixture
 * via Playwright `file://`; skips cleanly when chromium is unavailable.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import { runVerify } from '../scripts/lib/nav/verify.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const fixtureUrl = url.pathToFileURL(path.join(__dirname, 'fixtures', 'nav-live', 'collapsed-menu.html')).href;

const model = { destinations: new Map([['today', {}], ['wines', {}], ['cellar', {}]]) };
const contract = {
  version: 1,
  navLayers: { primary: ['#primary-nav'], secondary: ['#drawer'] },
  personas: [{ id: 'p', intents: [{ id: 'browse', destination: 'wines', requiredInLayer: 'secondary' }] }],
};

let available = true;
before(async () => {
  try { const { chromium } = await import('playwright'); const b = await chromium.launch({ headless: true }); await b.close(); }
  catch { available = false; }
});

describe('runVerify activation pass (collapsed menu)', () => {
  it('captures a behind-the-hamburger destination WITH activation', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const report = await runVerify({ url: fixtureUrl, model, contract, breakpoints: ['mobile'], hydrateMs: 400, timeoutMs: 15000, activate: true });
    assert.equal(report.ok, true, report.reason || '');
    const attr = report.liveAttribution;
    assert.ok(attr['wines'], 'wines (in the collapsed drawer) must be captured after activation');
    assert.ok(attr['wines'].layers.includes('secondary'), 'wines attributes to the drawer (secondary)');
    // A derived activation state was recorded.
    assert.ok(report.statesCollected.some((s) => s.startsWith('mobile+a')), 'an activation-derived state is collected');
  });

  it('does NOT capture the collapsed destination with activate:false', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const report = await runVerify({ url: fixtureUrl, model, contract, breakpoints: ['mobile'], hydrateMs: 400, timeoutMs: 15000, activate: false });
    assert.equal(report.ok, true, report.reason || '');
    assert.equal(report.liveAttribution['wines'], undefined, 'wines stays hidden without activation');
    assert.deepEqual(report.statesCollected, ['mobile'], 'no activation states when activate:false');
  });

  it('discards a trigger that navigates (navigation guard), run completes', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const report = await runVerify({ url: fixtureUrl, model, contract, breakpoints: ['mobile'], hydrateMs: 400, timeoutMs: 15000, activate: true });
    assert.equal(report.ok, true);
    assert.ok((report.stateWarnings || []).some((w) => /navigated away|discarded/i.test(w)), 'the navigating trigger is discarded with a warning');
  });
});

const degradedUrl = url.pathToFileURL(path.join(__dirname, 'fixtures', 'nav-live', 'degraded-activation.html')).href;

describe('runVerify activation adaptive early-stop (v1.4)', () => {
  it('aborts after 3 consecutive unactionable triggers, run completes', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const m = { destinations: new Map([['grid', {}], ['drinksoon', {}]]) };
    const c = { version: 1, navLayers: { secondary: ['.sub-tabs-row'] }, personas: [] };
    const report = await runVerify({ url: degradedUrl, model: m, contract: c, breakpoints: ['mobile'], hydrateMs: 400, timeoutMs: 15000, activate: true });
    assert.equal(report.ok, true, report.reason || '');
    assert.ok((report.stateWarnings || []).some((w) => /activation aborted/i.test(w)), 'aborts with the adaptive-stop warning');
    // No activation state succeeded (all triggers unactionable); base still collected.
    assert.deepEqual(report.statesCollected, ['mobile']);
  });
});
