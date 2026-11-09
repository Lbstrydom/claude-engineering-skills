/**
 * @fileoverview Tier-1 tests for layout physics (Gemini-G3 containment exclusion).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLayoutPhysics } from '../scripts/lib/visual/layout-physics.mjs';

const base = { surfaceId: 's', device: 'desktop', theme: 'light' };
const node = (o) => ({ ...base, displayed: true, ...o });

test('right edge beyond viewport → layout_overflow', () => {
  const out = runLayoutPhysics([node({ nodeKey: 'a', auditInstanceId: 'a', rect: { x: 0, y: 0, width: 1400, height: 20 }, scroll: {} })], {}, { viewportWidth: 1280 });
  assert.ok(out.some((f) => f.class === 'layout_overflow'));
});

test('scrollWidth>clientWidth without escape → content_clipping; with ellipsis → none', () => {
  const clip = runLayoutPhysics([node({ nodeKey: 'a', auditInstanceId: 'a', rect: { x: 0, y: 0, width: 100, height: 20 }, scroll: { scrollWidth: 200, clientWidth: 100 }, computed: {} })], {}, {});
  assert.ok(clip.some((f) => f.class === 'content_clipping'));
  const ok = runLayoutPhysics([node({ nodeKey: 'a', auditInstanceId: 'a', rect: { x: 0, y: 0, width: 100, height: 20 }, scroll: { scrollWidth: 200, clientWidth: 100 }, computed: { 'text-overflow': 'ellipsis' } })], {}, {});
  assert.equal(ok.filter((f) => f.class === 'content_clipping').length, 0);
});

test('degenerate box (clientWidth 1px) does not flag content_clipping (pass-4 #1)', () => {
  const out = runLayoutPhysics([node({ nodeKey: 'lbl', auditInstanceId: 'lbl', rect: { x: 0, y: 0, width: 1, height: 16 }, scroll: { scrollWidth: 120, clientWidth: 1 }, computed: {} })], {}, {});
  assert.equal(out.filter((f) => f.class === 'content_clipping').length, 0);
  // a normally-sized clipped box still fires
  const real = runLayoutPhysics([node({ nodeKey: 'r', auditInstanceId: 'r', rect: { x: 0, y: 0, width: 100, height: 16 }, scroll: { scrollWidth: 200, clientWidth: 100 }, computed: {} })], {}, {});
  assert.ok(real.some((f) => f.class === 'content_clipping'));
});

test('parent/child overlap is NOT flagged (containment); sibling overlap IS (G3)', () => {
  const parent = node({ nodeKey: 'p', auditInstanceId: 'p', parentInstanceId: null, rect: { x: 0, y: 0, width: 200, height: 200 }, scroll: {} });
  const child = node({ nodeKey: 'c', auditInstanceId: 'c', parentInstanceId: 'p', rect: { x: 10, y: 10, width: 50, height: 50 }, scroll: {} });
  const containment = runLayoutPhysics([parent, child], {}, {});
  assert.equal(containment.filter((f) => f.class === 'unexpected_overlap').length, 0, 'child inside parent is containment');

  const sibA = node({ nodeKey: 'x', auditInstanceId: 'x', parentInstanceId: 'p', rect: { x: 0, y: 0, width: 60, height: 60 }, scroll: {} });
  const sibB = node({ nodeKey: 'y', auditInstanceId: 'y', parentInstanceId: 'p', rect: { x: 40, y: 40, width: 60, height: 60 }, scroll: {} });
  const siblings = runLayoutPhysics([parent, sibA, sibB], {}, {});
  assert.ok(siblings.some((f) => f.class === 'unexpected_overlap'), 'overlapping siblings flagged');
});

test('a STATIC child of a fixed overlay does not flag overlap with the page behind (shakedown #2)', () => {
  // the real FP: #auth-screen(fixed) > .auth-card > div(static) overlaps header(static, page)
  const pageHeader = node({ nodeKey: 'h', auditInstanceId: 'h', parentInstanceId: null, rect: { x: 0, y: 0, width: 200, height: 40 }, scroll: {}, computed: { position: 'static' } });
  const overlay = node({ nodeKey: 'ov', auditInstanceId: 'ov', parentInstanceId: null, rect: { x: 0, y: 0, width: 200, height: 200 }, scroll: {}, computed: { position: 'fixed' } });
  const overlayChild = node({ nodeKey: 'oc', auditInstanceId: 'oc', parentInstanceId: 'ov', rect: { x: 20, y: 10, width: 100, height: 30 }, scroll: {}, computed: { position: 'static' } });
  const out = runLayoutPhysics([pageHeader, overlay, overlayChild], {}, {});
  assert.equal(out.filter((f) => f.class === 'unexpected_overlap').length, 0, 'overlay subtree vs page is intentional');
});

test('overlay set by an ANCESTOR above the contracted root (surfaceLayer) suppresses overlap (pass-3 #1)', () => {
  // #auth-screen(fixed) is OUTSIDE the contracted .auth-card subtree, so extract tags
  // the surface with surfaceLayer; the card's static children must not flag overlap
  // with the page header (a different/no layer).
  const header = node({ nodeKey: 'h', auditInstanceId: 'h', parentInstanceId: null, surfaceLayer: null, rect: { x: 0, y: 0, width: 300, height: 40 }, scroll: {}, computed: { position: 'static' } });
  const cardChild = node({ nodeKey: 'c', auditInstanceId: 'c', parentInstanceId: null, surfaceLayer: 'ovl:#auth-screen', rect: { x: 20, y: 10, width: 200, height: 50 }, scroll: {}, computed: { position: 'static' } });
  assert.equal(runLayoutPhysics([header, cardChild], {}, {}).filter((f) => f.class === 'unexpected_overlap').length, 0);
});

test('two siblings in the SAME layer still flag a real overlap', () => {
  const a = node({ nodeKey: 'x', auditInstanceId: 'x', parentInstanceId: null, rect: { x: 0, y: 0, width: 60, height: 60 }, scroll: {}, computed: { position: 'static' } });
  const b = node({ nodeKey: 'y', auditInstanceId: 'y', parentInstanceId: null, rect: { x: 40, y: 40, width: 60, height: 60 }, scroll: {}, computed: { position: 'static' } });
  assert.ok(runLayoutPhysics([a, b], {}, {}).some((f) => f.class === 'unexpected_overlap'));
});

test('overlapAllowed nodes are exempt from overlap', () => {
  const a = node({ nodeKey: 'x', auditInstanceId: 'x', parentInstanceId: null, rect: { x: 0, y: 0, width: 60, height: 60 }, scroll: {} });
  const b = node({ nodeKey: 'y', auditInstanceId: 'y', parentInstanceId: null, overlapAllowed: true, rect: { x: 40, y: 40, width: 60, height: 60 }, scroll: {} });
  assert.equal(runLayoutPhysics([a, b], {}, {}).filter((f) => f.class === 'unexpected_overlap').length, 0);
});

test('distorting object-fit with mismatched aspect → image_distortion', () => {
  const out = runLayoutPhysics([node({ nodeKey: 'img', auditInstanceId: 'img', isImage: true, naturalWidth: 100, naturalHeight: 100, rect: { x: 0, y: 0, width: 200, height: 50 }, scroll: {}, computed: { 'object-fit': 'fill' } })], {}, {});
  assert.ok(out.some((f) => f.class === 'image_distortion'));
  const safe = runLayoutPhysics([node({ nodeKey: 'img', auditInstanceId: 'img', isImage: true, naturalWidth: 100, naturalHeight: 100, rect: { x: 0, y: 0, width: 200, height: 50 }, scroll: {}, computed: { 'object-fit': 'cover' } })], {}, {});
  assert.equal(safe.filter((f) => f.class === 'image_distortion').length, 0);
});

// WCA report d9306fe9: absolute badge over a static sibling inside a relative tile
const tileScene = (badgeOver = {}) => {
  const tile = node({ nodeKey: 'tile', auditInstanceId: 'tile', parentInstanceId: null, rect: { x: 0, y: 0, width: 80, height: 60 }, scroll: {}, computed: { position: 'relative' } });
  const year = node({ nodeKey: 'year', auditInstanceId: 'year', parentInstanceId: 'tile', hasText: true, rect: { x: 4, y: 4, width: 40, height: 14 }, scroll: {}, computed: { position: 'static', color: 'rgb(0,0,0)', opacity: '1' } });
  const slot = node({ nodeKey: 'slot', auditInstanceId: 'slot', parentInstanceId: 'tile', hasText: true, rect: { x: 6, y: 6, width: 30, height: 12 }, scroll: {}, computed: { position: 'absolute', color: 'rgb(0,0,0)', opacity: '1' }, ...badgeOver });
  return [tile, year, slot];
};
const overlaps = (ns) => runLayoutPhysics(ns, {}, {}).filter((f) => f.class === 'unexpected_overlap');

test('absolute text over a static text sibling inside a relative tile IS flagged (WCA d9306fe9)', () => {
  assert.equal(overlaps(tileScene()).length, 1);
});

test('negative controls: intentional overlays inside a tile are NOT flagged', () => {
  const abs = (o) => ({ position: 'absolute', color: 'rgb(0,0,0)', opacity: '1', ...o });
  assert.equal(overlaps(tileScene({ ariaHidden: true })).length, 0, 'aria-hidden');
  assert.equal(overlaps(tileScene({ computed: abs({ opacity: '0' }) })).length, 0, 'opacity 0');
  assert.equal(overlaps(tileScene({ computed: abs({ color: 'rgba(0,0,0,0)' }) })).length, 0, 'transparent text');
  assert.equal(overlaps(tileScene({ clipped: true })).length, 0, 'clipped');
  assert.equal(overlaps(tileScene({ hasText: false })).length, 0, 'decorative badge with no text');
  assert.equal(overlaps(tileScene({ rect: { x: 50, y: 30, width: 20, height: 12 } })).length, 0, 'no geometric intersection');
  assert.equal(overlaps(tileScene({ computed: abs({ position: 'fixed' }) })).length, 0, 'fixed overlay is a different layer');
});

test('negative control: static text inside a FIXED overlay under the tile is not a tile overlap (M1/H9)', () => {
  const [tile, year, slot] = tileScene();
  const overlay = node({ nodeKey: 'ov', auditInstanceId: 'ov', parentInstanceId: 'tile', rect: { x: 0, y: 0, width: 80, height: 60 }, scroll: {}, computed: { position: 'fixed' } });
  const innerYear = { ...year, auditInstanceId: 'iy', nodeKey: 'iy', parentInstanceId: 'ov' };
  assert.equal(overlaps([tile, overlay, innerYear, slot]).length, 0);
});

test('negative controls: ancestor opacity 0 and two absolute siblings are not tile overlaps (R2)', () => {
  assert.equal(overlaps(tileScene({ effectiveOpacity: 0 })).length, 0, 'opacity:0 wrapper');
  const [tile, year, slot] = tileScene();
  const slot2 = { ...slot, auditInstanceId: 'slot2', nodeKey: 'slot2' };
  const yearAbs = { ...year, computed: { ...year.computed, position: 'absolute' } };
  assert.equal(overlaps([tile, yearAbs, slot2]).length, 0, 'two absolute layers');
});

test('absolute WRAPPER around a static text span over a static sibling is flagged (R3 H3)', () => {
  const tile = node({ nodeKey: 'tile', auditInstanceId: 'tile', parentInstanceId: null, rect: { x: 0, y: 0, width: 80, height: 60 }, scroll: {}, computed: { position: 'relative' } });
  const year = node({ nodeKey: 'year', auditInstanceId: 'year', parentInstanceId: 'tile', hasText: true, rect: { x: 4, y: 4, width: 40, height: 14 }, scroll: {}, computed: { position: 'static', color: 'rgb(0,0,0)' } });
  const wrap = node({ nodeKey: 'wrap', auditInstanceId: 'wrap', parentInstanceId: 'tile', rect: { x: 6, y: 6, width: 30, height: 12 }, scroll: {}, computed: { position: 'absolute' } });
  const span = node({ nodeKey: 'span', auditInstanceId: 'span', parentInstanceId: 'wrap', hasText: true, rect: { x: 6, y: 6, width: 30, height: 12 }, scroll: {}, computed: { position: 'static', color: 'rgb(0,0,0)' } });
  assert.equal(overlaps([tile, year, wrap, span]).length, 1);
});
