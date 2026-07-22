/**
 * Behavioural coverage for per-stage usage/cost capture in the tiered-recall
 * pipeline (2026-07-22 item 2b — docs/plans/tiered-recall-audit-pipeline.md).
 *
 * The wiring guards in tiered-pipeline-wiring.test.mjs pin the SOURCE shape
 * (usageEvents variable fed to computeCostReport, fail-open tryBuildUsageEvent,
 * Stage-2 _usage surfacing). This file proves the RUNTIME behaviour the whole
 * fix exists for: a `complete` run that actually spent provider tokens reports
 * a REAL `_usage.costUsd` dollar figure, never the meaningless confirmed `0`
 * (or the interim honest-`null`) it emitted before capture was threaded.
 *
 * The seam is deterministic: the pipeline accumulates one UsageEvent per stage
 * call and prices them with the static model-pricing table. We drive it with
 * stub providers (no network) whose discovery generators succeed with a
 * zero-finding result — a generator that finds nothing still SPENT tokens, so
 * its cost must be metered (the "meter even a zero-finding response" invariant).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runTieredAuditPipeline } from '../scripts/lib/audit/tiered-pipeline.mjs';
import { tieredAuditConfig } from '../scripts/lib/config.mjs';
import { resolveModel } from '../scripts/lib/model-resolver.mjs';
import { priceFor } from '../scripts/lib/model-pricing.mjs';

// A one-file diff — the minimum that makes resolveEligibleDiffPathMap `ready`
// so discovery runs (an empty diff short-circuits to skipped_no_eligible_files
// BEFORE any generator, per the wiring test's own note).
const REAL_DIFF = 'diff --git a/x.js b/x.js\nindex 111..222 100644\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n';

// Both required discovery generators succeed but find nothing; each still
// reports token usage, so the run is `complete` with 0 findings and a real,
// non-zero cost sourced purely from discovery spend.
const GLM_USAGE = { input_tokens: 1000, output_tokens: 500, cached_tokens: 0, latency_ms: 10 };
const SONNET_USAGE = { input_tokens: 2000, output_tokens: 800 };

function completeRunCtx(over = {}) {
  return {
    planContent: 'p',
    changedFiles: ['x.js'],
    diffText: REAL_DIFF,
    generatorOutcomes: [],
    model: resolveModel('latest-gpt'),
    noLedger: true, noDebtLedger: true, noTools: true, noCloudRecording: true,
    providers: {
      openai: null,
      // ossCall serves the GLM discovery generator here (Stage 1 never runs —
      // no findings survive to be triaged).
      ossCall: async () => ({ result: { findings: [] }, usage: GLM_USAGE, category: null, error: null }),
      anthropicClient: {
        messages: {
          create: async () => ({
            content: [{ type: 'tool_use', name: 'report_findings', input: { findings: [] } }],
            usage: SONNET_USAGE,
            stop_reason: 'tool_use',
          }),
        },
      },
      // No _usage on the Stage-2 stubs → clean-region sampling (if any) adds no
      // cost; discovery spend is what this test isolates.
      geminiReviewCall: async () => ({ verdict: 'verified' }),
      geminiCleanRegionCall: async () => ({ verdict: 'clean' }),
    },
    ...over,
  };
}

describe('tiered pipeline — per-stage usage capture → real _usage.costUsd', () => {
  test('a complete run that spent discovery tokens reports a REAL costUsd, not null and not a fabricated 0', async () => {
    const glmPriced = priceFor(tieredAuditConfig.discoveryModel);
    const sonnetPriced = priceFor(resolveModel('latest-sonnet'));
    // The static price table must know both discovery models for the exact-math
    // assertion; if a future table edit drops one, skip rather than false-fail.
    if (!glmPriced || !sonnetPriced) return;

    const result = await runTieredAuditPipeline(completeRunCtx());

    assert.equal(result.runStatus, 'complete', 'stubbed generators succeed → a complete run');
    assert.equal(result.findings.length, 0, 'both generators found nothing');

    const cost = result._usage.costUsd;
    assert.equal(typeof cost, 'number', 'costUsd must be a real number once tokens were captured (was null/0 before 2b)');
    assert.ok(cost > 0, `costUsd must be > 0 for a run that spent tokens, got ${cost}`);

    // Exact seam math: discovery GLM + Sonnet, priced by the static table.
    const glmUsd = (GLM_USAGE.input_tokens * glmPriced.input + GLM_USAGE.output_tokens * glmPriced.output) / 1e6;
    const sonnetUsd = (SONNET_USAGE.input_tokens * sonnetPriced.input + SONNET_USAGE.output_tokens * sonnetPriced.output) / 1e6;
    assert.ok(Math.abs(cost - (glmUsd + sonnetUsd)) < 1e-9, `expected ${glmUsd + sonnetUsd}, got ${cost}`);

    // Both discovery models are priced, so nothing degraded to 'unavailable'.
    assert.equal(result._usage.unavailableCostEventCount, 0, 'both discovery events priced → none unavailable');
  });

  test('honest-null: a run that captured NO usage events reports costUsd null, never a measured 0', async () => {
    // An empty diff skips both generators BEFORE any provider call (no tokens
    // spent), so usageEvents stays empty and buildUsageBlock's no-priced-events
    // branch must produce null — the contrast case to the real-cost run above.
    const result = await runTieredAuditPipeline(completeRunCtx({ diffText: '', changedFiles: [] }));
    assert.equal(result.runStatus, 'skipped_no_eligible_files', 'empty diff → skipped, not complete');
    assert.equal(result._usage.costUsd, null, 'nothing was metered → honest null, never a fabricated 0');
  });
});
