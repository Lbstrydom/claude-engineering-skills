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
import { fetchedUrlsUnderCli, isAnthropicMessagesUrl, MESSAGES_REQUEST } from './helpers/anthropic-wire.mjs';

const { resolveShadow, GEMINI_THINKING_BUDGET_BY_EFFORT, PROVIDERS } = _internals;
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
    //
    // Asserted on the EXPORTED descriptor's behaviour — `requestExtras()` is exactly what
    // runFinalReview calls — not on the text of providers.mjs. A source regex cannot tell a live
    // field from the same words in a comment, and breaks on any reformat. (Ledger topic 251efde41d8d.)
    const canonical = shadow({ provider: 'openrouter', model: KIMI }, { OPENROUTER_API_KEY: 'k' }).provider;
    assert.equal(canonical, 'openrouter');

    // The descriptor keyed by that canonical name must still declare both pins.
    const descriptor = PROVIDERS[canonical];
    assert.ok(descriptor, `no PROVIDERS["${canonical}"] — the shadow would run unpinned`);
    const extras = descriptor.requestExtras();
    assert.equal(extras.provider?.require_parameters, true, 'require_parameters pin missing from the inherited descriptor');
    assert.match(String(extras.provider?.sort), /^[a-z]+$/, 'provider sort pin missing from the inherited descriptor');
    assert.equal(extras.reasoning?.effort, finalReviewConfig.reasoningEffort, 'reasoning-effort pin missing — reasoning tokens count against max_tokens');
    assert.equal(descriptor.structuredOutput, true, 'the shadow needs the JSON schema, not prose');
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
    //
    // The EXPORTED descriptor's behaviour, not the text of providers.mjs: `requestExtras()` is what
    // runFinalReview sends. (A source regex also had to dodge this descriptor's own comment, which
    // names the OpenRouter-only fields in prose to explain their absence.) Ledger topic 251efde41d8d.
    const canonical = shadow({ provider: 'xai', model: null }, { XAI_API_KEY: 'k' }).provider;
    assert.equal(canonical, 'xai');

    const descriptor = PROVIDERS[canonical];
    const extras = descriptor.requestExtras();
    assert.deepEqual(extras, { reasoning_effort: finalReviewConfig.reasoningEffort },
      'exactly the flat reasoning_effort field xAI accepts — and nothing else');
    assert.equal(descriptor.structuredOutput, true, 'the shadow needs the JSON schema, not prose');
    assert.ok(!('provider' in extras), 'require_parameters/sort are OpenRouter-only — xai has one endpoint, nothing to require');
    assert.ok(!('reasoning' in extras), 'must NOT use OpenRouter\'s NESTED shape — xai would silently ignore it');
  });

  // Asserted on the IMPORTED table, not on source text. The table moved to
  // `scripts/lib/final-review/provider-specs.mjs` on 2026-08-18 (it has a second
  // reader — the pinned-revision fixture's credential preflight), and an
  // exported object can be read directly. That is also strictly stronger than
  // the line-regex this replaced: a regex over source cannot tell a live field
  // from the same words inside a comment.
  it('the SHADOW_PROVIDER_SPECS entry is native (not gateway) — has a real defaultSentinel', () => {
    const xai = _internals.SHADOW_PROVIDER_SPECS.xai;
    assert.ok(xai, 'no xai entry found in SHADOW_PROVIDER_SPECS');
    assert.equal(xai.defaultSentinel, 'latest-grok', 'xai must have a real default sentinel, unlike the openrouter gateway (defaultSentinel: null)');
    assert.notEqual(xai.gateway, true, 'xai is not a gateway — it is a single known provider with a real default model');
  });
});

describe('Alibaba shadow — resolution states (native replacement for the qwen OpenRouter arm, 2026-08-17)', () => {
  it('refuses without an explicit model — like openrouter (gateway:true), UNLIKE xai', () => {
    // Alibaba serves several unrelated model families verbatim (Qwen,
    // DeepSeek, GLM, Kimi) with no single sensible default, so it takes
    // openrouter's "no default, explicit model required" branch even though
    // it is not itself a multi-backend router.
    const r = shadow({ provider: 'alibaba', model: null }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' });
    assert.equal(r.state, 'skipped-no-model');
    assert.equal(r.model, null);
  });

  it('is ready with the curated model id and BOTH env vars', () => {
    const r = shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' });
    assert.equal(r.state, 'ready');
    assert.equal(r.model, 'qwen3.8-max');
    assert.equal(r.provider, 'alibaba');
  });

  it('the RETIRED deepseek snapshot pin no longer resolves via alibaba — it moved to DeepSeek\'s own direct API', () => {
    const r = shadow({ provider: 'alibaba', model: 'deepseek-v4-pro-0813' }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' });
    assert.equal(r.state, 'skipped-unsupported-provider');
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
  it('carries no OpenRouter routing pins, and sends enable_thinking EXPLICITLY TRUE — reasoning parity is the whole point of a comparison arm', () => {
    const canonical = shadow({ provider: 'alibaba', model: 'qwen3.8-max' }, { ALIBABA_CLOUD_API_KEY: 'k', ALIBABA_CLOUD_BASE_URL: 'https://example.invalid/v1' }).provider;
    assert.equal(canonical, 'alibaba');

    // The EXPORTED descriptor's behaviour (what runFinalReview sends), not source text — a regex
    // cannot tell a live field from a comment, nor a field gated behind a condition from an
    // unconditional one. Ledger topic 251efde41d8d.
    const descriptor = PROVIDERS[canonical];
    const extras = descriptor.requestExtras();
    assert.equal(descriptor.structuredOutput, true, 'the shadow needs the JSON schema, not prose');
    assert.ok(!('provider' in extras), 'require_parameters/sort are OpenRouter-only — alibaba is one workspace endpoint, nothing to require');
    // Set at all: Alibaba documents enable_thinking as required top-level for
    // non-streaming calls to thinking models, and leaving it unset is what
    // correlated with the observed stalls. And TRUE specifically. `false` would be faster and
    // cheaper and would WRECK the comparison: reasoningEffort:'high' binds every arm and is
    // hashed into the cohort digest, so an arm with reasoning off measures the dial rather than
    // the model (the campaign's own measured lesson: 0 findings at `low` vs 3 at `high` on one
    // identical transcript).
    assert.deepEqual(extras, { enable_thinking: true }, 'must send enable_thinking:true explicitly — unset is the state that stalled, false measures the setting not the model');
  });

  // Imported-table assertion, same reasoning as the xai case above.
  it('the SHADOW_PROVIDER_SPECS entry is gateway-shaped (no default sentinel) but its own family', () => {
    const alibaba = _internals.SHADOW_PROVIDER_SPECS.alibaba;
    assert.ok(alibaba, 'no alibaba entry found in SHADOW_PROVIDER_SPECS');
    assert.equal(alibaba.gateway, true, 'alibaba has no single sensible default across Qwen/DeepSeek/GLM/Kimi');
    assert.equal(alibaba.defaultSentinel, null);
    assert.equal(alibaba.family, 'alibaba', 'must NOT share the "gateway" family string with openrouter — kept distinct for telemetry and its own family check');
  });
});

describe('DeepSeek shadow — resolution states (direct API, replaces the Alibaba-workspace pin, 2026-08-17)', () => {
  it('refuses without an explicit model — no single default across v4-pro/v4-flash', () => {
    const r = shadow({ provider: 'deepseek', model: null }, { DEEPSEEK_API_KEY: 'k' });
    assert.equal(r.state, 'skipped-no-model');
  });

  it('is ready with either curated model id and just the one env var (a universal endpoint, unlike alibaba)', () => {
    for (const id of ['deepseek-v4-pro', 'deepseek-flash']) {
      const r = shadow({ provider: 'deepseek', model: id }, { DEEPSEEK_API_KEY: 'k' });
      assert.equal(r.state, 'ready', id);
      assert.equal(r.model, id);
      assert.equal(r.provider, 'deepseek');
    }
  });

  it('rejects the retired Alibaba-workspace dated snapshot, other unrelated ids, and the superseded v4-flash spelling', () => {
    for (const bad of ['deepseek-v4-pro-0813', 'qwen3.8-max', 'grok-4.6', 'deepseek-v4-flash']) {
      const r = shadow({ provider: 'deepseek', model: bad }, { DEEPSEEK_API_KEY: 'k' });
      assert.equal(r.state, 'skipped-unsupported-provider', `"${bad}" must not resolve via deepseek`);
    }
  });

  it('no DEEPSEEK_API_KEY -> skipped-no-key', () => {
    assert.equal(shadow({ provider: 'deepseek', model: 'deepseek-v4-pro' }, {}).state, 'skipped-no-key');
  });

  it('is a no-op under an active Azure profile — same guard order as every other provider', () => {
    const r = shadow({ provider: 'deepseek', model: 'deepseek-v4-pro' }, { DEEPSEEK_API_KEY: 'k' }, true);
    assert.equal(r.state, 'skipped-azure');
    assert.equal(r.model, null);
  });

  it('never lets the api key escape into the resolver result', () => {
    const secret = 'sk-DEADBEEFDEADBEEF';
    const r = shadow({ provider: 'deepseek', model: 'deepseek-v4-pro' }, { DEEPSEEK_API_KEY: secret });
    assert.doesNotMatch(JSON.stringify(r), /DEADBEEF/);
  });
});

describe('DeepSeek shadow — the descriptor degrades gracefully on this provider\'s json_schema rejection', () => {
  it('carries no OpenRouter routing pins, and requestExtras is empty', () => {
    const canonical = shadow({ provider: 'deepseek', model: 'deepseek-v4-pro' }, { DEEPSEEK_API_KEY: 'k' }).provider;
    assert.equal(canonical, 'deepseek');
    // The EXPORTED descriptor's behaviour, not source text. Ledger topic 251efde41d8d.
    const descriptor = PROVIDERS[canonical];
    assert.equal(descriptor.structuredOutput, true, 'the shadow needs the JSON schema, not prose — the openai transport degrades to prompt-only automatically if DeepSeek rejects it');
    assert.deepEqual(descriptor.requestExtras(), {}, 'no routing pins (OpenRouter-only) and no reasoning field — none is claimed until verified live');
  });

  // Imported-table assertion, same reasoning as the xai/alibaba cases above.
  it('the SHADOW_PROVIDER_SPECS entry is gateway-shaped (no default sentinel) but its own family, distinct from alibaba', () => {
    const deepseek = _internals.SHADOW_PROVIDER_SPECS.deepseek;
    assert.ok(deepseek, 'no deepseek entry found in SHADOW_PROVIDER_SPECS');
    assert.equal(deepseek.gateway, true);
    assert.equal(deepseek.defaultSentinel, null);
    assert.equal(deepseek.family, 'deepseek', 'must not share alibaba\'s family string — a qwen id must not pass as deepseek');
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
  // running CLAUDE_BACKEND=cli.
  //
  // OBSERVED ON THE WIRE (tests/helpers/anthropic-wire.mjs), no longer regexed from source: under
  // `cli` an unpinned client never touches the network, a pinned one POSTs to
  // api.anthropic.com/v1/messages. The shadow builder's twin of this pin lives in
  // gemini-review-shadow.test.mjs (with its negative control). Ledger topics 251efde41d8d / 630ffd6e3f03.
  //
  // The `azureRoute: null` half stays SOURCE-pinned below on purpose: the Azure config is frozen
  // at module import, so observing it needs a subprocess.
  const SHADOW_SRC = readFileSync(new URL('../scripts/lib/final-review/shadow.mjs', import.meta.url), 'utf-8');
  const PROVIDERS_SRC = readFileSync(new URL('../scripts/lib/final-review/providers.mjs', import.meta.url), 'utf-8');

  it('the PRIMARY claude-opus provider pins backend sdk — observed: it reaches the API under CLAUDE_BACKEND=cli', async () => {
    const urls = await fetchedUrlsUnderCli(async () => {
      const client = await PROVIDERS['claude-opus'].buildClient();
      await client.messages.create(MESSAGES_REQUEST);
    });
    assert.equal(urls.filter(isAnthropicMessagesUrl).length, 1,
      `the primary claude-opus client must pin the sdk backend; saw ${JSON.stringify(urls)}`);
  });

  it('both Anthropic arms pin azureRoute:null — they MEAN the public service', () => {
    // `claude-opus` is a different provider id from `azure-claude`, and the
    // shadow's cost note says it bills ANTHROPIC_API_KEY. Since an OMITTED
    // route now adopts the tenant's Azure Claude, dropping this pin would make
    // both arms silently become `azure-claude` on any Azure machine — the A/B
    // would then compare a provider against itself and read as agreement.
    const shadow = SHADOW_SRC.slice(SHADOW_SRC.indexOf('async function buildShadowClient'));
    assert.match(shadow.slice(0, shadow.indexOf('\n}\n')), /azureRoute:\s*null/);
    const block = PROVIDERS_SRC.slice(PROVIDERS_SRC.indexOf("'claude-opus': {"));
    assert.match(block.slice(0, block.indexOf("'azure-claude': {")), /azureRoute:\s*null/);
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
  // BEHAVIOURAL, through the real adapters with a canned SDK response each. The
  // source-regex version it replaces passed its gemini arm on a COMMENT naming
  // `thoughtsTokenCount` after the adapter had moved to the shared oracle.
  const { REVIEW_TRANSPORTS } = _internals;
  const IN = { model: 'm', maxTokens: 10, systemPrompt: 's', userPrompt: 'u', signal: new AbortController().signal };

  it('anthropic reads output_tokens_details.thinking_tokens', async () => {
    const client = { messages: { create: async () => ({
      content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 90, output_tokens_details: { thinking_tokens: 61 } },
    }) } };
    assert.equal((await REVIEW_TRANSPORTS.anthropic(client, IN)).usage.thinking_tokens, 61);
  });

  it('openai-shaped reads completion_tokens_details.reasoning_tokens', async () => {
    const client = { chat: { completions: { create: async () => ({
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 90, completion_tokens_details: { reasoning_tokens: 67 } },
    }) } } };
    assert.equal((await REVIEW_TRANSPORTS.openai(client, IN)).usage.thinking_tokens, 67);
  });

  it('gemini reads thoughtsTokenCount (via the shared oracle)', async () => {
    const client = { models: { generateContentStream: async () => (async function* () {
      yield { text: '{}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 5, thoughtsTokenCount: 44 } };
    })() } };
    assert.equal((await REVIEW_TRANSPORTS.gemini(client, IN)).usage.thinking_tokens, 44);
  });

  it('every transport RETURNS its finish reason, so callReviewer can fail a cut-off review', async () => {
    const openai = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }], usage: {} }) } } };
    const anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: '{}' }], stop_reason: 'max_tokens', usage: {} }) } };
    const gemini = { models: { generateContentStream: async () => (async function* () {
      yield { text: '{}', candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    })() } };
    assert.equal((await REVIEW_TRANSPORTS.openai(openai, IN)).finishReason, 'length');
    assert.equal((await REVIEW_TRANSPORTS.anthropic(anthropic, IN)).finishReason, 'max_tokens');
    assert.equal((await REVIEW_TRANSPORTS.gemini(gemini, IN)).finishReason, 'MAX_TOKENS');
  });
});
