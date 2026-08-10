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
 * Two modes, because "RLS is off" and "RLS is off AND anon can read it" are
 * different severities and only the second is a breach:
 *
 *   DIAGNOSTIC (default) — exit 1 on ANY table without RLS. Use when auditing
 *     after a migration; every no-RLS table is worth knowing about.
 *   GATE (`--gate`)      — exit 1 ONLY on *exploitable* exposure: a no-RLS
 *     table that also carries an anon/authenticated grant. Advisory-only
 *     no-RLS tables are printed and do not block.
 *
 * Why the gate ranks by exploitability rather than by lint level: a consumer's
 * 2026-07-19 Supabase audit produced 121 advisories, of which 91
 * `rls_enabled_no_policy` INFO rows were default-deny working exactly as
 * designed — while 3 ERROR rows were a live unauthenticated cross-tenant leak
 * (242 rows of drinking history readable with the public anon key). Ranking by
 * lint level would have buried the real one under the noise. A gate that cries
 * wolf gets bypassed, and a bypassed gate protects nothing.
 *
 * Exit codes:
 *   0  no blocking condition for the active mode, or AUDIT_DB_URL unset (cloud-off)
 *   1  blocking condition (see modes above)
 *   2  config / connectivity error
 *
 * Usage:
 *   AUDIT_DB_URL=postgres://… node scripts/check-rls.mjs
 *   AUDIT_DB_URL=postgres://… node scripts/check-rls.mjs --gate
 *   AUDIT_DB_URL=postgres://… node scripts/check-rls.mjs --format json
 *
 * @module scripts/check-rls
 */

/** Gate mode: block only on exploitable exposure (no-RLS + anon/authenticated grant). */
const GATE_MODE = process.argv.includes('--gate');

/**
 * The blocking decision, extracted pure so the two modes' semantics are unit-
 * testable without a live database (testing-doctrine Tier 1 — this is a
 * security gate, and "does it block on the right thing" is exactly the
 * property that must not silently regress).
 *
 * @param {{gateMode: boolean, noRlsCount: number, exposedGrantCount: number}} a
 * @returns {0|1} process exit code
 */
export function decideRlsExit({ gateMode, noRlsCount, exposedGrantCount }) {
  if (gateMode) return exposedGrantCount > 0 ? 1 : 0;
  return noRlsCount > 0 ? 1 : 0;
}

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
        // Vendor named as an EXAMPLE, not as the subject: RLS is a Postgres
        // feature and this check runs against any host. Supabase's advisor is
        // just the linter most users will have seen flag it.
        process.stderr.write(`${R}Tables WITHOUT RLS${X} (some hosts' security advisors — e.g. Supabase's — flag these):\n`);
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

    // Gate blocks on practical exposure only; diagnostic blocks on any no-RLS
    // table. `grants` is already scoped to no-RLS tables by the query above.
    if (GATE_MODE) {
      if (grants.length === 0 && noRls.length > 0 && !FORMAT_JSON) {
        process.stderr.write(
          `
${D}gate: not blocking — ${noRls.length} no-RLS table(s) carry no anon/authenticated grant ` +
          `(advisory). Run without --gate for the full diagnostic.${X}
`
        );
      }
    }
    process.exit(decideRlsExit({
      gateMode: GATE_MODE,
      noRlsCount: noRls.length,
      exposedGrantCount: grants.length,
    }));
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

// Only self-execute as a CLI. Without this guard, importing the module (e.g.
// to unit-test `decideRlsExit`) opens a live DB connection and calls
// process.exit — which is how the gate-semantics test first "failed" while
// every one of its assertions passed. Mirrors the isMain pattern already used
// by ship-commit.mjs and install-prepush-hook.mjs.
const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    if (!argv1) return false;
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${R}fatal${X}: ${err?.stack || err?.message || err}\n`);
    process.exit(2);
  });
}
