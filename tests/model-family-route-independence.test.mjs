/**
 * @fileoverview Tier 1 regression: a model's FAMILY must not depend on the
 * route it was reached by, while its ID still must.
 *
 * **The defect (measured 2026-08-23 against the live store).** This repo
 * deliberately reaches some models two ways — the bare native id and the
 * OpenRouter `vendor/model` slug — and both spellings are load-bearing:
 * `transportForModel` dispatches on exactly that shape, and `model-pricing`
 * keys prices on the verbatim id because the routes bill differently
 * (`qwen3.8-max` native at $2.00/$6.00 per 1M vs `qwen/qwen3.7-max` at
 * $1.25/$3.75). So `audit_findings.source_model` must keep BOTH.
 *
 * What must not vary is the family. `isSelfFamily` derived the vendor from
 * whichever half of the id happened to be there — the namespace when a `/`
 * was present, otherwise the head before the first `-`/`.` — so:
 *
 *   | pair                                    | before | after |
 *   |-----------------------------------------|--------|-------|
 *   | qwen3.8-max      / qwen/qwen3.8-max     | false  | true  |
 *   | kimi-k2-thinking / moonshotai/kimi-k2-… | false  | true  |
 *   | glm-5.2          / z-ai/glm-5.2         | false  | true  |
 *   | deepseek-v4-pro  / deepseek/deepseek-v4-pro | true (luck) | true |
 *
 * `self_family` is the ONLY field recording whether a model graded its own
 * output, and every `false` above is a confident wrong answer, not an
 * abstention — the bias the column exists to surface, reported as absent.
 * The deepseek row is why one spot-check would have cleared this: its vendor
 * slug coincidentally equals the head of its bare id.
 *
 * **Both directions are asserted.** A fix that widens matching until
 * everything is self-family would "pass" the table above while destroying the
 * signal, so the must-NOT-fire cases carry equal weight here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelFamily, MODEL_VENDORS,
  STATIC_POOL, OSS_POOL, XAI_POOL, ALIBABA_POOL, DEEPSEEK_POOL,
} from '../scripts/lib/model-resolver.mjs';
import { OSS_PRICING } from '../scripts/lib/model-pricing.mjs';
import { isSelfFamily } from '../scripts/lib/store/campaign.mjs';

describe('modelFamily — route- and version-independent vendor identity', () => {
  it('resolves the same family for both routes to one model', () => {
    // Exactly the pairs the live store holds, plus the two rotation arms.
    for (const [bare, slug] of [
      ['qwen3.8-max', 'qwen/qwen3.8-max'],
      ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
      ['kimi-k2-thinking', 'moonshotai/kimi-k2-thinking'],
      ['glm-5.2', 'z-ai/glm-5.2'],
    ]) {
      assert.equal(modelFamily(bare), modelFamily(slug), `${bare} vs ${slug}`);
    }
  });

  it('does not let a version digit split a family', () => {
    // The mechanism that broke qwen specifically: the digit rides in the bare
    // id but never in the vendor slug.
    assert.equal(modelFamily('qwen3.8-max'), 'qwen');
    assert.equal(modelFamily('qwen/qwen4-max'), 'qwen');
    assert.equal(modelFamily('qwen3.8-max'), modelFamily('qwen/qwen4-max'));
  });

  it('keeps genuinely different vendors apart', () => {
    // The must-NOT-fire direction. A fix that collapses these has destroyed
    // the signal while passing every case above.
    const families = ['claude-opus-5', 'gemini-pro-latest', 'gpt-5.6-terra', 'grok-4.6',
      'qwen/qwen3.8-max', 'deepseek-v4-pro', 'moonshotai/kimi-k2-thinking', 'z-ai/glm-5.2']
      .map(modelFamily);
    assert.equal(new Set(families).size, families.length,
      `all eight vendors must stay distinct, got ${JSON.stringify(families)}`);
  });

  it('abstains rather than guessing on an absent id', () => {
    for (const bad of [null, undefined, '', '   ', 42, {}]) {
      assert.equal(modelFamily(bad), null, `${JSON.stringify(bad)} must be null`);
    }
  });

  it('keeps two arms from ONE vendor together, whatever their model names', () => {
    // The case a namespace-stripping "fix" breaks, and the one that matters
    // most once a campaign runs several arms per vendor: an adjudicator and an
    // arm from the same vendor are the same bias question even when they are
    // different models. Asserted for both spellings of the vendor.
    assert.equal(isSelfFamily('moonshotai/kimi-k2', 'moonshotai/other'), true);
    assert.equal(isSelfFamily('qwen/qwen3-coder', 'qwen/qwen3.7-max'), true);
    assert.equal(isSelfFamily('z-ai/glm-4.6', 'z-ai/glm-5.3'), true);
    assert.equal(isSelfFamily('deepseek/deepseek-r1', 'deepseek-v4-flash'), true);
    assert.equal(isSelfFamily('claude-opus-4-8', 'claude-sonnet-5'), true);
    assert.equal(isSelfFamily('gpt-5.6-terra', 'gpt-5.5-pro'), true);
  });

  it('every model the repo routes to resolves to a KNOWN vendor', () => {
    // The gate that makes "add an arm" two edits instead of one. A new pool
    // entry whose vendor is not in VENDOR_ALIASES falls through to an
    // un-canonicalised token, which silently stops matching that vendor's
    // other spelling — the original defect, one vendor over. This fails here
    // instead.
    const ids = [
      ...Object.values(STATIC_POOL).flat(), ...Object.values(OSS_POOL).flat(),
      ...XAI_POOL, ...ALIBABA_POOL, ...DEEPSEEK_POOL, ...Object.keys(OSS_PRICING),
    ];
    assert.ok(ids.length >= 25, `vacuous-pass guard: expected the real pools, saw ${ids.length} ids`);
    const vendors = new Set(MODEL_VENDORS);
    const orphans = [...new Set(ids)].filter((id) => !vendors.has(modelFamily(id)));
    assert.deepEqual(orphans, [],
      `these ids resolve outside MODEL_VENDORS — add their vendor to VENDOR_ALIASES: ${JSON.stringify(orphans)}`);
  });

  it('never invents a family from a stray separator', () => {
    // An all-digit head keeps its digits — stripping would leave nothing, and
    // an empty family compared against another empty family is a false `true`.
    assert.equal(modelFamily('123-foo'), '123');
    assert.notEqual(modelFamily('123-foo'), '');
  });
});

describe('isSelfFamily — the bias flag reads through both routes', () => {
  it('flags a model judging its own output across routes', () => {
    assert.equal(isSelfFamily('qwen3.8-max', 'qwen/qwen3.8-max'), true);
    assert.equal(isSelfFamily('moonshotai/kimi-k2-thinking', 'kimi-k2-thinking'), true);
    assert.equal(isSelfFamily('z-ai/glm-5.2', 'glm-5.2'), true);
    assert.equal(isSelfFamily('deepseek-v4-pro', 'deepseek/deepseek-v4-pro'), true);
  });

  it('still reports false for a cross-vendor adjudication', () => {
    assert.equal(isSelfFamily('claude-opus-5', 'qwen/qwen3.8-max'), false);
    assert.equal(isSelfFamily('gemini-pro-latest', 'z-ai/glm-5.2'), false);
    assert.equal(isSelfFamily('gpt-5.6-terra', 'moonshotai/kimi-k2-thinking'), false);
  });

  it('returns null — not false — when either side is unknown', () => {
    // A confident `false` on missing data is the shape of the whole defect:
    // it is indistinguishable from a measured "no bias here".
    assert.equal(isSelfFamily(null, 'qwen3.8-max'), null);
    assert.equal(isSelfFamily('qwen3.8-max', undefined), null);
    assert.equal(isSelfFamily('', ''), null);
  });
});
