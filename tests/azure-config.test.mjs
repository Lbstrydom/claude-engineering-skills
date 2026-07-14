import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    assert.equal(c.claudeApiShape, 'anthropic');
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

// 2026-07-14 fresh-installer audit P0: openai-audit.mjs's OPENAI_API_KEY
// gate fired unconditionally, blocking the primary audit entry point for an
// Azure-only corporate install (which authenticates via AZURE_OPENAI_API_KEY
// through createOpenAIClient — it has no OPENAI_API_KEY at all, per
// defaults/work-profile.env.example). Subprocess probes because the gate
// lives inside main() and config freezes at import (same convention as
// tests/tiered-pipeline-wiring.test.mjs).
describe('openai-audit.mjs entry gate — Azure-only installs must pass (P0 regression)', () => {
  const runProbe = (extraEnv) => {
    try {
      execFileSync(process.execPath, ['scripts/openai-audit.mjs', 'plan', 'nonexistent-plan-probe.md'], {
        encoding: 'utf8', timeout: 60000, stdio: 'pipe',
        env: {
          PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
          AUDIT_LOOP_DISABLE_SHARED: '1',
          DOTENV_CONFIG_PATH: 'nonexistent-dotenv-probe.env', // keep the repo .env out
          ...extraEnv,
        },
      });
      return { ok: true, output: '' };
    } catch (err) {
      return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };

  it('no keys at all → still demands OPENAI_API_KEY (public-path behavior unchanged)', () => {
    const r = runProbe({});
    assert.equal(r.ok, false);
    assert.match(r.output, /OPENAI_API_KEY environment variable required/);
  });

  it('Azure-only (work-profile.env.example shape, no OPENAI_API_KEY) → passes the key gate', () => {
    const r = runProbe({
      AZURE_OPENAI_ENDPOINT: 'https://probe.openai.azure.com',
      AZURE_OPENAI_API_KEY: 'probe-key',
      AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5-3',
    });
    assert.equal(r.ok, false, 'still exits non-zero — but on the missing plan file, not the key gate');
    assert.doesNotMatch(r.output, /OPENAI_API_KEY environment variable required/,
      'an Azure-only install must never be blocked by the public-key gate');
    assert.match(r.output, /File not found/, 'proves execution progressed past the gate to the plan read');
  });
});
