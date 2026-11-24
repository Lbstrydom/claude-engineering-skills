/**
 * @fileoverview The `audit.llmCalls` writer: per-LLM-call provenance rows and the
 * producing process's recorded/dropped counts
 * (docs/plans/own-model-telemetry-pr3.md decision 4).
 *
 * Idempotent by construction, which is what licenses a spill/replay: call rows are
 * `ON CONFLICT (call_id)` (deterministic UUIDv5 identity; an existing NULL P0/tree column is filled on replay, nothing else is touched) and the summary
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
let _warnedDegraded = false;

/** PURE. The capture fields the supplied rows carry that an older column tier would silently drop. */
export function droppedFieldsFor(rows, { hasP0, hasTree, hasPricing = false }) {
  const carries = (cols) => cols.filter((c) => rows.some((r) => r?.[c] != null));
  return [
    ...(hasP0 ? [] : carries(P0_COLS.map(([n]) => n))),
    ...(hasTree ? [] : carries(TREE_COLS.map(([n]) => n))),
    ...(hasPricing ? [] : carries(PRICING_COLS.map(([n]) => n))),
  ];
}

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
// 20261124120000: the price table a row's cost_usd came from.
const PRICING_COLS = [['pricing_version', 'text']];
const FILLABLE = [...P0_COLS, ...TREE_COLS, ...PRICING_COLS];

/** PURE. The batch insert for a column set; identity is the primary key, so a replay inserts nothing. */
export function buildInsertCallsSql(cols) {
  const names = cols.map(([n]) => n).join(', ');
  const defs = cols.map(([n, ty]) => `${n} ${ty}`).join(', ');
  // A replay after a migration must restore what an older-tier insert dropped: for the P0/tree columns an existing NULL is
  // filled from the replayed value. A replay that has nothing to add updates no row, so it still inserts and updates 0.
  const fill = cols.map(([n]) => n).filter((n) => FILLABLE.some(([c]) => c === n));
  const conflict = fill.length
    ? `DO UPDATE SET ${fill.map((c) => `${c} = COALESCE(llm_call_provenance.${c}, EXCLUDED.${c})`).join(', ')}
    WHERE ${fill.map((c) => `(llm_call_provenance.${c} IS NULL AND EXCLUDED.${c} IS NOT NULL)`).join(' OR ')}`
    : 'DO NOTHING';
  return `
  INSERT INTO llm_call_provenance (${names})
  SELECT ${names}
    FROM jsonb_to_recordset($1::jsonb) AS r(${defs})
  ON CONFLICT (call_id) ${conflict}`;
}

const INSERT_CALLS_SQL = buildInsertCallsSql(BASE_COLS);
const INSERT_CALLS_P0_SQL = buildInsertCallsSql([...BASE_COLS, ...P0_COLS]);
const INSERT_CALLS_TREE_SQL = buildInsertCallsSql([...BASE_COLS, ...P0_COLS, ...TREE_COLS]);
const INSERT_CALLS_PRICING_SQL = buildInsertCallsSql([...BASE_COLS, ...P0_COLS, ...TREE_COLS, ...PRICING_COLS]);

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
  // Rows must belong to the run and producer the summary is keyed on: a mismatch would attribute calls to the wrong run.
  const stray = rows.find((r) => r?.audit_run_id !== runId || r?.producer !== producer);
  if (stray) return { ok: false, applied: false, rows: 0, error: new Error(`llm-calls: row ${stray.call_id} is for run ${stray.audit_run_id}/${stray.producer}, payload is ${runId}/${producer}`) };
  try {
    const hasP0 = await strictColumnExists('llm_call_provenance', 'logical_call_id', many, isCloudEnabled);
    const hasTree = hasP0 && await strictColumnExists('llm_call_provenance', 'audited_tree', many, isCloudEnabled);
    const hasPricing = hasTree && await strictColumnExists('llm_call_provenance', 'pricing_version', many, isCloudEnabled);
    const written = await withTx(async () => {
      let n = 0;
      if (rows.length) {
        // One statement over the whole batch; identity is the primary key, so a replay inserts nothing.
        const res = await query(hasPricing ? INSERT_CALLS_PRICING_SQL : hasTree ? INSERT_CALLS_TREE_SQL : hasP0 ? INSERT_CALLS_P0_SQL : INSERT_CALLS_SQL, [JSON.stringify(rows)]);
        n = res?.rowCount ?? 0;
      }
      await upsert('llm_call_log_summary', [{
        audit_run_id: runId, producer, process_nonce: nonce, recorded, dropped,
      }], { onConflict: ['audit_run_id', 'producer', 'process_nonce'], update: ['recorded', 'dropped'] });
      return n;
    });
    // A buffer that overflowed persisted only a SUBSET; the summary row keeps the truth (recorded/dropped)
    // and the orchestrator that drained the log marks the run incomplete when `dropped > 0`.
    // A store behind the P0 migrations still gets its rows, but the fields its schema cannot hold are DROPPED, and the
    // replay key (call_id) means a later migration cannot restore them. Say so in the receipt and on stderr: never a clean ok.
    const dropped_fields = droppedFieldsFor(rows, { hasP0, hasTree, hasPricing });
    if (dropped_fields.length) {
      if (!_warnedDegraded) {
        _warnedDegraded = true;
        process.stderr.write(`  [llm-calls] store lacks migration 20261123120000/20261123140000/20261124120000 — DROPPED from call provenance: ${dropped_fields.join(', ')} (setup-postgres.mjs --migrate)
`);
      }
      return { ok: true, applied: true, rows: written, degraded: `columns-missing:${dropped_fields.join(',')}` };
    }
    return { ok: true, applied: true, rows: written };
  } catch (err) {
    return { ok: false, applied: false, rows: 0, error: err };
  }
}
