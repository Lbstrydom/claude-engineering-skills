import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIClient, _resetClientCache, _internals } from '../scripts/lib/openai-client.mjs';
import { buildAzureConfig } from '../scripts/lib/config.mjs';

const INACTIVE = buildAzureConfig({}); // no AZURE_OPENAI_ENDPOINT → inactive

const AZURE_ENV = {
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_AI_ENDPOINT: 'https://example.services.ai.azure.com',
  AZURE_OPENAI_API_KEY: 'fake-azure-key',
  AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5.3-chat',
  AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'opus-4-6',
};

describe('createOpenAIClient — opt-in / byte-identical (the load-bearing invariant)', () => {
  beforeEach(() => _resetClientCache());

  it('with no Azure env, constructs a public client with the OpenAI default baseURL', async () => {
    const client = await createOpenAIClient({ azure: INACTIVE, apiKey: 'sk-test', fresh: true });
    // The public path must equal `new OpenAI({ apiKey })` — default baseURL,
    // no api-key header, no api-version query.
    assert.ok(client.baseURL.startsWith('https://api.openai.com'), `got ${client.baseURL}`);
    assert.equal(client.apiKey, 'sk-test');
  });

  it('public clients are cached by apiKey', async () => {
    const a = await createOpenAIClient({ azure: INACTIVE, apiKey: 'sk-same' });
    const b = await createOpenAIClient({ azure: INACTIVE, apiKey: 'sk-same' });
    assert.equal(a, b);
  });
});

describe('createOpenAIClient — Azure routing', () => {
  beforeEach(() => _resetClientCache());

  it('gpt purpose targets AZURE_OPENAI_ENDPOINT /openai/v1 with api-key + api-version', async () => {
    const cfg = buildAzureConfig(AZURE_ENV);
    const client = await createOpenAIClient({ purpose: 'gpt', azure: cfg, fresh: true });
    assert.equal(client.baseURL, 'https://example.openai.azure.com/openai/v1');
    assert.equal(client.apiKey, 'fake-azure-key');
  });

  it('applies the api-version query and api-key header (load-bearing Azure options)', async () => {
    const cfg = buildAzureConfig(AZURE_ENV);
    const client = await createOpenAIClient({ purpose: 'gpt', azure: cfg, fresh: true });
    // buildURL bakes the defaultQuery into every request URL.
    assert.match(client.buildURL('/embeddings', {}), /[?&]api-version=preview/);
    // defaultHeaders carries the Azure api-key header.
    assert.equal(client._options?.defaultHeaders?.['api-key'], 'fake-azure-key');
  });

  it('foundry-claude purpose targets AZURE_AI_ENDPOINT', async () => {
    const cfg = buildAzureConfig(AZURE_ENV);
    const client = await createOpenAIClient({ purpose: 'foundry-claude', azure: cfg, fresh: true });
    assert.equal(client.baseURL, 'https://example.services.ai.azure.com/openai/v1');
  });

  it('foundry-claude honours AZURE_FOUNDRY_API_PATH override (/models)', async () => {
    const cfg = buildAzureConfig({ ...AZURE_ENV, AZURE_FOUNDRY_API_PATH: '/models' });
    const client = await createOpenAIClient({ purpose: 'foundry-claude', azure: cfg, fresh: true });
    assert.equal(client.baseURL, 'https://example.services.ai.azure.com/models');
  });

  it('rejects an invalid purpose', async () => {
    await assert.rejects(() => createOpenAIClient({ purpose: 'bogus', azure: INACTIVE }), /Invalid purpose/);
  });

  it('foundry-claude without AZURE_AI_ENDPOINT throws', async () => {
    const cfg = buildAzureConfig({ ...AZURE_ENV, AZURE_AI_ENDPOINT: '' });
    await assert.rejects(() => createOpenAIClient({ purpose: 'foundry-claude', azure: cfg }), /AZURE_AI_ENDPOINT/);
  });
});

describe('azureBaseUrl helper', () => {
  it('strips trailing slashes before concatenation', () => {
    const cfg = buildAzureConfig({ ...AZURE_ENV, AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/' });
    assert.equal(_internals.azureBaseUrl('gpt', cfg), 'https://x.openai.azure.com/openai/v1');
  });
});
