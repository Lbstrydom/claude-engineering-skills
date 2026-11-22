import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalReviewCostUsd } from '../scripts/lib/telemetry/final-review-call.mjs';
import { costFromUsage } from '../scripts/lib/model-pricing.mjs';

const MODEL = 'gpt-5.4';

test('prices a review call and folds thinking tokens into output', () => {
  const usage = { input_tokens: 10000, output_tokens: 2000, thinking_tokens: 3000 };
  const expected = costFromUsage({ input_tokens: 10000, output_tokens: 5000 }, MODEL).totalUsd;
  assert.ok(typeof expected === 'number' && expected > 0, 'control: model must be priced');
  assert.equal(finalReviewCostUsd(usage, MODEL), expected);
  assert.ok(finalReviewCostUsd(usage, MODEL) > finalReviewCostUsd({ ...usage, thinking_tokens: 0 }, MODEL));
});

test('unmetered usage is null, never a fabricated 0', () => {
  assert.equal(finalReviewCostUsd(null, MODEL), null);
  assert.equal(finalReviewCostUsd({}, MODEL), null);
  assert.equal(finalReviewCostUsd({ usageMissing: true, input_tokens: 5, output_tokens: 5 }, MODEL), null);
});

test('unpriced model is null', () => {
  assert.equal(finalReviewCostUsd({ input_tokens: 10, output_tokens: 10 }, 'no-such-model-xyz'), null);
});
