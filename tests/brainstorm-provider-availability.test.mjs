/**
 * Provider-availability oracle + its CLI consequence.
 *
 * Regression origin (2026-08-13): a consumer on an Azure-only install reported
 * that /brainstorm's independent step could not run — "both providers were
 * unavailable because OPENAI_API_KEY and GEMINI_API_KEY are not configured" —
 * although `openai-adapter.mjs` had been routed through the Azure-aware client
 * seam a month earlier. Both dispatch sites short-circuited on the public env
 * var, so the Azure branch was unreachable.
 *
 * The load-bearing assertion is NOT "the Azure call succeeds" (that needs a
 * tenant); it is "the gate stops pre-empting the call". `state:'misconfigured'`
 * with `latencyMs:0` is the exact signature of the bug, so the CLI case below
 * asserts its absence against a deliberately unroutable endpoint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveProviderAvailability, defaultProviders } from '../scripts/lib/brainstorm/provider-availability.mjs';
import { BRAINSTORM_PROVIDERS, ProviderResultSchema } from '../scripts/lib/brainstorm/schemas.mjs';
import { PROVIDER_INPUT_CEILING_TOKENS } from '../scripts/lib/brainstorm/provider-limits.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(TEST_DIR, '..', 'scripts', 'brainstorm-round.mjs');

/** Minimal azureConfig snapshots — only the field the oracle reads. */
const AZURE_ON = { active: true };
const AZURE_OFF = { active: false };

describe('resolveProviderAvailability — openai', () => {
  it('is available on an active Azure profile with NO public key (the reported bug)', () => {
    const r = resolveProviderAvailability('openai', { azure: AZURE_ON, env: {} });
    assert.equal(r.available, true);
    assert.equal(r.route, 'azure');
    assert.equal(r.reason, null);
  });

  it('is available on the public profile with a key', () => {
    const r = resolveProviderAvailability('openai', { azure: AZURE_OFF, env: { OPENAI_API_KEY: 'sk-x' } });
    assert.equal(r.available, true);
    assert.equal(r.route, 'public');
  });

  it('is unavailable with neither, and the reason names BOTH routes', () => {
    const r = resolveProviderAvailability('openai', { azure: AZURE_OFF, env: {} });
    assert.equal(r.available, false);
    assert.match(r.reason, /OPENAI_API_KEY/);
    assert.match(r.reason, /AZURE_OPENAI_ENDPOINT/);
  });

  it('treats a whitespace-only key as absent', () => {
    const r = resolveProviderAvailability('openai', { azure: AZURE_OFF, env: { OPENAI_API_KEY: '   ' } });
    assert.equal(r.available, false);
  });
});

describe('resolveProviderAvailability — gemini', () => {
  it('is available with a key regardless of profile', () => {
    const r = resolveProviderAvailability('gemini', { azure: AZURE_ON, env: { GEMINI_API_KEY: 'g' } });
    assert.equal(r.available, true);
    assert.equal(r.route, 'public');
  });

  it('under Azure, says the profile has no Gemini rather than "set the key"', () => {
    const r = resolveProviderAvailability('gemini', { azure: AZURE_ON, env: {} });
    assert.equal(r.available, false);
    assert.match(r.reason, /Azure work profile has no Gemini equivalent/);
  });

  it('on the public profile, the reason stays the plain missing-key message', () => {
    const r = resolveProviderAvailability('gemini', { azure: AZURE_OFF, env: {} });
    assert.equal(r.available, false);
    assert.equal(r.reason, 'GEMINI_API_KEY not set');
  });
});

describe('resolveProviderAvailability — azure-claude', () => {
  const READY = {
    active: true,
    claudeDeployment: 'claude-opus-4-7',
    claudeRoute: { baseUrl: 'https://x.services.ai.azure.com/anthropic', apiKey: 'k', authMode: 'bearer' },
  };

  it('is available when profile, route and deployment all resolve', () => {
    const r = resolveProviderAvailability('azure-claude', { azure: READY, env: {} });
    assert.equal(r.available, true);
    assert.equal(r.route, 'azure');
  });

  it('is unavailable off Azure, and says so instead of naming a key', () => {
    const r = resolveProviderAvailability('azure-claude', { azure: AZURE_OFF, env: { ANTHROPIC_API_KEY: 'x' } });
    assert.equal(r.available, false);
    assert.match(r.reason, /Azure work profile is not active/);
  });

  // Three independent prerequisites, separately absent in practice — each must
  // report the one that is actually missing, or the operator debugs the wrong
  // variable.
  it('names the unresolved route when the credential is missing', () => {
    const r = resolveProviderAvailability('azure-claude', {
      azure: { ...READY, claudeRoute: { baseUrl: READY.claudeRoute.baseUrl, apiKey: null } },
      env: {},
    });
    assert.equal(r.available, false);
    assert.match(r.reason, /route did not resolve/);
  });

  it('names the missing deployment when route and profile are fine', () => {
    const r = resolveProviderAvailability('azure-claude', { azure: { ...READY, claudeDeployment: null }, env: {} });
    assert.equal(r.available, false);
    assert.match(r.reason, /AZURE_FOUNDRY_CLAUDE_DEPLOYMENT/);
  });
});

describe('defaultProviders — two voices, chosen by profile', () => {
  it('is unchanged on the public profile', () => {
    assert.deepEqual(defaultProviders({ azure: AZURE_OFF }), ['openai', 'gemini']);
  });

  it('substitutes the Azure voice for the structurally-absent Gemini one', () => {
    assert.deepEqual(defaultProviders({ azure: AZURE_ON }), ['openai', 'azure-claude']);
  });

  it('always offers exactly two voices — the skill compares, it does not monologue', () => {
    for (const azure of [AZURE_ON, AZURE_OFF]) {
      assert.equal(defaultProviders({ azure }).length, 2);
    }
  });
});

// A provider is only real if every table that must know about it does. These
// live in four files; the failure mode is a voice that parses but has no
// adapter, or has an adapter but no context ceiling — the latter shipped as a
// FATAL crash mid-run during this change and was caught only by running it.
describe('declared providers are wired everywhere', () => {
  for (const p of BRAINSTORM_PROVIDERS) {
    it(`"${p}" has an input-token ceiling table`, () => {
      assert.ok(
        Object.hasOwn(PROVIDER_INPUT_CEILING_TOKENS, p),
        `provider-limits.mjs has no entry for "${p}" — resume-context assembly throws Unknown provider`,
      );
      assert.equal(typeof PROVIDER_INPUT_CEILING_TOKENS[p].default, 'number');
    });

    it(`"${p}" is accepted by the provider-result schema`, () => {
      const parsed = ProviderResultSchema.safeParse({
        provider: p, state: 'misconfigured', text: null, errorMessage: 'x',
        httpStatus: null, usage: null, latencyMs: 0, estimatedCostUsd: null,
      });
      assert.ok(parsed.success, `ProviderResultSchema rejects "${p}"`);
    });
  }
});

describe('resolveProviderAvailability — wiring errors', () => {
  it('throws on an unknown provider rather than reporting a config problem', () => {
    assert.throws(
      () => resolveProviderAvailability('anthropic', { azure: AZURE_OFF, env: {} }),
      /unknown provider "anthropic"/,
    );
  });
});

describe('brainstorm CLI — Azure-only install', () => {
  // Unroutable by RFC 6761: `.invalid` never resolves, so the call fails at
  // the transport with no egress to a real endpoint and no spend. What is
  // being observed is that a call was ATTEMPTED at all.
  const AZURE_ONLY_ENV = {
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    AZURE_OPENAI_ENDPOINT: 'https://brainstorm-availability-test.invalid',
    AZURE_OPENAI_API_KEY: 'fake-key-not-a-secret',
    AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-test-deployment',
    AZURE_MAX_RETRIES: '0',
    MODEL_CATALOG_REFRESH: 'skip',
  };

  it('does not report the OpenAI voice misconfigured when only Azure is configured', () => {
    const outFile = path.join(os.tmpdir(), `brainstorm-azure-${Date.now()}.json`);
    const r = spawnSync('node', [
      HELPER, '--topic', 'azure availability probe', '--models', 'openai',
      '--max-tokens', '64', '--timeout-ms', '15000', '--out', outFile,
    ], { encoding: 'utf-8', timeout: 60_000, env: { ...process.env, ...AZURE_ONLY_ENV } });

    try {
      assert.equal(r.status, 0, `expected exit 0 (total output contract); stderr: ${r.stderr}`);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      const openai = doc.providers.find(p => p.provider === 'openai');
      assert.ok(openai, 'openai leg missing from envelope');
      assert.notEqual(
        openai.state, 'misconfigured',
        'the Azure route was pre-empted by the public-key gate — the 2026-08-13 regression',
      );
      // The call was attempted: a short-circuit records exactly 0ms.
      assert.ok(openai.latencyMs > 0, `expected a real call attempt, got latencyMs=${openai.latencyMs}`);
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });

  it('still reports misconfigured when NEITHER profile is configured (negative control)', () => {
    const outFile = path.join(os.tmpdir(), `brainstorm-none-${Date.now()}.json`);
    const r = spawnSync('node', [
      HELPER, '--topic', 'no profile probe', '--models', 'openai', '--out', outFile,
    ], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, ...AZURE_ONLY_ENV, AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_API_KEY: '' },
    });

    try {
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      const openai = doc.providers.find(p => p.provider === 'openai');
      assert.equal(openai.state, 'misconfigured');
      assert.equal(openai.latencyMs, 0);
      assert.match(openai.errorMessage, /OPENAI_API_KEY/);
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });
});
