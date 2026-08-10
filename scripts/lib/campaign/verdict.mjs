/**
 * @fileoverview Campaign verdict engine — the two-stage decision rule, the
 * derived state machine, and the gates that decide whether standings may be
 * read as a decision at all.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §5 (state map), §6.3/D5
 * (floor-then-cost), §2.5c-i (metric attribution), §2.5d (watermark).
 *
 * **Pure.** No store, no filesystem, no clock. Every input arrives as data so
 * the whole rule is exercisable from a fixture — which matters more here than
 * usual, because the rule's whole purpose is to be pre-registered and then
 * applied unchanged, and a rule you cannot run without a database is a rule
 * nobody re-checks.
 *
 * Three properties this module exists to enforce, each from a measured defect:
 *
 *  - **Effectiveness floor BEFORE cost.** Today's cost-only rule would have
 *    selected the arm that found one-sixth of the real defects at the lowest
 *    price per finding. The floor is a *conjunction* — non-inferior to the
 *    incumbent AND strictly above zero — because a purely relative floor admits
 *    a zero-finding arm whenever the incumbent itself scores low, and a
 *    zero-finding arm is by construction the cheapest thing in the campaign.
 *  - **A degenerate baseline is uninformative, not favourable.** A cohort on
 *    which the incumbent finds nothing has not discriminated between the arms;
 *    it failed to pose the question. That is `INCONCLUSIVE`, not a win for
 *    whoever happened to score above zero.
 *  - **A number that no gate qualifies is not a decision.** Standings render
 *    always, and carry a watermark NAMING every failing gate — a gate that
 *    doesn't say why reads as arbitrary, and an unqualified number gets quoted.
 *
 * @module scripts/lib/campaign/verdict
 */

import { MIN_TARGET_N } from './config.mjs';

/** §5. Terminal states are `INCONCLUSIVE` and `SUPERSEDED`. */
export const CAMPAIGN_STATES = Object.freeze([
  'COLLECTING', 'AWAITING_ADJUDICATION', 'AWAITING_REVIEW',
  'DECISION_READY', 'INCONCLUSIVE', 'SUPERSEDED',
]);

/** Severities that count toward the effectiveness metric (§2.5c-i row 4). */
export const COUNTED_SEVERITIES = Object.freeze(['HIGH', 'MEDIUM']);

/**
 * `adjudicator_kind` rank for the terminal-event total order. A direct human
 * disposition and a human override rank IDENTICALLY — both are human verdicts,
 * and the later one wins on the timestamp/id tiebreak below.
 */
const KIND_RANK = Object.freeze({ human: 2, agent: 1 });

/**
 * The TERMINAL event for one finding, under a **total** order (§2.5c-i row 3):
 * `adjudicator_kind` rank (human > agent) → `created_at` desc → `id` desc.
 *
 * `created_at` alone is not a total order: concurrent agent retries can share a
 * timestamp, and "latest" would then be nondeterministic across reads — two
 * reads of the same data disagreeing about a verdict is the failure this
 * ordering exists to make impossible. The `id` tiebreak is arbitrary but
 * *stable*, which is the whole requirement.
 *
 * Superseded events are excluded: a superseded agent verdict has been replaced,
 * and letting it win the order would resurrect a retracted ruling.
 *
 * @param {Array<{id: string, adjudicatorKind?: string|null, createdAt?: string|null,
 *   supersededAt?: string|null, adjudicationOutcome?: string|null, severity?: string|null,
 *   method?: string|null}>} events
 * @returns {object|null}
 */
export function terminalEvent(events) {
  const live = (events || []).filter((e) => e && e.supersededAt == null);
  if (live.length === 0) return null;
  let best = null;
  for (const e of live) {
    if (best === null || compareEvents(e, best) > 0) best = e;
  }
  return best;
}

/** Strictly-greater comparison for the total order above. Exported for the test
 *  that asserts the order is total rather than merely usually-decisive. */
export function compareEvents(a, b) {
  const ra = KIND_RANK[a?.adjudicatorKind] ?? 0;
  const rb = KIND_RANK[b?.adjudicatorKind] ?? 0;
  if (ra !== rb) return ra - rb;
  const ta = String(a?.createdAt ?? '');
  const tb = String(b?.createdAt ?? '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = String(a?.id ?? '');
  const ib = String(b?.id ?? '');
  if (ia === ib) return 0;
  return ia < ib ? -1 : 1;
}

/**
 * Per-arm accepted counts, under §2.5c-i's attribution rules.
 *
 * **Clustering defines the DENOMINATOR and the co-detection line; it never
 * transfers a verdict.** Each arm is credited if and only if its OWN member
 * finding's terminal event is `accepted` — never because a sibling in the
 * cluster was. Crediting both arms for independently catching the same defect
 * is correct (the metric asks "would this arm have caught it", per arm); but
 * crediting an arm whose own prose was *rejected* — for hallucinated evidence,
 * say — would inflate the weaker model with the stronger one's work, which is
 * precisely lesson (a): a high-dismissal arm looks productive until you
 * adjudicate.
 *
 * Within one arm, the matcher's cluster is also the dedup unit: an arm that
 * raises the same defect twice counts once, so a verbose arm cannot inflate
 * itself.
 *
 * @param {Array<{clusterId: string, snapshotId: string,
 *   members: Array<{findingId: string, armId: string, severity: string,
 *                   events: Array<object>}>}>} clusters
 * @returns {{perArm: Record<string, number>, credited: Array<object>}}
 */
export function creditAccepted(clusters) {
  const perArm = {};
  const credited = [];
  const counted = new Set(COUNTED_SEVERITIES);
  for (const cluster of clusters || []) {
    // Per (cluster, arm): the cluster IS the dedup unit within an arm.
    const armsCreditedHere = new Set();
    for (const member of cluster.members || []) {
      const term = terminalEvent(member.events);
      if (!term || term.adjudicationOutcome !== 'accepted') continue;
      // Severity comes from the TERMINAL event when it carries one — an
      // adjudicator may downgrade, and the pre-registered metric counts what the
      // adjudication concluded, not what the arm claimed.
      const severity = term.severity ?? member.severity;
      if (!counted.has(severity)) continue;
      if (armsCreditedHere.has(member.armId)) continue;
      armsCreditedHere.add(member.armId);
      perArm[member.armId] = (perArm[member.armId] ?? 0) + 1;
      credited.push({ clusterId: cluster.clusterId, snapshotId: cluster.snapshotId, armId: member.armId, findingId: member.findingId, severity });
    }
  }
  return { perArm, credited };
}

/**
 * Completion matrix, not a count (§2.5b-i).
 *
 * A snapshot is complete when every **non-replicate** arm produced a parseable
 * result under the current cohort. Replicates are collected but never gate
 * completeness. A partially-collected snapshot is returned with its missing
 * arms NAMED — never rounded up to complete, never silently dropped, because
 * "N complete" is the denominator every effectiveness number divides by.
 *
 * @param {Array<{snapshotId: string, armRuns: Array<{armId: string, supersededAt?: string|null, error?: string|null}>}>} snapshots
 * @param {string[]} requiredArmIds - non-replicate arm ids
 */
export function completionMatrix(snapshots, requiredArmIds) {
  const required = [...new Set(requiredArmIds || [])];
  const rows = (snapshots || []).map((snap) => {
    const ok = new Set();
    for (const run of snap.armRuns || []) {
      if (run.supersededAt != null) continue;
      if (run.error) continue;
      ok.add(run.armId);
    }
    const missing = required.filter((id) => !ok.has(id));
    return { snapshotId: snap.snapshotId, complete: missing.length === 0, missingArms: missing };
  });
  return {
    rows,
    complete: rows.filter((r) => r.complete).map((r) => r.snapshotId),
    incomplete: rows.filter((r) => !r.complete),
  };
}

/**
 * Per-arm spend. **Effectiveness reads live rows; spend reads ALL rows**
 * (§7a, shadow/S4).
 *
 * A superseded attempt WAS PAID FOR. Summing only the final attempt means an
 * arm that failed once and was re-run under `--force` reports less spend than
 * it cost, while an arm that succeeded first time reports all of its own — and
 * since the cost stage is a comparison *between* arms, that asymmetry
 * systematically flatters the flakier model. Lesson (e) in its subtler form:
 * not a null read as free, but a real charge read as never having happened.
 *
 * `cost_status: 'unpriced'` on ANY attempt — live or superseded — forces
 * `costEvidence: 'unknown'` for that arm (D6). So does `'unknown'`: a status
 * that says we never determined the price is not weaker evidence than one that
 * says we could not, it is the same absence.
 *
 * @param {Array<{snapshotId: string, armRuns: Array<{armId: string, attempt?: number,
 *   costUsd?: number|null, costStatus?: string, supersededAt?: string|null}>}>} snapshots
 */
export function armSpend(snapshots) {
  const perArm = {};
  for (const snap of snapshots || []) {
    for (const run of snap.armRuns || []) {
      const entry = perArm[run.armId] ?? (perArm[run.armId] = { spendUsd: 0, attempts: 0, unpricedAttempts: 0, costEvidence: 'known' });
      entry.attempts += 1;
      if (run.costStatus === 'priced' && Number.isFinite(run.costUsd)) {
        entry.spendUsd += Number(run.costUsd);
      } else {
        entry.unpricedAttempts += 1;
        entry.costEvidence = 'unknown';
      }
    }
  }
  for (const entry of Object.values(perArm)) entry.spendUsd = round6(entry.spendUsd);
  return perArm;
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

/**
 * Stage 1 — the effectiveness floor (D5).
 *
 * `clears = (perSnapshot >= incumbentPerSnapshot - floorMargin) AND
 * (perSnapshot > 0)`. Both halves are load-bearing and neither is redundant:
 * drop the relative test and a worse arm wins on price; drop the absolute test
 * and, whenever the incumbent scores at or below the margin, an arm that found
 * **nothing at all** satisfies `0 >= 0 - 0.5`, proceeds to the cost stage as the
 * cheapest possible participant, and wins. That is the same perverse arithmetic
 * D5 exists to kill, one level up.
 *
 * @param {{acceptedPerArm: Record<string, number>, nComplete: number,
 *   incumbentArmId: string, floorMargin: number, armIds: string[]}} args
 */
export function evaluateFloor({ acceptedPerArm, nComplete, incumbentArmId, floorMargin, armIds }) {
  const per = (armId) => (nComplete > 0 ? (acceptedPerArm[armId] ?? 0) / nComplete : 0);
  const incumbentPerSnapshot = per(incumbentArmId);
  // A cohort on which the incumbent finds nothing has not discriminated between
  // the arms — it failed to pose the question. Uninformative, not favourable.
  const degenerate = nComplete > 0 && incumbentPerSnapshot < floorMargin;
  const threshold = incumbentPerSnapshot - floorMargin;

  const perArm = {};
  for (const armId of armIds) {
    const value = per(armId);
    const clearsRelative = value >= threshold;
    const clearsAbsolute = value > 0;
    perArm[armId] = {
      accepted: acceptedPerArm[armId] ?? 0,
      perSnapshot: round6(value),
      clearsRelative,
      clearsAbsolute,
      clears: clearsRelative && clearsAbsolute,
    };
  }
  return {
    incumbentArmId,
    incumbentPerSnapshot: round6(incumbentPerSnapshot),
    floorMargin,
    threshold: round6(threshold),
    degenerate,
    perArm,
    cleared: armIds.filter((id) => perArm[id].clears),
  };
}

/**
 * Stage 2 — cost per accepted, over the arms that cleared the floor.
 *
 * **An arm with 0 accepted has `costPerAccepted: null`, never `Infinity` and
 * never a large number** (§2.5c-i last row): a computable-looking number
 * invites comparison, and "infinitely expensive" is a rendering of a
 * division-by-zero, not a measurement. Such an arm cannot reach here anyway —
 * the absolute half of the floor already excluded it — but the arithmetic is
 * written honestly rather than relying on an upstream guard.
 *
 * @param {{eligibleArmIds: string[], acceptedPerArm: Record<string, number>,
 *   spend: Record<string, {spendUsd: number, costEvidence: string, attempts: number}>,
 *   costCeilingUsdPerAccepted: number}} args
 */
export function evaluateCost({ eligibleArmIds, acceptedPerArm, spend, costCeilingUsdPerAccepted }) {
  const perArm = {};
  let evidence = 'known';
  for (const armId of eligibleArmIds) {
    const s = spend[armId] ?? { spendUsd: 0, costEvidence: 'unknown', attempts: 0 };
    const accepted = acceptedPerArm[armId] ?? 0;
    if (s.costEvidence !== 'known') evidence = 'unknown';
    const costPerAccepted = accepted > 0 && s.costEvidence === 'known'
      ? round6(s.spendUsd / accepted)
      : null;
    perArm[armId] = {
      spendUsd: s.costEvidence === 'known' ? s.spendUsd : null,
      costEvidence: s.costEvidence,
      attempts: s.attempts,
      accepted,
      costPerAccepted,
      withinCeiling: costPerAccepted == null ? null : costPerAccepted <= costCeilingUsdPerAccepted,
    };
  }
  if (evidence === 'unknown') {
    // D6: collection never halts on a pricing-table gap, but a comparison whose
    // money column is partly imaginary is not a comparison.
    return { evaluated: false, evidence, perArm, winner: null, reason: 'cost-evidence-unknown' };
  }
  const affordable = eligibleArmIds.filter((id) => perArm[id].withinCeiling === true);
  if (affordable.length === 0) {
    return { evaluated: true, evidence, perArm, winner: null, reason: 'no-arm-within-cost-ceiling' };
  }
  let winner = affordable[0];
  for (const id of affordable) {
    const a = perArm[id].costPerAccepted;
    const b = perArm[winner].costPerAccepted;
    if (a < b) winner = id;
    // A tie is broken by arm id so two reads of one dataset cannot disagree.
    else if (a === b && id < winner) winner = id;
  }
  return { evaluated: true, evidence, perArm, winner, reason: null };
}

/**
 * Is the decision the same at every plausible matcher threshold?
 *
 * **This replaces validating a point threshold, and the reason is measured.**
 * The cross-model cutoff (0.14) rests on a fixture whose own status reads
 * "PROVISIONAL — labels are model-generated ... Not a validated calibration."
 * The instinct is to validate it. The measurement says not to bother: on the
 * live cohort the floor metric took ONE distinct value across thresholds 0.00
 * to 0.90, and a controlled probe shows why — §2.5c-i credits each arm on its
 * OWN member's terminal event, so a CROSS-arm merge cannot move any arm's
 * count, and the denominator is complete snapshots, not clusters. Only
 * WITHIN-arm merging moves the metric (positive control: it does).
 *
 * So the threshold is not a number to be validated in advance; it is a number
 * whose wrongness is DETECTABLE PER DECISION. Sweep it, and:
 *   - if the outcome is identical at every variant, say so and proceed — the
 *     verdict did not depend on the calibration, which is a stronger statement
 *     than "the calibration was validated";
 *   - if it flips, refuse. That is a real finding about this cohort, and it
 *     names the human effort worth spending.
 *
 * Cheap by construction: near-invariance is the expected case, so this gate
 * almost never fires, and when it does it means something happened.
 *
 * @param {{config: object, snapshots: Array<object>, variants: Array<{label: string, clusters: Array<object>}>}} input
 */
export function assessThresholdSensitivity({ config, snapshots = [], variants = [] }) {
  if (!variants.length) {
    return { assessed: false, invariant: null, outcomes: [], reason: 'no variants supplied' };
  }
  const nonReplicate = config.arms.filter((a) => a.type !== 'replicate');
  const armIds = nonReplicate.map((a) => a.id);
  const incumbent = nonReplicate.find((a) => a.model === config.decision.incumbent);
  if (!incumbent) throw new Error('[campaign/verdict] sensitivity needs a declared incumbent arm');

  const matrix = completionMatrix(snapshots, armIds);
  const complete = new Set(matrix.complete);
  const nComplete = matrix.complete.length;
  const spend = armSpend(snapshots);

  const outcomes = variants.map(({ label, clusters }) => {
    const scoped = (clusters || []).filter((c) => complete.has(c.snapshotId));
    const { perArm: acceptedPerArm } = creditAccepted(scoped);
    const floor = evaluateFloor({
      acceptedPerArm, nComplete, incumbentArmId: incumbent.id,
      floorMargin: config.decisionRule.floorMargin, armIds,
    });
    const cost = evaluateCost({
      eligibleArmIds: floor.cleared, acceptedPerArm, spend,
      costCeilingUsdPerAccepted: config.decisionRule.costCeilingUsdPerAccepted,
    });
    return {
      label,
      degenerate: floor.degenerate,
      cleared: [...floor.cleared].sort(),
      winner: cost.winner ?? null,
      // The SIGNATURE is what invariance is judged on: the decision, not the
      // arithmetic behind it. Two variants that pick the same arm for different
      // reasons still agree about what to do.
      signature: JSON.stringify({ degenerate: floor.degenerate, cleared: [...floor.cleared].sort(), winner: cost.winner ?? null }),
    };
  });

  const distinct = new Set(outcomes.map((o) => o.signature));
  return {
    assessed: true,
    invariant: distinct.size === 1,
    outcomes,
    distinctOutcomes: distinct.size,
    reason: distinct.size === 1
      ? `identical decision at all ${outcomes.length} matcher variant(s) — this verdict does not depend on the calibration`
      : `the decision CHANGES across matcher variants (${distinct.size} distinct outcomes) — the calibration is load-bearing for this cohort`,
  };
}

/**
 * The decision-eligibility gates (§2.5d pane 2). Standings ALWAYS render; the
 * watermark names every failing gate, because a gate that doesn't say why reads
 * as arbitrary and gets argued with rather than fixed.
 *
 * Returned in a fixed order so the watermark text is stable across reads.
 */
export function evaluateGates({
  config, nComplete, adjudication, calibration, clustering, cohortSuperseded, sensitivity = null,
}) {
  const gates = [];
  const push = (id, ok, detail) => gates.push({ id, ok, detail });

  push('target-n-floor', config.targetN >= MIN_TARGET_N,
    `targetN ${config.targetN} (floor ${MIN_TARGET_N})`);
  push('n-complete', nComplete >= config.targetN,
    `${nComplete} complete of ${config.targetN} target`);
  push('cohort-live', !cohortSuperseded,
    cohortSuperseded ? 'cohort superseded by lock drift' : 'cohort current');

  const unadjudicated = adjudication?.unadjudicatedFindings ?? 0;
  push('adjudication-coverage', unadjudicated === 0,
    `${unadjudicated} finding(s) with no terminal adjudication`);

  const humanQueue = adjudication?.humanQueuePending ?? 0;
  push('human-queue-cleared', humanQueue === 0,
    `${humanQueue} judgement/unverifiable finding(s) awaiting a human disposition`);

  const calibrationGaps = calibrationShortfall(calibration);
  push('calibration-sample', calibrationGaps.length === 0,
    calibrationGaps.length === 0
      ? 'assigned calibration sample dispositioned for every arm'
      : calibrationGaps.map((g) => `${g.armId}: ${g.dispositioned}/${g.assigned}`).join('; '));

  // Assessed → invariance decides. NOT assessed → this gate cannot claim
  // anything, so it passes and an ADVISORY says the check did not run. Failing
  // it unassessed would watermark every reader that does not re-cluster (the
  // dashboard); passing it silently would be the "green having checked nothing"
  // shape. Naming the absence is the honest third option.
  push('threshold-invariance', sensitivity?.assessed ? sensitivity.invariant === true : true,
    sensitivity?.assessed
      ? sensitivity.reason
      : 'not assessed by this reader — run `node scripts/campaign.mjs verdict` for the swept check');

  const missingClusters = clustering?.snapshotsMissingClusters ?? [];
  push('attribution', missingClusters.length === 0,
    missingClusters.length === 0
      ? `clustered under matcher ${clustering?.matcherVersion ?? 'unknown'}`
      : `${missingClusters.length} complete snapshot(s) unclustered: ${missingClusters.slice(0, 5).join(', ')}`);

  return gates;
}

/**
 * Arms whose assigned calibration sample is not fully dispositioned.
 *
 * `not-applicable` arms (zero agent verdicts — they contributed no evidence to
 * calibrate) are distinct from `pending` and never block: requiring a human to
 * review nothing would make the gate unsatisfiable by doing the work correctly,
 * which is the cried-wolf shape this repo has already paid for once.
 */
export function calibrationShortfall(calibration) {
  const out = [];
  for (const [armId, c] of Object.entries(calibration?.perArm ?? {})) {
    if ((c.agentVerdicts ?? 0) === 0) continue;              // not-applicable
    if ((c.dispositioned ?? 0) < (c.assigned ?? 0)) {
      out.push({ armId, assigned: c.assigned ?? 0, dispositioned: c.dispositioned ?? 0 });
    }
  }
  return out.sort((a, b) => (a.armId < b.armId ? -1 : 1));
}

/**
 * §5's state, DERIVED on every read. There is no `state` column: a cache no
 * writer may branch on is a column whose only possible contribution is to be
 * stale, and a stored state machine with three writers (collector, adjudicator,
 * override CLI) is the concurrency bug the derivation avoids.
 */
export function deriveState({ gates, declaredInconclusive, cohortSuperseded, floor, nComplete, config }) {
  if (cohortSuperseded) return { state: 'SUPERSEDED', reason: 'lock drift orphaned this cohort' };
  if (declaredInconclusive) {
    return { state: 'INCONCLUSIVE', reason: declaredInconclusive.reason ?? 'declared by operator' };
  }
  if (config.targetN < MIN_TARGET_N) {
    return { state: 'INCONCLUSIVE', reason: `targetN ${config.targetN} is below the ${MIN_TARGET_N} floor — no verdict is supportable at this N` };
  }
  const gate = (id) => gates.find((g) => g.id === id);
  if (!gate('n-complete').ok) {
    return { state: 'COLLECTING', reason: `${nComplete} of ${config.targetN} snapshots complete` };
  }
  // The degenerate-baseline check runs only once N is reached: before that, a
  // low incumbent score is an artefact of a small cohort, not a finding about it.
  if (floor.degenerate) {
    return {
      state: 'INCONCLUSIVE',
      reason: `incumbent-floor-degenerate: the incumbent's own accepted-per-snapshot (${floor.incumbentPerSnapshot}) is below the floor margin (${floor.floorMargin}) — this cohort did not discriminate between the arms`,
    };
  }
  if (!gate('adjudication-coverage').ok) {
    return { state: 'AWAITING_ADJUDICATION', reason: gate('adjudication-coverage').detail };
  }
  if (!gate('human-queue-cleared').ok || !gate('calibration-sample').ok) {
    const pending = [gate('human-queue-cleared'), gate('calibration-sample')].filter((g) => !g.ok);
    return { state: 'AWAITING_REVIEW', reason: pending.map((g) => g.detail).join('; ') };
  }
  if (!gate('attribution').ok) {
    return { state: 'AWAITING_ADJUDICATION', reason: gate('attribution').detail };
  }
  return { state: 'DECISION_READY', reason: 'every gate passed' };
}

/**
 * Evaluate one campaign cohort end to end.
 *
 * Everything is data in and data out. The caller (`campaign.mjs verdict`, the
 * dashboard collector) supplies already-read rows; this decides what they mean.
 *
 * @param {{
 *   config: object,
 *   snapshots: Array<object>,
 *   clusters: Array<object>,
 *   adjudication?: {unadjudicatedFindings?: number, humanQueuePending?: number},
 *   calibration?: {perArm?: Record<string, {assigned?: number, dispositioned?: number, agentVerdicts?: number, overrides?: number, selfFamily?: number}>},
 *   clustering?: {snapshotsMissingClusters?: string[], matcherVersion?: string|null},
 *   cohortSuperseded?: boolean,
 *   declaredInconclusive?: {reason: string}|null,
 *   ruleChangedAfterFirstArmRun?: boolean,
 * }} input
 */
export function evaluateCampaign(input) {
  const {
    config, snapshots = [], clusters = [], adjudication = {}, calibration = {},
    clustering = {}, cohortSuperseded = false, declaredInconclusive = null,
    ruleChangedAfterFirstArmRun = false, sensitivity = null,
  } = input;

  const nonReplicate = config.arms.filter((a) => a.type !== 'replicate');
  const armIds = nonReplicate.map((a) => a.id);
  const incumbentArm = nonReplicate.find((a) => a.model === config.decision.incumbent);
  // The config schema guarantees exactly one incumbent arm; a missing one here
  // means the caller assembled a config this module never validated, and
  // guessing an incumbent would silently compare against the wrong baseline.
  if (!incumbentArm) {
    throw new Error(`[campaign/verdict] no non-replicate arm has model "${config.decision.incumbent}" — the incumbent must be a declared participant`);
  }

  const matrix = completionMatrix(snapshots, armIds);
  const nComplete = matrix.complete.length;
  const completeSet = new Set(matrix.complete);

  // Only clusters on COMPLETE snapshots contribute evidence: an incomplete
  // snapshot enters no denominator, so crediting its findings would put a
  // numerator over a denominator that excludes it.
  const scopedClusters = clusters.filter((c) => completeSet.has(c.snapshotId));
  const { perArm: acceptedPerArm, credited } = creditAccepted(scopedClusters);

  const floor = evaluateFloor({
    acceptedPerArm, nComplete, incumbentArmId: incumbentArm.id,
    floorMargin: config.decisionRule.floorMargin, armIds,
  });

  // Spend spans EVERY snapshot's arm-runs, complete or not, live or superseded:
  // an incomplete snapshot's calls were still paid for. It is reported, and it
  // is deliberately not divided by a denominator it is not part of — the cost
  // stage only runs when the cohort is complete.
  const spend = armSpend(snapshots);

  const gates = evaluateGates({ config, nComplete, adjudication, calibration, clustering, cohortSuperseded, sensitivity });
  const { state, reason } = deriveState({ gates, declaredInconclusive, cohortSuperseded, floor, nComplete, config });

  const failingGates = gates.filter((g) => !g.ok);
  // Eligibility is the CONJUNCTION of the lifecycle state and every gate — not
  // the state alone.
  //
  // `deriveState` re-checks most gates by hand, so for a while the two agreed
  // and the distinction looked cosmetic. It is not: a gate `deriveState` does
  // not know about was completely inert, because eligibility never consulted it
  // AND the watermark only renders when ineligible — so a failing gate rendered
  // NOWHERE. Adding `threshold-invariance` walked straight into that (it read
  // `invariant: false` and the campaign stayed DECISION_READY). Making this a
  // conjunction means any gate added later is load-bearing by construction,
  // rather than load-bearing only if someone remembers to teach `deriveState`
  // about it too.
  const decisionEligible = state === 'DECISION_READY' && failingGates.length === 0;

  let cost = { evaluated: false, evidence: 'not-evaluated', perArm: {}, winner: null, reason: 'floor stage not reached' };
  let verdict = null;
  if (decisionEligible) {
    cost = evaluateCost({
      eligibleArmIds: floor.cleared, acceptedPerArm, spend,
      costCeilingUsdPerAccepted: config.decisionRule.costCeilingUsdPerAccepted,
    });
    if (floor.cleared.length === 0) {
      verdict = { outcome: 'INCONCLUSIVE', reason: 'no arm cleared the effectiveness floor' };
    } else if (cost.winner) {
      verdict = { outcome: 'SELECT', armId: cost.winner, reason: `cleared the floor and won on ${config.decisionRule.tiebreak}` };
    } else {
      verdict = { outcome: 'INCONCLUSIVE', reason: cost.reason };
    }
  }

  const advisories = [];
  if (!sensitivity?.assessed) {
    // The verdict is being read without the swept check. Say so rather than let
    // a silent pass imply the calibration was shown not to matter.
    advisories.push({
      id: 'threshold-sensitivity-unassessed',
      detail: 'matcher-threshold sensitivity was not swept by this reader — the verdict may or may not depend on the calibration',
    });
  }
  if (ruleChangedAfterFirstArmRun) {
    // Pre-registration is protected by recording that the goalposts moved, not
    // by destroying the evidence — hashing an analysis-time field would mean a
    // cost-ceiling edit orphaned every snapshot ever collected.
    advisories.push({
      id: 'rule-changed',
      detail: 'the decision rule changed after the first arm-run was collected — see the campaign_events rule_changed entries',
    });
  }

  return {
    state,
    stateReason: reason,
    decisionEligible,
    watermark: decisionEligible ? null : {
      label: 'NOT DECISION-ELIGIBLE',
      failing: failingGates.map((g) => ({ id: g.id, detail: g.detail })),
    },
    advisories,
    gates,
    nComplete,
    completion: matrix,
    accepted: { perArm: acceptedPerArm, credited },
    floor,
    spend,
    cost,
    verdict,
    sensitivity,
    analysisTimeFields: {
      targetN: config.targetN,
      calibration: config.calibration,
      decisionRule: config.decisionRule,
      matcherVersion: clustering.matcherVersion ?? null,
    },
  };
}
