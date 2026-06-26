/**
 * @fileoverview Tier-1 tests for the stable node-identity key (the cross-theme /
 * cross-run join — highest-failure-risk seam).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stableNodeKey, sameNode, MAX_PATH_DEPTH } from '../scripts/lib/visual/node-key.mjs';

test('data-visual-id override wins and is stable regardless of structure', () => {
  const a = { tag: 'button', dataVisualId: 'pay-cta', ancestorPath: [{ tag: 'div', nthOfType: 1 }, { tag: 'button', nthOfType: 1 }] };
  const b = { tag: 'button', dataVisualId: 'pay-cta', ancestorPath: [{ tag: 'section', nthOfType: 2 }, { tag: 'button', nthOfType: 3 }] };
  assert.equal(stableNodeKey(a), 'vid:pay-cta');
  assert.ok(sameNode(a, b), 'same data-visual-id → same node despite different paths');
});

test('structural signature distinguishes same-tag siblings', () => {
  const first = { tag: 'div', ancestorPath: [{ tag: 'ul', nthOfType: 1 }, { tag: 'li', nthOfType: 1 }] };
  const second = { tag: 'div', ancestorPath: [{ tag: 'ul', nthOfType: 1 }, { tag: 'li', nthOfType: 2 }] };
  assert.notEqual(stableNodeKey(first), stableNodeKey(second));
});

test('structural key is identical across two runs of the same DOM', () => {
  const desc = () => ({ tag: 'button', role: 'button', ancestorPath: [{ tag: 'nav', nthOfType: 1, role: 'navigation' }, { tag: 'button', nthOfType: 2, role: 'button' }] });
  assert.equal(stableNodeKey(desc()), stableNodeKey(desc()));
});

test('role is folded into the signature', () => {
  const withRole = { tag: 'div', ancestorPath: [{ tag: 'div', nthOfType: 1, role: 'tab' }] };
  const noRole = { tag: 'div', ancestorPath: [{ tag: 'div', nthOfType: 1 }] };
  assert.notEqual(stableNodeKey(withRole), stableNodeKey(noRole));
});

test('deep paths are truncated to the identifying tail with an ellipsis marker', () => {
  const deep = { tag: 'span', ancestorPath: Array.from({ length: MAX_PATH_DEPTH + 4 }, (_, i) => ({ tag: 'div', nthOfType: i + 1 })) };
  const key = stableNodeKey(deep);
  assert.ok(key.startsWith('…>'), 'over-deep path keeps the tail with a truncation marker');
  assert.equal(key.split('>').length - 1, MAX_PATH_DEPTH, 'tail keeps exactly MAX_PATH_DEPTH segments');
});

test('invalid / empty descriptors degrade without throwing', () => {
  assert.equal(stableNodeKey(null), 'node:invalid');
  assert.equal(stableNodeKey({ tag: 'p' }), 'node:p:1');
});
