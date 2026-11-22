/**
 * @fileoverview The end-to-end capture canary (docs/plans/own-model-full-capture.md section 2.9,
 * phase P0). One synthetic logical call with TWO attempts (a schema-reject then a success) goes
 * through the REAL metadata pipeline (`beginLogicalCall` -> `recordGptAttemptFailure` / `recordGptCall`
 * -> `drain` -> the `audit.llmCalls` writer) into the store, is read BACK, and is checked: attempt
 * count, shared logical id, attempt numbers, typed outcomes, schema version, summary counter. It is then
 * deleted, so it never joins a population.
 *
 * A canary that cannot reach the store is `unmeasured`, never green. Its negative control is a
 * deliberately broken write (`breakWrite`): the canary must then FAIL.
 *
 * @module scripts/lib/capture/canary
 */
import crypto from 'node:crypto';
import { CAPTURE_SCHEMA_VERSION, CANARY_PURPOSE } from './schema-version.mjs';
import { LlmError } from '../robustness.mjs';

/** Closed results. Only `ok` and `disabled` exit 0. */
export const CANARY_RESULTS = Object.freeze(['ok', 'failed', 'unmeasured:cloud-off', 'unmeasured:store-not-migrated', 'disabled']);

/**
 * @param {{breakWrite?: boolean, deps?: object}} [o] `deps` is the test seam: log, write, db {many, query}
 * @returns {Promise<{result: string, checks: Array<{name: string, ok: boolean, detail?: string}>}>}
 */
export async function runCanary({ breakWrite = false, deps = {} } = {}) {
  if (process.env.LEARNING_DISABLE === '1') return { result: 'disabled', checks: [] };
  const log = deps.log ?? await import('../telemetry/llm-call-log.mjs');
  const { many, query } = deps.db ?? await import('../db/query.mjs');
  const write = deps.write ?? (await import('../store/llm-calls.mjs')).recordLlmCalls;
  const runId = crypto.randomUUID();
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail: String(detail) }) });
  try {
    log._resetLlmCallLog();
    if (!log.bindRun({ runId, producer: 'audit' })) return { result: 'failed', checks: [{ name: 'bind', ok: false, detail: 'bindRun refused' }] };
    const logicalCallId = log.beginLogicalCall();
    const opts = { passName: CANARY_PURPOSE };
    log.recordGptAttemptFailure({
      err: new LlmError('canary schema violation', { category: 'schema', usage: { input_tokens: 10, output_tokens: 1 } }),
      opts, model: 'canary-model', logicalCallId, attemptNo: 1, latencyMs: 5,
    });
    log.recordGptCall({
      result: { model: 'canary-model', usage: { input_tokens: 10, cached_tokens: 0, output_tokens: 5, reasoning_tokens: 0 }, latencyMs: 7 },
      opts: { ...opts, system: 'capture canary' }, logicalCallId, attemptNo: 2,
    });
    const drained = log.drain();
    check('drained two attempts', drained?.rows?.length === 2, drained?.rows?.length);
    if (!drained) return { result: 'failed', checks };
    // Negative control: a row the store must refuse (the producer CHECK). The canary has to FAIL on it.
    if (breakWrite) drained.rows = drained.rows.map((r) => ({ ...r, producer: 'not-a-producer' }));
    const receipt = await write({ ...drained, runId });
    if (receipt.reason === 'cloud-off' || receipt.reason === 'no-run-id') return { result: 'unmeasured:cloud-off', checks };
    if (receipt.reason === 'store-not-migrated') return { result: 'unmeasured:store-not-migrated', checks };
    check('write applied', receipt.ok && receipt.applied, receipt.error?.message ?? receipt.reason);
    const rows = await many(
      'SELECT call_id, logical_call_id, attempt_no, attempt_outcome, capture_schema_version FROM llm_call_provenance WHERE audit_run_id = $1 ORDER BY attempt_no',
      [runId]);
    check('read back two rows', rows.length === 2, rows.length);
    check('one logical call', new Set(rows.map((r) => r.logical_call_id)).size === 1 && rows[0]?.logical_call_id === logicalCallId);
    check('attempt numbers 1 and 2', rows.map((r) => Number(r.attempt_no)).join(',') === '1,2', rows.map((r) => r.attempt_no).join(','));
    check('two distinct attempt ids', new Set(rows.map((r) => r.call_id)).size === 2);
    check('typed outcomes', rows[0]?.attempt_outcome === 'schema-reject' && rows[1]?.attempt_outcome === 'success', rows.map((r) => r.attempt_outcome).join(','));
    check('schema version stamped', rows.length > 0 && rows.every((r) => r.capture_schema_version === CAPTURE_SCHEMA_VERSION));
    const sum = await many('SELECT recorded, dropped FROM llm_call_log_summary WHERE audit_run_id = $1', [runId]);
    check('summary counter matches', sum.length === 1 && Number(sum[0].recorded) === 2 && Number(sum[0].dropped) === 0);
  } catch (err) {
    check('canary threw', false, err?.message ?? err);
  } finally {
    try {   // never leave the synthetic run in the store; a failed cleanup is itself a failed check
      await query('DELETE FROM llm_call_provenance WHERE audit_run_id = $1', [runId]);
      await query('DELETE FROM llm_call_log_summary WHERE audit_run_id = $1', [runId]);
      const left = await many('SELECT audit_run_id FROM llm_call_provenance WHERE audit_run_id = $1', [runId]);
      const leftSum = await many('SELECT audit_run_id FROM llm_call_log_summary WHERE audit_run_id = $1', [runId]);
      check('cleanup removed every canary row', left.length === 0 && leftSum.length === 0, `${left.length}+${leftSum.length} left`);
    } catch (err) { check('cleanup', false, err?.message ?? err); }
    try { log._resetLlmCallLog(); } catch { /* ignore */ }
  }
  return { result: checks.every((c) => c.ok) ? 'ok' : 'failed', checks };
}
