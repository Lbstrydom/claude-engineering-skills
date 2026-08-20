/**
 * @fileoverview `recordShipEvent`'s repo-id validation (backlog-triage fix).
 *
 * The defect: `repo_id: repoId || null` wrote whatever `repoId` was handed
 * straight through with zero shape validation — a repo fingerprint hash, a
 * typo'd string, or any other truthy non-UUID value would be written into a
 * real foreign-key column with no signal that the write was scoped to
 * nothing (or worse, collided with a real row). Every other store writer in
 * this repo that accepts a `repoId` validates it against the same
 * `UUID_RE` shape (`bandit-fp.mjs`'s `isSyncableRepoId`, `campaign.mjs`'s
 * CLI) — `recordShipEvent` was the one place that didn't.
 *
 * MUST precede the dynamic import below (config resolves at import time —
 * same convention as tests/plans-ship-failure-contract.test.mjs).
 */
process.env.AUDIT_DB_URL = '';

const { recordShipEvent } = await import('../scripts/lib/store/ship-events.mjs');
const { isSyncableRepoId } = await import('../scripts/lib/store/bandit-fp.mjs');

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const EVENT = { outcome: 'pushed' };

describe('recordShipEvent refuses an implausible repoId instead of writing it through', () => {
  test('a non-UUID repoId (e.g. a repo fingerprint hash) is refused, not silently written', async () => {
    const r = await recordShipEvent('not-a-uuid-fingerprint-hash', EVENT);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-repo-id');
    // Refused before ever asking whether the store is even reachable.
    assert.notEqual(r.reason, 'cloud-off');
  });

  test('an empty-string repoId is refused as invalid, not silently coerced to "absent"', async () => {
    // The OLD code (`repoId || null`) silently coerced '' to null, treating a
    // present-but-empty value the same as no scope at all. That is exactly the
    // silent-garbage behaviour this fix removes: '' is not null/undefined, so
    // it is a PRESENT value that fails the UUID shape check and must be
    // refused, not quietly waved through as unscoped.
    const r = await recordShipEvent('', EVENT);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-repo-id');
  });

  test('a null/undefined repoId is treated as "no scope", not as invalid input', async () => {
    // The refusal must fire only for a PRESENT-but-implausible value — an
    // absent repoId is a legitimate unscoped event and must reach the normal
    // cloud-off/write path, never `invalid-repo-id`.
    const r1 = await recordShipEvent(null, EVENT);
    assert.equal(r1.ok, true);
    assert.equal(r1.reason, 'cloud-off');
    const r2 = await recordShipEvent(undefined, EVENT);
    assert.equal(r2.ok, true);
    assert.equal(r2.reason, 'cloud-off');
  });

  test('a real UUID repoId passes validation through to the normal cloud-off path', async () => {
    const r = await recordShipEvent(VALID_UUID, EVENT);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'cloud-off');
  });

  test('missing outcome is still checked first (ordering unchanged by the new guard)', async () => {
    const r = await recordShipEvent('garbage-id', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing-outcome');
    assert.notEqual(r.reason, 'invalid-repo-id');
  });

  test('positive control: the shared oracle itself rejects the same garbage value', () => {
    // Ties this test to the actual mechanism recordShipEvent now delegates
    // to — if isSyncableRepoId's rule ever changes, this fails alongside it
    // rather than silently drifting out of sync.
    assert.equal(isSyncableRepoId('not-a-uuid-fingerprint-hash'), false);
    assert.equal(isSyncableRepoId(VALID_UUID), true);
  });
});
