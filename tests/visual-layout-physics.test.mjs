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
