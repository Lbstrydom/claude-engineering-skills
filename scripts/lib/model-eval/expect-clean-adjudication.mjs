/**
 * @fileoverview Adjudicated scoring for an `expect_clean` report. The raw run only says which cases drew a MEDIUM+ finding; that is a
 * count of FLAGGED cases, and on a curated corpus it measures how clean the corpus is as much as how noisy the model is (2026-11-20: 11/11
 * flagged, yet 1 of 107 findings was a false claim and 52 were real defects). What distinguishes the two is a verdict per finding, so this
 * module scores a report against a list of them: `falseClaims` (WRONG), `realDefects` (REAL), `nits` (NOT_A_DEFECT), and `notClean`, the
 * cases that carry at least one REAL defect. Pure: no I/O, no model calls.
 *
 * The result says it is `complete` only when nothing is guessed: every finding has exactly one verdict, no verdict is orphaned or stale,
 * the report's own identities are unambiguous, every flagged case kept its findings, and the SOURCE run was whole (no failed case, no
 * cap stop). Anything less is `complete: false` with the reasons named, never a smaller-looking success.
 *
 * @module scripts/lib/model-eval/expect-clean-adjudication
 */
import crypto from 'node:crypto';

export const VERDICTS = Object.freeze(['REAL', 'NOT_A_DEFECT', 'WRONG', 'UNDETERMINED']);

/** The identity of a finding inside a report: the case, the pass that raised it and its id within that pass. */
export const findingKey = (kdId, f) => `${kdId}:${f?.pass ?? 'unknown'}:${f?.id ?? ''}`;

/**
 * A fingerprint of what a finding CLAIMS. A verdict that carries one is only applied to a finding that still has it, so an id reused by a
 * later, different run cannot inherit an old verdict. (Generation is not deterministic: the same case yields different findings under the same ids.)
 */
export const findingFingerprint = (f) => crypto.createHash('sha256')
  .update([f?.severity, f?.category, f?.section, f?.detail].map((x) => String(x ?? '')).join('\u0000')).digest('hex').slice(0, 16);

/**
 * @param {unknown} input  an array of verdicts, or `{reportRunId, verdicts}` (binds the file to the run it was made for)
 * @returns {{ok: true, byKey: Map<string, object>, reportRunId: string|null} | {ok: false, errors: string[]}}
 */
export function indexAdjudications(input) {
  // (also returns `allFingerprinted`: every verdict carries a content fingerprint, which is what binds an UNBOUND verdict list to its findings)
  const bound = input && !Array.isArray(input) && typeof input === 'object';
  const list = bound ? input.verdicts : input;
  if (!Array.isArray(list)) return { ok: false, errors: ['adjudications must be a JSON array, or {reportRunId, verdicts: [...]}'] };
  const errors = []; const byKey = new Map();
  list.forEach((a, i) => {
    const tag = `adjudication #${i}`;
    if (!a || typeof a !== 'object') { errors.push(`${tag}: not an object`); return; }
    const bad = [];
    for (const k of ['kdId', 'id', 'pass']) if (typeof a[k] !== 'string' || a[k] === '') bad.push(`${tag}: ${k} must be a non-empty string`);
    if (!VERDICTS.includes(a.class)) bad.push(`${tag}: class must be one of ${VERDICTS.join('|')}, got ${JSON.stringify(a.class)}`);
    // Where a defect came from is not a detail: an unknown origin must not read as "not introduced by the commit".
    if (a.class === 'REAL' && typeof a.preExisting !== 'boolean') bad.push(`${tag}: a REAL verdict needs a boolean preExisting (was the defect in the commit's own change?)`);
    if (a.fingerprint !== undefined && !/^[0-9a-f]{16}$/.test(String(a.fingerprint))) bad.push(`${tag}: fingerprint must be 16 hex characters`);
    if (bad.length) { errors.push(...bad); return; }
    const key = findingKey(a.kdId, a);
    if (byKey.has(key)) errors.push(`${tag}: duplicate verdict for ${key}`); else byKey.set(key, a);
  });
  if (bound && input.reportRunId !== undefined && (typeof input.reportRunId !== 'string' || input.reportRunId === '')) errors.push('reportRunId must be a non-empty string');
  return errors.length ? { ok: false, errors } : { ok: true, byKey, reportRunId: bound && typeof input.reportRunId === 'string' ? input.reportRunId : null, allFingerprinted: byKey.size > 0 && [...byKey.values()].every((a) => a.fingerprint !== undefined) };
}

/**
 * Score a report's per-case findings against verdicts.
 * @param {{kdId: string, outcome: string, findings?: object[]}[]} perCase
 * @param {Map<string, object>} byKey  from indexAdjudications
 * @param {{partial?: boolean, budgetStop?: object|null, costComplete?: boolean, bound?: boolean, allFingerprinted?: boolean}} [source]
 *   the report's own completeness fields (BOTH `partial` and `costComplete` must be present booleans: absent means unknown, never whole), and how
 *   the verdicts are tied to this report: `bound` (a {reportRunId} file for this run) or `allFingerprinted` (every verdict carries a content fingerprint)
 */
export function scoreAdjudicated(perCase, byKey, source = {}) {
  const seen = new Set(); const stale = []; const ambiguous = []; const inconsistent = [];
  const keysInReport = new Set(); // across the WHOLE report: a repeated case id must not let one verdict be applied twice
  const cases = []; const t = { REAL: 0, NOT_A_DEFECT: 0, WRONG: 0, UNDETERMINED: 0, unadjudicated: 0 };
  for (const c of perCase) {
    const counts = { REAL: 0, NOT_A_DEFECT: 0, WRONG: 0, UNDETERMINED: 0, unadjudicated: 0 };
    let introduced = false;
    // A flagged case has MEDIUM+ drivers by definition: none kept means the report cannot be adjudicated (an older or truncated report).
    if (c.outcome === 'flagged' && !(Array.isArray(c.findings) && c.findings.length > 0)) inconsistent.push(c.kdId);
    for (const f of c.findings ?? []) {
      const key = findingKey(c.kdId, f);
      if (!f?.id || keysInReport.has(key)) { ambiguous.push(f?.id ? key : `${c.kdId}:${f?.pass ?? 'unknown'}:(no id)`); continue; } // never apply one verdict to two findings
      keysInReport.add(key);
      const v = byKey.get(key);
      if (!v) { counts.unadjudicated += 1; continue; }
      seen.add(key);
      if (v.fingerprint !== undefined && v.fingerprint !== findingFingerprint(f)) { stale.push(key); counts.unadjudicated += 1; continue; }
      counts[v.class] += 1;
      if (v.class === 'REAL' && v.preExisting === false) introduced = true;
    }
    for (const k of Object.keys(t)) t[k] += counts[k];
    cases.push({ kdId: c.kdId, outcome: c.outcome, ...counts, notClean: counts.REAL > 0, realDefectIntroducedByCommit: introduced });
  }
  const orphaned = [...byKey.keys()].filter((k) => !seen.has(k) && !stale.includes(k));
  const failed = perCase.filter((c) => c.outcome === 'failed').map((c) => c.kdId);
  const reasons = [];
  if (t.unadjudicated > 0) reasons.push(`${t.unadjudicated} finding(s) have no verdict`);
  if (orphaned.length > 0) reasons.push(`${orphaned.length} verdict(s) match no finding`);
  if (stale.length > 0) reasons.push(`${stale.length} verdict(s) were made for a different finding under the same id`);
  if (ambiguous.length > 0) reasons.push(`${ambiguous.length} finding(s) have a missing or duplicate id`);
  if (inconsistent.length > 0) reasons.push(`flagged case(s) kept no findings: ${inconsistent.join(', ')}`);
  if (failed.length > 0) reasons.push(`the source run failed case(s): ${failed.join(', ')}`);
  if (source.partial === true || source.budgetStop) reasons.push('the source run was partial (cap stop or failed case)');
  if (source.costComplete === false) reasons.push('the source run\'s cost is incomplete');
  // Unknown is not whole: a report without these fields (older, or truncated) cannot be assumed complete.
  if (typeof source.partial !== 'boolean' || typeof source.costComplete !== 'boolean') reasons.push('the source report does not say whether it was complete (partial / costComplete missing): its completeness is unknown');
  if (t.UNDETERMINED > 0) reasons.push(`${t.UNDETERMINED} finding(s) are UNDETERMINED: their cases' cleanliness is not established`);
  // Finding ids are only unique within one run, so a verdict list must be tied to this run (reportRunId) or to each finding's content.
  if (source.bound !== true && source.allFingerprinted !== true) reasons.push('the verdicts are not bound to this report run (no reportRunId) and not every one carries a fingerprint: they could belong to a different run that reused the same ids');
  const judged = t.REAL + t.NOT_A_DEFECT + t.WRONG; // UNDETERMINED is neither a claim confirmed nor refuted
  return {
    complete: reasons.length === 0,
    incompleteReasons: reasons,
    findings: judged + t.UNDETERMINED + t.unadjudicated,
    falseClaims: t.WRONG, realDefects: t.REAL, nits: t.NOT_A_DEFECT, undetermined: t.UNDETERMINED, unadjudicated: t.unadjudicated,
    // Of the findings that were judged: how many claims were false. null when none were judged, never 0.
    falseClaimRate: judged > 0 ? t.WRONG / judged : null,
    notClean: cases.filter((c) => c.notClean).length,
    notCleanIntroducedByCommit: cases.filter((c) => c.realDefectIntroducedByCommit).length,
    casesWithFalseClaim: cases.filter((c) => c.WRONG > 0).length,
    measuredCases: cases.filter((c) => c.outcome !== 'failed').length,
    orphaned, stale, ambiguous, inconsistent, failedCases: failed,
    perCase: cases,
  };
}
