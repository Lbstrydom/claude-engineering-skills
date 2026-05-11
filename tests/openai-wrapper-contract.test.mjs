/**
 * Wrapper-contract tests for the audit LLM call chain.
 * Verifies the layered fail-fast / graceful-degradation policy after PR-2.
 *
 * Uses __testExports gated by AUDIT_EXPORTS_FOR_TESTS=1 to access the
 * module-private wrappers without polluting the production module surface.
 *
 * All tests use a stub OpenAI client; no live API calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';

const audit = await import('../scripts/openai-audit.mjs');
const { LlmError } = await import('../scripts/lib/robustness.mjs');
const { _callGPTOnce, callGPT, safeCallGPT, normalisePromptInput } = audit.__testExports;

const SCHEMA = z.object({ findings: z.array(z.any()).default([]) });

function makeStubOk(usagePatch = {}) {
  return {
    responses: {
      parse: async () => ({
        status: 'completed',
        output: [],
        output_parsed: { findings: [] },
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          prompt_tokens_details: { cached_tokens: 0, ...usagePatch },
          output_tokens_details: { reasoning_tokens: 10 },
        }
      })
    }
  };
}

function makeStubThrow(err) {
  return { responses: { parse: async () => { throw err; } } };
}

const VALID_LEGACY = {
  systemPrompt: 'sys',
  userPrompt: 'usr',
  schema: SCHEMA,
  schemaName: 'test',
  passName: 'test-pass',
  maxRetries: 0,
};

const VALID_STRUCTURED = {
  system: 'sys',
  messages: [{ role: 'user', content: 'usr' }],
  schema: SCHEMA,
  schemaName: 'test',
  passName: 'test-pass',
  maxRetries: 0,
};

describe('normalisePromptInput', () => {
  it('legacy mode produces 2-entry input array', () => {
    const input = normalisePromptInput({ systemPrompt: 'sys', userPrompt: 'usr' });
    assert.deepEqual(input, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('structured mode passes user messages through', () => {
    const input = normalisePromptInput({
      system: 'sys',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    assert.equal(input.length, 3);
    assert.equal(input[0].role, 'system');
    assert.equal(input[1].content, 'a');
    assert.equal(input[2].content, 'b');
  });

  it('hybrid input throws LlmError category=config', () => {
    assert.throws(
      () => normalisePromptInput({ systemPrompt: 'sys', userPrompt: 'usr', system: 'sys2' }),
      (err) => err instanceof LlmError && err.llmCategory === 'config' && err.llmRetryable === false
    );
  });

  it('hybrid input — systemPrompt + messages — throws config error', () => {
    assert.throws(
      () => normalisePromptInput({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'a' }] }),
      (err) => err instanceof LlmError && err.llmCategory === 'config'
    );
  });

  it('structured mode rejects non-array messages', () => {
    assert.throws(
      () => normalisePromptInput({ system: 'sys', messages: 'not-an-array' }),
      (err) => err instanceof LlmError && err.llmCategory === 'config'
    );
  });

  it('structured mode rejects empty messages array', () => {
    assert.throws(
      () => normalisePromptInput({ system: 'sys', messages: [] }),
      (err) => err instanceof LlmError && err.llmCategory === 'config'
    );
  });

  it('structured mode rejects non-user role', () => {
    assert.throws(
      () => normalisePromptInput({ system: 'sys', messages: [{ role: 'system', content: 'x' }] }),
      (err) => err instanceof LlmError && err.llmCategory === 'config'
    );
  });

  it('legacy mode rejects non-string systemPrompt', () => {
    assert.throws(
      () => normalisePromptInput({ systemPrompt: 42, userPrompt: 'usr' }),
      (err) => err instanceof LlmError && err.llmCategory === 'config'
    );
  });
});

describe('_callGPTOnce', () => {
  it('legacy mode: passes through and returns usage with cached_tokens', async () => {
    const stub = makeStubOk({ cached_tokens: 80 });
    const r = await _callGPTOnce(stub, VALID_LEGACY);
    assert.equal(r.result.findings.length, 0);
    assert.equal(r.usage.input_tokens, 100);
    assert.equal(r.usage.cached_tokens, 80);
    assert.equal(r.usage.output_tokens, 50);
    assert.equal(r.usage.reasoning_tokens, 10);
  });

  it('structured mode: passes messages array through to OpenAI', async () => {
    let received;
    const stub = {
      responses: {
        parse: async (params) => {
          received = params;
          return makeStubOk().responses.parse();
        }
      }
    };
    await _callGPTOnce(stub, VALID_STRUCTURED);
    assert.equal(received.input.length, 2);
    assert.equal(received.input[0].role, 'system');
    assert.equal(received.input[1].role, 'user');
  });

  it('hybrid input throws config-category LlmError BEFORE making any call', async () => {
    let called = false;
    const stub = { responses: { parse: async () => { called = true; return makeStubOk().responses.parse(); } } };
    await assert.rejects(
      _callGPTOnce(stub, { ...VALID_LEGACY, system: 'extra', messages: [{ role: 'user', content: 'x' }] }),
      (err) => err instanceof LlmError && err.llmCategory === 'config'
    );
    assert.equal(called, false, 'OpenAI client must not be called on config error');
  });

  it('cached_tokens defaults to 0 when prompt_tokens_details absent', async () => {
    const stub = {
      responses: {
        parse: async () => ({
          status: 'completed',
          output: [],
          output_parsed: { findings: [] },
          usage: { input_tokens: 50, output_tokens: 20 }, // no prompt_tokens_details
        })
      }
    };
    const r = await _callGPTOnce(stub, VALID_LEGACY);
    assert.equal(r.usage.cached_tokens, 0);
  });
});

describe('callGPT — retry aggregation', () => {
  it('successful first call returns clean usage (no retry)', async () => {
    const stub = makeStubOk({ cached_tokens: 70 });
    const r = await callGPT(stub, VALID_LEGACY);
    assert.equal(r.usage.cached_tokens, 70);
    assert.equal(r._retried, undefined);
  });

  it('retried call aggregates cached_tokens from all attempts', async () => {
    let calls = 0;
    const stub = {
      responses: {
        parse: async () => {
          calls += 1;
          if (calls === 1) {
            const err = new LlmError('transient', { category: 'http-503', retryable: true, usage: {
              input_tokens: 100, cached_tokens: 50, output_tokens: 0, reasoning_tokens: 0,
            } });
            throw err;
          }
          return {
            status: 'completed',
            output: [],
            output_parsed: { findings: [] },
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              prompt_tokens_details: { cached_tokens: 80 },
              output_tokens_details: { reasoning_tokens: 10 },
            }
          };
        }
      }
    };
    const r = await callGPT(stub, { ...VALID_LEGACY, maxRetries: 1 });
    assert.equal(r.usage.cached_tokens, 130, '50 from retry + 80 from success');
    assert.equal(r.usage.input_tokens, 200);
    assert.equal(r._retried, true);
  });

  it('404-equivalent (non-retryable 4xx) does NOT retry', async () => {
    let calls = 0;
    const err = new LlmError('not found', { category: 'http-404', retryable: false });
    const stub = { responses: { parse: async () => { calls += 1; throw err; } } };
    await assert.rejects(
      callGPT(stub, { ...VALID_LEGACY, maxRetries: 3 }),
      (e) => e === err
    );
    assert.equal(calls, 1, 'must not retry non-retryable errors');
  });
});

describe('safeCallGPT — fail-fast / graceful policy', () => {
  it('graceful: catches LLM-runtime error and returns failed:true shape with cached_tokens:0', async () => {
    const err = new LlmError('upstream error', { category: 'http-503', retryable: false });
    const stub = makeStubThrow(err);
    const r = await safeCallGPT(stub, { ...VALID_LEGACY, maxRetries: 0 }, { findings: [] });
    assert.equal(r.failed, true);
    assert.equal(r.usage.cached_tokens, 0);
    assert.equal(r.usage.input_tokens, 0);
    assert.deepEqual(r.result, { findings: [] });
  });

  it('FAIL-FAST: re-throws config-category errors (programmer bugs)', async () => {
    const stub = makeStubOk();
    await assert.rejects(
      safeCallGPT(stub, { ...VALID_LEGACY, system: 'hybrid' }, { findings: [] }),
      (err) => err instanceof LlmError && err.llmCategory === 'config'
    );
  });

  it('graceful-degradation shape includes all usage fields (including cached_tokens)', async () => {
    const stub = makeStubThrow(new Error('boom'));
    const r = await safeCallGPT(stub, { ...VALID_LEGACY, maxRetries: 0 }, { findings: [] });
    assert.equal(typeof r.usage.input_tokens, 'number');
    assert.equal(typeof r.usage.cached_tokens, 'number');
    assert.equal(typeof r.usage.output_tokens, 'number');
    assert.equal(typeof r.usage.reasoning_tokens, 'number');
    assert.equal(typeof r.usage.latency_ms, 'number');
  });
});
