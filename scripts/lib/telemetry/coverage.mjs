/**
 * @fileoverview Null-rate coverage gate, pure core
 * (docs/plans/own-model-telemetry-pr3.md decision 7; memo section 6.8 row 11).
 *
 * A capture column that quietly stops filling is the failure this exists for
 * (`adjudicator_kind` sat 97% null and nobody saw it). The tracked set is a
 * committed config of `{table, column, since, where?, expectFill, tolerance}`:
 *
 *   - `where` is a key into the closed APPLICABILITY enum (fixed SQL fragments in
 *     code, never caller text), so an optional field is measured only over the rows
 *     that CAN fill it;
 *   - `expectFill` is a HAND-SET floor, never seeded from an observed zero;
 *   - drift is measured against an optional committed `baselineRate`.
 *
 * Everything here is PURE (config + numbers in, decisions out). The store reads live
 * in `scripts/own-model-coverage.mjs`.
 *
 * Status vocabulary (closed): ok | drift | below-floor | unmeasured:no-eligible-rows
 * | unmeasured:store. Zero eligible rows is `unmeasured`, never green and never a rate.
 *
 * @module scripts/lib/telemetry/coverage
 */

import { MECHANICAL_WAVES } from '../audit-shadow.mjs';

/**
 * SQL for "this row was raised by a pass that has no model", GENERATED from MECHANICAL_WAVES -- never a hand list, so a
 * new mechanical wave leaves the model-attribution floors without an edit here (audit-telemetry-capture Decision 5).
 * Each wave name is a fixed identifier asserted below, so the fragment never carries caller text.
 */
const waveName = (w) => {
  if (!/^[a-z][a-z-]*$/.test(w)) throw new Error(`coverage: unsafe mechanical wave name ${JSON.stringify(w)}`);
  return w;
};
const WAVE_SQL_LIST = MECHANICAL_WAVES.map((w) => `'${waveName(w)}'`).join(', ');
/** A finding's category is prefixed `[<DisplayPrefix>]` by finding-assembly; the display prefix is the wave name capitalised. */
const WAVE_CATEGORY_GUARD = MECHANICAL_WAVES.map((w) => `category NOT LIKE '[${waveName(w)[0].toUpperCase()}${w.slice(1)}]%'`).join(' AND ');

/** Closed enum of applicability predicates: key -> fixed SQL fragment. */
export const APPLICABILITY = Object.freeze({
  all: 'TRUE',
  pass_selection: "decision_type = 'pass_selection'",
  non_campaign_event: "event_origin IS DISTINCT FROM 'campaign'",
  code_run: "mode = 'code'",
  audit_producer: "producer = 'audit'",
  // Rows raised by a model: audit_findings by classification kind and wave prefix, audit_pass_stats by pass name.
  model_finding: `source_kind = 'MODEL' AND ${WAVE_CATEGORY_GUARD}`,
  // A pass that made a model call recorded tokens; one that never ran (frontend on a backend diff) or never called a model
  // (architecture's mechanical siblings) did not. Measured 2026-10-29 on rows since 2026-08-23: with the token guard every
  // LLM pass fills source_model 100% and the only nulls are the MECHANICAL_WAVES that bill tokens without a model
  // (adjacency, duplication) -- without it the same column reads 51% on passes that never had a model to record.
  model_pass: `COALESCE(input_tokens, 0) > 0 AND pass_name NOT IN (${WAVE_SQL_LIST})`,
  // The final reviewer's per-finding reversals: the one adjudicator kind whose model the script CAN observe.
  reviewer_event: "adjudicator_kind = 'reviewer'",
});

export const STATUSES = Object.freeze(['ok', 'drift', 'below-floor', 'unmeasured:no-eligible-rows', 'unmeasured:store']);

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;

/**
 * PURE. Validate the config shape. Returns every problem, never throws.
 * @param {unknown} config
 * @returns {string[]}
 */
export function validateConfig(config) {
  const errs = [];
  if (!config || typeof config !== 'object' || !Array.isArray(config.entries)) return ['config.entries must be an array'];
  // Required: a missing value used to default to a date past every migration, which silently scanned nothing.
  if (!/^[0-9]{14}$/.test(config.coverageFromMigration ?? '')) errs.push('coverageFromMigration must be a 14-digit migration timestamp');
  if (config.windowDays !== undefined && !(Number.isInteger(config.windowDays) && config.windowDays >= 1 && config.windowDays <= 3650)) errs.push('windowDays must be an integer in [1,3650]');
  const seen = new Set();
  config.entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    if (!e || typeof e !== 'object') { errs.push(`${at}: not an object`); return; }
    if (!IDENT.test(e.table ?? '')) errs.push(`${at}: bad table`);
    if (!IDENT.test(e.column ?? '')) errs.push(`${at}: bad column`);
    if (e.timeColumn !== undefined && !IDENT.test(e.timeColumn)) errs.push(`${at}: bad timeColumn`);
    if (!ISO_DATE.test(e.since ?? '')) errs.push(`${at}: since must be an ISO date`);
    if (e.where !== undefined && !Object.hasOwn(APPLICABILITY, e.where)) errs.push(`${at}: where "${e.where}" is not in the applicability enum`);
    if (!(Number.isFinite(e.expectFill) && e.expectFill >= 0 && e.expectFill <= 1)) errs.push(`${at}: expectFill must be a number in [0,1]`);
    if (!(Number.isFinite(e.tolerance) && e.tolerance >= 0 && e.tolerance <= 1)) errs.push(`${at}: tolerance must be a number in [0,1]`);
    if (e.baselineRate !== undefined && e.baselineRate !== null && !(Number.isFinite(e.baselineRate) && e.baselineRate >= 0 && e.baselineRate <= 1)) errs.push(`${at}: baselineRate must be null or in [0,1]`);
    const k = `${e.table}.${e.column}.${e.where ?? 'all'}`;
    if (seen.has(k)) errs.push(`${at}: duplicate entry ${k}`);
    seen.add(k);
  });
  return errs;
}

/**
 * PURE. The measuring query for one VALIDATED entry (identifiers are regex-checked, the
 * predicate comes from the closed enum, the date is a bound parameter).
 * @returns {{sql: string, params: unknown[]}}
 */
export function buildMeasureSql(entry, windowDays = 30) {
  if (!IDENT.test(entry.table) || !IDENT.test(entry.column) || !IDENT.test(entry.timeColumn ?? 'created_at')) throw new Error('coverage: unsafe identifier');
  if (entry.where !== undefined && !Object.hasOwn(APPLICABILITY, entry.where)) throw new Error('coverage: unknown applicability key');
  const pred = APPLICABILITY[entry.where ?? 'all'];
  const t = entry.timeColumn ?? 'created_at';
  return {
    // A ROLLING window clipped by `since`: all-time fill would let months of healthy history mask a writer that stopped last week.
    sql: `SELECT count(*)::int AS total, count(${entry.column})::int AS filled FROM ${entry.table} WHERE ${t} >= GREATEST($1::timestamptz, now() - ($2::int * interval '1 day')) AND (${pred})`,
    params: [entry.since, windowDays],
  };
}

/**
 * PURE. Decide one entry's status from a measurement.
 * @param {object} entry
 * @param {{total: number, filled: number}|null} measured null = the store could not be read
 * @returns {{status: string, rate: number|null, total: number|null, filled: number|null}}
 */
export function evaluateEntry(entry, measured) {
  if (!measured) return { status: 'unmeasured:store', rate: null, total: null, filled: null };
  const total = Number(measured.total);
  const filled = Number(measured.filled);
  if (!Number.isFinite(total) || !Number.isFinite(filled) || total < 0 || filled < 0 || filled > total) return { status: 'unmeasured:store', rate: null, total: null, filled: null };
  if (total === 0) return { status: 'unmeasured:no-eligible-rows', rate: null, total, filled };
  const rate = filled / total;
  let status = 'ok';
  if (rate < entry.expectFill) status = 'below-floor';
  else if (Number.isFinite(entry.baselineRate) && rate < entry.baselineRate - entry.tolerance) status = 'drift';
  return { status, rate, total, filled };
}

/**
 * PURE. Exit code over a result set: 1 any drift/below-floor, else 3 any unmeasured, else 0.
 * A failure outranks an unmeasured column: a known-bad column must not hide behind an unreadable one.
 */
export function exitCodeFor(results) {
  if (results.some((r) => r.status === 'drift' || r.status === 'below-floor')) return 1;
  if (results.some((r) => r.status.startsWith('unmeasured'))) return 3;
  return 0;
}

/**
 * PURE. Columns ADDED by migrations at or after `fromMigration`, from raw SQL text.
 * Only `ALTER TABLE t ADD COLUMN [IF NOT EXISTS] c <type...>` statements (columns of a brand-new `CREATE TABLE`
 * are NOT scanned: such tables are tracked by explicit entries); a column declared
 * NOT NULL in that statement can never be null and is not returned.
 * @param {Array<{name: string, sql: string}>} migrations
 * @returns {Array<{table: string, column: string, migration: string}>}
 */
export function addedColumns(migrations, fromMigration) {
  const out = [];
  // One ALTER TABLE statement may carry several ADD COLUMN actions (comma separated): take the statement, then every action.
  const stmt = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([^;]*);/gi;
  const action = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)((?:[^,(]|\([^)]*\))*)/gi;
  for (const m of migrations) {
    if (m.name < fromMigration) continue;
    const text = m.sql.replace(/--[^\n]*/g, '');
    for (const st of text.matchAll(stmt)) {
      for (const x of st[2].matchAll(action)) {
        if (/\bNOT\s+NULL\b/i.test(x[2])) continue;
        out.push({ table: st[1].toLowerCase(), column: x[1].toLowerCase(), migration: m.name });
      }
    }
  }
  return out;
}

/**
 * PURE. The offline gate: every entry validates and names a column present in the schema
 * fixture, and every nullable column a covered migration added has an entry or a declared
 * exemption (with a reason).
 * @param {object} config parsed .own-model-coverage.json
 * @param {Map<string, Set<string>>} schemaColumns table -> column names (from the schema fixture)
 * @param {Array<{name: string, sql: string}>} migrations
 * @returns {string[]} violations (empty = pass)
 */
export function checkStatic(config, schemaColumns, migrations) {
  const errs = validateConfig(config);
  if (errs.length) return errs;
  const out = [];
  const covered = new Set(config.entries.map((e) => `${e.table}.${e.column}`));
  for (const e of config.entries) {
    const cols = schemaColumns.get(e.table);
    if (!cols) out.push(`${e.table}.${e.column}: table not in the schema fixture`);
    else if (!cols.has(e.column)) out.push(`${e.table}.${e.column}: column not in the schema fixture`);
  }
  const exempt = new Map((config.exempt ?? []).map((x) => [`${x.table}.${x.column}`, x.reason]));
  for (const [k, reason] of exempt) if (!String(reason ?? '').trim()) out.push(`${k}: exemption needs a reason`);
  for (const c of addedColumns(migrations, config.coverageFromMigration)) {
    const k = `${c.table}.${c.column}`;
    if (!covered.has(k) && !String(exempt.get(k) ?? '').trim()) out.push(`${k}: added by ${c.migration} but has no coverage entry or exemption`);
  }
  return out;
}
