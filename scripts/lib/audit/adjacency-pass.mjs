/**
 * @fileoverview Containment-adjacency audit pass (Wave 6) — deterministic
 * detector enumerates, LLM bouncer only judges what it is handed.
 *
 * Extracted from `legacy-production-audit.mjs` (docs/plans/legacy-production-audit-decomposition.md
 * Phase 3) — a pure relocation, verbatim bodies, no behaviour change.
 *
 * @module scripts/lib/audit/adjacency-pass
 */

import { AdjacencyBouncerResponseSchema } from '../schemas.mjs';
import { addUsage, computePassLimits } from '../robustness.mjs';
import { getPassPrompt, safeCallGPT } from './llm-helpers.mjs';
import { adjacencyConfig } from '../config.mjs';
import { runAdjacencyAnalysis } from './adjacency-detector.mjs';
import { runAdjacencyBouncer, buildAdjacencyFailedFinding } from './adjacency-report.mjs';
import { composeAdjacencyResult } from './adjacency-compose.mjs';

/**
 * Containment-adjacency audit pass (Wave 6) — deterministic detector enumerates,
 * LLM bouncer only judges what it is handed.
 *
 * Extracted alongside `runDuplicationPass` (2026-08-13) and for the same
 * reason: see that function's docblock for why the inline form could not carry
 * the `{result, usage, latencyMs}` contract. This wave's bouncer usage arrives
 * through a `callLlm` CALLBACK rather than a direct return, so it is captured
 * into the enclosing scope — `runAdjacencyBouncer` invokes that callback at
 * most once (adjacency-report.mjs), but the capture accumulates rather than
 * overwrites so a future second call cannot silently drop the first's tokens.
 *
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
export async function runAdjacencyPass({
  openai, ctx, passPrompt, auditBaseCommit,
  focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus,
}) {
  const adjStart = Date.now();
  // Counted independently of the token values, so "the bouncer was not invoked"
  // stays distinguishable from "it ran and reported nothing" — the shadow
  // reviewer's finding that no persisted signal separated those two.
  let bouncerCalls = 0;
  let bouncerUsage = null;
  let adjFindings = [];
  let adjSummary = '';
  try {
    // No diff contract → NOT-APPLICABLE, not a failure. The wave is
    // diff-triggered by construction (§D1), so on a `--scope full` or
    // base-less run there is nothing it could ever have been asked. Skipping
    // the detector entirely is what keeps that honest: running it would
    // record "no safe auditBaseCommit" as INPUT_BOUND incompleteness, which
    // emits a control finding — turning honest absence into a reported
    // coverage failure, the exact conflation R1-H3 split apart.
    // The test seam wins over Git resolution (mirroring Wave 5's), so a
    // hermetic test can exercise this whole path without faking a commit.
    const analysis = ctx.__runAdjacencyAnalysis
      ? await ctx.__runAdjacencyAnalysis({ repoRoot: process.cwd(), auditBaseCommit, bounds: adjacencyConfig })
      : !auditBaseCommit
        ? { coverage: { containersEnumerated: 0, statementsJudged: 0 }, candidates: [], incompleteness: [], threw: null }
        : await runAdjacencyAnalysis({ repoRoot: process.cwd(), auditBaseCommit, bounds: adjacencyConfig });

    // The bouncer runs only when there is something to judge. Zero eligible
    // candidates short-circuits without a model call.
    let bouncer = null;
    const eligible = (analysis.candidates ?? []).filter((c) => c.payload?.safe);
    if (eligible.length > 0) {
      bouncer = await runAdjacencyBouncer(analysis.candidates, {
        bounds: adjacencyConfig,
        rubric: getPassPrompt('adjacency'),
        callLlm: async ({ prompt, rubric }) => {
          const adjLimits = computePassLimits(prompt.length, 'low');
          const res = await safeCallGPT(openai, {
            ...passPrompt({
              rubric,
              focusBlock,
              passName: 'adjacency',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: `## Adjacency candidates (${eligible.length})`,
              code: prompt,
            }),
            schema: AdjacencyBouncerResponseSchema,
            schemaName: 'adjacency_bouncer',
            reasoning: 'low',
            ...adjLimits,
            passName: 'adjacency',
          }, null);
          bouncerCalls += 1;
          if (res?.usage) bouncerUsage = addUsage(bouncerUsage, res.usage);
          return res?.result ?? null;
        },
      });
    }

    // ONE composition point — the sole buildAdjacencyState call site.
    const composed = composeAdjacencyResult({
      analysis,
      bouncer,
      selected: true,
      diffContractAvailable: Boolean(auditBaseCommit) || Boolean(ctx.__runAdjacencyAnalysis),
    });
    adjFindings = composed.findings;
    const { state, coverage } = composed.result;
    adjSummary = `Adjacency: ${state} — ${coverage.containersEnumerated} container(s), `
      + `${coverage.statementsJudged} statement(s) judged, ${composed.result.candidates.length} candidate(s).`;
    process.stderr.write(`  ${adjSummary}\n`);
  } catch (err) {
    // Same reasoning as runDuplicationPass's catch above: fail-open, but name
    // the error CLASS so a programming bug is not reported as a detector
    // failure.
    process.stderr.write(`  Adjacency: unexpected ${err?.name || 'Error'} — ${err?.message}\n${err?.stack ? `${err.stack}\n` : ''}`);
    adjFindings = [buildAdjacencyFailedFinding(`${err?.name || 'Error'}: ${err?.message}`)];
    adjSummary = `Adjacency: unexpected ${err?.name || 'Error'} — see finding.`;
  }
  return {
    result: { pass_name: 'adjacency', findings: adjFindings, summary: adjSummary },
    callCount: bouncerCalls,
    usage: bouncerUsage ?? { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: Date.now() - adjStart,
  };
}
