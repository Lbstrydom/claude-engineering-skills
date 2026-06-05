import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAzureConfig } from '../scripts/lib/config.mjs';

const FULL = {
  AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com',
  AZURE_OPENAI_API_KEY: 'k',
  AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5.3-chat',
};

describe('buildAzureConfig — opt-in gate', () => {
  it('is inert (active=false) when AZURE_OPENAI_ENDPOINT is absent', () => {
    const c = buildAzureConfig({});
    assert.equal(c.active, false);
    assert.equal(c.openaiEndpoint, null);
    assert.equal(c.apiVersion, 'preview'); // v1-surface literal
    assert.equal(c.embedDeployment, 'text-embedding-3-small');
    assert.equal(c.claudeApiShape, 'openai');
  });

  it('activates and defaults correctly with the minimal valid set', () => {
    const c = buildAzureConfig(FULL);
    assert.equal(c.active, true);
    assert.equal(c.gptDeployment, 'gpt-5.3-chat');
    assert.equal(c.apiVersion, 'preview');
    assert.equal(c.foundryApiPath, '/openai/v1');
  });
});

describe('buildAzureConfig — fail-fast (all-or-nothing), redacted', () => {
  it('throws naming AZURE_OPENAI_API_KEY when endpoint set but key missing', () => {
    assert.throws(
      () => buildAzureConfig({ AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com', AZURE_OPENAI_GPT_DEPLOYMENT: 'd' }),
      /AZURE_OPENAI_API_KEY/,
    );
  });

  it('throws naming AZURE_OPENAI_GPT_DEPLOYMENT when missing', () => {
    assert.throws(
      () => buildAzureConfig({ AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com', AZURE_OPENAI_API_KEY: 'k' }),
      /AZURE_OPENAI_GPT_DEPLOYMENT/,
    );
  });

  it('never echoes the key value in the error (and DOES throw)', () => {
    // Key present but GPT deployment missing → must throw on the deployment,
    // never including the key value. assert.throws fails if it does NOT throw.
    assert.throws(
      () => buildAzureConfig({ AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com', AZURE_OPENAI_API_KEY: 'SECRETKEY' }),
      (e) => e.message.includes('AZURE_OPENAI_GPT_DEPLOYMENT') && !e.message.includes('SECRETKEY'),
    );
  });

  it('rejects an invalid AZURE_CLAUDE_API_SHAPE', () => {
    assert.throws(() => buildAzureConfig({ ...FULL, AZURE_CLAUDE_API_SHAPE: 'bedrock' }), /AZURE_CLAUDE_API_SHAPE/);
  });
});

describe('buildAzureConfig — sentinel vs deployment separation (H4)', () => {
  it('reads the wire deployment from AZURE_*_DEPLOYMENT, leaving sentinels untouched', () => {
    // OPENAI_AUDIT_MODEL stays a sentinel concern (config.openaiConfig); azure
    // config only carries the deployment name — no remap of gpt-5.3 here.
    const c = buildAzureConfig({ ...FULL, AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'opus-4-6' });
    assert.equal(c.gptDeployment, 'gpt-5.3-chat');
    assert.equal(c.claudeDeployment, 'opus-4-6');
  });
});
