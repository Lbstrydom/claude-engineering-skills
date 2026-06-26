/**
 * v1.4 — pure capture-completeness aggregation (computeCaptureStatus). Tier-1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCaptureStatus } from '../scripts/lib/nav/live-attribution.mjs';

const sel = (selector, layer) => ({ selector, layer });

describe('computeCaptureStatus (v1.4)', () => {
  it('captured = produced a placement; visible-but-unplaced = empty (stall); display:none = hidden; never present = absent', () => {
    const presence = { mobile: { '#A': 'visible', '#B': 'visible', '#C': 'hidden', '#D': 'absent' } };
    const r = computeCaptureStatus(presence, new Set(['#A']), [sel('#A', 'primary'), sel('#B', 'primary'), sel('#C', 'secondary'), sel('#D', 'secondary')]);
    assert.equal(r.captureStatus['#A'], 'captured');
    assert.equal(r.captureStatus['#B'], 'empty');
    assert.equal(r.captureStatus['#C'], 'hidden');
    assert.equal(r.captureStatus['#D'], 'absent');
    assert.deepEqual(r.absentDeclared, ['#D']);
  });

  it('[A captured, B empty] → layer UNVERIFIABLE (stall, even with a captured sibling)', () => {
    const r = computeCaptureStatus({ m: { '#A': 'visible', '#B': 'visible' } }, ['#A'], [sel('#A', 'primary'), sel('#B', 'primary')]);
    assert.ok(r.unverifiableLayers.includes('primary'));
  });

  it('[A captured, B hidden/absent] → layer VERIFIABLE (responsive variant)', () => {
    const hidden = computeCaptureStatus({ m: { '#A': 'visible', '#B': 'hidden' } }, ['#A'], [sel('#A', 'primary'), sel('#B', 'primary')]);
    assert.equal(hidden.unverifiableLayers.includes('primary'), false);
    const absent = computeCaptureStatus({ m: { '#A': 'visible', '#B': 'absent' } }, ['#A'], [sel('#A', 'primary'), sel('#B', 'primary')]);
    assert.equal(absent.unverifiableLayers.includes('primary'), false);
  });

  it('[A empty, B absent] and [all absent/hidden] → UNVERIFIABLE', () => {
    const stall = computeCaptureStatus({ m: { '#A': 'visible', '#B': 'absent' } }, [], [sel('#A', 'primary'), sel('#B', 'primary')]);
    assert.ok(stall.unverifiableLayers.includes('primary'));
    const never = computeCaptureStatus({ m: { '#A': 'hidden', '#B': 'absent' } }, [], [sel('#A', 'primary'), sel('#B', 'primary')]);
    assert.ok(never.unverifiableLayers.includes('primary'), 'no captured + no stall = never observable = unverifiable');
  });

  it('a captured single-container layer is verifiable; arrays out (no Set)', () => {
    const r = computeCaptureStatus({ m: { '#A': 'visible' } }, new Set(['#A']), [sel('#A', 'primary')]);
    assert.equal(r.unverifiableLayers.length, 0);
    assert.ok(Array.isArray(r.unverifiableLayers) && Array.isArray(r.absentDeclared));
  });

  it('a captured-in-ANY-state container is captured (union-consistent)', () => {
    // empty on mobile, captured (placed) overall → captured, not a stall.
    const r = computeCaptureStatus({ mobile: { '#A': 'visible' }, desktop: { '#A': 'visible' } }, new Set(['#A']), [sel('#A', 'primary')]);
    assert.equal(r.captureStatus['#A'], 'captured');
  });
});
