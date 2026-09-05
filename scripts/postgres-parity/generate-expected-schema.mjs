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

import '../lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';
import { atomicWriteFileSync } from '../lib/file-io.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
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
        'is_identity', is_identity,
        'identity_generation', identity_generation,
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
      -- deptype 'a' (auto) is a legacy serial's ownership; deptype 'i'
      -- (internal) is what GENERATED ... AS IDENTITY uses. Both must be
      -- checked or an identity column's owning sequence resolves to null
      -- here (audit R1-M17, found while adding identity-column capture).
      (SELECT attrelid::regclass::text || '.' || attname
        FROM pg_attribute
        WHERE attrelid = (SELECT refobjid
                          FROM pg_depend
                          WHERE objid = c.oid AND deptype IN ('a', 'i') LIMIT 1)
          AND attnum = (SELECT refobjsubid
                        FROM pg_depend
                        WHERE objid = c.oid AND deptype IN ('a', 'i') LIMIT 1)) AS owned_by
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
  assertRepoRoot(import.meta.url);
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined;
  if (outIdx >= 0 && (!outArg || outArg.startsWith('--'))) {
    process.stderr.write('--out requires a file path argument.\n');
    process.exit(2);
  }
  const outPath = outArg ?? DEFAULT_OUT;

  if (!process.env.AUDIT_DB_URL) {
    process.stderr.write(
      'AUDIT_DB_URL is not set.\n' +
      'Run against a fully-migrated database — typically a local `supabase start` stack\n' +
      'or a disposable Postgres + pgvector test DB.\n'
    );
    process.exit(2);
  }

  const { getPool, closePool, isDisposableDbHost, effectiveDbTarget } = await import('../lib/db/client.mjs');

  // Ground-truth guard: this fixture must reflect a FRESH MIGRATION REPLAY on a
  // vanilla self-hosted Postgres — what postgres-parity CI's bare
  // pgvector/pgvector container actually verifies against. Regenerating it from
  // a long-lived store has now gone wrong three times: 808beb8 (2026-07-14,
  // reverted same day by 35a737e) and 154fb57 (2026-07-22, which undid that
  // fix) both pulled in Supabase's platform extensions/grants and drifted CI
  // red; then on 2026-08-08 it happened again against the self-hosted store
  // that replaced Supabase, in a subtler way — a restored database renumbers
  // `attnum` past `DROP COLUMN` tombstones, so 9 `ordinal_position` values came
  // out different from what a replay produces.
  //
  // The first two were caught by a denylist of Supabase hostnames. The third
  // walked straight through it, because production had stopped being a Supabase
  // host. The check is now an ALLOWLIST of loopback hosts (`isDisposableDbHost`)
  // and fails closed: any host that is not demonstrably a throwaway is refused,
  // whatever brand of Postgres is behind it.
  let parsedDbUrl;
  try {
    parsedDbUrl = new URL(process.env.AUDIT_DB_URL);
  } catch {
    process.stderr.write('AUDIT_DB_URL is not a valid URL — expected a postgresql:// connection string.\n');
    process.exit(2);
  }
  // Effective host, not the displayed one: `?host=` overrides the URL authority
  // in the parser `pg` uses, so reading `.hostname` lets a production DSN pass
  // this allowlist wearing a loopback URL (2026-09-04, same fix as client.mjs).
  const effectiveHost = effectiveDbTarget(parsedDbUrl).host;
  if (!isDisposableDbHost(effectiveHost)) {
    process.stderr.write(
      `AUDIT_DB_URL points at host "${effectiveHost}", which is not a recognised disposable ` +
      'database host — refusing to generate the schema fixture from it.\n' +
      'This fixture is the ground truth for "what a fresh migration replay produces", so it must come ' +
      'from a database that IS one. A long-lived store drifts from that in ways that are invisible in ' +
      'the diff: a hosted platform layer adds extensions and grants, and a dump/restore renumbers ' +
      'column ordinals past DROP COLUMN tombstones.\n' +
      'Generate it from a fresh container instead: `npm run db:local:regen` (spins up a local ' +
      'pgvector/pgvector container, migrates it, and writes the fixture from that) — or, if CI already ' +
      'ran, download its uploaded `live-schema` artifact and use it directly (the pattern 35a737e used).\n'
    );
    process.exit(2);
  }

  const pool = await getPool();
  if (!pool) {
    process.stderr.write('getPool() returned null — check AUDIT_DB_URL resolution.\n');
    process.exit(2);
  }

  const out = { schema: 'public' };
  for (const [key, sql] of Object.entries(QUERIES)) {
    process.stderr.write(`  [expected-schema] querying ${key}…\n`);
    const res = await pool.query(sql);
    out[key] = res.rows;
  }

  await closePool();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  atomicWriteFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`  [expected-schema] wrote ${outPath}\n`);
}

// Mirrors the `_internals` pattern setup-postgres.mjs already uses for its
// own (hand-duplicated, kept-in-lock-step) copy of QUERIES.tables — lets a
// test exercise the REAL query text directly instead of a third copy.
export const _internals = Object.freeze({ QUERIES });

// Entrypoint guard (matches setup-postgres.mjs's own convention) — without
// this, `_internals` above couldn't be imported from a test at all: `main()`
// was previously called unconditionally on import, so a test importing this
// module for QUERIES would trigger a real DB preflight (or a hard
// process.exit(2) with AUDIT_DB_URL unset) as a side effect of the import.
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invoked) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
