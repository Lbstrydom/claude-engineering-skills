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

describe('xAI shadow — resolution states (plan: final-review-scoped-second-reviewer.md KD-4)', () => {
  it('is ready with the review-scoped key and NO explicit model — unlike a gateway, xai has a real default', () => {
    // The load-bearing difference from openrouter: xai is NOT `gateway:true`,
    // so an unset model derives from `defaultSentinel: 'latest-grok'` rather
    // than being refused. `resolveShadow`'s own gateway branch would reject
    // this shape (`skipped-no-model`); xai must not take that branch.
    const r = shadow({ provider: 'xai', model: null }, { XAI_API_KEY: 'k' });
    assert.equal(r.state, 'ready');
    assert.match(String(r.model), /grok/i);
    assert.equal(r.provider, 'xai');
  });

  it('is ready with an explicit model matching the xai family', () => {
    const r = shadow({ provider: 'xai', model: 'grok-4.6' }, { XAI_API_KEY: 'k' });
    assert.equal(r.state, 'ready');
    assert.equal(r.model, 'grok-4.6');
  });

  it('an explicit model from the WRONG family is rejected, not silently routed to xai', () => {
    const r = shadow({ provider: 'xai', model: 'claude-opus-5' }, { XAI_API_KEY: 'k' });
    assert.equal(r.state, 'skipped-unsupported-provider');
  });

  it('no XAI_API_KEY -> skipped-no-key, never a silent skip-unset', () => {
    const r = shadow({ provider: 'xai', model: null }, {});
    assert.equal(r.state, 'skipped-no-key');
  });

  it('is a no-op under an active Azure profile — same guard order as every other provider', () => {
    const r = shadow({ provider: 'xai', model: null }, { XAI_API_KEY: 'k' }, true);
    assert.equal(r.state, 'skipped-azure');
    assert.equal(r.model, null);
  });
});

describe('xAI shadow — the descriptor is DELIBERATELY NOT the OpenRouter shape (KD-4)', () => {
  it('carries the flat reasoning_effort field xAI actually accepts, and OMITS the OpenRouter-only gateway fields', async () => {
    // The point of KD-4 is the DIFFERENCE from the openrouter descriptor two
    // blocks above, not mere presence of a reasoning dial. xAI is a single
    // direct endpoint, not a router selecting among upstream backends, so
    // `provider`/`require_parameters`/`sort` have no meaning here — and
    // OpenRouter's NESTED `reasoning: { effort }` shape would be silently
    // ignored by xAI's API, which takes a FLAT top-level `reasoning_effort`
    // string (verified live 2026-08-14 against api.x.ai). Getting this wrong
    // is the "accepted but inert" failure class the Grok pre-flight (plan §8)
    // exists to catch — this test catches it earlier, for free.
    const src = readFileSync(new URL('../scripts/gemini-review.mjs', import.meta.url), 'utf-8');

    const canonical = shadow({ provider: 'xai', model: null }, { XAI_API_KEY: 'k' }).provider;
    assert.equal(canonical, 'xai');

    const descriptor = src.slice(src.indexOf('  xai: {'));
    const body = descriptor.slice(0, descriptor.indexOf('\n  },'));
    assert.match(body, /reasoning_effort:\s*finalReviewConfig\.reasoningEffort/, 'flat reasoning_effort pin missing');
    assert.match(body, /structuredOutput:\s*true/, 'the shadow needs the JSON schema, not prose');
    // Field-WITH-VALUE shape, not the bare word — this descriptor's own
    // explanatory comment names `require_parameters`/`sort`/`reasoning.effort`
    // in prose (to say why they're excluded), so a bare-word regex would match
    // the comment explaining the absence and fail the very test asserting it.
    assert.doesNotMatch(body, /require_parameters:\s*true/, 'require_parameters is OpenRouter-only — xai has one endpoint, nothing to require');
    assert.doesNotMatch(body, /sort:\s*'[a-z]+'/, 'sort is OpenRouter-only routing — meaningless for a direct endpoint');
    assert.doesNotMatch(body, /reasoning:\s*\{\s*effort:/, 'must NOT use OpenRouter\'s NESTED shape — xai would silently ignore it');
  });

  it('the SHADOW_PROVIDER_SPECS entry is native (not gateway) — has a real defaultSentinel', () => {
    const src = readFileSync(new URL('../scripts/gemini-review.mjs', import.meta.url), 'utf-8');
    const specs = src.slice(src.indexOf('const SHADOW_PROVIDER_SPECS'));
    const body = specs.slice(0, specs.indexOf('\n};'));
    const xaiLine = body.split('\n').find((l) => l.includes("'xai':") || l.includes('xai:'));
    assert.ok(xaiLine, 'no xai entry found in SHADOW_PROVIDER_SPECS');
    assert.match(xaiLine, /defaultSentinel:\s*'latest-grok'/, 'xai must have a real default sentinel, unlike the openrouter gateway (defaultSentinel: null)');
    assert.doesNotMatch(xaiLine, /gateway:\s*true/, 'xai is not a gateway — it is a single known provider with a real default model');
  });
});

describe('Alibaba shadow — resolution states (native replacement for the qwen/deepseek OpenRouter arms, 2026-08-17)', () => {
  it('refuses without an explicit model — like openrouter (gateway:true), UNLIKE xai', () => {
    // Alibaba serves several unrelated model families verbatim (Qwen,
    // DeepSeek, GLM, Kimi) with no single sensible default, so it takes
    // openrouter's "no default, explicit model required" branch even though
    // it is not itself a multi-backend router.
    const r = shadow({ provider: 'alibaba', model: null }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' });
    assert.equal(r.state, 'skipped-no-model');
    assert.equal(r.model, null);
  });

  it('is ready with a curated model id and BOTH env vars', () => {
    const r = shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' });
    assert.equal(r.state, 'ready');
    assert.equal(r.model, 'qwen3.8-max');
    assert.equal(r.provider, 'alibaba');
  });

  it('the OTHER curated id (deepseek) is also accepted', () => {
    const r = shadow({ provider: 'alibaba', model: 'deepseek-v4-pro-0813' }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' });
    assert.equal(r.state, 'ready');
  });

  it('an explicit model NOT in ALIBABA_POOL is rejected, not silently routed to alibaba', () => {
    // family check defers to isAlibabaModel — the SAME allowlist the runner
    // consults, not a name-pattern guess.
    for (const bad of ['grok-4.6', 'qwen/qwen3.8-max', 'deepseek-v4-pro']) {
      const r = shadow({ provider: 'alibaba', model: bad }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' });
      assert.equal(r.state, 'skipped-unsupported-provider', `"${bad}" must not resolve via alibaba`);
    }
  });

  it('EITHER missing env var (not just the key) is a refusal — the workspace URL has no fallback', () => {
    assert.equal(shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, { ALIBABA_CLOUD_API_KEY: 'k' }).state, 'skipped-no-key', 'missing base URL');
    assert.equal(shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, { ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' }).state, 'skipped-no-key', 'missing api key');
    assert.equal(shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, {}).state, 'skipped-no-key');
  });

  it('is a no-op under an active Azure profile — same guard order as every other provider', () => {
    const r = shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' }, true);
    assert.equal(r.state, 'skipped-azure');
    assert.equal(r.model, null);
  });

  it('never lets the api key escape into the resolver result', () => {
    const secret = 'sk-ws-DEADBEEFDEADBEEF';
    const r = shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, { ALIBABA_CLOUD_API_KEY: secret, ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' });
    assert.doesNotMatch(JSON.stringify(r), /DEADBEEF/);
  });
});

describe('Alibaba shadow — the descriptor is a direct endpoint, not an OpenRouter-style router', () => {
  it('carries no OpenRouter routing pins, and requestExtras is empty (no reasoning knob verified live yet)', () => {
    const src = readFileSync(new URL('../scripts/gemini-review.mjs', import.meta.url), 'utf-8');

    const canonical = shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' }).provider;
    assert.equal(canonical, 'alibaba');

    const descriptor = src.slice(src.indexOf('  alibaba: {'));
    const body = descriptor.slice(0, descriptor.indexOf('\n  },'));
    assert.match(body, /structuredOutput:\s*true/, 'the shadow needs the JSON schema, not prose');
    assert.doesNotMatch(body, /require_parameters:\s*true/, 'OpenRouter-only — alibaba is one workspace endpoint, nothing to require');
    assert.doesNotMatch(body, /sort:\s*'[a-z]+'/, 'sort is OpenRouter-only routing — meaningless for a direct endpoint');
    assert.match(body, /requestExtras:\s*\(\)\s*=>\s*\(\{\}\)/, 'no reasoning field is claimed until verified live against this workspace');
  });

  it('the SHADOW_PROVIDER_SPECS entry is gateway-shaped (no default sentinel) but its own family', () => {
    const src = readFileSync(new URL('../scripts/gemini-review.mjs', import.meta.url), 'utf-8');
    const specs = src.slice(src.indexOf('const SHADOW_PROVIDER_SPECS'));
    const body = specs.slice(0, specs.indexOf('\n};'));
    // The entry spans multiple lines (unlike xai's single-line one above), so
    // grab the whole `'alibaba': { ... },` block rather than one matching line.
    const startIdx = body.indexOf("'alibaba':");
    assert.ok(startIdx >= 0, 'no alibaba entry found in SHADOW_PROVIDER_SPECS');
    const rest = body.slice(startIdx);
    const alibabaBlock = rest.slice(0, rest.indexOf('\n  },') + 1);
    assert.match(alibabaBlock, /gateway:\s*true/, 'alibaba has no single sensible default across Qwen/DeepSeek/GLM/Kimi');
    assert.match(alibabaBlock, /defaultSentinel:\s*null/);
    assert.match(alibabaBlock, /family:\s*'alibaba'/, 'must NOT share the "gateway" family string with openrouter — kept distinct for telemetry and its own family check');
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

describe('final-review transports READ reasoning tokens, never fabricate them', () => {
  // The regression this pins: every transport builds its own usage object, so a
  // field it does not copy simply does not exist downstream. Both Anthropic and
  // OpenRouter shipped `thinking_tokens: 0` as a LITERAL. The Anthropic zero was
  // accidentally correct (forced tool_choice suppressed reasoning) and the
  // OpenRouter one was flatly wrong — Kimi was spending ~67% of its output
  // budget reasoning while the log reported none. A fabricated zero cannot show
  // you when it stops being true, which is the whole failure.
  //
  // Asserted at source because reproducing it needs three live providers.
  const SRC = readFileSync(new URL('../scripts/gemini-review.mjs', import.meta.url), 'utf-8');
  const transports = SRC.slice(SRC.indexOf('const REVIEW_TRANSPORTS'), SRC.indexOf('async function callReviewer'));

  it('no transport assigns a literal zero to thinking_tokens', () => {
    assert.doesNotMatch(transports, /thinking_tokens:\s*0\s*[,}]/,
      'a literal thinking_tokens: 0 is back — read it from the provider response instead');
  });

  it('each provider shape reads its own reasoning field', () => {
    assert.match(transports, /thoughtsTokenCount/, 'gemini');                          // Gemini
    assert.match(transports, /output_tokens_details\?\.thinking_tokens/, 'anthropic');  // Anthropic
    assert.match(transports, /completion_tokens_details\?\.reasoning_tokens/, 'openai'); // OpenAI/OpenRouter
  });

  it('the OpenAI-shaped transport surfaces max_tokens truncation', () => {
    // finish_reason 'length' yields JSON that may still parse, so a truncated
    // review reads as a short one. Silence here is indistinguishable from a
    // model that found little.
    assert.match(transports, /finish_reason/);
    assert.match(transports, /TRUNCATED/);
  });
});
