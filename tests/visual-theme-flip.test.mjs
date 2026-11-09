/**
 * @fileoverview Theme flip durability (WCA report 892b8e82): an app boot that reverts
 * the attribute flip must not yield light/light captures. Real Chromium (skips cleanly
 * without it) + pure-helper tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runExtract } from '../scripts/lib/visual/extract.mjs';
import { probesDiffer, buildPinInitScript, isDomFlip } from '../scripts/lib/visual/theme-flip.mjs';

// The surface fills at 400ms; the "theme manager" re-stamps data-theme=light at 150ms
// after DOMContentLoaded — i.e. AFTER the harness flip, BEFORE capture.
const page = (css) => `<!doctype html><html><head><style>${css}</style></head><body><main class="grid"></main>
<script>
document.addEventListener('DOMContentLoaded',()=>{
  setTimeout(()=>document.documentElement.setAttribute('data-theme','light'),150);
  setTimeout(()=>{document.querySelector('.grid').innerHTML='<p class="t">hello</p>';},400);
});
</script></body></html>`;
const THEMED = page('body{margin:0;background:#fff;color:#111}[data-theme=dark] body{background:#101010;color:#eee}');
const UNTHEMED = page('body{margin:0;background:#fff;color:#111}');

async function withHtml(html, fn) {
  const server = http.createServer((_q, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise((r) => server.listen(0, r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/`); } finally { server.close(); }
}
const attr = (name, value) => ({ name, apply: { mode: 'attribute', target: 'html', attribute: 'data-theme', value } });
const contract = {
  version: 1,
  surfaces: [{ id: 'main', selector: '.grid', sourceGlobs: ['x/**'], excludeSelectors: [], allowOverlapWith: [], nodeBudget: 400, interactiveBudget: 10 }],
  themes: [attr('light', 'light'), attr('dark', 'dark')],
};
const devices = [{ name: 'desktop', viewport: { width: 800, height: 600 } }];

test('pure: probesDiffer / isDomFlip / pin script', () => {
  assert.equal(probesDiffer([{ theme: 'a', probe: { k: 'x' } }, { theme: 'b', probe: { k: 'y' } }]).ok, true);
  const same = probesDiffer([{ theme: 'a', probe: { k: 'x' } }, { theme: 'b', probe: { k: 'x' } }]);
  assert.equal(same.ok, false);
  assert.match(same.reason, /not observable/);
  assert.equal(probesDiffer([{ theme: 'a', probe: { k: 'x' } }]).ok, true, 'a single theme is not a verdict');
  assert.equal(isDomFlip({ mode: 'media' }), false);
  assert.equal(buildPinInitScript({ mode: 'localStorage' }), null);
  assert.match(buildPinInitScript(contract.themes[1].apply), /MutationObserver/);
});

test('attribute flip reverted by app boot is still captured dark (real findings preserved)', async (t) => {
  const r = await withHtml(THEMED, (url) => runExtract({ url, contract, devices, timeoutMs: 15000 }));
  if (!r.ok && r.code === 'NO_CHROMIUM') { t.skip('Chromium not installed'); return; }
  assert.ok(r.ok, r.reason);
  const dark = r.perState.find((s) => s.theme === 'dark');
  const light = r.perState.find((s) => s.theme === 'light');
  assert.ok(dark && light, `both states captured (missing: ${JSON.stringify(r.missingStates)})`);
  const body = dark.nodes.find((n) => n.tag === 'p').computed.color;
  assert.ok(parseInt(body.match(/\d+/)[0], 10) > 200, `dark text colour must be the dark-theme value, got ${body}`);
  assert.notEqual(dark.nodes.find((n) => n.tag === 'p').computed.color, light.nodes.find((n) => n.tag === 'p').computed.color, 'dark and light captures differ');
});

test('a flip that changes nothing the page paints is unverified, never scored', async (t) => {
  const r = await withHtml(UNTHEMED, (url) => runExtract({ url, contract, devices, timeoutMs: 15000 }));
  if (!r.ok && r.code === 'NO_CHROMIUM') { t.skip('Chromium not installed'); return; }
  assert.ok(r.ok, r.reason);
  assert.equal(r.perState.length, 0, 'identical light/light captures must not reach perState');
  assert.equal(r.missingStates.length, 2);
  assert.ok(r.missingStates.every((m) => /not observable/.test(m.reason)));
});

test('pure: three themes, two identical -> both identical ones are flagged; disjoint samples are unverified', () => {
  const v = probesDiffer([{ theme: 'a', probe: { k: 'x' } }, { theme: 'b', probe: { k: 'x' } }, { theme: 'c', probe: { k: 'y' } }]);
  assert.equal(v.ok, false);
  assert.deepEqual([...v.badThemes].sort(), ['a', 'b']);
  assert.equal(probesDiffer([{ theme: 'a', probe: { p: 'x' } }, { theme: 'b', probe: { q: 'y' } }]).ok, false, 'no matched element is not evidence');
});

const STUBBORN = `<!doctype html><html data-theme="light"><head><style>body{margin:0;background:#fff}[data-theme=dark] body{background:#101010}</style></head><body><main class="grid"><p>x</p></main>
<script>new MutationObserver(()=>{if(document.documentElement.getAttribute('data-theme')!=='light')document.documentElement.setAttribute('data-theme','light');}).observe(document.documentElement,{attributes:true});</script></body></html>`;

test('an app that keeps reverting the flip forever is unverified, not a light/light "dark" capture', async (t) => {
  const r = await withHtml(STUBBORN, (url) => runExtract({ url, contract, devices, timeoutMs: 15000 }));
  if (!r.ok && r.code === 'NO_CHROMIUM') { t.skip('Chromium not installed'); return; }
  assert.ok(r.ok, r.reason);
  assert.equal(r.perState.find((s) => s.theme === 'dark'), undefined, 'dark must not be scored');
  assert.ok(r.missingStates.some((m) => m.theme === 'dark'));
});
