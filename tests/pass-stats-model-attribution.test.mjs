/**
 * @fileoverview Tier 2 regression: every GPT call must carry back the model
 * that served it, so `audit_pass_stats.source_model` is a measurement.
 *
 * **The defect.** `audit_pass_stats` has carried `source_model`, `cost_usd` and
 * `usage_unmeterable` columns since migration 20260701120000, and
 * `recordPassStats` has always written them — but the ONLY caller that ever
 * supplied them was `audit-shadow.mjs`, the model-A/B shadow that concluded
 * 2026-07-09. Measured 2026-08-23 against the live store: `source_model` was
 * NULL on all 5,459 production rows, and `cost_usd` on all 5,459. So six weeks
 * of per-pass findings-raised / accepted / dismissed / tokens / latency were
 * recorded against no model at all, and "did the new GPT release change
 * accept-rate or cost" was unanswerable from the log built to answer it.
 *
 * **Why the assertions sit here.** The model originates at the call seam, and
 * that is the only place it can be MEASURED rather than re-derived: an
 * orchestrator that looks the model up separately is a second source that can
 * drift from the request, which is the exact defect the `reasoningEffort`
 * comment in `llm-helpers.mjs` records for the effort column one row over.
 * Every assertion below therefore pins the value to the dispatched request or
 * the provider's own echo, never to config read independently.
 *
 * The degraded case matters as much as the happy one: a failed pass still
 * burns the tokens `safeCallGPT` reports, so dropping its model files real
 * spend against nobody.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { _callGPTOnce, safeCallGPT, wireModel } from '../scripts/lib/audit/llm-helpers.mjs';

const Schema = z.object({ findings: z.array(z.string()) }).strict();

const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};

/** A Responses-API stub whose reply optionally echoes a server-side model id. */
function stub(responseModel) {
  return {
    responses: {
      parse: async () => ({
        status: 'completed',
        output: [],
        output_parsed: { findings: [] },
        usage: USAGE,
        ...(responseModel === undefined ? {} : { model: responseModel }),
      }),
    },
  };
}

const opts = {
  system: 'you audit code',
  messages: [{ role: 'user', content: 'audit this' }],
  schema: Schema, schemaName: 'test_pass', reasoning: 'low', maxTokens: 500, timeoutMs: 5000,
};

describe('pass-stats model attribution — the call must report what served it', () => {
  it('prefers the provider-reported model over what we dispatched', async () => {
    // The server can answer with a MORE specific id than the one sent (a dated
    // snapshot behind an alias). That reply is the ground truth for "which
    // model produced these findings", so it must win.
    const out = await _callGPTOnce(stub('gpt-5.6-terra-2026-08-01'), opts);
    assert.equal(out.model, 'gpt-5.6-terra-2026-08-01');
  });

  it('falls back to the dispatched wire model when the provider echoes none', async () => {
    const out = await _callGPTOnce(stub(undefined), opts);
    assert.equal(out.model, wireModel(),
      'with no echo, what we SENT is the honest answer — not null, and not a separately-resolved id');
  });

  it('never reports a model the request did not name', async () => {
    // Negative control: the guard must key on the request/echo, not on ambient
    // config. If this ever passed while the stub echoed something else, the
    // value would be re-derived rather than measured.
    const out = await _callGPTOnce(stub('some-other-model'), opts);
    assert.notEqual(out.model, wireModel());
    assert.equal(out.model, 'some-other-model');
  });

  it('stamps the model on the degraded path, where real tokens were still burned', async () => {
    const throwing = { responses: { parse: async () => { throw new Error('boom'); } } };
    const out = await safeCallGPT(throwing, { ...opts, passName: 'p', maxRetries: 0 }, { findings: [] });
    assert.equal(out.failed, true, 'vacuous-pass guard: this must actually be the degraded path');
    assert.equal(out.model, wireModel(),
      'a failed pass reports the model it was dispatched to — omitting it files its spend against nobody');
  });
});
