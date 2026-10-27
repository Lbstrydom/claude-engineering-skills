/**
 * @fileoverview Provenance for the Gemini / final-review call
 * (docs/plans/own-model-telemetry-pr3.md decision 4, producer `final-review`).
 *
 * The final reviewer is a separate CLI process from the audit spine, so it owns its
 * own producer log: bind it to the review's run id, record the one primary call, and
 * flush through the same registered `audit.llmCalls` writer. Metadata only - the
 * transcript and verdict text never reach the log.
 *
 * Never throws and never changes the review's exit code: a provenance miss is
 * reported on stderr, not turned into a failed review.
 *
 * @module scripts/lib/telemetry/final-review-call
 */
import { bindRun, record, drain } from './llm-call-log.mjs';
import { routeFor } from './llm-call-log.mjs';

/**
 * @param {{runId: string|null, repoId?: string|null, model: string, provider: string, usage?: object, latencyMs?: number}} a
 * @returns {Promise<'recorded'|'skipped'|'failed'>}
 */
export async function recordFinalReviewCall({ runId, repoId = null, model, provider, usage, latencyMs }) {
  try {
    if (!runId) return 'skipped';
    if (!bindRun({ runId, repoId, workItemId: process.env.OWN_MODEL_WORK_ITEM_ID, producer: 'final-review' })) return 'skipped';
    record({
      purpose: 'final-review',
      model,
      route: routeFor({ azure: provider === 'azure-claude', cli: provider === 'anthropic-cli', model }),
      usage: {
        input_tokens: usage?.input_tokens ?? usage?.inputTokens,
        cached_tokens: usage?.cached_tokens ?? usage?.cachedTokens,
        output_tokens: usage?.output_tokens ?? usage?.outputTokens,
        reasoning_tokens: usage?.reasoning_tokens ?? usage?.reasoningTokens,
      },
      latencyMs,
    });
    const log = drain();
    if (!log) return 'skipped';
    await import('../audit-store-writers.mjs');   // registers the writers (side-effecting import)
    const { durableWrite } = await import('../durable-write.mjs');
    const out = await durableWrite('audit.llmCalls', { ...log, run_id: runId });
    return out.outcome === 'written' || out.outcome === 'skipped' ? 'recorded' : 'failed';
  } catch (err) {
    process.stderr.write(`  [llm-calls] final-review provenance not recorded: ${err?.message ?? err}\n`);
    return 'failed';
  }
}
