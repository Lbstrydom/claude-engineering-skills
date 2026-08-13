/**
 * @fileoverview Provider-agnostic final-review: descriptor catalog + the new
 * openai-compatible / openrouter routes + the G1 no-silent-egress invariant.
 *
 * Deterministic seam (Tier 1). Env is set BEFORE the dynamic import so the frozen
 * finalReviewConfig picks up the review-scoped gateway credentials. We only assert
 * return-value paths — assertReady's missing-config branch calls process.exit and
 * is intentionally not exercised in-process.
 */
process.env.FINAL_REVIEW_MODEL = 'anthropic/claude-opus-4';
process.env.FINAL_REVIEW_API_KEY = 'test-frk';
process.env.FINAL_REVIEW_BASE_URL = 'https://gateway.example/v1';
process.env.OPENROUTER_API_KEY = 'sk-or-test';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { selectProvider, _internals } = await import('../scripts/gemini-review.mjs');
const { PROVIDERS, PING_TRANSPORTS, resolveCompatCreds, resolveOpenRouterCreds } = _internals;

describe('ping covers every provider transport', () => {
  // `ping` is the diagnostic an operator reaches for when the reviewer is
  // failing, so a provider it cannot exercise is a hole exactly where it hurts.
  // It used to branch on GEMINI_API_KEY/ANTHROPIC_API_KEY and ignore --provider
  // entirely, which made it useless on an Azure-only install: neither variable
  // is set there, so it answered "set GEMINI_API_KEY or ANTHROPIC_API_KEY" —
  // advice that is wrong for that install and silent about the route in use.
  for (const [id, descriptor] of Object.entries(PROVIDERS)) {
    test(`provider "${id}" has a ping transport`, () => {
      const kind = descriptor.transportKind();
      assert.ok(
        typeof PING_TRANSPORTS[kind] === 'function',
        `provider "${id}" dispatches on transport "${kind}", which PING_TRANSPORTS does not implement`,
      );
    });
  }
});

describe('PROVIDERS catalog', () => {
  test('every descriptor is internally consistent', () => {
    const REQUIRED = ['id', 'label', 'transportKind', 'resolveModel', 'assertReady', 'buildClient'];
    const KINDS = new Set(['gemini', 'anthropic', 'openai']);
    for (const [id, d] of Object.entries(PROVIDERS)) {
      for (const k of REQUIRED) assert.ok(d[k] != null, `${id}.${k} present`);
      assert.equal(d.id, id, `${id}.id matches key`);
      assert.ok(KINDS.has(d.transportKind()), `${id} transportKind valid`);
    }
  });

  test('the two new gateways use the openai transport', () => {
    assert.equal(PROVIDERS['openai-compatible'].transportKind(), 'openai');
    assert.equal(PROVIDERS.openrouter.transportKind(), 'openai');
  });
});

describe('selectProvider — explicit-only new routes', () => {
  test('explicit "openai-compatible" resolves when base/key/model are set', () => {
    assert.equal(selectProvider('openai-compatible', { env: {}, azureActive: false }), 'openai-compatible');
  });

  test('explicit "openrouter" resolves with model + a key', () => {
    assert.equal(selectProvider('openrouter', { env: {}, azureActive: false }), 'openrouter');
  });

  test('default auto-detect is unchanged (Gemini → Azure → Opus)', () => {
    assert.equal(selectProvider(null, { env: { GEMINI_API_KEY: 'g' }, azureActive: false }), 'gemini');
    assert.equal(selectProvider(null, { env: { ANTHROPIC_API_KEY: 'a' }, azureActive: false }), 'claude-opus');
  });
});

describe('G1 — no silent egress via auto-fallback', () => {
  test('a globally scoped OPENROUTER_API_KEY never auto-selects a gateway route (first-party key present)', () => {
    // Only OPENROUTER_API_KEY + a first-party Anthropic key present. Auto-detect
    // MUST pick the first-party route (claude-opus), never openrouter — a stray
    // shared OpenRouter key must not silently route code egress to a third party.
    assert.equal(
      selectProvider(null, { env: { OPENROUTER_API_KEY: 'sk-or', ANTHROPIC_API_KEY: 'a' }, azureActive: false }),
      'claude-opus',
    );
  });

  test('ONLY OPENROUTER_API_KEY present → hits the no-provider exit, never returns a gateway route', () => {
    // The security-critical case: no first-party credential at all. Auto-detect
    // must NOT fall through to openrouter/openai-compatible on the shared key —
    // it must hit the "no provider available" exit. We stub process.exit so the
    // exit path is observable in-process instead of killing the runner.
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error(`__exit__${code}`); };
    console.error = () => {};
    try {
      assert.throws(
        () => selectProvider(null, { env: { OPENROUTER_API_KEY: 'sk-or' }, azureActive: false }),
        /__exit__1/,
        'must exit(1), never return a gateway route',
      );
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    assert.equal(exitCode, 1, 'no-provider path exits(1) rather than silently egressing to OpenRouter');
  });
});

describe('credential resolution', () => {
  test('resolveCompatCreds returns the review-scoped values', () => {
    const c = resolveCompatCreds();
    assert.equal(c.baseUrl, 'https://gateway.example/v1');
    assert.equal(c.apiKey, 'test-frk');
    assert.equal(c.model, 'anthropic/claude-opus-4');
  });

  test('resolveOpenRouterCreds prefers FINAL_REVIEW_API_KEY over the shared OPENROUTER_API_KEY', () => {
    const c = resolveOpenRouterCreds();
    assert.equal(c.apiKey, 'test-frk');          // review-scoped wins
    assert.equal(c.model, 'anthropic/claude-opus-4');
    assert.ok(c.baseUrl, 'baseUrl resolved (review-scoped or the openrouter default)');
  });
});
