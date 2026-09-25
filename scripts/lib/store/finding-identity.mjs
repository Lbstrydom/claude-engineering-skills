/**
 * @fileoverview Canonical `audit_findings` row identity — the ONE place the
 * compound key `(run_id, finding_fingerprint, pass_name, bucket)` is spelled
 * out, and the ONE lookup oracle that resolves it against a real row.
 *
 * Plan: docs/plans/runs-findings-write-boundary-hardening.md, Phase 1.
 *
 * Companion module to `finding-write.mjs` (Root Cause 2 — write-boundary
 * atomicity). This one is Root Cause 1: every read/lookup site in
 * `runs-findings.mjs` used to re-derive a partial, ad hoc subset of the real
 * key — fingerprint alone, or fingerprint+bucket without pass_name, or a bare
 * `LIMIT 1` with no ordering. `selectFindingRow` below is the single place
 * that ambiguity is refused rather than silently guessed.
 *
 * @module scripts/lib/store/finding-identity
 */

import { many } from '../db/query.mjs';

/**
 * JS-side string identity for `bucket` — mirrors the exact SQL expression
 * `recordFindings`' own `ON CONFLICT (..., COALESCE(bucket, ''))` target uses.
 *
 * This is a string-identity helper ONLY — never build a SQL predicate with
 * it. Deliberately distinct from `normaliseBucket` in `runs-findings.mjs`
 * (which validates/canonicalises a bucket *enum value*, a different concern);
 * the two must never be conflated.
 *
 * @param {string|null|undefined} bucket
 * @returns {string}
 */
export function coalesceBucket(bucket) {
  return bucket ?? '';
}

/**
 * Build the canonical compound key object for `selectFindingRow`'s
 * query-building. Every field is optional except `fingerprint`.
 *
 * An ABSENT field (or one whose value is `undefined`) means "do not filter
 * on this column at all" — deliberately different from an explicit `null`
 * (filter `col IS NOT DISTINCT FROM NULL`). This distinction is load-bearing
 * for `bucket`: an omitted bucket must let a lookup resolve across every
 * bucket, while an explicit `bucket: null` must match only rows where the
 * column is genuinely `NULL` (a primary finding). Does NOT coalesce `bucket`
 * — that would destroy this distinction; use `coalesceBucket` separately for
 * JS-side string identity (dedup keys), never here.
 *
 * @param {{runId?: string, fingerprint: string, passName?: string, bucket?: string|null, roundRaised?: number}} fields
 * @returns {Record<string, unknown>}
 */
export function findingKeyOf(fields) {
  const key = {};
  for (const k of ['runId', 'fingerprint', 'passName', 'bucket', 'roundRaised']) {
    if (Object.prototype.hasOwnProperty.call(fields, k) && fields[k] !== undefined) {
      key[k] = fields[k];
    }
  }
  return key;
}

/**
 * Build a STRING from a partial key's fields, for use as a `Set`/`Map` dedup
 * key — never `findingKeyOf`'s object form, which a `Set` compares by
 * reference (two separately-constructed key objects for the same logical
 * finding would never collapse). `bucket` is passed through `coalesceBucket`
 * so this agrees with the DB's `COALESCE(bucket, '')` unique-index
 * expression. Only the fields present in `key` are included, in a fixed
 * order, so two calls with the same logical partial key always produce the
 * same string.
 *
 * @param {{fingerprint?: string, bucket?: string|null, runId?: string, passName?: string, roundRaised?: number}} key
 * @returns {string}
 */
export function findingKeyString(key) {
  const parts = [];
  if (key.runId !== undefined) parts.push(`runId=${key.runId}`);
  if (key.fingerprint !== undefined) parts.push(`fingerprint=${key.fingerprint}`);
  if (key.passName !== undefined) parts.push(`passName=${key.passName}`);
  if (Object.prototype.hasOwnProperty.call(key, 'bucket') && key.bucket !== undefined) {
    parts.push(`bucket=${coalesceBucket(key.bucket)}`);
  }
  if (key.roundRaised !== undefined) parts.push(`roundRaised=${key.roundRaised}`);
  return parts.join('|');
}

const KEY_COLUMNS = {
  runId: 'run_id',
  fingerprint: 'finding_fingerprint',
  passName: 'pass_name',
  bucket: 'bucket',
  roundRaised: 'round_raised',
};

/**
 * The ONE lookup oracle for a single logical `audit_findings` row. `runId`
 * is mandatory — never a bare fingerprint-only or repo-only query (`runId`
 * alone bounds the candidate set to one audit run).
 *
 * A key field counts as present only when `key[field] !== undefined` — not
 * merely "is an own property" (a caller building `{bucket: opts.bucket}`
 * from an unset optional flag still creates an own `bucket` property whose
 * value is `undefined`; that must be treated as absent, not as `bucket IS
 * NULL`). A present field becomes a `col IS NOT DISTINCT FROM $val`
 * predicate with the RAW value — never coalesced (coalescing to `''` would
 * be wrong on its own terms: `bucket = ''` never matches a `NULL` row).
 *
 * Queries with `ORDER BY created_at DESC` and then explicitly checks
 * uniqueness: fetches up to 2 candidates, and if a 2nd exists whose
 * unsupplied key fields differ from the top candidate, returns an
 * `ambiguous` result rather than trusting `DESC` to have picked "the" row.
 *
 * No `repoId` option: `runId` is already repo-scoping by construction
 * (`audit_runs.repo_id` is a foreign key), and no current caller resolves a
 * finding without an already-known `runId`.
 *
 * `manyFn` is injectable (defaults to the real `many` from `db/query.mjs`),
 * mirroring `runs-findings.mjs`'s own `columnExists(table, col, manyFn,
 * cloudFn)` DI pattern — lets a Tier-1 unit test assert the ambiguity/
 * no-match logic against a fake row set without a live database.
 *
 * @param {{runId: string, fingerprint?: string, passName?: string, bucket?: string|null, roundRaised?: number}} key
 * @param {typeof many} [manyFn]
 * @returns {Promise<{ok: true, id: string, runId: string, fingerprint: string, passName: string, bucket: string|null}
 *                  | {ok: false, reason: 'no-match'|'ambiguous', candidates?: Array<Record<string, unknown>>}>}
 */
export async function selectFindingRow(key, manyFn = many) {
  if (!key || key.runId === undefined) {
    throw new TypeError('selectFindingRow: key.runId is mandatory');
  }
  const where = [];
  const params = [];
  for (const [field, column] of Object.entries(KEY_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(key, field) || key[field] === undefined) continue;
    params.push(key[field]);
    where.push(`${column} IS NOT DISTINCT FROM $${params.length}`);
  }
  const rows = await manyFn(
    `SELECT id, run_id, finding_fingerprint, pass_name, bucket, round_raised, created_at
       FROM audit_findings
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 2`,
    params
  );
  if (rows.length === 0) return { ok: false, reason: 'no-match' };
  if (rows.length > 1) {
    const [top, next] = rows;
    const unsuppliedDiffers = Object.entries(KEY_COLUMNS).some(([field, column]) => {
      if (Object.prototype.hasOwnProperty.call(key, field) && key[field] !== undefined) return false;
      return top[column] !== next[column];
    });
    if (unsuppliedDiffers) {
      return { ok: false, reason: 'ambiguous', candidates: rows };
    }
  }
  const row = rows[0];
  return {
    ok: true,
    id: row.id,
    runId: row.run_id,
    fingerprint: row.finding_fingerprint,
    passName: row.pass_name,
    bucket: row.bucket,
  };
}
