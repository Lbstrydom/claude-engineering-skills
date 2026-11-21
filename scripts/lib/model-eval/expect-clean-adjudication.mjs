/**
 * @fileoverview Adjudicated scoring for an `expect_clean` report. The raw run only says which cases drew a MEDIUM+ finding; that is a
 * count of FLAGGED cases, and on a curated corpus it measures how clean the corpus is as much as how noisy the model is (2026-11-20: 11/11
 * flagged, yet 1 of 107 findings was a false claim and 52 were real defects). What distinguishes the two is a verdict per finding, so this
 * module scores a report against a list of them: `falseClaims` (WRONG), `realDefects` (REAL), `nits` (NOT_A_DEFECT), and `notClean`, the
 * cases that carry at least one REAL defect. Pure: no I/O, no model calls.
 *
 * @module scripts/lib/model-eval/expect-clean-adjudication
 */

export const VERDICTS = Object.freeze(['REAL', 'NOT_A_DEFECT', 'WRONG', 'UNDETERMINED']);

/** The identity of a finding inside a report: the case, the pass that raised it and its id within that pass. */
export const findingKey = (kdId, f) => `${kdId}:${f?.pass ?? 'unknown'}:${f?.id ?? ''}`;

/**
 * @param {unknown} list
 * @returns {{ok: true, byKey: Map<string, object>} | {ok: false, errors: string[]}}
 */
export function indexAdjudications(list) {
  if (!Array.isArray(list)) return { ok: false, errors: ['adjudications must be a JSON array'] };
  const errors = []; const byKey = new Map();
  list.forEach((a, i) => {
    const tag = `adjudication #${i}`;
    if (!a || typeof a !== 'object') { errors.push(`${tag}: not an object`); return; }
    for (const k of ['kdId', 'id', 'pass']) if (typeof a[k] !== 'string' || a[k] === '') errors.push(`${tag}: ${k} must be a non-empty string`);
    if (!VERDICTS.includes(a.class)) errors.push(`${tag}: class must be one of ${VERDICTS.join('|')}, got ${JSON.stringify(a.class)}`);
    if (errors.length && errors.some((e) => e.startsWith(tag))) return;
    const key = findingKey(a.kdId, a);
    if (byKey.has(key)) errors.push(`${tag}: duplicate verdict for ${key}`); else byKey.set(key, a);
  });
  return errors.length ? { ok: false, errors } : { ok: true, byKey };
}

/**
 * Score a report's per-case findings against verdicts.
 * `findings` on a perCase entry are the MEDIUM+ drivers the report kept. A finding with no verdict is `unadjudicated`, never counted as
 * anything else, and the result is `complete: false` until none are left. A verdict that matches no finding is `orphaned` (stale or
 * from another run) and is reported, not silently ignored.
 * @param {{kdId: string, outcome: string, findings?: object[]}[]} perCase
 * @param {Map<string, object>} byKey  from indexAdjudications
 */
export function scoreAdjudicated(perCase, byKey) {
  const seen = new Set();
  const cases = []; const t = { REAL: 0, NOT_A_DEFECT: 0, WRONG: 0, UNDETERMINED: 0, unadjudicated: 0 };
  for (const c of perCase) {
    const counts = { REAL: 0, NOT_A_DEFECT: 0, WRONG: 0, UNDETERMINED: 0, unadjudicated: 0 };
    let introduced = false;
    for (const f of c.findings ?? []) {
      const key = findingKey(c.kdId, f);
      const v = byKey.get(key);
      if (!v) { counts.unadjudicated += 1; continue; }
      seen.add(key);
      counts[v.class] += 1;
      if (v.class === 'REAL' && v.preExisting === false) introduced = true;
    }
    for (const k of Object.keys(t)) t[k] += counts[k];
    cases.push({ kdId: c.kdId, outcome: c.outcome, ...counts, notClean: counts.REAL > 0, realDefectIntroducedByCommit: introduced });
  }
  const orphaned = [...byKey.keys()].filter((k) => !seen.has(k));
  const judged = t.REAL + t.NOT_A_DEFECT + t.WRONG; // UNDETERMINED is neither a claim confirmed nor refuted
  const measured = cases.filter((c) => c.outcome !== 'failed');
  return {
    complete: t.unadjudicated === 0 && orphaned.length === 0,
    findings: judged + t.UNDETERMINED + t.unadjudicated,
    falseClaims: t.WRONG, realDefects: t.REAL, nits: t.NOT_A_DEFECT, undetermined: t.UNDETERMINED, unadjudicated: t.unadjudicated,
    // Of the findings that were judged: how many claims were false. null when none were judged, never 0.
    falseClaimRate: judged > 0 ? t.WRONG / judged : null,
    notClean: cases.filter((c) => c.notClean).length,
    notCleanIntroducedByCommit: cases.filter((c) => c.realDefectIntroducedByCommit).length,
    casesWithFalseClaim: cases.filter((c) => c.WRONG > 0).length,
    measuredCases: measured.length,
    orphaned,
    perCase: cases,
  };
}
