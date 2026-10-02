/**
 * @fileoverview The golden-envelope runner's "hermetic" env must not carry
 * provider credentials (final-review shadow finding e90f5737).
 *
 * `runCase` documented itself as hermetic — no DSN, HOME redirected, shared
 * config off, non-git cwd — but inherited every API key from the parent, and
 * its own comment admitted that `arm-eval-run` has no cloud gate and goes
 * straight to paid LLM calls. The only thing between the golden suite and a
 * billed request was the discipline of the CASES table. With the keys scrubbed,
 * a case that reaches a provider fails for want of a credential instead of
 * spending.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hermeticEnv } from '../scripts/dev/capture-cross-skill-envelopes.mjs';

const BASE = {
  PATH: '/usr/bin',
  SystemRoot: 'C:\\Windows',
  OPENAI_API_KEY: 'sk-x',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  GEMINI_API_KEY: 'g',
  GOOGLE_API_KEY: 'g2',
  OPENROUTER_API_KEY: 'or',
  XAI_API_KEY: 'xai',
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_OPENAI_API_KEY: 'az',
  AWS_ACCESS_KEY_ID: 'AKIA',
  AWS_SECRET_ACCESS_KEY: 'shh',
  AUDIT_DB_URL: 'postgresql://real',
  AUDIT_POSTGRES_URL: 'postgresql://real-alias',
  LEARNING_REPO_NAME: 'owner/repo',
};

describe('hermeticEnv', () => {
  const env = hermeticEnv('/tmp/case-dir', BASE);

  it('drops every provider credential and route', () => {
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY', 'XAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      assert.equal(env[k], undefined, `${k} leaked into the hermetic env`);
    }
  });

  it('keeps the existing hermetic properties (DSN off, HOME redirected, shared config off)', () => {
    assert.equal(env.AUDIT_DB_URL, undefined);
    assert.equal(env.LEARNING_REPO_NAME, undefined);
    assert.equal(env.HOME, '/tmp/case-dir');
    assert.equal(env.USERPROFILE, '/tmp/case-dir');
    assert.equal(env.AUDIT_LOOP_DISABLE_SHARED, '1');
  });

  it('keeps what a child process needs to start (negative control)', () => {
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.SystemRoot, 'C:\\Windows');
  });

  it('does not mutate the env it was given', () => {
    assert.equal(BASE.OPENAI_API_KEY, 'sk-x');
  });
});
