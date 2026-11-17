/**
 * @fileoverview Debt ad2fd650d8bd — a receipt write that fails must not blind the
 * rollback guard. It is judged against BOTH durable stamps (the receipt's latest
 * entry and the consumer manifest's source commit), by commit ANCESTRY and never
 * by wall-clock.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rollbackAgainstStamps, manifestStamp } from '../scripts/lib/sync-rollback-guard.mjs';

describe('rollbackAgainstStamps', () => {
  const OLD = 'a'.repeat(40);
  const NEWER = 'b'.repeat(40);
  // `incoming` is an ancestor of `recorded` => rollback
  const ancestry = (anc, desc) => (anc === OLD && desc === NEWER ? 'yes' : 'no');
  const receipt = (sha, syncedAt = '2026-11-01T00:00:00Z') => ({ source: { commitSha: sha }, syncedAt });

  test('a receipt stamp that shows the rollback is reported', () => {
    assert.equal(rollbackAgainstStamps([receipt(NEWER), null], OLD, ancestry).recordedSha, NEWER);
  });

  test('RED on the parent: a STALE receipt (older delivery) hides a rollback only the manifest stamp shows', () => {
    const staleReceipt = receipt(OLD); // the receipt write of the later sync failed
    const manifest = manifestStamp({ commitSha: NEWER, generatedAt: '2026-11-02T00:00:00Z' });
    assert.equal(rollbackAgainstStamps([staleReceipt], OLD, ancestry), null, 'the parent consulted the receipt alone and saw nothing');
    assert.equal(rollbackAgainstStamps([staleReceipt, manifest], OLD, ancestry).recordedSha, NEWER);
  });

  test('wall-clock is irrelevant: a skewed generatedAt changes nothing', () => {
    const skewed = manifestStamp({ commitSha: NEWER, generatedAt: '1999-01-01T00:00:00Z' });
    assert.equal(rollbackAgainstStamps([skewed], OLD, ancestry).recordedSha, NEWER);
  });

  test('no stamps, an unresolvable commit, or the same commit: not a rollback (the guard fails open)', () => {
    assert.equal(rollbackAgainstStamps([], OLD, ancestry), null);
    assert.equal(rollbackAgainstStamps([null, manifestStamp(null)], OLD, ancestry), null);
    assert.equal(rollbackAgainstStamps([receipt(NEWER)], OLD, () => 'unknown'), null);
    assert.equal(rollbackAgainstStamps([receipt(OLD)], OLD, ancestry), null);
  });

  test('manifestStamp: shaped like a receipt entry; null for anything without a commit', () => {
    assert.deepEqual(manifestStamp({ commitSha: NEWER, generatedAt: 'T' }), { source: { commitSha: NEWER }, syncedAt: 'T' });
    assert.equal(manifestStamp({ commitSha: null }), null);
    assert.equal(manifestStamp(undefined), null);
  });
});
