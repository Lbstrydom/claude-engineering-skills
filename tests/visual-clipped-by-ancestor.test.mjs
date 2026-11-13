/**
 * @fileoverview `clipped_by_ancestor` — positive control + clean twins.
 *
 * Field finding (wine-cellar-app, 2026-11-13, 375x667): the right ~15px of a quantity
 * row was clipped off by an `overflow:hidden` modal body. A scrollWidth/width-delta
 * check reads clean because clipped content does not scroll: the row's own
 * scrollWidth === clientWidth (it fits ITS box; the box is wider than the clipper),
 * and the clipper sits above the captured surface root.
 *
 * Two layers:
 *   1. pure-seam tests over hand-built evidence (always run);
 *   2. a REAL-BROWSER fixture through runExtract() — the positive control that proves
 *      (a) the pre-existing checks stay clean on genuinely-clipped content and
 *      (b) the new check fires. Skips cleanly without Chromium (fails closed in CI).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runExtract } from '../scripts/lib/visual/extract.mjs';
import { runLayoutPhysics } from '../scripts/lib/visual/layout-physics.mjs';

const CLS = 'clipped_by_ancestor';
const OLD = new Set(['content_clipping', 'layout_overflow']);

// ── 1. pure seam ───────────────────────────────────────────────────────────
const n = (o) => ({ surfaceId: 's', device: 'mobile', theme: 'light', displayed: true, scroll: {}, computed: {}, ...o });
const box = (right = 300) => ({ left: 0, right, top: null, bottom: null, owner: { right: 'div.modal' } });
const run = (nodes) => runLayoutPhysics(nodes, {}, { viewportWidth: 375 }).filter((f) => f.class === CLS);

test('border box 15px past a clipping ancestor → fires, names side + owner', () => {
  const f = run([n({ nodeKey: 'a', auditInstanceId: 'a', rect: { x: 0, y: 0, width: 315, height: 40 }, clipBox: box() })]);
  assert.equal(f.length, 1);
  assert.equal(f[0].property, 'right');
  assert.match(f[0].actual, /15\.0px past div\.modal/);
});

test('sub-pixel (314 inside 313.5) and exactly-1px overhang stay quiet; 1.5px fires', () => {
  const mk = (w, r) => run([n({ nodeKey: 'a', auditInstanceId: 'a', rect: { x: 0, y: 0, width: w, height: 40 }, clipBox: box(r) })]);
  assert.equal(mk(314, 313.5).length, 0, 'half-pixel is layout noise');
  assert.equal(mk(301, 300).length, 0, '1px boundary does not fire');
  assert.equal(mk(301.5, 300).length, 1, '1.5px fires');
});

test('quiet: fully outside, collapsed, invisible, clipped-flag, overlapAllowed, no clipBox', () => {
  const rect = { x: 0, y: 0, width: 315, height: 40 };
  assert.equal(run([n({ nodeKey: 'a', auditInstanceId: 'a', rect: { x: 400, y: 0, width: 50, height: 40 }, clipBox: box() })]).length, 0, 'off-canvas');
  assert.equal(run([n({ nodeKey: 'a', auditInstanceId: 'a', rect: { x: 0, y: 0, width: 3, height: 40 }, clipBox: box(1) })]).length, 0, 'collapsed');
  assert.equal(run([n({ nodeKey: 'a', auditInstanceId: 'a', rect, clipBox: box(), effectiveOpacity: 0 })]).length, 0, 'opacity 0');
  assert.equal(run([n({ nodeKey: 'a', auditInstanceId: 'a', rect, clipBox: box(), clipped: true })]).length, 0, 'flagged fully clipped');
  assert.equal(run([n({ nodeKey: 'a', auditInstanceId: 'a', rect, clipBox: box(), overlapAllowed: true })]).length, 0, 'overlapAllowed');
  assert.equal(run([n({ nodeKey: 'a', auditInstanceId: 'a', rect, clipBox: null })]).length, 0, 'no clipping ancestor');
});

test('child is not re-reported when its captured parent overhangs at least as far; is when it overhangs further', () => {
  const parent = n({ nodeKey: 'p', auditInstanceId: 'p', rect: { x: 0, y: 0, width: 315, height: 40 }, clipBox: box() });
  const same = n({ nodeKey: 'c', auditInstanceId: 'c', parentInstanceId: 'p', rect: { x: 0, y: 0, width: 315, height: 20 }, clipBox: box() });
  assert.deepEqual(run([parent, same]).map((f) => f.nodeKey), ['p']);
  const further = n({ nodeKey: 'c', auditInstanceId: 'c', parentInstanceId: 'p', rect: { x: 0, y: 0, width: 340, height: 20 }, clipBox: box() });
  assert.deepEqual(run([parent, further]).map((f) => f.nodeKey).sort(), ['c', 'p']);
});

test('left/top/bottom overhangs are detected too (scrollWidth ignores negative-side overflow)', () => {
  const f = run([n({ nodeKey: 'a', auditInstanceId: 'a', rect: { x: -20, y: 90, width: 100, height: 40 }, clipBox: { left: 0, right: null, top: null, bottom: 100, owner: { left: 'div.m', bottom: 'div.m' } } })]);
  assert.deepEqual(f.map((x) => x.property).sort(), ['bottom', 'left']);
});

// ── 2. real browser ────────────────────────────────────────────────────────
// Each case is a modal (the clipper, OUTSIDE the surface root) wrapping a surface.
const FIXTURE = `<!doctype html><html><head><style>
  body{margin:0} .modal{width:300px;height:80px;overflow:hidden;margin-bottom:8px}
  .row{display:flex;height:40px;background:#eee} .row>span{flex:1}
</style></head><body>
  <div class="modal"><div id="bad" class="row" style="width:315px"><span>qty</span><span>+</span></div></div>
  <div class="modal"><div id="clean" class="row" style="width:300px"><span>qty</span><span>+</span></div></div>
  <div class="modal" style="width:313.5px"><div id="subpx" class="row" style="width:314px"><span>qty</span></div></div>
  <div class="modal" style="overflow-x:auto"><div id="scroll" class="row" style="width:315px"><span>qty</span></div></div>
  <div class="modal"><div id="offcanvas" class="row" style="width:100px;margin-left:400px"><span>qty</span></div></div>
  <div class="modal"><div id="abs" class="row" style="width:315px;position:fixed;top:600px"><span>qty</span></div></div>
  <div class="modal"><div id="vbad" class="row" style="width:300px;height:120px"><span>qty</span></div></div>
</body></html>`;

const surface = (id) => ({ id, selector: `#${id}`, sourceGlobs: ['x/**'], excludeSelectors: [], allowOverlapWith: [], nodeBudget: 50, interactiveBudget: 10 });
const contract = {
  version: 1,
  surfaces: ['bad', 'clean', 'subpx', 'scroll', 'offcanvas', 'abs', 'vbad'].map(surface),
  themes: [{ name: 'light', apply: { mode: 'class', target: 'html', value: 'light' } }],
};
const devices = [{ name: 'mobile', viewport: { width: 375, height: 667 } }];

async function extract() {
  const server = http.createServer((_q, res) => { res.setHeader('content-type', 'text/html'); res.end(FIXTURE); });
  await new Promise((r) => server.listen(0, r));
  try { return await runExtract({ url: `http://127.0.0.1:${server.address().port}/`, contract, devices, timeoutMs: 20000 }); }
  finally { server.close(); }
}

test('real browser: clipped row — old checks read CLEAN, clipped_by_ancestor fires; clean twins stay quiet', async (t) => {
  const result = await extract();
  if (!result.ok && result.code === 'NO_CHROMIUM') {
    if (process.env.CI || process.env.GITHUB_ACTIONS) assert.fail('Chromium missing in CI — clipping fixture must run');
    t.skip('Chromium not installed');
    return;
  }
  assert.ok(result.ok, result.reason);
  const { nodes, viewportWidth } = result.perState[0];
  const all = runLayoutPhysics(nodes, contract, { viewportWidth });
  const forSurface = (id, cls) => all.filter((f) => f.surfaceId === id && (cls instanceof Set ? cls.has(f.class) : f.class === cls));

  // Instrument check: the bad row really is clipped-but-scroll-blind in this browser.
  const badRoot = nodes.find((x) => x.surfaceId === 'bad' && x.depth === 1);
  assert.equal(badRoot.scroll.scrollWidth, badRoot.scroll.clientWidth, 'positive control: sw === cw while content is clipped');
  assert.ok(badRoot.rect.x + badRoot.rect.width <= viewportWidth, 'positive control: inside the viewport, so layout_overflow is blind too');

  // Negative control for the OLD approach: it reports nothing on the bad row.
  assert.equal(forSurface('bad', OLD).length, 0, 'scroll/width checks are blind to ancestor clipping');

  // The new check convicts it, ~15px on the right.
  const hit = forSurface('bad', CLS);
  assert.equal(hit.length, 1, 'exactly one finding (children deduped under the row)');
  assert.equal(hit[0].property, 'right');
  assert.match(hit[0].actual, /15\.0px/);

  const vhit = forSurface('vbad', CLS);
  assert.equal(vhit.length, 1, 'vertical clipping detected');
  assert.equal(vhit[0].property, 'bottom');

  for (const id of ['clean', 'subpx', 'scroll', 'offcanvas', 'abs']) {
    assert.equal(forSurface(id, CLS).length, 0, `${id} must stay quiet`);
  }
});
