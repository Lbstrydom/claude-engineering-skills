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

// Column tiers by migration. A store that has not applied a newer migration keeps the older insert: an
// older store must never lose its call rows because a newer column is absent.
const BASE_COLS = [
  ['call_id', 'uuid'], ['audit_run_id', 'uuid'], ['repo_id', 'uuid'], ['work_item_id', 'text'], ['producer', 'text'],
  ['purpose', 'text'], ['model_resolved', 'text'], ['route', 'text'], ['prompt_hash', 'text'], ['prompt_variant', 'text'],
  ['temperature', 'numeric'], ['reasoning_effort', 'text'], ['input_tokens', 'integer'], ['cached_tokens', 'integer'],
  ['output_tokens', 'integer'], ['reasoning_tokens', 'integer'], ['latency_ms', 'integer'], ['cost_usd', 'numeric'],
  ['truncated', 'boolean'], ['retried', 'boolean'], ['fallback', 'boolean'], ['schema_version', 'integer'],
];
// 20261123120000: per-attempt identity.
const P0_COLS = [['logical_call_id', 'uuid'], ['attempt_no', 'integer'], ['attempt_outcome', 'text'], ['capture_schema_version', 'integer']];
// 20261123140000: per-call tree identity.
const TREE_COLS = [['audited_tree', 'text'], ['diff_base_sha', 'text']];

/** PURE. The batch insert for a column set; identity is the primary key, so a replay inserts nothing. */
export function buildInsertCallsSql(cols) {
  const names = cols.map(([n]) => n).join(', ');
  const defs = cols.map(([n, ty]) => `${n} ${ty}`).join(', ');
  return `
  INSERT INTO llm_call_provenance (${names})
  SELECT ${names}
    FROM jsonb_to_recordset($1::jsonb) AS r(${defs})
  ON CONFLICT (call_id) DO NOTHING`;
}

const INSERT_CALLS_SQL = buildInsertCallsSql(BASE_COLS);
const INSERT_CALLS_P0_SQL = buildInsertCallsSql([...BASE_COLS, ...P0_COLS]);
const INSERT_CALLS_TREE_SQL = buildInsertCallsSql([...BASE_COLS, ...P0_COLS, ...TREE_COLS]);

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
    const hasP0 = await strictColumnExists('llm_call_provenance', 'logical_call_id', many, isCloudEnabled);
    const hasTree = hasP0 && await strictColumnExists('llm_call_provenance', 'audited_tree', many, isCloudEnabled);
    const written = await withTx(async () => {
      let n = 0;
      if (rows.length) {
        // One statement over the whole batch; identity is the primary key, so a replay inserts nothing.
        const res = await query(hasTree ? INSERT_CALLS_TREE_SQL : hasP0 ? INSERT_CALLS_P0_SQL : INSERT_CALLS_SQL, [JSON.stringify(rows)]);
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
