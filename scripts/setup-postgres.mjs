#!/usr/bin/env node
/**
 * @fileoverview Postgres setup CLI for the audit-loop store.
 *
 * Plan: docs/plans/postgres-parity.md §7 Phase 2 / §11 M2.
 *
 * One command for both fresh self-hosted Postgres AND adopt-mode against
 * a pre-provisioned (typically Supabase) DB:
 *
 *   AUDIT_DB_URL=postgres://… node scripts/setup-postgres.mjs --migrate
 *   AUDIT_DB_URL=postgres://… node scripts/setup-postgres.mjs --adopt
 *
 *   --migrate   Apply the compat-bootstrap (when applicable) + every
 *               `supabase/migrations/*.sql` in lexicographic order,
 *               recording the applied set in `audit_loop_migrations`.
 *               Idempotent — re-running skips already-applied files.
 *
 *   --adopt     For a pre-provisioned DB. Compare the live schema against
 *               `tests/fixtures/expected-schema.json` (Phase 0 #4 / R3/M3).
 *               All-match → seed the ledger as fully applied without
 *               replaying anything. Any mismatch → abort with a diff
 *               summary so the operator can decide.
 *
 *   --preflight-only   Run the privilege preflight and exit.
 *   --bootstrap-only   Apply the compat-bootstrap and exit. Useful for
 *                      iterating on the bootstrap against a throwaway DB.
 *   --dry-run          Print what would happen; touch nothing.
 *
 * @module scripts/setup-postgres
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const BOOTSTRAP_SQL = path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'compat-bootstrap.sql');
const EXPECTED_SCHEMA_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'expected-schema.json');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: null,       // 'migrate' | 'adopt' | 'check-drift'
    preflightOnly: false,
    bootstrapOnly: false,
    dryRun: false,
    format: 'human',  // 'human' | 'json' — used by --check-drift
  };
  // Indexed loop so flags-with-value (`--format json`) can advance the
  // iterator via `++i` (plan migration-drift-detector R3-audit + Gemini-R2-H1).
  // The existing flag set is bare-toggle-only, so this refactor is behaviour-
  // preserving for every flag except the new `--format`.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--migrate':         args.mode = 'migrate'; break;
      case '--adopt':           args.mode = 'adopt'; break;
      case '--check-drift':     args.mode = 'check-drift'; break;
      case '--preflight-only':  args.preflightOnly = true; break;
      case '--bootstrap-only':  args.bootstrapOnly = true; break;
      case '--dry-run':         args.dryRun = true; break;
      case '--format':          args.format = argv[++i]; break;
      default:
        if (a.startsWith('--')) {
          process.stderr.write(`${R}error${X}: unknown flag ${a}\n`);
          process.exit(2);
        }
    }
  }
  if (!args.mode && !args.preflightOnly && !args.bootstrapOnly) {
    process.stderr.write(
      `usage: setup-postgres.mjs --migrate | --adopt | --check-drift [--format human|json] [--dry-run | --preflight-only | --bootstrap-only]\n`
    );
    process.exit(2);
  }
  if (args.format !== 'human' && args.format !== 'json') {
    process.stderr.write(`${R}error${X}: --format must be 'human' or 'json' (got: ${args.format})\n`);
    process.exit(2);
  }
  return args;
}

// ── Preflight (plan R10 / R3/H3) ───────────────────────────────────────────

/**
 * Check that the current session role can:
 *   - create roles (CREATEROLE attribute), AND
 *   - create the three required extensions (pgcrypto, pg_trgm, vector).
 *
 * Both are non-fatal in adopt-mode (we don't touch roles or extensions on
 * a pre-provisioned DB), but fatal in --migrate mode on a fresh DB.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{canCreateRole: boolean, extensions: Record<string, 'present'|'available'|'missing'>}>}
 */
async function preflight(pool) {
  const result = {
    canCreateRole: false,
    extensions: {},
  };

  // CREATEROLE — pg_roles.rolcreaterole on the current_user.
  const roleRes = await pool.query(
    `SELECT rolcreaterole, rolsuper FROM pg_roles WHERE rolname = current_user`
  );
  if (roleRes.rows[0]) {
    result.canCreateRole = !!(roleRes.rows[0].rolcreaterole || roleRes.rows[0].rolsuper);
  }

  // Extensions — pg_extension (installed) ∪ pg_available_extensions (installable).
  for (const ext of ['pgcrypto', 'pg_trgm', 'vector']) {
    const installed = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = $1`, [ext]);
    if (installed.rows.length > 0) { result.extensions[ext] = 'present'; continue; }
    const avail = await pool.query(`SELECT 1 FROM pg_available_extensions WHERE name = $1`, [ext]);
    result.extensions[ext] = avail.rows.length > 0 ? 'available' : 'missing';
  }

  return result;
}

function reportPreflight(p, { strict }) {
  process.stderr.write(`\n${G}── Preflight ──${X}\n`);
  process.stderr.write(`  current_user CREATEROLE: ${p.canCreateRole ? G + 'yes' + X : Y + 'no' + X}\n`);
  for (const [ext, state] of Object.entries(p.extensions)) {
    const colour = state === 'present' ? G : state === 'available' ? Y : R;
    process.stderr.write(`  extension ${ext}: ${colour}${state}${X}\n`);
  }

  if (!strict) return true;

  // Strict mode (--migrate against a fresh DB): hard requirements.
  const missing = Object.entries(p.extensions).filter(([, v]) => v === 'missing');
  const errors = [];
  if (!p.canCreateRole) {
    errors.push(
      'CREATEROLE privilege required to create the anon/authenticated/service_role stub roles.\n' +
      '   Either GRANT CREATEROLE TO <current_user>, or hand off setup to a superuser.\n' +
      '   Managed-Postgres-without-CREATEROLE is an explicit v1-unsupported case ' +
      '(docs/plans/postgres-parity.md §10).'
    );
  }
  if (missing.length > 0) {
    errors.push(
      `Required extensions missing on this Postgres install: ${missing.map(([n]) => n).join(', ')}.\n` +
      `   Install hint: \`apt-get install postgresql-${'<ver>'}-pgvector\`, \`postgresql-contrib\` (pg_trgm + pgcrypto), or the equivalent for your distro.\n` +
      `   The extension packages must be physically present before CREATE EXTENSION can succeed.`
    );
  }
  if (errors.length > 0) {
    process.stderr.write(`\n${R}preflight failed:${X}\n`);
    for (const e of errors) process.stderr.write(` * ${e}\n`);
    return false;
  }
  return true;
}

// ── Supabase-managed auth detection (plan R16) ─────────────────────────────

/**
 * A real Supabase project ships its own `auth` schema owned by
 * `supabase_admin` (the Supabase platform role). When we see that, we MUST
 * NOT apply the compat bootstrap — even though every statement is
 * existence-guarded, running it against a managed DB is a code smell that
 * could mask a future regression.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<boolean>} true if the bootstrap should be skipped.
 */
async function isSupabaseManaged(pool) {
  const res = await pool.query(`
    SELECT pg_get_userbyid(nspowner) AS owner
    FROM pg_namespace
    WHERE nspname = 'auth'
  `);
  if (res.rows.length === 0) return false;
  const owner = res.rows[0].owner;
  // supabase_admin is the canonical owner on Supabase-hosted DBs. We treat
  // ANY auth-schema owner other than the runtime role as "managed" — a
  // self-hosted DB that ran a previous bootstrap would own auth itself.
  return owner === 'supabase_admin' || owner === 'supabase_auth_admin';
}

// ── Migration ledger ───────────────────────────────────────────────────────
// Tracks which `supabase/migrations/*.sql` files have been applied so
// re-running --migrate is idempotent (#13). The ledger table lives in
// `public` like everything else; the v1 scope is `public`-only.

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS audit_loop_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    sha256     text NOT NULL
  )
`;

async function ensureLedger(pool) {
  await pool.query(LEDGER_DDL);
}

async function readLedger(pool) {
  const res = await pool.query(`SELECT filename, sha256 FROM audit_loop_migrations`);
  return new Map(res.rows.map((r) => [r.filename, r.sha256]));
}

async function recordApplied(pool, filename, sha256) {
  await pool.query(
    `INSERT INTO audit_loop_migrations (filename, sha256) VALUES ($1, $2)
       ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()`,
    [filename, sha256]
  );
}

// ── Migrations ─────────────────────────────────────────────────────────────

async function listMigrations(dir = MIGRATIONS_DIR) {
  const entries = await fs.promises.readdir(dir);
  return entries.filter((e) => e.endsWith('.sql')).sort();
}

async function sha256(filePath) {
  const crypto = await import('node:crypto');
  const buf = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function applyMigration(pool, filename, dryRun) {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const sql = await fs.promises.readFile(fullPath, 'utf-8');
  const hash = await sha256(fullPath);
  if (dryRun) {
    process.stderr.write(`  ${D}(dry-run)${X} would apply ${filename}\n`);
    return hash;
  }
  await pool.query(sql);
  return hash;
}

async function applyBootstrap(pool, dryRun) {
  const sql = await fs.promises.readFile(BOOTSTRAP_SQL, 'utf-8');
  if (dryRun) {
    process.stderr.write(`  ${D}(dry-run)${X} would apply compat-bootstrap.sql (${sql.length} bytes)\n`);
    return;
  }
  await pool.query(sql);
}

// ── Adopt-mode schema diff (plan R3/M3, R4) ────────────────────────────────

/**
 * Run `generate-expected-schema.mjs`'s queries against the LIVE DB and
 * diff the result against the committed manifest. Mismatch → abort. Match
 * → return so the caller can seed the ledger.
 *
 * The actual catalog queries are re-imported from the generator module so
 * the two callers can't drift.
 */
async function captureLiveSchema(pool) {
  // SHARED_CATALOG_QUERIES is kept in lock-step with the generator script
  // (see comment on the constant). Keeping adopt-mode self-contained means
  // no module import edge to the generator's CLI; if the two ever drift,
  // adopt-mode produces a false mismatch which the operator notices
  // immediately. That's a much better failure than silent agreement.
  const live = { schema: 'public' };
  for (const [key, sql] of Object.entries(SHARED_CATALOG_QUERIES)) {
    const r = await pool.query(sql);
    live[key] = r.rows;
  }
  return live;
}

function diffSchemas(expected, live) {
  const differences = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(live)]);
  keys.delete('generatedAt');  // metadata field — not part of the comparison
  keys.delete('schema');       // always 'public' by contract
  for (const k of keys) {
    const e = expected[k] || [];
    const l = live[k] || [];
    if (JSON.stringify(canonicalise(e)) !== JSON.stringify(canonicalise(l))) {
      // Compute item-level diff for friendlier output.
      const eSet = new Set(e.map((row) => JSON.stringify(canonicalise(row))));
      const lSet = new Set(l.map((row) => JSON.stringify(canonicalise(row))));
      const missingInLive = [...eSet].filter((s) => !lSet.has(s));
      const extraInLive = [...lSet].filter((s) => !eSet.has(s));
      differences.push({
        category: k,
        missingInLive: missingInLive.slice(0, 5).map((s) => JSON.parse(s)),
        extraInLive: extraInLive.slice(0, 5).map((s) => JSON.parse(s)),
        missingTotal: missingInLive.length,
        extraTotal: extraInLive.length,
      });
    }
  }
  return differences;
}

/** Recursively sort object keys so structural equality is order-independent. */
function canonicalise(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) {
    return v.map(canonicalise).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  }
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalise(v[k]);
    return out;
  }
  return v;
}

// Catalog queries — kept in lock-step with generate-expected-schema.mjs.
// (When that script grows new fields, mirror the change here.)
const SHARED_CATALOG_QUERIES = {
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

// ── Main flows ─────────────────────────────────────────────────────────────

async function runMigrate(pool, { dryRun }) {
  const supabaseManaged = await isSupabaseManaged(pool);
  process.stderr.write(`\n${G}── Compat bootstrap ──${X}\n`);
  if (supabaseManaged) {
    process.stderr.write(`  ${Y}skipped${X} — Supabase-managed \`auth\` schema detected (R16)\n`);
  } else {
    process.stderr.write(`  applying ${path.relative(REPO_ROOT, BOOTSTRAP_SQL)}\n`);
    await applyBootstrap(pool, dryRun);
  }

  process.stderr.write(`\n${G}── Migrations ──${X}\n`);
  await ensureLedger(pool);
  const ledger = await readLedger(pool);
  const files = await listMigrations();

  let applied = 0, skipped = 0;
  for (const f of files) {
    const fullPath = path.join(MIGRATIONS_DIR, f);
    const expectedHash = await sha256(fullPath);
    if (ledger.has(f) && ledger.get(f) === expectedHash) {
      process.stderr.write(`  ${D}=${X} ${f} (already applied)\n`);
      skipped++;
      continue;
    }
    if (ledger.has(f) && ledger.get(f) !== expectedHash) {
      process.stderr.write(
        `\n${R}error${X}: ${f} previously applied with a different SHA256.\n` +
        `   Migrations must be append-only; do not edit a committed migration.\n` +
        `   If this is intentional, manually update audit_loop_migrations.sha256.\n`
      );
      throw new Error(`migration ${f} sha256 mismatch — refusing to re-apply`);
    }
    process.stderr.write(`  ${G}+${X} ${f}\n`);
    await applyMigration(pool, f, dryRun);
    if (!dryRun) await recordApplied(pool, f, expectedHash);
    applied++;
  }

  process.stderr.write(`\n${G}Done${X}: applied ${applied}, skipped ${skipped}, total ${files.length}.\n`);
}

async function runAdopt(pool) {
  process.stderr.write(`\n${G}── Adopt mode ──${X}\n`);
  if (!fs.existsSync(EXPECTED_SCHEMA_PATH)) {
    process.stderr.write(
      `${R}error${X}: ${path.relative(REPO_ROOT, EXPECTED_SCHEMA_PATH)} does not exist.\n` +
      `   Generate it first against a fully-migrated reference DB:\n` +
      `     AUDIT_DB_URL=postgres://… npm run parity:expected-schema\n`
    );
    throw new Error('expected-schema manifest missing');
  }

  process.stderr.write(`  reading expected schema from ${path.relative(REPO_ROOT, EXPECTED_SCHEMA_PATH)}\n`);
  const expected = JSON.parse(await fs.promises.readFile(EXPECTED_SCHEMA_PATH, 'utf-8'));
  process.stderr.write(`  capturing live schema…\n`);
  const live = await captureLiveSchema(pool);

  const differences = diffSchemas(expected, live);
  if (differences.length === 0) {
    process.stderr.write(`  ${G}match${X} — live schema matches the manifest exactly\n`);
    process.stderr.write(`\n${G}── Seeding ledger ──${X}\n`);
    await ensureLedger(pool);
    const files = await listMigrations();
    for (const f of files) {
      const hash = await sha256(path.join(MIGRATIONS_DIR, f));
      await recordApplied(pool, f, hash);
    }
    process.stderr.write(`  ${G}seeded${X} ${files.length} migration rows (no DDL replayed)\n`);
    return;
  }

  // Mismatch → abort with diff summary.
  process.stderr.write(`\n${R}schema drift detected${X} — ${differences.length} categor${differences.length === 1 ? 'y' : 'ies'} differ:\n`);
  for (const d of differences) {
    process.stderr.write(`\n  ## ${d.category} (live missing ${d.missingTotal}, extra ${d.extraTotal})\n`);
    if (d.missingInLive.length) {
      process.stderr.write(`    expected but missing in live:\n`);
      for (const m of d.missingInLive) process.stderr.write(`      - ${JSON.stringify(m)}\n`);
    }
    if (d.extraInLive.length) {
      process.stderr.write(`    present in live but not expected:\n`);
      for (const e of d.extraInLive) process.stderr.write(`      + ${JSON.stringify(e)}\n`);
    }
  }
  process.stderr.write(
    `\n${R}adopt-mode aborted${X}: live DB diverges from the manifest.\n` +
    `   Either re-generate the manifest against a freshly-migrated reference DB\n` +
    `   (\`npm run parity:expected-schema\`) or reconcile the live DB before retrying.\n`
  );
  throw new Error('schema-drift detected during --adopt');
}

// ── Read-only drift check ─────────────────────────────────────────────────
//
// Compares `supabase/migrations/*.sql` source files against the
// `audit_loop_migrations` ledger. Three drift kinds:
//   - unapplied:    source exists, no ledger row
//   - shaMismatch:  ledger sha ≠ current source sha
//   - orphanLedger: ledger row, no source file
//
// Exit-code contract (returned via `result.exitCode`, propagated by main()):
//   0 — clean (no drift) OR cloud-disabled
//   1 — drift
//   2 — hard error (thrown out of runCheckDrift; caught by main()'s try)
//   3 — needs bootstrap: ledger table missing
//
// MUST be truly read-only — no DDL, no DML. The `ensureLedger` call from
// runMigrate / runAdopt is deliberately NOT used here.
//
// Plan: docs/plans/migration-drift-detector.md §6 Addition 1.

async function runCheckDrift(pool, {
  format        = 'human',
  migrationsDir = MIGRATIONS_DIR,
  stdout        = process.stdout,
  stderr        = process.stderr,
} = {}) {
  // R1-audit M1: TRULY read-only. If the table doesn't exist, exit 3
  // with an actionable bootstrap hint — never create it.
  const ledgerExists = await pool.query(
    `SELECT to_regclass('public.audit_loop_migrations') AS t`
  );
  if (!ledgerExists.rows[0].t) {
    const msg = 'audit_loop_migrations table missing — bootstrap via `node scripts/setup-postgres.mjs --adopt` first';
    if (format === 'json') {
      stdout.write(JSON.stringify({ hasDrift: false, needsBootstrap: true, message: msg }, null, 2) + '\n');
    } else {
      stderr.write(`\n${R}── Migration drift check ──${X}\n  ${R}error${X}: ${msg}\n`);
    }
    return { hasDrift: false, needsBootstrap: true, exitCode: 3 };
  }

  const ledger = await readLedger(pool);                      // Map<filename, sha256>
  const files = await listMigrations(migrationsDir);          // sorted string[]

  const sourceHashes = new Map();
  for (const f of files) {
    sourceHashes.set(f, await sha256(path.join(migrationsDir, f)));
  }

  const unapplied = files.filter((f) => !ledger.has(f));
  const shaMismatch = files
    .filter((f) => ledger.has(f) && ledger.get(f) !== sourceHashes.get(f))
    .map((f) => ({ filename: f, ledgerSha: ledger.get(f), sourceSha: sourceHashes.get(f) }));
  const orphanLedger = [...ledger.keys()].filter((f) => !sourceHashes.has(f));

  const hasDrift = unapplied.length + shaMismatch.length + orphanLedger.length > 0;
  const result = {
    drift: { unapplied, shaMismatch, orphanLedger },
    applied: ledger.size,
    sourceTotal: files.length,
    hasDrift,
    needsBootstrap: false,
    exitCode: hasDrift ? 1 : 0,
  };

  if (format === 'json') {
    stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    renderHumanDriftReport(result, stderr);
  }
  return result;
}

function renderHumanDriftReport({ drift, applied, sourceTotal, hasDrift }, stderr = process.stderr) {
  stderr.write(`\n${G}── Migration drift check ──${X}\n`);
  stderr.write(`  ledger: ${applied} applied / ${sourceTotal} source files\n`);
  if (!hasDrift) {
    stderr.write(`  ${G}✓${X} no drift\n`);
    return;
  }
  if (drift.unapplied.length) {
    stderr.write(`\n  ${Y}unapplied${X} (${drift.unapplied.length}) — run \`node scripts/setup-postgres.mjs --migrate\`:\n`);
    for (const f of drift.unapplied) stderr.write(`    + ${f}\n`);
  }
  if (drift.shaMismatch.length) {
    stderr.write(`\n  ${R}sha-mismatch${X} (${drift.shaMismatch.length}) — committed migration edited after apply:\n`);
    for (const m of drift.shaMismatch) {
      stderr.write(`    ! ${m.filename}\n      ledger: ${m.ledgerSha.slice(0, 12)}…  source: ${m.sourceSha.slice(0, 12)}…\n`);
    }
  }
  if (drift.orphanLedger.length) {
    stderr.write(`\n  ${Y}orphan-ledger${X} (${drift.orphanLedger.length}) — applied but no source file (deleted?):\n`);
    for (const f of drift.orphanLedger) stderr.write(`    ? ${f}\n`);
  }
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { getPool, closePool } = await import('./lib/db/client.mjs');
  const pool = await getPool();

  // R3-audit M1: --check-drift exits 0 (cloud:false) when AUDIT_DB_URL is
  // unset. This lets `check:integration` chain arch:refresh:full && --check-drift
  // — both halves short-circuit gracefully when no DB is configured. Branch
  // taken BEFORE the generic "no pool → exit 2" guard below.
  if (!pool && args.mode === 'check-drift') {
    if (args.format === 'json') {
      process.stdout.write(JSON.stringify({
        cloud: false, skipped: true, reason: 'AUDIT_DB_URL unset',
      }, null, 2) + '\n');
    } else {
      process.stderr.write(`\n${Y}── Migration drift check ──${X}\n  ${D}skipped${X} — AUDIT_DB_URL unset\n`);
    }
    process.exit(0);
  }

  if (!pool) {
    process.stderr.write(
      `${R}error${X}: no DB pool — set AUDIT_DB_URL.\n` +
      `   See docs/plans/postgres-parity.md §2 "Connection model".\n`
    );
    process.exit(2);
  }

  try {
    // Mask the password in any URL we log.
    const masked = (process.env.AUDIT_DB_URL || '').replace(/:[^:@\s/]+@/, ':***@');
    process.stderr.write(`${G}Postgres setup${X}\n  URL: ${masked}\n  Schema: public\n`);

    // --check-drift is read-only — skip preflight (no DDL, no role/extension
    // requirements) and skip the bootstrap step. Keeps the check fast for
    // pre-push use.
    if (args.mode === 'check-drift') {
      const r = await runCheckDrift(pool, { format: args.format });
      process.exit(r.exitCode);
    }

    const pre = await preflight(pool);
    const strict = args.mode === 'migrate' && !args.dryRun && !await isSupabaseManaged(pool);
    if (!reportPreflight(pre, { strict })) {
      process.exit(2);
    }
    if (args.preflightOnly) return;

    if (args.bootstrapOnly) {
      await applyBootstrap(pool, args.dryRun);
      process.stderr.write(`${G}bootstrap applied${X}\n`);
      return;
    }

    if (args.mode === 'migrate') {
      await runMigrate(pool, { dryRun: args.dryRun });
    } else if (args.mode === 'adopt') {
      await runAdopt(pool);
    }
  } catch (err) {
    process.stderr.write(`\n${R}setup failed${X}: ${err.message}\n`);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Allow imports for tests; only run when invoked as a script.
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invoked) {
  main();
}

export const _internals = Object.freeze({
  parseArgs,
  preflight,
  reportPreflight,
  isSupabaseManaged,
  ensureLedger,
  readLedger,
  recordApplied,
  listMigrations,
  sha256,
  diffSchemas,
  canonicalise,
  runCheckDrift,
  renderHumanDriftReport,
  SHARED_CATALOG_QUERIES,
});
