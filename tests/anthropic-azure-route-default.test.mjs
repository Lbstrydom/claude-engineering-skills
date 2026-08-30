/**
 * @fileoverview A bare `createAnthropicClient()` on an active Azure work
 * profile must reach the TENANT's Claude, not public api.anthropic.com.
 *
 * Measured in consumer `storyline` (a real corporate Azure tenant, APIM route)
 * on 2026-08-30, before this change: `azureConfig.active` was `true` and a
 * routed client made a live Claude call in 1.4s, while a bare call did one of
 * two things depending only on whose machine it ran on —
 *   - with a personal key in `~/.audit-loop.env`: CORPORATE source shipped to
 *     `https://api.anthropic.com` on that PERSONAL credential;
 *   - without one: `ANTHROPIC_API_KEY required for sdk backend`, with a working
 *     APIM route unused in the same process.
 * `isClaudeAvailable()` returned `false` on the same tenant, so the three call
 * sites gated on it skipped themselves silently rather than failing.
 *
 * The properties under test are therefore FOUR, and the last two are the ones a
 * naive "make Azure work" fix breaks:
 *   1. omitted route + active profile ⇒ the tenant's endpoint;
 *   2. `isClaudeAvailable()` follows the ROUTE, not the public env var;
 *   3. OFF Azure, everything is byte-identical (the opt-in invariant);
 *   4. `azureRoute: null` still reaches public Anthropic, so the named
 *      public-Opus arms keep meaning what they say.
 *
 * Assertions are on the EMITTED request — URL and headers as the installed SDK
 * actually sends them. The SDK binds its transport at construction, so a
 * post-hoc `globalThis.fetch` patch observes nothing and a real request escapes
 * to the network (tests/azure-claude-route.test.mjs records that lesson).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAnthropicClient, isClaudeAvailable, _resetClientCache,
} from '../scripts/lib/anthropic-client.mjs';
import { resolveClaudeRouteFromEnv } from '../scripts/lib/azure-claude-route.mjs';

const TOUCHED = [
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_AI_ENDPOINT',
  'AZURE_AI_API_KEY', 'AZURE_CLAUDE_ROUTE', 'AZURE_OPENAI_GPT_DEPLOYMENT',
  'OPENAI_AUDIT_MODEL', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL', 'CLAUDE_BACKEND', 'AWS_REGION', 'AWS_DEFAULT_REGION',
];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  // Scrub, so the suite cannot pass or fail by whose machine it runs on — this
  // repo's own `.env` and the shared `~/.audit-loop.env` both set several of these.
  for (const k of TOUCHED) delete process.env[k];
  _resetClientCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  _resetClientCache();
});

/**
 * An APIM tenant: one endpoint, one subscription key, `api-key` header.
 *
 * `AZURE_OPENAI_GPT_DEPLOYMENT` is set because the Azure branch of the client
 * reaches `azure-throttle.mjs`, which imports `config.mjs`, whose
 * `buildAzureConfig()` enforces all-or-nothing at module load. A fixture that
 * omitted it failed inside config rather than in the code under test.
 */
function apimTenant() {
  process.env.AZURE_OPENAI_ENDPOINT = 'https://tenant-apim.azure-api.net/foundry';
  process.env.AZURE_OPENAI_API_KEY = 'apim-subscription-key';
  process.env.AZURE_OPENAI_GPT_DEPLOYMENT = 'gpt-test';
  process.env.AZURE_CLAUDE_ROUTE = 'apim';
}

/** Capture the request the INSTALLED SDK emits, without letting it leave. */
function captureTransport() {
  const seen = [];
  const fetch = async (url, init = {}) => {
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    seen.push({ url: String(url), headers });
    return new Response(
      JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { seen, fetch };
}

async function emit(options) {
  const { seen, fetch } = captureTransport();
  const client = await createAnthropicClient({ ...options, fetch, fresh: true, redactor: null });
  await client.messages.create({
    model: 'claude-test', max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(seen.length, 1, 'expected exactly one emitted request');
  return seen[0];
}

describe('1 — an omitted azureRoute adopts the tenant on an active profile', () => {
  test('bare call targets the APIM endpoint, with the api-key header', async () => {
    apimTenant();
    const req = await emit({});
    assert.match(req.url, /^https:\/\/tenant-apim\.azure-api\.net\/foundry\/anthropic\//,
      `bare client emitted to ${req.url}`);
    assert.equal(req.headers['api-key'], 'apim-subscription-key');
    assert.ok(!req.headers.authorization, 'APIM must not receive a Bearer header');
  });

  test('a personal ANTHROPIC_API_KEY can never reach the tenant', async () => {
    // The measured failure: a dev machine carrying a personal key in
    // ~/.audit-loop.env sent CORPORATE source to api.anthropic.com on it. The
    // inverse — the public key travelling to the corporate host — is the
    // 2026-08-13 cross-service-credential incident. Neither may be reachable.
    apimTenant();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-personal-do-not-send';
    const req = await emit({});
    assert.match(req.url, /tenant-apim\.azure-api\.net/, 'went to public Anthropic');
    const all = JSON.stringify(req.headers);
    assert.ok(!all.includes('sk-ant-personal-do-not-send'),
      `personal key present in emitted headers: ${all}`);
    assert.equal(req.headers['api-key'], 'apim-subscription-key');
  });

  test('a foundry tenant gets Bearer, not api-key', async () => {
    // The two routes differ ONLY in which header carries the credential; a
    // default that got this backwards would 401 on every call.
    process.env.AZURE_OPENAI_ENDPOINT = 'https://tenant-apim.azure-api.net/foundry';
    process.env.AZURE_OPENAI_API_KEY = 'shared-key';
    process.env.AZURE_OPENAI_GPT_DEPLOYMENT = 'gpt-test';
    process.env.AZURE_AI_ENDPOINT = 'https://tenant-aif.services.ai.azure.com';
    process.env.AZURE_CLAUDE_ROUTE = 'foundry';
    const req = await emit({});
    assert.match(req.url, /^https:\/\/tenant-aif\.services\.ai\.azure\.com\/anthropic\//);
    assert.equal(req.headers.authorization, 'Bearer shared-key');
  });
});

describe('2 — isClaudeAvailable follows the ROUTE, not the public env var', () => {
  test('an Azure profile with no ANTHROPIC_API_KEY is AVAILABLE', () => {
    apimTenant();
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(isClaudeAvailable(), true);
  });

  test('no route and no key is still unavailable — the direction that must not flip', () => {
    // A gate that answers "available" everywhere is as useless as one that
    // answers "unavailable" everywhere; only one of those fails loudly.
    assert.equal(isClaudeAvailable(), false);
  });
});

describe('3 — OFF Azure nothing changes (the opt-in invariant)', () => {
  test('a bare call still targets public Anthropic', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-public';
    const req = await emit({});
    assert.match(req.url, /^https:\/\/api\.anthropic\.com\//);
    assert.equal(req.headers['x-api-key'], 'sk-ant-public');
  });

  test('resolveClaudeRouteFromEnv is null without AZURE_OPENAI_ENDPOINT', () => {
    process.env.AZURE_AI_ENDPOINT = 'https://tenant-aif.services.ai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'k';
    assert.equal(resolveClaudeRouteFromEnv(), null,
      'AZURE_OPENAI_ENDPOINT is the profile switch — nothing else activates it');
  });

  test('a half-configured profile THROWS rather than demoting to public', () => {
    // Returning null here would silently send a corporate-tenant call to the
    // public endpoint with whatever key happened to be around.
    process.env.AZURE_OPENAI_ENDPOINT = 'https://tenant-apim.azure-api.net/foundry';
    assert.throws(() => resolveClaudeRouteFromEnv(), /AZURE_OPENAI_API_KEY is missing/);
  });
});

describe('4 — azureRoute: null is the explicit public opt-out', () => {
  test('the named public arm still reaches api.anthropic.com on an Azure machine', async () => {
    // gemini-review's `claude-opus` provider and model-eval's non-azure arm both
    // rely on this: their ids MEAN the public service, and silently redirecting
    // them would mis-attribute every comparison run on an Azure machine.
    apimTenant();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-public';
    const req = await emit({ azureRoute: null });
    assert.match(req.url, /^https:\/\/api\.anthropic\.com\//);
    assert.equal(req.headers['x-api-key'], 'sk-ant-public');
  });

  test('an explicit route still wins over the environment', async () => {
    apimTenant();
    const req = await emit({
      azureRoute: {
        baseUrl: 'https://explicit.example/anthropic',
        apiKey: 'explicit-key', authMode: 'bearer', credentialVar: 'X',
      },
    });
    assert.match(req.url, /^https:\/\/explicit\.example\/anthropic\//);
    assert.equal(req.headers.authorization, 'Bearer explicit-key');
  });
});

describe('5 — the cli/bedrock backends are untouched', () => {
  test('an active profile does not coerce CLAUDE_BACKEND=cli onto a baseURL', async () => {
    // `claude -p` takes no baseURL. Auto-adopting a route there would either
    // throw or silently coerce to sdk — billing the API key instead of drawing
    // the Agent SDK credit.
    apimTenant();
    process.env.CLAUDE_BACKEND = 'cli';
    const client = await createAnthropicClient({ fresh: true });
    // The sdk wrapper exposes a `baseURL` passthrough; the cli adapter has no
    // such property. Had the route been adopted here, reconcileBackendWithBaseUrl
    // would have coerced this to sdk and the property would exist.
    assert.equal('baseURL' in client, false, 'coerced to the sdk backend');
  });
});
