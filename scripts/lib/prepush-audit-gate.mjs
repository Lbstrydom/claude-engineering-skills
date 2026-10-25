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
 *     passed). Keyed on tree identity - never branch name, never recency. A tree that differs by one byte re-runs UNLESS the
 *     branch's own patches are range-diff-equivalent to the audited commits (lib/patch-equivalence.mjs, hook v13): a rebase or a
 *     cherry-pick recovery moves the tree, not the branch's diff, and is reported as such, never as "the same tree".
 *     {@link auditBudgetSec} scales the budget with the diff when there is nothing to reuse.
 *  4. {@link classifyNoPlanPush} - a push the plan selector resolved NO plan for (hook v13): docs-only and sync-bookkeeping-only
 *     pushes have nothing to audit; anything else would have passed with nothing measured, so it is UNMEASURED.
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
 * Identity is the TREE, or - when the tree differs - the branch's own PATCHES: the marker's `auditedTree` must equal the pushed
 * commit's tree object id, or `equivalence` must say the pushed branch's own commits have exactly the audited commits' content fingerprints
 * (`patchRangesEquivalent`; the caller only asks when the marker names an `auditedSha`). The marker alone proves an audit RAN (its
 * own header says so), so a reuse additionally needs the store's row for that run to say it CONVERGED - and when that cannot be
 * read (cloud off, query failed, no row) the answer is "re-run", never "assume it passed".
 *
 * @param {{marker: {runId?: string, auditedTree?: string|null}|null, pushedTree: string|null, convergence: {roundConvergedAfter: number|null}|null, convergenceWhy?: string|null, equivalence?: {equivalent: boolean, commits?: number, reason?: string}|null}} input
 * @returns {{reuse: boolean, runId?: string, round?: number, auditedTree?: string, equivalence?: 'range-diff', commits?: number, reason?: string}}
 */
export function decideAuditReuse({ marker, pushedTree, convergence, convergenceWhy = null, equivalence = null }) {
  if (!marker || typeof marker.runId !== 'string' || marker.runId === '') return { reuse: false, reason: 'no recorded audit run (.audit/last-audit-run.json absent or unreadable)' };
  if (!OBJECT_ID_RE.test(String(pushedTree ?? ''))) return { reuse: false, reason: 'the pushed commit\'s tree could not be resolved' };
  if (!OBJECT_ID_RE.test(String(marker.auditedTree ?? ''))) return { reuse: false, reason: `run ${marker.runId} recorded no audited-tree identity` };
  const sameTree = marker.auditedTree === pushedTree;
  const byPatches = !sameTree && equivalence?.equivalent === true;
  if (!sameTree && !byPatches) {
    const base = `the last audited tree (${marker.auditedTree.slice(0, 12)}) is not the pushed tree (${pushedTree.slice(0, 12)})`;
    return { reuse: false, reason: equivalence && equivalence.equivalent === false ? `${base}, and the branch's patches are not range-diff-equivalent to the audited commits (${equivalence.reason})` : base };
  }
  const what = sameTree ? 'this exact tree' : 'the same patches';
  if (!convergence) return { reuse: false, reason: `run ${marker.runId} audited ${what}, but whether it passed cannot be verified (${convergenceWhy ?? 'store unavailable'})` };
  if (!Number.isInteger(convergence.roundConvergedAfter)) return { reuse: false, reason: `run ${marker.runId} audited ${what} but did not converge` };
  return sameTree
    ? { reuse: true, runId: marker.runId, round: convergence.roundConvergedAfter, auditedTree: marker.auditedTree }
    : { reuse: true, runId: marker.runId, round: convergence.roundConvergedAfter, auditedTree: marker.auditedTree, equivalence: 'range-diff', commits: equivalence.commits };
}

/**
 * Budget scaling, in seconds: `baseSec + perFileSec * files`, never below `floorSec` (the unknown-size answer), capped.
 *
 * REFIT 2026-10-24 from MEASURED wall times, not a guess. Source: the store's `audit_runs` (mode=code, one row per audit
 * invocation, `total_duration_ms` against `diff_files_changed`), 3000 most recent rows 2026-09-14..2026-10-24 across three repos;
 * the 610 ROUND-1 rows are the population that matches a pre-push audit (a hook audit is a fresh invocation, no ledger - later
 * rounds are several times faster: p50 313s round 1 vs 133s round 2). Round-1 p50/p90/p95 by files changed: 3-6 -> 121/240/349s,
 * 6-10 -> 274/512/559s, 16-25 -> 459/716/837s, 25-40 -> 551/807/855s, 40-80 -> 655/965/1167s; max 1823s (125 files).
 * `600 + 30*files` covers 100% of the 610 round-1 rows and 99.3% with 25% headroom for the hook's own startup and preflight (the
 * wall the hook enforces is longer than the audit's own `total_duration_ms`). The v12 formula `300 + 20*files + 0.1*lines` covered
 * 94.4%: storyline (23 files, 1208 lines) was given 881s and took 882s.
 *
 * Lines are NOT in the formula: `diff_lines_changed` is populated on only 122 of the 610 round-1 rows, and where it is it
 * explains less than the file count does (corr(sec, lines) 0.10 vs corr(sec, files) 0.27). The audit's cost is dominated by
 * per-file passes, and it saturates; a line term added a guess, not a measurement. The cap bounds a runaway.
 * Re-fit by re-running the same query when the pass set or the models change - a budget that refuses every big push gets overridden.
 */
export const BUDGET = Object.freeze({ floorSec: 600, baseSec: 600, perFileSec: 30, capSec: 2700 });

/**
 * The code-audit budget for a diff of this size. The previous flat 600s refused a ~60-file push whose audit had already passed;
 * the cap keeps a runaway audit bounded (a step that exceeds even this still REFUSES - it is never a skip).
 * @param {{files: number|null, lines?: number|null}} size `files: null` = the size is unknown, which keeps the old floor; `lines` is informational
 * @returns {{budgetSec: number, basis: string}}
 */
export function auditBudgetSec({ files, lines } = {}) {
  const { floorSec, baseSec, perFileSec, capSec } = BUDGET;
  // Only the file count is an input; `lines` is shown when known, and its absence or garbage never costs the file-based answer.
  if (!Number.isFinite(files) || files < 0) return { budgetSec: floorSec, basis: 'diff size unknown' };
  const raw = Math.round(baseSec + perFileSec * files);
  const budgetSec = Math.min(capSec, Math.max(floorSec, raw));
  const shownLines = Number.isFinite(lines) && lines >= 0 ? `, ${lines} changed line(s)` : '';
  return { budgetSec, basis: `${files} file(s)${shownLines}${budgetSec === capSec && raw > capSec ? ` (capped at ${capSec}s)` : ''}` };
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

/** The files only a machine writes about a sync (hook v7's short-circuit lists the same two; a test pins the two spellings together). */
export const SYNC_BOOKKEEPING_FILES = Object.freeze(['.sync-receipt.json', 'scripts/.sync-owned.json']);
/** Prose, never executed: nothing for a CODE audit to read. By extension only - a `docs/` JSON or script is still code. */
const DOCS_EXTENSION_RE = /\.(md|mdx|markdown|txt|rst)$/i;

/**
 * A push for which the plan selector resolved NO plan (none touched among >1 active, or none active). The hook used to `finish`
 * there with only "[plan-status] no active plan to audit": a code push passed with nothing measured and was never reported
 * UNMEASURED (storyline #431, 2026-10-24). The audit is plan-keyed (`openai-audit.mjs code <plan-file>`), so it cannot run
 * plan-less; the honest answer is UNMEASURED, refused unless the one named override is set - except for pushes that carry nothing
 * a code audit reads.
 *
 * @param {{files: string[]|null}} input `null` = the pushed file list could not be established (an unknown range is never "nothing changed")
 * @returns {{exempt: true, why: string} | {exempt: false, codeFiles: string[]|null}}
 */
export function classifyNoPlanPush({ files } = {}) {
  if (!Array.isArray(files)) return { exempt: false, codeFiles: null };
  if (files.length === 0) return { exempt: true, why: 'the push changes no files' };
  if (files.every((f) => SYNC_BOOKKEEPING_FILES.includes(f))) return { exempt: true, why: `only sync bookkeeping (${files.join(', ')})` };
  const codeFiles = files.filter((f) => !SYNC_BOOKKEEPING_FILES.includes(f) && !DOCS_EXTENSION_RE.test(f));
  if (codeFiles.length === 0) return { exempt: true, why: `only documentation and sync bookkeeping (${files.length} file(s))` };
  return { exempt: false, codeFiles };
}

/**
 * The hook's decision for a plan-less push, as `{allow, lines}` (same shape as {@link decideAuditGate}).
 * @param {{files: string[]|null, env?: Record<string, string|undefined>, selectorFailed?: boolean}} input `selectorFailed`: the plan
 *   selector itself errored (e.g. a malformed Status), which is no plan selected for a different reason and is named as such
 */
export const PLAN_OVERRIDE_ENV = 'AUDIT_PREPUSH_PLAN';

export function decideNoPlanGate({ files, env = {}, selectorFailed = false, exists = () => true }) {
  const c = classifyNoPlanPush({ files });
  if (c.exempt) return { allow: true, lines: [`[prepush-hook] no plan to audit, and the push carries nothing a code audit reads: ${c.why} - code audit skipped`] };
  const shown = c.codeFiles === null
    ? 'the pushed file list could not be established (no push range from git), so it cannot be shown to be docs or bookkeeping'
    : `${c.codeFiles.length} code file(s) in the push (${c.codeFiles.slice(0, 5).join(', ')}${c.codeFiles.length > 5 ? ', ...' : ''})`;
  // The override is read in exactly one place (check-plan-status.mjs --select) and a missing file selects NOTHING, so name that
  // case: telling the operator "none changed among several active" when they HAD set the override sends them hunting.
  const override = String(env[PLAN_OVERRIDE_ENV] ?? '').trim();
  const why = selectorFailed ? 'the plan selector failed (its error is above)'
    : override && !exists(override) ? `${PLAN_OVERRIDE_ENV}=${override} does not exist`
      : 'no single active plan could be chosen: none is active, or several are and the push does not single one out';
  const head = `UNMEASURED: no plan was selected for this push (${why}), so no code audit ran - ${shown}.`;
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
      '   The code audit is keyed to a plan in docs/plans/. A gate that did not run is not a pass.',
      `   Name the plan this work belongs to - an explicit override always wins: ${PLAN_OVERRIDE_ENV}=docs/plans/<plan>.md git push`,
      '   or touch that plan in the push (or leave exactly one plan with an active Status), so the selector can pick it,',
      `   or push this one UNMEASURED on purpose: ${UNMEASURED_OVERRIDE_ENV}=1 git push (recorded in the output), or skip every hook step: git push --no-verify.`,
      '',
    ],
  };
}

// ── NO_CODE_IN_SCOPE (hook v15; fleet 70b5, docs/plans/prepush-convergence-cluster-a.md) ────────────────────────────────────────────────
// The dependencies are INJECTED so this module stays light (it is loaded by every hook CLI call); the CLI passes the real ones and a test
// proves they agree with the audit's own refusal.

/** The outcome token a push with no implementation file is recorded as. It is a MEASURED fact about the push, not a verdict. */
export const NO_CODE_OUTCOME = 'NO_CODE_IN_SCOPE';

/**
 * Does the pushed file list contain nothing the code audit would take as a subject? The oracle is the audit's OWN bucketing
 * (`classifyFiles`: `shared` = context, not subject; `auditSubjectFileGuard` counts only backend+frontend), NOT the coverage taxonomy -
 * the taxonomy calls `package.json` "declarative" and the audit admits it, yet a package.json-only diff aborts because it is `shared`.
 * Anything this cannot positively place is CODE (the audit runs, or refuses, exactly as in v14): an unknown list, an unrecognised type,
 * an audit-infra path, a classifier that throws.
 *
 * @param {{files: string[]|null,
 *   isInfra: (p: string) => boolean, taxonomyClass: (p: string) => string, bucketOf: (p: string) => 'backend'|'frontend'|'shared'}} input
 * @returns {{noCode: true, files: string[]} | {noCode: false, reason: string}}
 */
export function classifyNoCodePush({ files, isInfra, taxonomyClass, bucketOf } = {}) {
  if (!Array.isArray(files)) return { noCode: false, reason: 'the pushed file list could not be established' };
  if (files.length === 0) return { noCode: false, reason: 'the push lists no files' };
  try {
    for (const f of files) {
      if (typeof f !== 'string' || f === '') return { noCode: false, reason: 'an unreadable path in the pushed file list' };
      if (SYNC_BOOKKEEPING_FILES.includes(f)) continue;
      if (isInfra(f)) return { noCode: false, reason: `${f} is audit infrastructure` };
      const cls = taxonomyClass(f);
      if (cls === 'non-code') continue;
      if (cls === 'uncovered') return { noCode: false, reason: `${f} is of a type the audit does not recognise` };
      if (bucketOf(f) === 'shared') continue;
      return { noCode: false, reason: `${f} is an implementation file the audit reads` };
    }
  } catch (e) {
    return { noCode: false, reason: `the classifier failed (${e?.message || 'error'})` };
  }
  return { noCode: true, files: [...files] };
}

/** The record a no-code bypass leaves, bound to the pushed tree. `files` is capped: the count is the evidence, the list is a convenience. */
export function buildNoCodeRecord({ tree, base, head, files, now = () => new Date().toISOString() }) {
  return { outcome: NO_CODE_OUTCOME, tree, base: base ?? null, head: head ?? null, fileCount: files.length, files: files.slice(0, 200), classifiedAt: now() };
}

/** The single protocol line `prepush-step.mjs no-code` prints: `no-code <N> <record-path>` | `code <reason>`. */
export const noCodeLine = (n, recordPath) => `no-code ${n} ${recordPath}`;
export const codeLine = (reason) => `code ${String(reason).replace(/[\r\n]+/g, ' ')}`;

// ── Recurrence (informational only; never suppresses, never gates) ───────────────────────────────────────────────────────────────────────

/** Similarity above which two findings on the same file read as one concern - the threshold `suppressReRaises` calibrated for paraphrased re-raises. */
export const RECURRENCE_SIMILARITY = 0.35;

/**
 * How much of this push's findings sit where the previous push's findings sat. Two tiers because the diagnosis measured 0/32 exact
 * category+file overlap between consecutive pushes while the SAME files came back reworded: `sameFile` (a robust lower bound on "again")
 * and `alsoSimilar` (same file AND textually close). Count-only: a wrong match is a wrong sentence, never a wrong verdict.
 *
 * @param {{previous: object[], current: object[], filesOf: (f: object) => Set<string>, similarity: (a: object, b: object) => number}} input
 * @returns {{total: number, sameFile: number, alsoSimilar: number}}
 */
export function summariseRecurrence({ previous, current, filesOf, similarity }) {
  const prev = Array.isArray(previous) ? previous : [];
  const cur = Array.isArray(current) ? current : [];
  const prevFiles = prev.map((p) => ({ p, files: filesOf(p) }));
  let sameFile = 0; let alsoSimilar = 0;
  for (const f of cur) {
    const files = filesOf(f);
    const hits = prevFiles.filter((x) => [...files].some((file) => x.files.has(file)));
    if (hits.length === 0) continue;
    sameFile += 1;
    if (hits.some((x) => similarity(f, x.p) > RECURRENCE_SIMILARITY)) alsoSimilar += 1;
  }
  return { total: cur.length, sameFile, alsoSimilar };
}

/** The operator-facing sentence. */
export function formatRecurrenceLine({ prevTree, total, sameFile, alsoSimilar }) {
  return `recurrence vs ${String(prevTree).slice(0, 12)}: ${sameFile} of ${total} finding(s) are on files already flagged in the previous push (${alsoSimilar} also textually similar)`;
}
