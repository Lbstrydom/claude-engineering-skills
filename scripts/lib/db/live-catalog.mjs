/**
 * @fileoverview Capture a LIVE Postgres catalog in the shape
 * `tests/fixtures/expected-schema.json` records.
 *
 * Moved out of `scripts/setup-postgres.mjs` on 2026-09-27 so the two readers of
 * the live schema — `--adopt` (a one-time strict full-schema match) and
 * `--check-drift --live` (a standing constraint/index check) — share ONE capture
 * rather than growing a second copy of these queries. The CLI sits over the
 * file-size ratchet, which is the other reason they live here.
 *
 * Read-only: every statement is a catalog SELECT.
 *
 * @module scripts/lib/db/live-catalog
 */

/**
 * Run `generate-expected-schema.mjs`'s catalog queries against the LIVE DB.
 * The caller diffs the result against the committed manifest with
 * `diffSchemas` (lib/db/schema-diff.mjs).
 *
 * @param {{query: (sql: string) => Promise<{rows: unknown[]}>}} pool
 * @param {{only?: string[]}} [opts] - capture only these catalog categories
 *   (e.g. `['constraints', 'indexes']` for `--check-drift --live`); default all.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function captureLiveSchema(pool, { only = null } = {}) {
  // SHARED_CATALOG_QUERIES is kept in lock-step with the generator script
  // (see comment on the constant). Keeping adopt-mode self-contained means
  // no module import edge to the generator's CLI; if the two ever drift,
  // adopt-mode produces a false mismatch which the operator notices
  // immediately. That's a much better failure than silent agreement.
  const live = { schema: 'public' };
  for (const [key, sql] of Object.entries(SHARED_CATALOG_QUERIES)) {
    if (only && !only.includes(key)) continue;
    const r = await pool.query(sql);
    live[key] = r.rows;
  }
  return live;
}

// Catalog queries — kept in lock-step with generate-expected-schema.mjs.
// (When that script grows new fields, mirror the change here.)
//
// `ordinal_position` is captured RAW on both sides — it is pg `attnum`, and the
// fixture is a faithful record of the reference DB's physical layout, gaps and
// all. It is normalised to a dense rank at comparison time by
// `denseRankColumnPositions`; see that function for why the normalisation is
// not pushed down into this SQL.
export const SHARED_CATALOG_QUERIES = Object.freeze({
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
  // The join carries the TABLE identity (conrelid → pg_class.relname), not only
  // name + schema: a constraint name is unique per TABLE, not per schema — two
  // tables may legally each own a CHECK named `valid_status` — and a
  // name-only join cross-multiplies them, attributing each table's definition
  // to the other. (The generator's copy predates this; the committed fixture
  // has no name shared across tables, so both produce identical rows today.)
  constraints: `
    SELECT
      tc.table_name,
      tc.constraint_name,
      tc.constraint_type,
      pg_get_constraintdef(c.oid) AS definition
    FROM information_schema.table_constraints tc
    JOIN pg_constraint c ON c.conname = tc.constraint_name
    JOIN pg_namespace n  ON n.oid = c.connamespace AND n.nspname = tc.constraint_schema
    JOIN pg_class rel    ON rel.oid = c.conrelid AND rel.relname = tc.table_name
                        AND rel.relnamespace = n.oid
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
});
