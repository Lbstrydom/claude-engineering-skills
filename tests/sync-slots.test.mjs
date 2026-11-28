/**
 * @fileoverview `lib/sync-slots.mjs`: the marker grammar and the splice that
 * puts a consumer's block into an upstream slot.
 *
 * Tier 3 (consumer sync contract): these bytes land in consumer repos we cannot
 * observe, and the manifest hash of them is the divergence gate's base, so
 * determinism is a correctness property, not a nicety.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findSlotMarkers, normaliseFragment, spliceBlocks, lintSlotMarkers, SlotError, SLOT_ERROR,
  renderStartLine, renderEndLine, SLOT_NAME_RE,
} from '../scripts/lib/sync-slots.mjs';

const UPSTREAM = [
  '---',
  'name: demo',
  'description: d',
  '---',
  '',
  '# Demo',
  '',
  '## Usage',
  '',
  '<!-- sync-slot:target-adapter -->',
  '',
  '## Phase 1 — Detect',
  'body',
  '',
].join('\n');

const block = (content, slot = 'target-adapter', from = '.sync-blocks/demo.target-adapter.md') =>
  ({ slot, from, content: normaliseFragment(content, { from }) });

const codeOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof SlotError, `not a SlotError: ${e}`); return e.code; } return null; };

describe('marker grammar', () => {
  it('finds an exact marker with its nearest preceding heading', () => {
    const [m] = findSlotMarkers(UPSTREAM);
    assert.deepEqual({ name: m.name, line: m.line, heading: m.heading, fm: m.inFrontmatter, fence: m.inFence },
      { name: 'target-adapter', line: 10, heading: '## Usage', fm: false, fence: false });
  });

  it('only an exact, column-0 line is a marker', () => {
    for (const t of ['  <!-- sync-slot:a -->', '<!-- sync-slot:A -->', '<!--sync-slot:a-->', '<!-- sync-slot:a --> x', 'x <!-- sync-slot:a -->']) {
      assert.equal(findSlotMarkers(t).length, 0, t);
    }
    assert.equal(findSlotMarkers('<!-- sync-slot:a-1 -->').length, 1);
  });

  it('slot names: lowercase letter first, then [a-z0-9-], 40 max', () => {
    assert.ok(SLOT_NAME_RE.test('target-adapter'));
    for (const bad of ['', '1a', 'A', 'a_b', 'a'.repeat(41)]) assert.equal(SLOT_NAME_RE.test(bad), false, bad);
  });
});

describe('normaliseFragment', () => {
  it('CRLF and LF fragments normalise to identical bytes, ending in exactly one newline', () => {
    const lf = normaliseFragment('## Adapter\n\nuse x\n\n\n');
    const crlf = normaliseFragment('## Adapter\r\n\r\nuse x\r\n');
    assert.equal(lf, '## Adapter\n\nuse x\n');
    assert.equal(crlf, lf);
  });

  it('refuses an empty fragment, one carrying the slot token, and one with an unclosed fence', () => {
    assert.equal(codeOf(() => normaliseFragment(' \n\n')), SLOT_ERROR.FRAGMENT_EMPTY);
    assert.equal(codeOf(() => normaliseFragment('a\n<!-- sync-slot:x -->\n')), SLOT_ERROR.FRAGMENT_HAS_MARKER);
    assert.equal(codeOf(() => normaliseFragment('a\n```bash\nnpm run x\n')), SLOT_ERROR.FRAGMENT_UNBALANCED_FENCE);
    assert.equal(codeOf(() => normaliseFragment('a\n```')), SLOT_ERROR.FRAGMENT_UNBALANCED_FENCE);
  });

  it('accepts a closed fence and a fragment that starts with a rule line', () => {
    assert.equal(codeOf(() => normaliseFragment('```bash\nnpm run x\n```\n')), null);
    assert.equal(codeOf(() => normaliseFragment('---\n## A\n')), null);
  });
});

describe('spliceBlocks', () => {
  it('no blocks is the identity, even over text whose markers are malformed', () => {
    const weird = 'x\n<!-- sync-slot:a -->\n<!-- sync-slot:a -->\n';
    assert.equal(spliceBlocks(weird, []).content, weird);
  });

  it('replaces the marker line with a start line, the fragment, and an end line', () => {
    const r = spliceBlocks(UPSTREAM, [block('## Adapter\nuse x\n')]);
    const lines = r.content.split('\n');
    const at = lines.indexOf(renderStartLine('target-adapter', '.sync-blocks/demo.target-adapter.md'));
    assert.ok(at > 0, r.content);
    assert.deepEqual(lines.slice(at + 1, at + 4), ['## Adapter', 'use x', renderEndLine('target-adapter')]);
    assert.ok(!r.content.includes('<!-- sync-slot:target-adapter -->'), 'the bare marker is consumed');
    assert.deepEqual(r.applied, [{ slot: 'target-adapter', anchorHeading: '## Usage' }]);
    // Upstream text either side is untouched.
    assert.ok(r.content.startsWith('---\nname: demo'));
    assert.ok(r.content.endsWith('## Phase 1 — Detect\nbody\n'));
  });

  it('render-from-source determinism: two renders of the same inputs give identical bytes', () => {
    const a = spliceBlocks(UPSTREAM, [block('one\ntwo\n')]).content;
    const b = spliceBlocks(UPSTREAM, [block('one\r\ntwo\r\n')]).content;
    assert.equal(a, b);
  });

  it('refuses already-spliced input rather than splicing twice', () => {
    const once = spliceBlocks(UPSTREAM, [block('x\n')]).content;
    assert.equal(codeOf(() => spliceBlocks(once, [block('x\n')])), SLOT_ERROR.ALREADY_SPLICED);
  });

  it('a declared slot with no marker THROWS slot-missing (the block is never dropped)', () => {
    const gone = UPSTREAM.replace('<!-- sync-slot:target-adapter -->\n', '');
    assert.equal(codeOf(() => spliceBlocks(gone, [block('x\n')])), SLOT_ERROR.MISSING);
  });

  it('a duplicated marker, a marker in frontmatter, and a marker in a fence each throw', () => {
    const dup = `${UPSTREAM}<!-- sync-slot:target-adapter -->\n`;
    assert.equal(codeOf(() => spliceBlocks(dup, [block('x\n')])), SLOT_ERROR.DUPLICATE);
    const fm = '---\nname: d\n<!-- sync-slot:s -->\n---\nbody\n';
    assert.equal(codeOf(() => spliceBlocks(fm, [block('x\n', 's')])), SLOT_ERROR.IN_FRONTMATTER);
    const fenced = 'a\n```\n<!-- sync-slot:s -->\n```\n';
    assert.equal(codeOf(() => spliceBlocks(fenced, [block('x\n', 's')])), SLOT_ERROR.IN_FENCE);
  });

  it('two slots in one file splice independently; applied[] is sorted by slot', () => {
    const two = `${UPSTREAM}## Later\n<!-- sync-slot:alpha -->\n`;
    const r = spliceBlocks(two, [block('T\n'), block('A\n', 'alpha')]);
    assert.deepEqual(r.applied.map((x) => [x.slot, x.anchorHeading]), [['alpha', '## Later'], ['target-adapter', '## Usage']]);
  });
});

describe('lintSlotMarkers (upstream push side)', () => {
  it('a clean file has no problems; grammar documented inside a fence is prose', () => {
    assert.deepEqual(lintSlotMarkers(UPSTREAM), []);
    assert.deepEqual(lintSlotMarkers('```\n<!-- sync-slot:<name> -->\n```\n'), []);
  });

  it('reports every problem: malformed, in-frontmatter, in-fence, duplicate', () => {
    const text = [
      '---', '<!-- sync-slot:fm -->', '---',
      '<!-- sync-slot: typo -->',
      '```', '<!-- sync-slot:fenced -->', '```',
      '<!-- sync-slot:d -->', '<!-- sync-slot:d -->',
    ].join('\n');
    assert.deepEqual(lintSlotMarkers(text).map((p) => [p.line, p.code]), [
      [2, SLOT_ERROR.IN_FRONTMATTER], [4, SLOT_ERROR.MALFORMED], [6, SLOT_ERROR.IN_FENCE], [9, SLOT_ERROR.DUPLICATE],
    ]);
  });
});
