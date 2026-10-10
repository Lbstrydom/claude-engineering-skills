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

import fs from 'node:fs';
import { normalizePath } from '../file-io.mjs';
import { unreadChangedLines } from '../hunk-window.mjs';

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
 * @param {object} [opts]
 * @param {Function|null} [opts.hunksFor] - new-side hunks per changed path (`final-review-hunks.mjs`); null = no diff
 *   evidence, so changed lines in a cut or dropped file are UNMEASURED (never 0).
 * @param {string[]|null} [opts.requested] - the paths the envelope asked the reader for (`codePaths`); a changed file in
 *   it but absent from the final render was dropped by the envelope budget (envelope.mjs Step 4) and is counted unread.
 * @param {Function} [opts.readText] - fallback line source, used only when the reader recorded no `lineCounts`.
 * @returns {object} the summary — see docs/plans/final-review-hunk-windows.md D4
 */
export function summariseCodeCoverage(stats, changedFiles = [], { hunksFor = null, requested = null, readText = defaultReadText } = {}) {
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
    hunkEvidence: typeof hunksFor === 'function' ? 'expected' : 'not-applicable',
    changedLinesTotal: 0,
    changedLinesTotalUnknownFiles: 0,
    changedLinesUnread: null,
    changedLinesUnmeasuredFiles: 0,
    changedUnread: [],
    changedUnmeasured: [],
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
  const omittedSet = new Set((stats.budgetOmitted ?? []).map(key));
  const unreadableSet = new Set((stats.unreadable ?? []).map(key));
  const sensitiveSet = new Set((stats.sensitiveExcluded ?? []).map(key));
  const requestedSet = Array.isArray(requested) ? new Set(requested.map(key)) : null;
  const lineCounts = new Map(Object.entries(stats.lineCounts ?? {}).map(([p, n]) => [key(p), n]));
  // The count the reader recorded for the snapshot it rendered (plan audit R1-M2); a read only when it recorded none.
  const lineCountOf = (p) => {
    if (lineCounts.has(key(p))) return lineCounts.get(key(p));
    const text = readText(p);
    return typeof text === 'string' ? text.split('\n').length : null;
  };

  let unreadSum = 0;
  let measuredShort = 0; // files not rendered whole whose changed lines WERE measured
  let complete = true; // every changed file rendered AND every changed line shown
  for (const p of changed) {
    const k = key(p);
    const hunks = typeof hunksFor === 'function' ? hunksFor(p) : null;
    let outcome;
    let m = null;
    if (fullSet.has(k)) {
      outcome = 'full';
      base.changedFull.push(p);
      const n = lineCountOf(p);
      // A whole render shows every line: 0 unread with or without hunks; the total is known only with them.
      m = unreadChangedLines({ lineCount: n, hunks, ranges: n ? [[1, n]] : [] }) ?? { total: null, unread: 0 };
    } else if (cutMap.has(k)) {
      const cut = cutMap.get(k);
      outcome = cut.windowed ? 'windowed' : 'head-cut';
      const ranges = Array.isArray(cut.ranges) ? cut.ranges : null;
      m = ranges ? unreadChangedLines({ lineCount: lineCountOf(p), hunks, ranges }) : null;
      base.changedHeadCut.push({ path: p, ...cut, unread: m?.unread ?? null, total: m?.total ?? null });
    } else {
      base.changedMissing.push(p);
      const dropped = omittedSet.has(k)
        || (requestedSet !== null && requestedSet.has(k) && !unreadableSet.has(k) && !sensitiveSet.has(k));
      if (dropped) {
        outcome = 'budget-omitted';
        m = unreadChangedLines({ lineCount: lineCountOf(p), hunks, ranges: [] });
      } else {
        outcome = unreadableSet.has(k) ? 'unreadable' : sensitiveSet.has(k) ? 'sensitive' : 'not-requested';
      }
    }
    const rendered = outcome === 'full' || outcome === 'windowed' || outcome === 'head-cut';
    if (m && Number.isInteger(m.total)) base.changedLinesTotal += m.total;
    else base.changedLinesTotalUnknownFiles++;
    if (!m) {
      base.changedLinesUnmeasuredFiles++;
      base.changedUnmeasured.push({ path: p, outcome, reason: unmeasuredReason(outcome, hunks) });
      complete = false;
      continue;
    }
    if (outcome !== 'full') measuredShort++;
    unreadSum += m.unread;
    if (m.unread > 0) base.changedUnread.push({ path: p, outcome, unread: m.unread, total: m.total });
    if (!rendered || m.unread > 0) complete = false;
  }
  // A sum over nothing measured is not a measurement: with every short file unmeasured the total stays null.
  const anyShort = measuredShort + base.changedLinesUnmeasuredFiles > 0;
  base.changedLinesUnread = anyShort && measuredShort === 0 ? null : unreadSum;
  const lines = linesSuffix(base);

  const seen = base.changedFull.length + base.changedHeadCut.length;
  if (seen === 0) {
    return {
      ...base,
      state: 'none',
      reason: `all ${changed.length} changed file(s) were dropped before the reviewer: `
        + base.changedMissing.slice(0, 8).join(', ') + lines,
    };
  }
  if (!complete) {
    const windowed = base.changedHeadCut.filter((c) => c.windowed).length;
    return {
      ...base,
      state: 'partial',
      reason: `${base.changedFull.length}/${changed.length} changed file(s) rendered whole; `
        + `${base.changedHeadCut.length} head-cut (${windowed} windowed), ${base.changedMissing.length} absent${lines}`,
    };
  }
  if (base.changedHeadCut.length > 0) {
    return {
      ...base,
      state: 'full',
      reason: `all ${changed.length} changed file(s) shown — ${base.changedFull.length} whole, `
        + `${base.changedHeadCut.length} windowed with every changed line (${base.changedLinesTotal} changed line(s))`,
    };
  }
  return { ...base, state: 'full', reason: `all ${changed.length} changed file(s) rendered whole` };
}

function defaultReadText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function unmeasuredReason(outcome, hunks) {
  if (outcome === 'not-requested') return 'not selected for the envelope';
  if (outcome === 'unreadable') return 'the reader could not read it';
  if (outcome === 'sensitive') return 'excluded as sensitive';
  return Array.isArray(hunks) ? 'its line count could not be read' : 'no diff evidence for where its change is';
}

function linesSuffix(cov) {
  const parts = [];
  if (cov.changedLinesUnread > 0) parts.push(`${cov.changedLinesUnread} of ${cov.changedLinesTotal} changed line(s) never shown`);
  if (cov.changedLinesUnmeasuredFiles > 0) {
    parts.push(`changed lines unmeasured for ${cov.changedLinesUnmeasuredFiles} file(s)`
      + (cov.hunkEvidence === 'not-applicable' ? ' (no diff evidence)' : ''));
  }
  return parts.length ? `; ${parts.join('; ')}` : '';
}

/**
 * The `--out` summary-line segment (docs/plans/final-review-hunk-windows.md D5): what the reviewer saw of the change,
 * beside its verdict. Never gates anything. '' only when there is no coverage record at all, or no changed-file set to
 * measure against (a plan review has no code under review — there is nothing to report, not an unknown shortfall).
 *
 * @param {object|null|undefined} cov - `summariseCodeCoverage` output
 * @returns {string}
 */
export function formatCodeCoverageSegment(cov) {
  if (!cov || typeof cov.state !== 'string' || !(cov.changedRequested > 0)) return '';
  const parts = [];
  if (cov.changedLinesUnread > 0) parts.push(`${cov.changedLinesUnread} changed line(s) never shown`);
  if (cov.changedLinesUnmeasuredFiles > 0) parts.push(`changed lines unmeasured for ${cov.changedLinesUnmeasuredFiles} file(s)`);
  return `Code: ${cov.state.toUpperCase()}${parts.length ? `, ${parts.join(', ')}` : ''}`;
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
