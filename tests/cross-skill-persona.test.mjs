import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CLI = path.resolve('scripts/cross-skill.mjs');

function runCli(args, { env = {} } = {}) {
  // Force cloud:false mode: strip env vars AND point dotenv at a
  // non-existent file so it can't re-populate from .env on startup.
  // shared-cloud-config follow-up: also strip SHARED_VARS and disable
  // the ~/.audit-loop.env autoload (`AUDIT_LOOP_DISABLE_SHARED=1`) so
  // the operator's bootstrapped shared file doesn't leak AUDIT_DB_URL
  // (etc.) into the subprocess and turn these "no-op when cloud
  // unavailable" tests into real-cloud round-trips.
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.PERSONA_TEST_SUPABASE_URL;
  delete cleanEnv.PERSONA_TEST_SUPABASE_ANON_KEY;
  delete cleanEnv.SUPABASE_AUDIT_URL;
  delete cleanEnv.SUPABASE_AUDIT_ANON_KEY;
  delete cleanEnv.AUDIT_DB_URL;
  delete cleanEnv.AUDIT_DB_SSL_MODE;
  cleanEnv.AUDIT_LOOP_DISABLE_SHARED = '1';
  cleanEnv.DOTENV_CONFIG_PATH = 'nonexistent-for-test';
  cleanEnv.DOTENV_CONFIG_QUIET = 'true';

  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: cleanEnv,
    timeout: 15000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

describe('cross-skill persona CLI — no-op when cloud unavailable', () => {
  it('list-personas returns empty rows with cloud:false', () => {
    const r = runCli(['list-personas', '--url', 'https://example.com']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.cloud, false);
    assert.deepEqual(r.json.rows, []);
  });

  it('list-personas rejects missing --url', () => {
    const r = runCli(['list-personas']);
    assert.notEqual(r.status, 0);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.error.code, 'BAD_INPUT');
  });

  it('list-personas rejects invalid URL', () => {
    const r = runCli(['list-personas', '--url', 'not-a-url']);
    assert.notEqual(r.status, 0);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.error.code, 'BAD_INPUT');
  });

  it('add-persona no-op with cloud:false', () => {
    const r = runCli(['add-persona', '--json', JSON.stringify({
      name: 'Demo',
      description: 'Demo persona for test',
      appUrl: 'https://example.com',
    })]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.cloud, false);
    assert.equal(r.json.personaId, null);
  });

  it('add-persona rejects missing required fields', () => {
    const r = runCli(['add-persona', '--json', JSON.stringify({ name: 'only-name' })]);
    assert.notEqual(r.status, 0);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.error.code, 'BAD_INPUT');
    const issues = r.json.error.issues || [];
    const paths = new Set(issues.map(i => i.path.join('.')));
    assert.ok(paths.has('description') || paths.has('appUrl'));
  });

  it('record-persona-session no-op with cloud:false', () => {
    const r = runCli(['record-persona-session', '--json', JSON.stringify({
      sessionId: 'persona-test-12345',
      persona: 'Tester',
      url: 'https://example.com',
      browserTool: 'Playwright MCP',
      stepsTaken: 8,
      verdict: 'Ready for users',
      p0Count: 0, p1Count: 0, p2Count: 1, p3Count: 0,
      findings: [],
    })]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.cloud, false);
    assert.equal(r.json.sessionId, null);
    assert.equal(r.json.statsUpdated, false);
  });

  it('record-persona-session rejects invalid verdict enum', () => {
    const r = runCli(['record-persona-session', '--json', JSON.stringify({
      sessionId: 'persona-test-1',
      persona: 'x',
      url: 'https://example.com',
      browserTool: 'x',
      verdict: 'wrong',
    })]);
    assert.notEqual(r.status, 0);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.error.code, 'BAD_INPUT');
  });
});

describe('cross-skill detect-stack', () => {
  it('reports js-ts for this repo', () => {
    const r = runCli(['detect-stack']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.stack, 'js-ts');
  });

  it('honours --include-env-manager', () => {
    const r = runCli(['detect-stack', '--include-env-manager']);
    assert.equal(r.status, 0);
    assert.equal(r.json.environmentManager, 'none');
  });
});
