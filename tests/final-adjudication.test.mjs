/**
 * Tier-1 tests for Stage 2 final adjudication (tiered-recall pipeline,
 * Cluster D scoped Phase 9). Plan: docs/plans/tiered-recall-audit-pipeline.md.
 * Adapters are stubs throughout — no live LLM/network calls, and no
 * modification to the untested gemini-review.mjs core (see module header).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectAdjudicationSample, runFinalAdjudication } from '../scripts/lib/audit/final-adjudication.mjs';

const CLOCK = () => '2026-01-01T00:00:00.000Z';

function mkEnvelope(severity, evidenceType, stage1Outcome) {
  return {
    canonicalFinding: { severity, evidenceType },
    stageDecisions: [{ stage: 'stage1', outcome: stage1Outcome, reasonCode: 'x', hasDeterministicDisproof: stage1Outcome === 'mechanical_dismissed', createdAt: CLOCK() }],
  };
}

describe('selectAdjudicationSample', () => {
  it('includes all escalated envelopes as mandatory', () => {
    const escalated = [mkEnvelope('MEDIUM', 'commission', 'escalated')];
    const { mandatory } = selectAdjudicationSample({ escalated, mechanicalDismissed: [] }, [], { seed: 1 });
    assert.equal(mandatory.length, 1);
  });

  it('a HIGH/omission dismissal reaches Stage 2 via the escalated path, not mechanicalDismissed (consolidated Gemini gate fix G1, round 2)', () => {
    // Per stage1-triage.mjs's severity gate, a HIGH/omission valid dismissal is
    // ALWAYS logged as `escalated` (never `mechanical_dismissed`) — so it's
    // already covered by the "all escalated envelopes are mandatory" case
    // above, not by a separate HIGH/omission check inside the
    // mechanicalDismissed loop (that check was dead code — removed).
    const escalated = [mkEnvelope('HIGH', 'commission', 'escalated'), mkEnvelope('LOW', 'omission', 'escalated')];
    const { mandatory } = selectAdjudicationSample({ escalated, mechanicalDismissed: [] }, [], { seed: 1 });
    assert.equal(mandatory.length, 2);
  });

  it('a mechanicalDismissed entry (always MEDIUM/LOW commission by construction) never lands in mandatory, even if a caller passes an out-of-contract HIGH one', () => {
    // Defensive test for the dead-code removal: mechanicalDismissed entries
    // are unconditionally routed to the tail-sample pool now, matching the
    // real pipeline's invariant that mechanical_dismissed is only ever
    // reached for MEDIUM/LOW commission candidates.
    const dismissed = [mkEnvelope('HIGH', 'commission', 'mechanical_dismissed')];
    const { mandatory, tailSample } = selectAdjudicationSample({ escalated: [], mechanicalDismissed: dismissed }, [], { tailSampleRate: 1, seed: 1 });
    assert.equal(mandatory.length, 0);
    assert.equal(tailSample.length, 1);
  });

  it('samples only a fraction of MEDIUM/LOW commission mechanical dismissals into the tail, not mandatory', () => {
    const dismissed = Array.from({ length: 20 }, () => mkEnvelope('MEDIUM', 'commission', 'mechanical_dismissed'));
    const { mandatory, tailSample } = selectAdjudicationSample({ escalated: [], mechanicalDismissed: dismissed }, [], { tailSampleRate: 0.1, seed: 1 });
    assert.equal(mandatory.length, 0);
    assert.equal(tailSample.length, 2); // ceil(20 * 0.1)
  });

  it('is deterministic for a fixed seed', () => {
    const dismissed = Array.from({ length: 20 }, (_, i) => ({ ...mkEnvelope('MEDIUM', 'commission', 'mechanical_dismissed'), id: i }));
    const a = selectAdjudicationSample({ escalated: [], mechanicalDismissed: dismissed }, [], { tailSampleRate: 0.2, seed: 42 });
    const b = selectAdjudicationSample({ escalated: [], mechanicalDismissed: dismissed }, [], { tailSampleRate: 0.2, seed: 42 });
    assert.deepEqual(a.tailSample.map((e) => e.id), b.tailSample.map((e) => e.id));
  });

  it('samples a bounded, capped fraction of clean-region files', () => {
    const cleanRegionFiles = Array.from({ length: 50 }, (_, i) => `file${i}.js`);
    const { cleanRegionSample } = selectAdjudicationSample({ escalated: [], mechanicalDismissed: [] }, cleanRegionFiles, { cleanRegionRate: 0.1, seed: 1 });
    assert.equal(cleanRegionSample.length, 5); // ceil(50 * 0.1)
  });

  it('never samples more clean-region files than exist', () => {
    const cleanRegionFiles = ['a.js', 'b.js'];
    const { cleanRegionSample } = selectAdjudicationSample({ escalated: [], mechanicalDismissed: [] }, cleanRegionFiles, { cleanRegionRate: 5, seed: 1 });
    assert.equal(cleanRegionSample.length, 2);
  });
});

describe('runFinalAdjudication', () => {
  it('reverses a mechanical dismissal Gemini overturns', async () => {
    const envelope = mkEnvelope('HIGH', 'commission', 'mechanical_dismissed');
    const { reversed } = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [envelope] }, [],
      { reviewCall: async () => ({ verdict: 'reversed' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(reversed.length, 1);
    assert.equal(envelope.stageDecisions.at(-1).outcome, 'reversed');
  });

  it('confirms a mechanical dismissal Gemini agrees with', async () => {
    const envelope = mkEnvelope('HIGH', 'commission', 'mechanical_dismissed');
    const { confirmedDismissal } = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [envelope] }, [],
      { reviewCall: async () => ({ verdict: 'confirmed' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(confirmedDismissal.length, 1);
  });

  it('confirms a HIGH/omission dismissal Gemini agrees with — a Gemini-confirmed escalated-for-severity dismissal must be confirmed_dismissal, NEVER verified (consolidated Gemini gate fix G1, round 2)', async () => {
    // This is the exact bug G1 caught: a HIGH/omission valid dismissal is
    // logged as `outcome: 'escalated', reasonCode: 'valid_dismissal_high_or_omission_escalated'`
    // (per stage1-triage.mjs's severity gate) — NOT `mechanical_dismissed`.
    // Before the fix, `wasDismissed` checked ONLY `mechanical_dismissed`, so
    // this exact case fell through to `verified` (an ACTIVE finding) instead
    // of `confirmed_dismissal` (correctly suppressed) when Gemini agreed.
    const envelope = {
      canonicalFinding: { severity: 'HIGH', evidenceType: 'commission' },
      stageDecisions: [{ stage: 'stage1', outcome: 'escalated', reasonCode: 'valid_dismissal_high_or_omission_escalated', hasDeterministicDisproof: true, createdAt: CLOCK() }],
    };
    const { confirmedDismissal, verified } = await runFinalAdjudication(
      { escalated: [envelope], mechanicalDismissed: [] }, [],
      { reviewCall: async () => ({ verdict: 'confirmed' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(confirmedDismissal.length, 1);
    assert.equal(verified.length, 0);
  });

  it('a GENUINE survivor (no Stage 1 dismissal attempt at all) that Gemini confirms is still verified, not confirmed_dismissal', async () => {
    const envelope = {
      canonicalFinding: { severity: 'HIGH', evidenceType: 'commission' },
      stageDecisions: [{ stage: 'stage1', outcome: 'escalated', reasonCode: 'stage1_call_failed', hasDeterministicDisproof: false, createdAt: CLOCK() }],
    };
    const { confirmedDismissal, verified } = await runFinalAdjudication(
      { escalated: [envelope], mechanicalDismissed: [] }, [],
      { reviewCall: async () => ({ verdict: 'confirmed' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(verified.length, 1);
    assert.equal(confirmedDismissal.length, 0);
  });

  it('verifies an escalated survivor Gemini confirms', async () => {
    const envelope = mkEnvelope('MEDIUM', 'commission', 'escalated');
    const { verified } = await runFinalAdjudication(
      { escalated: [envelope], mechanicalDismissed: [] }, [],
      { reviewCall: async () => ({ verdict: 'verified' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(verified.length, 1);
  });

  it('an escalated envelope reviewCall verdict "confirmed" resolves to verified, not confirmed_dismissal (it was never mechanically dismissed)', async () => {
    const envelope = mkEnvelope('MEDIUM', 'commission', 'escalated');
    const { verified, confirmedDismissal } = await runFinalAdjudication(
      { escalated: [envelope], mechanicalDismissed: [] }, [],
      { reviewCall: async () => ({ verdict: 'confirmed' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(verified.length, 1);
    assert.equal(confirmedDismissal.length, 0);
  });

  it('a reviewCall throw leaves the envelope unresolved — never silently accepted or dismissed', async () => {
    const envelope = mkEnvelope('HIGH', 'commission', 'mechanical_dismissed');
    const { unresolved, reversed, confirmedDismissal, verified } = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [envelope] }, [],
      { reviewCall: async () => { throw new Error('API down'); }, cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(unresolved.length, 1);
    assert.equal(reversed.length, 0);
    assert.equal(confirmedDismissal.length, 0);
    assert.equal(verified.length, 0);
  });

  it('an unrecognized verdict value (unknown or missing) leaves the envelope unresolved rather than silently defaulting to verified (audit fix H4, round 2)', async () => {
    const envelope = mkEnvelope('HIGH', 'commission', 'mechanical_dismissed');
    const { unresolved, verified } = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [envelope] }, [],
      { reviewCall: async () => ({ verdict: 'maybe' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(unresolved.length, 1);
    assert.equal(verified.length, 0);
  });

  it('a missing verdict field also leaves the envelope unresolved', async () => {
    const envelope = mkEnvelope('MEDIUM', 'commission', 'escalated');
    const { unresolved, verified } = await runFinalAdjudication(
      { escalated: [envelope], mechanicalDismissed: [] }, [],
      { reviewCall: async () => ({ rationale: 'no verdict field' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { seed: 1 }
    );
    assert.equal(unresolved.length, 1);
    assert.equal(verified.length, 0);
  });

  it('surfaces a missed_candidate finding from the clean-region sample', async () => {
    const { missedCandidates } = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [] }, ['clean.js'],
      { reviewCall: async () => ({ verdict: 'verified' }), cleanRegionCall: async () => ({ verdict: 'missed_candidate', finding: { detail: 'a real bug' } }), clock: CLOCK },
      { cleanRegionRate: 1, seed: 1 }
    );
    assert.equal(missedCandidates.length, 1);
    assert.equal(missedCandidates[0].file, 'clean.js');
    assert.equal(missedCandidates[0].finding.detail, 'a real bug');
  });

  it('a clean-region call throw is skipped (advisory, never blocks the round)', async () => {
    const { missedCandidates } = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [] }, ['clean.js'],
      { reviewCall: async () => ({ verdict: 'verified' }), cleanRegionCall: async () => { throw new Error('timeout'); }, clock: CLOCK },
      { cleanRegionRate: 1, seed: 1 }
    );
    assert.equal(missedCandidates.length, 0);
  });

  it('a clean "verdict" from the clean-region call never surfaces as a missed candidate', async () => {
    const { missedCandidates } = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [] }, ['clean.js'],
      { reviewCall: async () => ({ verdict: 'verified' }), cleanRegionCall: async () => ({ verdict: 'clean' }), clock: CLOCK },
      { cleanRegionRate: 1, seed: 1 }
    );
    assert.equal(missedCandidates.length, 0);
  });

  it('surfaces clean-region call failures in cleanRegionFailures rather than swallowing them silently (audit fix M5)', async () => {
    const { cleanRegionFailures, missedCandidates } = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [] }, ['a.js', 'b.js'],
      {
        reviewCall: async () => ({ verdict: 'verified' }),
        cleanRegionCall: async (file) => { if (file === 'a.js') throw new Error('adapter down'); return { verdict: 'clean' }; },
        clock: CLOCK,
      },
      { cleanRegionRate: 1, seed: 1 }
    );
    assert.equal(cleanRegionFailures.length, 1);
    assert.equal(cleanRegionFailures[0].file, 'a.js');
    assert.match(cleanRegionFailures[0].errorMessage, /adapter down/);
    assert.equal(missedCandidates.length, 0);
  });
});

describe('selectAdjudicationSample — clean-region sizing baseline (audit fix M7)', () => {
  it('sizes the clean-region sample as a fraction of totalChangedFilesCount, not the already-filtered clean pool', () => {
    // 100 total changed files, only 5 are "clean" (unflagged) — 10% of 100 = 10,
    // but there are only 5 clean files available, so the cap is 5.
    const cleanRegionFiles = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
    const { cleanRegionSample } = selectAdjudicationSample(
      { escalated: [], mechanicalDismissed: [] }, cleanRegionFiles,
      { cleanRegionRate: 0.1, seed: 1, totalChangedFilesCount: 100 }
    );
    assert.equal(cleanRegionSample.length, 5); // capped at available clean files, not floor(0.1*5)=1
  });

  it('a smaller totalChangedFilesCount than the clean pool correctly shrinks the sample below the pool size', () => {
    // 20 total changed files, 15 are clean — 10% of 20 = 2, which is LESS than
    // the clean pool (15). Before the fix, this would have sampled 10% of 15 = 2 too
    // by coincidence at this rate — use a case that actually differentiates:
    const cleanRegionFiles = Array.from({ length: 15 }, (_, i) => `clean${i}.js`);
    const { cleanRegionSample } = selectAdjudicationSample(
      { escalated: [], mechanicalDismissed: [] }, cleanRegionFiles,
      { cleanRegionRate: 0.1, seed: 1, totalChangedFilesCount: 20 }
    );
    assert.equal(cleanRegionSample.length, 2); // ceil(20 * 0.1) = 2, NOT ceil(15 * 0.1) = 2 (coincidentally same here)
    // Use a bigger baseline gap to unambiguously prove the fix:
    const { cleanRegionSample: sampleWithBiggerBaseline } = selectAdjudicationSample(
      { escalated: [], mechanicalDismissed: [] }, cleanRegionFiles,
      { cleanRegionRate: 0.5, seed: 1, totalChangedFilesCount: 4 } // 50% of 4 = 2, vs 50% of 15 = 8 (pre-fix)
    );
    assert.equal(sampleWithBiggerBaseline.length, 2);
  });

  it('falls back to the clean-region pool size when totalChangedFilesCount is omitted (backward-safe default)', () => {
    const cleanRegionFiles = Array.from({ length: 10 }, (_, i) => `clean${i}.js`);
    const { cleanRegionSample } = selectAdjudicationSample(
      { escalated: [], mechanicalDismissed: [] }, cleanRegionFiles,
      { cleanRegionRate: 0.5, seed: 1 }
    );
    assert.equal(cleanRegionSample.length, 5); // ceil(10 * 0.5) = 5, baseline defaults to pool size
  });
});
