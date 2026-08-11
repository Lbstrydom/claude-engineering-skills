import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../setup.mjs';

const { ACCESS_ROUTES, DB_OPTIONS } = _internals;

// setup.mjs is the first thing every user runs and had no coverage at all —
// importing it used to start the wizard. These pin the contract that was
// actually wrong: which keys each access route declares REQUIRED.

describe('setup wizard — LLM access routes', () => {
  it('offers every route the runtime actually supports', () => {
    const names = ACCESS_ROUTES.map(r => r.name);
    assert.ok(names.some(n => /direct/i.test(n)), 'direct API keys');
    assert.ok(names.some(n => /azure/i.test(n)), 'Azure work profile');
    assert.ok(names.some(n => /openrouter/i.test(n)), 'OpenRouter');
  });

  it('does NOT require a public OpenAI key on the Azure route', () => {
    // The defect this replaces: OPENAI_API_KEY was `required: true` for
    // everyone, so a corporate Azure profile — where the GPT auditor routes to
    // Azure OpenAI and no public key exists — was told it needed one.
    const azure = ACCESS_ROUTES.find(r => /azure/i.test(r.name));
    const openaiKey = azure.keys.find(k => k.name === 'OPENAI_API_KEY');
    assert.equal(openaiKey, undefined, 'the Azure route must not prompt for OPENAI_API_KEY at all');
  });

  it('requires the one Azure var that actually activates the Azure path', () => {
    // config.mjs keys the whole Azure profile off AZURE_OPENAI_ENDPOINT; if it
    // were optional here, setup could complete an "Azure" run that is silently
    // still the public path.
    const azure = ACCESS_ROUTES.find(r => /azure/i.test(r.name));
    const endpoint = azure.keys.find(k => k.name === 'AZURE_OPENAI_ENDPOINT');
    assert.ok(endpoint, 'AZURE_OPENAI_ENDPOINT must be offered');
    assert.equal(endpoint.required, true);
  });

  it('keeps OPENAI_API_KEY required on the direct route', () => {
    const direct = ACCESS_ROUTES.find(r => /direct/i.test(r.name));
    const openaiKey = direct.keys.find(k => k.name === 'OPENAI_API_KEY');
    assert.equal(openaiKey.required, true);
  });

  it('gives every route at least one required key', () => {
    // A route with nothing required would complete having configured nothing
    // and still read as success.
    for (const route of ACCESS_ROUTES) {
      assert.ok(
        route.keys.some(k => k.required),
        `route "${route.name}" declares no required key`,
      );
    }
  });

  it('uses unique selection keys', () => {
    const keys = ACCESS_ROUTES.map(r => r.key);
    assert.equal(new Set(keys).size, keys.length, 'duplicate menu keys make a choice ambiguous');
  });

  it('every key carries a description the prompt can show', () => {
    for (const route of ACCESS_ROUTES) {
      for (const k of route.keys) {
        assert.ok(k.desc && k.desc.length > 0, `${route.name}/${k.name} has no desc`);
      }
    }
  });
});

describe('setup wizard — database options', () => {
  it('offers exactly local-only and Postgres, and no SQLite', () => {
    const names = DB_OPTIONS.map(o => o.name);
    assert.deepEqual(names, ['None', 'Postgres']);
    assert.ok(
      !JSON.stringify(DB_OPTIONS).toLowerCase().includes('sqlite'),
      'there is no SQLite backend; implying one is how users conclude persistence is active when it is not',
    );
  });

  it('the Postgres option collects the DSN that the preflight then verifies', () => {
    const pg = DB_OPTIONS.find(o => o.name === 'Postgres');
    assert.ok(pg.extraKeys.includes('AUDIT_DB_URL'));
  });
});
