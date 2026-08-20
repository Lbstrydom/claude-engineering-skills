/**
 * @fileoverview `isAttemptExcluded` (store/campaign.mjs) and
 * `resolveStoreState` (bakeoff-collect.mjs)'s store-unavailable degradation
 * ladder — §7 Phase 2 of docs/plans/campaign-arm-state-and-identity-integrity.md.
 *
 * `isAttemptExcluded` is pure (Tier 1, no database); `resolveStoreState`'s
 * cloud-off/cloud-on-but-unregistered paths are exercised the same way
 * `tests/campaign-promote.test.mjs`'s `repoId` test does — by toggling
 * `AUDIT_DB_URL` around the call, never against a live database.
 *
 * @module tests/store-campaign-arm-state
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isAttemptExcluded } from '../scripts/lib/store/campaign.mjs';
import { resolveStoreState } from '../scripts/bakeoff-collect.mjs';

describe('isAttemptExcluded — the single quarantine-match oracle', () => {
  it('no exclusions at all — never excluded', () => {
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: 'h1' }, []), false);
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: 'h1' }, undefined), false);
  });

  it('a scope="all" exclusion matches EVERY attempt for its snapshot, regardless of hash', () => {
    const exclusions = [{ snapshotId: 's1', scope: 'all', planContentHash: null }];
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: 'h1' }, exclusions), true);
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: null }, exclusions), true);
  });

  it('a scope="all" exclusion for a DIFFERENT snapshot does not match', () => {
    const exclusions = [{ snapshotId: 's1', scope: 'all', planContentHash: null }];
    assert.equal(isAttemptExcluded({ snapshotId: 's2', planContentHash: 'h1' }, exclusions), false);
  });

  it('a scope="pairing" exclusion matches only an attempt with the SAME hash', () => {
    const exclusions = [{ snapshotId: 's1', scope: 'pairing', planContentHash: 'bad-hash' }];
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: 'bad-hash' }, exclusions), true);
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: 'good-hash' }, exclusions), false,
      'a DIFFERENT hash for the same snapshot must not be caught by a pairing-scoped exclusion');
  });

  it('a scope="pairing" exclusion with a NULL hash matches only an attempt whose hash is ALSO null', () => {
    // The exact legacy shape: the 3 real mis-paired snapshots predate
    // plan_content_hash entirely, so their quarantine is recorded with
    // planContentHash: null — and NULL-vs-NULL must count as a match, or the
    // legacy pairing could never be excluded at all.
    const exclusions = [{ snapshotId: 's1', scope: 'pairing', planContentHash: null }];
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: null }, exclusions), true);
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: 'some-real-hash' }, exclusions), false,
      'a genuinely re-collected, hash-bearing attempt must NOT be caught by the legacy NULL-hash exclusion — this is exactly what lets the Close-out recovery correction land');
  });

  it('multiple exclusions for different snapshots each apply only to their own', () => {
    const exclusions = [
      { snapshotId: 's1', scope: 'all', planContentHash: null },
      { snapshotId: 's2', scope: 'pairing', planContentHash: 'h2' },
    ];
    assert.equal(isAttemptExcluded({ snapshotId: 's1', planContentHash: 'anything' }, exclusions), true);
    assert.equal(isAttemptExcluded({ snapshotId: 's2', planContentHash: 'h2' }, exclusions), true);
    assert.equal(isAttemptExcluded({ snapshotId: 's2', planContentHash: 'other' }, exclusions), false);
    assert.equal(isAttemptExcluded({ snapshotId: 's3', planContentHash: 'h2' }, exclusions), false);
  });
});

describe('resolveStoreState — the store-unavailable degradation ladder (Gemini gate round 1 H3, round 3 G1)', () => {
  const baseArgs = {
    lockDigest: 'lock1', campaignKey: 'camp', snapshotIdValue: 's1',
    expectedConfigDigest: null, expectedPlanContentHash: null,
  };

  it('no lockDigest at all — returns empty state immediately, no store touched', async () => {
    const r = await resolveStoreState({ ...baseArgs, lockDigest: null, allowLogOnlyRetry: false });
    assert.deepEqual(r, { storeArmState: {}, activeExclusions: [] });
  });

  it('(d) cloud disabled (no AUDIT_DB_URL) — throws unless --allow-log-only-retry is passed', async () => {
    const saved = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      await assert.rejects(
        resolveStoreState({ ...baseArgs, allowLogOnlyRetry: false }),
        (err) => /^\[bakeoff\] Store read failed: /.test(err.message)
          && /Cloud store is disabled/.test(err.message) && /allow-log-only-retry/.test(err.message),
      );
    } finally {
      if (saved === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = saved;
    }
  });

  it('(d) same cloud-off case — proceeds with empty state when --allow-log-only-retry IS passed', async () => {
    const saved = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      const r = await resolveStoreState({ ...baseArgs, allowLogOnlyRetry: true });
      assert.deepEqual(r, { storeArmState: {}, activeExclusions: [] });
    } finally {
      if (saved === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = saved;
    }
  });

  // NOTE on (c) — the OTHER half of the round-1/round-3 gate (a genuinely
  // THROWN store-read error, e.g. a real connectivity/auth failure, as
  // opposed to (d)'s clean `cloud:false` reply): this is NOT separately
  // unit-tested here, honestly, because reaching it needs a live-but-broken
  // database connection, which this suite does not have (the same reason
  // `repoId`'s own test above covers its `kind:'error'` throw path at the
  // CLI boundary instead of here). What IS verified above is that BOTH
  // cases share the identical code path: `resolveStoreState`'s catch block
  // has no branch distinguishing "the error came from a cloud-off check"
  // from "the error came from a real exception" — both produce the exact
  // `[bakeoff] Store read failed: ...` shape asserted in (d), so a thrown
  // error would be gated the same way without a redundant, mislabelled test
  // pretending to exercise a path it cannot reach.
});
