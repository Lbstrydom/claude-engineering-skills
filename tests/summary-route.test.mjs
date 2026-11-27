/**
 * The arch-index summariser's route oracle (lib/summary-route.mjs) and the
 * Azure-GPT call path. Pins: public profile unchanged (Claude), Azure defaults
 * to the profile's GPT deployment, AZURE_SUMMARY_BACKEND=claude keeps Foundry
 * Claude, a typo fails loud, GPT's `length` reads as truncation, and the prompt
 * tells the model to summarise cut-off bodies (2026-11-27: 12/50 `<no body>`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSummaryRoute, summariserAvailability, normaliseStopReason, callAzureGptSummary,
} from '../scripts/lib/summary-route.mjs';
import { buildSummaryPrompt, assessBatchCompleteness } from '../scripts/symbol-index/summarise.mjs';

const PUBLIC = Object.freeze({ active: false, gptDeployment: null, summaryDeployment: 'claude-sonnet-5-5', claudeRoute: null });
const AZURE = Object.freeze({
  active: true, gptDeployment: 'gpt-tenant', summaryDeployment: 'claude-sonnet-5-5',
  claudeRoute: { baseUrl: 'https://x.invalid/anthropic', apiKey: 'k', authMode: 'bearer', credentialVar: 'AZURE_AI_API_KEY' },
});

describe('resolveSummaryRoute', () => {
  it('public profile: Claude, unchanged', () => {
    assert.deepEqual(resolveSummaryRoute({ azure: PUBLIC, env: {} }), { kind: 'anthropic', model: null });
  });
  it('public profile ignores AZURE_SUMMARY_BACKEND', () => {
    assert.equal(resolveSummaryRoute({ azure: PUBLIC, env: { AZURE_SUMMARY_BACKEND: 'claude' } }).kind, 'anthropic');
  });
  it('Azure profile defaults to the GPT deployment', () => {
    assert.deepEqual(resolveSummaryRoute({ azure: AZURE, env: {} }), { kind: 'azure-gpt', model: 'gpt-tenant' });
  });
  it('AZURE_SUMMARY_BACKEND=claude selects Foundry Claude (case-insensitive)', () => {
    assert.deepEqual(resolveSummaryRoute({ azure: AZURE, env: { AZURE_SUMMARY_BACKEND: ' Claude ' } }),
      { kind: 'azure-claude', model: 'claude-sonnet-5-5' });
  });
  it('a typo fails loud instead of picking a route', () => {
    assert.throws(() => resolveSummaryRoute({ azure: AZURE, env: { AZURE_SUMMARY_BACKEND: 'gtp' } }), /Invalid AZURE_SUMMARY_BACKEND="gtp"/);
  });
});

describe('summariserAvailability', () => {
  it('Azure GPT is available by construction', () => {
    assert.deepEqual(summariserAvailability({ azure: AZURE, env: {} }), { available: true, route: 'azure-gpt', reason: null });
  });
  it('Azure Claude without a Foundry route is unavailable, with a reason', () => {
    const r = summariserAvailability({ azure: { ...AZURE, claudeRoute: null }, env: { AZURE_SUMMARY_BACKEND: 'claude' } });
    assert.equal(r.available, false);
    assert.match(r.reason, /no Foundry Claude route/);
  });
  it('public profile asks the Claude backend oracle, both directions', () => {
    assert.equal(summariserAvailability({ azure: PUBLIC, env: {}, claudeAvailable: () => true }).available, true);
    const no = summariserAvailability({ azure: PUBLIC, env: {}, claudeAvailable: () => false });
    assert.equal(no.available, false);
    assert.match(no.reason, /no Claude provider/);
  });
  it('an invalid backend is unavailable, not a throw', () => {
    const r = summariserAvailability({ azure: AZURE, env: { AZURE_SUMMARY_BACKEND: 'x' } });
    assert.equal(r.available, false);
    assert.match(r.reason, /Invalid AZURE_SUMMARY_BACKEND/);
  });
});

describe('truncation across providers', () => {
  it("GPT's finish_reason 'length' normalises to max_tokens", () => {
    assert.equal(normaliseStopReason('length'), 'max_tokens');
    assert.equal(normaliseStopReason('stop'), 'stop');
    assert.equal(normaliseStopReason(null), undefined);
  });
  it("a fully populated batch with stop 'length' is NOT complete", () => {
    const h = assessBatchCompleteness(['a', 'b'], 'length');
    assert.equal(h.complete, false);
    assert.equal(h.truncated, true);
  });
});

describe('callAzureGptSummary — the emitted request', () => {
  function fakeClient(response) {
    const calls = [];
    return { calls, chat: { completions: { create: async (p) => { calls.push(p); return response; } } } };
  }
  it('sends the deployment and max_completion_tokens (never max_tokens)', async () => {
    const c = fakeClient({ choices: [{ message: { content: '1. does x' }, finish_reason: 'stop' }] });
    const out = await callAzureGptSummary({ model: 'gpt-tenant' }, 'PROMPT', 512, c);
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].model, 'gpt-tenant');
    assert.equal(c.calls[0].max_completion_tokens, 2048, 'floored: a reasoning model must not be starved on a 1-symbol re-ask');
    assert.equal('max_tokens' in c.calls[0], false);
    assert.deepEqual(c.calls[0].messages, [{ role: 'user', content: 'PROMPT' }]);
    assert.deepEqual(out, { text: '1. does x', stopReason: 'stop', usage: null }, 'no provider usage → null, not a fabricated 0');
  });
  it('a budget above the floor passes through unchanged', async () => {
    const c = fakeClient({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
    await callAzureGptSummary({ model: 'm' }, 'p', 12800, c);
    assert.equal(c.calls[0].max_completion_tokens, 12800);
  });
  it('reports provider usage when present', async () => {
    const c = fakeClient({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    assert.deepEqual((await callAzureGptSummary({ model: 'm' }, 'p', 1, c)).usage, { inputTokens: 7, outputTokens: 3 });
  });
  it('a content_filter stop throws FILTERED instead of returning partial text', async () => {
    const c = fakeClient({ choices: [{ message: { content: 'A plausible looking partial summary' }, finish_reason: 'content_filter' }] });
    await assert.rejects(callAzureGptSummary({ model: 'm' }, 'p', 1, c), (e) => e.code === 'FILTERED');
  });
  it("reports a 'length' cut as max_tokens", async () => {
    const c = fakeClient({ choices: [{ message: { content: '1. a' }, finish_reason: 'length' }] });
    assert.equal((await callAzureGptSummary({ model: 'm' }, 'p', 1, c)).stopReason, 'max_tokens');
  });
});

describe('callAzureGptSummary — egress redaction of the WHOLE prompt', () => {
  it('redacts a secret in an interpolated symbol name / path, not only bodies', async () => {
    const calls = [];
    const c = { chat: { completions: { create: async (p) => { calls.push(p); return { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }; } } } };
    // Built at runtime (a 32-char opaque token the sanitizer redacts), so no
    // credential-shaped literal sits in this public repo for scanners to flag.
    const secret = ['tok', 'Q7x'.repeat(10), 'Z9'].join('');
    const prompt = buildSummaryPrompt([{ kind: 'function', symbolName: secret, filePath: `src/${secret}.mjs`, startLine: 1, endLine: 1, bodyText: 'x' }]);
    assert.ok(prompt.includes(secret), 'precondition: the prompt carries the secret unredacted');
    await callAzureGptSummary({ model: 'm' }, prompt, 10, c);
    const sent = calls[0].messages[0].content;
    assert.ok(!sent.includes(secret), 'the emitted request must not carry it');
    assert.ok(sent.includes('[REDACTED_TOKEN]'), 'and carries the redaction marker in its place');
  });
});

describe('an invalid AZURE_SUMMARY_BACKEND stops the run', () => {
  it('summariserAvailability flags it as a config error, not plain unavailability', () => {
    const r = summariserAvailability({ azure: AZURE, env: { AZURE_SUMMARY_BACKEND: 'gtp' } });
    assert.equal(r.configError, true);
  });
  it('the summarise CLI exits non-zero with the diagnostic, before reading input', async () => {
    const { spawnSync } = await import('node:child_process');
    const path = await import('node:path');
    const cli = path.join(import.meta.dirname, '..', 'scripts', 'symbol-index', 'summarise.mjs');
    const r = spawnSync(process.execPath, [cli], {
      input: '', encoding: 'utf-8', timeout: 60_000,
      env: {
        ...process.env, LEARNING_DISABLE: '1',
        AZURE_OPENAI_ENDPOINT: 'https://example.invalid', AZURE_OPENAI_API_KEY: 'test-not-a-key',
        AZURE_OPENAI_GPT_DEPLOYMENT: 'g', AZURE_SUMMARY_BACKEND: 'gtp',
      },
    });
    assert.equal(r.status, 1, `stderr=${r.stderr}`);
    assert.match(r.stderr, /Invalid AZURE_SUMMARY_BACKEND="gtp"/);
  });
});

describe('summarise-domains cache identity follows the generating model', async () => {
  const { generationModelId } = await import('../scripts/symbol-index/summarise-domains.mjs');
  it('each route yields a distinct id, so a backend switch misses the cache', () => {
    const az = { openaiEndpoint: 'https://res-a.openai.azure.com/', claudeRoute: { baseUrl: 'https://res-a.services.ai.azure.com/anthropic' } };
    const pub = generationModelId({ kind: 'anthropic', model: null }, 'claude-haiku-x', az);
    const gpt = generationModelId({ kind: 'azure-gpt', model: 'gpt-tenant' }, 'claude-haiku-x', az);
    const cla = generationModelId({ kind: 'azure-claude', model: 'claude-sonnet-5-5' }, 'claude-haiku-x', az);
    assert.equal(pub, 'claude-haiku-x');
    assert.equal(gpt, 'azure-gpt:res-a.openai.azure.com:gpt-tenant');
    assert.equal(cla, 'azure-claude:res-a.services.ai.azure.com:claude-sonnet-5-5');
    assert.equal(new Set([pub, gpt, cla]).size, 3);
    assert.notEqual(generationModelId({ kind: 'azure-gpt', model: 'a' }, 'h', az), generationModelId({ kind: 'azure-gpt', model: 'b' }, 'h', az));
  });
  it('the same deployment name on another Azure resource is a different identity', () => {
    const a = generationModelId({ kind: 'azure-gpt', model: 'gpt-tenant' }, 'h', { openaiEndpoint: 'https://res-a.openai.azure.com' });
    const b = generationModelId({ kind: 'azure-gpt', model: 'gpt-tenant' }, 'h', { openaiEndpoint: 'https://res-b.openai.azure.com' });
    assert.notEqual(a, b);
  });
});

describe('summarise-domains refuses a truncated summary', async () => {
  const { assertNotTruncated } = await import('../scripts/symbol-index/summarise-domains.mjs');
  it('max_tokens throws TRUNCATED; a normal stop passes', () => {
    assert.throws(() => assertNotTruncated('max_tokens'), (e) => e.code === 'TRUNCATED');
    assert.doesNotThrow(() => assertNotTruncated('stop'));
    assert.doesNotThrow(() => assertNotTruncated('end_turn'));
  });
});

describe('buildSummaryPrompt — cut-off bodies', () => {
  const sym = (bodyText) => ({ kind: 'function', symbolName: 'f', filePath: 'a.mjs', startLine: 1, endLine: 2, bodyText });
  it('tells the model to summarise a cut-off body, and <no body> only for an empty one', () => {
    const p = buildSummaryPrompt([sym('x')]);
    assert.match(p, /cut off: summarise a cut-off body from the part shown/);
    assert.match(p, /"<no body>" only when a body is genuinely empty/);
    assert.doesNotMatch(p, /unparseable/, 'the wording that made GPT drop long bodies is gone');
  });
  it('still slices each body to 1500 chars', () => {
    const p = buildSummaryPrompt([sym('a'.repeat(4000))]);
    assert.equal((p.match(/a+/g) || []).reduce((m, s) => Math.max(m, s.length), 0), 1500);
  });
});
