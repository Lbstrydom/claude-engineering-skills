// Every OpenAI / Anthropic id the resolver can hand out offline must carry ITS
// OWN price row — not the family fallback. The 2026-09-23 refresh is why: the
// family row had been the only row, priced at a retired generation ($15/$75
// for `claude-opus` when Opus 5.5 is $4/$20; $2.50/$10 for `gpt-5` while
// `latest-gpt` resolved to gpt-6-astra at $10/$50), and nothing failed because
// a fallback reads as priced. This test iterates the POOL — the side a price
// table cannot see — so adding a pool entry without a row fails at push.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATIC_POOL, pricingKey, resolveModel, _resetCatalogCache, parseOpenAIModel } from '../scripts/lib/model-resolver.mjs';
import { modelPricing } from '../scripts/lib/model-pricing-table.mjs';
import { pricingKeys, priceFor, isPriced, costFromUsage, costForBudget } from '../scripts/lib/model-pricing.mjs';

/** The key `priceFor` lands on for an id — the first of pricingKeys() present in the table. */
function landingKey(id) {
  return pricingKeys(id).find((k) => Object.hasOwn(modelPricing, k)) ?? null;
}

describe('model pricing — STATIC_POOL coverage (2026-09-23)', () => {
  it('every OpenAI and Anthropic STATIC_POOL id lands on a version+SKU row, never the family fallback', () => {
    const offenders = [];
    for (const provider of ['openai', 'anthropic']) {
      for (const id of STATIC_POOL[provider]) {
        const key = landingKey(id);
        if (!key || key === pricingKey(id)) offenders.push(`${id} → ${key ?? 'UNPRICED'}`);
      }
    }
    assert.deepEqual(offenders, [], `pool ids priced by the coarse family row (or not at all): ${offenders.join(', ')}`);
  });

  it('every sentinel the offline resolver can return is priced', () => {
    _resetCatalogCache();
    for (const s of ['latest-gpt', 'latest-gpt-mini', 'latest-opus', 'latest-sonnet', 'latest-haiku', 'latest-pro', 'latest-flash', 'latest-flash-lite']) {
      const id = resolveModel(s, { silent: true });
      assert.equal(isPriced(id), true, `${s} → ${id} must be priced`);
    }
  });

  it('the user-facing claim that motivated the refresh: gpt-6-sol is cheaper than gpt-5.6-terra, and latest-gpt now resolves to it', () => {
    _resetCatalogCache();
    const sol = priceFor('gpt-6-sol', { inputTokens: 1000 });
    const terra = priceFor('gpt-5.6-terra', { inputTokens: 1000 });
    assert.equal(sol.input, terra.input, '$2 in on both');
    assert.ok(sol.output < terra.output, `$${sol.output} out on gpt-6-sol vs $${terra.output} on gpt-5.6-terra`);
    assert.equal(resolveModel('latest-gpt', { silent: true }), 'gpt-6-sol');
  });

  it('two SKUs of one family never share a rate — astra vs sol vs luna at major 6', () => {
    const [astra, sol, luna] = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].map((id) => priceFor(id, { inputTokens: 1000 }));
    assert.ok(astra.input > sol.input && sol.input > luna.input);
    assert.ok(astra.output > sol.output && sol.output > luna.output);
    assert.equal(pricingKey('gpt-6-astra'), pricingKey('gpt-6-sol'), 'same family key — which is exactly why the family key alone cannot be the price');
  });

  it('OpenAI 5.6/6 rows are prompt-size tiered at 272K: a long-context call bills at the long rate', () => {
    const short = priceFor('gpt-6-sol', { inputTokens: 272_000 });
    const long = priceFor('gpt-6-sol', { inputTokens: 272_001 });
    assert.equal(short.input, 2.00);
    assert.equal(long.input, 4.00);
    assert.equal(long.output, 15.00);
    const r = costForBudget({ input_tokens: 300_000, output_tokens: 0 }, 'gpt-6-sol');
    assert.equal(r.estimated, false);
    assert.equal(r.totalUsd, 300_000 * 4.00 / 1_000_000, 'the spend-cap path reserves at the long-context rate');
  });

  it('an unlisted PREMIUM OpenAI SKU is unpriced (null), not silently priced at the balanced family rate', () => {
    assert.equal(parseOpenAIModel('gpt-5.5-pro').isPremium, true, 'precondition: the fixture is a premium SKU');
    assert.equal(Object.hasOwn(modelPricing, 'gpt-5.5-pro'), false, 'precondition: no row of its own');
    assert.equal(priceFor('gpt-5.5-pro'), null);
    assert.equal(costFromUsage({ input_tokens: 10, output_tokens: 10 }, 'gpt-5.5-pro').priced, false);
    assert.equal(costForBudget({ input_tokens: 10, output_tokens: 10 }, 'gpt-5.5-pro').estimated, true, 'the spend cap over-estimates instead');
  });

  it('an unlisted NON-premium SKU still takes the family fallback (an operator pin the table has never seen)', () => {
    assert.equal(Object.hasOwn(modelPricing, 'gpt-5.7-terra'), false, 'precondition');
    assert.deepEqual(priceFor('gpt-5.7-terra'), modelPricing['gpt-5']);
  });

  it('Claude rows: Opus 5.5 is cheaper than Opus 5, and its 0.05x cache read is a real rate, not the 0.10x multiplier', () => {
    const o55 = priceFor('claude-opus-5-5');
    const o5 = priceFor('claude-opus-5');
    assert.ok(o55.input < o5.input && o55.output < o5.output);
    const hit = costFromUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, 'claude-opus-5-5');
    assert.equal(hit.inputUsd, 0.20, '$0.20/MTok cache read (0.05 x $4), not $0.40 (0.10 x $4)');
    const hit5 = costFromUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, 'claude-opus-5');
    assert.equal(hit5.inputUsd, 0.50, 'Opus 5 keeps the standard 0.10x multiplier');
    assert.deepEqual(priceFor('claude-sonnet-5'), { input: 2, output: 10 });
  });

  it('the family fallbacks err HIGH for the current generation, never low', () => {
    // A fallback that under-prices is the one shape the spend cap exists to
    // prevent; the family row must sit at or above every current row's rate.
    for (const [family, members] of [
      ['claude-opus', ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']],
      ['claude-sonnet', ['claude-sonnet-5', 'claude-sonnet-4-6']],
      ['claude-haiku', ['claude-haiku-4-5']],
    ]) {
      for (const id of members) {
        const px = priceFor(id);
        assert.ok(modelPricing[family].input >= px.input && modelPricing[family].output >= px.output, `${family} fallback must not under-price ${id}`);
      }
    }
  });
});
