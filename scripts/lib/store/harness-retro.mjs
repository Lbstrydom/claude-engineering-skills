/**
 * @fileoverview Store seam for the harness retro's derived records
 * (docs/plans/harness-retro.md §2 c14; migration 20261116120000_harness_retro.sql).
 *
 * Writers return receipts `{applied, rows, reason?, error?}` for the durable-write
 * registry (`scripts/lib/audit-store-writers.mjs`):
 *   - cloud off            → `{applied:false, reason:'cloud-off'}` (the ONLY decline)
 *   - superseded snapshot  → `{applied:true, rows:0, reason:'superseded'}` (idempotent success)
 *   - any SQL error        → `{applied:false, error}` with the ORIGINAL error, so a
 *     schema fault (store not migrated) spills and fails loudly instead of
 *     reading as a decline.
 *
 * Row schemas are `.strict()`: no field outside the plan's egress allowlist can
 * reach the store. There is deliberately no label / free-text column.
 *
 * @module scripts/lib/store/harness-retro
 */
import { z } from 'zod';
import { withTx, many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

const FP = z.string().regex(/^[0-9a-f]{16}$/);
const TS = z.string().min(10);

export const OccurrenceRowSchema = z.object({
  fingerprint: FP,
  kind: z.string().min(1).max(40),
  tool: z.string().max(200),
  occurrences: z.number().int().positive(),
  first_at: TS.nullable(),
  last_at: TS.nullable(),
}).strict();

export const SessionSnapshotSchema = z.object({
  session_key: z.string().regex(/^[0-9a-f]{32}$/),
  repo_uuid: z.string().uuid(),
  account_key: z.string().regex(/^[0-9a-f]{16}$/),
  origin: z.enum(['interactive', 'automated']),
  started_at: TS,
  fingerprint_version: z.number().int().positive(),
  signal_count: z.number().int().nonnegative(),
  last_scan_id: z.string().min(1),
  observed_until: TS,
  occurrences: z.array(OccurrenceRowSchema),
}).strict();

export const ScanRowSchema = z.object({
  scan_id: z.string().min(1),
  account_key: z.string().regex(/^[0-9a-f]{16}$/),
  repo_uuid: z.string().uuid(),
  fingerprint_version: z.number().int().positive(),
  requested_since: TS,
  requested_until: TS,
  files_listed: z.number().int().nonnegative(),
  files_read: z.number().int().nonnegative(),
  read_errors: z.number().int().nonnegative(),
  completed: z.boolean(),
}).strict();

/** The egress allowlist, exported so the CLI test can assert payload keys exactly. */
export const SNAPSHOT_KEYS = Object.freeze(Object.keys(SessionSnapshotSchema.shape));
export const OCCURRENCE_KEYS = Object.freeze(Object.keys(OccurrenceRowSchema.shape));

const UPSERT_SESSION_SQL = `
  INSERT INTO harness_retro_sessions
    (session_key, repo_uuid, account_key, origin, started_at, fingerprint_version, signal_count, last_scan_id, observed_until, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
  ON CONFLICT (session_key) DO UPDATE SET
    repo_uuid = EXCLUDED.repo_uuid, account_key = EXCLUDED.account_key, origin = EXCLUDED.origin,
    started_at = EXCLUDED.started_at, fingerprint_version = EXCLUDED.fingerprint_version,
    signal_count = EXCLUDED.signal_count, last_scan_id = EXCLUDED.last_scan_id,
    observed_until = EXCLUDED.observed_until, updated_at = now()
  WHERE harness_retro_sessions.observed_until <= EXCLUDED.observed_until
  RETURNING session_key`;

/**
 * One transaction per session: freshness-guarded upsert, then replace the
 * session's occurrences. A denominator can never land without its numerator.
 * @param {object} snapshot
 */
export async function writeSessionSnapshot(snapshot) {
  const s = SessionSnapshotSchema.parse(snapshot);
  if (!(await isCloudEnabled())) return { applied: false, rows: 0, reason: 'cloud-off' };
  try {
    return await withTx(async (client) => {
      const up = await client.query(UPSERT_SESSION_SQL, [
        s.session_key, s.repo_uuid, s.account_key, s.origin, s.started_at, s.fingerprint_version,
        s.signal_count, s.last_scan_id, s.observed_until,
      ]);
      if (up.rowCount === 0) return { applied: true, rows: 0, reason: 'superseded' };
      await client.query('DELETE FROM harness_retro_occurrences WHERE session_key = $1', [s.session_key]);
      for (const o of s.occurrences) {
        await client.query(
          `INSERT INTO harness_retro_occurrences (session_key, fingerprint, kind, tool, occurrences, first_at, last_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [s.session_key, o.fingerprint, o.kind, o.tool, o.occurrences, o.first_at, o.last_at],
        );
      }
      return { applied: true, rows: 1 + s.occurrences.length };
    });
  } catch (error) {
    return { applied: false, rows: 0, error };
  }
}

/** The scan row (coverage evidence). Idempotent on `scan_id`. */
export async function writeScanRow(row) {
  const r = ScanRowSchema.parse(row);
  if (!(await isCloudEnabled())) return { applied: false, rows: 0, reason: 'cloud-off' };
  try {
    return await withTx(async (client) => {
      const res = await client.query(
        `INSERT INTO harness_retro_scans
           (scan_id, account_key, repo_uuid, fingerprint_version, requested_since, requested_until,
            files_listed, files_read, read_errors, completed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (scan_id) DO UPDATE SET completed = EXCLUDED.completed
         RETURNING scan_id`,
        [r.scan_id, r.account_key, r.repo_uuid, r.fingerprint_version, r.requested_since, r.requested_until,
          r.files_listed, r.files_read, r.read_errors, r.completed],
      );
      return { applied: true, rows: res.rowCount ?? 0 };
    });
  } catch (error) {
    return { applied: false, rows: 0, error };
  }
}

/**
 * Sessions (+ their fingerprint counts) of one repo started in [fromTs, toTs).
 * Throws on a SQL error — a schema fault must never read as "no sessions".
 */
export async function readRetroWindow({ repoUuid, fromTs, toTs }) {
  const rows = await many(
    `SELECT s.session_key, s.repo_uuid, s.account_key, s.started_at, s.fingerprint_version,
            o.fingerprint, o.occurrences
       FROM harness_retro_sessions s
       LEFT JOIN harness_retro_occurrences o ON o.session_key = s.session_key
      WHERE s.repo_uuid = $1 AND s.started_at >= $2 AND s.started_at < $3`,
    [repoUuid, fromTs, toTs],
  );
  const byKey = new Map();
  for (const r of rows) {
    let s = byKey.get(r.session_key);
    if (!s) {
      s = { sessionKey: r.session_key, repoUuid: r.repo_uuid, accountKey: r.account_key,
        startedAt: new Date(r.started_at).toISOString(), fingerprintVersion: Number(r.fingerprint_version), counts: {} };
      byKey.set(r.session_key, s);
    }
    if (r.fingerprint) s.counts[r.fingerprint] = Number(r.occurrences);
  }
  return [...byKey.values()];
}

/** Completed AND incomplete scan rows of one repo (the effect function filters). Throws on SQL error. */
export async function readRetroScans({ repoUuid }) {
  const rows = await many(
    `SELECT account_key, repo_uuid, requested_since, requested_until, completed
       FROM harness_retro_scans WHERE repo_uuid = $1`,
    [repoUuid],
  );
  return rows.map((r) => ({
    accountKey: r.account_key, repoUuid: r.repo_uuid, completed: r.completed === true,
    since: new Date(r.requested_since).toISOString(), until: new Date(r.requested_until).toISOString(),
  }));
}
