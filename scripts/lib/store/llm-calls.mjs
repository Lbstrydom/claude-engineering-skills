/**
 * @fileoverview The `audit.llmCalls` writer: per-LLM-call provenance rows and the
 * producing process's recorded/dropped counts
 * (docs/plans/own-model-telemetry-pr3.md decision 4).
 *
 * Idempotent by construction, which is what licenses a spill/replay: call rows are
 * `ON CONFLICT (call_id) DO NOTHING` (deterministic UUIDv5 identity) and the summary
 * row is keyed `(audit_run_id, producer, process_nonce)`, one per producing process,
 * so a second producer never overwrites the first's counts. Both land in ONE
 * transaction, so a summary can never claim rows that were not written.
 *
 * Receipt-shaped (`{applied, rows, reason?, error?}`) like its siblings.
 *
 * @module scripts/lib/store/llm-calls
 */
import { query, upsert, withTx, many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { strictColumnExists } from './column-probes.mjs';

let _warnedUnmigrated = false;

const INSERT_CALLS_SQL = `
  INSERT INTO llm_call_provenance
    (call_id, audit_run_id, repo_id, work_item_id, producer, purpose, model_resolved, route, prompt_hash, prompt_variant,
     temperature, reasoning_effort, input_tokens, cached_tokens, output_tokens, reasoning_tokens, latency_ms, cost_usd,
     truncated, retried, fallback, schema_version)
  SELECT call_id, audit_run_id, repo_id, work_item_id, producer, purpose, model_resolved, route, prompt_hash, prompt_variant,
         temperature, reasoning_effort, input_tokens, cached_tokens, output_tokens, reasoning_tokens, latency_ms, cost_usd,
         truncated, retried, fallback, schema_version
    FROM jsonb_to_recordset($1::jsonb) AS r(
      call_id uuid, audit_run_id uuid, repo_id uuid, work_item_id text, producer text, purpose text, model_resolved text,
      route text, prompt_hash text, prompt_variant text, temperature numeric, reasoning_effort text, input_tokens integer,
      cached_tokens integer, output_tokens integer, reasoning_tokens integer, latency_ms integer, cost_usd numeric,
      truncated boolean, retried boolean, fallback boolean, schema_version integer)
  ON CONFLICT (call_id) DO NOTHING`;

/**
 * @param {{runId: string, producer: string, nonce: string, rows: object[], recorded: number, dropped: number}} payload
 * @returns {Promise<{ok: boolean, applied: boolean, rows: number, reason?: string, error?: Error}>}
 */
export async function recordLlmCalls(payload) {
  const { runId, producer, nonce, rows = [], recorded = 0, dropped = 0 } = payload ?? {};
  if (!runId) return { ok: true, applied: false, rows: 0, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { ok: true, applied: false, rows: 0, reason: 'cloud-off' };
  if (!await strictColumnExists('llm_call_provenance', 'call_id', many, isCloudEnabled)) {
    if (!_warnedUnmigrated) {
      _warnedUnmigrated = true;
      process.stderr.write('  [llm-calls] store lacks 20261028120000 — LLM call provenance NOT persisted (setup-postgres.mjs --migrate)\n');
    }
    return { ok: true, applied: false, rows: 0, reason: 'store-not-migrated' };
  }
  try {
    const written = await withTx(async () => {
      let n = 0;
      if (rows.length) {
        // One statement over the whole batch; identity is the primary key, so a replay inserts nothing.
        const res = await query(INSERT_CALLS_SQL, [JSON.stringify(rows)]);
        n = res?.rowCount ?? 0;
      }
      await upsert('llm_call_log_summary', [{
        audit_run_id: runId, producer, process_nonce: nonce, recorded, dropped,
      }], { onConflict: ['audit_run_id', 'producer', 'process_nonce'], update: ['recorded', 'dropped'] });
      return n;
    });
    // A buffer that overflowed persisted only a SUBSET; the summary row keeps the truth (recorded/dropped)
    // and the orchestrator that drained the log marks the run incomplete when `dropped > 0`.
    return { ok: true, applied: true, rows: written };
  } catch (err) {
    return { ok: false, applied: false, rows: 0, error: err };
  }
}
