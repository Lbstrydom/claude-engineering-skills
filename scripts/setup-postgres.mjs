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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve the CONSUMER repo root regardless of layout — source `scripts/` OR the
// synced `scripts/.claude-skills/`. `path.resolve(__dirname, '..')` is WRONG under
// the isolated layout (it lands on `scripts/`, so `--migrate` failed with ENOENT
// `scripts/.audit-loop/migrations` in consumers). findRepoRootFromScript walks up to
// the `scripts` ancestor and returns the dir above it — correct in both layouts
// (matches how cross-skill.mjs / nav-audit.mjs resolve paths).
const REPO_ROOT = findRepoRootFromScript(import.meta.url) || path.resolve(__dirname, '..');

// Audit-loop migrations live at `supabase/migrations/` in the canonical
// claude-engineering-skills source repo, and at `.audit-loop/migrations/`
// in consumer repos after `npm run sync` (the destination path is
// audit-loop-private to avoid colliding with consumer-app Supabase product
// migrations — see scripts/sync-to-repos.mjs::syncMigrations()). Prefer
// the audit-loop-private path when present; fall back to supabase/ for
// source-repo and pre-relocation contexts.
const MIGRATIONS_DIR_PRIVATE = path.join(REPO_ROOT, '.audit-loop', 'migrations');
const MIGRATIONS_DIR_LEGACY = path.join(REPO_ROOT, 'supabase', 'migrations');
const MIGRATIONS_DIR = fs.existsSync(MIGRATIONS_DIR_PRIVATE)
  ? MIGRATIONS_DIR_PRIVATE
  : MIGRATIONS_DIR_LEGACY;
// compat-bootstrap.sql is synced ALONGSIDE this script (lib/db/ sits next to it in
// both layouts), so resolve it script-relative, not repo-relative.
const BOOTSTRAP_SQL = path.join(__dirname, 'lib', 'db', 'compat-bootstrap.sql');
const EXPECTED_SCHEMA_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'expected-schema.json');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: null,       // 'migrate' | 'adopt' | 'check-drift' | 'repair-eol'
    preflightOnly: false,
    bootstrapOnly: false,
    dryRun: false,
    format: 'human',  // 'human' | 'json' — used by --check-drift
  };
  // Indexed loop so flags-with-value (`--format json`) can advance the
  // iterator via `++i` (plan migration-drift-detector R3-audit + Gemini-R2-H1).
  // The existing flag set is bare-toggle-only, so this refactor is behaviour-
  // preserving for every flag except the new `--format`.
  // Modes are MUTUALLY EXCLUSIVE. Assigning `args.mode` per flag would let the
  // last one silently win, so `--migrate --adopt` would run adopt and
  // `--adopt --migrate` would replay migrations — materially different
  // persistence behaviour selected by argument order. Collect and reject
  // instead. (`--repair-eol` joining the set is what made this reachable with
  // a ledger-WRITING mode on either side.)
  const modes = [];
  const setMode = (m) => { args.mode = m; if (!modes.includes(m)) modes.push(m); };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--migrate':         setMode('migrate'); break;
      case '--adopt':           setMode('adopt'); break;
      case '--ensure-local':    setMode('ensure-local'); break;
      case '--check-drift':     setMode('check-drift'); break;
      case '--repair-eol':      setMode('repair-eol'); break;
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
  if (modes.length > 1) {
    process.stderr.write(
      `${R}error${X}: mode flags are mutually exclusive — got ${modes.map((m) => `--${m}`).join(' ')}.\n` +
      `   Pick exactly one; argument order must never decide which one runs.\n`
    );
    process.exit(2);
  }
  if (!args.mode && !args.preflightOnly && !args.bootstrapOnly) {
    process.stderr.write(
      `usage: setup-postgres.mjs --migrate | --adopt | --ensure-local | --check-drift | --repair-eol [--format human|json] [--dry-run | --preflight-only | --bootstrap-only]\n`
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

// Deny-by-default for anon/authenticated. Owner role (the runtime DSN's
// postgres user) bypasses RLS, so the ledger remains writeable by the
// audit-loop. Idempotent on re-run.
const LEDGER_RLS = `ALTER TABLE audit_loop_migrations ENABLE ROW LEVEL SECURITY`;

async function ensureLedger(pool) {
  await pool.query(LEDGER_DDL);
  await pool.query(LEDGER_RLS);
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

// ── Migration content hashing (EOL-invariant) ──────────────────────────────
//
// WHY: the ledger hash is a tamper guard ("was this committed migration edited
// after it was applied?"). Hashing RAW bytes made it also a *checkout-mode*
// guard, which it was never meant to be: a migration applied from a CRLF
// working tree records a CRLF hash, while any LF checkout of the identical
// committed file hashes differently → a false "edited after apply" abort on
// every clean clone. (Observed 2026-07-14 on
// `20260521120000_persona_test_candidates.sql`; the `.gitattributes eol=lf`
// pin landed AFTER that file was first checked out.)
//
// Canonicalizing at this seam makes checkout mode permanently irrelevant while
// leaving the tamper guard exactly as strict for real content edits.
//
// Plan: docs/plans/debt-burndown-workstreams.md §3 WS-A.

/**
 * Canonicalize migration bytes for hashing: replace ONLY the byte sequence
 * `0x0D 0x0A` (CRLF) with `0x0A` (LF).
 *
 * Byte-level by contract. Every other byte passes through untouched — a lone
 * `CR`, a BOM, UTF-8 multibyte sequences, and even non-UTF-8 bytes. We do NOT
 * decode to a string first: `Buffer` has no `.replace`, and decoding would
 * silently rewrite malformed UTF-8, widening a tamper guard into a normalizer.
 *
 * @param {Buffer} buf
 * @returns {Buffer} a new Buffer (never the input) with CRLF folded to LF
 */
export function canonicalizeMigrationBytes(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let w = 0;
  for (let r = 0; r < buf.length; r++) {
    // Fold CR only when it is immediately followed by LF; a lone CR survives.
    if (buf[r] === 0x0d && r + 1 < buf.length && buf[r + 1] === 0x0a) continue;
    out[w++] = buf[r];
  }
  return out.subarray(0, w);
}

/**
 * Reconstruct the historical all-CRLF representation of a migration — the
 * bytes a pre-`eol=lf` Windows checkout would have produced.
 *
 * Canonicalize first, then expand EVERY remaining `0x0A` to `0x0D 0x0A`,
 * preserving all other bytes (lone `CR` included). This yields exactly ONE
 * legacy representation, deliberately: a historical file with MIXED endings
 * cannot match it and is therefore classified `shaMismatch` for manual
 * investigation rather than auto-repaired. "Some other byte pattern also
 * hashes to the stored value" is indistinguishable from tampering.
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function legacyCrlfBytes(buf) {
  const canonical = canonicalizeMigrationBytes(buf);
  let lfCount = 0;
  for (let i = 0; i < canonical.length; i++) if (canonical[i] === 0x0a) lfCount++;
  const out = Buffer.allocUnsafe(canonical.length + lfCount);
  let w = 0;
  for (let i = 0; i < canonical.length; i++) {
    if (canonical[i] === 0x0a) out[w++] = 0x0d;
    out[w++] = canonical[i];
  }
  return out;
}

/**
 * THE hash for all current apply / verify / ledger comparisons.
 * @param {Buffer} buf
 * @returns {string} hex sha256 of the canonicalized bytes
 */
export function hashCanonicalMigrationBytes(buf) {
  return crypto.createHash('sha256').update(canonicalizeMigrationBytes(buf)).digest('hex');
}

/**
 * Raw-byte sha256 — NOT canonicalized. Used for exactly one purpose: testing a
 * ledger row against the reconstructed historical representation during
 * `eol-legacy` classification. It is NEVER written to the ledger.
 *
 * These two primitives are deliberately non-interchangeable: passing
 * reconstructed CRLF bytes through the canonicalizing hash would return the
 * canonical LF hash and no legacy row could ever be identified.
 *
 * @param {Buffer} buf
 * @returns {string} hex sha256 of the bytes as given
 */
export function hashRawBytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Canonical hash of a migration file on disk.
 *
 * @duplicate-justification: target=scripts/sync-to-repos.mjs:sha256 reason=deliberate
 * divergence, not duplication. sync-to-repos hashes RAW bytes to prove a synced
 * file is byte-identical in a consumer repo — EOL normalization there would hide
 * a real transfer corruption. This one hashes CANONICALIZED bytes so a migration's
 * tamper guard is invariant to checkout mode. Unifying them would break one of the
 * two invariants; they must stay separate.
 */
async function sha256(filePath) {
  return hashCanonicalMigrationBytes(await fs.promises.readFile(filePath));
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
      // Distinguish the benign, mechanically-repairable EOL-legacy case from a
      // real content edit — pointing an operator at a manual ledger UPDATE for
      // a CRLF artifact is how a tamper guard gets routinely overridden.
      const legacySha = hashRawBytes(legacyCrlfBytes(await fs.promises.readFile(fullPath)));
      if (ledger.get(f) === legacySha) {
        process.stderr.write(
          `\n${R}error${X}: ${f} carries a pre-canonicalization CRLF hash (eol-legacy).\n` +
          `   The committed content is UNCHANGED — this is a line-ending artifact.\n` +
          `   Repair the ledger, then re-run: node scripts/setup-postgres.mjs --repair-eol\n`
        );
        throw new Error(`migration ${f} eol-legacy ledger hash — run --repair-eol`);
      }
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

// ── EOL-legacy ledger repair ───────────────────────────────────────────────
//
// Rewrites ONLY `eol-legacy` ledger rows (same committed content, historical
// CRLF hash) to the canonical hash. Never touches a true `shaMismatch`.
//
// Safety properties, all load-bearing:
//   - advisory lock, so a concurrent --migrate cannot interleave;
//   - ONE transaction — partial repair is not a reachable state;
//   - compare-and-swap per row (`WHERE filename=$1 AND sha256=$2`): if a row
//     changed between classification and write, 0 rows update and the whole
//     transaction aborts rather than overwriting a hash we never inspected;
//   - idempotent — a second run classifies nothing and writes nothing.
//
// Plan: docs/plans/debt-burndown-workstreams.md §3 WS-A leg 3.

/** Advisory-lock key shared by --migrate and --repair-eol (arbitrary, fixed). */
const MIGRATION_LOCK_KEY = 4152026071801n;

/**
 * Run `fn` while holding the migration advisory lock on a dedicated client.
 * Session-scoped (not xact-scoped) so it can wrap `runMigrate`, which applies
 * each migration in its own implicit transaction and must NOT be forced into
 * one (e.g. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction).
 */
async function withMigrationLock(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [String(MIGRATION_LOCK_KEY)]);
    return await fn();
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [String(MIGRATION_LOCK_KEY)]); }
    catch { /* connection already gone — the lock dies with the session anyway */ }
    client.release();
  }
}

export async function runRepairEol(pool, { dryRun = false, migrationsDir = MIGRATIONS_DIR } = {}) {
  process.stderr.write(`\n${G}── EOL-legacy ledger repair ──${X}\n`);

  const ledgerExists = await pool.query(`SELECT to_regclass('public.audit_loop_migrations') AS t`);
  if (!ledgerExists.rows[0].t) {
    process.stderr.write(`  ${R}error${X}: audit_loop_migrations table missing — nothing to repair.\n`);
    return { repaired: [], exitCode: 3 };
  }

  // Classify with the same logic --check-drift uses (one definition, not two).
  const drift = await runCheckDrift(pool, {
    format: 'json', migrationsDir,
    stdout: { write() {} }, stderr: { write() {} },   // classification only; no report
  });
  const candidates = drift.drift?.eolLegacy ?? [];

  if (candidates.length === 0) {
    process.stderr.write(`  ${G}✓${X} no eol-legacy rows — nothing to repair\n`);
    return { repaired: [], exitCode: 0 };
  }

  process.stderr.write(`  ${candidates.length} eol-legacy row(s) to repair:\n`);
  for (const c of candidates) {
    process.stderr.write(`    ~ ${c.filename}\n      ${c.ledgerSha.slice(0, 12)}… (CRLF) → ${c.sourceSha.slice(0, 12)}… (canonical)\n`);
  }
  if (dryRun) {
    process.stderr.write(`\n  ${D}(dry-run)${X} no rows written\n`);
    return { repaired: [], dryRun: true, exitCode: 0 };
  }

  // ONE client for the lock AND the transaction. `pg_advisory_xact_lock` is
  // transaction-scoped, so it is released by COMMIT/ROLLBACK automatically —
  // a session lock taken on a different client (or via the ambient-pool
  // `withTx`) could outlive a failure, and would not even be the same
  // connection the UPDATEs run on.
  const client = await pool.connect();
  let repaired;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [String(MIGRATION_LOCK_KEY)]);
    const done = [];
    for (const c of candidates) {
      // `applied_at` is deliberately NOT touched: this repair corrects a hash
      // representation, it does not re-apply anything. Stamping now() would
      // destroy the historical record of when the migration was actually
      // deployed — the ledger's whole evidentiary value.
      const res = await client.query(
        `UPDATE audit_loop_migrations
            SET sha256 = $3
          WHERE filename = $1 AND sha256 = $2`,
        [c.filename, c.ledgerSha, c.sourceSha]
      );
      if (res.rowCount !== 1) {
        // The row moved under us between classification and write. Abort
        // everything — never write a hash we did not inspect, and never leave
        // a half-repaired ledger.
        throw new Error(
          `repair-eol: concurrent modification of '${c.filename}' ` +
          `(expected 1 row updated, got ${res.rowCount}) — transaction rolled back, nothing changed`
        );
      }
      done.push({ filename: c.filename, from: c.ledgerSha, to: c.sourceSha });
    }
    await client.query('COMMIT');
    repaired = done;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
    throw err;
  } finally {
    client.release();
  }

  process.stderr.write(`\n  ${G}repaired${X} ${repaired.length} row(s)\n`);
  return { repaired, exitCode: 0 };
}

/**
 * Seed ledger rows for migrations that have NO row yet — and only those.
 *
 * Load-bearing: `recordApplied` upserts, so seeding every file would overwrite
 * the stored hash of an **already-ledgered** migration with whatever is on disk
 * now. That silently rubber-stamps a tampered migration (destroying the
 * `shaMismatch` evidence the guard exists to produce) and would quietly rewrite
 * an `eol-legacy` row to the canonical hash — doing `--repair-eol`'s job
 * without its advisory lock, compare-and-swap, or classification.
 *
 * On a fresh adopt (empty ledger) this is identical to seeding everything.
 *
 * @returns {Promise<string[]>} the filenames actually recorded
 */
export async function seedUnledgeredMigrations(pool, { files, existing, migrationsDir }) {
  const newly = files.filter((f) => !existing.has(f));
  for (const f of newly) {
    await recordApplied(pool, f, await sha256(path.join(migrationsDir, f)));
  }
  return newly;
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

    // Adopt is a WHOLE-DB ledger seed: every unledgered migration is recorded
    // as applied. That is correct only when the live schema really does
    // contain them all — which the manifest diff above just proved. Name the
    // rows being newly recorded anyway: "seeded 69 rows" hides whether this
    // adopted one known-live migration or silently marked a genuinely
    // unapplied one as done. Plan: WS-A leg 4.
    const existing = await readLedger(pool);
    // The "which rows are new" filter lives in seedUnledgeredMigrations (one
    // definition, and a testable one) — log from its return, never recompute.
    const seeded = await seedUnledgeredMigrations(pool, { files, existing, migrationsDir: MIGRATIONS_DIR });
    if (seeded.length) {
      process.stderr.write(`  recorded ${seeded.length} previously-unledgered migration(s) as applied:\n`);
      for (const f of seeded) process.stderr.write(`    + ${f}\n`);
    }
    process.stderr.write(
      `  ${G}seeded${X} ${seeded.length} new migration row(s); ` +
      `${files.length - seeded.length} already ledgered and left untouched (no DDL replayed)\n`
    );
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

export async function runCheckDrift(pool, {
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
  const legacyHashes = new Map();
  for (const f of files) {
    const buf = await fs.promises.readFile(path.join(migrationsDir, f));
    sourceHashes.set(f, hashCanonicalMigrationBytes(buf));
    // The historical all-CRLF representation, hashed RAW (see hashRawBytes).
    legacyHashes.set(f, hashRawBytes(legacyCrlfBytes(buf)));
  }

  const unapplied = files.filter((f) => !ledger.has(f));

  // A mismatching row is one of two very different things, and conflating them
  // is what made the tamper guard fire on clean checkouts:
  //   eol-legacy  — the row records the pre-canonicalization CRLF hash of the
  //                 SAME committed content. Benign, mechanically repairable.
  //   shaMismatch — anything else. The real guard; still a hard failure.
  const eolLegacy = [];
  const shaMismatch = [];
  for (const f of files) {
    if (!ledger.has(f) || ledger.get(f) === sourceHashes.get(f)) continue;
    const entry = { filename: f, ledgerSha: ledger.get(f), sourceSha: sourceHashes.get(f) };
    if (ledger.get(f) === legacyHashes.get(f)) eolLegacy.push(entry);
    else shaMismatch.push(entry);
  }
  const orphanLedger = [...ledger.keys()].filter((f) => !sourceHashes.has(f));

  const hasDrift = unapplied.length + eolLegacy.length + shaMismatch.length + orphanLedger.length > 0;
  const result = {
    drift: { unapplied, eolLegacy, shaMismatch, orphanLedger },
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
  if (drift.eolLegacy?.length) {
    stderr.write(`\n  ${Y}eol-legacy${X} (${drift.eolLegacy.length}) — same content, pre-canonicalization CRLF hash; repair with \`node scripts/setup-postgres.mjs --repair-eol\`:\n`);
    for (const m of drift.eolLegacy) {
      stderr.write(`    ~ ${m.filename}\n      ledger: ${m.ledgerSha.slice(0, 12)}… (CRLF)  canonical: ${m.sourceSha.slice(0, 12)}…\n`);
    }
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

/**
 * `--ensure-local` — guided local-Postgres preflight. ORCHESTRATES; never
 * silently installs a server or creates roles. Returns when it's safe to
 * proceed to `--migrate`; otherwise prints the next action and exits non-zero.
 * Plan: docs/plans/azure-work-profile.md §7 #12.
 */
async function runEnsureLocal() {
  const { spawnSync } = await import('node:child_process');
  const isTTY = !!process.stdout.isTTY;
  const plat = process.platform;

  const commandExists = (cmd) => {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: plat === 'win32' });
      return r.status === 0;
    } catch { return false; }
  };

  // State 1 — tools present?
  if (!commandExists('psql')) {
    const installCmd = plat === 'win32'
      ? 'winget install -e --id PostgreSQL.PostgreSQL   (or: choco install postgresql)'
      : plat === 'darwin'
        ? 'brew install postgresql@16'
        : 'sudo apt-get install -y postgresql postgresql-contrib';
    process.stderr.write(
      `\n${Y}Postgres not detected (no \`psql\` on PATH).${X}\n` +
      `  Install it — we do NOT auto-install:\n    ${installCmd}\n` +
      `  Then re-run: ${D}node scripts/setup-postgres.mjs --ensure-local${X}\n`,
    );
    process.exit(1);
  }

  // State 2 — DSN present? (resolveDbUrl also fail-fasts on AUDIT_STORE=postgres w/o DSN)
  const { resolveDbUrl } = await import('./lib/db/client.mjs');
  let dsn;
  try { dsn = resolveDbUrl(); } catch (e) { process.stderr.write(`\n${R}${e.message}${X}\n`); process.exit(1); }
  if (!dsn) {
    process.stderr.write(
      `\n${Y}Postgres is installed but no DSN is configured.${X}\n` +
      `  Set AUDIT_DB_URL, e.g.:\n` +
      `    ${D}AUDIT_DB_URL=postgres://postgres:<password>@localhost:5432/audit_loop${X}\n` +
      `  Create the database if it doesn't exist yet:\n    ${D}createdb audit_loop${X}\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `${G}Postgres present + DSN configured${X}` +
    `${isTTY ? '' : ' (non-interactive)'} — proceeding to migrate.\n`,
  );
  // Connection failure / missing extensions surface in the normal --migrate
  // preflight path below; --ensure-local just got us there safely.
}

async function main() {
  // CLI smoke contract — proves imports + layout-aware path resolution survive
  // relocation into a consumer's scripts/.claude-skills/ (AGENTS.md CLI_SMOKE_SET).
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const args = parseArgs(process.argv.slice(2));

  // --ensure-local runs BEFORE getPool() (the whole point is to detect a
  // missing server/DSN). On success it degrades into the --migrate path.
  if (args.mode === 'ensure-local') {
    await runEnsureLocal();
    args.mode = 'migrate';
  }

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

    // Ledger-only repair: no schema preflight needed (it writes exactly one
    // column on already-existing rows and replays no DDL).
    if (args.mode === 'repair-eol') {
      const r = await runRepairEol(pool, { dryRun: args.dryRun });
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
      // Serialize against a concurrent --repair-eol (shared advisory lock).
      await withMigrationLock(pool, () => runMigrate(pool, { dryRun: args.dryRun }));
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
