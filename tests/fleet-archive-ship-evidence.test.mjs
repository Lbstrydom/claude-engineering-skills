/**
 * @fileoverview `shipEvidenceOwed` (scripts/lib/fleet/lifecycle.mjs): a READY member whose PR is still open must not be archived,
 * because its local `.audit/` gate-evidence and final-review markers are what a coordinator's re-check of its shipped head reads
 * (docs/plans/coordinator-aggregate-ship.md section 2.2). Both directions: when it fires, and when it must NOT.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shipEvidenceOwed } from '../scripts/lib/fleet/lifecycle.mjs';

describe('archive-check: a ready, unmerged member owes its evidence markers', () => {
  it('a ready session with an open PR is owed: archiving would destroy the markers the re-check reads', () => {
    assert.match(shipEvidenceOwed({ ready: { oid: 'a'.repeat(40), at: 'x' } }, { number: 21 }), /PR #21 is ready but unmerged.*\.audit\//);
  });
  it('not ready, or no PR at all: nothing is owed (the direction it must NOT fire)', () => {
    assert.equal(shipEvidenceOwed({ ready: null }, { number: 21 }), null);
    assert.equal(shipEvidenceOwed({ ready: { oid: 'a'.repeat(40) } }, null), null);
    assert.equal(shipEvidenceOwed(null, { number: 21 }), null);
    assert.equal(shipEvidenceOwed({ ready: null }, { unknown: 'gh unavailable' }), null, 'a member that is not ready owes nothing even when the PR query failed');
  });
  it('a READY member whose PR could not be queried is UNCERTAIN, never clear to archive', () => {
    assert.match(shipEvidenceOwed({ ready: { oid: 'a'.repeat(40) } }, { unknown: 'gh unavailable' }), /could not be queried \(gh unavailable\).*unknown/);
  });
});
