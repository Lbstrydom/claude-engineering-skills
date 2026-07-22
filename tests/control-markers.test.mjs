/**
 * @fileoverview Tier-1 tests for the control-marker prefix classifier — the
 * single JS-side source of truth reused by finalize-outcomes.mjs's
 * needs-triage/auto-dismiss split. Pure, no DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_MARKER_PREFIXES, isControlMarkerDetail } from '../scripts/lib/audit/control-markers.mjs';

describe('isControlMarkerDetail', () => {
  it('matches the ADJACENCY_INCOMPLETE control-marker prefix', () => {
    assert.equal(
      isControlMarkerDetail('ADJACENCY_INCOMPLETE (enumeration-bound): maxContainers=20 reached — remaining files not enumerated'),
      true,
    );
  });

  it('does NOT match a genuine adjacency finding under the same [Adjacency] category', () => {
    assert.equal(
      isControlMarkerDetail('a.js:12 sits inside the `if` at a.js:10, but reads nothing declared in that branch.'),
      false,
    );
  });

  it('matches only as a PREFIX, not a substring elsewhere in the text', () => {
    assert.equal(isControlMarkerDetail('This mentions ADJACENCY_INCOMPLETE mid-sentence, not at the start.'), false);
  });

  it('is false for non-string / empty / nullish input', () => {
    assert.equal(isControlMarkerDetail(''), false);
    assert.equal(isControlMarkerDetail(null), false);
    assert.equal(isControlMarkerDetail(undefined), false);
    assert.equal(isControlMarkerDetail(42), false);
  });

  it('CONTROL_MARKER_PREFIXES is frozen and currently exactly [ADJACENCY_INCOMPLETE]', () => {
    assert.deepEqual(CONTROL_MARKER_PREFIXES, ['ADJACENCY_INCOMPLETE']);
    assert.ok(Object.isFrozen(CONTROL_MARKER_PREFIXES));
  });
});
