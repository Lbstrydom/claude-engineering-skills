/**
 * @fileoverview Migration 20261123130000_restore_original_unique_keys_after_local_reconcile against a real Postgres.
 *
 * Reproduces the 2026-11-20 incident shape (three unique keys replaced by `model`-including variants) INSIDE a
 * transaction that is always rolled back, runs the migration's SQL, and asserts the original keys are back, that a healthy
 * store is a no-op, and that duplicate rows under the original key make it refuse with a count and change nothing.
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND .github/workflows/postgres-parity.yml - two edits, always.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is the URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';
const SQL = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations',
    '20261123130000_restore_original_unique_keys_after_local_reconcile.sql'), 'utf8');

const KEYS = {
  bandit_arms_unique: ['bandit_arms', 'UNIQUE (pass_name, variant_id, context_bucket)'],
  false_positive_patterns_repo_pattern_key: ['false_positive_patterns', 'UNIQUE (repo_id, pattern_type, pattern_value)'],
  prompt_variants_pass_variant_key: ['prompt_variants', 'UNIQUE (pass_name, variant_name)'],
};

describe('restore original unique keys (DB integration)', { skip }, () => {
  let pool;
  before(async () => {
    const client = await import('../scripts/lib/db/client.mjs');
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    client._resetForTest?.();
    pool = await client.getPool();
  });
  after(async () => {
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  /** Run `fn(c)` in a transaction that is ALWAYS rolled back. */
  async function inRolledBackTx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  const defOf = async (c, name) => (await c.query(
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND contype = 'u'`, [name])).rows.map((r) => r.d);
  const drift = async (c) => {
    await c.query('ALTER TABLE bandit_arms ADD COLUMN model text');
    await c.query('ALTER TABLE false_positive_patterns ADD COLUMN model text');
    await c.query('ALTER TABLE prompt_variants ADD COLUMN model text');
    for (const n of Object.keys(KEYS)) await c.query(`ALTER TABLE ${KEYS[n][0]} DROP CONSTRAINT ${n}`);
    await c.query('ALTER TABLE bandit_arms ADD CONSTRAINT bandit_arms_unique UNIQUE (pass_name, variant_id, context_bucket, model)');
    await c.query('ALTER TABLE false_positive_patterns ADD CONSTRAINT fp_model_key UNIQUE (repo_id, pattern_type, pattern_value, model)');
    await c.query('ALTER TABLE prompt_variants ADD CONSTRAINT prompt_variants_pass_variant_model_key UNIQUE (pass_name, variant_name, model)');
  };

  test('healthy store: the migration is a no-op and the three keys stay exact', async () => {
    await inRolledBackTx(async (c) => {
      const oids = (await c.query(`SELECT conname, oid FROM pg_constraint WHERE conname = ANY($1)`, [Object.keys(KEYS)])).rows;
      await c.query(SQL);
      for (const [n, [, def]] of Object.entries(KEYS)) assert.deepEqual(await defOf(c, n), [def], n);
      const after = (await c.query(`SELECT conname, oid FROM pg_constraint WHERE conname = ANY($1)`, [Object.keys(KEYS)])).rows;
      assert.deepEqual(after, oids, 'no constraint was dropped and recreated');
    });
  });

  test('drifted store (the incident shape): originals restored, model variants gone, idempotent on re-run', async () => {
    await inRolledBackTx(async (c) => {
      await drift(c);
      await c.query(SQL);
      for (const [n, [, def]] of Object.entries(KEYS)) assert.deepEqual(await defOf(c, n), [def], n);
      for (const gone of ['fp_model_key', 'prompt_variants_pass_variant_model_key']) assert.deepEqual(await defOf(c, gone), [], gone);
      await c.query(SQL); // second run: no-op, no error
      // The real consequence: the code's ON CONFLICT target resolves again.
      await c.query(`INSERT INTO prompt_variants (pass_name, variant_name, prompt_hash) VALUES ('p','v','h')
                     ON CONFLICT (pass_name, variant_name) DO NOTHING`);
    });
  });

  test('an identically named index on ANOTHER table is never dropped: refuses instead', async () => {
    await inRolledBackTx(async (c) => {
      await drift(c);
      await c.query('ALTER TABLE prompt_variants DROP CONSTRAINT prompt_variants_pass_variant_model_key');
      await c.query('CREATE TABLE zz_other (a int)');
      await c.query('CREATE UNIQUE INDEX prompt_variants_pass_variant_key ON zz_other (a)');
      await c.query('SAVEPOINT s');
      await assert.rejects(() => c.query(SQL), /belongs to another table/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      const r = await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'prompt_variants_pass_variant_key' AND tablename = 'zz_other'`);
      assert.equal(r.rowCount, 1, 'the unrelated index is untouched');
    });
  });

  test('a same-named PARTIAL or differently-keyed unique index is refused, not dropped', async () => {
    for (const ddl of [
      'CREATE UNIQUE INDEX prompt_variants_pass_variant_key ON prompt_variants (pass_name, variant_name) WHERE is_active',
      'CREATE UNIQUE INDEX prompt_variants_pass_variant_key ON prompt_variants (prompt_hash)',
    ]) {
      await inRolledBackTx(async (c) => {
        await drift(c);
        await c.query('ALTER TABLE prompt_variants DROP CONSTRAINT prompt_variants_pass_variant_model_key');
        await c.query(ddl);
        await c.query('SAVEPOINT s');
        await assert.rejects(() => c.query(SQL), /not a plain unique index over the original key/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        assert.equal((await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'prompt_variants_pass_variant_key'`)).rowCount, 1);
      });
    }
  });

  test('a plain bare unique index over the original key IS replaced by the constraint', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('ALTER TABLE prompt_variants DROP CONSTRAINT prompt_variants_pass_variant_key');
      await c.query('CREATE UNIQUE INDEX prompt_variants_pass_variant_key ON prompt_variants (pass_name, variant_name)');
      await c.query(SQL);
      assert.deepEqual(await defOf(c, 'prompt_variants_pass_variant_key'), ['UNIQUE (pass_name, variant_name)']);
    });
  });

  test('duplicates under the original key: refuses with the count and changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      await drift(c);
      await c.query(`INSERT INTO bandit_arms (pass_name, variant_id, model) VALUES ('p','v','m1'), ('p','v','m2')`);
      await c.query('SAVEPOINT s');
      await assert.rejects(() => c.query(SQL), /bandit_arms cannot be restored .*1 duplicate group/s);
      await c.query('ROLLBACK TO SAVEPOINT s');
      assert.deepEqual(await defOf(c, 'bandit_arms_unique'), ['UNIQUE (pass_name, variant_id, context_bucket, model)'],
        'the drifted key is untouched after a refusal');
    });
  });
});
