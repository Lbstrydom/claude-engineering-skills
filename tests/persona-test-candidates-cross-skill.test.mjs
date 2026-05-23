/**
 * Tests for the Phase 3 WS-PIPE1 cross-skill commands:
 *   - upsert-persona-test-candidate
 *   - list-persona-test-candidates
 *   - mark-persona-test-candidate-proposed
 *
 * These subcommands talk to live Supabase via the learning-store, which
 * is unreachable from a unit test. Coverage focus:
 *   1. CLI dispatch routes the command name correctly.
 *   2. Schema rejection of malformed payloads (BAD_INPUT).
 *   3. The `cloud:false` graceful-degradation contract when env is unset.
 *
 * Live integration is exercised manually against a configured DB.
 *
 * Plan: wine-cellar-app/docs/plans/persona-test-consistency-phase3.md
 *       (WS-PIPE1 cloud-write).
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

// Temp cwd so dotenv can't pick up a dev .env and re-supply Supabase
// vars (which would defeat the cloud:false graceful-degradation tests).
const NO_ENV_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe1-test-'));

function run(argv) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.PERSONA_TEST_SUPABASE_URL;
  delete cleanEnv.PERSONA_TEST_SUPABASE_ANON_KEY;
  delete cleanEnv.PERSONA_TEST_SUPABASE_SERVICE_ROLE_KEY;
  delete cleanEnv.SUPABASE_AUDIT_URL;
  delete cleanEnv.SUPABASE_AUDIT_SERVICE_ROLE_KEY;
  delete cleanEnv.SUPABASE_AUDIT_ANON_KEY;
  delete cleanEnv.AUDIT_DB_URL;
  delete cleanEnv.AUDIT_DB_SSL_MODE;
  // shared-cloud-config follow-up: disable ~/.audit-loop.env autoload.
  cleanEnv.AUDIT_LOOP_DISABLE_SHARED = '1';
  return spawnSync('node', [CLI, ...argv], {
    encoding: 'utf-8',
    timeout: 8000,
    env: cleanEnv,
    cwd: NO_ENV_CWD,
  });
}

const EXIT_BAD_INPUT = 2;

describe('cross-skill: upsert-persona-test-candidate', () => {
  it('rejects missing repoName with BAD_INPUT', () => {
    const r = run(['upsert-persona-test-candidate', '--json', JSON.stringify({
      fingerprint: 'abc', canaryName: 'c', surfaceId: 's', severity: 'P2'
    })]);
    assert.equal(r.status, EXIT_BAD_INPUT);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.error?.code, 'BAD_INPUT');
  });

  it('rejects missing fingerprint with BAD_INPUT', () => {
    const r = run(['upsert-persona-test-candidate', '--json', JSON.stringify({
      repoName: 'r', canaryName: 'c', surfaceId: 's', severity: 'P2'
    })]);
    assert.equal(r.status, EXIT_BAD_INPUT);
  });

  it('rejects missing canaryName/surfaceId/severity with BAD_INPUT', () => {
    const r = run(['upsert-persona-test-candidate', '--json', JSON.stringify({
      repoName: 'r', fingerprint: 'abc'
    })]);
    assert.equal(r.status, EXIT_BAD_INPUT);
  });

  it('rejects invalid severity with BAD_INPUT (out of P0..P3)', () => {
    const r = run(['upsert-persona-test-candidate', '--json', JSON.stringify({
      repoName: 'r', fingerprint: 'abc', canaryName: 'c', surfaceId: 's', severity: 'CRITICAL'
    })]);
    assert.equal(r.status, EXIT_BAD_INPUT);
    const j = JSON.parse(r.stdout);
    assert.match(j.error.message, /severity/i);
  });

  it('accepts valid payload — passes validation + reaches dispatch', () => {
    const r = run(['upsert-persona-test-candidate', '--json', JSON.stringify({
      repoName: 'test-repo', fingerprint: 'a'.repeat(64),
      canaryName: 'c', surfaceId: 's', severity: 'P2'
    })]);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    // Either (a) cloud unset → ok:true cloud:false (graceful-degrade), or
    // (b) cloud configured → dispatch ran, store layer returned a result
    // (ok:true on a working DB, ok:false on a DB missing the table).
    // What we're pinning is: command DISPATCHED + JSON envelope shape.
    assert.equal(typeof j.ok, 'boolean');
    assert.equal(typeof j.cloud, 'boolean');
  });

  it('accepts every P0..P3 severity', () => {
    for (const severity of ['P0', 'P1', 'P2', 'P3']) {
      const r = run(['upsert-persona-test-candidate', '--json', JSON.stringify({
        repoName: 'r', fingerprint: 'f', canaryName: 'c', surfaceId: 's', severity
      })]);
      assert.equal(r.status, 0, `severity=${severity} should be accepted`);
    }
  });
});

describe('cross-skill: list-persona-test-candidates', () => {
  it('rejects missing repoName with BAD_INPUT', () => {
    const r = run(['list-persona-test-candidates', '--json', '{}']);
    assert.equal(r.status, EXIT_BAD_INPUT);
    const j = JSON.parse(r.stdout);
    assert.equal(j.error?.code, 'BAD_INPUT');
  });

  it('accepts minimal payload — passes validation + reaches dispatch', () => {
    const r = run(['list-persona-test-candidates', '--json', JSON.stringify({
      repoName: 'test-repo'
    })]);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    // Envelope shape contract — DB-connection state can vary in CI.
    assert.equal(j.ok, true);
    assert.equal(typeof j.cloud, 'boolean');
    assert.ok(Array.isArray(j.candidates));
  });

  it('threads policy thresholds through the payload', () => {
    // Just check it accepts the shape; the actual filtering is store-layer.
    const r = run(['list-persona-test-candidates', '--json', JSON.stringify({
      repoName: 'r', ageDays: 14, occurrencesFloor: 5, severityFloor: 'P1'
    })]);
    assert.equal(r.status, 0);
  });
});

describe('cross-skill: mark-persona-test-candidate-proposed', () => {
  it('rejects missing repoName with BAD_INPUT', () => {
    const r = run(['mark-persona-test-candidate-proposed', '--json', JSON.stringify({
      fingerprint: 'abc'
    })]);
    assert.equal(r.status, EXIT_BAD_INPUT);
  });

  it('rejects missing fingerprint with BAD_INPUT', () => {
    const r = run(['mark-persona-test-candidate-proposed', '--json', JSON.stringify({
      repoName: 'r'
    })]);
    assert.equal(r.status, EXIT_BAD_INPUT);
  });

  it('accepts valid payload — passes validation + reaches dispatch', () => {
    const r = run(['mark-persona-test-candidate-proposed', '--json', JSON.stringify({
      repoName: 'r', fingerprint: 'a'.repeat(64)
    })]);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(typeof j.ok, 'boolean');
    assert.equal(typeof j.cloud, 'boolean');
    assert.equal(typeof j.rowsAffected, 'number');
  });
});
