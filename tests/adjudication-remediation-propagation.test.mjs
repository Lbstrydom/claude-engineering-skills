/**
 * Gap #2 (fix-lifecycle plan): recordAdjudicationEvent must propagate
 * remediation_state to the audit_findings column the `unlocked_fixes` view
 * reads — not only to finding_adjudication_events. The patch builder is the
 * deterministic seam; the DB round-trip is out of scope for a unit test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFindingAdjudicationPatch } from '../scripts/lib/store/runs-findings.mjs';

const DECIDED = new Date('2026-07-21T00:00:00Z');

test('propagates remediation_state to audit_findings when the event carries one', () => {
  const patch = buildFindingAdjudicationPatch(
    { adjudicationOutcome: 'accepted', remediationState: 'fixed' }, DECIDED,
  );
  assert.equal(patch.remediation_state, 'fixed', 'remediation_state must be written to audit_findings (gap #2)');
  assert.equal(patch.adjudication_outcome, 'accepted');
  assert.equal(patch.decided_at, DECIDED);
});

test('does NOT include remediation_state when the event omits it — cannot null an existing state', () => {
  for (const event of [
    { adjudicationOutcome: 'dismissed' },
    { adjudicationOutcome: 'dismissed', remediationState: undefined },
    { adjudicationOutcome: 'dismissed', remediationState: null },
  ]) {
    const patch = buildFindingAdjudicationPatch(event, DECIDED);
    assert.ok(!('remediation_state' in patch),
      `remediation_state must be absent from the patch for ${JSON.stringify(event)} (monotonic-safe)`);
    assert.equal(patch.adjudication_outcome, 'dismissed');
  }
});

test('every terminal remediation state propagates', () => {
  for (const s of ['fixed', 'verified', 'regressed', 'pending']) {
    const patch = buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted', remediationState: s }, DECIDED);
    assert.equal(patch.remediation_state, s);
  }
});
