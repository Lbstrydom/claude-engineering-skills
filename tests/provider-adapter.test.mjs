/**
 * @fileoverview Dial-forwarding coverage for provider-adapter.mjs's three
 * transport branches (auditor-controls-execution-wiring.md, Phase 3). Tests
 * the pure `applyOpenAIDials`/`applyAnthropicDials`/`applyGeminiDials`
 * helpers directly — "assert the emitted request, not the client config"
 * (this repo's own lesson) applied without a real or mocked SDK client,
 * since `invokeOpenAICompatible`/`invokeNativeAnthropic`/`invokeNativeGemini`
 * have no injectable client seam.
 *
 * @module tests/provider-adapter
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _internals } from '../scripts/lib/model-eval/provider-adapter.mjs';

const { applyOpenAIDials, applyAnthropicDials, applyGeminiDials, applyOssProviderPin } = _internals;

describe('applyOpenAIDials', () => {
  it('omitted dials produce today\'s exact request shape — no reasoning/temperature/max_output_tokens keys', () => {
    const body = { model: 'gpt-5.6', input: [] };
    const honored = applyOpenAIDials(body, undefined);
    assert.deepEqual(honored, {});
    assert.deepEqual(Object.keys(body).sort(), ['input', 'model']);
  });

  it('forwards reasoningEffort as a nested reasoning.effort object', () => {
    const body = {};
    const honored = applyOpenAIDials(body, { reasoningEffort: 'high' });
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(honored.reasoningEffort, true);
  });

  it('forwards temperature and maxOutputTokens as flat fields', () => {
    const body = {};
    const honored = applyOpenAIDials(body, { temperature: 0.7, maxOutputTokens: 4000 });
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_output_tokens, 4000);
    assert.deepEqual(honored, { temperature: true, maxOutputTokens: true });
  });
});

describe('applyAnthropicDials', () => {
  it('omitted dials leave the request body untouched (ceiling default is set by the caller, not this function)', () => {
    const body = { model: 'claude-opus', max_tokens: 8000 };
    const honored = applyAnthropicDials(body, undefined);
    assert.deepEqual(honored, {});
    assert.equal(body.max_tokens, 8000, 'unchanged — the default ceiling the caller set before calling this function');
  });

  it('reasoningEffort present is reported false — no native equivalent, never forwarded', () => {
    const body = {};
    const honored = applyAnthropicDials(body, { reasoningEffort: 'high' });
    assert.equal(honored.reasoningEffort, false);
    assert.equal('reasoning' in body, false);
  });

  it('temperature <= 1 is forwarded and honored true', () => {
    const body = {};
    const honored = applyAnthropicDials(body, { temperature: 1 });
    assert.equal(body.temperature, 1);
    assert.equal(honored.temperature, true);
  });

  it('temperature > 1 is NOT forwarded (Anthropic range is [0,1]) and honored false — round-5 H3', () => {
    const body = {};
    const honored = applyAnthropicDials(body, { temperature: 1.5 });
    assert.equal('temperature' in body, false);
    assert.equal(honored.temperature, false);
  });

  it('maxOutputTokens present overrides max_tokens', () => {
    const body = { max_tokens: 8000 };
    const honored = applyAnthropicDials(body, { maxOutputTokens: 2000 });
    assert.equal(body.max_tokens, 2000);
    assert.equal(honored.maxOutputTokens, true);
  });
});

describe('applyGeminiDials', () => {
  it('omitted dials produce today\'s exact config shape', () => {
    const config = { systemInstruction: 'x', responseMimeType: 'application/json' };
    const honored = applyGeminiDials(config, undefined);
    assert.deepEqual(honored, {});
    assert.deepEqual(Object.keys(config).sort(), ['responseMimeType', 'systemInstruction']);
  });

  it('reasoningEffort present is reported false — no native equivalent, never forwarded', () => {
    const config = {};
    const honored = applyGeminiDials(config, { reasoningEffort: 'medium' });
    assert.equal(honored.reasoningEffort, false);
    assert.equal('reasoningEffort' in config, false);
  });

  it('temperature/maxOutputTokens are forwarded as FLAT siblings of systemInstruction — not nested under generationConfig (round-5 H2)', () => {
    const config = { systemInstruction: 'x', responseMimeType: 'application/json' };
    const honored = applyGeminiDials(config, { temperature: 0.3, maxOutputTokens: 3000 });
    assert.equal(config.temperature, 0.3);
    assert.equal(config.maxOutputTokens, 3000);
    assert.equal('generationConfig' in config, false, 'must never wrap dials in a generationConfig object — this SDK usage has no such wrapper');
    assert.deepEqual(honored, { temperature: true, maxOutputTokens: true });
  });
});

describe('applyOssProviderPin — Gemini-gate round-2 H2/M2 fix', () => {
  it('pins require_parameters when route.provider is "oss" AND a dial was honored', () => {
    const body = {};
    applyOssProviderPin(body, { provider: 'oss' }, { reasoningEffort: true });
    assert.deepEqual(body.provider, { require_parameters: true });
  });

  it('does NOT pin when no dial was honored, even on the oss route — byte-identical for a dial-free call', () => {
    const body = {};
    applyOssProviderPin(body, { provider: 'oss' }, {});
    assert.equal('provider' in body, false);
  });

  it('does NOT pin on the public/azure routes, even with dials honored — the pin is OpenRouter-specific', () => {
    const body = {};
    applyOssProviderPin(body, { provider: 'openai' }, { reasoningEffort: true });
    assert.equal('provider' in body, false);
  });

  it('never sets a "sort" preference — deliberately no opinion, never guessed', () => {
    const body = {};
    applyOssProviderPin(body, { provider: 'oss' }, { temperature: true });
    assert.equal('sort' in body.provider, false);
  });
});
