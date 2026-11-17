/**
 * debt-resolve must accept every topicId the authoritative reader prints. The store holds every entry and the
 * local cache a subset, so a local-only lookup rejected most of the debt (2026-11-17: 392 of 459 store-only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDebtEntry, debtRemovalSucceeded } from '../scripts/lib/debt-memory.mjs';

test('a store-only entry is found in the store, a cached one locally first', () => {
  const local = [{ topicId: 'a' }];
  const store = [{ topicId: 'a', s: 1 }, { topicId: 'b' }];
  assert.deepEqual(pickDebtEntry('a', { local, store }), { entry: { topicId: 'a' }, where: 'local' });
  assert.deepEqual(pickDebtEntry('b', { local, store }), { entry: { topicId: 'b' }, where: 'store' });
  assert.deepEqual(pickDebtEntry('c', { local, store }), { entry: null, where: null });
  assert.deepEqual(pickDebtEntry('b', { local }), { entry: null, where: null }, 'store not asked is not found');
});

test('success is judged on the copy that existed', () => {
  assert.equal(debtRemovalSucceeded('store', { removedLocal: false, removedCloud: true }), true);
  assert.equal(debtRemovalSucceeded('store', { removedLocal: false, removedCloud: false }), false);
  assert.equal(debtRemovalSucceeded('local', { removedLocal: true, removedCloud: false }), true);
  assert.equal(debtRemovalSucceeded('local', { removedLocal: false, removedCloud: true }), false);
});
