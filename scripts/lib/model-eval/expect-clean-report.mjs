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
import { scoreExpectCleanCase, summarizeExpectClean } from './corpus-selection.mjs';

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

/**
 * @param {{runId: string, arm: object, route: object, cases: {visibleInput: {diff: string, files: string[]}, hiddenGroundTruth: {kdId: string}, repoRoot: string}[],
 *   scope?: string, passes?: string[], meter?: {record: Function, check: Function}|null, generate?: typeof runAuditGenerationArm}} args
 * @returns {Promise<{perCase: object[], summary: object, usageEvents: object[], budgetStop: object|null}>}
 */
export async function runExpectCleanReport({ runId, arm, route, cases, scope, passes, meter = null, generate = runAuditGenerationArm }) {
  const perCase = []; const usageEvents = []; let budgetStop = null;
  // Serialised: generation chdirs into the case's repo, which is process-global state.
  for (const kdCase of cases) {
    const kdId = kdCase.hiddenGroundTruth.kdId;
    const files = kdCase.visibleInput.files;
    let scored;
    try {
      const gen = await generate({ arm, auditInput: { diff: kdCase.visibleInput.diff, files, repoRoot: kdCase.repoRoot }, route, runId, role: 'auditor', scope, passes });
      usageEvents.push(gen.usageEvent);
      meter?.record(gen.usageEvent.costUsd);
      scored = scoreExpectCleanCase({ findings: toScorable(gen.findings, files) }, files);
    } catch (err) {
      // A generation that could not complete is `failed` (unmeasured, in the denominator), never clean.
      process.stderr.write(`  [expect-clean] ${kdId}: generation failed: ${err.message}\n`);
      scored = { outcome: 'failed', passes: [] };
      meter?.record(null);
    }
    perCase.push({ kdId, ...scored });
    const stop = meter?.check();
    if (stop?.stop) { budgetStop = { reason: stop.reason, casesCompleted: perCase.length, casesPlanned: cases.length }; break; }
  }
  return { perCase, summary: summarizeExpectClean(perCase), usageEvents, budgetStop };
}
