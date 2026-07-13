/**
 * @fileoverview DB-free tests for the tiered-shadow store seam
 * (scripts/lib/store/tiered-shadow.mjs). Per this repo's testing doctrine,
 * the actual INSERT/SELECT round trip is DB-side and covered by the
 * empirical verify doctrine for a new analyzer/table, not asserted here
 * against a mock (that would test the mock). What IS asserted, DB-free:
 * schema validation catches malformed input before any query is built,
 * and the cloud-off path degrades gracefully without attempting a
 * connection (this dev machine has a real AUDIT_DB_URL — every test file
 * here must stay hermetic regardless of that, per the shadow-flip
 * incident's own lesson).
 */
process.env.AUDIT_DB_URL = ''; // must precede the dynamic import below

const { appendTieredShadowObservation, getTieredShadowObservations } = await import('../scripts/lib/store/tiered-shadow.mjs');

import test from 'node:test';
import assert from 'node:assert/strict';

test('appendTieredShadowObservation: cloud off → {ok:true, cloud:false}, no query attempted', async () => {
  const r = await appendTieredShadowObservation({
    repoId: 'a0000000-0000-0000-0000-000000000000',
    legacyOk: true, shadowOk: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
});

test('appendTieredShadowObservation: schema-invalid input rejected before any cloud check', async () => {
  const r = await appendTieredShadowObservation({ repoId: '', legacyOk: true, shadowOk: true });
  assert.equal(r.ok, false);
  assert.equal(r.cloud, false);
  assert.match(r.error, /invalid args/);
});

test('appendTieredShadowObservation: missing required fields rejected', async () => {
  const r = await appendTieredShadowObservation({ repoId: 'r1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('getTieredShadowObservations: cloud off → {ok:true, cloud:false, rows:[]}', async () => {
  const r = await getTieredShadowObservations({ repoIds: ['a0000000-0000-0000-0000-000000000000'] });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
  assert.deepEqual(r.rows, []);
});

test('getTieredShadowObservations: empty repoIds array is rejected (never silently "all repos")', async () => {
  await assert.rejects(() => getTieredShadowObservations({ repoIds: [] }));
});
