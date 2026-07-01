/**
 * @fileoverview Theme-safety PIECE 2 — runUnadaptedColor + assessColorCoverage +
 * the origin-based provenance signal. Pure fixtures (no browser).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runUnadaptedColor, assessColorCoverage } from '../scripts/lib/visual/unadapted-color.mjs';
import { resolveWinningOrigin } from '../scripts/lib/visual/provenance-resolver.mjs';

const uaColor = { property: 'color', value: 'buttontext', origin: 'user-agent', sourceOrder: 0, specificity: [0, 0, 1] };
const authorBg = { property: 'background-color', value: '#fff', origin: 'author', sourceOrder: 1, specificity: [0, 1, 0] };

function control(over = {}) {
  return {
    tag: 'button', displayed: true, isImage: false,
    surfaceId: 's1', auditInstanceId: 'va-1', textSnippet: 'Add',
    computed: { color: 'rgb(0,0,0)', 'background-color': 'rgb(255,255,255)', 'border-top-width': '0px' },
    declarations: [uaColor, authorBg],
    ...over,
  };
}

describe('resolveWinningOrigin', () => {
  it('returns the winning color declaration origin', () => {
    assert.equal(resolveWinningOrigin([uaColor, authorBg], 'color'), 'user-agent');
  });
  it('an author color of higher source order wins → author', () => {
    const authorColor = { property: 'color', value: '#333', origin: 'author', sourceOrder: 5, specificity: [0, 0, 1] };
    assert.equal(resolveWinningOrigin([uaColor, authorColor], 'color'), 'author');
  });
  it('background shorthand is a background-color candidate (expandFor)', () => {
    const bgShorthand = { property: 'background', value: '#fff', origin: 'author', sourceOrder: 1, specificity: [0, 1, 0] };
    assert.equal(resolveWinningOrigin([bgShorthand], 'background-color'), 'author');
  });
});

describe('runUnadaptedColor', () => {
  it('flags a form control with UA color + author box', () => {
    const f = runUnadaptedColor([control()]);
    assert.equal(f.length, 1);
    assert.equal(f[0].class, 'unadapted_text_color');
    assert.equal(f[0].reportOnly, true);
    assert.equal(f[0].surfaceId, 's1');
  });

  it('does NOT flag when the author set color (local/companion/inherited author winner)', () => {
    const authorColor = { property: 'color', value: '#333', origin: 'author', sourceOrder: 5, specificity: [0, 0, 1] };
    const f = runUnadaptedColor([control({ declarations: [uaColor, authorColor, authorBg] })]);
    assert.equal(f.length, 0);
  });

  it('fires on the `background:` SHORTHAND author box (the exact-bug regression)', () => {
    const bgShorthand = { property: 'background', value: '#fff', origin: 'author', sourceOrder: 1, specificity: [0, 1, 0] };
    const f = runUnadaptedColor([control({ declarations: [uaColor, bgShorthand] })]);
    assert.equal(f.length, 1);
  });

  it('does NOT flag a transparent author background (no visible box color)', () => {
    const transparentBg = { property: 'background-color', value: 'transparent', origin: 'author', sourceOrder: 1, specificity: [0, 1, 0] };
    const f = runUnadaptedColor([control({ declarations: [uaColor, transparentBg], computed: { color: 'rgb(0,0,0)', 'background-color': 'rgba(0, 0, 0, 0)', 'border-top-width': '0px' } })]);
    assert.equal(f.length, 0);
  });

  it('skips non-form-control interactives (v1 scope), images, hidden, and no-declaration nodes', () => {
    assert.equal(runUnadaptedColor([control({ tag: 'div', role: 'button' })]).length, 0, 'div[role=button] out of v1 scope');
    assert.equal(runUnadaptedColor([control({ isImage: true })]).length, 0, 'image');
    assert.equal(runUnadaptedColor([control({ displayed: false })]).length, 0, 'hidden');
    assert.equal(runUnadaptedColor([control({ declarations: [] })]).length, 0, 'no evidence → skip, not a false finding');
    assert.equal(runUnadaptedColor([control({ declarations: [{ property: 'color', value: 'x' }] })]).length, 0, 'declarations without origin are not evidence (H1)');
    assert.equal(runUnadaptedColor([control({ declarations: [{ property: 'padding', value: '8px', origin: 'author' }] })]).length, 0, 'origin only on a non-audited property is not evidence (H3)');
  });

  it('skips non-text input types (checkbox/radio/range/file) — they paint no adaptable text (L3)', () => {
    assert.equal(runUnadaptedColor([control({ tag: 'input', inputType: 'checkbox' })]).length, 0);
    assert.equal(runUnadaptedColor([control({ tag: 'input', inputType: 'range' })]).length, 0);
    assert.equal(runUnadaptedColor([control({ tag: 'input', inputType: 'text' })]).length, 1, 'text input still in scope');
  });
});

describe('assessColorCoverage', () => {
  it('counts eligible form controls and those with provenance evidence', () => {
    const nodes = [control(), control({ auditInstanceId: 'va-2', declarations: [] }), control({ tag: 'div' })];
    assert.deepEqual(assessColorCoverage(nodes), { eligible: 2, withEvidence: 1 });
  });
});
