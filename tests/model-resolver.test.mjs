import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATIC_POOL, DEPRECATED_REMAP, SENTINEL_TO_TIER, OSS_POOL, XAI_POOL,
  isSentinel, parseClaudeModel, parseGeminiModel, parseOpenAIModel,
  pickNewestClaude, pickNewestGemini, pickNewestOpenAI,
  deprecatedRemap, resolveModel, setCatalog, _resetCatalogCache,
  supportsReasoningEffort, pricingKey, isXaiModel, isAlibabaModel, resolveAlibabaCreds,
  isDeepseekModel, resolveDeepseekCreds, DEEPSEEK_BASE_URL,
} from '../scripts/lib/model-resolver.mjs';

// Reset state between tests so catalog overrides from one test don't leak
beforeEach(() => _resetCatalogCache());

// ── isSentinel ──────────────────────────────────────────────────────────────

describe('isSentinel', () => {
  it('detects known sentinels (case-insensitive)', () => {
    assert.equal(isSentinel('latest-gpt'), true);
    assert.equal(isSentinel('latest-opus'), true);
    assert.equal(isSentinel('latest-pro'), true);
    assert.equal(isSentinel('LATEST-FLASH'), true);
  });

  it('rejects concrete model IDs', () => {
    assert.equal(isSentinel('gpt-5.4'), false);
    assert.equal(isSentinel('claude-opus-4-7'), false);
    assert.equal(isSentinel('gemini-3.1-pro-preview'), false);
  });

  it('rejects non-strings', () => {
    assert.equal(isSentinel(null), false);
    assert.equal(isSentinel(undefined), false);
    assert.equal(isSentinel(42), false);
  });
});

// ── parseClaudeModel ────────────────────────────────────────────────────────

describe('parseClaudeModel', () => {
  it('parses bare (rolling alias) IDs', () => {
    const p = parseClaudeModel('claude-opus-4-7');
    assert.equal(p.tier, 'opus');
    assert.equal(p.major, 4);
    assert.equal(p.minor, 7);
    assert.equal(p.date, null);
  });

  it('parses dated (pinned snapshot) IDs', () => {
    const p = parseClaudeModel('claude-haiku-4-5-20251001');
    assert.equal(p.tier, 'haiku');
    assert.equal(p.major, 4);
    assert.equal(p.minor, 5);
    assert.equal(p.date, '20251001');
  });

  it('returns null for non-Claude IDs', () => {
    assert.equal(parseClaudeModel('gpt-5.4'), null);
    assert.equal(parseClaudeModel('gemini-pro-latest'), null);
  });
});

// ── parseGeminiModel ────────────────────────────────────────────────────────

describe('parseGeminiModel', () => {
  it('parses Google aliases with high-priority major=Infinity', () => {
    const p = parseGeminiModel('gemini-pro-latest');
    assert.equal(p.tier, 'pro');
    assert.equal(p.isAlias, true);
    assert.equal(p.major, Number.POSITIVE_INFINITY);
  });

  it('parses versioned preview IDs', () => {
    const p = parseGeminiModel('gemini-3.1-pro-preview');
    assert.equal(p.tier, 'pro');
    assert.equal(p.major, 3);
    assert.equal(p.minor, 1);
    assert.equal(p.isPreview, true);
    assert.equal(p.isAlias, false);
  });

  it('parses versioned non-preview IDs', () => {
    const p = parseGeminiModel('gemini-2.5-flash');
    assert.equal(p.tier, 'flash');
    assert.equal(p.major, 2);
    assert.equal(p.minor, 5);
    assert.equal(p.isPreview, false);
  });

  it('parses flash-lite tier', () => {
    const p = parseGeminiModel('gemini-flash-lite-latest');
    assert.equal(p.tier, 'flash-lite');
    assert.equal(p.isAlias, true);
  });
});

// ── parseOpenAIModel ────────────────────────────────────────────────────────

describe('parseOpenAIModel', () => {
  it('parses gpt-5.4', () => {
    const p = parseOpenAIModel('gpt-5.4');
    assert.equal(p.family, 'gpt');
    assert.equal(p.major, 5);
    assert.equal(p.minor, 4);
    assert.equal(p.isLite, false);
  });

  it('parses mini variants', () => {
    const p = parseOpenAIModel('gpt-4.1-mini');
    assert.equal(p.variant, 'mini');
    assert.equal(p.isLite, true);
  });

  it('parses o-series', () => {
    const p = parseOpenAIModel('o1');
    assert.equal(p.family, 'o');
    assert.equal(p.major, 1);
  });

  it('parses GPT-5.6\'s three-tier sol/terra/luna naming (regression — the prior regex returned null for all three)', () => {
    const sol = parseOpenAIModel('gpt-5.6-sol');
    assert.equal(sol.major, 5);
    assert.equal(sol.minor, 6);
    assert.equal(sol.variant, 'sol');
    assert.equal(sol.isPremium, true);
    assert.equal(sol.isLite, false);

    const terra = parseOpenAIModel('gpt-5.6-terra');
    assert.equal(terra.variant, 'terra');
    assert.equal(terra.isPremium, false);
    assert.equal(terra.isLite, false);

    const luna = parseOpenAIModel('gpt-5.6-luna');
    assert.equal(luna.variant, 'luna');
    assert.equal(luna.isLite, true);
    assert.equal(luna.isPremium, false);
  });

  it('flags gpt-*-pro as isPremium (the pre-existing premium-SKU shape)', () => {
    const p = parseOpenAIModel('gpt-5.5-pro');
    assert.equal(p.isPremium, true);
  });
});

// ── Tier pickers ────────────────────────────────────────────────────────────

describe('pickNewestClaude', () => {
  it('prefers newest major.minor', () => {
    const pool = ['claude-opus-4-1', 'claude-opus-4-7', 'claude-opus-4-6'];
    assert.equal(pickNewestClaude(pool, 'opus'), 'claude-opus-4-7');
  });

  it('prefers undated (rolling) over dated at same version', () => {
    const pool = ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'];
    assert.equal(pickNewestClaude(pool, 'haiku'), 'claude-haiku-4-5');
  });

  it('filters by tier', () => {
    const pool = ['claude-opus-4-7', 'claude-haiku-4-5'];
    assert.equal(pickNewestClaude(pool, 'haiku'), 'claude-haiku-4-5');
    assert.equal(pickNewestClaude(pool, 'sonnet'), null);
  });
});

describe('pickNewestGemini', () => {
  it('short-circuits to Google alias when present', () => {
    const pool = ['gemini-3.1-pro-preview', 'gemini-pro-latest', 'gemini-2.5-pro'];
    assert.equal(pickNewestGemini(pool, 'pro'), 'gemini-pro-latest');
  });

  it('falls back to newest versioned when no alias', () => {
    const pool = ['gemini-2.5-pro', 'gemini-3.1-pro-preview'];
    assert.equal(pickNewestGemini(pool, 'pro'), 'gemini-3.1-pro-preview');
  });

  it('prefers GA over preview at same version', () => {
    const pool = ['gemini-3.1-pro-preview', 'gemini-3.1-pro'];
    // `gemini-3.1-pro` isn't in DEPRECATED_REMAP-rewrite territory here; the
    // parser treats it as a valid GA ID — GA should win at same version.
    assert.equal(pickNewestGemini(pool, 'pro'), 'gemini-3.1-pro');
  });
});

describe('pickNewestOpenAI', () => {
  it('excludes mini variants by default', () => {
    const pool = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-4.1-mini'];
    assert.equal(pickNewestOpenAI(pool), 'gpt-5.4');
  });

  it('selects mini when variant=mini', () => {
    const pool = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-4.1-mini'];
    assert.equal(pickNewestOpenAI(pool, 'mini'), 'gpt-5.4-mini');
  });

  it('prefers the plain/balanced SKU (terra) over the premium SKU (sol) at the same version — the standard sentinel is a reasoning-effort axis, not a model-SKU axis', () => {
    const pool = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    assert.equal(pickNewestOpenAI(pool), 'gpt-5.6-terra');
  });

  it('still prefers a newer plain/balanced SKU over an older premium one (version beats SKU rank)', () => {
    const pool = ['gpt-5.5-pro', 'gpt-5.6-terra'];
    assert.equal(pickNewestOpenAI(pool), 'gpt-5.6-terra');
  });

  it('variant=mini matches ANY lite SKU by literal name, not just "mini" — regression for a renamed cheap tier (mini -> luna)', () => {
    const pool = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    assert.equal(pickNewestOpenAI(pool, 'mini'), 'gpt-5.6-luna');
  });

  it('variant=mini still prefers the newer lite SKU across a generation boundary (luna over an older mini)', () => {
    const pool = ['gpt-5.4-mini', 'gpt-5.6-luna'];
    assert.equal(pickNewestOpenAI(pool, 'mini'), 'gpt-5.6-luna');
  });
});

// ── deprecatedRemap ─────────────────────────────────────────────────────────

describe('deprecatedRemap', () => {
  it('remaps known stale IDs to sentinels', () => {
    assert.equal(deprecatedRemap('gpt-5.2', { silent: true }), 'latest-gpt');
    assert.equal(deprecatedRemap('gemini-3-flash', { silent: true }), 'latest-flash');
    assert.equal(deprecatedRemap('claude-opus-3', { silent: true }), 'latest-opus');
  });

  it('passes through unknown IDs unchanged', () => {
    assert.equal(deprecatedRemap('gpt-5.4', { silent: true }), 'gpt-5.4');
    assert.equal(deprecatedRemap('claude-opus-4-7', { silent: true }), 'claude-opus-4-7');
  });

  it('handles nullish input gracefully', () => {
    assert.equal(deprecatedRemap(null), null);
    assert.equal(deprecatedRemap(undefined), undefined);
  });
});

// ── resolveModel ────────────────────────────────────────────────────────────

describe('resolveModel', () => {
  it('returns concrete IDs unchanged', () => {
    assert.equal(resolveModel('gpt-5.4'), 'gpt-5.4');
    assert.equal(resolveModel('claude-opus-4-7'), 'claude-opus-4-7');
  });

  it('resolves latest-gpt via static pool', () => {
    const result = resolveModel('latest-gpt');
    assert.match(result, /^gpt-/);
    assert.equal(STATIC_POOL.openai.includes(result), true);
  });

  it('resolves latest-opus via static pool', () => {
    const result = resolveModel('latest-opus');
    assert.match(result, /^claude-opus-/);
  });

  it('resolves latest-pro via Google alias short-circuit', () => {
    // Static pool contains gemini-pro-latest → alias should win
    assert.equal(resolveModel('latest-pro'), 'gemini-pro-latest');
  });

  it('resolves latest-flash via Google alias short-circuit', () => {
    assert.equal(resolveModel('latest-flash'), 'gemini-flash-latest');
  });

  it('resolves latest-haiku preferring undated rolling alias', () => {
    assert.equal(resolveModel('latest-haiku'), 'claude-haiku-4-5');
  });

  it('applies deprecatedRemap before sentinel resolution', () => {
    // gpt-5.2 → latest-gpt → concrete gpt-5.4
    const r = resolveModel('gpt-5.2', { silent: true });
    assert.match(r, /^gpt-/);
    assert.notEqual(r, 'gpt-5.2');
  });

  it('throws on non-string input', () => {
    assert.throws(() => resolveModel(null), /non-empty string/);
    assert.throws(() => resolveModel(42), /non-empty string/);
  });

  it('uses live catalog when populated (overrides static)', () => {
    // Seed live catalog with a future model that doesn't exist in static pool
    setCatalog('anthropic', ['claude-opus-5-0', 'claude-sonnet-4-6']);
    assert.equal(resolveModel('latest-opus'), 'claude-opus-5-0');
  });

  it('end-to-end: latest-gpt resolves to the newest plain/balanced SKU (terra) and latest-gpt-mini to the newest lite SKU (luna) once GPT-5.6 is live — regression for the sol/terra/luna naming + mini-generalization fixes together', () => {
    setCatalog('openai', ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini']);
    assert.equal(resolveModel('latest-gpt'), 'gpt-5.6-terra');
    assert.equal(resolveModel('latest-gpt-mini'), 'gpt-5.6-luna');
  });

  it('merges live and static pools', () => {
    // Live provides a newer Gemini model — should win over versioned static
    // entries but Google alias (in static) should still short-circuit.
    setCatalog('google', ['gemini-4.0-pro-preview']);
    // Alias short-circuit wins for pro tier (static pool has gemini-pro-latest)
    assert.equal(resolveModel('latest-pro'), 'gemini-pro-latest');
  });
});

// ── supportsReasoningEffort ─────────────────────────────────────────────────

describe('supportsReasoningEffort', () => {
  it('returns true for gpt-5+', () => {
    assert.equal(supportsReasoningEffort('gpt-5.4'), true);
    assert.equal(supportsReasoningEffort('gpt-5.4-mini'), true);
    assert.equal(supportsReasoningEffort('gpt-6'), true);
  });

  it('returns true for o-series', () => {
    assert.equal(supportsReasoningEffort('o1'), true);
    assert.equal(supportsReasoningEffort('o3'), true);
  });

  it('returns false for gpt-4 and below', () => {
    assert.equal(supportsReasoningEffort('gpt-4.1-mini'), false);
    assert.equal(supportsReasoningEffort('gpt-4o'), false);
  });

  it('returns false for non-OpenAI IDs', () => {
    assert.equal(supportsReasoningEffort('claude-opus-4-7'), false);
    assert.equal(supportsReasoningEffort('gemini-pro-latest'), false);
  });
});

// ── pricingKey ──────────────────────────────────────────────────────────────

describe('pricingKey', () => {
  it('returns family+tier for Claude', () => {
    assert.equal(pricingKey('claude-opus-4-7'), 'claude-opus');
    assert.equal(pricingKey('claude-haiku-4-5'), 'claude-haiku');
  });

  it('returns tier-stable keys for Gemini', () => {
    assert.equal(pricingKey('gemini-pro-latest'), 'gemini-pro');
    assert.equal(pricingKey('gemini-3.1-pro-preview'), 'gemini-pro');
    assert.equal(pricingKey('gemini-flash-latest'), 'gemini-flash');
  });

  it('handles OpenAI variants', () => {
    assert.equal(pricingKey('gpt-5.4'), 'gpt-5');
    assert.equal(pricingKey('gpt-5.4-mini'), 'gpt-5-mini');
  });
});

// ── Data integrity ──────────────────────────────────────────────────────────

describe('STATIC_POOL / DEPRECATED_REMAP integrity', () => {
  it('every DEPRECATED_REMAP target is a valid sentinel', () => {
    for (const [deprecated, target] of Object.entries(DEPRECATED_REMAP)) {
      assert.equal(
        Object.hasOwn(SENTINEL_TO_TIER, target),
        true,
        `remap target "${target}" (from "${deprecated}") is not a registered sentinel`
      );
    }
  });

  it('every sentinel resolves to something in its provider pool', () => {
    for (const sentinel of Object.keys(SENTINEL_TO_TIER)) {
      const resolved = resolveModel(sentinel, { silent: true });
      const spec = SENTINEL_TO_TIER[sentinel];
      // OSS sentinels use a role-partitioned pool (no versioned STATIC_POOL
      // array) — the equivalent no-phantom-id guarantee is OSS_POOL[role].
      if (spec.provider === 'oss') {
        assert.equal(
          OSS_POOL[spec.role].includes(resolved),
          true,
          `"${sentinel}" resolved to "${resolved}" which is not in OSS_POOL.${spec.role}`
        );
        continue;
      }
      // Same shape as the OSS carve-out above, one role-partitioned pool
      // (model-resolver.mjs's XAI_POOL docstring explains why xai is NOT in
      // STATIC_POOL: its endpoint mixes chat/non-chat ids with no uniform
      // version grammar, so there is no per-provider array to check against).
      if (spec.provider === 'xai') {
        assert.equal(
          XAI_POOL.includes(resolved),
          true,
          `"${sentinel}" resolved to "${resolved}" which is not in XAI_POOL`
        );
        continue;
      }
      assert.equal(
        STATIC_POOL[spec.provider].includes(resolved),
        true,
        `"${sentinel}" resolved to "${resolved}" which is not in STATIC_POOL.${spec.provider}`
      );
    }
  });

  it('Google aliases present for pro/flash tiers', () => {
    assert.equal(STATIC_POOL.google.includes('gemini-pro-latest'), true);
    assert.equal(STATIC_POOL.google.includes('gemini-flash-latest'), true);
  });
});

describe('isXaiModel — chat models only, NOT a bare prefix test (audit-found gap)', () => {
  it('accepts real chat model ids', () => {
    for (const id of ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning']) {
      assert.equal(isXaiModel(id), true, `${id} should be a recognised xAI chat model`);
    }
  });

  it('REJECTS the non-chat families verified live on api.x.ai — the exact gap the audit caught', () => {
    // grok-imagine-* and grok-build-* were observed live 2026-08-14 on the
    // same /v1/models endpoint as the chat models. A bare /^grok/i prefix
    // matched them too, which would route an image/video/build model to the
    // chat-completions transport and fail only at runtime.
    for (const id of ['grok-imagine-image', 'grok-imagine-image-2.0', 'grok-imagine-video', 'grok-imagine-video-1.5', 'grok-build-0.1']) {
      assert.equal(isXaiModel(id), false, `${id} must NOT be classified as a chat model`);
    }
  });

  it('rejects non-grok ids and non-string input without throwing', () => {
    assert.equal(isXaiModel('claude-opus-5'), false);
    assert.equal(isXaiModel('gemini-pro-latest'), false);
    for (const v of [null, undefined, 42, {}]) assert.doesNotThrow(() => isXaiModel(v));
  });

  it('is case-insensitive, matching the rest of this repo\'s id-matching convention', () => {
    assert.equal(isXaiModel('GROK-4.6'), true);
    assert.equal(isXaiModel('Grok-Imagine-Image'), false);
  });
});

describe('isAlibabaModel — curated allowlist, not a name-pattern guess', () => {
  it('accepts the one known bare workspace id (qwen only, since 2026-08-17)', () => {
    assert.equal(isAlibabaModel('qwen3.8-max'), true);
  });

  it('the RETIRED Alibaba-hosted deepseek snapshot is no longer in ALIBABA_POOL — moved to DeepSeek\'s own direct API', () => {
    // Two consecutive 300s timeouts on this workspace at real review size
    // (qwen, on the identical request, succeeded both times) moved deepseek
    // off Alibaba entirely — see isDeepseekModel below, not this pool.
    assert.equal(isAlibabaModel('deepseek-v4-pro-0813'), false);
    assert.equal(isAlibabaModel('deepseek-v4-pro'), false);
  });

  it('rejects the OpenRouter-slug spelling of the SAME model — a different route, on purpose', () => {
    // Feeds the OSS auditor pool (OSS_POOL/OSS_PRICING), a totally different
    // consumption path; ALIBABA_POOL must never accidentally widen to match
    // it, or that path's routing silently changes too.
    assert.equal(isAlibabaModel('qwen/qwen3.8-max'), false);
  });

  it('rejects unrelated ids and non-string input without throwing', () => {
    assert.equal(isAlibabaModel('grok-4.6'), false);
    assert.equal(isAlibabaModel('deepseek-v4-pro'), false, 'the undated base variant is not the curated one');
    for (const v of [null, undefined, 42, {}]) assert.doesNotThrow(() => isAlibabaModel(v));
  });
});

describe('resolveAlibabaCreds — workspace endpoint has NO fallback (unlike XAI_BASE_URL)', () => {
  it('reads both halves from env with no default', () => {
    const saved = { key: process.env.ALIBABA_CLOUD_API_KEY, base: process.env.ALIBABA_CLOUD_BASE_URL };
    process.env.ALIBABA_CLOUD_API_KEY = 'test-key';
    process.env.ALIBABA_CLOUD_BASE_URL = 'https://example.invalid/compatible-mode/v1';
    try {
      assert.deepEqual(resolveAlibabaCreds(), { baseUrl: 'https://example.invalid/compatible-mode/v1', apiKey: 'test-key' });
    } finally {
      if (saved.key === undefined) delete process.env.ALIBABA_CLOUD_API_KEY; else process.env.ALIBABA_CLOUD_API_KEY = saved.key;
      if (saved.base === undefined) delete process.env.ALIBABA_CLOUD_BASE_URL; else process.env.ALIBABA_CLOUD_BASE_URL = saved.base;
    }
  });

  it('baseUrl is null (never a guessed host) when unset', () => {
    const saved = process.env.ALIBABA_CLOUD_BASE_URL;
    delete process.env.ALIBABA_CLOUD_BASE_URL;
    try {
      assert.equal(resolveAlibabaCreds().baseUrl, null);
    } finally {
      if (saved !== undefined) process.env.ALIBABA_CLOUD_BASE_URL = saved;
    }
  });
});

describe('isDeepseekModel — direct-API route, replaces the Alibaba-workspace pin (2026-08-17)', () => {
  it('accepts the two ids confirmed live on DeepSeek\'s own /models endpoint', () => {
    assert.equal(isDeepseekModel('deepseek-v4-pro'), true);
    assert.equal(isDeepseekModel('deepseek-v4-flash'), true);
  });

  it('rejects the retired Alibaba-workspace dated snapshot and the OpenRouter slug', () => {
    assert.equal(isDeepseekModel('deepseek-v4-pro-0813'), false, 'that was an Alibaba-workspace pin, not a DeepSeek id');
    assert.equal(isDeepseekModel('deepseek/deepseek-v4-pro'), false, 'the OSS-pool OpenRouter slug is a different route');
  });

  it('rejects unrelated ids and non-string input without throwing', () => {
    assert.equal(isDeepseekModel('qwen3.8-max'), false);
    for (const v of [null, undefined, 42, {}]) assert.doesNotThrow(() => isDeepseekModel(v));
  });
});

describe('resolveDeepseekCreds — a UNIVERSAL endpoint (unlike Alibaba\'s workspace), hardcoded', () => {
  it('baseUrl is always the public DeepSeek API, with no env override needed', () => {
    assert.equal(resolveDeepseekCreds().baseUrl, DEEPSEEK_BASE_URL);
    assert.equal(DEEPSEEK_BASE_URL, 'https://api.deepseek.com/v1');
  });

  it('reads the api key from env', () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    try {
      assert.equal(resolveDeepseekCreds().apiKey, 'test-key');
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});
