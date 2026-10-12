/**
 * @fileoverview `buildShadowClient` is a closed dispatch — and it is tied, by TABLE, to the two
 * other places that name a shadow provider.
 *
 * Three structures each know "which providers exist" and no compiler compares them:
 *   - `SHADOW_PROVIDER_SPECS` (what `resolveShadow` ADMITS, by canonical name),
 *   - `PROVIDERS`             (what `runFinalReview` looks the canonical name up in), and
 *   - `buildShadowClient`     (which client to construct).
 *
 * `buildShadowClient` used to end in an unconditional `return createAnthropicClient(...)`, so a
 * provider admitted by the first and missing from the third — or a plain typo — silently got a
 * PUBLIC ANTHROPIC client: the arm was billed to the wrong provider while recording itself under
 * the right name (`buildShadowClient('some-future-provider')` returned one — executed
 * 2026-10-03). It now throws. This table fails the moment the three drift. Plan:
 * docs/plans/final-review-debt-suppression-revival.md §2.5 (ledger topic 232661f933cc).
 *
 * The assertions are on WHERE EACH CLIENT ADDRESSES ITS REQUESTS and WITH WHICH CREDENTIAL — not
 * on SDK family (audit-code R1 M7: four providers share one SDK, so a family check passes when one
 * is routed to another) and not on "did not throw" (R1 M6: that passes a ReferenceError).
 *
 * Tier 1: constructs real SDK client objects; nothing is sent over a network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Config is frozen at import, so the credentials every branch reads must exist BEFORE the modules
// load. They are DISTINCT dummies per provider: constructing an SDK client sends nothing, and
// distinct values are what let a test tell "routed to the wrong provider" from "built correctly".
const KEYS = Object.freeze({
  openrouter: 'sk-or-test-A-not-real',
  xai: 'xai-test-B-not-real',
  deepseek: 'ds-test-C-not-real',
  alibaba: 'ali-test-D-not-real',
  gemini: 'gm-test-E-not-real',
});
Object.assign(process.env, {
  FINAL_REVIEW_API_KEY: KEYS.openrouter,
  XAI_API_KEY: KEYS.xai,
  DEEPSEEK_API_KEY: KEYS.deepseek,
  ALIBABA_CLOUD_API_KEY: KEYS.alibaba,
  ALIBABA_CLOUD_BASE_URL: 'https://ws-test.example.invalid/compat/v1',
  GEMINI_API_KEY: KEYS.gemini,
  ANTHROPIC_API_KEY: 'sk-ant-test-F-not-real',
});

const { buildShadowClient, mapRouteToShadowProvider } = await import('../scripts/lib/final-review/shadow.mjs');
const { SHADOW_PROVIDER_SPECS } = await import('../scripts/lib/final-review/provider-specs.mjs');
const { PROVIDERS, resolveOpenRouterCreds } = await import('../scripts/lib/final-review/providers.mjs');
const { resolveXaiCreds, resolveAlibabaCreds, resolveDeepseekCreds } = await import('../scripts/lib/model-resolver.mjs');

const UNSUPPORTED = /unsupported shadow provider/;
const CANONICALS = [...new Set(Object.values(SHADOW_PROVIDER_SPECS).map((s) => s.canonical))].sort();
// `azure-claude` is reached only via the model-eval override (`mapRouteToShadowProvider`), never
// through SHADOW_PROVIDER_SPECS — Azure is a no-op for FINAL_REVIEW_SHADOW by design.
const ALL = [...CANONICALS, 'azure-claude'];

/** The OpenAI-compatible providers: one SDK, four different destinations and credentials. */
const GATEWAYS = {
  openrouter: { creds: resolveOpenRouterCreds(), key: KEYS.openrouter },
  xai: { creds: resolveXaiCreds(), key: KEYS.xai },
  alibaba: { creds: resolveAlibabaCreds(), key: KEYS.alibaba },
  deepseek: { creds: resolveDeepseekCreds(), key: KEYS.deepseek },
};
const stripSlash = (u) => String(u).replace(/\/+$/, '');

describe('buildShadowClient — the table that ties SHADOW_PROVIDER_SPECS, PROVIDERS and the client branches', () => {
  it('the table is not vacuous: it covers every canonical the specs admit', () => {
    assert.deepEqual(CANONICALS, ['alibaba', 'claude-opus', 'deepseek', 'gemini', 'openrouter', 'xai']);
    assert.deepEqual(Object.keys(GATEWAYS).sort(), CANONICALS.filter((c) => !['gemini', 'claude-opus'].includes(c)),
      'a new canonical provider needs a branch in this table, which is the point');
  });

  for (const canonical of CANONICALS) {
    it(`${canonical}: is a PROVIDERS key (that is how runFinalReview inherits its wire behaviour) and buildShadowClient builds a client`, async () => {
      assert.equal(typeof PROVIDERS[canonical]?.transportKind, 'function', `PROVIDERS has no "${canonical}" descriptor`);
      assert.ok(await buildShadowClient(canonical), 'a client object');
    });
  }

  for (const [name, { creds, key }] of Object.entries(GATEWAYS)) {
    it(`${name}: the client ADDRESSES that provider's own endpoint with that provider's own credential`, async () => {
      assert.ok(creds.baseUrl, `${name} resolved no base URL — the assertion below would be vacuous`);
      const client = await buildShadowClient(name);
      assert.equal(stripSlash(client.baseURL), stripSlash(creds.baseUrl), `${name} is addressing the wrong endpoint`);
      assert.equal(client.apiKey, key, `${name} is carrying another provider's credential`);
    });
  }

  it('NEGATIVE CONTROL: the four OpenAI-compatible providers are pairwise distinguishable — routing one to another would FAIL the per-provider assertions', async () => {
    const built = {};
    for (const name of Object.keys(GATEWAYS)) {
      const c = await buildShadowClient(name);
      built[name] = { baseURL: stripSlash(c.baseURL), apiKey: c.apiKey };
    }
    const names = Object.keys(built);
    assert.equal(new Set(names.map((n) => built[n].baseURL)).size, names.length, 'every provider has its own endpoint');
    assert.equal(new Set(names.map((n) => built[n].apiKey)).size, names.length, 'every provider has its own credential');
  });

  it('gemini carries the Gemini credential', async () => {
    const client = await buildShadowClient('gemini');
    assert.equal(client.apiKey, KEYS.gemini);
    assert.equal(typeof client.models?.generateContentStream, 'function');
  });

  it('claude-opus is the PUBLIC Anthropic service (its sdk pin is observed on the wire in gemini-review-shadow.test.mjs)', async () => {
    const client = await buildShadowClient('claude-opus');
    assert.equal(stripSlash(client.baseURL), 'https://api.anthropic.com');
    assert.equal(typeof client.messages?.create, 'function');
  });

  it('every provider string the model-eval override can produce is one buildShadowClient knows', () => {
    for (const route of [
      { transport: 'native-gemini' },
      { transport: 'native-anthropic', provider: 'azure' },
      { transport: 'native-anthropic', provider: 'anthropic' },
    ]) {
      const provider = mapRouteToShadowProvider(route);
      assert.ok(ALL.includes(provider), `${JSON.stringify(route)} -> "${provider}" is not in the dispatch table`);
    }
  });

  it('REGRESSION: an unknown provider no longer falls through to a PUBLIC ANTHROPIC client — it throws, naming the provider', async () => {
    await assert.rejects(() => buildShadowClient('some-future-provider'), (err) => {
      assert.match(err.message, UNSUPPORTED);
      assert.match(err.message, /"some-future-provider"/);
      return true;
    });
  });

  it('NEGATIVE CONTROL: the raw alias "anthropic" is not a canonical name — callers must pass what resolveShadow returns', async () => {
    assert.equal(SHADOW_PROVIDER_SPECS.anthropic.canonical, 'claude-opus');
    await assert.rejects(() => buildShadowClient('anthropic'), UNSUPPORTED);
    await assert.rejects(() => buildShadowClient(undefined), UNSUPPORTED);
    await assert.rejects(() => buildShadowClient(''), UNSUPPORTED);
  });
});

// ── azure-claude: observed through the request it EMITS, under a controlled Azure profile ──────
// A SUBPROCESS, because `azureConfig` is frozen at module import. The assertions are on the wire
// (AGENTS.md: "assert the emitted request, not the client config") and a regression to the old
// "did not throw" check would pass a ReferenceError. The PUBLIC key is set in the child's
// environment precisely so that it can be seen NOT to leave: an endpoint and the credential it is
// addressed with are one unit (docs/runbooks/azure-work-profile.md).
describe('buildShadowClient("azure-claude") — emitted request under an Azure profile', () => {
  const PUBLIC_KEY = 'sk-ant-PUBLIC-key-must-never-reach-azure';
  const AZURE_KEY = 'azure-key-test-not-real';
  const HOST = 'https://example-resource.openai.azure.com';
  const CHILD = `
    const records = [];
    globalThis.fetch = async (url, init) => {
      records.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) });
      return new Response(JSON.stringify({
        id: 'x', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { buildShadowClient } = await import('./scripts/lib/final-review/shadow.mjs');
    const { azureConfig } = await import('./scripts/lib/config.mjs');
    const client = await buildShadowClient('azure-claude');
    const body = { model: 'claude-test', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
    if (azureConfig.claudeApiShape === 'anthropic') await client.messages.create(body);
    else await client.chat.completions.create(body);
    console.log('RESULT ' + JSON.stringify({ shape: azureConfig.claudeApiShape, records }));
  `;
  const run = (shape) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env,
        AZURE_OPENAI_ENDPOINT: HOST, AZURE_OPENAI_API_KEY: AZURE_KEY, AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-test',
        AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'claude-test', AZURE_CLAUDE_API_SHAPE: shape,
        ANTHROPIC_API_KEY: PUBLIC_KEY, CLAUDE_BACKEND: 'cli',
      },
    });
    assert.equal(r.status, 0, `child failed: ${r.stderr.slice(-600)}`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `child produced no RESULT line: ${r.stdout.slice(-400)}`);
    return JSON.parse(line.slice('RESULT '.length));
  };

  for (const [shape, pathFragment] of [['anthropic', '/anthropic/v1/messages'], ['openai', '/openai/v1/chat/completions']]) {
    it(`${shape} shape: exactly one request, to the AZURE host (${pathFragment}), carrying the Azure credential and never the public key`, () => {
      const { shape: seen, records } = run(shape);
      assert.equal(seen, shape, 'the child resolved the shape under test');
      assert.equal(records.length, 1, `one request expected, saw ${JSON.stringify(records.map((r) => r.url))}`);
      assert.ok(records[0].url.startsWith(HOST), `request left for ${records[0].url}`);
      assert.ok(records[0].url.includes(pathFragment), `unexpected path: ${records[0].url}`);
      assert.match(JSON.stringify(records[0].headers), new RegExp(AZURE_KEY), 'the Azure credential must be what authenticates');
      assert.doesNotMatch(JSON.stringify(records[0]), /PUBLIC-key/, 'the PUBLIC Anthropic key must never reach an Azure host');
    });
  }
});
