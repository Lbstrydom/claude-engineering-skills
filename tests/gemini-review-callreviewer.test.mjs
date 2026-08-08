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
