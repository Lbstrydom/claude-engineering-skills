/**
 * @fileoverview What the consumer pre-push hook may conclude from its code-audit step (hook v12; Tier 3 consumer-hook seam).
 *
 * Three decisions, all pure so both directions are testable without a model, a store or a push:
 *
 *  1. {@link classifyAuditOutcome} - did the audit MEASURE anything? An audit that crashed, could not authenticate, or came back
 *     INCOMPLETE produced no evidence about the change, and the hook used to print "config/key error -> noise" and let the push
 *     through (storyline #427, 2026-10-23). The audit's own contract is the oracle, never its prose: `openai-audit.mjs` exits 0 for a
 *     completed run WHATEVER it found (findings are in the `--out` envelope's `verdict`, never in the exit code), 3 for INCOMPLETE,
 *     1/2 for "the CLI itself errored / refused". So a non-zero exit is "did not run" by construction, and exit 0 only counts as a
 *     measurement when the envelope carries a verdict the hook recognises.
 *  2. {@link decideAuditGate} - unmeasured REFUSES unless the one named override is set (and then says so, loudly); findings stay
 *     advisory unless AUDIT_PREPUSH_BLOCK=1; clean passes.
 *  3. {@link decideAuditReuse} - a completed, CONVERGED audit run whose audited tree IS the pushed commit's tree is already the
 *     evidence; re-running it only burns the budget (a ~60-file storyline push timed out at 600s after 3 GPT rounds + Gemini had
 *     passed). Keyed on tree identity ONLY - never branch name, never recency. A tree that differs by one byte re-runs.
 *     {@link auditBudgetSec} scales the budget with the diff when there is nothing to reuse.
 *
 * @module scripts/lib/prepush-audit-gate
 */

/** The one named override for an audit that did not run. Recorded in the hook's output whenever it is used. */
export const UNMEASURED_OVERRIDE_ENV = 'AUDIT_PREPUSH_ALLOW_UNMEASURED';

/** Verdicts `computeAuditVerdict` can emit for a run that completed (findings-pipeline.mjs). INCOMPLETE is handled apart. */
const CLEAN_VERDICTS = Object.freeze(['PASS']);
const FINDING_VERDICTS = Object.freeze(['NEEDS_FIXES', 'SIGNIFICANT_ISSUES']);

/** A git tree/commit object id (sha-1 or sha-256), the same shape the evidence marker's reader accepts. */
const OBJECT_ID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Count findings by severity, or null when the collection is not readable evidence: a missing/non-array `findings`, or an entry whose
 * severity is not one of the three the audit emits. Substituting zero for an unreadable envelope would read as a clean run.
 */
const countBySeverity = (findings) => {
  if (!Array.isArray(findings)) return null;
  const c = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const sev = typeof f?.severity === 'string' ? f.severity.toUpperCase() : '';
    if (sev === 'HIGH') c.high += 1; else if (sev === 'MEDIUM') c.medium += 1; else if (sev === 'LOW') c.low += 1;
    else return null;
  }
  return c;
};

/** The cause named for a non-zero audit exit. Closed over the audit CLI's documented exits; anything else is reported as itself. */
function causeForExit(exitCode) {
  if (exitCode === 3) return 'the audit came back INCOMPLETE (exit 3): it measured less than the change, so it is not evidence about it';
  if (exitCode === 2) return 'the audit refused its arguments (exit 2) before reading anything';
  if (exitCode === 1) return 'the audit CLI errored before producing a verdict (exit 1): a crash, missing provider credentials, or a refused scope - see the output above';
  if (exitCode === null || exitCode === undefined || !Number.isInteger(exitCode)) return 'the audit produced no exit status (it was killed or could not start)';
  if (exitCode > 128) return `the audit was killed by a signal (exit ${exitCode})`;
  return `the audit exited ${exitCode}, which is not a completed run`;
}

/**
 * @typedef {{kind: 'clean'|'findings'|'unmeasured', cause: string|null, verdict: string|null, counts: {high: number, medium: number, low: number}}} AuditOutcome
 */

/**
 * Classify what the audit step measured, from its exit status and its `--out` envelope.
 * @param {{exitCode: number|null, report: object|null}} input `report` is the parsed envelope, or null when absent/unparseable
 * @returns {AuditOutcome}
 */
export function classifyAuditOutcome({ exitCode, report } = {}) {
  const none = { high: 0, medium: 0, low: 0 };
  if (exitCode !== 0) return { kind: 'unmeasured', cause: causeForExit(exitCode), verdict: null, counts: none };
  if (!report || typeof report !== 'object') {
    return { kind: 'unmeasured', cause: 'the audit exited 0 but left no result envelope (--out file missing or unparseable), so nothing it concluded can be read', verdict: null, counts: none };
  }
  const verdict = typeof report.verdict === 'string' ? report.verdict : null;
  const counts = countBySeverity(report.findings);
  if (counts === null) {
    return { kind: 'unmeasured', cause: `the audit's envelope (verdict ${verdict ?? 'none'}) has no readable findings list, so the hook cannot tell what it found`, verdict, counts: none };
  }
  if (verdict === 'INCOMPLETE') {
    return { kind: 'unmeasured', cause: 'the audit reported verdict INCOMPLETE: it measured less than the change, so it is not evidence about it', verdict, counts };
  }
  if (CLEAN_VERDICTS.includes(verdict)) {
    // POLICY: "clean" means the audit's own PASS with nothing at HIGH or MEDIUM. PASS tolerates up to two MEDIUMs (NEEDS_FIXES starts
    // above that), which are still findings to surface; LOW-only is below the audit's own convergence bar, so it neither gates under
    // AUDIT_PREPUSH_BLOCK=1 nor reads as findings - the counts are printed either way.
    return counts.high + counts.medium > 0
      ? { kind: 'findings', cause: null, verdict, counts }
      : { kind: 'clean', cause: null, verdict, counts };
  }
  if (FINDING_VERDICTS.includes(verdict)) return { kind: 'findings', cause: null, verdict, counts };
  return { kind: 'unmeasured', cause: `the audit's envelope carries ${verdict === null ? 'no verdict' : `an unrecognised verdict "${verdict}"`}, so the hook cannot tell what it found`, verdict, counts };
}

/**
 * Turn an outcome into the hook's decision. `lines` are for stderr, in order.
 * @param {{outcome: AuditOutcome, env?: Record<string, string|undefined>}} input
 * @returns {{allow: boolean, lines: string[]}}
 */
export function decideAuditGate({ outcome, env = {} }) {
  const { kind, cause, verdict, counts } = outcome;
  const tally = `H:${counts.high} M:${counts.medium} L:${counts.low}`;
  if (kind === 'clean') return { allow: true, lines: [`[prepush-hook] code audit: ${verdict} (${tally}) - ran clean`] };
  if (kind === 'findings') {
    const block = env.AUDIT_PREPUSH_BLOCK === '1';
    return {
      allow: !block,
      lines: [
        `[prepush-hook] code audit: ${verdict} (${tally}) - the audit RAN and found things to address`,
        block ? '[prepush-hook] push BLOCKED: AUDIT_PREPUSH_BLOCK=1 gates on findings' : '[prepush-hook] advisory (set AUDIT_PREPUSH_BLOCK=1 to gate on findings)',
      ],
    };
  }
  // unmeasured
  const head = `UNMEASURED: the code audit did NOT run to a verdict - ${cause}.`;
  if (env[UNMEASURED_OVERRIDE_ENV] === '1') {
    return {
      allow: true,
      lines: [
        `⚠  [prepush-hook] ${head}`,
        `⚠  [prepush-hook] push ALLOWED UNMEASURED because ${UNMEASURED_OVERRIDE_ENV}=1 is set - nothing about this change was checked by the audit.`,
      ],
    };
  }
  return {
    allow: false,
    lines: [
      '',
      `✗  [prepush-hook] ${head}`,
      '   This is NOT a finding about your change and NOT a clean run: no evidence was produced. A gate that did not run is not a pass.',
      `   Fix the cause above and push again, or push this one UNMEASURED on purpose: ${UNMEASURED_OVERRIDE_ENV}=1 git push (recorded in the output),`,
      '   or skip every hook step: git push --no-verify.',
      '',
    ],
  };
}

/**
 * Decide whether a recorded audit run already covers the pushed commit.
 *
 * Identity is the TREE and nothing else: the marker's `auditedTree` must equal the pushed commit's tree object id. The marker alone
 * proves an audit RAN (its own header says so), so a reuse additionally needs the store's row for that run to say it CONVERGED -
 * and when that cannot be read (cloud off, query failed, no row) the answer is "re-run", never "assume it passed".
 *
 * @param {{marker: {runId?: string, auditedTree?: string|null}|null, pushedTree: string|null, convergence: {roundConvergedAfter: number|null}|null, convergenceWhy?: string|null}} input
 * @returns {{reuse: boolean, runId?: string, round?: number, auditedTree?: string, reason?: string}}
 */
export function decideAuditReuse({ marker, pushedTree, convergence, convergenceWhy = null }) {
  if (!marker || typeof marker.runId !== 'string' || marker.runId === '') return { reuse: false, reason: 'no recorded audit run (.audit/last-audit-run.json absent or unreadable)' };
  if (!OBJECT_ID_RE.test(String(pushedTree ?? ''))) return { reuse: false, reason: 'the pushed commit\'s tree could not be resolved' };
  if (!OBJECT_ID_RE.test(String(marker.auditedTree ?? ''))) return { reuse: false, reason: `run ${marker.runId} recorded no audited-tree identity` };
  if (marker.auditedTree !== pushedTree) {
    return { reuse: false, reason: `the last audited tree (${marker.auditedTree.slice(0, 12)}) is not the pushed tree (${pushedTree.slice(0, 12)})` };
  }
  if (!convergence) return { reuse: false, reason: `run ${marker.runId} audited this exact tree, but whether it passed cannot be verified (${convergenceWhy ?? 'store unavailable'})` };
  if (!Number.isInteger(convergence.roundConvergedAfter)) return { reuse: false, reason: `run ${marker.runId} audited this exact tree but did not converge` };
  return { reuse: true, runId: marker.runId, round: convergence.roundConvergedAfter, auditedTree: marker.auditedTree };
}

/** Budget scaling, in seconds. `base` covers startup + the fixed passes; the per-file and per-line terms are the measured slope. */
export const BUDGET = Object.freeze({ floorSec: 600, baseSec: 300, perFileSec: 20, perLineSec: 0.1, capSec: 2700 });

/**
 * The code-audit budget for a diff of this size. The previous flat 600s refused a ~60-file push whose audit had already passed;
 * the cap keeps a runaway audit bounded (a step that exceeds even this still REFUSES - it is never a skip).
 * @param {{files: number|null, lines: number|null}} size `null` = the size is unknown, which keeps the old floor
 * @returns {{budgetSec: number, basis: string}}
 */
export function auditBudgetSec({ files, lines } = {}) {
  const { floorSec, baseSec, perFileSec, perLineSec, capSec } = BUDGET;
  if (!Number.isFinite(files) || !Number.isFinite(lines) || files < 0 || lines < 0) {
    return { budgetSec: floorSec, basis: 'diff size unknown' };
  }
  const raw = Math.round(baseSec + perFileSec * files + perLineSec * lines);
  const budgetSec = Math.min(capSec, Math.max(floorSec, raw));
  return { budgetSec, basis: `${files} file(s), ${lines} changed line(s)${budgetSec === capSec && raw > capSec ? ` (capped at ${capSec}s)` : ''}` };
}

/**
 * Sum `git diff --numstat -z` output into a file and changed-line count. A binary entry (`-\t-\tpath`) counts as a file, not lines.
 * Renames/copies under -z carry an extra NUL-separated path pair; they are counted once.
 * @param {string} numstatZ
 * @returns {{files: number, lines: number}}
 */
export function parseNumstatZ(numstatZ) {
  let files = 0; let lines = 0;
  const parts = String(numstatZ ?? '').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    files += 1;
    if (m[1] !== '-') lines += Number(m[1]) + Number(m[2]);
    if (m[3] === '') i += 2; // rename/copy: the old and new paths follow as their own NUL-terminated fields
  }
  return { files, lines };
}
