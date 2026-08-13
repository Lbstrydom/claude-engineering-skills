import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIClient, createOpenRouterClient, _resetClientCache, _cacheKeys, _internals } from '../scripts/lib/openai-client.mjs';
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

  it('emits the stock public OpenAI URL — no deployment segment, no api-version', async () => {
    // The end-to-end counterpart of the Azure URL tests: the deployment-qualified
    // work must be invisible from off-Azure.
    const t = captureTransport();
    const client = await createOpenAIClient({ azure: INACTIVE, apiKey: 'sk-test', fetch: t.fetchImpl });
    await client.embeddings.create({ model: 'text-embedding-3-large', input: 'ping' });
    assert.equal(t.calls[0].url, 'https://api.openai.com/v1/embeddings');
    assert.equal(t.calls[0].headers.get('authorization'), 'Bearer sk-test');
    assert.equal(t.calls[0].headers.get('api-key'), null);
  });
});

// ── Fake fetch transport ────────────────────────────────────────────────────
// The deployment segment is injected inside `AzureOpenAI.buildRequest`, NOT in
// `buildURL` — so asserting on `client.baseURL` (as this suite used to) cannot
// observe the routing that actually ships. These tests therefore drive a real
// request through an injected transport and assert on the URL the INSTALLED SDK
// emitted. Bodies are inert stubs; no credential is ever asserted-on by value
// beyond the fake key defined in this file.
function captureTransport(body = { data: [{ embedding: [0, 0] }] }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers || {}) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const DEPLOY_ENV = {
  ...AZURE_ENV,
  AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-deployment-name',
  AZURE_OPENAI_EMBED_DEPLOYMENT: 'embed-deployment-name',
};

describe('createOpenAIClient — Azure deployment-qualified routing (SDK-generated URLs)', () => {
  beforeEach(() => { providerEnv.beforeEach(); _resetClientCache(); });
  afterEach(() => { providerEnv.afterEach(); _resetClientCache(); });

  it('embeddings go to /openai/deployments/{embed-deployment}/embeddings', async () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const t = captureTransport();
    const client = await createOpenAIClient({ purpose: 'embed', azure: cfg, fetch: t.fetchImpl });
    await client.embeddings.create({ model: cfg.embedDeployment, input: 'ping', dimensions: 768 });
    assert.equal(
      t.calls[0].url,
      'https://example.openai.azure.com/openai/deployments/embed-deployment-name/embeddings?api-version=2025-03-01-preview',
    );
  });

  it('chat completions go to /openai/deployments/{gpt-deployment}/chat/completions', async () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const t = captureTransport({ id: 'x', choices: [] });
    const client = await createOpenAIClient({ purpose: 'gpt', azure: cfg, fetch: t.fetchImpl });
    // `max_completion_tokens`, not the deprecated `max_tokens` — the newer Azure
    // API versions reject `max_tokens` on chat completions.
    await client.chat.completions.create({
      model: cfg.gptDeployment,
      max_completion_tokens: 256,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(
      t.calls[0].url,
      'https://example.openai.azure.com/openai/deployments/gpt-deployment-name/chat/completions?api-version=2025-03-01-preview',
    );
  });

  it('the Responses API is NOT deployment-qualified — /openai/responses', async () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const t = captureTransport({ id: 'x', output: [], status: 'completed' });
    const client = await createOpenAIClient({ purpose: 'gpt', azure: cfg, fetch: t.fetchImpl });
    await client.responses.create({ model: cfg.gptDeployment, input: 'ping' });
    assert.equal(
      t.calls[0].url,
      'https://example.openai.azure.com/openai/responses?api-version=2025-03-01-preview',
    );
  });

  it('a trailing slash on the endpoint emits no double slash', async () => {
    const cfg = buildAzureConfig({ ...DEPLOY_ENV, AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com/' });
    const t = captureTransport();
    const client = await createOpenAIClient({ purpose: 'embed', azure: cfg, fetch: t.fetchImpl });
    await client.embeddings.create({ model: cfg.embedDeployment, input: 'ping', dimensions: 768 });
    assert.equal(
      t.calls[0].url,
      'https://example.openai.azure.com/openai/deployments/embed-deployment-name/embeddings?api-version=2025-03-01-preview',
    );
    // Belt-and-braces: no `//` anywhere after the scheme, whatever the shape.
    assert.equal(/([^:])\/\//.test(t.calls[0].url), false, t.calls[0].url);
  });

  it('an endpoint carrying a base-path suffix preserves that suffix (APIM route)', async () => {
    const cfg = buildAzureConfig({ ...DEPLOY_ENV, AZURE_OPENAI_ENDPOINT: 'https://gateway.example.net/aoai-route/' });
    const t = captureTransport();
    const client = await createOpenAIClient({ purpose: 'embed', azure: cfg, fetch: t.fetchImpl });
    await client.embeddings.create({ model: cfg.embedDeployment, input: 'ping', dimensions: 768 });
    assert.equal(
      t.calls[0].url,
      'https://gateway.example.net/aoai-route/openai/deployments/embed-deployment-name/embeddings?api-version=2025-03-01-preview',
    );
  });

  it('api-key authentication remains in effect', async () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const t = captureTransport();
    const client = await createOpenAIClient({ purpose: 'embed', azure: cfg, fetch: t.fetchImpl });
    await client.embeddings.create({ model: cfg.embedDeployment, input: 'ping', dimensions: 768 });
    assert.equal(t.calls[0].headers.get('api-key'), 'fake-azure-key');
    // Azure uses the `api-key` header, never `Authorization: Bearer`.
    assert.equal(t.calls[0].headers.get('authorization'), null);
  });

  it('AZURE_OPENAI_API_VERSION overrides the deployment-qualified default', async () => {
    const cfg = buildAzureConfig({ ...DEPLOY_ENV, AZURE_OPENAI_API_VERSION: '2024-10-21' });
    const t = captureTransport();
    const client = await createOpenAIClient({ purpose: 'embed', azure: cfg, fetch: t.fetchImpl });
    await client.embeddings.create({ model: cfg.embedDeployment, input: 'ping', dimensions: 768 });
    assert.equal(
      t.calls[0].url,
      'https://example.openai.azure.com/openai/deployments/embed-deployment-name/embeddings?api-version=2024-10-21',
    );
  });

  it('a client built with an injected transport is never cached', async () => {
    // Guards the leak direction: a test client must not be servable to a real
    // call site through the module-global cache.
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const t = captureTransport();
    await createOpenAIClient({ purpose: 'embed', azure: cfg, fetch: t.fetchImpl });
    const real = await createOpenAIClient({ purpose: 'embed', azure: cfg });
    await real.embeddings.create({ model: cfg.embedDeployment, input: 'x', dimensions: 768 })
      .catch(() => {}); // a real transport will fail; we only care it wasn't the fake
    assert.equal(t.calls.length, 0, 'the cached client must not be the fake-transport one');
  });
});

describe('createOpenAIClient — Azure client cache isolation by purpose/deployment', () => {
  beforeEach(() => { providerEnv.beforeEach(); _resetClientCache(); });
  afterEach(() => { providerEnv.afterEach(); _resetClientCache(); });

  it('gpt and embed purposes return DISTINCT clients pinned to their own deployment', async () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const gpt = await createOpenAIClient({ purpose: 'gpt', azure: cfg });
    const embed = await createOpenAIClient({ purpose: 'embed', azure: cfg });
    assert.notEqual(gpt, embed, 'deployment is constructor-level route state — must not share a client');
    assert.equal(gpt.deploymentName, 'gpt-deployment-name');
    assert.equal(embed.deploymentName, 'embed-deployment-name');
  });

  it('the same purpose still hits the cache', async () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    assert.equal(
      await createOpenAIClient({ purpose: 'gpt', azure: cfg }),
      await createOpenAIClient({ purpose: 'gpt', azure: cfg }),
    );
  });

  it('two deployments of the SAME purpose do not share a client (doctor probe ladder)', async () => {
    // azure-doctor probes candidate deployments by injecting an azure snapshot.
    // If the deployment were absent from the cache key, every probe after the
    // first would silently reuse the first candidate's route.
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const a = await createOpenAIClient({ purpose: 'embed', azure: { ...cfg, embedDeployment: 'cand-a' } });
    const b = await createOpenAIClient({ purpose: 'embed', azure: { ...cfg, embedDeployment: 'cand-b' } });
    assert.notEqual(a, b);
    assert.equal(a.deploymentName, 'cand-a');
    assert.equal(b.deploymentName, 'cand-b');
  });

  it('never puts raw key material in a cache key', async () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    await createOpenAIClient({ purpose: 'gpt', azure: cfg });
    for (const k of _cacheKeys()) {
      assert.equal(k.includes('fake-azure-key'), false, 'cache key must carry only a digest');
    }
  });
});

describe('createOpenAIClient — Azure routing', () => {
  beforeEach(() => { providerEnv.beforeEach(); _resetClientCache(); });
  afterEach(() => { providerEnv.afterEach(); _resetClientCache(); });

  it('gpt purpose is built against AZURE_OPENAI_ENDPOINT with the api-key credential', async () => {
    const cfg = buildAzureConfig(AZURE_ENV);
    const client = await createOpenAIClient({ purpose: 'gpt', azure: cfg, fresh: true });
    // baseURL is now the SDK-owned `${endpoint}/openai` root; the deployment
    // segment is appended per-operation (asserted end-to-end above).
    assert.equal(client.baseURL, 'https://example.openai.azure.com/openai');
    assert.equal(client.apiKey, 'fake-azure-key');
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

  it('foundry-claude is UNCHANGED — v1 surface, undated api-version, no /deployments', async () => {
    // Foundry is a separate product surface with no deployment-qualified routing.
    // The GPT/embed migration must not drag it along, including its api-version.
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const t = captureTransport({ id: 'x', choices: [] });
    const client = await createOpenAIClient({ purpose: 'foundry-claude', azure: cfg, fetch: t.fetchImpl });
    assert.equal(client.baseURL, 'https://example.services.ai.azure.com/openai/v1');
    await client.chat.completions.create({
      model: cfg.claudeDeployment,
      max_completion_tokens: 256,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(
      t.calls[0].url,
      'https://example.services.ai.azure.com/openai/v1/chat/completions?api-version=preview',
    );
    assert.equal(t.calls[0].headers.get('api-key'), 'fake-azure-key');
  });

  it('foundry-claude does not share a client with gpt or embed', async () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    const foundry = await createOpenAIClient({ purpose: 'foundry-claude', azure: cfg });
    const gpt = await createOpenAIClient({ purpose: 'gpt', azure: cfg });
    assert.notEqual(foundry, gpt);
    assert.equal(foundry.deploymentName, undefined, 'foundry client must not be deployment-pinned');
  });

  it('rejects an invalid purpose', async () => {
    await assert.rejects(() => createOpenAIClient({ purpose: 'bogus', azure: INACTIVE }), /Invalid purpose/);
  });

  // Was, until 2026-08-13: "foundry-claude without AZURE_AI_ENDPOINT throws".
  // That asserted the defect — it made an APIM-fronted Claude route
  // unrepresentable, since the only origin the purpose would accept was the
  // direct Foundry host. The route resolver now owns that decision.
  it('foundry-claude without AZURE_AI_ENDPOINT falls back to the APIM origin', async () => {
    const cfg = buildAzureConfig({ ...AZURE_ENV, AZURE_AI_ENDPOINT: '' });
    assert.equal(cfg.claudeRoute.mode, 'apim');
    assert.equal(
      _internals.azureBaseUrl('foundry-claude', cfg),
      `${AZURE_ENV.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '')}/openai/v1`,
    );
  });

  it('AZURE_CLAUDE_ROUTE=foundry without AZURE_AI_ENDPOINT fails at config time', () => {
    assert.throws(
      () => buildAzureConfig({ ...AZURE_ENV, AZURE_AI_ENDPOINT: '', AZURE_CLAUDE_ROUTE: 'foundry' }),
      /AZURE_AI_ENDPOINT/,
    );
  });
});

describe('azureBaseUrl helper', () => {
  it('strips trailing slashes from the gpt/embed endpoint root', () => {
    const cfg = buildAzureConfig({ ...AZURE_ENV, AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/' });
    assert.equal(_internals.azureBaseUrl('gpt', cfg), 'https://x.openai.azure.com');
  });

  it('preserves a base-path suffix on the endpoint root', () => {
    const cfg = buildAzureConfig({ ...AZURE_ENV, AZURE_OPENAI_ENDPOINT: 'https://gw.example.net/route//' });
    assert.equal(_internals.azureBaseUrl('embed', cfg), 'https://gw.example.net/route');
  });

  it('azureDeploymentFor maps purpose → the right deployment, and names the missing var', () => {
    const cfg = buildAzureConfig(DEPLOY_ENV);
    assert.equal(_internals.azureDeploymentFor('gpt', cfg), 'gpt-deployment-name');
    assert.equal(_internals.azureDeploymentFor('embed', cfg), 'embed-deployment-name');
    assert.throws(
      () => _internals.azureDeploymentFor('embed', { ...cfg, embedDeployment: '' }),
      /AZURE_OPENAI_EMBED_DEPLOYMENT/,
    );
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
