/**
 * A retried LLM call is billed for EVERY attempt. Two retry loops kept only
 * the last attempt's usage (campaign's adjudicator overwrote it; the final
 * review threw a failed attempt's usage away), so spend was costed as one
 * call and every retry read as free. Both tests below failed before the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumUsage } from '../scripts/lib/model-pricing.mjs';
import { _internals as campaign } from '../scripts/campaign.mjs';
import { runReviewWithRetry } from '../scripts/gemini-review.mjs';

test('sumUsage: adds every numeric field (cache reads/writes, thinking, self-reported cost), ORs flags, and two nulls stay null', () => {
  assert.equal(sumUsage(null, null), null);
  assert.deepEqual(sumUsage(null, { input_tokens: 1 }), { input_tokens: 1 });
  assert.deepEqual(
    sumUsage(
      { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, provider_cost_usd: 0.01, usageMissing: false, service_tier: 'standard' },
      { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 7, provider_cost_usd: 0.02, usageMissing: true },
    ),
    { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, provider_cost_usd: 0.03, usageMissing: true, service_tier: 'standard' },
  );
});

test('campaign callAdjudicator: usage is SUMMED across both attempts, not overwritten by the last one', async () => {
  const replies = [
    { content: [{ type: 'text', text: 'prose, no tool call' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 50 } },
    { content: [{ type: 'text', text: 'prose again' }], stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 70 } },
  ];
  const client = { messages: { create: async () => replies.shift() } };
  const r = await campaign.callAdjudicator({ client, model: 'claude-opus-5-5', blind: { worksheetRowId: 'w1' } });
  assert.equal(r.verdict, null);
  assert.deepEqual(r.usage, { input_tokens: 3000, output_tokens: 300, cache_read_input_tokens: 120 });
});

test('campaign callAdjudicator: an attempt that threw (no response, nothing billed) adds nothing and fabricates nothing', async () => {
  let n = 0;
  const client = { messages: { create: async () => { n += 1; if (n === 1) throw new Error('socket hang up'); return { content: [], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }; } } };
  const r = await campaign.callAdjudicator({ client, model: 'claude-opus-5-5', blind: { worksheetRowId: 'w1' } });
  assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 1 });
});

// ── final review: the Gemini transport's truncated-JSON retry ───────────────

const VALID_REVIEW = JSON.stringify({
  verdict: 'APPROVE',
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'fine' },
  new_findings: [], wrongly_dismissed: [], over_engineering_flags: [],
  architectural_coherence: 'Strong', overall_reasoning: 'ok',
});
const TRANSCRIPT = JSON.stringify({ audit_mode: 'code', changed_files: [], code_files: [], summary: 't', rounds: [{ round: 1, findings: [] }], claude_resolutions: [] });

/** A Gemini-shaped client whose streams yield the given (text, tokens) replies in order. */
function geminiClient(replies) {
  return {
    models: {
      generateContentStream: async () => {
        const { text, input, output } = replies.shift();
        return (async function* stream() {
          yield { text, usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, thoughtsTokenCount: 0, totalTokenCount: input + output } };
        })();
      },
    },
  };
}

test('runReviewWithRetry: a JSON-truncated first attempt is billed — the returned usage is the sum of both attempts', async () => {
  const client = geminiClient([
    { text: '{"verdict":"APPROVE","overall_reasoning":"cut off mid-str', input: 1000, output: 400 },
    { text: VALID_REVIEW, input: 1100, output: 300 },
  ]);
  const r = await runReviewWithRetry('gemini', client, '# plan', TRANSCRIPT, 'ctx', 'code');
  assert.equal(r.result.verdict, 'APPROVE');
  assert.equal(r.usage.input_tokens, 2100);
  assert.equal(r.usage.output_tokens, 700);
});

test('runReviewWithRetry: when every attempt fails, the thrown error carries the summed billed usage instead of dropping it', async () => {
  const client = geminiClient([
    { text: '{"verdict":"APP', input: 1000, output: 400 },
    { text: '{"verdict":"APPRO', input: 1000, output: 500 },
  ]);
  const err = await runReviewWithRetry('gemini', client, '# plan', TRANSCRIPT, 'ctx', 'code').then(() => null, (e) => e);
  assert.ok(err, 'both attempts truncated: the call must reject');
  assert.equal(err.usage?.input_tokens, 2000);
  assert.equal(err.usage?.output_tokens, 900);
});
