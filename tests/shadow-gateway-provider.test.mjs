/**
 * @fileoverview Contract tests for an OpenAI-compatible GATEWAY as the shadow
 * final reviewer (`FINAL_REVIEW_SHADOW=openrouter`).
 *
 * Cluster B of docs/plans/final-review-credit-and-cheap-shadow.md. The shadow
 * path previously admitted only claude/gemini, so a cheap gateway model could be
 * the PRIMARY reviewer (zero code — the `openrouter` descriptor already carries
 * the routing pins) but never the shadow.
 *
 * Two properties carry most of the weight here:
 *
 *  - **The routing pins reach the wire.** One OpenRouter model id is served by
 *    many backends with incompatible context limits, chosen per request, and
 *    reasoning tokens count against `max_tokens`. Unpinned, a shadow run measures
 *    the ROUTER, not the model — the exact failure experiment-4 already recorded.
 *    The pins are inherited rather than re-plumbed (the shadow path shares
 *    `runFinalReview`, which resolves `PROVIDERS[canonical].requestExtras()`), so
 *    the test pins the INHERITANCE: it fails if a future refactor of that lookup
 *    silently drops them.
 *  - **Azure precedence holds before any credential is touched.** A gateway
 *    shadow must be a no-op under an active Azure profile, and must not construct
 *    a client or issue a request to discover that.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { _internals } from '../scripts/gemini-review.mjs';

import { finalReviewConfig } from '../scripts/lib/config.mjs';

const { resolveShadow, GEMINI_THINKING_BUDGET_BY_EFFORT } = _internals;
const KIMI = 'moonshotai/kimi-k2-thinking';
const shadow = (cfg, env = {}, azureActive = false) =>
  resolveShadow({ shadowConfig: cfg, env, azureActive });

describe('gateway shadow — resolution states', () => {
  it('is ready with an explicit model and the review-scoped key', () => {
    const r = shadow({ provider: 'openrouter', model: KIMI }, { FINAL_REVIEW_API_KEY: 'k' });
    assert.equal(r.state, 'ready');
    assert.equal(r.provider, 'openrouter', 'canonical must match the PROVIDERS key — that is what inherits the pins');
    assert.equal(r.model, KIMI);
  });

  it('accepts the shared OPENROUTER_API_KEY as a fallback credential', () => {
    const r = shadow({ provider: 'openrouter', model: KIMI }, { OPENROUTER_API_KEY: 'k' });
    assert.equal(r.state, 'ready');
  });

  it('refuses without a credential from EITHER source', () => {
    assert.equal(shadow({ provider: 'openrouter', model: KIMI }, {}).state, 'skipped-no-key');
  });

  it('refuses without an explicit model rather than guessing one', () => {
    // A gateway passes ids verbatim, so there is no sentinel to derive from —
    // inventing a default would spend the operator's money on a model they never
    // named.
    const r = shadow({ provider: 'openrouter', model: null }, { OPENROUTER_API_KEY: 'k' });
    assert.equal(r.state, 'skipped-no-model');
    assert.equal(r.model, null);
  });

  it('passes the gateway model id through VERBATIM — no sentinel rewrite (D6)', () => {
    // resolveModel would mangle a slashed vendor id; the raw string must survive.
    assert.equal(shadow({ provider: 'openrouter', model: KIMI }, { OPENROUTER_API_KEY: 'k' }).model, KIMI);
    const other = 'z-ai/glm-5.2';
    assert.equal(shadow({ provider: 'openrouter', model: other }, { OPENROUTER_API_KEY: 'k' }).model, other);
  });

  it('never lets a credential value escape into the resolver result', () => {
    const secret = 'sk-or-v1-DEADBEEFDEADBEEF';
    const r = shadow({ provider: 'openrouter', model: KIMI }, { OPENROUTER_API_KEY: secret });
    assert.doesNotMatch(JSON.stringify(r), /DEADBEEF/, 'hasCredential must return a boolean, never the key');
  });
});

describe('gateway shadow — Azure precedence (guard order is load-bearing)', () => {
  it('is a no-op under an active Azure profile even when fully configured', () => {
    const r = shadow({ provider: 'openrouter', model: KIMI }, { OPENROUTER_API_KEY: 'k', FINAL_REVIEW_API_KEY: 'k2' }, true);
    assert.equal(r.state, 'skipped-azure');
    assert.equal(r.model, null, 'no model is resolved on the Azure path');
  });

  it('the Azure guard precedes the credential check — an unconfigured gateway still reports azure', () => {
    // Order matters: reporting `skipped-no-key` under Azure would send an
    // operator hunting for a credential that the profile makes irrelevant.
    assert.equal(shadow({ provider: 'openrouter', model: KIMI }, {}, true).state, 'skipped-azure');
  });
});

describe('gateway shadow — the existing providers are untouched', () => {
  it('claude-opus and anthropic still resolve from their own default sentinel', () => {
    for (const p of ['claude-opus', 'anthropic']) {
      const r = shadow({ provider: p, model: null }, { ANTHROPIC_API_KEY: 'k' });
      assert.equal(r.state, 'ready', `${p} must be unaffected`);
      assert.match(String(r.model), /claude|opus|mythos|fable/i);
      assert.equal(r.provider, 'claude-opus');
    }
  });

  it('gemini still resolves from its own default sentinel', () => {
    const r = shadow({ provider: 'gemini', model: null }, { GEMINI_API_KEY: 'k' });
    assert.equal(r.state, 'ready');
    assert.match(String(r.model), /gemini/i);
  });

  it('a family mismatch on a NON-gateway provider is still rejected', () => {
    const r = shadow({ provider: 'gemini', model: 'latest-opus' }, { GEMINI_API_KEY: 'k' });
    assert.equal(r.state, 'skipped-unsupported-provider');
  });

  it('an unknown provider is still an explicit skip, not a throw', () => {
    assert.equal(shadow({ provider: 'llama-farm', model: 'x' }, {}).state, 'skipped-unsupported-provider');
  });

  it('unset stays byte-identical: the path is not entered at all', () => {
    const r = shadow({ provider: null, model: null }, {});
    assert.equal(r.state, 'skipped-unset');
    assert.equal(r.provider, null);
  });
});

describe('gateway shadow — the OpenRouter routing pins are inherited, not re-plumbed', () => {
  it('the canonical provider name matches a PROVIDERS descriptor that supplies the pins', async () => {
    // This is the whole mechanism: runFinalReview does
    // `PROVIDERS[provider].requestExtras?.()`, and the shadow supplies its
    // CANONICAL name. If that name stopped matching, the shadow would silently
    // run unpinned and measure OpenRouter's router instead of the model.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../scripts/gemini-review.mjs', import.meta.url), 'utf-8'));

    const canonical = shadow({ provider: 'openrouter', model: KIMI }, { OPENROUTER_API_KEY: 'k' }).provider;
    assert.equal(canonical, 'openrouter');

    // The descriptor keyed by that canonical name must still declare both pins.
    const descriptor = src.slice(src.indexOf('  openrouter: {'));
    const body = descriptor.slice(0, descriptor.indexOf('\n  },'));
    assert.match(body, /require_parameters:\s*true/, 'require_parameters pin missing from the inherited descriptor');
    assert.match(body, /sort:\s*'[a-z]+'/, 'provider sort pin missing from the inherited descriptor');
    assert.match(body, /reasoning:\s*\{\s*effort:/, 'reasoning-effort pin missing — reasoning tokens count against max_tokens');
    assert.match(body, /structuredOutput:\s*true/, 'the shadow needs the JSON schema, not prose');
  });
});

describe('reasoning-effort dial (apples-to-apples arms)', () => {
  it('defaults to `high` — the depth Gemini and Opus already ran at', () => {
    assert.equal(['low', 'medium', 'high'].includes(finalReviewConfig.reasoningEffort), true);
  });

  it('the Gemini effort→budget map pins `high` to 16384, the value that arm always used', () => {
    // Load-bearing: adopting the shared dial must leave the PRIMARY reviewer
    // byte-identical, so the only arm that moves is the one that was mis-set.
    assert.equal(GEMINI_THINKING_BUDGET_BY_EFFORT.high, 16384);
    assert.ok(GEMINI_THINKING_BUDGET_BY_EFFORT.low < GEMINI_THINKING_BUDGET_BY_EFFORT.medium);
    assert.ok(GEMINI_THINKING_BUDGET_BY_EFFORT.medium < GEMINI_THINKING_BUDGET_BY_EFFORT.high);
  });

  it('every effort level the config accepts has a Gemini budget — no undefined budget can reach the API', () => {
    for (const level of ['low', 'medium', 'high']) {
      assert.equal(typeof GEMINI_THINKING_BUDGET_BY_EFFORT[level], 'number', `no budget for ${level}`);
    }
  });
});

describe('Anthropic reviewer transports pin the sdk backend', () => {
  // Both Anthropic paths need a transport that supports tools/tool_choice AND
  // can carry a ~50K-token prompt. The `cli` backend does neither: it silently
  // drops tools (so provider-side schema enforcement vanishes) and passes the
  // prompt as a process argument, which overflows the Windows command line.
  // The shadow path was pinned 2026-07-26; the PRIMARY path was missed until
  // 2026-08-03 because it is only reached when GEMINI_API_KEY is absent —
  // meaning the final gate's own fallback reviewer was dead on any machine
  // running CLAUDE_BACKEND=cli. A source assertion, because reproducing it
  // needs a real CLI spawn and a 50K-token payload.
  const SRC = readFileSync(new URL('../scripts/gemini-review.mjs', import.meta.url), 'utf-8');

  it('the shadow builder pins backend sdk', () => {
    const fn = SRC.slice(SRC.indexOf('async function buildShadowClient'));
    assert.match(fn.slice(0, fn.indexOf('\n}\n')), /createAnthropicClient\(\{\s*backend:\s*'sdk'\s*\}\)/);
  });

  it('the PRIMARY claude-opus provider pins backend sdk — never the ambient env', () => {
    const block = SRC.slice(SRC.indexOf("'claude-opus': {"));
    const body = block.slice(0, block.indexOf("'azure-claude': {"));
    assert.match(body, /createAnthropicClient\(\{\s*backend:\s*'sdk'\s*\}\)/);
    assert.doesNotMatch(body, /createAnthropicClient\(\s*\)/, 'ambient-backend construction reintroduced');
  });
});
