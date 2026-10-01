/**
 * /brainstorm's Azure second voice (Foundry Claude).
 *
 * The load-bearing assertions are on the REQUEST THE ADAPTER EMITS, not on the
 * client it built: the Anthropic SDK binds its transport at construction, so a
 * config-shaped assertion proves nothing about what leaves the process — the
 * 2026-08-13 cross-service-credential incident is exactly what that blindness
 * cost. Every case here drives an injected transport and inspects the URL,
 * headers and body.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { callAzureClaude, _classifyCompletion, _resetClient } from '../scripts/lib/brainstorm/azure-claude-adapter.mjs';
import { buildAzureConfig } from '../scripts/lib/config.mjs';
import { resolveOutputBudget, resolveProviderCall } from '../scripts/lib/brainstorm/depth-config.mjs';
import { ProviderResultSchema } from '../scripts/lib/brainstorm/schemas.mjs';

const AOAI = 'https://unit-test-aoai.openai.azure.com';
const AIF = 'https://unit-test-foundry.services.ai.azure.com';
const BASE_ENV = {
  AZURE_OPENAI_ENDPOINT: AOAI,
  AZURE_OPENAI_API_KEY: 'aoai-key-not-a-secret',
  AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-test',
  AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'claude-opus-4-7',
};

/** Capture one request and answer it with a canned Anthropic message. */
function captureTransport(reply) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { seen, fetchImpl };
}

const OK_REPLY = {
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-7',
  content: [{ type: 'text', text: 'A brainstormed view.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 120, output_tokens: 40 },
};

function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name);
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return hit ? hit[1] : null;
}

describe('azure-claude adapter — emitted request', () => {
  it('POSTs the DEPLOYMENT name as the model, to the resolved route', async () => {
    _resetClient();
    const route = buildAzureConfig({ ...BASE_ENV, AZURE_AI_ENDPOINT: AIF }).claudeRoute;
    const { seen, fetchImpl } = captureTransport(OK_REPLY);

    const r = await callAzureClaude({
      topic: 'should we cache this?',
      model: 'claude-opus-4-7',
      maxTokens: 800,
      _clientOptions: { azureRoute: route, fetch: fetchImpl, redactor: null },
    });

    assert.equal(r.state, 'success');
    assert.equal(r.provider, 'azure-claude');
    assert.equal(seen.length, 1, 'expected exactly one request');
    assert.match(seen[0].url, /\/v1\/messages$/);
    assert.ok(seen[0].url.startsWith(route.baseUrl), `request went to ${seen[0].url}, not the resolved route ${route.baseUrl}`);
    assert.equal(seen[0].body.model, 'claude-opus-4-7', 'a sentinel would 404 — the wire model must be the deployment');
    assert.equal(seen[0].body.max_tokens, 800);
    assert.equal(seen[0].body.messages[0].content, 'should we cache this?');
    assert.match(seen[0].body.system, /brainstorming partner/i, 'must carry the brainstorm prompt, not an audit prompt');
  });

  // The two routes are addressed with DIFFERENT credentials on a tenant that
  // sets a dedicated Foundry key, so each case can actually fail: sending the
  // wrong one is a bare 401 that names neither the route nor the credential
  // (the 2026-08-13 incident). `AZURE_AI_API_KEY` is honoured on the FOUNDRY
  // route only — APIM is always addressed with the AOAI key — so the fixtures
  // below are asymmetric on purpose.
  const FOUNDRY_KEY = 'foundry-dedicated-key';
  const routeFixtures = [
    {
      name: 'foundry',
      route: () => buildAzureConfig({ ...BASE_ENV, AZURE_AI_ENDPOINT: AIF, AZURE_AI_API_KEY: FOUNDRY_KEY }).claudeRoute,
      expectHost: AIF,
      expectHeader: 'authorization',
      expectKey: FOUNDRY_KEY,
      forbiddenKey: BASE_ENV.AZURE_OPENAI_API_KEY,
    },
    {
      name: 'apim',
      route: () => buildAzureConfig({ ...BASE_ENV, AZURE_AI_ENDPOINT: AIF, AZURE_CLAUDE_ROUTE: 'apim', AZURE_AI_API_KEY: FOUNDRY_KEY }).claudeRoute,
      expectHost: AOAI,
      expectHeader: 'api-key',
      expectKey: BASE_ENV.AZURE_OPENAI_API_KEY,
      forbiddenKey: FOUNDRY_KEY,
    },
  ];

  for (const f of routeFixtures) {
    it(`sends the ${f.name} route its own host, header and credential — never the other's`, async () => {
      _resetClient();
      const route = f.route();
      // Guard against a vacuous pass: if the two routes ever resolved to the
      // same credential, "the other key did not leak" would be unfalsifiable.
      assert.notEqual(route.apiKey, f.forbiddenKey, 'fixture is vacuous — the two routes share a credential');
      const { seen, fetchImpl } = captureTransport(OK_REPLY);

      await callAzureClaude({
        topic: 't', model: 'claude-opus-4-7', maxTokens: 64,
        _clientOptions: { azureRoute: route, fetch: fetchImpl, redactor: null },
      });

      assert.ok(seen[0].url.startsWith(f.expectHost), `${f.name} request went to ${seen[0].url}`);
      const carried = headerValue(seen[0].headers, f.expectHeader);
      assert.ok(carried && carried.includes(f.expectKey), `${f.expectHeader} did not carry the ${f.name} credential`);
      const allHeaders = JSON.stringify(
        seen[0].headers instanceof Headers ? Object.fromEntries(seen[0].headers) : seen[0].headers,
      );
      assert.ok(!allHeaders.includes(f.forbiddenKey), `the other route's credential was sent to ${f.expectHost}`);
    });
  }

  it('reports usage and a costed estimate from the response', async () => {
    _resetClient();
    const route = buildAzureConfig({ ...BASE_ENV, AZURE_AI_ENDPOINT: AIF }).claudeRoute;
    const { fetchImpl } = captureTransport(OK_REPLY);
    const r = await callAzureClaude({
      topic: 't', model: 'claude-opus-4-7', maxTokens: 64,
      _clientOptions: { azureRoute: route, fetch: fetchImpl, redactor: null },
    });
    // thinkingTokens null, not 0: OK_REPLY reports no split, and an absent
    // count must not be recorded as a measured zero.
    assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 40, thinkingTokens: null });
    // claude-opus-4-7 at its own published rate ($5/$25 — the old $15/$75
    // `claude-opus` family row was Opus 4.1's, retired 2026-09-23):
    // 120 * 5/1M + 40 * 25/1M = 0.0006 + 0.001
    assert.ok(Math.abs(r.estimatedCostUsd - 0.0016) < 1e-9, `unexpected cost ${r.estimatedCostUsd}`);
  });

  it('joins every text block rather than reading only the first', async () => {
    _resetClient();
    const route = buildAzureConfig({ ...BASE_ENV, AZURE_AI_ENDPOINT: AIF }).claudeRoute;
    const { fetchImpl } = captureTransport({
      ...OK_REPLY,
      content: [{ type: 'text', text: 'first half. ' }, { type: 'text', text: 'second half.' }],
    });
    const r = await callAzureClaude({
      topic: 't', model: 'claude-opus-4-7', maxTokens: 64,
      _clientOptions: { azureRoute: route, fetch: fetchImpl, redactor: null },
    });
    assert.equal(r.text, 'first half. second half.');
  });
});

describe('azure-claude adapter — completion classifier', () => {
  it('labels a max_tokens stop as truncated and KEEPS the partial text', () => {
    const r = _classifyCompletion({ text: 'half an idea', stopReason: 'max_tokens' });
    assert.equal(r.state, 'truncated');
    assert.equal(r.text, 'half an idea');
  });

  it('treats refusal as blocked, outranking the presence of text', () => {
    const r = _classifyCompletion({ text: 'some text', stopReason: 'refusal' });
    assert.equal(r.state, 'blocked');
    assert.equal(r.text, null);
  });

  it('treats whitespace-only content as empty, not success', () => {
    const r = _classifyCompletion({ text: '   \n ', stopReason: 'end_turn' });
    assert.equal(r.state, 'empty');
  });

  it('labels a normal stop as success', () => {
    const r = _classifyCompletion({ text: 'a view', stopReason: 'end_turn' });
    assert.equal(r.state, 'success');
    assert.equal(r.errorMessage, null);
  });
});

// Storyline field report (2026-10-01): with no effort sent, Opus 5 thought at
// its API default and deep rounds ran out of a 4,600 ceiling. The adapter
// discarded the thinking count, so a truncation could not say whether thinking
// or prose spent the budget, and the remedy it named ("raise --depth") does not
// exist at the top tier.
describe('azure-claude adapter — thinking budget', () => {
  const route = () => buildAzureConfig({ ...BASE_ENV, AZURE_AI_ENDPOINT: AIF }).claudeRoute;
  const deepCall = resolveProviderCall({ budget: resolveOutputBudget({ explicitDepth: 'deep' }), provider: 'azure-claude' });

  it('a max_tokens stop with heavy thinking is truncated, records the thinking, and names --max-tokens at deep', async () => {
    _resetClient();
    const { seen, fetchImpl } = captureTransport({
      ...OK_REPLY,
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'The answer begins and then' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 900, output_tokens: deepCall.maxTokens, output_tokens_details: { thinking_tokens: 3100 } },
    });
    const r = await callAzureClaude({
      topic: 't', model: 'claude-opus-5', ...deepCall,
      _clientOptions: { azureRoute: route(), fetch: fetchImpl, redactor: null },
    });

    assert.equal(r.state, 'truncated');
    assert.equal(r.text, 'The answer begins and then', 'only text blocks reach the user — never thinking');
    assert.equal(r.usage.thinkingTokens, 3100);
    assert.match(r.errorMessage, /3100 of it spent on thinking/);
    assert.match(r.errorMessage, /--max-tokens above 6000/, 'deep is the top tier — the remedy must be --max-tokens');
    assert.doesNotMatch(r.errorMessage, /--depth/, '"raise --depth" is unactionable at deep');
    // And the request that produced it carried an explicit effort, so the
    // provider default can no longer decide how much of the ceiling thinking eats.
    assert.deepEqual(seen[0].body.output_config, { effort: 'medium' });
    assert.equal(seen[0].body.max_tokens, 6000);
    // The count must survive the write boundary, not just the adapter.
    assert.equal(ProviderResultSchema.parse(r).usage.thinkingTokens, 3100);
  });

  it('below the top tier, the remedy is the next --depth', async () => {
    _resetClient();
    const standard = resolveProviderCall({ budget: resolveOutputBudget({ explicitDepth: 'standard' }), provider: 'azure-claude' });
    const { fetchImpl } = captureTransport({ ...OK_REPLY, stop_reason: 'max_tokens' });
    const r = await callAzureClaude({
      topic: 't', model: 'claude-opus-5', ...standard,
      _clientOptions: { azureRoute: route(), fetch: fetchImpl, redactor: null },
    });
    assert.equal(r.state, 'truncated');
    assert.match(r.errorMessage, /--depth deep/);
    assert.doesNotMatch(r.errorMessage, /spent on thinking/, 'no count reported ⇒ no thinking claim');
  });

  it('retries once WITHOUT effort when the deployment rejects the field', async () => {
    _resetClient();
    const seen = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init?.body ?? '{}');
      seen.push(body);
      if (body.output_config) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: Extra inputs are not permitted' } }),
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(OK_REPLY), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const r = await callAzureClaude({
      topic: 't', model: 'claude-sonnet-4-5', maxTokens: 64, reasoningEffort: 'medium',
      _clientOptions: { azureRoute: route(), fetch: fetchImpl, redactor: null, maxRetries: 0 },
    });
    assert.equal(r.state, 'success');
    assert.equal(seen.length, 2);
    assert.ok(seen[0].output_config, 'first attempt must carry the effort');
    assert.equal(seen[1].output_config, undefined, 'the retry must drop it');
  });

  it('does NOT retry an unrelated 400', async () => {
    _resetClient();
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: roles must alternate' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    };
    const r = await callAzureClaude({
      topic: 't', model: 'claude-opus-5', maxTokens: 64, reasoningEffort: 'medium',
      _clientOptions: { azureRoute: route(), fetch: fetchImpl, redactor: null, maxRetries: 0 },
    });
    assert.equal(r.state, 'http_error');
    assert.equal(calls, 1);
  });

  it('omits output_config when no effort is given (byte-identical request)', async () => {
    _resetClient();
    const { seen, fetchImpl } = captureTransport(OK_REPLY);
    await callAzureClaude({
      topic: 't', model: 'claude-opus-5', maxTokens: 64,
      _clientOptions: { azureRoute: route(), fetch: fetchImpl, redactor: null },
    });
    assert.equal(seen[0].body.output_config, undefined);
  });
});
