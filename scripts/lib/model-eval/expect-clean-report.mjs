/**
 * @fileoverview The report-only `expect_clean` run (sashiko PR C, G1). A clean case is a known-good commit: the question is not
 * "did the candidate find the defect" but "did it raise a MEDIUM/HIGH finding on code that has none". That needs the real 5-pass
 * generation arm (the Tier-C extractor forces one defect per case, so it can never answer "none"), scored judge-free by
 * `scoreExpectCleanCase`. The result is a REPORT, not a decision: it carries no verdict, and the store requires a verdict on a
 * `completed` run, so it is written to `--out` and never persisted as a run.
 *
 * @module scripts/lib/model-eval/expect-clean-report
 */
import { runAuditGenerationArm } from './arm-generation.mjs';
import { scoreExpectCleanCase, summarizeExpectClean, driverIndexes } from './corpus-selection.mjs';
import { redactSecrets } from '../secret-patterns.mjs';

const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);
const norm = (f) => String(f).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();

/**
 * Generation findings carry `affectedFiles` / `_primaryFile`, not `file`. A finding that names a case file is attributed to it.
 * One that names no file at all is attributed to the case's first file: the whole diff is the case, and dropping an
 * unattributable MEDIUM+ finding would flatter the candidate. A finding that names only OTHER files is left out of this case.
 */
export function toScorable(findings, files) {
  const want = new Set(files.map(norm));
  return findings.map((f) => {
    const named = [f?._primaryFile, ...(Array.isArray(f?.affectedFiles) ? f.affectedFiles : [])].filter((x) => typeof x === 'string' && x.trim() !== '');
    const hit = named.find((n) => want.has(norm(n)));
    const file = hit ?? (named.length === 0 ? files[0] : named[0]);
    return { file, severity: f?.severity, pass: f?._pass };
  });
}

/** The text fields of a finding that a human needs to judge its claim; each is secret-redacted before it can reach `--out`. */
const TEXT_FIELDS = ['id', 'category', 'section', 'detail', 'risk', 'recommendation', 'principle', 'evidence', 'evidenceRef', 'quote'];
// Recursive: a structured `evidence` ({quote: ...}) or an array must not carry a secret past a string-only redactor.
const redactDeep = (v) => {
  if (typeof v === 'string') return redactSecrets(v).text;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
};

/**
 * The findings that drove a false positive, kept in full so the outcome can be adjudicated: a bare `false_positive` with a pass name
 * cannot say whether the claim was real, wrong or a nit. Same attribution and the same MEDIUM+ filter as the scorer, so what is
 * kept is exactly what made the case a false positive. Free text goes through the audit's own secret redaction.
 */
export function retainDrivers(findings, files) {
  return driverIndexes(toScorable(findings, files), files).map((i) => {
    const f = findings[i];
    const out = { severity: f.severity, pass: f._pass ?? 'unknown', files: redactDeep(Array.isArray(f.affectedFiles) ? f.affectedFiles : []), primaryFile: redactDeep(f._primaryFile ?? null) };
    for (const k of TEXT_FIELDS) if (f[k] !== undefined) out[k] = redactDeep(f[k]);
    return out;
  });
}

/**
 * `capUsd` is the total cap: with it, a case is not started if the costliest case so far would not fit under it.
 * @param {{runId: string, arm: object, route: object, cases: {visibleInput: {diff: string, files: string[]}, hiddenGroundTruth: {kdId: string}, repoRoot: string}[],
 *   scope?: string, passes?: string[], meter?: {record: Function, check: Function}|null, generate?: typeof runAuditGenerationArm}} args
 * @returns {Promise<{perCase: object[], summary: object, usageEvents: object[], budgetStop: object|null}>}
 */
export async function runExpectCleanReport({ runId, arm, route, cases, scope, passes, meter = null, capUsd = null, generate = runAuditGenerationArm }) {
  const perCase = []; const usageEvents = []; let budgetStop = null; let unaccounted = 0; let maxCaseUsd = 0;
  const stopBefore = () => {
    // Checked BEFORE every case, the first included: a meter already at the cap must not start another paid generation.
    const stop = meter?.check();
    if (stop?.stop) return { reason: stop.reason };
    // The 5-pass call cannot be bounded from outside, so project one case ahead: the costliest case so far must still fit under the cap.
    if (meter && Number.isFinite(capUsd) && maxCaseUsd > 0 && meter.spentUsd + maxCaseUsd > capUsd + 1e-9) return { reason: 'projected-over-cap' };
    return null;
  };
  // Serialised: generation chdirs into the case's repo, which is process-global state.
  for (const kdCase of cases) {
    const stop = stopBefore();
    if (stop) { budgetStop = { ...stop, casesCompleted: perCase.length, casesPlanned: cases.length }; break; }
    const kdId = kdCase.hiddenGroundTruth.kdId;
    const files = kdCase.visibleInput.files;
    let scored = { outcome: 'failed', passes: [] }; let gen = null; let threw = false;
    try {
      gen = await generate({ arm, auditInput: { diff: kdCase.visibleInput.diff, files, repoRoot: kdCase.repoRoot }, route, runId, role: 'auditor', scope, passes });
    } catch (err) {
      // A generation that could not complete is `failed` (unmeasured, in the denominator), never clean. It may still have been billed,
      // so the meter is told the cost is UNKNOWN and the report says its cost is incomplete.
      process.stderr.write(`  [expect-clean] ${kdId}: generation failed: ${err.message}
`);
      threw = true;
      unaccounted += 1;
      meter?.record(null);
    }
    if (!threw && !(gen && typeof gen === 'object')) {
      // Resolved to nothing: the call may have been billed, so it is unknown cost and the case is failed.
      process.stderr.write(`  [expect-clean] ${kdId}: the generation returned no result
`);
      unaccounted += 1;
      meter?.record(null);
    }
    if (gen && typeof gen === 'object') {
      const cost = gen.usageEvent?.costUsd;
      if (gen.usageEvent) usageEvents.push(gen.usageEvent);
      // A usage event with no finite cost means the call was billed at an unknown price: unknown to the meter, unaccounted in the report.
      if (!Number.isFinite(cost) || cost < 0) unaccounted += 1; else maxCaseUsd = Math.max(maxCaseUsd, cost);
      meter?.record(cost); // paid for whatever scoring says: recorded once, outside the scoring try
      try {
        // Every entry must be a finding with a valid severity: a malformed one makes the case unmeasured, never clean.
        if (!Array.isArray(gen.findings) || !gen.findings.every((f) => f && typeof f === 'object' && SEVERITIES.has(f.severity))) throw new Error('malformed finding in the generation result');
        scored = scoreExpectCleanCase({ findings: toScorable(gen.findings, files) }, files);
      } catch (err) {
        process.stderr.write(`  [expect-clean] ${kdId}: result unusable: ${err.message}
`);
      }
    }
    // The findings that made the case a false positive ride with it: the report must be adjudicable without a re-run.
    const drivers = scored.outcome === 'false_positive' && Array.isArray(gen?.findings) ? retainDrivers(gen.findings, files) : undefined;
    perCase.push({ kdId, ...scored, ...(drivers ? { findings: drivers } : {}) });
  }
  return { perCase, summary: summarizeExpectClean(perCase), usageEvents, budgetStop, unaccounted };
}

/** Pure: the process exit code for a report. 0 only when every case was measured and every call's cost is accounted for. */
export function exitCodeFor(rep, budgetStoppedCode) {
  if (rep.budgetStop) return budgetStoppedCode;
  // 3 is INCOMPLETE across this repo: an all-failed (unmeasured) report is the extreme case of it, not a different failure.
  return rep.summary.unmeasured || rep.summary.failed > 0 || rep.unaccounted > 0 ? 3 : 0;
}
