/**
 * @fileoverview `--repair-eol` against a REAL disposable Postgres (WS-A, R3-M2).
 *
 * The hermetic hashing suite (`setup-postgres-hashing.test.mjs`) proves the
 * byte contract; it structurally CANNOT prove the things that make a
 * production-writing repair safe: that the compare-and-swap actually matches
 * one row, that a conflicting row rolls the WHOLE transaction back, that the
 * advisory lock is really held, and that a second run is a no-op. Verifying
 * those on the shared store would be a single unrepeatable trial on
 * production data — so they run here, against a throwaway DB.
 *
 * Gated on AUDIT_DB_TEST_URL and `assertDisposableDbUrl` — the guard added
 * after the 2026-07-14 incident where a test DSN aliased to production.
 * Skips cleanly when unset.
 *
 * Run:
 *   node scripts/db-test-container.mjs up
 *   AUDIT_DB_TEST_URL=postgres://…  node --test tests/repair-eol.integration.test.mjs
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §3 WS-A.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';

import { assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import {
  hashCanonicalMigrationBytes,
  hashRawBytes,
  legacyCrlfBytes,
  runCheckDrift,
  runRepairEol,
  seedUnledgeredMigrations,
} from '../scripts/setup-postgres.mjs';
// cli-io.mjs's `sha(buf, len=12)` defaults to a 12-char truncation for
// content-identity display use; this file needs the FULL digest for
// hash-equality assertions, so every call site below passes `64`
// (SHA-256's full hex length) explicitly rather than duplicating the
// hashing logic in a local wrapper.
import { sha } from '../scripts/lib/cli-io.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;

// Fail-closed: refuse to run destructively against a production-shaped DSN.
let skipReason = TEST_URL ? false : 'set AUDIT_DB_TEST_URL to a disposable Postgres to run';
if (TEST_URL) {
  try {
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL ?? null });
  } catch (err) {
    skipReason = `AUDIT_DB_TEST_URL rejected as non-disposable: ${err.message}`;
  }
}

const LF = Buffer.from('CREATE TABLE canary (id int);\nSELECT 1;\n', 'utf-8');

describe('--repair-eol against a disposable Postgres', { skip: skipReason }, () => {
  let pool;
  let dir;

  /** Seed the ledger with one row per file, using the supplied hash. */
  async function seed(rows) {
    await pool.query('TRUNCATE audit_loop_migrations');
    for (const [filename, hash] of Object.entries(rows)) {
      await pool.query(
        'INSERT INTO audit_loop_migrations (filename, sha256) VALUES ($1, $2)',
        [filename, hash]
      );
    }
  }

  const ledgerRow = async (f) => (
    await pool.query('SELECT sha256 FROM audit_loop_migrations WHERE filename = $1', [f])
  ).rows[0]?.sha256;

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_URL, max: 4 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_loop_migrations (
        filename    text PRIMARY KEY,
        sha256      text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    // A migrations dir with three files — one per classification.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-eol-'));
    for (const f of ['001_canonical.sql', '002_legacy.sql', '003_tampered.sql']) {
      fs.writeFileSync(path.join(dir, f), LF);
    }
  });

  after(async () => {
    await pool?.query('DROP TABLE IF EXISTS audit_loop_migrations');
    await pool?.end();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  beforeEach(async () => {
    await seed({
      '001_canonical.sql': hashCanonicalMigrationBytes(LF),          // already correct
      '002_legacy.sql': hashRawBytes(legacyCrlfBytes(LF)),           // eol-legacy
      '003_tampered.sql': sha(Buffer.from('DROP TABLE users;\n'), 64),   // real mismatch
    });
  });

  it('classifies the three rows distinctly', async () => {
    const r = await runCheckDrift(pool, {
      format: 'json', migrationsDir: dir,
      stdout: { write() {} }, stderr: { write() {} },
    });
    assert.deepEqual(r.drift.eolLegacy.map((e) => e.filename), ['002_legacy.sql']);
    assert.deepEqual(r.drift.shaMismatch.map((e) => e.filename), ['003_tampered.sql']);
    assert.equal(r.drift.unapplied.length, 0);
  });

  it('repairs ONLY the eol-legacy row; canonical and tampered are untouched', async () => {
    const before = {
      canonical: await ledgerRow('001_canonical.sql'),
      tampered: await ledgerRow('003_tampered.sql'),
    };

    const res = await runRepairEol(pool, { migrationsDir: dir });

    assert.equal(res.repaired.length, 1);
    assert.equal(res.repaired[0].filename, '002_legacy.sql');
    assert.equal(await ledgerRow('002_legacy.sql'), hashCanonicalMigrationBytes(LF));
    // The tamper guard must survive the repair completely intact.
    assert.equal(await ledgerRow('003_tampered.sql'), before.tampered);
    assert.equal(await ledgerRow('001_canonical.sql'), before.canonical);
  });

  it('PRESERVES applied_at — a hash repair is not a re-deployment', async () => {
    // Stamping applied_at = now() would erase when the migration was actually
    // deployed, which is the ledger's evidentiary value. (Consolidated Gemini
    // gate G1 — the first implementation did exactly that.)
    const backdated = '2020-01-02T03:04:05.000Z';
    await pool.query(
      'UPDATE audit_loop_migrations SET applied_at = $2 WHERE filename = $1',
      ['002_legacy.sql', backdated]
    );
    const before = (await pool.query(
      'SELECT applied_at FROM audit_loop_migrations WHERE filename = $1', ['002_legacy.sql']
    )).rows[0].applied_at;

    await runRepairEol(pool, { migrationsDir: dir });

    const after = (await pool.query(
      'SELECT applied_at FROM audit_loop_migrations WHERE filename = $1', ['002_legacy.sql']
    )).rows[0].applied_at;
    assert.equal(after.toISOString(), before.toISOString(), 'applied_at must not change');
    assert.equal(await ledgerRow('002_legacy.sql'), hashCanonicalMigrationBytes(LF), 'but the hash IS repaired');
  });

  it('is idempotent — a second run classifies and writes nothing', async () => {
    await runRepairEol(pool, { migrationsDir: dir });
    const afterFirst = await ledgerRow('002_legacy.sql');

    const second = await runRepairEol(pool, { migrationsDir: dir });

    assert.equal(second.repaired.length, 0);
    assert.equal(second.exitCode, 0);
    assert.equal(await ledgerRow('002_legacy.sql'), afterFirst);
  });

  it('--dry-run reports the candidate but writes nothing', async () => {
    const before = await ledgerRow('002_legacy.sql');
    const res = await runRepairEol(pool, { migrationsDir: dir, dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(res.repaired.length, 0);
    assert.equal(await ledgerRow('002_legacy.sql'), before);
  });

  it('a row that changes between classify and write aborts the WHOLE transaction', async () => {
    // Two eol-legacy candidates. The race must land in the real window —
    // AFTER runRepairEol's own internal classification, BEFORE its UPDATEs.
    // (Pre-corrupting instead would just make the row classify as
    // shaMismatch, so it would never become a candidate and no CAS conflict
    // would occur — that mistake made an earlier version of this test pass
    // vacuously.)
    const second = '004_legacy_two.sql';
    fs.writeFileSync(path.join(dir, second), LF);
    await seed({
      '002_legacy.sql': hashRawBytes(legacyCrlfBytes(LF)),
      [second]: hashRawBytes(legacyCrlfBytes(LF)),
    });
    const originalFirst = await ledgerRow('002_legacy.sql');

    // Wrap the pool and race inside `connect()`. That lands exactly in the
    // window we need: runRepairEol has finished its internal classification
    // (it uses pool.query) but has not yet issued BEGIN or any UPDATE.
    // Deliberately NOT by monkey-patching client.query — overriding it fights
    // node-postgres's own use of that method and hangs the client.
    let raced = false;
    const racingPool = {
      query: (...a) => pool.query(...a),
      connect: async () => {
        const client = await pool.connect();
        if (!raced) {
          raced = true;
          await pool.query(
            'UPDATE audit_loop_migrations SET sha256 = $2 WHERE filename = $1',
            [second, 'deadbeef'.repeat(8)]
          );
        }
        return client;
      },
    };

    await assert.rejects(
      () => runRepairEol(racingPool, { migrationsDir: dir }),
      /concurrent modification/,
    );
    assert.equal(raced, true, 'the race hook never fired — test would be vacuous');

    // The FIRST row must be unchanged — proof the whole transaction rolled
    // back rather than leaving a half-repaired ledger.
    assert.equal(await ledgerRow('002_legacy.sql'), originalFirst);

    fs.rmSync(path.join(dir, second), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('holds the migration advisory lock for the duration of the repair', async () => {
    // Take the same lock from an independent session; the repair must block.
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', ['4152026071801']);

      let settled = false;
      const repair = runRepairEol(pool, { migrationsDir: dir }).then(
        (v) => { settled = true; return v; },
        (e) => { settled = true; throw e; },
      );
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(settled, false, 'repair proceeded while the lock was held');

      await blocker.query('ROLLBACK');       // release
      const res = await repair;              // now it can finish
      assert.equal(res.repaired.length, 1);
    } finally {
      blocker.release();
    }
  });
});

describe('seedUnledgeredMigrations — adopt must not rubber-stamp existing rows', { skip: skipReason }, () => {
  let pool;
  let dir;

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_URL, max: 4 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_loop_migrations (
        filename    text PRIMARY KEY,
        sha256      text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-seed-'));
    for (const f of ['001_a.sql', '002_b.sql', '003_c.sql']) fs.writeFileSync(path.join(dir, f), LF);
  });

  after(async () => {
    await pool?.query('DROP TABLE IF EXISTS audit_loop_migrations');
    await pool?.end();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('records ONLY unledgered files and leaves existing hashes byte-identical', async () => {
    // 002 is already ledgered with a TAMPERED hash. Seeding every file would
    // upsert over it, erasing the shaMismatch evidence — the exact bypass the
    // consolidated Gemini gate caught (round-3 G1).
    const tampered = sha(Buffer.from('DROP TABLE users;\n'), 64);
    await pool.query('TRUNCATE audit_loop_migrations');
    await pool.query('INSERT INTO audit_loop_migrations (filename, sha256) VALUES ($1,$2)', ['002_b.sql', tampered]);

    const existing = new Map([['002_b.sql', tampered]]);
    const seeded = await seedUnledgeredMigrations(pool, {
      files: ['001_a.sql', '002_b.sql', '003_c.sql'], existing, migrationsDir: dir,
    });

    assert.deepEqual(seeded, ['001_a.sql', '003_c.sql'], 'only the unledgered files are recorded');
    const row = await pool.query('SELECT sha256 FROM audit_loop_migrations WHERE filename = $1', ['002_b.sql']);
    assert.equal(row.rows[0].sha256, tampered, 'the tampered hash MUST survive — adopt is not a repair tool');
  });

  it('on an empty ledger, seeds everything (fresh adopt is unchanged)', async () => {
    await pool.query('TRUNCATE audit_loop_migrations');
    const seeded = await seedUnledgeredMigrations(pool, {
      files: ['001_a.sql', '002_b.sql', '003_c.sql'], existing: new Map(), migrationsDir: dir,
    });
    assert.deepEqual(seeded, ['001_a.sql', '002_b.sql', '003_c.sql']);
    const n = await pool.query('SELECT count(*)::int c FROM audit_loop_migrations');
    assert.equal(n.rows[0].c, 3);
  });

  it('records the CANONICAL hash for seeded rows', async () => {
    await pool.query('TRUNCATE audit_loop_migrations');
    await seedUnledgeredMigrations(pool, { files: ['001_a.sql'], existing: new Map(), migrationsDir: dir });
    const row = await pool.query('SELECT sha256 FROM audit_loop_migrations WHERE filename = $1', ['001_a.sql']);
    assert.equal(row.rows[0].sha256, hashCanonicalMigrationBytes(LF));
  });
});
