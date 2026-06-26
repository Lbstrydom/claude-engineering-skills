/**
 * @fileoverview Integration test for runExtract() against a SELF-SERVED static
 * fixture (plan §9, H5) — the highest-risk module gets a real CI contract, not
 * just manual verification. Skips cleanly when Chromium isn't installed so a
 * browserless CI lane never hard-fails.
 *
 * Asserts: evidence shape, per-surfaceId containment, device×theme cells, the
 * forcePseudoState path yields effective per-state computed styles WITHOUT any
 * mouse/keyboard event, and the nodeBudget cap is honoured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runExtract } from '../scripts/lib/visual/extract.mjs';

const FIXTURE = `<!doctype html><html><head><style>
  :root{--brand:#3366ff}
  body{margin:0;background:#ffffff}
  .grid{padding:8px}
  .card{border-radius:6px;padding:8px;background:#fff}
  button{background:#3366ff;color:#fff;border:0}
  button:hover{background:#2244dd}
  button:focus-visible{outline:2px solid #3366ff}
  .bad{color:#777} /* low contrast on white */
</style></head><body>
  <main class="grid">
    <div class="card"><button id="b1">Pay</button><span class="bad">subtle</span></div>
  </main>
</body></html>`;

async function withServer(fn) {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(FIXTURE); });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try { return await fn(url); } finally { server.close(); }
}

const contract = {
  version: 1,
  surfaces: [{ id: 'main', selector: '.grid', sourceGlobs: ['x/**'], excludeSelectors: [], allowOverlapWith: [], nodeBudget: 400, interactiveBudget: 50 }],
  themes: [{ name: 'light', apply: { mode: 'class', target: 'html', value: 'light' } }],
};
const devices = [{ name: 'desktop', viewport: { width: 1024, height: 768 } }];

test('runExtract returns evidence shape OR skips cleanly without Chromium', async (t) => {
  const result = await withServer((url) => runExtract({ url, contract, devices, timeoutMs: 15000 }));
  if (!result.ok && result.code === 'NO_CHROMIUM') {
    // M2: in CI this is the highest-risk module — a silent skip would let CDP /
    // forcePseudoState / budget regressions ship. Fail closed in CI; allow local opt-out.
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      assert.fail('Chromium missing in CI — extract integration test must run (install: `npx playwright install chromium`)');
    }
    t.skip('Chromium not installed — `npx playwright install chromium` to run this lane');
    return;
  }
  assert.ok(result.ok, `extract failed: ${result.reason || ''}`);
  assert.equal(result.perState.length, 1, 'one device×theme cell');
  const state = result.perState[0];
  assert.equal(state.device, 'desktop');
  assert.equal(state.theme, 'light');

  const nodes = state.nodes;
  assert.ok(nodes.length > 0, 'collected some nodes');
  assert.ok(nodes.every((n) => n.surfaceId === 'main'), 'all nodes attributed to the surface');
  assert.ok(nodes.every((n) => typeof n.nodeKey === 'string'), 'every node has a stable key');

  const button = nodes.find((n) => n.tag === 'button');
  assert.ok(button, 'found the button');
  assert.ok(button.pseudo && button.pseudo.hover, 'forcePseudoState produced a hover snapshot');
  // hover background should differ from base (effective, not interpolated)
  assert.notEqual(button.pseudo.hover['background-color'], (button.computed['background-color']), 'effective hover delta captured');
});

// Regression for the theme-transition capture FP (found by wine-cellar-app shakedown):
// a theme-aware element with a transition was captured mid-interpolation → the
// FROM-theme value, fabricating theme_unmapped_token + contrast_failure.
const TRANSITION_FIXTURE = `<!doctype html><html data-theme="light"><head><style>
  :root[data-theme="light"]{--btn:#ffffff}
  :root[data-theme="dark"]{--btn:#101010}
  body{margin:0;background:#fff}
  .grid{padding:8px}
  /* a deliberately LONG transition so it can't naturally settle during capture */
  button{background:var(--btn);transition:background 5s linear;color:#777}
</style></head><body><main class="grid"><button id="b">Go</button></main></body></html>`;

const transitionContract = {
  version: 1,
  surfaces: [{ id: 'main', selector: '.grid', sourceGlobs: ['x/**'], excludeSelectors: [], allowOverlapWith: [], nodeBudget: 400, interactiveBudget: 50 }],
  themes: [
    { name: 'light', apply: { mode: 'attribute', target: 'html', attribute: 'data-theme', value: 'light' } },
    { name: 'dark', apply: { mode: 'attribute', target: 'html', attribute: 'data-theme', value: 'dark' } },
  ],
};

test('theme flip is captured at the SETTLED value, not mid-transition (shakedown transition-FP)', async (t) => {
  const http2 = await import('node:http');
  const server = http2.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(TRANSITION_FIXTURE); });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const result = await runExtract({ url, contract: transitionContract, devices, timeoutMs: 15000 });
    if (!result.ok && result.code === 'NO_CHROMIUM') { t.skip('Chromium not installed'); return; }
    assert.ok(result.ok, `extract failed: ${result.reason || ''}`);
    const darkState = result.perState.find((s) => s.theme === 'dark');
    assert.ok(darkState, 'captured the dark state');
    const button = darkState.nodes.find((n) => n.tag === 'button');
    assert.ok(button, 'found the button in dark');
    // settled dark token is #101010 = rgb(16,16,16); the light FROM-value is rgb(255,255,255).
    const r = parseInt((button.computed['background-color'].match(/\d+/) || [])[0], 10);
    assert.ok(r < 64, `dark button background must be SETTLED dark, not the light from-value (got ${button.computed['background-color']})`);
  } finally {
    server.close();
  }
});
