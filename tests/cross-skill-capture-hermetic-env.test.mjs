/**
 * @fileoverview Defect 9f722c58 — scripts/dev/capture-cross-skill-envelopes.mjs
 * calls its runs hermetic but left provider keys in the child env, so a case
 * whose args reach a paid LLM call (`arm-eval-run` has no cloud gate) would have
 * billed the shell that ran the capture. `buildCaseEnv` is the one place the
 * child env is built; these tests pin what it removes and what it must keep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaseEnv } from '../scripts/dev/capture-cross-skill-envelopes.mjs';
import { PROVIDER_ENV_VARS } from './helpers/provider-env.mjs';

test('every var in the test layer\'s PROVIDER_ENV_VARS is scrubbed from the case env (the copy cannot drift)', () => {
  const base = { PATH: '/usr/bin', ...Object.fromEntries(PROVIDER_ENV_VARS.map((k) => [k, 'x'])) };
  const env = buildCaseEnv(base);
  const leaked = PROVIDER_ENV_VARS.filter((k) => k in env);
  assert.deepEqual(leaked, [], `provider vars that survived into the hermetic child env: ${leaked.join(', ')}`);
});

test('with provider credentials set in the ambient env, none reach the child env — and PATH etc. still do', () => {
  const saved = {};
  const set = {
    ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test',
    AZURE_OPENAI_API_KEY: 'az-test', AZURE_SOMETHING_NEW: 'az-new', OPENROUTER_API_KEY: 'or-test',
  };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const env = buildCaseEnv(process.env);
    for (const k of Object.keys(set)) assert.equal(k in env, false, `${k} must not reach the hermetic child`);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
    assert.ok(pathKey, 'instrument check: the ambient env has a PATH');
    assert.equal(env[pathKey], process.env[pathKey], 'non-provider vars (PATH) must be carried through');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('matching is case-insensitive — a Windows-style spelling does not slip through', () => {
  const env = buildCaseEnv({ Anthropic_Api_Key: 'x', openai_api_key: 'x', Azure_Openai_Endpoint: 'x', Keep: 'y' });
  assert.deepEqual(env, { Keep: 'y', AUDIT_LOOP_DISABLE_SHARED: '1' });
});

test('the pre-existing hermetic scrubs and HOME redirect are preserved; baseEnv is not mutated', () => {
  const base = { AUDIT_DB_URL: 'postgres://x', DOTENV_CONFIG_PATH: '/x', LEARNING_REPO_NAME: 'o/r', PERSONA_TEST_REPO_NAME: 'o/r', HOME: '/real', USERPROFILE: 'C:\real', Keep: 'y' };
  const snapshot = { ...base };
  const env = buildCaseEnv(base, '/tmp/case');
  for (const k of ['AUDIT_DB_URL', 'DOTENV_CONFIG_PATH', 'LEARNING_REPO_NAME', 'PERSONA_TEST_REPO_NAME']) assert.equal(k in env, false, k);
  assert.equal(env.HOME, '/tmp/case');
  assert.equal(env.USERPROFILE, '/tmp/case');
  assert.equal(env.AUDIT_LOOP_DISABLE_SHARED, '1');
  assert.equal(env.Keep, 'y');
  assert.deepEqual(base, snapshot, 'buildCaseEnv must be pure');
});

test('negative control: the pre-fix construction (spread + the four deletes) DID carry provider keys', () => {
  const base = { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test', AUDIT_DB_URL: 'x' };
  const prefix = { ...base, HOME: '/h', USERPROFILE: '/h', AUDIT_LOOP_DISABLE_SHARED: '1' };
  delete prefix.DOTENV_CONFIG_PATH; delete prefix.AUDIT_DB_URL; delete prefix.PERSONA_TEST_REPO_NAME; delete prefix.LEARNING_REPO_NAME;
  assert.ok('ANTHROPIC_API_KEY' in prefix && 'OPENAI_API_KEY' in prefix, 'the old shape leaked the keys — this is what the new test would have caught');
  assert.equal('ANTHROPIC_API_KEY' in buildCaseEnv(base, '/h'), false);
});
