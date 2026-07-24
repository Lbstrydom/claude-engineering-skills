/**
 * @fileoverview Tier-1 tests for `scripts/lib/audit/tiered-provider-calls.mjs`
 * — the discovery-generator factories and the Stage-1 triager adapters,
 * extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md
 * Phase 1). Each factory takes explicit dependencies (never closes over
 * orchestrator scope), so a fake `providers` object is sufficient — no
 * `runTieredAuditPipeline` invocation required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGlmDiscoveryCall, createSonnetDiscoveryCall, wrapWithUsageMetering,
  defaultTriagerCall, validatedTriagerCall,
} from '../scripts/lib/audit/tiered-provider-calls.mjs';

// `clampToJsonSchemaLimits` is a no-op when its schema arg is not an object
// (schemas.mjs: `if (jsonSchema == null || typeof jsonSchema !== 'object') return value;`),
// so `unclampedQuoteSchema: null` is a safe stand-in — these factories never
// inspect the contract's schema shape themselves, only pass it through.
const fakeContract = {
  anchorContract: 'FAKE ANCHOR CONTRACT',
  glmLenientSchema: {},
  glmResponseValidationSchema: {},
  unclampedQuoteSchema: null,
  sonnetFindingsTool: { name: 'report_findings' },
};

describe('createGlmDiscoveryCall', () => {
  it('success path: returns findings and records usage', async () => {
    const recorded = [];
    const call = createGlmDiscoveryCall({
      providers: { ossCall: async () => ({ result: { findings: [{ id: 'f1' }] }, usage: { input_tokens: 10, output_tokens: 5, latency_ms: 3 }, category: null, error: null }) },
      model: 'glm-test',
      contract: fakeContract,
      discoveryPlan: 'plan text',
      discoveryCode: 'code text',
      recordUsage: (e) => recorded.push(e),
    });
    const findings = await call();
    assert.deepEqual(findings, [{ id: 'f1' }]);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].provider, 'oss');
    assert.equal(recorded[0].modelSentinel, 'glm-test');
    assert.equal(recorded[0].resolvedModel, 'glm-test');
    assert.equal(recorded[0].wallClockMs, 3);
  });

  it('recordUsage call shape: provider_cost_usd passthrough branch fires only when the provider reports it', async () => {
    const recorded = [];
    const call = createGlmDiscoveryCall({
      providers: { ossCall: async () => ({ result: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1, provider_cost_usd: 0.0042 }, category: null, error: null }) },
      model: 'glm-test', contract: fakeContract, discoveryPlan: '', discoveryCode: '',
      recordUsage: (e) => recorded.push(e),
    });
    await call();
    assert.equal(recorded[0].selfReportedCostUsd, 0.0042);
  });

  it('recordUsage call shape: no provider_cost_usd field at all when the provider does not report one', async () => {
    const recorded = [];
    const call = createGlmDiscoveryCall({
      providers: { ossCall: async () => ({ result: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, category: null, error: null }) },
      model: 'glm-test', contract: fakeContract, discoveryPlan: '', discoveryCode: '',
      recordUsage: (e) => recorded.push(e),
    });
    await call();
    assert.equal('selfReportedCostUsd' in recorded[0], false);
  });

  it('missing/malformed result.findings array throws, preserving err.category', async () => {
    const call = createGlmDiscoveryCall({
      providers: { ossCall: async () => ({ result: null, usage: {}, category: 'bad_shape', error: 'boom' }) },
      model: 'glm-test', contract: fakeContract, discoveryPlan: '', discoveryCode: '',
      recordUsage: () => {},
    });
    await assert.rejects(call(), (err) => {
      assert.match(err.message, /did not return a result\.findings array/);
      assert.match(err.message, /boom/);
      assert.equal(err.category, 'bad_shape');
      return true;
    });
  });

  it('result.findings not an array throws the same contract error', async () => {
    const call = createGlmDiscoveryCall({
      providers: { ossCall: async () => ({ result: { findings: 'nope' }, usage: {}, category: null, error: null }) },
      model: 'glm-test', contract: fakeContract, discoveryPlan: '', discoveryCode: '',
      recordUsage: () => {},
    });
    await assert.rejects(call(), /did not return a result\.findings array/);
  });

  it('no providers.ossCall at all → returns a call that throws "unavailable"', async () => {
    const call = createGlmDiscoveryCall({ providers: {}, model: 'x', contract: fakeContract, discoveryPlan: '', discoveryCode: '', recordUsage: () => {} });
    await assert.rejects(call(), /providers\.ossCall unavailable/);
  });
});

describe('createSonnetDiscoveryCall', () => {
  it('success path: returns findings and records usage', async () => {
    const recorded = [];
    const call = createSonnetDiscoveryCall({
      providers: {
        anthropicClient: {
          messages: {
            create: async () => ({
              content: [{ type: 'tool_use', name: 'report_findings', input: { findings: [{ id: 'f2' }] } }],
              usage: { input_tokens: 20, output_tokens: 8 },
              stop_reason: 'tool_use',
            }),
          },
        },
      },
      ctx: {},
      contract: fakeContract,
      discoveryPlan: 'plan text',
      discoveryCode: 'code text',
      recordUsage: (e) => recorded.push(e),
    });
    const findings = await call();
    assert.deepEqual(findings, [{ id: 'f2' }]);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].provider, 'anthropic');
    assert.equal(recorded[0].modelSentinel, 'latest-sonnet');
  });

  it('missing/malformed report_findings tool_use throws, naming stop_reason', async () => {
    const call = createSonnetDiscoveryCall({
      providers: { anthropicClient: { messages: { create: async () => ({ content: [], stop_reason: 'max_tokens' }) } } },
      ctx: {}, contract: fakeContract, discoveryPlan: '', discoveryCode: '', recordUsage: () => {},
    });
    await assert.rejects(call(), /stop_reason: max_tokens/);
  });

  it('a tool_use whose input.findings is not an array throws the same contract error', async () => {
    const call = createSonnetDiscoveryCall({
      providers: { anthropicClient: { messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'report_findings', input: { findings: 'nope' } }], stop_reason: 'tool_use' }) } } },
      ctx: {}, contract: fakeContract, discoveryPlan: '', discoveryCode: '', recordUsage: () => {},
    });
    await assert.rejects(call(), /report_findings tool call with a findings array/);
  });

  it('no providers.anthropicClient → throws naming the readiness state when present', async () => {
    const call = createSonnetDiscoveryCall({
      providers: {},
      ctx: { providers: { anthropicReadiness: { state: 'degraded', message: 'no key configured' } } },
      contract: fakeContract, discoveryPlan: '', discoveryCode: '', recordUsage: () => {},
    });
    await assert.rejects(call(), /degraded: no key configured/);
  });

  it('no providers.anthropicClient and no readiness record → "unavailable (no readiness record)"', async () => {
    const call = createSonnetDiscoveryCall({
      providers: {}, ctx: {}, contract: fakeContract, discoveryPlan: '', discoveryCode: '', recordUsage: () => {},
    });
    await assert.rejects(call(), /unavailable \(no readiness record\)/);
  });
});

describe('wrapWithUsageMetering', () => {
  it('meters when _usage is present, folding thinking_tokens into output_tokens', async () => {
    const recorded = [];
    const wrapped = wrapWithUsageMetering(
      async () => ({ verdict: 'confirmed', _usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 20 }, _model: 'gemini-pro' }),
      (e) => recorded.push(e),
    );
    const result = await wrapped('arg');
    assert.equal(result.verdict, 'confirmed', 'the rest of the result must pass through unchanged');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].provider, 'gemini');
    assert.equal(recorded[0].usage.output_tokens, 70, 'thinking_tokens must be folded into output_tokens');
  });

  it('derives provider from the model id, not a hardcoded "gemini" (Opus/Azure-Claude fallback case)', async () => {
    const recorded = [];
    const wrapped = wrapWithUsageMetering(
      async () => ({ verdict: 'confirmed', _usage: { input_tokens: 1, output_tokens: 1 }, _model: 'claude-opus-4-8' }),
      (e) => recorded.push(e),
    );
    await wrapped('arg');
    assert.equal(recorded[0].provider, 'anthropic');
  });

  it('no _usage → does not call recordUsage at all', async () => {
    const recorded = [];
    const wrapped = wrapWithUsageMetering(async () => ({ verdict: 'clean' }), (e) => recorded.push(e));
    const result = await wrapped('arg');
    assert.equal(result.verdict, 'clean');
    assert.equal(recorded.length, 0);
  });
});

describe('defaultTriagerCall / validatedTriagerCall — moved verbatim, contract unchanged', () => {
  it('defaultTriagerCall requires providers.openai', async () => {
    await assert.rejects(defaultTriagerCall({}, {}), /providers\.openai is required/);
  });

  it('validatedTriagerCall requires providers.ossCall', async () => {
    await assert.rejects(validatedTriagerCall({}, {}, 'model'), /providers\.ossCall is required/);
  });

  it('validatedTriagerCall throws (never fabricates a dismissal) when ossCall returns no result, preserving category', async () => {
    await assert.rejects(
      validatedTriagerCall({ category: 'c', detail: 'd' }, { ossCall: async () => ({ result: null, category: 'timeout', error: 'no response', usage: {} }) }, 'model'),
      (err) => {
        assert.match(err.message, /ossCall failed/);
        assert.match(err.message, /no response/);
        assert.equal(err.category, 'timeout');
        return true;
      },
    );
  });

  it('validatedTriagerCall returns {result, usage} on success', async () => {
    const { result, usage } = await validatedTriagerCall(
      { category: 'c', detail: 'd' },
      { ossCall: async () => ({ result: { dismissalAttempted: true, disproof: 'x' }, category: null, error: null, usage: { input_tokens: 1, output_tokens: 1 } }) },
      'model',
    );
    assert.deepEqual(result, { dismissalAttempted: true, disproof: 'x' });
    assert.deepEqual(usage, { input_tokens: 1, output_tokens: 1 });
  });
});
