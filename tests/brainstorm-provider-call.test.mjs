/**
 * @fileoverview Per-provider call plan — ceiling, effort, timeout, remedy.
 *
 * Storyline field report (2026-10-01): the azure-claude voice was routinely cut
 * off at `--depth deep`. Two separable causes, both pinned here:
 *  1. No effort was sent, so Opus 5 thought at its API default (`high`).
 *  2. The shared prose budget assumes ~1.33–1.6 tokens/word; Claude measured
 *     ~2.3, so the deep ceiling held ~700 Claude words before any thinking.
 * And the truncation message told a user already at the top tier to raise
 * `--depth`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOutputBudget,
  resolveProviderCall,
  truncationRemedy,
  CLAUDE_DEPTH_TOKENS,
  CLAUDE_DEPTH_EFFORT,
  DEPTH_TOKENS,
  DEPTH_VISIBLE_TOKENS,
  CLAUDE_VISIBLE_TOKENS,
  TIMEOUT_MS_PER_TOKEN,
} from '../scripts/lib/brainstorm/depth-config.mjs';
import { _classifyCompletion as classifyOpenAI } from '../scripts/lib/brainstorm/openai-adapter.mjs';
import { ProviderResultSchema, DebateRoundSchema } from '../scripts/lib/brainstorm/schemas.mjs';

const budget = (depth, extra = {}) => resolveOutputBudget({ explicitDepth: depth, ...extra });

for (const depth of ['shallow', 'standard', 'deep']) {
  test(`${depth}: azure-claude gets an explicit effort and its own ceiling`, () => {
    const c = resolveProviderCall({ budget: budget(depth), provider: 'azure-claude' });
    assert.equal(c.reasoningEffort, CLAUDE_DEPTH_EFFORT[depth], 'never null — null means the provider default');
    assert.ok(c.reasoningEffort, 'an omitted effort is the defect this exists to prevent');
    assert.equal(c.maxTokens, CLAUDE_DEPTH_TOKENS[depth]);
    assert.ok(c.maxTokens >= DEPTH_TOKENS[depth], 'Claude prose is denser — its ceiling never shrinks below the shared one');
  });

  test(`${depth}: Claude's prose budget is denser than the shared one`, () => {
    assert.ok(CLAUDE_VISIBLE_TOKENS[depth] > DEPTH_VISIBLE_TOKENS[depth]);
  });
}

test('deep Claude ceiling clears the worst measured medium-effort call with room to spare', () => {
  // 4,423 = worst of 29 measured deep/medium calls (2026-10-01, opus-5, 1,990
  // of it thinking) — 96% of the OLD 4,600 ceiling, i.e. a near-truncation that
  // effort alone did not prevent. A ceiling change that pushes this back above
  // 80% has given the headroom away again.
  const WORST_MEASURED = 4423;
  assert.ok(WORST_MEASURED / CLAUDE_DEPTH_TOKENS.deep < 0.8, `${WORST_MEASURED / CLAUDE_DEPTH_TOKENS.deep}`);
});

test('timeout scales with EACH provider\'s own ceiling', () => {
  const claude = resolveProviderCall({ budget: budget('deep'), provider: 'azure-claude', timeoutMs: 60000 });
  const openai = resolveProviderCall({ budget: budget('deep'), provider: 'openai', timeoutMs: 60000 });
  assert.equal(claude.timeoutMs, CLAUDE_DEPTH_TOKENS.deep * TIMEOUT_MS_PER_TOKEN);
  assert.equal(openai.timeoutMs, DEPTH_TOKENS.deep * TIMEOUT_MS_PER_TOKEN);
  assert.ok(claude.timeoutMs > openai.timeoutMs, 'a Claude-sized ceiling under an OpenAI-sized timeout would abort');
});

test('--timeout-ms is honoured verbatim for every provider', () => {
  for (const provider of ['openai', 'gemini', 'azure-claude']) {
    const c = resolveProviderCall({ budget: budget('deep'), provider, explicitTimeoutMs: true, timeoutMs: 1234 });
    assert.equal(c.timeoutMs, 1234);
  }
});

test('--max-tokens overrides the ceiling for Claude too, but not its effort', () => {
  const c = resolveProviderCall({ budget: budget('deep', { explicitMaxTokens: true, maxTokens: 9000 }), provider: 'azure-claude' });
  assert.equal(c.maxTokens, 9000);
  assert.equal(c.reasoningEffort, CLAUDE_DEPTH_EFFORT.deep, 'depth always applies; --max-tokens owns only the ceiling');
  assert.match(c.truncationRemedy, /--max-tokens above 9000/);
});

test('other providers are unchanged: shared ceiling, OpenAI keeps its own effort, Gemini none', () => {
  const b = budget('shallow');
  const openai = resolveProviderCall({ budget: b, provider: 'openai' });
  const gemini = resolveProviderCall({ budget: b, provider: 'gemini' });
  assert.equal(openai.maxTokens, DEPTH_TOKENS.shallow);
  assert.equal(openai.reasoningEffort, b.reasoningEffort);
  assert.equal(gemini.maxTokens, DEPTH_TOKENS.shallow);
  assert.equal(gemini.reasoningEffort, null);
});

test('truncation remedy: next tier below deep; --max-tokens at deep and after an override', () => {
  assert.match(truncationRemedy({ depth: 'shallow', maxTokens: 2400 }), /--depth standard/);
  assert.match(truncationRemedy({ depth: 'standard', maxTokens: 3300 }), /--depth deep/);
  const top = truncationRemedy({ depth: 'deep', maxTokens: 6000 });
  assert.match(top, /top tier/);
  assert.match(top, /--max-tokens above 6000/);
  assert.doesNotMatch(top, /--depth/);
  assert.match(truncationRemedy({ depth: 'shallow', ceilingOverridden: true, maxTokens: 500 }), /--max-tokens above 500/);
});

test('openai adapter: truncation names the remedy and the reasoning share', () => {
  const r = classifyOpenAI({ text: 'partial', finishReason: 'length', maxTokens: 4600, thinkingTokens: 2000, truncationRemedy: 'X-REMEDY' });
  assert.equal(r.state, 'truncated');
  assert.match(r.errorMessage, /4600-token/);
  assert.match(r.errorMessage, /2000 of it spent on thinking/);
  assert.match(r.errorMessage, /X-REMEDY/);
});

test('thinkingTokens survives both write schemas; legacy rows without it still parse', () => {
  const base = {
    provider: 'azure-claude', state: 'truncated', text: 'x', errorMessage: 'm', httpStatus: null,
    latencyMs: 1, estimatedCostUsd: 0.01,
  };
  const withCount = { ...base, usage: { inputTokens: 1, outputTokens: 2, thinkingTokens: 1 } };
  assert.equal(ProviderResultSchema.parse(withCount).usage.thinkingTokens, 1,
    'a plain z.object strips undeclared keys — the field must be declared to persist');
  assert.equal(DebateRoundSchema.parse({ ...withCount, reactingTo: 'openai' }).usage.thinkingTokens, 1);
  assert.equal(ProviderResultSchema.parse({ ...base, usage: { inputTokens: 1, outputTokens: 2, thinkingTokens: null } }).usage.thinkingTokens, null);
  assert.ok(ProviderResultSchema.safeParse({ ...base, usage: { inputTokens: 1, outputTokens: 2 } }).success, 'pre-existing ledger rows');
});
