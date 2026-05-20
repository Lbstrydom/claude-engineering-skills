#!/usr/bin/env node
/**
 * @fileoverview Generate `tests/fixtures/expected-schema.json` from a
 * pristine fully-migrated Postgres database. Drives adopt-mode in M2's
 * `setup-postgres.mjs` rewrite (plan §0 prereq #4, §7 P2, R3/M3).
 *
 * Captures everything adopt-mode needs to detect drift:
 *  - tables (columns, defaults, NOT NULL, identity sequences)
 *  - functions (name, args, return type, security)
 *  - views (name, definition)
 *  - policies (table, name, roles, USING/WITH CHECK expressions)
 *  - constraints (PK / FK / UNIQUE / CHECK)
 *  - indexes (name, def)
 *  - triggers (name, table, timing, event, function)
 *  - sequences (name, owned-by column)
 *  - extensions (name, version)
 *  - grants (object, grantee, privilege)
 *  - owners (object → role)
 *
 * Connection: `AUDIT_DB_URL` (same env the runtime uses; plan §2 connection
 * model). The DSN must point at a database where ALL `supabase/migrations/*.sql`
 * have applied successfully — typically a fresh `supabase start` stack or a
 * disposable test DB.
 *
 * Usage:
 *   AUDIT_DB_URL=postgresql://… node scripts/postgres-parity/generate-expected-schema.mjs \
 *     --out tests/fixtures/expected-schema.json
 *
 * The output is JSON sorted deterministically (stable diff). Re-run after
 * every new migration; the produced file is committed.
 *
 * @module scripts/postgres-parity/generate-expected-schema
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_OUT = path.join(REPO_ROOT, 'tests', 'fixtures', 'expected-schema.json');

// ── Catalog queries ────────────────────────────────────────────────────────
// Every query is scoped to `schemaname = 'public'` — v1 supports `public`
// only (plan §2 "Schema scope"). The single exception is `auth.users` and
// `auth.uid()` which are non-core deps we expect to find in adopt-mode on
// Supabase; the compat-bootstrap inventory (M0 #1 doc) already enumerates them.

const QUERIES = {
  tables: `
    SELECT
      table_name,
      json_agg(json_build_object(
        'column_name', column_name,
        'data_type', data_type,
        'is_nullable', is_nullable,
        'column_default', column_default,
        'ordinal_position', ordinal_position
      ) ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    WHERE table_schema = 'public'
    GROUP BY table_name
    ORDER BY table_name
  `,

  functions: `
    SELECT
      p.proname AS function_name,
      pg_get_function_identity_arguments(p.oid) AS args,
      pg_get_function_result(p.oid) AS return_type,
      p.prosecdef AS security_definer,
      array_to_string(p.proconfig, ',') AS config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    ORDER BY function_name, args
  `,

  views: `
    SELECT viewname AS view_name, definition
    FROM pg_views
    WHERE schemaname = 'public'
    ORDER BY view_name
  `,

  policies: `
    SELECT
      schemaname || '.' || tablename AS table_ref,
      policyname,
      permissive,
      roles,
      cmd,
      qual,
      with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `,

  constraints: `
    SELECT
      tc.table_name,
      tc.constraint_name,
      tc.constraint_type,
      pg_get_constraintdef(c.oid) AS definition
    FROM information_schema.table_constraints tc
    JOIN pg_constraint c ON c.conname = tc.constraint_name
    JOIN pg_namespace n  ON n.oid = c.connamespace AND n.nspname = tc.constraint_schema
    WHERE tc.constraint_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name
  `,

  indexes: `
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `,

  triggers: `
    SELECT
      event_object_table AS table_name,
      trigger_name,
      action_timing,
      string_agg(event_manipulation, ',' ORDER BY event_manipulation) AS events,
      action_statement
    FROM information_schema.triggers
    WHERE event_object_schema = 'public'
    GROUP BY event_object_table, trigger_name, action_timing, action_statement
    ORDER BY table_name, trigger_name
  `,

  sequences: `
    SELECT
      c.relname AS sequence_name,
      (SELECT attrelid::regclass::text || '.' || attname
        FROM pg_attribute
        WHERE attrelid = (SELECT refobjid
                          FROM pg_depend
                          WHERE objid = c.oid AND deptype = 'a' LIMIT 1)
          AND attnum = (SELECT refobjsubid
                        FROM pg_depend
                        WHERE objid = c.oid AND deptype = 'a' LIMIT 1)) AS owned_by
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S' AND n.nspname = 'public'
    ORDER BY sequence_name
  `,

  extensions: `
    SELECT extname AS extension_name, extversion AS version
    FROM pg_extension
    ORDER BY extension_name
  `,

  grants: `
    SELECT
      grantee,
      table_schema || '.' || table_name AS object,
      string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
    GROUP BY grantee, table_schema, table_name
    ORDER BY object, grantee
  `,

  owners: `
    SELECT
      c.relname AS object_name,
      c.relkind AS object_kind,
      pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S')
    ORDER BY object_kind, object_name
  `,
};

// ── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_OUT;

  if (!process.env.AUDIT_DB_URL) {
    process.stderr.write(
      'AUDIT_DB_URL is not set.\n' +
      'Run against a fully-migrated database — typically a local `supabase start` stack\n' +
      'or a disposable Postgres + pgvector test DB.\n'
    );
    process.exit(2);
  }

  const { getPool, closePool } = await import('../lib/db/client.mjs');
  const pool = await getPool();
  if (!pool) {
    process.stderr.write('getPool() returned null — check AUDIT_DB_URL resolution.\n');
    process.exit(2);
  }

  const out = { generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), schema: 'public' };
  for (const [key, sql] of Object.entries(QUERIES)) {
    process.stderr.write(`  [expected-schema] querying ${key}…\n`);
    const res = await pool.query(sql);
    out[key] = res.rows;
  }

  await closePool();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  process.stderr.write(`  [expected-schema] wrote ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.stack || err.message}\n`);
  process.exit(1);
});
