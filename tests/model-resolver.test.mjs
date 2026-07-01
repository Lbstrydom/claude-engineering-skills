import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATIC_POOL, DEPRECATED_REMAP, SENTINEL_TO_TIER, OSS_POOL,
  isSentinel, parseClaudeModel, parseGeminiModel, parseOpenAIModel,
  pickNewestClaude, pickNewestGemini, pickNewestOpenAI,
  deprecatedRemap, resolveModel, setCatalog, _resetCatalogCache,
  supportsReasoningEffort, pricingKey,
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
