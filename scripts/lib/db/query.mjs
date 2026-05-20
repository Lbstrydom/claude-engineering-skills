/**
 * @fileoverview Thin SQL helpers + `withTx` over the shared `pg.Pool`.
 *
 * Plan: docs/plans/postgres-parity.md §7 Phase 1 row 3.
 *
 * Every helper auto-binds to the active transaction client when a `withTx`
 * frame is on the AsyncLocalStorage stack — otherwise it talks to the pool
 * directly. Domain modules never juggle clients (Gemini G3 / R15).
 *
 * SQL-building helpers (`insertReturning`, `upsert`, `updateWhere`,
 * `deleteWhere`) are pure functions over plain objects with parameterised
 * placeholders. They never accept raw string fragments for column or table
 * names — those go through `quoteIdent` which rejects anything containing a
 * double-quote, so a column-name typo can't escalate into SQL injection
 * even if it ever did get fed user input.
 *
 * `_builders` is exported as a test seam for the pure SQL-generation tests
 * (mirrors the `_internals` pattern already in file-io.mjs / shared.mjs).
 *
 * @module scripts/lib/db/query
 */

import { _txStore, getActiveTxClient, getPool } from './client.mjs';
import { normalizePostgresError } from './errors.mjs';

// ── Identifier quoting ─────────────────────────────────────────────────────

/**
 * Wrap a Postgres identifier in double-quotes. Refuses anything containing
 * a `"` so a malformed column or table name cannot be used to break out of
 * the quoted region.
 *
 * @param {string} name
 * @returns {string}
 */
function quoteIdent(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('quoteIdent: identifier must be a non-empty string');
  }
  if (name.includes('"')) {
    throw new Error(`quoteIdent: identifier contains a double-quote: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Identifier shape used by the conflict-target ON-CONSTRAINT form. Mirrors
 * Postgres's "regular identifier" rules — letter/underscore lead, then
 * letters / digits / underscores / dollar signs. Quoted constraint names
 * aren't supported here (tighten if a real call site ever needs them).
 */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Normalise the `returning` option for INSERT/UPDATE/DELETE.
 *  - `true` / `'*'` → `*` (wildcard — explicit opt-in)
 *  - `string[]`     → comma-separated, each entry quoted as an identifier
 *
 * **Raw-string expressions are NOT accepted** (audit R1 M7/M10, R2 H2):
 * the API used to pass any non-empty string through verbatim, which left a
 * direct path for unsanitised SQL to reach generated statements. To project
 * a computed expression, change the SQL builder rather than smuggling raw
 * SQL through the type-safe boundary.
 */
function normalizeReturning(r) {
  if (r === true || r === '*') return '*';
  if (Array.isArray(r)) {
    if (r.length === 0) throw new Error('returning: array cannot be empty');
    return r.map(quoteIdent).join(', ');
  }
  throw new TypeError(
    `returning: must be true | '*' | string[] (raw strings are not accepted — pass ['col1','col2']); got ${typeof r}`
  );
}

/**
 * Normalise the `onConflict` target. Three legal forms:
 *  - `string[]`              → `("a", "b")` (each column quoted)
 *  - `string` identifier(s)  → bare column, or comma-list of columns
 *  - `'ON CONSTRAINT <name>'`→ ON CONSTRAINT form (constraint name must be
 *                               a regular identifier; see SAFE_IDENT_RE)
 *
 * **Parenthesised raw expressions are NOT accepted** (audit R1 M7/M10,
 * R2 H2): the previous `(<anything>)` passthrough was a SQL-injection
 * surface. If an expression-index call site ever needs `(LOWER(name))`,
 * add a typed builder for it.
 */
function normalizeConflictTarget(target) {
  if (Array.isArray(target)) {
    if (target.length === 0) throw new Error('onConflict: array cannot be empty');
    return `(${target.map(quoteIdent).join(', ')})`;
  }
  if (typeof target === 'string' && target.length > 0) {
    const trimmed = target.trim();
    // ON CONSTRAINT <name> — constraint name must be a regular identifier.
    const onConstraint = /^ON\s+CONSTRAINT\s+(\S+)\s*$/i.exec(trimmed);
    if (onConstraint) {
      const name = onConstraint[1];
      if (!SAFE_IDENT_RE.test(name)) {
        throw new Error(`onConflict: ON CONSTRAINT requires a regular identifier name, got "${name}"`);
      }
      return `ON CONSTRAINT ${name}`;
    }
    // Reject raw parenthesised expressions.
    if (trimmed.startsWith('(')) {
      throw new Error(
        'onConflict: raw parenthesised expressions are not accepted — pass a string[] of column names instead'
      );
    }
    // Bare list — split on commas, validate each as an identifier.
    const cols = trimmed.split(',').map((s) => quoteIdent(s.trim()));
    return `(${cols.join(', ')})`;
  }
  throw new TypeError(`onConflict: must be string or string[], got ${typeof target}`);
}

// ── Pure SQL builders ──────────────────────────────────────────────────────
// Exported via `_builders` for unit tests. Each returns `{sql, params}`.
//
// ### `undefined` contract (audit R1 H2 / H3 / H7)
//
// Across every mutation builder, `undefined` is treated identically: it means
// "this column / predicate was never supplied". The two safe interpretations
// of that fact are opposite for inserts vs predicates, so each builder picks
// the one matching its semantic role:
//
//   - **INSERT-side** (buildInsert / buildUpsert): an undefined column value
//     is dropped from the SQL so the column's DB default fires. Callers who
//     want a real NULL must pass `null` explicitly.
//   - **WHERE-side** (buildUpdate / buildDelete): an undefined predicate
//     value is **rejected** with a hard error — silently widening a 1-row
//     UPDATE/DELETE to all-rows on an upstream typo is unrecoverable. `null`
//     is allowed and translates to `IS NULL`.
//
// `buildUpsert` additionally enforces uniform-shape across rows (per-row key
// sets must match row 0). Combined with the column-drop rule this means an
// `undefined` in row 0 omits the column from every row in the batch — which
// is what callers expect when a payload mixes "set / leave default" semantics.

/**
 * Build an `INSERT … RETURNING …` statement from a plain row object.
 * Undefined values are skipped (treated as "column not supplied", which
 * lets DB defaults / generated columns fire). To write a real NULL, pass
 * `null` explicitly.
 *
 * @param {string} table
 * @param {Record<string, unknown>} row
 * @param {{returning?: true | '*' | string | string[]}} [opts]
 * @returns {{sql: string, params: unknown[]}}
 */
function buildInsert(table, row, { returning } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('buildInsert: row must be a plain object');
  }
  const entries = Object.entries(row).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    throw new Error(`buildInsert(${table}): all column values are undefined`);
  }
  const cols = entries.map(([k]) => quoteIdent(k));
  const placeholders = entries.map((_, i) => `$${i + 1}`);
  const params = entries.map(([, v]) => v);
  let sql = `INSERT INTO ${quoteIdent(table)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
  if (returning !== undefined) sql += ` RETURNING ${normalizeReturning(returning)}`;
  return { sql, params };
}

/**
 * Build an `INSERT … ON CONFLICT …` (DO NOTHING or DO UPDATE) statement
 * from a uniform array of row objects.
 *
 * `update`:
 *  - omitted / `null` / `'ignore'` / `false` → `DO NOTHING`
 *  - `'all'`           → `DO UPDATE SET <every column> = EXCLUDED.<column>`
 *  - `string[]`        → `DO UPDATE SET <listed columns> = EXCLUDED.<column>`
 *
 * @param {string} table
 * @param {Array<Record<string, unknown>>} rows
 * @param {{
 *   onConflict?: string | string[],
 *   update?: 'all' | string[] | 'ignore' | null | false,
 *   returning?: true | '*' | string | string[]
 * }} [opts]
 */
function buildUpsert(table, rows, { onConflict, update, returning } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`buildUpsert(${table}): rows must be a non-empty array`);
  }
  // Per the §INSERT-side rule above, an `undefined` column drops out of the
  // SQL so DB defaults can fire — matching buildInsert's behaviour. We
  // derive the canonical key list from row 0 minus its undefined entries,
  // then enforce that EVERY row has the exact same defined-key set. That
  // makes "this column is defaulted for the whole batch" the only legal
  // shape — mixing defined / undefined for the same column across rows is
  // a contract violation (and would otherwise quietly bind `undefined` as
  // NULL via the pg driver — audit R1 H3 / H7).
  const keys = Object.keys(rows[0] || {}).filter((k) => rows[0][k] !== undefined);
  if (keys.length === 0) {
    throw new Error(`buildUpsert(${table}): row 0 has no defined columns`);
  }
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || {};
    const rk = Object.keys(r).filter((k) => r[k] !== undefined);
    if (rk.length !== keys.length || !keys.every((k) => rk.includes(k))) {
      throw new Error(`buildUpsert(${table}): row ${i} has a different defined-column shape from row 0`);
    }
  }
  // Validate update-column membership BEFORE building params (catches typos
  // at the boundary instead of waiting for a server-side 42703 — audit M8).
  if (Array.isArray(update)) {
    for (const col of update) {
      if (!keys.includes(col)) {
        throw new Error(`buildUpsert(${table}): update column "${col}" is not in the inserted column set`);
      }
    }
  }
  // If `update` requests DO UPDATE behaviour, `onConflict` MUST be present
  // — Postgres has no ON CONFLICT DO UPDATE without a target (audit M8).
  if (
    onConflict === undefined &&
    update != null && update !== 'ignore' && update !== false
  ) {
    throw new Error(`buildUpsert(${table}): \`update\` requires \`onConflict\` (no DO UPDATE without conflict target)`);
  }

  const cols = keys.map(quoteIdent);
  const params = [];
  const valueGroups = rows.map((row) => {
    const placeholders = keys.map((k) => {
      params.push(row[k]);
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  let sql = `INSERT INTO ${quoteIdent(table)} (${cols.join(', ')}) VALUES ${valueGroups.join(', ')}`;
  if (onConflict !== undefined) {
    const target = normalizeConflictTarget(onConflict);
    if (update == null || update === 'ignore' || update === false) {
      sql += ` ON CONFLICT ${target} DO NOTHING`;
    } else if (update === 'all') {
      const setClause = keys.map((k) => `${quoteIdent(k)} = EXCLUDED.${quoteIdent(k)}`).join(', ');
      sql += ` ON CONFLICT ${target} DO UPDATE SET ${setClause}`;
    } else if (Array.isArray(update)) {
      if (update.length === 0) {
        throw new Error(`buildUpsert(${table}): update array cannot be empty (use 'ignore' for DO NOTHING)`);
      }
      const setClause = update.map((k) => `${quoteIdent(k)} = EXCLUDED.${quoteIdent(k)}`).join(', ');
      sql += ` ON CONFLICT ${target} DO UPDATE SET ${setClause}`;
    } else {
      throw new TypeError(`buildUpsert(${table}): invalid update option: ${String(update)}`);
    }
  }
  if (returning !== undefined) sql += ` RETURNING ${normalizeReturning(returning)}`;
  return { sql, params };
}

/**
 * Validate + flatten a WHERE object to clauses + params. Shared by
 * buildUpdate and buildDelete so they enforce the exact same predicate
 * contract. `undefined` is a HARD ERROR (audit R1 H2) — silently dropping
 * a predicate value can widen a 1-row mutation to all-rows. `null` is
 * accepted and translates to `IS NULL` (Postgres's `= NULL` is never true
 * and would otherwise no-op).
 *
 * @param {string} table - for error messages
 * @param {string} op - 'UPDATE' or 'DELETE' for error messages
 * @param {Record<string, unknown>} where
 * @param {number} startParamIndex - placeholder counter the caller has
 *   already committed (so SET clauses + WHERE clauses share one $-counter)
 * @returns {{clauses: string[], params: unknown[]}}
 */
function flattenWhere(table, op, where, startParamIndex = 0) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) {
    throw new TypeError(`${op}(${table}): where must be a plain object`);
  }
  const entries = Object.entries(where);
  if (entries.length === 0) {
    throw new Error(`${op}(${table}): where clause cannot be empty`);
  }
  // Reject undefined predicates BEFORE filtering — an undefined value
  // collapses silently if we filter first, which is precisely the H2 bug.
  const undefKeys = entries.filter(([, v]) => v === undefined).map(([k]) => k);
  if (undefKeys.length > 0) {
    throw new Error(
      `${op}(${table}): refusing undefined WHERE value for column(s) ${undefKeys.join(', ')} ` +
      `— silently dropping a predicate could widen the mutation. Pass null for IS NULL, or omit the key.`
    );
  }
  const params = [];
  const clauses = entries.map(([k, v]) => {
    if (v === null) return `${quoteIdent(k)} IS NULL`;
    params.push(v);
    return `${quoteIdent(k)} = $${startParamIndex + params.length}`;
  });
  return { clauses, params };
}

/**
 * Build an `UPDATE … WHERE … RETURNING …` statement.
 * Refuses an empty WHERE — open-ended UPDATEs are a footgun, not a feature.
 *
 * `where` keys map to `col = $n`, except a `null` value which becomes
 * `col IS NULL`. `undefined` is rejected (see `flattenWhere`).
 */
function buildUpdate(table, patch, where, { returning } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError(`buildUpdate(${table}): patch must be a plain object`);
  }
  const patchEntries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (patchEntries.length === 0) {
    throw new Error(`buildUpdate(${table}): patch has no defined columns`);
  }

  const params = [];
  const setClauses = patchEntries.map(([k, v]) => {
    params.push(v);
    return `${quoteIdent(k)} = $${params.length}`;
  });
  const flat = flattenWhere(table, 'buildUpdate', where, params.length);
  for (const p of flat.params) params.push(p);

  let sql = `UPDATE ${quoteIdent(table)} SET ${setClauses.join(', ')} WHERE ${flat.clauses.join(' AND ')}`;
  if (returning !== undefined) sql += ` RETURNING ${normalizeReturning(returning)}`;
  return { sql, params };
}

/**
 * Build a `DELETE … WHERE … RETURNING …` statement.
 * Empty WHERE is refused; undefined predicate values are rejected (audit R1 H2).
 */
function buildDelete(table, where, { returning } = {}) {
  const flat = flattenWhere(table, 'buildDelete', where, 0);
  let sql = `DELETE FROM ${quoteIdent(table)} WHERE ${flat.clauses.join(' AND ')}`;
  if (returning !== undefined) sql += ` RETURNING ${normalizeReturning(returning)}`;
  return { sql, params: flat.params };
}

// ── Runtime execution ──────────────────────────────────────────────────────

/**
 * Execute a query against the active tx client (when inside `withTx`) or
 * the shared pool. Throws `Error & { code: 'NO_DB' }` if cloud mode is
 * disabled — callers that want graceful no-op behaviour should `getPool()`
 * first and skip.
 *
 * @template T
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult<T>>}
 */
async function _exec(sql, params = []) {
  const txClient = getActiveTxClient();
  if (txClient) {
    try {
      return await txClient.query(sql, params);
    } catch (err) {
      throw Object.assign(err, { _normalized: normalizePostgresError(err) });
    }
  }
  const pool = await getPool();
  if (!pool) {
    const err = new Error('No DB pool — set AUDIT_DB_URL to enable cloud mode');
    err.code = 'NO_DB';
    throw err;
  }
  try {
    return await pool.query(sql, params);
  } catch (err) {
    throw Object.assign(err, { _normalized: normalizePostgresError(err) });
  }
}

/**
 * Run a parameterised SQL string and return the full pg result.
 * Use this when you need `rowCount` or want to handle the result yourself.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export async function query(sql, params = []) {
  return _exec(sql, params);
}

/**
 * Return the single row produced by `sql`, or `null` if zero rows.
 * Throws if the query produced more than one row.
 *
 * @template T
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<T | null>}
 */
export async function one(sql, params = []) {
  const res = await _exec(sql, params);
  if (res.rows.length === 0) return null;
  if (res.rows.length > 1) {
    throw new Error(`one(): expected 0 or 1 row, got ${res.rows.length}`);
  }
  return res.rows[0];
}

/**
 * Return the rows array (possibly empty).
 *
 * @template T
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<T[]>}
 */
export async function many(sql, params = []) {
  const res = await _exec(sql, params);
  return res.rows;
}

/**
 * INSERT a row and return either the RETURNING projection (when `returning`
 * is supplied) or `null`. Skips undefined columns so DB-side defaults fire.
 *
 * @param {string} table
 * @param {Record<string, unknown>} row
 * @param {{returning?: true | '*' | string | string[]}} [opts]
 */
export async function insertReturning(table, row, opts = {}) {
  const { sql, params } = buildInsert(table, row, opts);
  if (opts.returning === undefined) {
    await _exec(sql, params);
    return null;
  }
  const res = await _exec(sql, params);
  return res.rows[0] ?? null;
}

/**
 * Multi-row UPSERT. See `buildUpsert` for the option surface. Returns the
 * RETURNING rows when supplied, else the raw rowCount.
 *
 * @param {string} table
 * @param {Array<Record<string, unknown>>} rows
 * @param {{
 *   onConflict?: string | string[],
 *   update?: 'all' | string[] | 'ignore' | null | false,
 *   returning?: true | '*' | string | string[]
 * }} [opts]
 */
export async function upsert(table, rows, opts = {}) {
  const { sql, params } = buildUpsert(table, rows, opts);
  const res = await _exec(sql, params);
  if (opts.returning !== undefined) return res.rows;
  return { rowCount: res.rowCount ?? 0 };
}

/**
 * UPDATE rows matching `where` with the supplied `patch`.
 *
 * @param {string} table
 * @param {Record<string, unknown>} patch
 * @param {Record<string, unknown>} where
 * @param {{returning?: true | '*' | string | string[]}} [opts]
 */
export async function updateWhere(table, patch, where, opts = {}) {
  const { sql, params } = buildUpdate(table, patch, where, opts);
  const res = await _exec(sql, params);
  if (opts.returning !== undefined) return res.rows;
  return { rowCount: res.rowCount ?? 0 };
}

/**
 * DELETE rows matching `where`.
 *
 * @param {string} table
 * @param {Record<string, unknown>} where
 * @param {{returning?: true | '*' | string | string[]}} [opts]
 */
export async function deleteWhere(table, where, opts = {}) {
  const { sql, params } = buildDelete(table, where, opts);
  const res = await _exec(sql, params);
  if (opts.returning !== undefined) return res.rows;
  return { rowCount: res.rowCount ?? 0 };
}

// ── Transactions ───────────────────────────────────────────────────────────

/**
 * Run `fn` inside a transaction. Re-entrant: when called from within another
 * `withTx` frame the nested call joins the parent transaction via SAVEPOINT
 * — the same `pg.PoolClient` is reused, so we can never deadlock against
 * `AUDIT_DB_POOL_MAX` by checking out a second client (Gemini G3 / R15).
 *
 * On thrown error the outermost frame issues `ROLLBACK`; nested frames
 * issue `ROLLBACK TO SAVEPOINT spN`. ROLLBACK failures are swallowed —
 * the original error is what the caller wants to see.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTx(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withTx: fn must be a function');
  }

  const parent = _txStore.getStore();
  if (parent) {
    const depth = parent.depth + 1;
    const sp = `sp_${depth}`;
    await parent.client.query(`SAVEPOINT ${sp}`);
    try {
      const result = await _txStore.run(
        { client: parent.client, depth },
        () => fn(parent.client)
      );
      await parent.client.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      try { await parent.client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* swallow — original error wins */ }
      throw err;
    }
  }

  const pool = await getPool();
  if (!pool) {
    const err = new Error('withTx: no DB pool — set AUDIT_DB_URL');
    err.code = 'NO_DB';
    throw err;
  }
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const result = await _txStore.run(
      { client, depth: 0 },
      () => fn(client)
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow — original error wins */ }
    throw err;
  } finally {
    if (!released) {
      released = true;
      client.release();
    }
  }
}

// ── Test seam ──────────────────────────────────────────────────────────────

/**
 * Pure SQL-string builders, exported as a private surface for unit tests
 * that exercise SQL generation without a database. Not part of the public
 * API — call the executing helpers (`insertReturning`/`upsert`/…) instead.
 */
export const _builders = Object.freeze({
  quoteIdent,
  normalizeReturning,
  normalizeConflictTarget,
  flattenWhere,
  buildInsert,
  buildUpsert,
  buildUpdate,
  buildDelete,
});
