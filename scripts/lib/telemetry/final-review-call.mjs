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
import { costFromUsage, PRICING_VERSION } from '../model-pricing.mjs';
import { resolveWorkItemId } from '../ledger/work-item.mjs';
import { execFileSync } from 'node:child_process';

/**
 * USD for one final-review call, priced the way the GPT path prices its aggregate
 * (`costFromUsage`). Gemini bills thinking tokens at the OUTPUT rate and reports them
 * separately from `output_tokens`, so they are folded in (same rule as
 * `tiered-provider-calls.mjs`). Pure. `null` = unmetered or unpriced model, never a
 * fabricated 0.
 * @param {object|null|undefined} usage
 * @param {string} model
 * @returns {number|null}
 */
export function finalReviewCostUsd(usage, model) {
  if (!usage || typeof usage !== 'object') return null;
  const out = usage.output_tokens ?? usage.outputTokens;
  const think = usage.thinking_tokens ?? 0;
  const priced = { ...usage, input_tokens: usage.input_tokens ?? usage.inputTokens, output_tokens: typeof out === 'number' ? out + (typeof think === 'number' ? think : 0) : out };
  return costFromUsage(priced, model).totalUsd ?? null;
}

/**
 * @param {{runId: string|null, repoId?: string|null, model: string, provider: string, usage?: object, latencyMs?: number}} a
 * @returns {Promise<'recorded'|'skipped'|'failed'>}
 */
export function reviewedTreeFromTranscript(transcriptContent) {
  try {
    const t = typeof transcriptContent === 'string' ? JSON.parse(transcriptContent) : transcriptContent;
    const last = Array.isArray(t?.rounds) ? t.rounds[t.rounds.length - 1] : null;
    return typeof last?._auditedTree === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(last._auditedTree) ? last._auditedTree : null;
  } catch { return null; }
}

export async function recordFinalReviewCall({ runId, repoId = null, model, provider, usage, latencyMs, auditedTree = undefined }) {
  try {
    if (!runId) return 'skipped';
    // Same per-call identity as the audit producer. The reviewer is its own process, so the tree is read
    // from the working tree it reviewed; no diff base is known here, so it stays null rather than guessed.
    // The tree is the one the REVIEW INPUT carries (the transcript's own `_auditedTree`), passed by the caller: never the
    // working tree at record time, which can have moved since the transcript was built. None given is null.
    const tree = auditedTree ?? null;
    let branch = null;
    try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim(); } catch { /* detached or no git: no branch segment, no guess */ }
    if (!bindRun({ runId, repoId, workItemId: resolveWorkItemId({ branch }), producer: 'final-review', auditedTree: tree })) return 'skipped';
    record({
      purpose: 'final-review',
      model,
      route: routeFor({ azure: provider === 'azure-claude', cli: provider === 'anthropic-cli', model }),
      usage: {
        input_tokens: usage?.input_tokens ?? usage?.inputTokens,
        cached_tokens: usage?.cached_tokens ?? usage?.cachedTokens,
        output_tokens: usage?.output_tokens ?? usage?.outputTokens,
        reasoning_tokens: usage?.reasoning_tokens ?? usage?.reasoningTokens ?? usage?.thinking_tokens,
      },
      latencyMs,
      costUsd: finalReviewCostUsd(usage, model),
      pricingVersion: PRICING_VERSION,
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
