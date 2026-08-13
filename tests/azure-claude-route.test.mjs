/**
 * The Azure Claude route contract — endpoint, credential and auth header as ONE
 * unit.
 *
 * Regression origin (2026-08-13). `claudeBaseUrl` was hard-wired to
 * `AZURE_AI_ENDPOINT` while `anthropic-client.mjs` sniffed the credential out of
 * `AZURE_OPENAI_API_KEY` and always sent it as `Authorization: Bearer`. On a
 * tenant whose Claude is fronted by API Management those are two different
 * services, so every call shipped the APIM subscription key to the direct
 * Foundry host and came back `401` — and the APIM route was not merely
 * misconfigured but UNREPRESENTABLE: no combination of env vars reached it.
 *
 * These assertions are on the EMITTED REQUEST (URL + auth header), not on client
 * configuration: the incident's whole lesson is that a client whose config looks
 * right can still put the credential in the wrong header at the wrong host.
 * The live-verified expectations below were measured against a real APIM
 * front-end on 2026-08-13 (`api-key` accepted; Bearer rejected with "Access
 * denied due to missing subscription key").
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildAzureConfig } from '../scripts/lib/config.mjs';
import { createAnthropicClient, _resetClientCache } from '../scripts/lib/anthropic-client.mjs';
import { claudeRouteReport, describeTransportFailure, classifyAzureTransportFailure, AZURE_FAILURE_CODE } from '../scripts/lib/azure-route-report.mjs';

const APIM = 'https://tenant.azure-api.net/foundry';
const AIF = 'https://tenant.services.ai.azure.com';
const BASE = {
  AZURE_OPENAI_ENDPOINT: APIM,
  AZURE_OPENAI_API_KEY: 'apim-subscription-key',
  AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5.5',
  AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'claude-opus-4-7',
};

describe('claudeRoute resolution', () => {
  it('defaults to the foundry route when AZURE_AI_ENDPOINT is set (back-compat)', () => {
    const r = buildAzureConfig({ ...BASE, AZURE_AI_ENDPOINT: AIF }).claudeRoute;
    assert.equal(r.mode, 'foundry');
    assert.equal(r.baseUrl, `${AIF}/anthropic`);
    assert.equal(r.authMode, 'bearer');
  });

  it('defaults to the apim route when there is no AI endpoint to address', () => {
    const r = buildAzureConfig(BASE).claudeRoute;
    assert.equal(r.mode, 'apim');
    assert.equal(r.baseUrl, `${APIM}/anthropic`);
    assert.equal(r.authMode, 'api-key');
    assert.equal(r.credentialVar, 'AZURE_OPENAI_API_KEY');
    assert.equal(r.credentialShared, false);
  });

  it('AZURE_CLAUDE_ROUTE=apim wins even when AZURE_AI_ENDPOINT is present', () => {
    const r = buildAzureConfig({ ...BASE, AZURE_AI_ENDPOINT: AIF, AZURE_CLAUDE_ROUTE: 'apim' }).claudeRoute;
    assert.equal(r.mode, 'apim');
    assert.equal(r.baseUrl, `${APIM}/anthropic`);
  });

  it('the foundry route prefers a dedicated AZURE_AI_API_KEY', () => {
    const r = buildAzureConfig({ ...BASE, AZURE_AI_ENDPOINT: AIF, AZURE_AI_API_KEY: 'foundry-key' }).claudeRoute;
    assert.equal(r.apiKey, 'foundry-key');
    assert.equal(r.credentialVar, 'AZURE_AI_API_KEY');
    assert.equal(r.credentialShared, false);
  });

  // The exact configuration that produced the incident. It stays PERMITTED
  // (some tenants legitimately share one key) but must never be silent again.
  it('flags a cross-service credential fallback as shared rather than hiding it', () => {
    const r = buildAzureConfig({ ...BASE, AZURE_AI_ENDPOINT: AIF }).claudeRoute;
    assert.equal(r.credentialVar, 'AZURE_OPENAI_API_KEY');
    assert.equal(r.credentialShared, true, 'the AOAI key addressed at the Foundry host must be flagged');
  });

  it('rejects an unknown route name', () => {
    assert.throws(() => buildAzureConfig({ ...BASE, AZURE_CLAUDE_ROUTE: 'direct' }), /Invalid AZURE_CLAUDE_ROUTE/);
  });

  it('rejects AZURE_CLAUDE_ROUTE=foundry with no AZURE_AI_ENDPOINT to address', () => {
    assert.throws(() => buildAzureConfig({ ...BASE, AZURE_CLAUDE_ROUTE: 'foundry' }), /AZURE_AI_ENDPOINT/);
  });

  it('claudeBaseUrl stays in lockstep with the route it is derived from', () => {
    for (const env of [BASE, { ...BASE, AZURE_AI_ENDPOINT: AIF }]) {
      const c = buildAzureConfig(env);
      assert.equal(c.claudeBaseUrl, c.claudeRoute.baseUrl);
    }
  });
});

describe('the emitted Claude request', () => {
  beforeEach(() => _resetClientCache());

  /**
   * Capture the URL + auth headers the INSTALLED SDK actually puts on the wire.
   * The transport is injected at CONSTRUCTION — the SDK binds it there, so a
   * `globalThis.fetch` patch applied afterwards intercepts nothing and the
   * request escapes to the real network (observed while writing this suite:
   * 20s of real retries against a non-existent host, and `seen.url` undefined).
   */
  async function emitted(env) {
    const route = buildAzureConfig(env).claudeRoute;
    const seen = {};
    const client = await createAnthropicClient({
      backend: 'sdk', azureRoute: route, redactor: null,
      fetch: async (url, init) => {
        seen.url = String(url);
        const get = (k) => init?.headers?.get?.(k) ?? init?.headers?.[k] ?? null;
        seen.apiKeyHeader = get('api-key');
        seen.authorization = get('authorization');
        seen.xApiKey = get('x-api-key');
        // 200, NOT an error status: the SDK retries 5xx with backoff, so an
        // error stub turned each of these assertions into ~20s of real waiting.
        return new Response(
          JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await client.messages.create({ model: 'claude-opus-4-7', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
    return seen;
  }

  it('apim route: addresses the APIM host and carries the key in an api-key header', async () => {
    const seen = await emitted({ ...BASE, AZURE_AI_ENDPOINT: AIF, AZURE_CLAUDE_ROUTE: 'apim' });
    assert.equal(seen.url, `${APIM}/anthropic/v1/messages`);
    assert.equal(seen.apiKeyHeader, 'apim-subscription-key');
    // Bearer here is rejected by APIM with "missing subscription key" (measured).
    assert.equal(seen.authorization, null, 'APIM must not be sent a Bearer token');
  });

  it('foundry route: addresses the Foundry host and carries the key as Bearer', async () => {
    const seen = await emitted({ ...BASE, AZURE_AI_ENDPOINT: AIF, AZURE_AI_API_KEY: 'foundry-key' });
    assert.equal(seen.url, `${AIF}/anthropic/v1/messages`);
    assert.equal(seen.authorization, 'Bearer foundry-key');
    assert.equal(seen.apiKeyHeader, null, 'the Foundry host takes Bearer, not api-key');
  });

  // The defect itself: one host must never receive the other's credential.
  it('never sends the APIM subscription key to the direct Foundry host', async () => {
    const seen = await emitted({ ...BASE, AZURE_AI_ENDPOINT: AIF, AZURE_AI_API_KEY: 'foundry-key' });
    assert.ok(!JSON.stringify(seen).includes('apim-subscription-key'),
      'the AOAI/APIM key must not appear in a request to the Foundry host');
  });

  it('does not share one cached client between the two auth modes', async () => {
    _resetClientCache();
    const apim = await createAnthropicClient({
      backend: 'sdk', azureRoute: buildAzureConfig({ ...BASE, AZURE_AI_ENDPOINT: AIF, AZURE_CLAUDE_ROUTE: 'apim' }).claudeRoute,
    });
    const foundry = await createAnthropicClient({
      backend: 'sdk', azureRoute: buildAzureConfig({ ...BASE, AZURE_AI_ENDPOINT: AIF }).claudeRoute,
    });
    assert.notEqual(apim, foundry);
  });
});

describe('route reporting never leaks credentials', () => {
  it('claudeRouteReport names the source variable, not the value', () => {
    const cfg = buildAzureConfig({ ...BASE, AZURE_AI_ENDPOINT: AIF });
    const report = claudeRouteReport(cfg);
    assert.equal(report.credentialSource, 'AZURE_OPENAI_API_KEY');
    assert.equal(report.credentialPresent, true);
    assert.ok(!JSON.stringify(report).includes('apim-subscription-key'));
  });

  it('a transport failure names the failure class, the route and the credential VAR', () => {
    const cfg = buildAzureConfig({ ...BASE, AZURE_AI_ENDPOINT: AIF });
    const err = Object.assign(new Error('401 Access denied'), { status: 401 });
    const msg = describeTransportFailure(err, 'azure-claude', cfg);
    assert.match(msg, /AUTH_ENDPOINT_MISMATCH/);
    assert.match(msg, /foundry/);
    assert.match(msg, /AZURE_OPENAI_API_KEY/);
    assert.match(msg, /AZURE_CLAUDE_ROUTE=apim/, 'must point at the actual remedy');
    assert.ok(!msg.includes('apim-subscription-key'), 'must never echo the credential');
  });

  it('leaves a non-Azure provider message byte-identical', () => {
    const err = new Error('some gemini failure');
    assert.equal(describeTransportFailure(err, 'gemini'), 'some gemini failure');
  });

  it('classifies by defect, not by bare status', () => {
    assert.equal(classifyAzureTransportFailure({ status: 404 }), AZURE_FAILURE_CODE.DEPLOYMENT_ROUTE_NOT_FOUND);
    assert.equal(classifyAzureTransportFailure({ status: 401 }), AZURE_FAILURE_CODE.AUTH_ENDPOINT_MISMATCH);
    assert.equal(classifyAzureTransportFailure(new Error('ECONNREFUSED')), AZURE_FAILURE_CODE.TRANSPORT_UNAVAILABLE);
  });
});
