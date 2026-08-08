/**
 * @fileoverview Anthropic prompt caching on the final-review transport, and the
 * cost arithmetic that keeps a cache hit from reading as a free review.
 *
 * Deterministic seam (Tier 1). The failure this guards is not a crash — it is a
 * SAVING THAT ISN'T THERE, in two flavours:
 *
 *   1. An inert marker. `cache_control` on a prefix below the model's minimum
 *      cacheable length is accepted by the API, billed at the 1.25x write
 *      premium, and never read back — a 25% cost INCREASE that looks like an
 *      optimisation.
 *   2. A fabricated saving. On a cache hit Anthropic moves the prefix out of
 *      `input_tokens` into `cache_read_input_tokens`. A reader that drops that
 *      field reports an 81K-token review as a few hundred tokens, and the cost
 *      derived from it is a measurement of nothing. Same class as the hardcoded
 *      `thinking_tokens: 0` this file's sibling test already guards.
 *
 * Env is set BEFORE the imports because finalReviewConfig is frozen at import —
 * which is why the flag lives in its own test file rather than joining
 * gemini-review-callreviewer.test.mjs, which must import with caching OFF.
 *
 * EVERY repo import here is dynamic, deliberately. Static `import` statements
 * are hoisted above module-body code, so a single static import of anything
 * that transitively reaches config.mjs (model-pricing.mjs does) freezes the
 * config before the assignment below ever runs — and the whole suite then tests
 * the caching-OFF path while reading as if it tested caching ON. Caught by the
 * placement cases failing on first run; do not "tidy" these back to static.
 *
 * @module tests/final-review-prompt-cache
 */
process.env.FINAL_REVIEW_PROMPT_CACHE = '1';
process.env.GEMINI_REVIEW_TIMEOUT_MS = '5000';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const { costFromUsage, costForBudget, CACHE_MULTIPLIER, priceFor } = await import('../scripts/lib/model-pricing.mjs');
const gemini = await import('../scripts/gemini-review.mjs');
const { _internals, ANTHROPIC_MIN_CACHEABLE_TOKENS, runFinalReview } = gemini;
const { callReviewer, streamAnthropicMessage } = _internals;

/** A client that records the request body and returns a minimal valid review. */
function recordingClient(usage = { input_tokens: 5, output_tokens: 3 }) {
  const seen = {};
  return {
    seen,
    messages: {
      create: async (body) => {
        seen.body = body;
        return { content: [{ type: 'text', text: '{"verdict":"CONCERNS"}' }], usage };
      },
    },
  };
}

/** The single user content block's cache_control, or null when content is a bare string. */
function cacheMarker(body) {
  const content = body?.messages?.[0]?.content;
  if (typeof content === 'string' || !Array.isArray(content)) return null;
  return content[0]?.cache_control ?? null;
}

// Comfortably over the 1024-token minimum at the chars/4 estimate the adapter
// uses, without depending on the exact ratio.
const LONG_PROMPT = 'x'.repeat(ANTHROPIC_MIN_CACHEABLE_TOKENS * 4 * 3);
const BASE = { model: 'm', systemPrompt: 'sys', passName: 'unit', transportKind: 'anthropic' };

describe('anthropic transport — cache breakpoint placement', () => {
  test('marks the user block when enabled and the prompt clears the minimum', async () => {
    const client = recordingClient();
    await callReviewer(client, { ...BASE, userPrompt: LONG_PROMPT });
    assert.deepEqual(cacheMarker(client.seen.body), { type: 'ephemeral' });
  });

  test('a below-minimum prompt is NOT marked, even with the flag on', async () => {
    // The whole point of the guard: an inert marker costs the write premium and
    // is never read back, so "enabled" must not mean "always marked".
    const client = recordingClient();
    await callReviewer(client, { ...BASE, userPrompt: 'short' });
    assert.equal(cacheMarker(client.seen.body), null);
    assert.equal(typeof client.seen.body.messages[0].content, 'string',
      'unmarked requests keep the plain-string content shape');
  });

  test('one breakpoint only — a second buys no prefix the first does not cover', async () => {
    const client = recordingClient();
    await callReviewer(client, { ...BASE, userPrompt: LONG_PROMPT });
    const content = client.seen.body.messages[0].content;
    assert.equal(content.length, 1);
    assert.equal(content.filter((b) => b.cache_control).length, 1);
  });

  test('the marked prompt text is unchanged — caching alters cost, never content', async () => {
    const client = recordingClient();
    await callReviewer(client, { ...BASE, userPrompt: LONG_PROMPT });
    assert.equal(client.seen.body.messages[0].content[0].text, LONG_PROMPT);
  });
});

describe('anthropic transport — cache usage is carried, not dropped', () => {
  test('a cache HIT surfaces the read tokens instead of vanishing', async () => {
    // input_tokens collapses on a hit; without cache_read_input_tokens the caller
    // sees a 300-token review where an 81K-token one was sent.
    const client = recordingClient({
      input_tokens: 312, output_tokens: 4200,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 80_870,
    });
    const { usage } = await callReviewer(client, { ...BASE, userPrompt: LONG_PROMPT });
    assert.equal(usage.cache_read_input_tokens, 80_870);
    assert.equal(usage.cache_creation_input_tokens, 0);
    assert.equal(usage.input_tokens, 312, 'the provider-reported uncached count is passed through as-is');
  });

  test('absent cache fields read as 0, never undefined', async () => {
    const client = recordingClient({ input_tokens: 5, output_tokens: 3 });
    const { usage } = await callReviewer(client, { ...BASE, userPrompt: 'short' });
    assert.equal(usage.cache_read_input_tokens, 0);
    assert.equal(usage.cache_creation_input_tokens, 0);
  });

  test('the STREAM reader accumulates cache_read_input_tokens from message_start', async () => {
    // The streaming path builds its own usage object, so a field it does not
    // copy does not exist downstream however correct the adapter above is.
    const client = { messages: { create: async () => (async function* () {
      yield { type: 'message_start', message: { usage: {
        input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 80_870,
      } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '{}' } };
      yield { type: 'message_delta', usage: { output_tokens: 4200 }, delta: { stop_reason: 'end_turn' } };
    })() } };
    const r = await streamAnthropicMessage(client, {});
    assert.equal(r.usage.cache_read_input_tokens, 80_870);
    assert.equal(r.usage.cache_creation_input_tokens, 0);
    assert.equal(r.usage.input_tokens, 400);
  });
});

describe('costFromUsage — a cache hit is cheap, not free', () => {
  const MODEL = 'claude-opus-5';
  const px = priceFor(MODEL);

  test('the model under test is priced (otherwise every assertion below is vacuous)', () => {
    assert.ok(px, `${MODEL} must resolve to a price for these cases to mean anything`);
  });

  test('a cache READ is billed at the read multiplier, not dropped', () => {
    const hit = costFromUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, MODEL);
    assert.equal(hit.totalUsd, px.input * CACHE_MULTIPLIER.read);
    assert.ok(hit.totalUsd > 0, 'a cache hit must never cost zero — the tokens were still billed');
  });

  test('a cache WRITE is billed ABOVE base — the premium that makes this opt-in', () => {
    const write = costFromUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, MODEL);
    const plain = costFromUsage({ input_tokens: 1_000_000, output_tokens: 0 }, MODEL);
    assert.ok(write.totalUsd > plain.totalUsd, 'a single cached send costs MORE than an uncached one');
    assert.equal(write.totalUsd, plain.totalUsd * CACHE_MULTIPLIER.write);
  });

  test('two identical sends cost 1.35x uncached-x1, not 2x and not 1.1x', () => {
    // The claim the reorder is justified by. Getting this wrong in either
    // direction misprices the whole campaign.
    const N = 1_000_000;
    const first = costFromUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: N }, MODEL);
    const second = costFromUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: N }, MODEL);
    const uncachedPair = costFromUsage({ input_tokens: N, output_tokens: 0 }, MODEL).totalUsd * 2;
    const ratio = (first.totalUsd + second.totalUsd) / (uncachedPair / 2);
    assert.equal(Number(ratio.toFixed(4)), 1.35);
    assert.equal(Number((1 - (first.totalUsd + second.totalUsd) / uncachedPair).toFixed(4)), 0.325);
  });

  test('inputTokens reports TOTAL prompt size, so cached and uncached runs compare', () => {
    const r = costFromUsage({ input_tokens: 312, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 870, output_tokens: 10 }, MODEL);
    assert.equal(r.inputTokens, 81_182);
    assert.equal(r.cacheReadTokens, 80_000);
    assert.equal(r.cacheWriteTokens, 870);
  });

  test('a provider that reports no cache fields is priced exactly as before', () => {
    const r = costFromUsage({ input_tokens: 1000, output_tokens: 100 }, MODEL);
    assert.equal(r.totalUsd, (1000 * px.input + 100 * px.output) / 1e6);
    assert.equal(r.inputTokens, 1000);
  });
});

describe('request fingerprint — "are these two arms different?" is a comparison', () => {
  const TRANSCRIPT = JSON.stringify({ mode: 'code', rounds: [] });
  const client = () => ({ messages: { create: async () => ({
    content: [{ type: 'tool_use', name: 'submit_review', input: {
      verdict: 'APPROVE', deliberation_quality: 'x', new_findings: [], wrongly_dismissed: [],
      over_engineering_flags: [], architectural_coherence: 'x', overall_reasoning: 'x',
    } }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }) } });
  const fp = (plan, model) => runFinalReview('claude-opus', client(), plan, TRANSCRIPT, 'ctx', 'code', model)
    .then((r) => r.requestFingerprint);

  test('identical inputs produce an identical fingerprint — a reroll is detectable', async () => {
    // The whole point. The bake-off's opus and solo-opus arms differ only in
    // downstream bucketing, and establishing that took token-count archaeology
    // across five files plus a read of the shadow orchestration.
    assert.equal(await fp('# plan'), await fp('# plan'));
  });

  test('a changed prompt changes the fingerprint', async () => {
    assert.notEqual(await fp('# plan'), await fp('# a different plan'));
  });

  test('a changed model changes the fingerprint', async () => {
    assert.notEqual(await fp('# plan'), await fp('# plan', 'some-other-model'));
  });

  test('it is stamped on the RESULT, so it survives into the arm output file', async () => {
    // A value only on the return object is lost at the first hop that rebuilds
    // its own envelope — how the shadow's cache-token counts went missing.
    const r = await runFinalReview('claude-opus', client(), '# plan', TRANSCRIPT, 'ctx', 'code');
    assert.equal(r.result._requestFingerprint, r.requestFingerprint);
    assert.match(r.requestFingerprint, /^[0-9a-f]{16}$/);
  });
});

describe('costForBudget — cached tokens can never under-reserve the ceiling', () => {
  const MODEL = 'claude-opus-5';

  test('a cache write counts toward the cap at its premium', () => {
    const b = costForBudget({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, MODEL);
    const plain = costForBudget({ input_tokens: 1_000_000, output_tokens: 0 }, MODEL);
    assert.ok(b.totalUsd > plain.totalUsd);
  });

  test('a cache read counts toward the cap rather than reading as free spend', () => {
    const b = costForBudget({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, MODEL);
    assert.ok(b.totalUsd > 0);
  });

  test('missing cache fields do NOT make an otherwise-metered call unmeterable', () => {
    // They are optional fields; treating their absence as unmeterable would pin
    // every non-Anthropic run to its pre-flight reservation forever.
    const b = costForBudget({ input_tokens: 10, output_tokens: 2 }, MODEL);
    assert.equal(b.unmeterable, false);
  });
});
