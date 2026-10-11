/**
 * @fileoverview Schema-capability probes for the audit store — "does this
 * optional, later-migration column exist on THIS store?" — extracted from
 * `runs-findings.mjs` (which re-exports the `_reset*` test seams) so the
 * writers there can keep growing their guards without growing that file.
 *
 * Every probe is a 0-row `SELECT col FROM table LIMIT 0`, and every probe obeys
 * the same three rules:
 *  - only a DEFINITIVE answer is cached (`42703`/`42P01` = confirmed absent, a
 *    successful probe = present) — a transient error never poisons the cache;
 *  - a transient error is retried once, then reported as `definitive:false`;
 *  - a probe issued while a `withTx` frame is active runs inside its own
 *    SAVEPOINT (`isolated` below). The `db/query.mjs` helpers bind to the active
 *    transaction client, so a probe that fails — which is exactly what an
 *    un-migrated store's probe does — would otherwise abort the CALLER's
 *    transaction, and the findings it was about to write would vanish at COMMIT.
 *
 * @module scripts/lib/store/column-probes
 */

import { many, withTx } from '../db/query.mjs';
import { getActiveTxClient } from '../db/client.mjs';
import { isCloudEnabled } from './repo.mjs';

/**
 * True only for PostgreSQL `undefined_column` (SQLSTATE 42703) or
 * `undefined_table` (42P01) — the errors that genuinely mean "this column is
 * absent" (an un-migrated store). Every other failure (connection refused,
 * permission, pool exhaustion, statement timeout) is transient/unexpected and
 * must NOT be cached as "column missing" (M3/M5).
 */
function isUndefinedColumnError(err) {
  return !!err && (
    err.code === '42703' || err.code === '42P01'
    || /column .* does not exist|relation .* does not exist/i.test(err.message || '')
  );
}

/** Run one probe statement, SAVEPOINT-isolated when a transaction is active. */
function isolated(manyFn, sql) {
  return getActiveTxClient() ? withTx(() => manyFn(sql)) : manyFn(sql);
}

/**
 * Probe with ONE retry on a transient error. Returns `{ present, definitive }`;
 * `definitive` is true only for an authoritative answer (M3/M5/M6).
 */
async function probeColumn(sql, manyFn = many) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await isolated(manyFn, sql);
      return { present: true, definitive: true };
    } catch (err) {
      if (isUndefinedColumnError(err)) return { present: false, definitive: true };
      if (attempt === 0) continue; // transient — retry once before degrading
      process.stderr.write(`  [learning] column probe failed transiently (${err.code || err.message}); columnless for this call\n`);
    }
  }
  return { present: false, definitive: false };
}

// Cached classification-column probe (column shape doesn't change mid-run).
let _hasClassificationColumns = null;

/** Test-only reset for the probe cache (mirrors legacy export). */
export function _resetClassificationColumnCache() {
  _hasClassificationColumns = null;
}

/**
 * @param {typeof many} [manyFn]
 * @param {() => Promise<boolean>} [cloudFn]
 * @returns {Promise<boolean>} whether `audit_findings.sonar_type` & co. exist
 */
export async function detectClassificationColumns(manyFn = many, cloudFn = isCloudEnabled) {
  if (_hasClassificationColumns !== null) return _hasClassificationColumns;
  // Cloud off means NO probe ran: that is "not asked", not "column absent", so it
  // is answered but never cached — a cached false would outlive the store coming up.
  if (!await cloudFn()) return false;
  const { present, definitive } = await probeColumn(`SELECT sonar_type FROM audit_findings LIMIT 0`, manyFn);
  if (definitive) {
    _hasClassificationColumns = present; // cache only an authoritative result
    if (!present) process.stderr.write('  [learning] classification columns not present — run migration to enable\n');
  }
  return present;
}

// Cached probe for the run-unification `audit_pass_stats.round` column
// (migration 20260605120000), so the round code degrades to the columnless path
// on an un-migrated store (WS1 §1.3a).
let _hasPassStatsRoundColumn = null;

/** Test-only reset for the round-column probe cache. */
export function _resetPassStatsRoundColumnCache() {
  _hasPassStatsRoundColumn = null;
}

/**
 * `{present, definitive}`, not a bare boolean: `updatePassStatsPostDeliberation`
 * falls back to a per-run (all-rounds) UPDATE only on a CONFIRMED-absent column
 * — on an unresolved probe that fallback would overwrite every round's row.
 * @param {typeof many} [manyFn]
 * @param {() => Promise<boolean>} [cloudFn]
 * @returns {Promise<{present: boolean, definitive: boolean}>}
 */
export async function detectPassStatsRoundColumn(manyFn = many, cloudFn = isCloudEnabled) {
  if (_hasPassStatsRoundColumn !== null) return { present: _hasPassStatsRoundColumn, definitive: true };
  if (!await cloudFn()) return { present: false, definitive: true };
  const result = await probeColumn(`SELECT round FROM audit_pass_stats LIMIT 0`, manyFn);
  if (result.definitive) {
    _hasPassStatsRoundColumn = result.present; // cache only an authoritative result
    if (!result.present) process.stderr.write('  [learning] audit_pass_stats.round not present — run migration 20260605120000 for per-round pass telemetry\n');
  }
  return result;
}

// Generic cached optional-column probe, keyed `<table>.<col>` — the same
// `SELECT col … LIMIT 0` pattern as the two column-specific probes above,
// generalised for the many later-migration columns the writers and the
// dashboard read path guard.
const _runReadColumnCache = new Map();

/** Test-only reset for the read-path column probe cache. */
export function _resetRunReadColumnCache() {
  _runReadColumnCache.clear();
}

/**
 * round-3 audit H2 (GPT deliberation: compromise, MEDIUM): `columnExists`
 * cannot distinguish "confirmed absent" from "an exhausted transient probe" —
 * both read `false` to its ~25 boolean-context call sites, and widening ALL of
 * them to a tri-state was ruled disproportionate. This exposes the
 * `definitive` bit for the write sites whose REPORTED outcome a caller trusts
 * (`updateRunMeta`, `applyRemediationVerificationResults`,
 * `updatePassStatsPostDeliberation`).
 *
 * @param {string} table  hardcoded table literal (never user input)
 * @param {string} col    hardcoded column literal (never user input)
 * @param {(sql:string, params?:unknown[]) => Promise<unknown[]>} manyFn
 * @param {() => Promise<boolean>} cloudFn
 * @returns {Promise<{present: boolean, definitive: boolean}>}
 */
export async function probeColumnExistence(table, col, manyFn, cloudFn) {
  const key = `${table}.${col}`;
  if (_runReadColumnCache.has(key)) return { present: _runReadColumnCache.get(key), definitive: true };
  // No probe ran with the cloud off, so there is nothing to cache (see the
  // module header: only a schema observation is cached).
  if (!await cloudFn()) return { present: false, definitive: true };
  // Retry once before degrading (round-1 audit H8/H17): a single blip must not
  // omit the probed column from THIS call — load-bearing for `recordFindings`,
  // whose intra-batch dedup key depends on `hasBucket` being accurate.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await isolated(manyFn, `SELECT "${col}" FROM ${table} LIMIT 0`);
      _runReadColumnCache.set(key, true);
      return { present: true, definitive: true };
    } catch (err) {
      if (isUndefinedColumnError(err)) {
        _runReadColumnCache.set(key, false);
        return { present: false, definitive: true };
      }
      if (attempt === 0) continue;
      // round-2 audit H5: an exhausted transient probe is NOT a confirmed-absent
      // column — say so, and leave the cache unset so the next call re-probes.
      process.stderr.write(`  [learning] columnExists(${key}) probe failed transiently (${err.code || err.message}); treating as absent for this call only\n`);
    }
  }
  return { present: false, definitive: false };
}

/** Boolean form of `probeColumnExistence` for call sites that degrade either way. */
export async function columnExists(table, col, manyFn, cloudFn) {
  const { present } = await probeColumnExistence(table, col, manyFn, cloudFn);
  return present;
}
