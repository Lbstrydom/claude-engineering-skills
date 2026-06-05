import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicClient, _resetClientCache } from '../scripts/lib/anthropic-client.mjs';

// Use redactor:null so the factory returns the RAW Anthropic SDK client
// (the redaction wrapper would hide `.baseURL`). sdk backend + explicit apiKey.

const BASE = { backend: 'sdk', apiKey: 'sk-test', redactor: null, fresh: true };

describe('createAnthropicClient — baseURL (Azure Foundry anthropic shape)', () => {
  beforeEach(() => _resetClientCache());
  afterEach(() => { delete process.env.AZURE_OPENAI_API_KEY; delete process.env.ANTHROPIC_BASE_URL; });

  it('default (no baseURL) targets public api.anthropic.com', async () => {
    const c = await createAnthropicClient({ ...BASE });
    assert.match(c.baseURL, /api\.anthropic\.com/);
  });

  it('passes options.baseURL into the SDK client', async () => {
    const url = 'https://example.services.ai.azure.com';
    const c = await createAnthropicClient({ ...BASE, baseURL: url });
    assert.equal(c.baseURL, url);
  });

  it('ANTHROPIC_BASE_URL env is honoured when no option given', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://env.example.com';
    const c = await createAnthropicClient({ ...BASE });
    assert.equal(c.baseURL, 'https://env.example.com');
  });

  it('uses Bearer auth (authToken) for the Azure Foundry path', async () => {
    process.env.AZURE_OPENAI_API_KEY = 'azkey';
    const c = await createAnthropicClient({ backend: 'sdk', baseURL: 'https://foundry.example/anthropic', redactor: null, fresh: true });
    // Azure Foundry uses `Authorization: Bearer <key>` — the SDK's authToken,
    // NOT x-api-key/api-key. The SDK stores it as `c.authToken`.
    assert.equal(c.authToken, 'azkey');
    assert.equal(c.baseURL, 'https://foundry.example/anthropic');
  });
});

describe('createAnthropicClient — cache keys distinguish baseURL', () => {
  beforeEach(() => _resetClientCache());

  it('different baseURLs are not served from the same cache entry', async () => {
    const a = await createAnthropicClient({ backend: 'sdk', apiKey: 'k', redactor: null, baseURL: 'https://a.example' });
    const b = await createAnthropicClient({ backend: 'sdk', apiKey: 'k', redactor: null, baseURL: 'https://b.example' });
    assert.notEqual(a.baseURL, b.baseURL);
  });
});
