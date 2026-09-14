#!/usr/bin/env node
/**
 * @fileoverview One-time diagnostic: how many stored `symbol_refresh_coverage`
 * rows does the current `CoverageSchema` reject?
 *
 * `getGraphCoverage` (scripts/lib/store/arch/coverage.mjs) validates on read
 * and maps a schema failure to `null` — the same as "no row" — so a stored
 * row that predates a schema tightening degrades silently to `unknown`,
 * logged only as a stderr line at the moment something happens to read it.
 * That is the correct FAILURE direction (never a false clean verdict), but it
 * means nobody knows the blast radius of a tightening until they trip over it
 * one row at a time. This script answers that question directly: read every
 * row, run the SAME `CoverageSchema.safeParse` the live read path uses, and
 * report which ones fail and why.
 *
 * Read-only — this never writes, migrates, or backfills anything. It exists
 * to make an invisible degradation visible, not to fix it (there is no single
 * correct backfill: a row failing the arithmetic-coherence check has no
 * recoverable "correct" value, only the fact that it should be re-measured).
 *
 * Usage: node scripts/dev/coverage-schema-audit.mjs [--json]
 *
 * final-review-credit-queue fp 04dbf5b8 / id 4037e9ed
 */
import { getPool } from '../lib/db/client.mjs';
import { CoverageSchema } from '../lib/coverage-schema.mjs';
import { assertKnownFlags, ArgvError, hasFlag } from '../lib/cli-io.mjs';

const KNOWN_FLAGS = ['--json', '--selfcheck-relocation', '--help'];

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'coverage-schema-audit.mjs' });

  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT c.refresh_id, c.payload, rr.repo_id, ar.name AS repo_name
       FROM symbol_refresh_coverage c
       LEFT JOIN refresh_runs rr ON rr.id = c.refresh_id
       LEFT JOIN audit_repos ar ON ar.id = rr.repo_id
      ORDER BY c.created_at`,
  );

  const invalid = [];
  for (const row of rows) {
    const parsed = CoverageSchema.safeParse(row.payload);
    if (!parsed.success) {
      invalid.push({
        refreshId: row.refresh_id,
        repo: row.repo_name || row.repo_id || 'unknown-repo',
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
  }

  if (hasFlag('json')) {
    console.log(JSON.stringify({ scanned: rows.length, invalid: invalid.length, rows: invalid }, null, 2));
  } else {
    console.log(`Scanned ${rows.length} symbol_refresh_coverage row(s); ${invalid.length} fail CoverageSchema.`);
    for (const r of invalid) {
      console.log(`  ${r.refreshId} (${r.repo}): ${r.issues.join('; ')}`);
    }
  }
  process.exitCode = 0;
}

main().catch((err) => {
  if (err instanceof ArgvError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
