#!/usr/bin/env node
/**
 * @fileoverview Migration v3: add run-metadata columns to audit_runs.
 *
 * New columns:
 *   diff_lines_changed   INTEGER  — total +/- lines in the diff at audit time
 *   diff_files_changed   INTEGER  — number of files in the diff
 *   session_cache_hit    BOOLEAN  — whether --session-cache was a cache hit
 *   map_reduce_passes    TEXT[]   — which passes triggered map-reduce
 *   scope_mode           VARCHAR  — 'diff' | 'plan' | 'full'
 *   r2_skip_reason       VARCHAR  — why R2 was not run ('converged' | 'plan_mode' | 'small_diff')
 *
 * All columns are nullable — fully backward-compatible with existing rows.
 *
 * Usage:
 *   node scripts/migrate-v3-run-metadata.mjs
 *   DATABASE_URL=postgres://... node scripts/migrate-v3-run-metadata.mjs
 */

import './lib/load-env.mjs';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('Error: DATABASE_URL is required');
  process.exit(1);
}

let pg;
try {
  pg = await import('pg');
} catch {
  console.error('Error: pg not installed. Run: npm install pg');
  process.exit(1);
}

const { default: { Client } } = pg;
const client = new Client({ connectionString: DB_URL });

const MIGRATIONS = [
  {
    name: 'diff_lines_changed',
    sql: `ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_lines_changed INTEGER`,
  },
  {
    name: 'diff_files_changed',
    sql: `ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_files_changed INTEGER`,
  },
  {
    name: 'session_cache_hit',
    sql: `ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS session_cache_hit BOOLEAN`,
  },
  {
    name: 'map_reduce_passes',
    sql: `ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS map_reduce_passes TEXT[]`,
  },
  {
    name: 'scope_mode',
    sql: `ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS scope_mode VARCHAR(20)`,
  },
  {
    name: 'r2_skip_reason',
    sql: `ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS r2_skip_reason VARCHAR(50)`,
  },
];

async function run() {
  await client.connect();
  console.log('Connected. Running v3 migration...\n');

  let ok = 0;
  for (const m of MIGRATIONS) {
    try {
      await client.query(m.sql);
      console.log(`  [OK] ${m.name}`);
      ok++;
    } catch (err) {
      console.error(`  [ERR] ${m.name}: ${err.message}`);
    }
  }

  await client.end();
  console.log(`\nDone: ${ok}/${MIGRATIONS.length} migrations applied.`);
  if (ok < MIGRATIONS.length) process.exit(1);
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
