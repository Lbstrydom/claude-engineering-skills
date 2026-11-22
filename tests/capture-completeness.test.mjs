/**
 * Own-model full capture, P0: logical call ids, typed attempt outcomes, completeness reconciliation
 * and the canary (docs/plans/own-model-full-capture.md sections 2.9, 2.10).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from '../scripts/lib/telemetry/llm-call-log.mjs';
import { LlmError } from '../scripts/lib/robustness.mjs';
import { CAPTURE_SCHEMA_VERSION, ATTEMPT_OUTCOMES, attemptOutcomeForError } from '../scripts/lib/capture/schema-version.mjs';
import {
  judgeRun, reconcileAuditDispatch, reconcileChipLaunch, reconcileFleetLand, reconcileCost, exitCodeFor, IN_FLIGHT_GRACE_MS, CHIP_GRACE_MS,
} from '../scripts/lib/capture/completeness.mjs';
import { runCanary } from '../scripts/lib/capture/canary.mjs';
import { buildReport, renderReport } from '../scripts/capture-completeness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const OLD = '2026-11-20T00:00:00Z';

describe('attempt outcome vocabulary', () => {
  test('every mapped outcome is in the closed list, and an unknown failure is `error`', () => {
    const cats = ['truncated', 'incomplete', 'schema', 'empty', 'timeout', 'cancel', 'refusal', 'permanent', 'http-500', undefined];
    for (const c of cats) assert.ok(ATTEMPT_OUTCOMES.includes(attemptOutcomeForError(new LlmError('x', { category: c }))), String(c));
    assert.equal(attemptOutcomeForError(new LlmError('x', { category: 'schema' })), 'schema-reject');
    assert.equal(attemptOutcomeForError(new LlmError('x', { category: 'truncated' })), 'partial');
    assert.equal(attemptOutcomeForError(new LlmError('x', { category: 'empty' })), 'missing-payload');
    assert.equal(attemptOutcomeForError(null), 'error');
    assert.equal(attemptOutcomeForError({ name: 'AbortError' }), 'timeout');
  });
});

describe('llm-call-log: logical call + attempts', () => {
  const prev = process.env.LEARNING_DISABLE;
  beforeEach(() => { delete process.env.LEARNING_DISABLE; log._resetLlmCallLog(); });
  afterEach(() => { if (prev === undefined) delete process.env.LEARNING_DISABLE; else process.env.LEARNING_DISABLE = prev; log._resetLlmCallLog(); });

  test('three attempts of one logical call are three rows, one logical id, distinct call ids', () => {
    assert.ok(log.bindRun({ runId: RUN, producer: 'audit' }));
    const lid = log.beginLogicalCall();
    for (const [n, cat] of [[1, 'timeout'], [2, 'schema']]) {
      assert.ok(log.recordGptAttemptFailure({ err: new LlmError('x', { category: cat }), opts: { passName: 'p' }, model: 'gpt-x', logicalCallId: lid, attemptNo: n }));
    }
    assert.ok(log.recordGptCall({ result: { model: 'gpt-x', usage: { input_tokens: 1, output_tokens: 1 } }, opts: { passName: 'p' }, logicalCallId: lid, attemptNo: 3 }));
    const { rows, recorded } = log.drain();
    assert.equal(recorded, 3);
    assert.deepEqual(rows.map((r) => r.attempt_outcome), ['timeout', 'schema-reject', 'success']);
    assert.deepEqual(rows.map((r) => r.attempt_no), [1, 2, 3]);
    assert.equal(new Set(rows.map((r) => r.logical_call_id)).size, 1);
    assert.equal(rows[0].logical_call_id, lid);
    assert.equal(new Set(rows.map((r) => r.call_id)).size, 3);
    assert.ok(rows.every((r) => r.capture_schema_version === CAPTURE_SCHEMA_VERSION));
  });

  test('two logical calls get two ids; a failed attempt carries a retried flag only after the first', () => {
    log.bindRun({ runId: RUN, producer: 'audit' });
    const a = log.beginLogicalCall(); const b = log.beginLogicalCall();
    assert.notEqual(a, b);
    log.recordGptAttemptFailure({ err: new LlmError('x', { category: 'schema' }), opts: {}, model: 'm', logicalCallId: a, attemptNo: 1 });
    log.recordGptAttemptFailure({ err: new LlmError('x', { category: 'schema' }), opts: {}, model: 'm', logicalCallId: a, attemptNo: 2 });
    const { rows } = log.drain();
    assert.deepEqual(rows.map((r) => r.retried), [false, true]);
  });

  test('cost is priced from usage, and an unpriced model is null, never 0', () => {
    log.bindRun({ runId: RUN, producer: 'audit' });
    log.recordGptCall({ result: { model: 'no-such-model-zzz', usage: { input_tokens: 5, output_tokens: 5 } }, opts: {} });
    log.recordGptCall({ result: { model: 'gpt-5.4', usage: { input_tokens: 1000, output_tokens: 1000 } }, opts: {} });
    const { rows } = log.drain();
    assert.equal(rows[0].cost_usd, null);
    assert.ok(rows[1].cost_usd === null || rows[1].cost_usd > 0);
  });

  test('an unbound log records nothing and counts it; LEARNING_DISABLE=1 refuses to bind', () => {
    assert.equal(log.beginLogicalCall(), null);
    assert.equal(log.recordGptAttemptFailure({ err: new LlmError('x', { category: 'schema' }), opts: {}, model: 'm' }), false);
    process.env.LEARNING_DISABLE = '1';
    assert.equal(log.bindRun({ runId: RUN, producer: 'audit' }), false);
    assert.equal(log.drain(), null);
  });

  test('an attempt outcome outside the vocabulary is stored as `error`, never as the outside value', () => {
    log.bindRun({ runId: RUN, producer: 'audit' });
    log.record({ attemptOutcome: 'definitely-not-a-state' });
    assert.equal(log.drain().rows[0].attempt_outcome, 'error');
  });
});

describe('judgeRun / reconcileAuditDispatch', () => {
  const base = { started_at: OLD, summaries: 1, recorded: 5, dropped: 0, rows: 5 };
  test('verdicts', () => {
    assert.equal(judgeRun(base, NOW).verdict, 'reconciled');
    assert.equal(judgeRun({ ...base, rows: 3 }, NOW).verdict, 'gap');
    assert.equal(judgeRun({ ...base, rows: 3 }, NOW).missing, 2);
    assert.equal(judgeRun({ ...base, dropped: 2, rows: 3 }, NOW).verdict, 'dropped');
    assert.equal(judgeRun({ ...base, summaries: 0, recorded: 0, rows: 0 }, NOW).verdict, 'unmeasured');
    assert.equal(judgeRun({ ...base, summaries: 0, recorded: 0, rows: 4 }, NOW).verdict, 'unmeasured');
    assert.equal(judgeRun({ ...base, summaries: 0, recorded: 0, rows: 0, started_at: new Date(NOW - IN_FLIGHT_GRACE_MS + 60_000) }, NOW).verdict, 'in-flight');
  });

  test('a run with no summary and zero rows is UNMEASURED, never reconciled (zero starts judged is not 100%)', () => {
    const g = reconcileAuditDispatch([{ run_id: 'a', repo: 'r', started_at: OLD, summaries: 0, rows: 0 }], NOW);
    assert.equal(g[0].runs_by_verdict.reconciled, 0);
    assert.equal(g[0].status, 'partial:unmeasured-runs');
    assert.equal(exitCodeFor({ auditDispatch: [{ status: 'unmeasured:zero-judgeable-starts' }], chipLaunch: [] }), 3);
  });

  test('no runs at all gives an empty report that exits 3, never 0', () => {
    assert.deepEqual(reconcileAuditDispatch([], NOW), []);
    assert.equal(exitCodeFor({ auditDispatch: [], chipLaunch: [] }), 3);
  });

  test('groups by repo x schema version, never pooling; pre-P0 rows are labelled pre-p0', () => {
    const rows = [
      { run_id: '1', repo: 'r', capture_schema_version: 1, started_at: OLD, summaries: 1, recorded: 2, rows: 2, logical_calls: 1, outcomes: { success: 1, 'schema-reject': 1 } },
      { run_id: '2', repo: 'r', capture_schema_version: null, started_at: OLD, summaries: 1, recorded: 2, rows: 2, logical_calls: 0 },
      { run_id: '3', repo: 'r', capture_schema_version: 1, started_at: OLD, summaries: 1, recorded: 4, rows: 3, logical_calls: 2 },
    ];
    const g = reconcileAuditDispatch(rows, NOW);
    assert.deepEqual(g.map((x) => x.capture_schema_version), ['1', 'pre-p0']);
    const v1 = g[0];
    assert.equal(v1.starts, 2); assert.equal(v1.status, 'gap'); assert.equal(v1.missing_attempts, 1);
    assert.deepEqual(v1.gap_runs.map((x) => x.run_id), ['3']);
    assert.equal(v1.outcomes['schema-reject'], 1);
    assert.equal(exitCodeFor({ auditDispatch: g, chipLaunch: [] }), 1);
  });

  test('three retries of one logical call count as one logical call with three attempts', () => {
    const g = reconcileAuditDispatch([{ run_id: '1', repo: 'r', capture_schema_version: 1, started_at: OLD, summaries: 1, recorded: 3, rows: 3, logical_calls: 1 }], NOW)[0];
    assert.equal(g.logical_calls, 1); assert.equal(g.attempts, 3); assert.equal(g.status, 'ok');
  });

  test('a start whose call row is missing shows as a gap (the plan negative control)', () => {
    const g = reconcileAuditDispatch([{ run_id: '1', repo: 'r', capture_schema_version: 1, started_at: OLD, summaries: 1, recorded: 1, rows: 0, logical_calls: 0 }], NOW)[0];
    assert.equal(g.status, 'gap');
  });
});

describe('chip launch, fleet land, cost', () => {
  test('chip launch: completed, open, gap and uncorrelated are kept apart', () => {
    const young = new Date(NOW - CHIP_GRACE_MS + 3600_000).toISOString();
    const g = reconcileChipLaunch([
      { repo: 'r', work_item_id: 'wi-a', event_at: OLD, has_outcome: true },
      { repo: 'r', work_item_id: 'wi-b', event_at: young, has_outcome: false },
      { repo: 'r', work_item_id: 'wi-c', event_at: '2026-10-01T00:00:00Z', has_outcome: false },
      { repo: 'r', work_item_id: null, event_at: OLD, has_outcome: false },
    ], NOW)[0];
    assert.deepEqual([g.starts, g.completed, g.open, g.gaps, g.uncorrelated], [4, 1, 1, 1, 1]);
    assert.equal(g.status, 'gap');
  });

  test('fleet land is reported with starts and `unmeasured`, never a zero loss', () => {
    const g = reconcileFleetLand([{ repo: 'r', merges: 3 }])[0];
    assert.equal(g.starts, 3); assert.match(g.status, /^unmeasured:/);
  });

  test('cost: absent or zero side is unmeasured; within and outside tolerance are told apart', () => {
    assert.match(reconcileCost({ call_cost_usd: null, run_cost_usd: 1, rows: 3, priced_rows: 0 }).status, /^unmeasured/);
    assert.match(reconcileCost({ call_cost_usd: 1, run_cost_usd: 0, rows: 3, priced_rows: 3 }).status, /^unmeasured/);
    assert.match(reconcileCost(null).status, /^unmeasured/);
    assert.equal(reconcileCost({ call_cost_usd: 1.02, run_cost_usd: 1, rows: 3, priced_rows: 3 }).status, 'ok');
    assert.equal(reconcileCost({ call_cost_usd: 1.2, run_cost_usd: 1, rows: 3, priced_rows: 3 }).status, 'outside-tolerance');
  });
});

describe('report + render', () => {
  const queries = (runs, tasks = [], merges = [], cost = null) => ({
    readAuditRuns: async () => runs, readChipTasks: async () => tasks, readFleetMerges: async () => merges, readCostFigures: async () => cost,
  });
  test('an empty store reports unmeasured and exit 3 in text and structure', async () => {
    const r = await buildReport({ nowMs: NOW, deps: { queries: queries([]) } });
    assert.equal(r.exitCode, 3);
    assert.match(renderReport(r), /audit-dispatch: unmeasured:zero-starts/);
  });
  test('a clean measured run exits 0; a gap exits 1', async () => {
    const ok = { run_id: '1', repo: 'r', capture_schema_version: 1, started_at: OLD, summaries: 1, recorded: 1, rows: 1, logical_calls: 1 };
    assert.equal((await buildReport({ nowMs: NOW, deps: { queries: queries([ok]) } })).exitCode, 0);
    assert.equal((await buildReport({ nowMs: NOW, deps: { queries: queries([{ ...ok, rows: 0 }]) } })).exitCode, 1);
  });
});

describe('canary', () => {
  /** An in-memory stand-in for the store: the writer inserts, `many` reads back, `query` deletes. */
  function fakeStore({ refuse = false } = {}) {
    const rows = []; const sums = [];
    return {
      write: async (p) => {
        if (refuse || p.rows.some((r) => r.producer !== 'audit')) return { ok: false, applied: false, rows: 0, error: new Error('check violation') };
        rows.push(...p.rows); sums.push({ audit_run_id: p.runId, recorded: p.recorded, dropped: p.dropped });
        return { ok: true, applied: true, rows: p.rows.length };
      },
      db: {
        many: async (sql, [id]) => (/llm_call_log_summary/.test(sql) ? sums.filter((s) => s.audit_run_id === id)
          : rows.filter((r) => r.audit_run_id === id).sort((a, b) => a.attempt_no - b.attempt_no)),
        query: async (sql, [id]) => { for (const arr of [rows, sums]) for (let i = arr.length - 1; i >= 0; i--) if (arr[i].audit_run_id === id) arr.splice(i, 1); },
      },
      rows, sums,
    };
  }
  const prev = process.env.LEARNING_DISABLE;
  beforeEach(() => { delete process.env.LEARNING_DISABLE; });
  afterEach(() => { if (prev === undefined) delete process.env.LEARNING_DISABLE; else process.env.LEARNING_DISABLE = prev; });

  test('passes through the real pipeline and leaves nothing behind', async () => {
    const s = fakeStore();
    const out = await runCanary({ deps: { write: s.write, db: s.db } });
    assert.equal(out.result, 'ok', JSON.stringify(out.checks.filter((c) => !c.ok)));
    assert.equal(s.rows.length, 0); assert.equal(s.sums.length, 0);
  });

  test('NEGATIVE CONTROL: a broken write makes the canary fail', async () => {
    const s = fakeStore();
    const out = await runCanary({ breakWrite: true, deps: { write: s.write, db: s.db } });
    assert.equal(out.result, 'failed');
    assert.ok(out.checks.some((c) => !c.ok && c.name === 'write applied'));
  });

  test('a refused write fails; a store that cannot be reached is unmeasured, never ok', async () => {
    assert.equal((await runCanary({ deps: { write: fakeStore({ refuse: true }).write, db: fakeStore().db } })).result, 'failed');
    const cloudOff = await runCanary({ deps: { write: async () => ({ ok: true, applied: false, rows: 0, reason: 'cloud-off' }), db: fakeStore().db } });
    assert.equal(cloudOff.result, 'unmeasured:cloud-off');
    const unmigrated = await runCanary({ deps: { write: async () => ({ ok: true, applied: false, rows: 0, reason: 'store-not-migrated' }), db: fakeStore().db } });
    assert.equal(unmigrated.result, 'unmeasured:store-not-migrated');
  });

  test('a writer that drops the typed columns (the legacy insert) is caught on read-back', async () => {
    const s = fakeStore();
    const legacy = async (p) => s.write({ ...p, rows: p.rows.map(({ attempt_outcome, logical_call_id, attempt_no, capture_schema_version, ...r }) => r) });
    assert.equal((await runCanary({ deps: { write: legacy, db: s.db } })).result, 'failed');
  });

  test('LEARNING_DISABLE=1 turns the canary off', async () => {
    process.env.LEARNING_DISABLE = '1';
    assert.equal((await runCanary({ deps: {} })).result, 'disabled');
  });
});

describe('CLI contract', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'capture-completeness.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
  test('--selfcheck-relocation prints OK', () => {
    const r = run(['--selfcheck-relocation']);
    assert.equal(r.status, 0); assert.match(r.stdout, /OK/);
  });
  test('an unknown flag and a missing verb exit 2', () => {
    assert.equal(run(['report', '--nonsense']).status, 2);
    assert.equal(run([]).status, 2);
  });
  test('canary under LEARNING_DISABLE=1 exits 0 with result disabled', () => {
    const r = run(['canary'], { LEARNING_DISABLE: '1' });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).result, 'disabled');
  });
});
