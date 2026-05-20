/**
 * @fileoverview Phase 1 semantic-compare tests.
 *
 * Covers:
 *   - CROSS_STREAM_VIOLATION for non-prose fieldType
 *   - Pre-egress redaction is invoked before the LLM call
 *   - llmMaxChars truncation + truncated-reason flag
 *   - Cache hit returns zero-latency / zero-usage envelope
 *   - Cache miss persists the verdict and returns provider envelope
 *   - Parse failure → deterministic fallback verdict
 *   - Egress log receives the redaction count
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compare, createInMemoryCache, _internals }
  from '../scripts/lib/persona-test/semantic-compare.mjs';

describe('compare — cross-stream invariant', () => {
  it('throws CROSS_STREAM_VIOLATION for fieldType="boolean"', async () => {
    await assert.rejects(
      compare('true', 'false', 'boolean'),
      /CROSS_STREAM_VIOLATION/,
    );
  });
  it('throws for any non-prose type (integer/enum/id/count/freshness)', async () => {
    for (const t of ['integer', 'enum', 'id', 'count', 'freshness']) {
      await assert.rejects(compare('a', 'b', t), /CROSS_STREAM_VIOLATION/);
    }
  });
  it('accepts fieldType="prose"', async () => {
    const r = await compare('hello', 'hi there', 'prose');
    // No comparator wired → uncertain with explicit reason.
    assert.equal(r.result.matched, 'uncertain');
    assert.equal(r.result.reason, 'comparator-not-configured');
  });
});

describe('compare — pre-egress redaction (Gemini-R5-G1 / Boundary 1)', () => {
  it('runs both inputs through redact() before any LLM call', async () => {
    let seen;
    const fakeLLM = async (_provider, _sys, userPrompt) => {
      seen = userPrompt;
      return { result: { matched: 'yes' }, usage: {}, latencyMs: 1 };
    };
    const fakeProvider = {};
    const synthSecret = 'sk-' + 'A'.repeat(25);
    const r = await compare(`token=${synthSecret}`, 'plain', 'prose', {
      callLLM: fakeLLM,
      provider: fakeProvider,
    });
    assert.ok(seen, 'callLLM should be invoked');
    assert.equal(seen.includes(synthSecret), false, 'raw secret must not appear in prompt');
    assert.match(seen, /\[REDACTED:openai-key\]/);
    assert.equal(r.result.matched, 'yes');
  });
});

describe('compare — truncation (Gemini-R5-G1)', () => {
  it('truncates inputs to maxChars and tags verdict with prose-truncated-for-llm', async () => {
    const fakeLLM = async () => ({ result: { matched: 'yes' }, usage: {}, latencyMs: 1 });
    const longA = 'A'.repeat(5000);
    const longB = 'B'.repeat(5000);
    const r = await compare(longA, longB, 'prose', {
      callLLM: fakeLLM, provider: {}, maxChars: 1000,
    });
    assert.equal(r.result.matched, 'yes');
    assert.equal(r.result.reason, 'prose-truncated-for-llm');
  });
});

describe('compare — cache', () => {
  it('cache hit returns zero-cost zero-latency envelope', async () => {
    const cache = createInMemoryCache();
    const fakeLLM = async () => ({ result: { matched: 'no' }, usage: {}, latencyMs: 100 });
    const opts = { callLLM: fakeLLM, provider: {}, cache };
    const first = await compare('A', 'B', 'prose', opts);
    assert.equal(first.result.matched, 'no');
    const second = await compare('A', 'B', 'prose', opts);
    assert.equal(second.result.matched, 'no');
    assert.equal(second.latencyMs, 0, 'cache hit should report 0 latency');
    assert.equal(second.usage.cache_hit, 1);
  });

  it('different inputs produce different cache keys', async () => {
    const cache = createInMemoryCache();
    let calls = 0;
    const fakeLLM = async () => { calls++; return { result: { matched: 'yes' }, usage: {}, latencyMs: 1 }; };
    const opts = { callLLM: fakeLLM, provider: {}, cache };
    await compare('A', 'B', 'prose', opts);
    await compare('X', 'Y', 'prose', opts);
    assert.equal(calls, 2);
  });
});

describe('compare — parse failure fallback', () => {
  it('returns the deterministic FALLBACK_VERDICT when the wrapper returns null', async () => {
    const r = await compare('a', 'b', 'prose', {
      callLLM: async () => null,
      provider: {},
    });
    assert.equal(r.result.matched, 'uncertain');
    assert.equal(r.result.reason, 'provider-parse-failed');
  });

  it('returns fallback when wrapper returns malformed result', async () => {
    const r = await compare('a', 'b', 'prose', {
      callLLM: async () => ({ result: { not_a_verdict: true }, usage: {}, latencyMs: 1 }),
      provider: {},
    });
    assert.equal(r.result.matched, 'uncertain');
    assert.equal(r.result.reason, 'provider-parse-failed');
  });
});

describe('compare — egress log', () => {
  it('emits a log record with redaction count and truncation flag', async () => {
    let logged;
    const fakeLLM = async () => ({ result: { matched: 'yes' }, usage: {}, latencyMs: 1 });
    const synthSecret = 'AKIA' + 'X'.repeat(16);
    await compare(`AWS_KEY=${synthSecret}`, 'plain', 'prose', {
      callLLM: fakeLLM,
      provider: {},
      surfaceId: 'status-chip',
      logEgress: (rec) => { logged = rec; },
    });
    assert.ok(logged);
    assert.equal(logged.surfaceId, 'status-chip');
    assert.ok(logged.redactionCount >= 1);
    assert.equal(typeof logged.timestamp, 'string');
    assert.equal(logged.truncated, false);
  });

  it('an egress-log throw does not break the compare path', async () => {
    const fakeLLM = async () => ({ result: { matched: 'yes' }, usage: {}, latencyMs: 1 });
    const r = await compare('a', 'b', 'prose', {
      callLLM: fakeLLM,
      provider: {},
      logEgress: () => { throw new Error('boom'); },
    });
    assert.equal(r.result.matched, 'yes');
  });
});

describe('compare — internals', () => {
  it('exposes FALLBACK_VERDICT shape', () => {
    assert.equal(_internals.FALLBACK_VERDICT.matched, 'uncertain');
    assert.equal(_internals.FALLBACK_VERDICT.reason, 'provider-parse-failed');
  });
  it('cache key is content-hash + model — same content/model → same key', () => {
    const k1 = _internals.makeCacheKey('A', 'B', 'm');
    const k2 = _internals.makeCacheKey('A', 'B', 'm');
    const k3 = _internals.makeCacheKey('A', 'B', 'other');
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
  });
});
