/**
 * @fileoverview P0 part 2 of docs/plans/own-model-full-capture.md, pure seams: per-call tree identity,
 * work-item resolution, bake-off identity from the snapshot, the column-tiered writer SQL, the dashboard
 * panel and the canary's tree check. The DB-backed half is tests/own-model-capture-p0-db.test.mjs.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { bindRun, record, drain, beginLogicalCall, _resetLlmCallLog } from '../scripts/lib/telemetry/llm-call-log.mjs';
import { resolveWorkItemId, mintWorkItemId } from '../scripts/lib/ledger/work-item.mjs';
import { identityFromTranscript, readSnapshotIdentity } from '../scripts/lib/bakeoff/snapshot-identity.mjs';
import { buildInsertCallsSql, droppedFieldsFor } from '../scripts/lib/store/llm-calls.mjs';
import sectionCaptureCompleteness, { statusClass } from '../scripts/lib/dashboard/sections/capture-completeness.mjs';
import { runCanary } from '../scripts/lib/capture/canary.mjs';

const RUN = '11111111-1111-4111-8111-111111111111';
const TREE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

describe('per-call tree identity', () => {
  const prev = process.env.LEARNING_DISABLE;
  beforeEach(() => { delete process.env.LEARNING_DISABLE; _resetLlmCallLog(); });
  afterEach(() => { if (prev === undefined) delete process.env.LEARNING_DISABLE; else process.env.LEARNING_DISABLE = prev; });

  test('every attempt row carries the bound tree and diff base', () => {
    assert.equal(bindRun({ runId: RUN, producer: 'audit', auditedTree: TREE, diffBaseSha: BASE }), true);
    beginLogicalCall();
    record({ purpose: 'a' }); record({ purpose: 'b' });
    const rows = drain().rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.audited_tree === TREE && r.diff_base_sha === BASE));
  });

  test('NEGATIVE CONTROL: an unbound identity is null, and a non-oid value is refused rather than stored', () => {
    bindRun({ runId: RUN, producer: 'audit', auditedTree: 'a'.repeat(41), diffBaseSha: 'not a sha' });
    record({ purpose: 'a' });
    const [r] = drain().rows;
    assert.equal(r.audited_tree, null);
    assert.equal(r.diff_base_sha, null);
  });
});

describe('resolveWorkItemId', () => {
  const wi = mintWorkItemId();
  test('env wins, then the wi- branch segment, never a guess', () => {
    assert.equal(resolveWorkItemId({ env: { OWN_MODEL_WORK_ITEM_ID: wi }, branch: null }), wi);
    assert.equal(resolveWorkItemId({ env: {}, branch: `claude/wi-${wi}` }), wi);
    assert.equal(resolveWorkItemId({ env: {}, branch: 'claude/ces-own-model-p0b-c1973f' }), null);
    assert.equal(resolveWorkItemId({ env: {}, branch: null }), null);
  });
  test('a malformed env value does not fall through to the branch, and says so', () => {
    assert.equal(resolveWorkItemId({ env: { OWN_MODEL_WORK_ITEM_ID: 'oops' }, branch: `wi-${wi}` }), null);
  });
});

describe('bake-off identity comes from the snapshot', () => {
  test('the newest round carrying an identity wins; none means absent, never the working tree', () => {
    const t = { rounds: [{ _auditedTree: 'c'.repeat(40), _auditedSha: 'd'.repeat(40) }, { _auditedTree: TREE, _auditedSha: BASE }] };
    assert.deepEqual(identityFromTranscript(t), { auditedSha: BASE, auditedTree: TREE, source: 'snapshot' });
    // NEGATIVE CONTROL: the newest round carries none, so an OLDER round's identity is never borrowed.
    assert.equal(identityFromTranscript({ rounds: [...t.rounds, { round: 3 }] }).source, 'absent');
    // Git object ids are 40 or 64 hex chars: 41 is not one.
    assert.equal(identityFromTranscript({ rounds: [{ _auditedTree: 'a'.repeat(41) }] }).source, 'absent');
    assert.deepEqual(identityFromTranscript({ rounds: [{ round: 1 }] }), { auditedSha: null, auditedTree: null, source: 'absent' });
    assert.equal(identityFromTranscript(null).source, 'absent');
    assert.equal(identityFromTranscript({ rounds: [{ _auditedTree: 'nope' }] }).source, 'absent');
  });
  test('an unreadable transcript is absent, not a throw', () => {
    const r = readSnapshotIdentity('/no/such/transcript.json');
    assert.equal(r.source, 'unreadable');
    assert.ok(r.error);
  });
});

describe('writer column tiers', () => {
  test('a store behind the migrations is told, not silently trimmed: dropped fields are named', () => {
    const rows = [{ logical_call_id: 'x', audited_tree: TREE, diff_base_sha: null }];
    assert.deepEqual(droppedFieldsFor(rows, { hasP0: true, hasTree: true }), []);
    assert.deepEqual(droppedFieldsFor(rows, { hasP0: true, hasTree: false }), ['audited_tree']);
    assert.deepEqual(droppedFieldsFor(rows, { hasP0: false, hasTree: false }), ['logical_call_id', 'audited_tree']);
    assert.deepEqual(droppedFieldsFor([{ call_id: 'y' }], { hasP0: false, hasTree: false }), [], 'nothing carried, nothing dropped');
  });
  test('the tree tier names both new columns; the older tiers never do', () => {
    const tree = buildInsertCallsSql([['call_id', 'uuid'], ['audited_tree', 'text'], ['diff_base_sha', 'text']]);
    assert.match(tree, /audited_tree text, diff_base_sha text/);
    assert.doesNotMatch(buildInsertCallsSql([['call_id', 'uuid']]), /audited_tree/);
    assert.match(tree, /ON CONFLICT \(call_id\) DO UPDATE SET audited_tree = COALESCE\(llm_call_provenance\.audited_tree, EXCLUDED\.audited_tree\)/);
    assert.match(tree, /WHERE \(\(llm_call_provenance\.audited_tree IS NULL AND EXCLUDED\.audited_tree IS NOT NULL\) OR /);
    assert.match(buildInsertCallsSql([['call_id', 'uuid']]), /ON CONFLICT \(call_id\) DO NOTHING/, 'the base tier has nothing to backfill');
  });
  // Field report 5 (2026-11-23): the P0 plan listed pricing_version beside cost_usd, but no migration or writer had it.
  test('the pricing tier backfills pricing_version on replay; a store without it is told it was dropped', () => {
    const pricing = buildInsertCallsSql([['call_id', 'uuid'], ['audit_run_id', 'uuid'], ['cost_usd', 'numeric'], ['pricing_version', 'text']]);
    assert.match(pricing, /THEN COALESCE\(llm_call_provenance\.pricing_version, EXCLUDED\.pricing_version\) ELSE llm_call_provenance\.pricing_version END/);
    // Only beside the same, non-null stored cost; only on the same run.
    assert.match(pricing, /llm_call_provenance\.cost_usd IS NOT NULL AND llm_call_provenance\.cost_usd = EXCLUDED\.cost_usd/);
    assert.match(pricing, /WHERE llm_call_provenance\.audit_run_id = EXCLUDED\.audit_run_id AND \(/);
    const rows = [{ audited_tree: TREE, pricing_version: '2026-09-23' }];
    assert.deepEqual(droppedFieldsFor(rows, { hasP0: true, hasTree: true, hasPricing: false }), ['pricing_version']);
    assert.deepEqual(droppedFieldsFor(rows, { hasP0: true, hasTree: true, hasPricing: true }), []);
  });
});

describe('pricing_version rides beside cost_usd', () => {
  beforeEach(() => _resetLlmCallLog());
  afterEach(() => _resetLlmCallLog());
  test('a priced call carries the price table version; an unpriced one carries neither (never a version without a cost)', async () => {
    const { recordGptCall, recordGptAttemptFailure } = await import('../scripts/lib/telemetry/llm-call-log.mjs');
    const { PRICING_VERSION, costFromUsage } = await import('../scripts/lib/model-pricing.mjs');
    assert.ok(costFromUsage({ input_tokens: 1000, output_tokens: 1000 }, 'gpt-5.4').totalUsd > 0, 'vacuous-pass guard: the model must be priced');
    assert.ok(bindRun({ runId: '11111111-1111-4111-8111-111111111111', producer: 'audit' }));
    recordGptCall({ result: { model: 'gpt-5.4', usage: { input_tokens: 1000, output_tokens: 1000 } }, opts: {} });
    recordGptCall({ result: { model: 'no-such-model-zzz', usage: { input_tokens: 5, output_tokens: 5 } }, opts: {} });
    recordGptAttemptFailure({ err: { llmUsage: { input_tokens: 1000, output_tokens: 10 } }, opts: {}, model: 'gpt-5.4' });
    record({ purpose: 'x', model: 'm', costUsd: null, pricingVersion: PRICING_VERSION });
    const { rows } = drain();
    assert.deepEqual(rows.map((r) => [r.cost_usd > 0, r.pricing_version]), [
      [true, PRICING_VERSION], [false, null], [true, PRICING_VERSION], [false, null],
    ]);
  });
});

describe('capture-completeness dashboard panel', () => {
  const ui = {
    NON_OK: new Set(['unexpected-error']),
    escapeHtml: (s) => String(s), warningPanel: () => 'WARN', emptyPanel: (_i, m) => `EMPTY:${m}`,
  };
  const base = { cloud: true, windowDays: 7, cost: 'ok', captureSchemaVersion: 1, groups: [] };
  test('unmeasured is never rendered as ok', () => {
    assert.equal(statusClass('ok'), 'ok');
    assert.notEqual(statusClass('unmeasured:zero-starts'), 'ok');
    assert.notEqual(statusClass('partial:x'), 'ok');
    const html = sectionCaptureCompleteness({ src: { status: 'ok' }, captureCompleteness: { ...base, exitCode: 3 } }, ui);
    assert.match(html, /UNMEASURED/);
    assert.doesNotMatch(html, /class="ok"/);
  });
  test('cloud off or a failing collector never reads as a clean measurement', () => {
    assert.match(sectionCaptureCompleteness({ src: { status: 'missing-optional' }, captureCompleteness: null }, ui), /^EMPTY/);
    assert.equal(sectionCaptureCompleteness({ src: { status: 'unexpected-error' }, captureCompleteness: null }, ui), 'WARN');
  });
});

describe('canary tree identity', () => {
  test('a writer that drops the tree columns is caught on read-back', async () => {
    const rows = []; const sums = [];
    const write = async (p) => {
      rows.push(...p.rows.map(({ audited_tree, diff_base_sha, ...r }) => r)); sums.push({ audit_run_id: p.runId, recorded: p.recorded, dropped: p.dropped });
      return { ok: true, applied: true, rows: p.rows.length };
    };
    const db = {
      many: async (sql, [id]) => (/llm_call_log_summary/.test(sql) ? sums.filter((s) => s.audit_run_id === id) : rows.filter((r) => r.audit_run_id === id).sort((a, b) => a.attempt_no - b.attempt_no)),
      query: async (_s, [id]) => { for (const arr of [rows, sums]) for (let i = arr.length - 1; i >= 0; i--) if (arr[i].audit_run_id === id) arr.splice(i, 1); },
    };
    const out = await runCanary({ deps: { write, db } });
    assert.equal(out.result, 'failed');
    assert.ok(out.checks.some((c) => !c.ok && c.name === 'tree identity stamped on every attempt'));
  });
});

describe('capture-completeness flush-ledger', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/capture-completeness.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  test('LEARNING_DISABLE=1 turns it off (exit 0, disabled)', () => {
    const r = run(['flush-ledger'], { LEARNING_DISABLE: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"result":\s*"disabled"/);
  });
  test('it accepts no flags: an unknown flag is refused, never ignored', () => {
    assert.notEqual(run(['flush-ledger', '--days', '3'], { LEARNING_DISABLE: '1' }).status, 0);
  });
});

describe('final-review tree comes from the review input', () => {
  test('the transcript newest round names the tree; anything else is null, never the working tree', async () => {
    const { reviewedTreeFromTranscript } = await import('../scripts/lib/telemetry/final-review-call.mjs');
    assert.equal(reviewedTreeFromTranscript(JSON.stringify({ rounds: [{ _auditedTree: BASE }, { _auditedTree: TREE }] })), TREE);
    assert.equal(reviewedTreeFromTranscript(JSON.stringify({ rounds: [{ _auditedTree: TREE }, {}] })), null);
    assert.equal(reviewedTreeFromTranscript('not json'), null);
    assert.equal(reviewedTreeFromTranscript({ rounds: [{ _auditedTree: 'a'.repeat(41) }] }), null);
  });
});
