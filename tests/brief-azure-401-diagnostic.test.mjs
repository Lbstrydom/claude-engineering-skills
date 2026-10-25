/**
 * The brief step's Haiku leg on an Azure tenant that sets BOTH endpoints.
 *
 * Regression origin (ai-organiser, 21-25 Oct 2026): every audit logged
 * "Claude Haiku brief 401" and the step silently never ran. Offline repro of
 * that tenant's env: AZURE_AI_ENDPOINT set (-> foundry route, Bearer) with no
 * AZURE_AI_API_KEY, so the route falls back to the APIM subscription key
 * (`credentialShared`) and sends it to the direct Foundry host, which rejects it.
 * The failure line named neither the host nor the credential variable, so it
 * read as noise. Assertions are on the EMITTED request and on the rendered
 * failure text — never on credential values.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildAzureConfig } from '../scripts/lib/config.mjs';
import { createAnthropicClient, _resetClientCache } from '../scripts/lib/anthropic-client.mjs';
import { describeBriefClaudeFailure } from '../scripts/lib/context.mjs';

const AIF = 'https://tenant.services.ai.azure.com';
const KEY = 'apim-subscription-key-DO-NOT-LEAK';
const AIO_SHAPE = {
  AZURE_OPENAI_ENDPOINT: 'https://tenant.azure-api.net/foundry',
  AZURE_OPENAI_API_KEY: KEY,
  AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5.5',
  AZURE_AI_ENDPOINT: AIF,
};

describe('brief Haiku leg on a both-endpoints Azure tenant', () => {
  beforeEach(() => _resetClientCache());

  it('emits the shared APIM key as Bearer at the Foundry host (the 401 shape)', async () => {
    const route = buildAzureConfig(AIO_SHAPE).claudeRoute;
    assert.equal(route.credentialShared, true);
    let seen;
    const client = await createAnthropicClient({
      azureRoute: route,
      fetch: async (url, init) => {
        seen = { url: String(url), headers: new Headers(init.headers) };
        return new Response('{"error":{"message":"denied"}}', { status: 401, headers: { 'content-type': 'application/json' } });
      },
    });
    const err = await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] })
      .then(() => null, (e) => e);
    assert.equal(err?.status, 401);
    assert.ok(seen.url.startsWith(`${AIF}/anthropic/`), seen.url);
    assert.equal(seen.headers.get('authorization'), `Bearer ${KEY}`);
  });

  it('the failure line names host, credential variable and the shared-credential defect', async () => {
    const cfg = buildAzureConfig(AIO_SHAPE);
    const text = await describeBriefClaudeFailure(Object.assign(new Error('401 denied'), { status: 401 }), cfg);
    assert.match(text, /AUTH_ENDPOINT_MISMATCH/);
    assert.ok(text.includes(AIF), 'names the endpoint addressed');
    assert.match(text, /AZURE_OPENAI_API_KEY/);
    assert.match(text, /AZURE_AI_API_KEY/, 'names the remedy variable');
    assert.ok(!text.includes(KEY), 'never prints the credential value');
  });

  it('off Azure the failure text is the plain error message (byte-identical)', async () => {
    const cfg = buildAzureConfig({});
    assert.equal(await describeBriefClaudeFailure(new Error('boom'), cfg), 'boom');
  });
});
