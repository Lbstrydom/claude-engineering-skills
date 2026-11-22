/**
 * @fileoverview The store reads behind `capture:completeness` (docs/plans/own-model-full-capture.md
 * section 2.9, phase P0). Read-only SQL with every value a bound parameter; the verdicts are in
 * `./completeness.mjs` (pure). A store without the P0 columns still answers: the new-column
 * expressions degrade to NULL, which the report reads as `pre-p0`, never as success.
 *
 * @module scripts/lib/capture/completeness-queries
 */
import { many } from '../db/query.mjs';
import { isCloudEnabled } from '../store/repo.mjs';
import { strictColumnExists } from '../store/column-probes.mjs';

/** The synthetic canary's `purpose`: excluded from every figure so it can never pollute a population. */
export const CANARY_PURPOSE = 'capture-canary';

/**
 * One row per audit run in the window (code runs only: a plan audit has no per-pass call log).
 * Per-run call figures come from ONE aggregate subquery, so no join can multiply a count.
 * @param {{days: number, repo?: string|null, fn?: Function}} o
 */
export async function readAuditRuns({ days, repo = null, fn = many }) {
  const hasP0 = await strictColumnExists('llm_call_provenance', 'logical_call_id', fn, isCloudEnabled);
  const p0 = hasP0
    ? 'COUNT(DISTINCT logical_call_id)::int AS logical_calls, MAX(capture_schema_version) AS capture_schema_version'
    : '0 AS logical_calls, NULL::integer AS capture_schema_version';
  const sql = `
    SELECT r.id AS run_id, r.created_at AS started_at, repo.name AS repo,
           (SELECT COUNT(*)::int FROM llm_call_log_summary s WHERE s.audit_run_id = r.id) AS summaries,
           (SELECT COALESCE(SUM(recorded), 0)::int FROM llm_call_log_summary s WHERE s.audit_run_id = r.id) AS recorded,
           (SELECT COALESCE(SUM(dropped), 0)::int FROM llm_call_log_summary s WHERE s.audit_run_id = r.id) AS dropped,
           COALESCE(c.rows, 0) AS rows, COALESCE(c.logical_calls, 0) AS logical_calls, c.capture_schema_version
      FROM audit_runs r
      LEFT JOIN audit_repos repo ON repo.id = r.repo_id
      LEFT JOIN (
        SELECT audit_run_id, COUNT(*)::int AS rows, ${p0}
          FROM llm_call_provenance WHERE purpose IS DISTINCT FROM $3 GROUP BY audit_run_id
      ) c ON c.audit_run_id = r.id
     WHERE r.mode = 'code' AND r.created_at >= now() - ($1::int * interval '1 day')
       AND ($2::text IS NULL OR repo.name = $2)`;
  const runs = await fn(sql, [days, repo, CANARY_PURPOSE]);
  // Outcomes per run in a second, plain GROUP BY (a pre-P0 store has the column absent: none to read).
  const outcomes = hasP0
    ? await fn(`SELECT audit_run_id, attempt_outcome, COUNT(*)::int AS n FROM llm_call_provenance
                 WHERE purpose IS DISTINCT FROM $2 AND attempt_outcome IS NOT NULL
                   AND created_at >= now() - ($1::int * interval '1 day' + interval '1 day')
                 GROUP BY audit_run_id, attempt_outcome`, [days, CANARY_PURPOSE])
    : [];
  const byRun = new Map();
  for (const o of outcomes) {
    const m = byRun.get(o.audit_run_id) ?? {};
    m[o.attempt_outcome] = Number(o.n);
    byRun.set(o.audit_run_id, m);
  }
  return runs.map((r) => ({ ...r, outcomes: byRun.get(r.run_id) ?? {} }));
}

/** Ledger `task` rows (chip launches), each flagged by whether the work item has an `outcome` row. */
export async function readChipTasks({ days, repo = null, fn = many }) {
  return fn(`
    SELECT t.repo_name AS repo, t.work_item_id, t.event_at,
           (t.work_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM own_model_ledger o
              WHERE o.kind = 'outcome' AND o.work_item_id = t.work_item_id)) AS has_outcome
      FROM own_model_ledger t
     WHERE t.kind = 'task' AND t.event_at >= now() - ($1::int * interval '1 day')
       AND ($2::text IS NULL OR t.repo_name = $2)`, [days, repo]);
}

/** Ledger merged outcomes (fleet land): the only landing record there is. */
export async function readFleetMerges({ days, repo = null, fn = many }) {
  return fn(`
    SELECT repo_name AS repo, COUNT(*)::int AS merges
      FROM own_model_ledger
     WHERE kind = 'outcome' AND payload->>'kind' = 'merged' AND event_at >= now() - ($1::int * interval '1 day')
       AND ($2::text IS NULL OR repo_name = $2)
     GROUP BY repo_name`, [days, repo]);
}

/** Sum of per-call cost against the run-level estimate, over runs that HAVE call rows. */
export async function readCostFigures({ days, repo = null, fn = many }) {
  const rows = await fn(`
    WITH runs AS (
      SELECT r.id, r.total_cost_estimate FROM audit_runs r LEFT JOIN audit_repos repo ON repo.id = r.repo_id
       WHERE r.mode = 'code' AND r.created_at >= now() - ($1::int * interval '1 day') AND ($2::text IS NULL OR repo.name = $2)
         AND EXISTS (SELECT 1 FROM llm_call_provenance c WHERE c.audit_run_id = r.id AND c.producer = 'audit')
    ), calls AS (
      SELECT c.cost_usd FROM llm_call_provenance c JOIN runs ON runs.id = c.audit_run_id
       WHERE c.producer = 'audit' AND c.purpose IS DISTINCT FROM $3
    )
    SELECT (SELECT SUM(cost_usd) FROM calls) AS call_cost_usd,
           (SELECT SUM(total_cost_estimate) FROM runs) AS run_cost_usd,
           (SELECT COUNT(*)::int FROM calls) AS rows,
           (SELECT COUNT(cost_usd)::int FROM calls) AS priced_rows`, [days, repo, CANARY_PURPOSE]);
  return rows[0] ?? null;
}
