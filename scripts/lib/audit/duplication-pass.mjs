/**
 * @fileoverview Duplication audit pass (Wave 5) — mechanical detector → LLM
 * bouncer → deterministic fallback.
 *
 * Extracted from `legacy-production-audit.mjs` (docs/plans/legacy-production-audit-decomposition.md
 * Phase 3) — a pure relocation, verbatim bodies, no behaviour change.
 *
 * @module scripts/lib/audit/duplication-pass
 */

import { DuplicationBouncerResponseSchema } from '../schemas.mjs';
import { gitDiffWithWorkingTree } from '../vcs.mjs';
import { normalizePath } from '../file-io.mjs';
import { computePassLimits } from '../robustness.mjs';
import { getPassPrompt, safeCallGPT } from './llm-helpers.mjs';
import { runDuplicationAnalysis } from './duplication-detector.mjs';
import {
  formatCandidatesForPrompt, mapBouncerDecisionsToFindings,
  deriveFindingsFromDuplicationReport, buildDetectorFailedFinding, finalizeDeterministicFindings,
} from './duplication-report.mjs';

/**
 * Duplication audit pass (Wave 5) — mechanical detector → LLM bouncer →
 * deterministic fallback, mirroring `runArchitecturePass`'s two-stage shape.
 *
 * **Extracted from `runLegacyProductionAudit`'s body (2026-08-13).** The wave
 * had mirrored that shape since it landed, but not the `{result, usage,
 * latencyMs}` return contract this repo's passes follow: inline, the result
 * literal sat ~40 lines below its own `safeCallGPT` call and hard-coded
 * `usage: { input_tokens: 0, ... }`. `runLegacyProductionAudit` reduces
 * `allResults[].usage` into `totalUsage`, so the bouncer's tokens never
 * reached `_usage.costUsd` (under-reported spend) or `cacheMetrics.hitRate`
 * (whose denominator feeds the weekly `cache-hitrate-check`) — a fabricated
 * zero reading as a measurement. The waves already extracted into functions
 * (`runArchitecturePass`, `runOrphanIntroducedPass`) never had the bug,
 * because a function boundary is what carries the contract.
 *
 * Guarded by tests/audit-wave-usage-accounting.test.mjs, which asserts the
 * observable consequence (`result._usage`) and carries both a vacuous-pass
 * guard and a no-call negative control.
 *
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
export async function runDuplicationPass({
  openai, ctx, passPrompt, changedFiles, auditBaseCommit,
  focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus,
}) {
  const dupStart = Date.now();
  // The bouncer's measured usage, or null when no model call was made. Null →
  // a zeroed envelope below, which is an honest "nothing was spent" rather
  // than the constant this extraction removes.
  // Counted independently of the token values, so "the bouncer was not invoked"
  // stays distinguishable from "it ran and reported nothing" — the shadow
  // reviewer's finding that no persisted signal separated those two.
  let bouncerCalls = 0;
  let bouncerUsage = null;
  let dupFindings = [];
  let dupSummary = '';
  try {
    let report = { state: 'unavailable', reason: 'no auditBaseCommit resolved for this audit run', deterministicFindings: [], semanticCandidates: [] };
    // Test-only injection point (round-1 code-audit M25/M26 fix): when set,
    // bypasses Git resolution entirely and calls the override directly —
    // a hermetic test harness can exercise the findings -> bouncer ->
    // convergence path with a synthetic report, with no live Git/DB/
    // embedding access and no need to also fake a real auditBaseCommit.
    // Production callers never set this; it defaults to undefined.
    if (ctx.__runDuplicationAnalysis) {
      report = await ctx.__runDuplicationAnalysis({ repoRoot: process.cwd(), changedFiles: changedFiles || [], auditBaseCommit });
    } else if (auditBaseCommit) {
      const diff = gitDiffWithWorkingTree(process.cwd(), auditBaseCommit);
      if (diff.ok) {
        const scopeSet = new Set((changedFiles || []).map(normalizePath));
        const inScope = (p) => scopeSet.size === 0 || scopeSet.has(normalizePath(p));
        const richChangedFiles = [
          ...diff.files.added.filter(inScope).map((p) => ({ status: 'added', currentPath: p })),
          ...diff.files.modified.filter(inScope).map((p) => ({ status: 'modified', currentPath: p })),
          ...diff.files.untracked.filter(inScope).map((p) => ({ status: 'added', currentPath: p })),
          ...diff.files.renamed.filter((r) => inScope(r.to)).map((r) => ({ status: 'renamed', currentPath: r.to, previousPath: r.from })),
        ];
        report = await runDuplicationAnalysis({ repoRoot: process.cwd(), changedFiles: richChangedFiles, auditBaseCommit });
      } else {
        report = { state: 'unavailable', reason: `git diff failed: ${diff.error.message}`, deterministicFindings: [], semanticCandidates: [] };
      }
    }

    if (report.state === 'clean') {
      dupSummary = 'Duplication: clean — no candidates over threshold.';
    } else if (report.state === 'unavailable') {
      process.stderr.write(`  Duplication: SKIPPED (unavailable — ${report.reason})\n`);
      dupSummary = `Duplication: SKIPPED (unavailable — ${report.reason})`;
    } else if (report.state === 'failed') {
      process.stderr.write(`  Duplication: FAILED — ${report.reason}\n`);
      dupFindings = [buildDetectorFailedFinding(report.reason)];
      dupSummary = 'Duplication: detector failed — see finding.';
    } else {
      // 'findings' — deterministicFindings always land unconditionally;
      // semanticCandidates go through the bouncer (round-2 M3: never let a
      // bouncer outcome affect the deterministic channel).
      const deterministic = finalizeDeterministicFindings(report.deterministicFindings);
      let semanticFindings = [];
      if (report.semanticCandidates.length > 0) {
        const { prompt, includedIds } = formatCandidatesForPrompt(report.semanticCandidates, { repoRoot: process.cwd() });
        const included = report.semanticCandidates.filter((c) => includedIds.includes(c.id));
        if (included.length === 0) {
          semanticFindings = []; // every candidate refused by the egress scan — nothing to send
        } else {
          const dupLimits = computePassLimits(prompt.length, 'low');
          const bouncerResult = await safeCallGPT(openai, {
            ...passPrompt({
              rubric: getPassPrompt('duplication'),
              focusBlock,
              passName: 'duplication',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: `## Candidates (${included.length})`,
              code: prompt,
            }),
            schema: DuplicationBouncerResponseSchema,
            schemaName: 'duplication_bouncer',
            reasoning: 'low',
            ...dupLimits,
            passName: 'duplication',
          }, null);
          // Captured whether or not the call succeeded: a failed bouncer still
          // burns tokens, and dropping them would re-open this defect on the
          // degraded path only — the harder half to notice.
          bouncerCalls += 1;
          bouncerUsage = bouncerResult?.usage ?? null;
          const decisions = bouncerResult?.result?.decisions;
          const mapped = decisions ? mapBouncerDecisionsToFindings(decisions, included, includedIds) : { ok: false, reason: 'bouncer call failed or returned no decisions' };
          if (mapped.ok) {
            semanticFindings = mapped.findings;
          } else {
            process.stderr.write(`  Duplication bouncer failed (${mapped.reason}) — using deterministic fallback for ${included.length} candidate(s)\n`);
            semanticFindings = deriveFindingsFromDuplicationReport(included);
          }
        }
      }
      dupFindings = [...deterministic, ...semanticFindings];
      dupSummary = `Duplication: ${dupFindings.length} finding(s) (${deterministic.length} deterministic, ${semanticFindings.length} semantic).`;
    }
  } catch (err) {
    // Still fail-open — a wave must never abort the audit — but the error is no
    // longer flattened to a message. A TypeError from a bad injected seam and a
    // detector I/O failure produced identical output, so a programming bug in
    // this pass was indistinguishable from the environment being unavailable,
    // and read as an ordinary "detector failed" finding. `err.name` + the stack
    // are what tell those apart; the finding text keeps the message so the
    // report is unchanged.
    process.stderr.write(`  Duplication: unexpected ${err?.name || 'Error'} — ${err?.message}\n${err?.stack ? `${err.stack}\n` : ''}`);
    dupFindings = [buildDetectorFailedFinding(`${err?.name || 'Error'}: ${err?.message}`)];
    dupSummary = `Duplication: unexpected ${err?.name || 'Error'} — see finding.`;
  }
  return {
    result: { pass_name: 'duplication', findings: dupFindings, summary: dupSummary },
    callCount: bouncerCalls,
    usage: bouncerUsage ?? { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: Date.now() - dupStart,
  };
}
