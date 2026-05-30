#!/usr/bin/env node
/**
 * @fileoverview Diagnostic: list every public table without Row-Level
 * Security enabled, plus the anon/authenticated grants that make a
 * no-RLS table actually exploitable on a Supabase project.
 *
 * Background: Supabase's `rls_disabled_in_public` security scanner fires
 * whenever a public table has `relrowsecurity=false`. The audit-loop is
 * single-tenant (the runtime DSN's owner role bypasses RLS), but anon /
 * authenticated default grants on Supabase make missing-RLS tables a
 * real DML exposure if the project anon key ever leaks. This script is
 * how we audit "did anything regress?" after a migration.
 *
 * Exit codes:
 *   0  all public tables have RLS, or AUDIT_DB_URL unset (cloud-off)
 *   1  one or more tables without RLS
 *   2  config / connectivity error
 *
 * Usage:
 *   AUDIT_DB_URL=postgres://… node scripts/check-rls.mjs
 *   AUDIT_DB_URL=postgres://… node scripts/check-rls.mjs --format json
 *
 * @module scripts/check-rls
 */

const FORMAT_JSON = process.argv.includes('--format=json') ||
  (process.argv.includes('--format') && process.argv[process.argv.indexOf('--format') + 1] === 'json');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

async function main() {
  const { getPool, closePool } = await import('./lib/db/client.mjs');
  const pool = await getPool();

  if (!pool) {
    if (FORMAT_JSON) {
      process.stdout.write(JSON.stringify({
        cloud: false, skipped: true, reason: 'AUDIT_DB_URL unset',
      }, null, 2) + '\n');
    } else {
      process.stderr.write(`${Y}── RLS check ──${X}\n  ${D}skipped${X} — AUDIT_DB_URL unset\n`);
    }
    process.exit(0);
  }

  try {
    const tablesQ = await pool.query(`
      SELECT c.relname                              AS table_name,
             c.relrowsecurity                       AS rls_enabled,
             c.relforcerowsecurity                  AS rls_forced,
             pg_get_userbyid(c.relowner)            AS owner,
             (SELECT COUNT(*) FROM pg_policies p
               WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
       ORDER BY c.relrowsecurity ASC, c.relname ASC
    `);

    const noRls  = tablesQ.rows.filter((r) => !r.rls_enabled);
    const withRls = tablesQ.rows.filter((r) => r.rls_enabled);

    let grants = [];
    if (noRls.length > 0) {
      const grantsQ = await pool.query(
        `
        SELECT table_name, grantee, privilege_type
          FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name = ANY($1)
           AND grantee IN ('anon', 'authenticated', 'public', 'PUBLIC')
         ORDER BY table_name, grantee, privilege_type
        `,
        [noRls.map((r) => r.table_name)]
      );
      grants = grantsQ.rows;
    }

    if (FORMAT_JSON) {
      process.stdout.write(JSON.stringify({
        cloud: true,
        totalTables: tablesQ.rows.length,
        withRlsCount: withRls.length,
        noRlsCount: noRls.length,
        tablesWithoutRls: noRls.map((r) => ({
          table: r.table_name,
          owner: r.owner,
          policyCount: Number(r.policy_count),
        })),
        anonExposureGrants: grants.map((r) => ({
          table: r.table_name,
          grantee: r.grantee,
          privilege: r.privilege_type,
        })),
      }, null, 2) + '\n');
    } else {
      process.stderr.write(`\n${G}── RLS check ──${X}\n`);
      process.stderr.write(
        `  ${tablesQ.rows.length} public tables: ` +
        `${G}${withRls.length} with RLS${X}, ` +
        `${noRls.length > 0 ? R : G}${noRls.length} without${X}\n\n`
      );

      if (noRls.length > 0) {
        process.stderr.write(`${R}Tables WITHOUT RLS${X} (Supabase scanner will flag these):\n`);
        for (const r of noRls) {
          process.stderr.write(
            `  ${R}✗${X} ${r.table_name.padEnd(45)} ${D}owner=${r.owner} policies=${r.policy_count}${X}\n`
          );
        }

        if (grants.length > 0) {
          process.stderr.write(`\n${R}Anon/authenticated grants on no-RLS tables${X} (practical exposure):\n`);
          for (const g of grants) {
            process.stderr.write(`  ${g.table_name}  ${g.grantee}  ${g.privilege_type}\n`);
          }
        } else {
          process.stderr.write(`\n${D}(no anon/authenticated grants — practical exposure is zero)${X}\n`);
        }

        process.stderr.write(
          `\n${Y}Fix${X}: add ` +
          `\`ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;\` migration, then ` +
          `\`node scripts/setup-postgres.mjs --migrate\`.\n`
        );
      } else {
        process.stderr.write(`${G}✓ all public tables have RLS enabled${X}\n`);
      }
    }

    process.exit(noRls.length > 0 ? 1 : 0);
  } catch (err) {
    if (FORMAT_JSON) {
      process.stdout.write(JSON.stringify({
        cloud: true, error: err?.message || String(err),
      }, null, 2) + '\n');
    } else {
      process.stderr.write(`${R}error${X}: ${err?.message || err}\n`);
    }
    process.exit(2);
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  process.stderr.write(`${R}fatal${X}: ${err?.stack || err?.message || err}\n`);
  process.exit(2);
});
