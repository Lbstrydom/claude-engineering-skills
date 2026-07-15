/**
 * @fileoverview Two-level outcome-based decision-rule evaluator (v2).
 *
 * Plan: docs/plans/model-ab-harness-v2.md (D5–D8, §4 R2-M3). Replaces v1's
 * ratio-vs-baseline rule with the operator's core model:
 *
 *   LEVEL 1 — quality GATE (disqualify BEFORE ranking): structured-output
 *     conformance ≥ floor and accepted-precision ≥ floor. The plan's third
 *     clause — no sensitive-egress violation — is enforced STRUCTURALLY UPSTREAM
 *     (the shadow hard-aborts a run BEFORE persisting any finding on an egress
 *     refusal), so a scored row's existence already proves no egress violation;
 *     it is a precondition, not a per-arm signal re-derived here. A gated-out arm
 *     is never ranked.
 *   LEVEL 2 — rank the surviving arms by OUTCOME-BASED weighted quality over
 *     PER-ASSIGNMENT canonical clusters (verified-non-quick-fix ≫ quick-fix ≫
 *     nit ≫ dismissed). Cost is NEVER folded into the score — it is a reported
 *     Pareto FRONTIER (€/accepted-weighted, €/accepted-HIGH) alongside recall.
 *
 * Scoring/recall UNIT = (assignment × within-assignment canonical cluster) — NOT
 * the global cluster (finding_equivalence is semantic-global, so the same bug in
 * two assignments is TWO detection events; dedup is cross-ARM WITHIN an
 * assignment only — §4 R2-M3 / Gemini R1). An arm gets credit ONCE per accepted
 * cluster it reached, at that cluster's adjudicated severity × BEST qualMult
 * among its findings; SUMMED across prospective + prompt_variant='default'
 * assignments.
 *
 * MIN_ASSIGNMENTS counts DISTINCT (commit_sha × stage_type) = distinct CODE, NOT
 * assignment_id (which includes attempt/variant) — else 20 reruns of ONE commit
 * satisfy the diversity floor (the v1 bug, Gemini R1). The headline filter
 * (phase='prospective' + prompt_variant='default') + distinct-code count keep
 * calibration, probe, and rerun data out of the ranking signal.
 *
 * Constants are CALIBRATED on the known-bug calibration set, then FROZEN before
 * the prospective run (§3 H3). The values here are the calibration STARTING
 * point — DO NOT tune them against prospective data (that breaks pre-registration).
 *
 * PURE — no I/O. The CLI (cross-skill.mjs model-ab-decision) reads the finding-
 * grain (model_ab_finding_scores) + cost (model_ab_arm_cost) views and calls
 * `evaluateDecision`.
 *
 * @module scripts/lib/model-ab-decision
 */

import { EUR_PER_USD } from './model-pricing.mjs';
import { ARM_IDS } from './audit-arms.mjs';

/** Pinned pre-registered constants — calibrate-then-freeze (plan §3 H3 / §4 R2-M3). */
export const DECISION_CONSTANTS = Object.freeze({
  // Severity weight of a canonical cluster (the cluster's adjudicated severity).
  SEV_WEIGHTS: Object.freeze({ LOW: 1, MEDIUM: 3, HIGH: 8, CRITICAL: 15 }),
  // Base quality multiplier by remediation state (best across a cluster's findings).
  QUAL_BASE: Object.freeze({ verified: 1.0, fixed: 0.6, planned: 0.5, pending: 0.5, regressed: 0.5 }),
  QUICK_FIX_MULT: 0.4,   // an accepted quick-fix is discounted (×0.4)
  ALPHA: 0.35,           // unique-coverage bonus weight (a cluster only this arm reached)
  LAMBDA: 1.0,           // FP penalty per DISMISSED finding (each = 1 LOW-equiv)
  REG_PEN: 8,            // penalty per REGRESSED cluster an arm reached
  PRECISION_FLOOR: 0.30, // GATE: accepted / (accepted + dismissed) findings
  MIN_CONFORMANCE: 0.98, // GATE: structured-output conformance rate
  MIN_ASSIGNMENTS: 12,   // decidability: distinct (commit_sha × stage_type) code units (D10 N=12–25)
});

const VALID_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/** Normalize a raw severity to the weight-table domain (default MEDIUM). */
export function normalizeSeverity(sev) {
  if (typeof sev !== 'string') return 'MEDIUM';
  let s = sev.toUpperCase().trim();
  if (s === 'MED') s = 'MEDIUM';
  if (s === 'CRIT') s = 'CRITICAL';
  return VALID_SEVERITIES.has(s) ? s : 'MEDIUM';
}

/** Severity weight of a cluster. */
export function sevW(severity, C = DECISION_CONSTANTS) {
  return C.SEV_WEIGHTS[normalizeSeverity(severity)] ?? C.SEV_WEIGHTS.MEDIUM;
}

/**
 * Quality multiplier for ONE finding (pure function of ledger state — plan H4):
 * base(remediation_state) × (is_quick_fix ? 0.4 : 1). The cluster takes the BEST
 * (max) multiplier among its findings (§4 R2-M3).
 */
export function qualMult(remediationState, isQuickFix, C = DECISION_CONSTANTS) {
  const base = C.QUAL_BASE[remediationState] ?? C.QUAL_BASE.pending;
  return isQuickFix ? base * C.QUICK_FIX_MULT : base;
}

/**
 * Fold finding-grain rows into (assignment × canonical) clusters over the
 * HEADLINE scope (phase='prospective' AND prompt_variant='default'). Returns the
 * cluster map + the distinct-code count for the decidability gate.
 *
 * NOTE: `distinctAssignments` here is the FINDING-derived count; the authoritative
 * decidability count (`distinctCodeUnits`, used by evaluateDecision) unions in
 * cost/pass-stats rows so ZERO-finding assignments also count (audit R2 79679362).
 *
 * @param {Array<object>} findingRows - rows from model_ab_finding_scores
 * @returns {{ clusters: Map<string,object>, codeUnits:Set<string>, distinctAssignments:number, armsSeen:Set<string> }}
 */
export function buildClusters(findingRows) {
  const clusters = new Map(); // `${assignment_id}::${canonical_id}` → cluster
  const distinctCode = new Set(); // (commit_sha × stage_type)
  const armsSeen = new Set();
  for (const r of findingRows || []) {
    // Headline filter: only prospective + default variant enter the ranking.
    if (r.phase !== 'prospective') continue;
    const promptVariant = r.prompt_variant ?? 'default';
    if (promptVariant !== 'default') continue;
    const arm = r.arm;
    if (!ARM_IDS.includes(arm)) continue; // __INVALID__/other excluded (SSoT: audit-arms)
    // Guard a missing canonical_id (audit R2 cf63f2c2): the view COALESCEs it to
    // the finding_fingerprint so it is never null in practice, but a null/empty
    // value would collapse UNRELATED findings into one synthetic `id::undefined`
    // cluster — skip fail-closed rather than mis-cluster.
    if (r.canonical_id == null || r.canonical_id === '') continue;
    armsSeen.add(arm);

    const assignmentId = r.assignment_id ?? r.commit_sha ?? r.run_id ?? 'unknown';
    const stageType = r.stage_type ?? 'audit-code';
    // Distinct CODE = distinct (commit_sha × stage_type), commit-only, NO
    // fallback to assignment_id/run_id (which include attempt/variant) — the
    // diversity floor (Gemini R1 / audit R3). A row without a commit_sha can't
    // attest to code diversity.
    if (r.commit_sha != null && r.commit_sha !== '') distinctCode.add(`${r.commit_sha}::${stageType}`);

    const key = `${assignmentId}::${r.canonical_id}`;
    let c = clusters.get(key);
    if (!c) {
      c = {
        assignmentId, canonicalId: r.canonical_id, stageType,
        armsReached: new Set(), outcome: 'pending', maxSevW: 0, bestQualMult: 0,
        regressed: false,
        // per-arm finding tallies (precision + FP penalty are per-FINDING).
        // NOTE (audit R1 07c50fd0 design intent): maxSevW + bestQualMult are
        // CLUSTER-level by design — a cluster is one canonical issue, and its
        // severity (human-adjudicated on the canonical) + fix quality
        // (remediation of the shared fix — Claude is the constant coder) are
        // properties of the ISSUE, not of which arm detected it. Every arm that
        // reached the cluster is credited with the issue's value (recall-style,
        // §4 R2-M3 "best qualMult among the cluster's findings"); arms are
        // DIFFERENTIATED by WHICH clusters they reached + the unique-coverage
        // bonus + the per-finding FP penalty, not by re-valuing a shared issue.
        acceptedFindings: Object.fromEntries(ARM_IDS.map((a) => [a, 0])),
        dismissedFindings: Object.fromEntries(ARM_IDS.map((a) => [a, 0])),
      };
      clusters.set(key, c);
    }
    c.armsReached.add(arm);
    const outcome = r.outcome ?? 'pending';
    // Cluster outcome: accepted wins over dismissed wins over pending.
    if (outcome === 'accepted') c.outcome = 'accepted';
    else if (outcome === 'dismissed' && c.outcome !== 'accepted') c.outcome = 'dismissed';
    if (outcome === 'accepted') c.acceptedFindings[arm] += 1;
    else if (outcome === 'dismissed') c.dismissedFindings[arm] += 1;
    // Cluster severity + quality + regression derive ONLY from ACCEPTED findings
    // (audit R3 07c50fd0-contamination): a DISMISSED finding in the same
    // canonical cluster is noise — its severity/remediation must not inflate the
    // value the arm is credited with. Only accepted clusters are scored anyway,
    // so pending/dismissed-only clusters keep the zero defaults harmlessly.
    if (outcome === 'accepted') {
      c.maxSevW = Math.max(c.maxSevW, sevW(r.severity));
      c.bestQualMult = Math.max(c.bestQualMult, qualMult(r.remediation_state ?? 'pending', !!r.is_quick_fix));
      if ((r.remediation_state ?? 'pending') === 'regressed') c.regressed = true;
    }
  }
  return { clusters, codeUnits: distinctCode, distinctAssignments: distinctCode.size, armsSeen };
}

/**
 * Distinct (commit_sha × stage_type) code units across BOTH finding rows AND cost
 * rows, headline-scoped. Cost (pass_stats) rows exist for EVERY executed
 * assignment — including ones that produced ZERO findings — so unioning them in
 * counts zero-finding assignments toward the decidability floor (audit R2
 * 79679362/bcfe3389: the earlier finding-only count silently dropped them).
 */
export function distinctCodeUnits(findingRows, costRows) {
  const set = new Set();
  const add = (r) => {
    if (r.phase !== 'prospective') return;
    if ((r.prompt_variant ?? 'default') !== 'default') return;
    const stageType = r.stage_type ?? 'audit-code';
    // The diversity floor counts distinct CODE = distinct (commit_sha × stage_type)
    // ONLY (audit R3): NEVER fall back to assignment_id/run_id, which include
    // attempt/variant — a fallback would let reruns of one commit (with a null
    // commit_sha) inflate the count, re-introducing the exact v1 diversity bug.
    // A row with no commit_sha cannot attest to code diversity → skip it.
    if (r.commit_sha == null || r.commit_sha === '') return;
    set.add(`${r.commit_sha}::${stageType}`);
  };
  for (const r of findingRows || []) add(r);
  for (const r of costRows || []) add(r);
  return set;
}

/**
 * Fold cost rows into per-arm standalone cost + conformance (headline scope).
 * `costKnown` is CONSERVATIVE (audit R1 fe21cf7b/3ac051aa): an arm's cost is
 * known only when it had ≥1 row AND EVERY contributing row is priced +
 * meterable. A single unknown/unmeterable row makes the whole arm's cost
 * unknown, so the €-frontier degrades to `null` (never a partial understatement
 * read as authoritative).
 */
export function aggregateCost(costRows) {
  const byArm = new Map(); // arm → { standaloneUsd, hasRows, anyUnknown, conformNum, conformDen }
  for (const r of costRows || []) {
    if (r.phase !== 'prospective') continue;
    if ((r.prompt_variant ?? 'default') !== 'default') continue;
    const arm = r.arm;
    if (!ARM_IDS.includes(arm)) continue;
    if (!byArm.has(arm)) byArm.set(arm, { standaloneUsd: 0, hasRows: false, anyUnknown: false, conformNum: 0, conformDen: 0 });
    const a = byArm.get(arm);
    a.hasRows = true;
    // A row is "unknown cost" if unpriced (cost null / cost_known false) OR its
    // usage was unmeterable — either way the summed total would understate.
    const rowUnknown = r.standalone_cost_usd == null || r.cost_known === false || r.any_unmeterable === true;
    if (rowUnknown) a.anyUnknown = true;
    else a.standaloneUsd += Number(r.standalone_cost_usd);
    if (r.conformant_passes != null && r.pass_executions != null) {
      a.conformNum += Number(r.conformant_passes); a.conformDen += Number(r.pass_executions);
    }
  }
  // Derive the conservative costKnown flag.
  for (const a of byArm.values()) a.costKnown = a.hasRows && !a.anyUnknown;
  return byArm;
}

/**
 * Compute the full per-arm scorecard + gate + frontier + ranking.
 *
 * @param {Array<object>} findingRows - model_ab_finding_scores rows
 * @param {Array<object>} [costRows]  - model_ab_arm_cost rows
 * @param {object} [constants=DECISION_CONSTANTS]
 * @returns {{ constants:object, status:string, distinctAssignments:number,
 *   headline:object, arms:object, ranking:object[], baselineArm:string,
 *   totalAcceptedClusters:number }}
 */
export function evaluateDecision(findingRows, costRows = [], constants = DECISION_CONSTANTS) {
  const C = constants;
  const { clusters } = buildClusters(findingRows);
  const cost = aggregateCost(costRows);
  // Count distinct code across finding AND cost rows so zero-finding assignments
  // (which still have pass_stats/cost rows) count toward the decidability floor.
  const distinctAssignments = distinctCodeUnits(findingRows, costRows).size;

  // Decidability gate (before any ranking).
  const clusterList = [...clusters.values()];
  const anyPending = clusterList.some((c) => c.outcome === 'pending');
  const acceptedClusters = clusterList.filter((c) => c.outcome === 'accepted');
  const totalAcceptedClusters = acceptedClusters.length;

  const base = {
    constants: C,
    headline: { phase: 'prospective', promptVariant: 'default' },
    distinctAssignments,
    baselineArm: 'A',
    totalAcceptedClusters,
    arms: {},
    ranking: [],
  };

  if (distinctAssignments < C.MIN_ASSIGNMENTS) {
    return { ...base, status: 'collecting',
      reason: `${distinctAssignments}/${C.MIN_ASSIGNMENTS} distinct (commit × stage_type) code units` };
  }
  if (anyPending) {
    const n = clusterList.filter((c) => c.outcome === 'pending').length;
    return { ...base, status: 'awaiting-adjudication', reason: `${n} cluster(s) still pending human adjudication` };
  }
  if (totalAcceptedClusters === 0) {
    return { ...base, status: 'insufficient-baseline', reason: 'no accepted clusters — nothing to rank' };
  }

  // Per-arm scorecard.
  const armIds = [...ARM_IDS];
  const perArm = {};
  for (const arm of armIds) {
    let score = 0, acceptedWeighted = 0, acceptedHigh = 0, reachedAccepted = 0, uniqueBonus = 0, regCount = 0;
    let acceptedFindings = 0, dismissedFindings = 0;
    for (const c of acceptedClusters) {
      if (!c.armsReached.has(arm)) continue;
      reachedAccepted += 1;
      const w = c.maxSevW * c.bestQualMult;
      acceptedWeighted += w;
      score += w;
      if (normalizeSeverityBucketIsHigh(c)) acceptedHigh += 1;
      if (c.armsReached.size === 1) uniqueBonus += C.ALPHA * c.maxSevW;
      if (c.regressed) regCount += 1;
    }
    // FP penalty + precision are per-FINDING (noise is noise regardless of clustering).
    for (const c of clusterList) {
      acceptedFindings += c.acceptedFindings[arm] || 0;
      dismissedFindings += c.dismissedFindings[arm] || 0;
    }
    score += uniqueBonus;
    score -= C.LAMBDA * dismissedFindings;
    score -= C.REG_PEN * regCount;

    // Gate inputs.
    const armCost = cost.get(arm) || { standaloneUsd: 0, costKnown: false, conformNum: 0, conformDen: 0 };
    const conformanceRate = armCost.conformDen > 0 ? armCost.conformNum / armCost.conformDen : null;
    const precisionDen = acceptedFindings + dismissedFindings;
    const precision = precisionDen > 0 ? acceptedFindings / precisionDen : null;

    // LEVEL-1 GATE. The plan's three clauses are conformance, sensitive-egress,
    // and precision. EGRESS is enforced STRUCTURALLY UPSTREAM (audit R1 298804ee):
    // the shadow's OSS adapter + shared egress gate hard-ABORT a run on any
    // sensitive-egress refusal BEFORE a single finding/pass-stat is persisted, so
    // the mere EXISTENCE of scored rows for a run proves no egress violation
    // occurred for it. The gate therefore does not (and cannot) re-derive egress
    // from the view — it is a precondition, not a per-arm signal. What remains to
    // check here is conformance + precision.
    const gateReasons = [];
    let passesGate = true;
    if (conformanceRate == null) { passesGate = false; gateReasons.push('conformance unknown — cannot clear gate (fail-closed)'); }
    else if (conformanceRate < C.MIN_CONFORMANCE) { passesGate = false; gateReasons.push(`conformance ${conformanceRate.toFixed(3)} < ${C.MIN_CONFORMANCE}`); }
    if (precision == null) { passesGate = false; gateReasons.push('precision undefined (no adjudicated findings) — cannot clear gate'); }
    else if (precision < C.PRECISION_FLOOR) { passesGate = false; gateReasons.push(`precision ${precision.toFixed(2)} < ${C.PRECISION_FLOOR}`); }
    if (passesGate && gateReasons.length === 0) gateReasons.push('conformance + precision floors met (egress enforced structurally upstream)');

    // Recall = accepted clusters reached / all accepted clusters (union).
    const recall = totalAcceptedClusters > 0 ? reachedAccepted / totalAcceptedClusters : null;

    // Frontier (cost NEVER folded into score — reported alongside).
    const standaloneEur = armCost.costKnown ? armCost.standaloneUsd * EUR_PER_USD : null;
    const eurPerAcceptedWeighted = (standaloneEur != null && acceptedWeighted > 0) ? standaloneEur / acceptedWeighted : null;
    const eurPerAcceptedHigh = (standaloneEur != null && acceptedHigh > 0) ? standaloneEur / acceptedHigh : null;

    perArm[arm] = {
      arm, score: round4(score),
      acceptedWeighted: round4(acceptedWeighted),
      reachedAcceptedClusters: reachedAccepted,
      uniqueBonus: round4(uniqueBonus),
      acceptedHighClusters: acceptedHigh,
      regressedClusters: regCount,
      acceptedFindings, dismissedFindings,
      precision: precision == null ? null : round4(precision),
      conformanceRate: conformanceRate == null ? null : round4(conformanceRate),
      recall: recall == null ? null : round4(recall),
      gate: { passes: passesGate, reasons: gateReasons },
      frontier: {
        standaloneEur: standaloneEur == null ? null : round4(standaloneEur),
        eurPerAcceptedWeighted: eurPerAcceptedWeighted == null ? null : round4(eurPerAcceptedWeighted),
        eurPerAcceptedHigh: eurPerAcceptedHigh == null ? null : round4(eurPerAcceptedHigh),
      },
    };
  }

  // Rank the GATED-IN arms by weighted-quality score (desc). Gated-out arms are
  // reported but never ranked (Level 1 precedes Level 2).
  const ranking = armIds
    .map((a) => perArm[a])
    .filter((a) => a.gate.passes)
    .sort((x, y) => y.score - x.score);

  return { ...base, status: 'decide', arms: perArm, ranking };
}

// A cluster counts as HIGH iff its adjudicated severity weight is ≥ the HIGH
// weight — computed from the cluster's max severity weight vs the HIGH constant.
function normalizeSeverityBucketIsHigh(cluster, C = DECISION_CONSTANTS) {
  return cluster.maxSevW >= C.SEV_WEIGHTS.HIGH;
}

// @duplicate-justification: target=scripts/lib/arm-eval/decision.mjs:round4 reason=arm-eval-stats and model-ab-decision are deliberately independent shadow-evaluation systems (AGENTS.md "Model-A/B/C shadow CONCLUDED" and "Arm-eval framework" sections) -- not accidental duplication, do not merge
function round4(n) {
  return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : n;
}
