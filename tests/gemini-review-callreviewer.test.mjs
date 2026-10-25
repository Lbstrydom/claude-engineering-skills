/**
 * @fileoverview Unified `callReviewer` seam — timeout/abort ownership, per-transport
 * happy path, fence-strip (G2), and redacted error normalization.
 *
 * Deterministic seam (Tier 1). The whole point of collapsing the three former
 * per-provider call functions into one `callReviewer` was ONE abort-correct
 * timeout path: a regression here re-introduces the background hang (a call that
 * never rejects) or the socket leak. We shrink the per-attempt timeout via
 * GEMINI_REVIEW_TIMEOUT_MS (read at config import) so the timeout case is fast.
 *
 * Env is set BEFORE the dynamic import so the frozen config picks it up.
 */
process.env.GEMINI_REVIEW_TIMEOUT_MS = '150';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { _internals } = await import('../scripts/gemini-review.mjs');
const { callReviewer } = _internals;

const BASE = { model: 'm', systemPrompt: 'sys', userPrompt: 'usr', passName: 'unit' };

describe('callReviewer — timeout & abort ownership', () => {
  test('rejects at the per-attempt timeout AND aborts the signal (reason=timeout)', async () => {
    let capturedSignal = null;
    const hangingClient = {
      chat: { completions: { create: (_body, opts) => {
        capturedSignal = opts?.signal ?? null;
        return new Promise(() => { /* never settles */ });
      } } },
    };
    await assert.rejects(
      callReviewer(hangingClient, { ...BASE, transportKind: 'openai' }),
      /Timeout after/,
    );
    assert.ok(capturedSignal, 'adapter received an AbortSignal');
    assert.equal(capturedSignal.aborted, true, 'signal was aborted (socket teardown)');
    assert.equal(capturedSignal.reason, 'timeout', 'self-abort is distinguishable from a provider abort');
  });
});

describe('callReviewer — per-transport happy path (normalized result + usage)', () => {
  test('openai transport parses a ```json-fenced body (G2) and maps usage', async () => {
    const client = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: '```json\n{"verdict":"APPROVE"}\n```' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      }) } },
    };
    const { result, usage } = await callReviewer(client, { ...BASE, transportKind: 'openai' });
    assert.equal(result.verdict, 'APPROVE');           // fence was stripped
    assert.equal(usage.input_tokens, 7);
    assert.equal(usage.output_tokens, 2);
  });

  test('an OUTER ```json fence whose findings contain INNER ``` code fences parses in full (Gemini-gate G1)', async () => {
    // The regression: a lazy fence regex stops at the first inner closing fence
    // and truncates a review whose recommendation carries a code block.
    const inner = 'Use `const x = 1;` — see ```js\nconst y = 2;\n``` for the pattern.';
    const body = '```json\n' + JSON.stringify({ verdict: 'CONCERNS', recommendation: inner }) + '\n```';
    const client = { chat: { completions: { create: async () => ({
      choices: [{ message: { content: body }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }) } } };
    const { result } = await callReviewer(client, { ...BASE, transportKind: 'openai' });
    assert.equal(result.verdict, 'CONCERNS');
    assert.equal(result.recommendation, inner, 'inner ``` fences did not truncate the payload');
  });

  test('anthropic transport (non-iterable final message) maps usage; cache tokens are NOT thinking tokens', async () => {
    const client = {
      messages: { create: async () => ({
        content: [{ type: 'text', text: '{"verdict":"CONCERNS"}' }],
        usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 1 },
      }) },
    };
    const { result, usage } = await callReviewer(client, { ...BASE, transportKind: 'anthropic' });
    assert.equal(result.verdict, 'CONCERNS');
    assert.equal(usage.input_tokens, 5);
    assert.equal(usage.output_tokens, 3);
    assert.equal(usage.thinking_tokens, 0, 'cache_creation_input_tokens must NOT be conflated with thinking tokens');
  });

  test('gemini transport accumulates a stream and maps usageMetadata', async () => {
    const client = {
      models: { generateContentStream: async () => (async function* () {
        yield { text: '{"verdict":"REJECT"}', usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 2 } };
      })() },
    };
    const { result, usage } = await callReviewer(client, { ...BASE, transportKind: 'gemini' });
    assert.equal(result.verdict, 'REJECT');
    assert.equal(usage.input_tokens, 9);
    assert.equal(usage.thinking_tokens, 2);
    // BILLED output = candidates + thoughts. Google excludes thoughts from
    // candidatesTokenCount but bills them at the output rate, so reading
    // candidates alone understated this reviewer ~2.5x on real runs — which is
    // the arm it is compared against on cost.
    assert.equal(usage.output_tokens, 6, 'thoughts are billed output and must be counted');
  });

  test('gemini output_tokens stays a SINGLE total — thinking is a share of it, not an addend', async () => {
    // The invariant that keeps the shared cost oracle correct across providers:
    // Anthropic and OpenAI already fold reasoning into output_tokens, so any
    // consumer adding thinking_tokens on top would double-count everywhere.
    const client = {
      models: { generateContentStream: async () => (async function* () {
        yield { text: '{"verdict":"APPROVE"}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 310, thoughtsTokenCount: 17792 } };
      })() },
    };
    const { usage } = await callReviewer(client, { ...BASE, transportKind: 'gemini' });
    assert.equal(usage.output_tokens, 18102);
    assert.ok(usage.thinking_tokens < usage.output_tokens, 'thinking is contained in output, never beside it');
  });
});

describe('callReviewer — error normalization', () => {
  test('surfaces provider status + message, preserves err.status', async () => {
    const client = {
      chat: { completions: { create: async () => { throw Object.assign(new Error('model not found'), { status: 404 }); } } },
    };
    await assert.rejects(
      callReviewer(client, { ...BASE, transportKind: 'openai' }),
      (err) => {
        assert.match(err.message, /HTTP 404/);
        assert.match(err.message, /model not found/);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  test('unknown transport kind throws before any network attempt', async () => {
    await assert.rejects(
      callReviewer({}, { ...BASE, transportKind: 'nope' }),
      /unknown transport kind "nope"/,
    );
  });
});

const { GeminiFinalReviewSchema } = await import('../scripts/lib/final-review/output-schemas.mjs');
const VALID = {
  verdict: 'APPROVE',
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'ok' },
  new_findings: [], wrongly_dismissed: [], over_engineering_flags: [],
  architectural_coherence: 'Strong', overall_reasoning: 'ok',
};
const openaiReply = (content, finishReason) => ({ chat: { completions: { create: async () => ({
  choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 11, completion_tokens: 22 },
}) } } });

describe('callReviewer — a cut-off or structurally invalid response is a FAILED review, never a short one', () => {
  test('openai finish_reason "length" rejects even though the surviving JSON parses', async () => {
    const err = await callReviewer(openaiReply(JSON.stringify(VALID), 'length'), { ...BASE, transportKind: 'openai' })
      .then(() => null, (e) => e);
    assert.ok(err, 'a truncated review must not resolve');
    assert.match(err.message, /truncated at the output-token ceiling \(finish reason: length\)/);
    assert.equal(err.truncated, true, 'structured flag survives the wrap, so the retry keys on it, not prose');
    assert.equal(err.usage?.input_tokens, 11, 'the cut-off response was billed');
  });

  test('anthropic stop_reason "max_tokens" rejects', async () => {
    const client = { messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify(VALID) }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 },
    }) } };
    await assert.rejects(callReviewer(client, { ...BASE, transportKind: 'anthropic' }), /finish reason: max_tokens/);
  });

  test('gemini finishReason "MAX_TOKENS" is READ from the stream and rejects', async () => {
    const client = { models: { generateContentStream: async () => (async function* () {
      yield { text: JSON.stringify(VALID), candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    })() } };
    await assert.rejects(callReviewer(client, { ...BASE, transportKind: 'gemini' }), /finish reason: MAX_TOKENS/);
  });

  test('NEGATIVE CONTROL: a normal stop with a schema-valid body resolves', async () => {
    const { result } = await callReviewer(openaiReply(JSON.stringify(VALID), 'stop'), { ...BASE, transportKind: 'openai', zodSchema: GeminiFinalReviewSchema });
    assert.equal(result.verdict, 'APPROVE');
  });

  test('a verdict-only object fails schema validation instead of returning as a clean gate', async () => {
    const err = await callReviewer(openaiReply('{"verdict":"APPROVE"}', 'stop'), { ...BASE, transportKind: 'openai', zodSchema: GeminiFinalReviewSchema })
      .then(() => null, (e) => e);
    assert.ok(err, '{verdict:"APPROVE"} alone is not a review');
    assert.match(err.message, /failed schema validation/);
    assert.match(err.message, /deliberation_quality/, 'names the missing structure');
    assert.equal(err.usage?.output_tokens, 22, 'billed usage rides out on the failure');
  });

  test('an OVER-LIMIT-only violation is kept (Gemini strips maxItems) — the direction that must not fire', async () => {
    const eleven = { ...VALID, over_engineering_flags: Array.from({ length: 11 }, (_, i) => `flag ${i}`) };
    const { result } = await callReviewer(openaiReply(JSON.stringify(eleven), 'stop'), { ...BASE, transportKind: 'openai', zodSchema: GeminiFinalReviewSchema });
    assert.equal(result.over_engineering_flags.length, 11);
  });
});

describe('callReviewer — cancellation reaches the Gemini SDK, and an abort stays classifiable', () => {
  test('gemini passes the AbortSignal as config.abortSignal in its ONE argument (a 2nd arg is dropped by the SDK)', async () => {
    let args = null;
    const client = { models: { generateContentStream: async (...a) => {
      args = a;
      return (async function* () { yield { text: '{"verdict":"APPROVE"}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }; })();
    } } };
    await callReviewer(client, { ...BASE, transportKind: 'gemini' });
    assert.equal(args.length, 1, '@google/genai generateContentStream takes exactly one parameter object');
    assert.ok(args[0].config?.abortSignal instanceof AbortSignal, 'cancellation must ride in config.abortSignal');
  });

  test('a provider AbortError is wrapped with the structured timeout classification (behavioural, not a source pin)', async () => {
    const client = { chat: { completions: { create: async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    } } } };
    const err = await callReviewer(client, { ...BASE, transportKind: 'openai' }).then(() => null, (e) => e);
    assert.equal(err.llmCategory, 'timeout');
    assert.equal(err.llmRetryable, true);
  });
});
