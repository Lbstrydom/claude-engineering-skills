/**
 * @fileoverview Same-run overlap between a shadow reviewer's findings and the
 * findings the rest of the pipeline already produced in that same audit run.
 *
 * **Why this exists.** A shadow reviewer is bucketed "shadow-only" when the
 * PRIMARY final reviewer did not raise it. That is not the same as "nothing
 * else in the pipeline found it" — the 5-pass GPT audit runs BEFORE final
 * review, so a finding GPT already raised, which the shadow then re-raises at
 * the gate, is still bucketed shadow-only while adding nothing. Read naively,
 * shadow-only is an upper bound on marginal value, not a measurement.
 *
 * The 2026-07 final-review shadow A/B (docs/research/final-review-shadow-
 * adjudication-briefing.md) shipped a KEEP verdict before anyone checked this,
 * and the check had to be reconstructed by hand afterwards. The data was
 * already there: `audit_findings` carries `run_id` + `pass_name`, so the audit
 * passes and the shadow join on the run they shared. Nothing needed building —
 * only knowing to look. This module is that "knowing to look", made standing.
 *
 * **Read the result honestly:**
 * - File-level disjointness is STRONGER than a semantic match, not weaker: two
 *   findings on different files are necessarily different findings. So
 *   `sameFileCount: 0` is a real result, not a failed lookup.
 * - `runsWithBoth` is the denominator that matters. A run carrying no
 *   audit-pass rows proves nothing about overlap, so it is reported separately
 *   and never silently folded into a clean-looking zero.
 * - **This measures WITHIN-run overlap only.** A finding raised by an audit
 *   pass in an EARLIER run and re-raised by the shadow later is invisible here.
 *   That leak is real (confirmed once, fingerprint fd33a4e4) and unmeasured;
 *   `crossRunOverlapMeasured: false` is returned unconditionally so a caller
 *   can never mistake this for a complete answer.
 *
 * @module scripts/lib/model-eval/shadow-overlap
 */

import { many } from '../db/query.mjs';

/** Pass names that are final-review roles, not pipeline audit passes. */
export const FINAL_REVIEW_PASSES = Object.freeze(['final-review', 'final-review-shadow']);

/**
 * Pure core: given already-fetched rows, compute the overlap summary.
 * Separated from the query so the arithmetic is unit-testable without a DB.
 *
 * @param {Array<{run_id:string, pass_name:string, primary_file:string|null}>} rows
 * @param {string} shadowPass
 * @returns {object} overlap summary
 */
export function summariseOverlap(rows, shadowPass = 'final-review-shadow') {
  const byRun = new Map();
  for (const r of rows) {
    if (!byRun.has(r.run_id)) byRun.set(r.run_id, { shadow: new Set(), audit: new Set() });
    const bucket = r.pass_name === shadowPass ? 'shadow'
      : FINAL_REVIEW_PASSES.includes(r.pass_name) ? null
        : 'audit';
    if (bucket && r.primary_file) byRun.get(r.run_id)[bucket].add(r.primary_file);
  }

  let runsWithShadow = 0, runsWithAudit = 0, runsWithBoth = 0;
  let shadowFindingsInBothRuns = 0, sameFileCount = 0;
  const overlaps = [];

  for (const [runId, v] of byRun) {
    const hasShadow = v.shadow.size > 0, hasAudit = v.audit.size > 0;
    if (hasShadow) runsWithShadow++;
    if (hasAudit) runsWithAudit++;
    if (!hasShadow || !hasAudit) continue;
    runsWithBoth++;
    shadowFindingsInBothRuns += v.shadow.size;
    const shared = [...v.shadow].filter((f) => v.audit.has(f));
    if (shared.length) { sameFileCount += shared.length; overlaps.push({ runId, files: shared }); }
  }

  return {
    runsWithShadow,
    runsWithAudit,
    runsWithBoth,
    shadowFindingsInBothRuns,
    sameFileCount,
    overlaps,
    // Never inferable from the numbers above — stated so a caller cannot read
    // a within-run zero as "no overlap at all". See the module docstring.
    crossRunOverlapMeasured: false,
    interpretation: runsWithBoth === 0
      ? 'INCONCLUSIVE — no run carries both shadow and audit-pass findings; overlap is unmeasured, not zero.'
      : sameFileCount === 0
        ? `CLEAN within-run — across ${runsWithBoth} run(s) carrying both, no file was flagged by the shadow AND an audit pass. Cross-run re-raises remain unmeasured.`
        : `OVERLAP — ${sameFileCount} shadow finding(s) landed on a file an audit pass already flagged in the same run; the shadow added nothing there.`,
  };
}

/**
 * Query + summarise. Returns `{ok:false}` shape rather than throwing when the
 * store is unreachable, matching the cross-skill CLI contract.
 *
 * @param {{runIds: string[], shadowPass?: string}} opts
 */
export async function computeShadowOverlap({ runIds, shadowPass = 'final-review-shadow' }) {
  if (!Array.isArray(runIds) || runIds.length === 0) {
    return { ok: false, error: 'runIds must be a non-empty array of audit_run uuids' };
  }
  const rows = await many(
    `SELECT run_id, pass_name, primary_file
       FROM audit_findings
      WHERE run_id = ANY($1::uuid[])`,
    [runIds],
  );
  return { ok: true, runsQueried: runIds.length, findingsScanned: rows.length, ...summariseOverlap(rows, shadowPass) };
}
