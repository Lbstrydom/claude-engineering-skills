/**
 * Tier 1 — the campaign verdict engine (Phase 4).
 *
 * Plan: docs/plans/model-comparison-campaigns.md §9 cases 4 + 5, §6.3/D5,
 * §2.5c-i, §5.
 *
 * The headline case is the MEASURED one: opus at 1.50 accepted HIGH/MED per
 * snapshot and $1.98 per accepted, against kimi at 0.25 and $0.58. Floor-then-
 * cost must select opus; a cost-only rule selects kimi, and that anti-case is
 * asserted too — it is the arithmetic this whole design exists to kill, and a
 * test that only asserts the right answer cannot tell you the rule is what
 * produced it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  evaluateCampaign, evaluateFloor, evaluateCost, terminalEvent, compareEvents,
  creditAccepted, completionMatrix, armSpend, calibrationShortfall, deriveState,
  evaluateGates,
} from '../scripts/lib/campaign/verdict.mjs';
import { parseCampaignConfig } from '../scripts/lib/campaign/config.mjs';

const REAL_CONFIG = parseCampaignConfig(JSON.parse(fs.readFileSync('.campaigns/final-review-2026q3.json', 'utf-8'))).config;

// ── fixture builders ────────────────────────────────────────────────────────

/**
 * Build a cohort: `n` complete snapshots, `accepted[armId]` accepted HIGH
 * findings spread across them, and a per-arm total spend.
 */
function buildCohort({ n, accepted, spendUsd, costStatus = {}, armIds = ['opus', 'kimi'], replicateArmIds = ['solo-opus'] }) {
  const snapshots = [];
  const clusters = [];
  for (let i = 0; i < n; i += 1) {
    const snapshotId = `snap${String(i).padStart(2, '0')}`;
    const armRuns = [...armIds, ...replicateArmIds].map((armId) => ({
      armId, attempt: 1, error: null, supersededAt: null,
      costUsd: (spendUsd[armId] ?? 0) / n,
      costStatus: costStatus[armId] ?? 'priced',
    }));
    snapshots.push({ snapshotId, armRuns });
  }
  for (const armId of armIds) {
    const total = accepted[armId] ?? 0;
    for (let k = 0; k < total; k += 1) {
      const snapshotId = `snap${String(k % n).padStart(2, '0')}`;
      clusters.push({
        clusterId: `c-${armId}-${k}`,
        snapshotId,
        members: [{
          findingId: `f-${armId}-${k}`, armId, severity: 'HIGH',
          events: [{ id: `e-${armId}-${k}`, adjudicatorKind: 'agent', adjudicationOutcome: 'accepted', createdAt: '2026-08-10T00:00:00Z', supersededAt: null }],
        }],
      });
    }
  }
  return { snapshots, clusters };
}

const CLEAN_GATES = {
  adjudication: { unadjudicatedFindings: 0, humanQueuePending: 0 },
  calibration: { perArm: { opus: { agentVerdicts: 10, assigned: 5, dispositioned: 5 }, kimi: { agentVerdicts: 4, assigned: 4, dispositioned: 4 } } },
  clustering: { snapshotsMissingClusters: [], matcherVersion: '1' },
};

// ── §9 case 4 — the measured table ──────────────────────────────────────────

test('the measured cohort selects opus under floor-then-cost', () => {
  // 12 snapshots · opus 18 accepted (1.50/snapshot) at $1.98 each = $35.64
  //              · kimi  3 accepted (0.25/snapshot) at $0.58 each = $1.74
  const { snapshots, clusters } = buildCohort({
    n: 12, accepted: { opus: 18, kimi: 3 }, spendUsd: { opus: 35.64, kimi: 1.74, 'solo-opus': 0 },
  });
  const r = evaluateCampaign({ config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES });

  assert.equal(r.state, 'DECISION_READY');
  assert.equal(r.nComplete, 12);
  assert.equal(r.floor.perArm.opus.perSnapshot, 1.5);
  assert.equal(r.floor.perArm.kimi.perSnapshot, 0.25);
  assert.equal(r.floor.threshold, 1);
  assert.equal(r.floor.perArm.kimi.clears, false, 'kimi is below the incumbent minus the margin');
  assert.deepEqual(r.floor.cleared, ['opus']);
  assert.equal(r.verdict.outcome, 'SELECT');
  assert.equal(r.verdict.armId, 'opus');
  assert.equal(r.cost.perArm.opus.costPerAccepted, 1.98);
});

test('ANTI-CASE: a cost-only rule selects kimi on the same data — the arithmetic D5 exists to kill', () => {
  const { snapshots } = buildCohort({ n: 12, accepted: { opus: 18, kimi: 3 }, spendUsd: { opus: 35.64, kimi: 1.74, 'solo-opus': 0 } });
  const acceptedPerArm = { opus: 18, kimi: 3 };
  // Skip the floor entirely — this is what the pre-D5 rule did.
  const costOnly = evaluateCost({
    eligibleArmIds: ['opus', 'kimi'], acceptedPerArm, spend: armSpend(snapshots), costCeilingUsdPerAccepted: 8,
  });
  assert.equal(costOnly.winner, 'kimi', 'cost-only picks the arm that found one-sixth of the real defects');
  assert.equal(costOnly.perArm.kimi.costPerAccepted, 0.58);
  assert.equal(costOnly.perArm.opus.costPerAccepted, 1.98);
});

// ── D5's second failure: the zero-finding arm ───────────────────────────────

test('a zero-accepted, zero-cost arm must NOT select even when the relative test passes', () => {
  // The sharpest available case: incumbent EXACTLY at the margin (6/12 = 0.5,
  // margin 0.5 → threshold 0), so `0 >= 0` passes the relative test and the
  // cohort is NOT degenerate (that test is strict `<`). The absolute half is
  // the only thing standing between a zero-finding arm and the cost stage,
  // where it is by construction the cheapest participant.
  const { snapshots, clusters } = buildCohort({
    n: 12, accepted: { opus: 6, kimi: 0 }, spendUsd: { opus: 12, kimi: 0, 'solo-opus': 0 },
  });
  const floor = evaluateFloor({
    acceptedPerArm: { opus: 6, kimi: 0 }, nComplete: 12, incumbentArmId: 'opus', floorMargin: 0.5, armIds: ['opus', 'kimi'],
  });
  assert.equal(floor.threshold, 0);
  assert.equal(floor.degenerate, false, 'exactly-at-margin is not degenerate — the absolute test is doing the work');
  assert.equal(floor.perArm.kimi.clearsRelative, true, 'the RELATIVE test alone admits the zero-finding arm');
  assert.equal(floor.perArm.kimi.clearsAbsolute, false);
  assert.equal(floor.perArm.kimi.clears, false, 'the conjunction is what excludes it');

  const r = evaluateCampaign({ config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES });
  assert.notEqual(r.verdict?.armId, 'kimi');
  assert.equal(r.verdict.armId, 'opus');
});

test('a degenerate incumbent yields INCONCLUSIVE, not a win for whoever scored above zero', () => {
  // Incumbent at 0.25 < floorMargin 0.5 — the cohort did not discriminate.
  const { snapshots, clusters } = buildCohort({
    n: 12, accepted: { opus: 3, kimi: 4 }, spendUsd: { opus: 6, kimi: 2, 'solo-opus': 0 },
  });
  const r = evaluateCampaign({ config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES });
  assert.equal(r.state, 'INCONCLUSIVE');
  assert.match(r.stateReason, /incumbent-floor-degenerate/);
  assert.equal(r.verdict, null, 'no verdict is computed from a baseline that carries no signal');
});

// ── §9 case 5 — unknown cost ────────────────────────────────────────────────

test('an unpriced arm-run refuses the cost stage while the floor stage still evaluates', () => {
  const { snapshots, clusters } = buildCohort({
    n: 12, accepted: { opus: 18, kimi: 12 }, spendUsd: { opus: 35.64, kimi: 0, 'solo-opus': 0 },
    costStatus: { kimi: 'unpriced' },
  });
  const r = evaluateCampaign({ config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES });
  assert.equal(r.floor.perArm.kimi.clears, true, 'the floor stage still ran');
  assert.equal(r.cost.evaluated, false);
  assert.equal(r.cost.reason, 'cost-evidence-unknown');
  assert.equal(r.verdict.outcome, 'INCONCLUSIVE');
  assert.equal(r.spend.kimi.spendUsd, 0, 'the arithmetic is reported…');
  assert.equal(r.spend.kimi.costEvidence, 'unknown', '…but never as a measurement');
});

test('cost per accepted for a zero-accepted arm is null, never Infinity', () => {
  const cost = evaluateCost({
    eligibleArmIds: ['ghost'], acceptedPerArm: { ghost: 0 },
    spend: { ghost: { spendUsd: 12, costEvidence: 'known', attempts: 1 } }, costCeilingUsdPerAccepted: 8,
  });
  assert.equal(cost.perArm.ghost.costPerAccepted, null);
  assert.equal(cost.perArm.ghost.withinCeiling, null);
  assert.equal(cost.winner, null);
});

test('an arm over the cost ceiling cannot win', () => {
  const cost = evaluateCost({
    eligibleArmIds: ['pricey'], acceptedPerArm: { pricey: 1 },
    spend: { pricey: { spendUsd: 40, costEvidence: 'known', attempts: 1 } }, costCeilingUsdPerAccepted: 8,
  });
  assert.equal(cost.perArm.pricey.withinCeiling, false);
  assert.equal(cost.reason, 'no-arm-within-cost-ceiling');
});

// ── §2.5c-i attribution ─────────────────────────────────────────────────────

test('each arm is credited only for its OWN accepted member, never a sibling\'s', () => {
  const clusters = [{
    clusterId: 'c1',
    snapshotId: 's1',
    members: [
      { findingId: 'fa', armId: 'a', severity: 'HIGH', events: [{ id: '1', adjudicatorKind: 'agent', adjudicationOutcome: 'accepted', createdAt: 't', supersededAt: null }] },
      // Same defect, but B's own prose was rejected — hallucinated evidence.
      { findingId: 'fb', armId: 'b', severity: 'HIGH', events: [{ id: '2', adjudicatorKind: 'agent', adjudicationOutcome: 'dismissed', createdAt: 't', supersededAt: null }] },
    ],
  }];
  const { perArm } = creditAccepted(clusters);
  assert.equal(perArm.a, 1);
  assert.equal(perArm.b, undefined, 'a rejected finding is not rescued by a sibling in its cluster');
});

test('both arms are credited when both independently caught the same defect', () => {
  const ev = (id) => [{ id, adjudicatorKind: 'agent', adjudicationOutcome: 'accepted', createdAt: 't', supersededAt: null }];
  const { perArm } = creditAccepted([{
    clusterId: 'c1', snapshotId: 's1',
    members: [
      { findingId: 'fa', armId: 'a', severity: 'HIGH', events: ev('1') },
      { findingId: 'fb', armId: 'b', severity: 'MEDIUM', events: ev('2') },
    ],
  }]);
  assert.equal(perArm.a, 1);
  assert.equal(perArm.b, 1, 'the metric asks "would this arm have caught it", per arm');
});

test('one arm raising the same defect twice counts once', () => {
  const ev = (id) => [{ id, adjudicatorKind: 'agent', adjudicationOutcome: 'accepted', createdAt: 't', supersededAt: null }];
  const { perArm } = creditAccepted([{
    clusterId: 'c1', snapshotId: 's1',
    members: [
      { findingId: 'f1', armId: 'verbose', severity: 'HIGH', events: ev('1') },
      { findingId: 'f2', armId: 'verbose', severity: 'HIGH', events: ev('2') },
    ],
  }]);
  assert.equal(perArm.verbose, 1, 'the cluster is the dedup unit within an arm');
});

test('LOW severity does not count toward the pre-registered metric', () => {
  const { perArm } = creditAccepted([{
    clusterId: 'c1', snapshotId: 's1',
    members: [{ findingId: 'f1', armId: 'a', severity: 'LOW', events: [{ id: '1', adjudicatorKind: 'agent', adjudicationOutcome: 'accepted', createdAt: 't', supersededAt: null }] }],
  }]);
  assert.deepEqual(perArm, {});
});

test('an adjudicator downgrade is honoured — severity comes from the terminal event', () => {
  const { perArm } = creditAccepted([{
    clusterId: 'c1', snapshotId: 's1',
    members: [{
      findingId: 'f1', armId: 'a', severity: 'HIGH',
      events: [{ id: '1', adjudicatorKind: 'agent', adjudicationOutcome: 'accepted', severity: 'LOW', createdAt: 't', supersededAt: null }],
    }],
  }]);
  assert.deepEqual(perArm, {}, 'a downgraded finding stops counting');
});

// ── the terminal-event total order ──────────────────────────────────────────

test('human outranks agent regardless of timestamp', () => {
  const t = terminalEvent([
    { id: 'a', adjudicatorKind: 'agent', adjudicationOutcome: 'accepted', createdAt: '2026-08-10T05:00:00Z', supersededAt: null },
    { id: 'h', adjudicatorKind: 'human', adjudicationOutcome: 'dismissed', createdAt: '2026-08-10T01:00:00Z', supersededAt: null },
  ]);
  assert.equal(t.id, 'h');
});

test('same kind + same timestamp is broken by id — the order is TOTAL', () => {
  const a = { id: 'aaa', adjudicatorKind: 'agent', createdAt: 'T', supersededAt: null };
  const b = { id: 'bbb', adjudicatorKind: 'agent', createdAt: 'T', supersededAt: null };
  assert.ok(compareEvents(b, a) > 0);
  assert.ok(compareEvents(a, b) < 0);
  assert.equal(compareEvents(a, a), 0);
  // Two reads of one dataset must not disagree, whatever order the rows arrive in.
  assert.equal(terminalEvent([a, b]).id, 'bbb');
  assert.equal(terminalEvent([b, a]).id, 'bbb');
});

test('a direct human disposition and a human override rank identically — the later wins', () => {
  const t = terminalEvent([
    { id: 'h1', adjudicatorKind: 'human', method: null, adjudicationOutcome: 'accepted', createdAt: '2026-08-10T01:00:00Z', supersededAt: null },
    { id: 'h2', adjudicatorKind: 'human', method: 'override', adjudicationOutcome: 'dismissed', createdAt: '2026-08-10T02:00:00Z', supersededAt: null },
  ]);
  assert.equal(t.id, 'h2');
});

test('a superseded event never wins the order', () => {
  const t = terminalEvent([
    { id: 'old', adjudicatorKind: 'human', adjudicationOutcome: 'accepted', createdAt: '2026-08-10T09:00:00Z', supersededAt: '2026-08-10T10:00:00Z' },
    { id: 'new', adjudicatorKind: 'agent', adjudicationOutcome: 'dismissed', createdAt: '2026-08-10T01:00:00Z', supersededAt: null },
  ]);
  assert.equal(t.id, 'new');
  assert.equal(terminalEvent([{ id: 'x', supersededAt: 'now' }]), null);
});

// ── completion + spend ──────────────────────────────────────────────────────

test('a replicate arm never gates completeness; a missing non-replicate arm is NAMED', () => {
  const m = completionMatrix([
    { snapshotId: 's1', armRuns: [{ armId: 'opus' }, { armId: 'kimi' }] },
    { snapshotId: 's2', armRuns: [{ armId: 'opus' }] },
    { snapshotId: 's3', armRuns: [{ armId: 'opus' }, { armId: 'kimi', error: 'exit 1' }] },
  ], ['opus', 'kimi']);
  assert.deepEqual(m.complete, ['s1']);
  assert.deepEqual(m.incomplete.map((r) => [r.snapshotId, r.missingArms]), [['s2', ['kimi']], ['s3', ['kimi']]]);
});

test('spend sums ALL attempts including superseded ones', () => {
  const spend = armSpend([{
    snapshotId: 's1',
    armRuns: [
      { armId: 'flaky', attempt: 1, costUsd: 2, costStatus: 'priced', supersededAt: '2026-08-10T00:00:00Z' },
      { armId: 'flaky', attempt: 2, costUsd: 3, costStatus: 'priced', supersededAt: null },
      { armId: 'steady', attempt: 1, costUsd: 3, costStatus: 'priced', supersededAt: null },
    ],
  }]);
  assert.equal(spend.flaky.spendUsd, 5, 'a superseded attempt WAS paid for');
  assert.equal(spend.flaky.attempts, 2);
  assert.equal(spend.steady.spendUsd, 3);
});

test('an unpriced attempt makes the arm\'s cost evidence unknown, not zero', () => {
  const spend = armSpend([{ snapshotId: 's1', armRuns: [{ armId: 'a', costUsd: null, costStatus: 'unpriced', supersededAt: null }] }]);
  assert.equal(spend.a.costEvidence, 'unknown');
  assert.equal(spend.a.unpricedAttempts, 1);
});

// ── gates + state ───────────────────────────────────────────────────────────

test('the watermark names EVERY failing gate', () => {
  const { snapshots, clusters } = buildCohort({ n: 4, accepted: { opus: 6, kimi: 1 }, spendUsd: { opus: 10, kimi: 1, 'solo-opus': 0 } });
  const r = evaluateCampaign({
    config: REAL_CONFIG, snapshots, clusters,
    adjudication: { unadjudicatedFindings: 3, humanQueuePending: 2 },
    calibration: { perArm: { opus: { agentVerdicts: 10, assigned: 5, dispositioned: 1 } } },
    clustering: { snapshotsMissingClusters: [], matcherVersion: '1' },
  });
  assert.equal(r.decisionEligible, false);
  const ids = r.watermark.failing.map((g) => g.id);
  assert.deepEqual(ids.sort(), ['adjudication-coverage', 'calibration-sample', 'human-queue-cleared', 'n-complete']);
  assert.equal(r.watermark.label, 'NOT DECISION-ELIGIBLE');
  for (const g of r.watermark.failing) assert.ok(g.detail.length > 0, `${g.id} must say WHY`);
});

test('an arm with zero agent verdicts is not-applicable, never a blocking calibration gap', () => {
  assert.deepEqual(calibrationShortfall({ perArm: { silent: { agentVerdicts: 0, assigned: 0, dispositioned: 0 } } }), []);
  assert.deepEqual(
    calibrationShortfall({ perArm: { busy: { agentVerdicts: 9, assigned: 5, dispositioned: 2 } } }),
    [{ armId: 'busy', assigned: 5, dispositioned: 2 }],
  );
});

test('an unclustered complete snapshot blocks attribution rather than guessing', () => {
  const { snapshots, clusters } = buildCohort({ n: 12, accepted: { opus: 18, kimi: 3 }, spendUsd: { opus: 35.64, kimi: 1.74, 'solo-opus': 0 } });
  const r = evaluateCampaign({
    config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES,
    clustering: { snapshotsMissingClusters: ['snap03'], matcherVersion: '1' },
  });
  assert.equal(r.decisionEligible, false);
  assert.ok(r.watermark.failing.some((g) => g.id === 'attribution'));
});

test('lock drift supersedes every other state', () => {
  const { snapshots, clusters } = buildCohort({ n: 12, accepted: { opus: 18, kimi: 3 }, spendUsd: { opus: 35.64, kimi: 1.74, 'solo-opus': 0 } });
  const r = evaluateCampaign({ config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES, cohortSuperseded: true });
  assert.equal(r.state, 'SUPERSEDED');
  assert.equal(r.decisionEligible, false);
});

test('an operator declaration is terminal INCONCLUSIVE', () => {
  const { snapshots, clusters } = buildCohort({ n: 12, accepted: { opus: 18, kimi: 3 }, spendUsd: { opus: 35.64, kimi: 1.74, 'solo-opus': 0 } });
  const r = evaluateCampaign({
    config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES,
    declaredInconclusive: { reason: 'eligible pool exhausted at N=9' },
  });
  assert.equal(r.state, 'INCONCLUSIVE');
  assert.match(r.stateReason, /pool exhausted/);
});

test('targetN below the floor is INCONCLUSIVE regardless of what the config says', () => {
  // The schema already refuses this; the verdict engine refuses it INDEPENDENTLY,
  // so a config assembled in code cannot buy a fast verdict by lowering N.
  const cfg = { ...REAL_CONFIG, targetN: 4 };
  const gates = evaluateGates({ config: cfg, nComplete: 4, adjudication: {}, calibration: {}, clustering: {}, cohortSuperseded: false });
  const s = deriveState({ gates, declaredInconclusive: null, cohortSuperseded: false, floor: { degenerate: false }, nComplete: 4, config: cfg });
  assert.equal(s.state, 'INCONCLUSIVE');
  assert.match(s.reason, /below the 12 floor/);
});

test('a rule change after the first arm-run is an advisory beside the number, not a deletion of it', () => {
  const { snapshots, clusters } = buildCohort({ n: 12, accepted: { opus: 18, kimi: 3 }, spendUsd: { opus: 35.64, kimi: 1.74, 'solo-opus': 0 } });
  const r = evaluateCampaign({ config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES, ruleChangedAfterFirstArmRun: true });
  assert.equal(r.verdict.outcome, 'SELECT', 'the evidence survives');
  assert.ok(r.advisories.some((a) => a.id === 'rule-changed'), 'and the fact that the goalposts moved is recorded');
});

test('an incumbent that names no declared arm is a refusal, not a guessed baseline', () => {
  const cfg = { ...REAL_CONFIG, decision: { type: 'select_default', incumbent: 'nobody' } };
  assert.throws(() => evaluateCampaign({ config: cfg, snapshots: [], clusters: [] }), /incumbent must be a declared participant/);
});

test('an incomplete snapshot contributes no clusters to the numerator', () => {
  // 12 snapshots, but snap00's kimi arm errored — so snap00 is incomplete, and
  // the two accepted findings that live on it must not be credited.
  const { snapshots, clusters } = buildCohort({ n: 12, accepted: { opus: 12, kimi: 12 }, spendUsd: { opus: 24, kimi: 12, 'solo-opus': 0 } });
  snapshots[0].armRuns.find((r) => r.armId === 'kimi').error = 'exit 1';
  const r = evaluateCampaign({ config: REAL_CONFIG, snapshots, clusters, ...CLEAN_GATES });
  assert.equal(r.nComplete, 11);
  assert.equal(r.accepted.perArm.opus, 11, 'the snapshot outside the denominator is outside the numerator too');
  assert.equal(r.accepted.perArm.kimi, 11);
});
