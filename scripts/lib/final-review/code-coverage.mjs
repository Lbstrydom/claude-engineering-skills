/**
 * @fileoverview Did the final reviewer actually SEE the changed code?
 *
 * Pure: takes a `readFilesAsContextDetailed` stats record plus the changed-file
 * set, and answers one question the envelope could not previously answer at
 * all — how much of the diff under review reached the model.
 *
 * WHY THIS EXISTS (measured 2026-09-02, audit SID audit-code-1788374248):
 * the `full` envelope renders code at `{maxPerFile: 8000}`, a HEAD cut. The
 * commit under review added `AUTOCRLF_PROBE` at char 16,170 of a 22,162-char
 * file, so the reviewer received the first third of the file and none of the
 * change — then returned APPROVE, with `_envelope.truncated` reporting `{}`.
 * A head cut is the wrong shape for a diff review because a changed region can
 * sit anywhere in the file; measuring the cut is what makes that visible, and
 * `applyCoverageGate` is what stops a verdict issued over zero coverage from
 * being reported as a pass ("audit your success paths", AGENTS.md).
 *
 * @module scripts/lib/final-review/code-coverage
 */

import { normalizePath } from '../file-io.mjs';

/**
 * Coverage states, weakest claim first. `unknown` is NOT a synonym for `full`:
 * it means nothing was measured, and it must never satisfy a check that `full`
 * would satisfy.
 */
export const COVERAGE_STATES = ['unknown', 'none', 'partial', 'full'];

/**
 * @param {object|null} stats - `readFilesAsContextDetailed().stats`, or null
 *   when the renderer reported nothing (then the state is `unknown`).
 * @param {string[]} changedFiles - the diff's file set (transcript.changed_files).
 * @returns {{state:string, reason:string, changedRequested:number,
 *   changedFull:string[], changedHeadCut:object[], changedMissing:string[],
 *   charsRendered:number, charsOnDisk:number}}
 */
export function summariseCodeCoverage(stats, changedFiles = []) {
  const changed = (Array.isArray(changedFiles) ? changedFiles : []).filter(
    (p) => typeof p === 'string' && p.length > 0,
  );
  const base = {
    changedRequested: changed.length,
    changedFull: [],
    changedHeadCut: [],
    changedMissing: [],
    charsRendered: stats?.charsRendered ?? 0,
    charsOnDisk: stats?.charsOnDisk ?? 0,
  };

  if (!stats) {
    return { ...base, state: 'unknown', reason: 'renderer reported no coverage record' };
  }
  if (changed.length === 0) {
    // No declared diff set (e.g. a `full`-scope run whose transcript carries no
    // `changed_files`). We measured the render but have nothing to measure it
    // AGAINST — that is `unknown`, not a clean bill of health.
    return { ...base, state: 'unknown', reason: 'no changed-file set declared in the transcript' };
  }

  const key = (p) => normalizePath(p);
  const fullSet = new Set(stats.full.map(key));
  const cutMap = new Map(stats.headTruncated.map((t) => [key(t.path), t]));

  for (const p of changed) {
    const k = key(p);
    if (fullSet.has(k)) base.changedFull.push(p);
    else if (cutMap.has(k)) base.changedHeadCut.push({ path: p, ...cutMap.get(k) });
    else base.changedMissing.push(p);
  }

  const seen = base.changedFull.length + base.changedHeadCut.length;
  if (seen === 0) {
    return {
      ...base,
      state: 'none',
      reason: `all ${changed.length} changed file(s) were dropped before the reviewer: `
        + base.changedMissing.slice(0, 8).join(', '),
    };
  }
  if (base.changedHeadCut.length > 0 || base.changedMissing.length > 0) {
    return {
      ...base,
      state: 'partial',
      reason: `${base.changedFull.length}/${changed.length} changed file(s) rendered whole; `
        + `${base.changedHeadCut.length} head-cut, ${base.changedMissing.length} absent`,
    };
  }
  return { ...base, state: 'full', reason: `all ${changed.length} changed file(s) rendered whole` };
}

/**
 * A verdict issued with ZERO coverage of the changed code cannot be an approval.
 *
 * Fires only on `state === 'none'` — the one condition assertable without the
 * diff hunks: every changed file was dropped, so the reviewer demonstrably read
 * none of the subject. `partial` is reported but NOT gated: a head cut may or
 * may not have contained the changed region, and downgrading on a maybe would
 * make the gate cry wolf. `unknown` never gates either — it is an absent
 * measurement, and gating on one would punish runs the instrument cannot see.
 *
 * Mutates and returns `result` (the caller stamps it on the shared object that
 * survives every downstream hop, as `_requestFingerprint` already does).
 *
 * @param {object} result - a `GeminiFinalReviewSchema` result
 * @param {object} coverage - `summariseCodeCoverage` output
 * @returns {{downgraded: boolean, from: string|null, to: string|null}}
 */
export function applyCoverageGate(result, coverage) {
  const none = { downgraded: false, from: null, to: null };
  if (!result || !coverage || coverage.state !== 'none') return none;
  if (result.verdict !== 'APPROVE') return none;

  const from = result.verdict;
  // CONCERNS, not a new enum member: the four verdicts are a MODEL-facing
  // contract (they are rendered into the prompt's verdict guide and derived
  // into three provider JSON schemas), and this is a mechanical post-condition,
  // not something the model should ever be able to claim. CONCERNS is the
  // weakest non-approval, and the original verdict is preserved verbatim on
  // `_coverageGate.reportedVerdict` — nothing is erased.
  result.verdict = 'CONCERNS';
  result._coverageGate = {
    downgraded: true,
    reportedVerdict: from,
    effectiveVerdict: result.verdict,
    state: coverage.state,
    reason: coverage.reason,
  };
  const notice = `⚠ COVERAGE GATE: this reviewer reported ${from}, but ${coverage.reason}. `
    + 'The verdict was mechanically downgraded because it cannot rest on code the reviewer never received. '
    + 'Treat it as unverified, not as an approval.\n\n';
  result.overall_reasoning = (notice + (result.overall_reasoning ?? '')).slice(0, 3000);
  return { downgraded: true, from, to: result.verdict };
}
