import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIClient, createOpenRouterClient, _resetClientCache, _internals } from '../scripts/lib/openai-client.mjs';
import { buildAzureConfig } from '../scripts/lib/config.mjs';
import { providerEnvHooks } from './helpers/provider-env.mjs';

// This suite references AZURE_OPENAI_ENDPOINT but previously only reset the
// client cache — an AMBIENT Azure endpoint (corporate machine, work profile,
// harness) silently activated the Azure path inside tests asserting on the
// PUBLIC one. Same class as the ANTHROPIC_BASE_URL harness failure; one shared
// env-family list so the two suites cannot drift apart.
const providerEnv = providerEnvHooks();

const INACTIVE = buildAzureConfig({}); // no AZURE_OPENAI_ENDPOINT → inactive

const AZURE_ENV = {
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_AI_ENDPOINT: 'https://example.services.ai.azure.com',
  AZURE_OPENAI_API_KEY: 'fake-azure-key',
  AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5.3-chat',
  AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'opus-4-6',
};

describe('createOpenAIClient — opt-in / byte-identical (the load-bearing invariant)', () => {
  beforeEach(() => { providerEnv.beforeEach(); _resetClientCache(); });
  afterEach(() => { providerEnv.afterEach(); _resetClientCache(); });

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
  beforeEach(() => { providerEnv.beforeEach(); _resetClientCache(); });
  afterEach(() => { providerEnv.afterEach(); _resetClientCache(); });

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

describe('createOpenAIClient — OSS path caching (consolidated Gemini gate fix G3)', () => {
  beforeEach(() => { providerEnv.beforeEach(); _resetClientCache(); });
  afterEach(() => { providerEnv.afterEach(); _resetClientCache(); });

  it('caches by baseURL+apiKey when no headers are supplied', async () => {
    const a = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-oss' } });
    const b = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-oss' } });
    assert.equal(a, b);
  });

  it('does NOT share a cached client across DIFFERENT headers for the same baseURL+apiKey', async () => {
    const a = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-oss', headers: { 'HTTP-Referer': 'app-a' } } });
    const b = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-oss', headers: { 'HTTP-Referer': 'app-b' } } });
    assert.notEqual(a, b);
    assert.equal(a._options.defaultHeaders?.['HTTP-Referer'], 'app-a');
    assert.equal(b._options.defaultHeaders?.['HTTP-Referer'], 'app-b');
  });

  it('caches by IDENTICAL headers regardless of key insertion order', async () => {
    const a = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-oss', headers: { 'HTTP-Referer': 'app-a', 'X-Title': 'title' } } });
    const b = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-oss', headers: { 'X-Title': 'title', 'HTTP-Referer': 'app-a' } } });
    assert.equal(a, b);
  });

  it('a headers-present call and a no-headers call for the same baseURL+apiKey are cached separately', async () => {
    const withHeaders = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-oss', headers: { 'HTTP-Referer': 'app-a' } } });
    const noHeaders = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-oss' } });
    assert.notEqual(withHeaders, noHeaders);
  });
});

describe('createOpenRouterClient — the named OSS seam', () => {
  beforeEach(() => { providerEnv.beforeEach(); _resetClientCache(); });
  afterEach(() => { providerEnv.afterEach(); _resetClientCache(); });

  const CFG = {
    openrouterApiKey: 'sk-or-test',
    openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  };

  it('resolves credentials from config and constructs against the OpenRouter base URL', async () => {
    const client = await createOpenRouterClient({ config: CFG, fresh: true });
    assert.equal(client.baseURL, 'https://openrouter.ai/api/v1');
    assert.equal(client.apiKey, 'sk-or-test');
  });

  it('throws an actionable, named error when no key is configured', async () => {
    // Asserts on THIS seam's message, not merely on the var name: the delegate
    // (createOpenAIClient's oss path) also names OPENROUTER_API_KEY, so a
    // looser regex passes even with this guard removed. Verified by mutation —
    // disabling the guard must turn this test red, and with `/OPENROUTER_API_KEY/`
    // it did not.
    await assert.rejects(
      () => createOpenRouterClient({ config: { ...CFG, openrouterApiKey: null }, fresh: true }),
      (err) => err instanceof Error && /OpenRouter route requires OPENROUTER_API_KEY/.test(err.message),
    );
  });

  it('honours a custom base URL (self-hosted / proxied router)', async () => {
    const client = await createOpenRouterClient({
      config: { ...CFG, openrouterBaseUrl: 'https://router.internal/v1' }, fresh: true,
    });
    assert.equal(client.baseURL, 'https://router.internal/v1');
  });

  it('caches by credentials, and does NOT share a client across different headers', async () => {
    // Guards the header-digest cache fix in the oss path: two calls differing
    // only by routing headers must not reuse the first call's headers.
    const a = await createOpenRouterClient({ config: CFG, headers: { 'X-Title': 'one' } });
    const b = await createOpenRouterClient({ config: CFG, headers: { 'X-Title': 'one' } });
    const c = await createOpenRouterClient({ config: CFG, headers: { 'X-Title': 'two' } });
    assert.equal(a, b, 'identical headers should hit the cache');
    assert.notEqual(a, c, 'different headers must construct a distinct client');
  });

  it('does not activate the Azure path even when Azure env is present', async () => {
    // The OSS route is independent of the Azure/public branches by construction.
    for (const [k, v] of Object.entries(AZURE_ENV)) process.env[k] = v;
    const client = await createOpenRouterClient({ config: CFG, fresh: true });
    assert.equal(client.baseURL, 'https://openrouter.ai/api/v1');
  });
});
