/**
 * @fileoverview Pins for the test-env hermeticity boundary (scripts/run-tests.mjs).
 *
 * The class: agent harnesses and corporate machines inject provider-routing
 * env vars into ambient shells (Claude Code desktop injects
 * `ANTHROPIC_BASE_URL`; a work profile carries `AZURE_OPENAI_ENDPOINT`), and
 * `azureConfig` is a module-LOAD-time snapshot — so a suite verdict could
 * depend on which shell ran it. Before the runner existed, a hostile ambient
 * `AZURE_OPENAI_ENDPOINT` flipped 3 real verdicts (audit-plan/rebuttal smoke
 * ×2 via inherited child env, model-ab-egress via the load-time snapshot).
 *
 * Success-path adversarialism: the suite proves BOTH directions — that a
 * hostile env genuinely activates the Azure profile without the scrub (the
 * hazard exists and the probe can see it), AND that the scrub kills it. A
 * scrub test without the hazard mirror could pass while testing nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SCRUBBED_ROUTING_ENV, scrubRoutingEnv } from '../scripts/run-tests.mjs';

const ROOT = path.join(import.meta.dirname, '..');

const HOSTILE = {
  AZURE_OPENAI_ENDPOINT: 'https://hostile.openai.azure.com',
  AZURE_OPENAI_API_KEY: 'hostile-key',
  AZURE_OPENAI_GPT_DEPLOYMENT: 'hostile-gpt',
  AZURE_AI_ENDPOINT: 'https://hostile.services.ai.azure.com',
};

/** Spawn a probe that imports config.mjs and exits 0 iff azureConfig.active. */
function probeAzureActive(env) {
  try {
    execFileSync(process.execPath, [
      '-e',
      'import("./scripts/lib/config.mjs").then(m => process.exit(m.azureConfig.active ? 0 : 1))',
    ], { cwd: ROOT, env, stdio: 'ignore', timeout: 60000 });
    return true;   // exit 0 → active
  } catch {
    return false;  // non-zero → inactive
  }
}

describe('the hazard is real and the scrub kills it (both directions)', () => {
  test('MIRROR (the hazard): hostile ambient env ACTIVATES the Azure profile at module load', () => {
    // Without this direction, the scrub test below could pass vacuously —
    // e.g. if the probe were broken, or config stopped reading these vars.
    const active = probeAzureActive({ ...process.env, ...HOSTILE });
    assert.equal(active, true, 'the hostile env must be able to activate the profile, or this whole suite tests nothing');
  });

  test('the scrub: the same hostile env, scrubbed, does NOT activate the profile', () => {
    const active = probeAzureActive(scrubRoutingEnv({ ...process.env, ...HOSTILE }));
    assert.equal(active, false, 'a scrubbed child must resolve the public profile');
  });
});

describe('scrubRoutingEnv — the pure contract', () => {
  test('removes every listed routing selector', () => {
    const out = scrubRoutingEnv({ ...HOSTILE, ANTHROPIC_BASE_URL: 'https://x', CLAUDE_BACKEND: 'cli', OPENAI_BASE_URL: 'https://y' });
    for (const k of SCRUBBED_ROUTING_ENV) assert.equal(k in out, false, `${k} must be scrubbed`);
  });

  test('NEVER touches credentials or unrelated vars', () => {
    // Credentials are how CI injects secrets; scrubbing them breaks real
    // workflows. A key with no routing selector is inert for verdicts.
    const input = {
      AZURE_OPENAI_API_KEY: 'kept',
      OPENAI_API_KEY: 'kept',
      ANTHROPIC_API_KEY: 'kept',
      GEMINI_API_KEY: 'kept',
      AUDIT_DB_TEST_URL: 'kept',
      PATH: '/usr/bin',
    };
    const out = scrubRoutingEnv(input);
    assert.deepEqual(out, input, 'only routing selectors may be removed');
  });

  test('is pure — the input object is not mutated', () => {
    const input = { AZURE_OPENAI_ENDPOINT: 'https://x' };
    scrubRoutingEnv(input);
    assert.equal(input.AZURE_OPENAI_ENDPOINT, 'https://x');
  });
});

describe('DRIFT GUARD: the scrub list tracks what the config layer actually reads', () => {
  // The census spans BOTH files since 2026-08-30: `buildClaudeRoute` moved to
  // azure-claude-route.mjs so anthropic-client.mjs could consult it without
  // importing config.mjs. Reading config.mjs alone would have declared
  // AZURE_CLAUDE_ROUTE / AZURE_AI_API_KEY "no longer read" while they still
  // steer every Claude request — a census whose SOURCE SET is narrower than the
  // behaviour it guards reports a hole as a clean bill of health.
  const CONFIG_SOURCES = ['scripts/lib/config.mjs', 'scripts/lib/azure-claude-route.mjs'];
  const readConfigLayer = () => CONFIG_SOURCES
    .map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')).join('\n');
  // The recurring class this week: a hygiene list and a resolution list drift
  // apart (the anthropic beforeEach saved 3 of the 4 vars the factory reads).
  // This pin makes the drift a test failure instead of a latent hole: every
  // `env.AZURE_*` token in config.mjs must be either scrubbed or an
  // explicitly-documented credential.
  // Credentials, not selectors: inert on their own — neither can activate the
  // Azure profile or move a request, because only an ENDPOINT does that.
  // `AZURE_AI_API_KEY` is the direct-Foundry credential; it is read only after
  // `AZURE_CLAUDE_ROUTE`/`AZURE_AI_ENDPOINT` (both scrubbed) have already chosen
  // the foundry route, so an ambient value cannot redirect anything by itself.
  const CREDENTIAL_ALLOWLIST = new Set(['AZURE_OPENAI_API_KEY', 'AZURE_AI_API_KEY']);

  test('every AZURE_* var buildAzureConfig consumes is scrubbed or a documented credential', () => {
    const src = readConfigLayer();
    const consumed = new Set([...src.matchAll(/env\.(AZURE_[A-Z_]+)/g)].map((m) => m[1]));
    assert.ok(consumed.size >= 8, `sanity: expected the Azure var census to find the known set, got ${consumed.size}`);
    for (const v of consumed) {
      assert.ok(
        SCRUBBED_ROUTING_ENV.includes(v) || CREDENTIAL_ALLOWLIST.has(v),
        `config.mjs reads env.${v} but it is neither scrubbed nor allowlisted as a credential — ` +
        'add it to SCRUBBED_ROUTING_ENV (routing selector) or CREDENTIAL_ALLOWLIST (credential, with rationale)',
      );
    }
  });

  test('MIRROR: nothing in the scrub list is dead weight for the Azure family', () => {
    // Every scrubbed AZURE_* var must actually be consumed somewhere in
    // the config layer — a stale entry hides a rename (the var would silently
    // stop being scrubbed under its new name while the old name stays green).
    const src = readConfigLayer();
    const consumed = new Set([...src.matchAll(/env\.(AZURE_[A-Z_]+)/g)].map((m) => m[1]));
    for (const v of SCRUBBED_ROUTING_ENV.filter((k) => k.startsWith('AZURE_'))) {
      assert.ok(consumed.has(v), `${v} is scrubbed but the config layer no longer reads it — renamed?`);
    }
  });
});

describe('the runner end-to-end (the previously-flipping suites, under hostile env)', () => {
  test('run-tests.mjs passes the real victim suites with a hostile ambient env', () => {
    // model-ab-egress was the pure load-time-snapshot victim; openai-client is
    // the provider suite itself. Before the runner: 3 failures under this env.
    execFileSync(process.execPath, [
      'scripts/run-tests.mjs',
      'tests/model-ab-egress.test.mjs',
      'tests/openai-client.test.mjs',
    ], {
      cwd: ROOT,
      env: { ...process.env, ...HOSTILE },
      stdio: 'ignore',
      timeout: 300000,
    });
    // execFileSync throws on non-zero exit — reaching here IS the assertion.
  });
});
