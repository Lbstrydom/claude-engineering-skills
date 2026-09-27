/**
 * The `cli` Anthropic backend self-reports its exact cost (`claude -p`'s
 * `total_cost_usd`). AGENTS.md says to use it, but it only ever reached
 * `_meta.cost_usd`, which nothing but `anthropic-ping.mjs` read — so a usage
 * event priced the call from tokens instead of the CLI's exact figure. The
 * first test failed before the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/lib/anthropic-client.mjs';
import { buildUsageEvent } from '../scripts/lib/audit/usage-event.mjs';

const { normaliseCliOutput } = _internals;
const CREATED_AT = '2026-09-27T00:00:00.000Z';

const cliStdout = (extra = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'hi',
  usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 90000 },
  total_cost_usd: 0.0421, duration_ms: 900, num_turns: 1, ...extra,
});

test('cli backend: the self-reported cost reaches the usage event as an EXACT cost, not a token estimate', () => {
  const resp = normaliseCliOutput(cliStdout(), 'claude-opus-5-5');
  const ev = buildUsageEvent({ provider: 'anthropic', modelSentinel: 'latest-opus', resolvedModel: 'claude-opus-5-5', usage: resp.usage }, CREATED_AT);
  assert.equal(ev.costAmountUsd, 0.0421);
  assert.equal(ev.usageReliability, 'exact');
  assert.equal(ev.inputTokens, 12);
  assert.equal(resp._meta.cost_usd, 0.0421, '_meta stays for anthropic-ping');
});

test('cli backend: an envelope with no total_cost_usd falls back to token pricing — never a fabricated exact $0', () => {
  const resp = normaliseCliOutput(cliStdout({ total_cost_usd: undefined }), 'claude-opus-5-5');
  assert.equal('provider_cost_usd' in resp.usage, false);
  const ev = buildUsageEvent({ provider: 'anthropic', modelSentinel: 'latest-opus', resolvedModel: 'claude-opus-5-5', usage: resp.usage }, CREATED_AT);
  assert.equal(ev.usageReliability, 'estimated');
});

test('buildUsageEvent: an explicit selfReportedCostUsd still wins over usage.provider_cost_usd', () => {
  const ev = buildUsageEvent({ provider: 'oss', modelSentinel: 'm', resolvedModel: 'm', usage: { input_tokens: 1, output_tokens: 1, provider_cost_usd: 9 }, selfReportedCostUsd: 0.5 }, CREATED_AT);
  assert.equal(ev.costAmountUsd, 0.5);
});

test('buildUsageEvent: the sdk backend (no self-reported cost) is unchanged — priced from tokens', () => {
  const ev = buildUsageEvent({ provider: 'anthropic', modelSentinel: 'latest-opus', resolvedModel: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 100 } }, CREATED_AT);
  assert.equal(ev.usageReliability, 'estimated');
  assert.ok(ev.costAmountUsd > 0);
});
