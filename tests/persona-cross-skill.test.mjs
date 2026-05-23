/**
 * Tests for the new persona cross-skill subcommands wired during the
 * 20260507 RLS hardening (Phase B / service-role-only).
 *
 * The subcommands themselves talk to live Supabase via the learning-store,
 * which is unreachable from a unit test. Coverage focus:
 *   1. CLI argv parsing — flags vs JSON payload routing, defaults, validation
 *   2. Schema rejection of malformed payloads
 *   3. The `cloud:false` graceful-degradation contract when env is unset
 *
 * Live integration is exercised manually post-deploy via:
 *   node scripts/cross-skill.mjs get-persona-sessions-by-repo \
 *     --repo "<repo>" --limit 1
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, '..', 'scripts', 'cross-skill.mjs');

// Use a temp cwd so dotenv doesn't load the dev `.env` (which would
// re-supply PERSONA_TEST_SUPABASE_URL etc and make the cloud:false
// degradation untestable).
const NO_ENV_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-skill-test-'));

function run(argv, env = {}) {
  const cleanEnv = { ...process.env, ...env };
  // Strip env vars too so even if dotenv finds a stray .env it still
  // can't override our blank slate for these tests.
  // shared-cloud-config follow-up: also strip SHARED_VARS + disable
  // ~/.audit-loop.env autoload — see config.mjs AUDIT_LOOP_DISABLE_SHARED.
  delete cleanEnv.PERSONA_TEST_SUPABASE_URL;
  delete cleanEnv.PERSONA_TEST_SUPABASE_ANON_KEY;
  delete cleanEnv.PERSONA_TEST_SUPABASE_SERVICE_ROLE_KEY;
  delete cleanEnv.SUPABASE_AUDIT_URL;
  delete cleanEnv.SUPABASE_AUDIT_SERVICE_ROLE_KEY;
  delete cleanEnv.SUPABASE_AUDIT_ANON_KEY;
  delete cleanEnv.AUDIT_DB_URL;
  delete cleanEnv.AUDIT_DB_SSL_MODE;
  cleanEnv.AUDIT_LOOP_DISABLE_SHARED = '1';
  return spawnSync('node', [CLI, ...argv], {
    encoding: 'utf-8',
    timeout: 8000,
    env: cleanEnv,
    cwd: NO_ENV_CWD,
  });
}

// Cross-skill convention: BAD_INPUT exits with status 2 (per emitError default).
const EXIT_BAD_INPUT = 2;

describe('cross-skill: get-persona-sessions-by-repo', () => {
  it('rejects missing --repo with BAD_INPUT', () => {
    const r = run(['get-persona-sessions-by-repo']);
    assert.equal(r.status, EXIT_BAD_INPUT);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.error?.code, 'BAD_INPUT');
  });

  it('accepts --repo flag form', () => {
    const r = run(['get-persona-sessions-by-repo', '--repo', 'my-repo']);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.cloud, false);  // env stripped → cloud not configured
    assert.deepEqual(j.rows, []);
  });

  it('accepts --p0-only modifier without value', () => {
    const r = run(['get-persona-sessions-by-repo', '--repo', 'my-repo', '--p0-only']);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
  });

  it('accepts --select csv', () => {
    const r = run(['get-persona-sessions-by-repo', '--repo', 'my-repo', '--select', 'persona,verdict,p0_count']);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
  });

  it('accepts --limit numeric', () => {
    const r = run(['get-persona-sessions-by-repo', '--repo', 'my-repo', '--limit', '3']);
    assert.equal(r.status, 0);
  });

  it('accepts JSON payload via --json', () => {
    const r = run(['get-persona-sessions-by-repo', '--json', JSON.stringify({ repoName: 'my-repo', limit: 5 })]);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
  });

  it('rejects invalid limit (out of range)', () => {
    const r = run(['get-persona-sessions-by-repo', '--json', JSON.stringify({ repoName: 'r', limit: 9999 })]);
    assert.equal(r.status, EXIT_BAD_INPUT);
    const j = JSON.parse(r.stdout);
    assert.equal(j.error?.code, 'BAD_INPUT');
  });
});

describe('cross-skill: get-persona-sessions-by-url', () => {
  it('rejects missing --url with BAD_INPUT', () => {
    const r = run(['get-persona-sessions-by-url']);
    assert.equal(r.status, EXIT_BAD_INPUT);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.error?.code, 'BAD_INPUT');
  });

  it('accepts --url flag form + returns cloud:false when no env', () => {
    const r = run(['get-persona-sessions-by-url', '--url', 'https://example.test']);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.cloud, false);
    assert.deepEqual(j.rows, []);
  });

  it('accepts JSON payload + --select', () => {
    const r = run(['get-persona-sessions-by-url', '--json', JSON.stringify({ url: 'https://example.test', limit: 3, select: ['persona', 'verdict'] })]);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
  });
});

describe('Subcommands appear in --help', () => {
  it('lists both new subcommands', () => {
    const r = run(['--help']);
    assert.match(r.stdout, /get-persona-sessions-by-repo/);
    assert.match(r.stdout, /get-persona-sessions-by-url/);
  });
});
