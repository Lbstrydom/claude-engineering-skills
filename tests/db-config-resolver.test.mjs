/**
 * Env-resolver + fail-fast tests for `scripts/lib/db/client.mjs#getPool`.
 *
 * No DB connection is opened — every test exercises only the synchronous
 * portion of the resolver (null path or thrown error). Tests that would
 * have built a real Pool live in db-withtx.test.mjs / db-date-parser.test.mjs
 * behind the `AUDIT_DB_TEST_URL` env gate.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getPool, _resetForTest } from '../scripts/lib/db/client.mjs';

const ENV_KEYS = [
  'AUDIT_DB_URL',
  'AUDIT_DB_SSL_MODE',
  'AUDIT_DB_POOL_MAX',
  'AUDIT_DB_SCHEMA',
  'AUDIT_POSTGRES_SCHEMA',
  'SUPABASE_AUDIT_URL',
  'SUPABASE_AUDIT_ANON_KEY',
  'SUPABASE_AUDIT_SERVICE_ROLE_KEY',
];

let snapshot;

beforeEach(async () => {
  await _resetForTest();
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await _resetForTest();
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe('getPool() env resolver', () => {
  it('returns null when no audit DB env is set (graceful no-op)', async () => {
    const pool = await getPool();
    assert.equal(pool, null);
  });

  it('throws an actionable error when only legacy SUPABASE_AUDIT_URL is set', async () => {
    process.env.SUPABASE_AUDIT_URL = 'https://abc.supabase.co';
    await assert.rejects(
      () => getPool(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /AUDIT_DB_URL/);
        assert.match(err.message, /SUPABASE_AUDIT/);
        // The hint must mention how to find the DSN — verify the pointer
        // to the Supabase dashboard so the error is genuinely actionable.
        assert.match(err.message, /Connect/);
        return true;
      }
    );
  });

  it('throws on legacy anon key even when URL is unset', async () => {
    process.env.SUPABASE_AUDIT_ANON_KEY = 'eyJ-test-key';
    await assert.rejects(() => getPool(), /AUDIT_DB_URL/);
  });

  it('throws on legacy service-role key even when URL is unset', async () => {
    process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY = 'eyJ-svc-key';
    await assert.rejects(() => getPool(), /AUDIT_DB_URL/);
  });

  it('refuses a non-public AUDIT_DB_SCHEMA', async () => {
    process.env.AUDIT_DB_SCHEMA = 'audit_loop';
    await assert.rejects(
      () => getPool(),
      (err) => {
        assert.match(err.message, /public/);
        assert.match(err.message, /audit_loop/);
        return true;
      }
    );
  });

  it('refuses a non-public legacy AUDIT_POSTGRES_SCHEMA', async () => {
    process.env.AUDIT_POSTGRES_SCHEMA = 'audit_loop';
    await assert.rejects(() => getPool(), /public/);
  });

  it('accepts AUDIT_DB_SCHEMA="public" (explicit but valid)', async () => {
    // Schema check passes; resolver continues, finds no AUDIT_DB_URL, returns null.
    process.env.AUDIT_DB_SCHEMA = 'public';
    const pool = await getPool();
    assert.equal(pool, null);
  });

  it('legacy-only fail-fast wins over the null path', async () => {
    // AUDIT_DB_URL absent + legacy present → throw, not return null.
    process.env.SUPABASE_AUDIT_URL = 'https://x.supabase.co';
    await assert.rejects(() => getPool());
  });
});
