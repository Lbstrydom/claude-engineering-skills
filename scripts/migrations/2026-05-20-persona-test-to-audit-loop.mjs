#!/usr/bin/env node
/**
 * @fileoverview One-shot migration — copy `personas` + `persona_test_sessions`
 * rows from the legacy "Persona Test" Supabase project (`cnvxixhaubfuijldxyli`)
 * into the Audit-loop project (`uahjjdelnnpfmaqjrwoz`), which already hosts the
 * canonical persona schema since the ~April-13 cutover.
 *
 * Collision policy: **Audit-loop wins** — `ON CONFLICT DO NOTHING` so any row
 * already present in Audit-loop is preserved and the Persona-Test version is
 * skipped. Per the user's explicit answer to the consolidation question.
 *
 * Why a script, not `supabase db dump`: `supabase db dump` runs pg_dump inside
 * a Docker container for version compatibility; Docker is not available in this
 * environment. The `pg` driver works direct-to-DSN.
 *
 * Safe to re-run: idempotent (ON CONFLICT DO NOTHING). Failed transactions
 * roll back cleanly.
 *
 * Usage:
 *   node scripts/migrations/2026-05-20-persona-test-to-audit-loop.mjs \
 *     --source-url 'postgresql://postgres.cnvxixhaubfuijldxyli:<PW>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' \
 *     --target-url "$AUDIT_DB_URL" \
 *     [--dry-run]
 *
 * After migration completes + counts look right, delete the Persona Test
 * Supabase project to stop the recurring cost (it has nothing else in it).
 */

import pgPkg from 'pg';
const { Pool } = pgPkg;

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { sourceUrl: null, targetUrl: null, dryRun: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '--source-url':  args.sourceUrl = a[++i]; break;
      case '--target-url':  args.targetUrl = a[++i]; break;
      case '--dry-run':     args.dryRun = true; break;
      default:
        process.stderr.write(`unknown arg: ${a[i]}\n`);
        process.exit(2);
    }
  }
  if (!args.sourceUrl || !args.targetUrl) {
    process.stderr.write(
      'usage: persona-test-to-audit-loop.mjs --source-url <DSN> --target-url <DSN> [--dry-run]\n'
    );
    process.exit(2);
  }
  return args;
}

// ── Safety guards ──────────────────────────────────────────────────────────

function assertSourceIsPersonaTest(url) {
  if (!/cnvxixhaubfuijldxyli/.test(url)) {
    throw new Error(
      `--source-url does not contain the Persona Test project ref (cnvxixhaubfuijldxyli). ` +
      `Refusing to copy from an unexpected source. URL: ${url.replace(/:[^:@/]+@/, ':***@')}`
    );
  }
}
function assertTargetIsAuditLoop(url) {
  if (!/uahjjdelnnpfmaqjrwoz/.test(url)) {
    throw new Error(
      `--target-url does not contain the Audit-loop project ref (uahjjdelnnpfmaqjrwoz). ` +
      `Refusing to write to an unexpected target. URL: ${url.replace(/:[^:@/]+@/, ':***@')}`
    );
  }
}

// ── Read source rows ───────────────────────────────────────────────────────

async function readSource(pool) {
  // Reading row column lists dynamically so the script handles minor column-
  // shape differences (e.g. columns added later on Audit-loop) without us
  // hardcoding the schema. We only copy columns that exist in BOTH source +
  // target — see filterColumns() below.
  const personas = await pool.query('SELECT * FROM personas');
  const sessions = await pool.query('SELECT * FROM persona_test_sessions');
  return { personas: personas.rows, sessions: sessions.rows };
}

async function getTargetColumns(pool, table) {
  // Returns a Map<columnName, dataType> so the binder can JSON.stringify
  // jsonb/json values (pg reads them as JS objects but won't auto-encode
  // back on write — sending an object raw produces SQL "invalid input
  // syntax for type json").
  const res = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  const m = new Map();
  for (const r of res.rows) m.set(r.column_name, r.data_type);
  return m;
}

function filterColumns(rows, targetColMap) {
  if (rows.length === 0) return { rows, columns: [], types: new Map() };
  const sourceCols = Object.keys(rows[0]);
  const common = sourceCols.filter((c) => targetColMap.has(c));
  const dropped = sourceCols.filter((c) => !targetColMap.has(c));
  const types = new Map(common.map((c) => [c, targetColMap.get(c)]));
  const filtered = rows.map((r) => Object.fromEntries(common.map((c) => [c, r[c]])));
  return { rows: filtered, columns: common, types, dropped };
}

/**
 * Encode a JS value for safe binding as a pg parameter, given the target
 * column's `data_type` (as reported by information_schema).
 *
 *   - `jsonb` / `json`: stringify the JS object — pg sends the string,
 *     Postgres parses it per the column type.
 *   - Postgres arrays (`ARRAY` per information_schema.data_type): pass
 *     the JS array through; pg's native array encoder handles it.
 *   - Everything else: pass through (Date, Buffer, primitives all work).
 */
function bindValue(v, dataType) {
  if (v == null) return v;
  if (dataType === 'jsonb' || dataType === 'json') {
    return JSON.stringify(v);
  }
  return v;
}

// ── Write target ───────────────────────────────────────────────────────────

function quoteIdent(name) {
  if (typeof name !== 'string' || name.includes('"')) {
    throw new Error(`invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

async function bulkInsert(client, table, rows, columns, types) {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const cols = columns.map(quoteIdent).join(', ');
  const params = [];
  const valueGroups = rows.map((row) => {
    const placeholders = columns.map((c) => {
      params.push(bindValue(row[c], types.get(c)));
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  // ON CONFLICT DO NOTHING without a target column matches any unique
  // constraint — picks up both (id) PK and (name, app_url) unique on personas.
  const sql = `
    INSERT INTO ${quoteIdent(table)} (${cols})
    VALUES ${valueGroups.join(', ')}
    ON CONFLICT DO NOTHING
  `;
  const res = await client.query(sql, params);
  return { inserted: res.rowCount ?? 0, skipped: rows.length - (res.rowCount ?? 0) };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  assertSourceIsPersonaTest(args.sourceUrl);
  assertTargetIsAuditLoop(args.targetUrl);

  const source = new Pool({ connectionString: args.sourceUrl, max: 1, ssl: { rejectUnauthorized: false } });
  const target = new Pool({ connectionString: args.targetUrl, max: 1, ssl: { rejectUnauthorized: false } });

  try {
    process.stderr.write('  [migrate] reading source rows from Persona Test…\n');
    const { personas, sessions } = await readSource(source);
    process.stderr.write(`  [migrate] source has ${personas.length} personas + ${sessions.length} sessions\n`);

    const personaTargetCols = await getTargetColumns(target, 'personas');
    const sessionTargetCols = await getTargetColumns(target, 'persona_test_sessions');

    const personaFiltered = filterColumns(personas, personaTargetCols);
    const sessionFiltered = filterColumns(sessions, sessionTargetCols);

    if (personaFiltered.dropped?.length) {
      process.stderr.write(`  [migrate] personas — dropping source-only columns: ${personaFiltered.dropped.join(', ')}\n`);
    }
    if (sessionFiltered.dropped?.length) {
      process.stderr.write(`  [migrate] persona_test_sessions — dropping source-only columns: ${sessionFiltered.dropped.join(', ')}\n`);
    }

    if (args.dryRun) {
      process.stderr.write('  [migrate] DRY-RUN — would write:\n');
      process.stderr.write(`    personas: ${personaFiltered.rows.length} candidate rows; columns: ${personaFiltered.columns.join(', ')}\n`);
      process.stderr.write(`    persona_test_sessions: ${sessionFiltered.rows.length} candidate rows; columns: ${sessionFiltered.columns.join(', ')}\n`);
      return;
    }

    const client = await target.connect();
    let personasRes, sessionsRes;
    try {
      await client.query('BEGIN');
      personasRes = await bulkInsert(client, 'personas', personaFiltered.rows, personaFiltered.columns, personaFiltered.types);
      sessionsRes = await bulkInsert(client, 'persona_test_sessions', sessionFiltered.rows, sessionFiltered.columns, sessionFiltered.types);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
      throw err;
    } finally {
      client.release();
    }

    // Post-migration sanity check — count rows on target.
    const tPersonas = await target.query('SELECT COUNT(*)::int AS c FROM personas');
    const tSessions = await target.query('SELECT COUNT(*)::int AS c FROM persona_test_sessions');

    process.stderr.write('\n  [migrate] DONE\n');
    process.stderr.write(`    personas:               inserted ${personasRes.inserted}, skipped ${personasRes.skipped}\n`);
    process.stderr.write(`    persona_test_sessions:  inserted ${sessionsRes.inserted}, skipped ${sessionsRes.skipped}\n`);
    process.stderr.write(`    Audit-loop now holds:   ${tPersonas.rows[0].c} personas, ${tSessions.rows[0].c} sessions\n`);
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.stack || err.message}\n`);
  process.exit(1);
});
