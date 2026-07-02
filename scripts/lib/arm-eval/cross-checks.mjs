/**
 * @fileoverview Pluggable objective cross-checks for arm-eval (D8 / §10.5).
 *
 * Plan: docs/plans/arm-eval-framework.md §10.5. For the plan experiment, run
 * OBJECTIVE signals alongside the blinded rubric judge — reported, never an
 * auto-override (a sharp disagreement is a `flag` for human inspection):
 *   - audit-proxy        — the FIXED /audit-plan accepted-weighted defect load
 *   - arch-memory-reuse  — does the plan REINVENT symbols that already exist?
 *   - requirements-invariant — does the plan contradict an active invariant?
 *   - security-incident  — does the plan re-tread a known incident class?
 *
 * Each check returns a typed CrossCheck result. FAIL-CLOSED: a missing input or
 * an unwired dependency yields `status:'unavailable'` (or `'error'`), NEVER a
 * fabricated pass. Per-check runners are injectable (`deps`) for tests.
 *
 * @module scripts/lib/arm-eval/cross-checks
 */

export const CROSS_CHECK_VERSION = '1';

/** Normalize any check runner's return into the CrossCheck envelope. */
function envelope(checkName, partial) {
  return {
    checkName,
    checkVersion: CROSS_CHECK_VERSION,
    status: partial.status,                 // ok | flag | unavailable | error
    score: partial.score ?? null,
    findings: partial.findings ?? null,
    evidenceRefs: partial.evidenceRefs ?? null,
    failureReason: partial.failureReason ?? null,
  };
}

/** The registered checks. Each: async (ctx, deps) → partial CrossCheck. */
export const CHECKS = Object.freeze({
  'audit-proxy': async (ctx, deps) => {
    if (typeof deps.auditProxy !== 'function') return { status: 'unavailable', failureReason: 'auditProxy dep not wired' };
    if (!ctx.planText) return { status: 'unavailable', failureReason: 'no plan text' };
    const r = await deps.auditProxy({ planText: ctx.planText });
    // Lower defect load = better; report as score (defect load) + finding count.
    return { status: 'ok', score: r.load ?? null, findings: r.findings ?? null, evidenceRefs: r.runId ? { auditRunId: r.runId } : null };
  },
  'arch-memory-reuse': async (ctx, deps) => {
    if (typeof deps.getNeighbourhood !== 'function') return { status: 'unavailable', failureReason: 'getNeighbourhood dep not wired' };
    const paths = ctx.planIntent?.targetPaths || [];
    if (!paths.length) return { status: 'unavailable', failureReason: 'plan carries no parseable target paths (§10.10 intent block missing)' };
    const r = await deps.getNeighbourhood({ targetPaths: paths, intentDescription: ctx.intentDescription || '' });
    const recs = r.records || r.recommendations || [];
    // INFORMATIONAL only (Gemini gate fix): getNeighbourhood recommends 'reuse'
    // because reusable symbols EXIST near these paths — NOT because this plan
    // reinvents them. We cannot reliably parse "proposed new symbols" from a plan
    // DOCUMENT, so flagging any 'reuse' rec would penalize every plan touching a
    // populated area. Report the nearby reuse candidates as context for the judge/
    // human; never a penalty. (Reinvention detection is v-next, needs code.)
    const reuseCandidates = recs.filter((x) => ['reuse', 'extend'].includes((x.recommendation || '').toLowerCase()));
    return { status: 'ok', score: null, findings: reuseCandidates.slice(0, 10), evidenceRefs: { note: 'informational — nearby reuse candidates, not a reinvention penalty' } };
  },
  'requirements-invariant': async (ctx, deps) => {
    if (typeof deps.checkRequirements !== 'function') return { status: 'unavailable', failureReason: 'checkRequirements dep not wired' };
    if (!ctx.planText) return { status: 'unavailable', failureReason: 'no plan text' };
    const r = await deps.checkRequirements({ planText: ctx.planText });
    const violations = r.violations || [];
    return { status: violations.length ? 'flag' : 'ok', score: violations.length, findings: violations };
  },
  'security-incident': async (ctx, deps) => {
    if (typeof deps.getIncidentNeighbourhood !== 'function') return { status: 'unavailable', failureReason: 'getIncidentNeighbourhood dep not wired' };
    const paths = ctx.planIntent?.targetPaths || [];
    if (!paths.length) return { status: 'unavailable', failureReason: 'no target paths to match incidents against' };
    const r = await deps.getIncidentNeighbourhood({ targetPaths: paths, intentDescription: ctx.intentDescription || '' });
    const incidents = r.incidents || [];
    return { status: incidents.length ? 'flag' : 'ok', score: incidents.length, findings: incidents.slice(0, 10) };
  },
});

/**
 * Run the declared cross-checks for one produced plan.
 * @param {{ checks:string[], planText?:string, planIntent?:object, intentDescription?:string, deps?:object }} input
 * @returns {Promise<object[]>} CrossCheck envelopes
 */
export async function runCrossChecks({ checks = [], planText = null, planIntent = null, intentDescription = '', deps = {} }) {
  const ctx = { planText, planIntent, intentDescription };
  const out = [];
  for (const name of checks) {
    const runner = CHECKS[name];
    if (!runner) { out.push(envelope(name, { status: 'error', failureReason: `unknown cross-check "${name}"` })); continue; }
    try {
      out.push(envelope(name, await runner(ctx, deps)));
    } catch (err) {
      out.push(envelope(name, { status: 'error', failureReason: err.message }));
    }
  }
  return out;
}
