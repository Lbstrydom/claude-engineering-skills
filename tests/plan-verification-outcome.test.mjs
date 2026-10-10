/**
 * @fileoverview `ux-lock-run.mjs verify` — the recording step's wiring and its
 * exit code (upstream report 512cf1c9).
 *
 * The reported defect had two halves. The SQL half is proven against Postgres
 * in `tests/plan-verification-items-db.test.mjs`. This file is the other half:
 * `cmdVerify` called the items writer, DISCARDED its result, and emitted
 * `ok: true` + exit 0 — so four consecutive consumer runs looked successful
 * while recording no criteria. A test of the ok/exit decision alone could pass
 * with the result still discarded, so these drive `persistAndReportVerify`, the
 * function `cmdVerify` delegates to, with injected writers, and assert what the
 * CLI would emit and exit with.
 *
 * @module tests/plan-verification-outcome
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  persistAndReportVerify, verifyPersistOutcome, VERIFY_PERSIST_FAILED_EXIT,
} from '../scripts/ux-lock-run.mjs';

const ITEMS = [
  { criterionHash: 'h0', criterionIndex: 0, severity: 'P0', category: 'other', description: 'a', passed: true, errorMessage: null, durationMs: 5 },
  { criterionHash: 'h1', criterionIndex: 1, severity: 'P1', category: 'other', description: 'b', passed: false, errorMessage: 'boom', durationMs: 7 },
  { criterionHash: 'h2', criterionIndex: 2, severity: 'P1', category: 'other', description: 'c', passed: false, errorMessage: 'skipped', durationMs: 0 },
];

/** Writers that record their calls and return canned results. */
function writers({ run = { ok: true, cloud: true, runId: 'run-1' }, items = { ok: true, inserted: 3 } } = {}) {
  const calls = { run: [], items: [] };
  return {
    calls,
    writers: {
      recordPlanVerificationRun: async (arg) => { calls.run.push(arg); return typeof run === 'function' ? run() : run; },
      recordPlanVerificationItems: async (...args) => { calls.items.push(args); return typeof items === 'function' ? items() : items; },
    },
  };
}

const call = (over = {}, w = writers()) => persistAndReportVerify({
  items: ITEMS, orphanTests: ['orphan'], policyTotal: 0, cloud: true, planId: 'plan-1',
  commit: 'abc', url: 'http://localhost', writers: w.writers, ...over,
});

/** Every failure path must still carry the full report. */
function assertReportComplete(envelope) {
  assert.equal(envelope.mode, 'verify');
  assert.equal(envelope.totalCriteria, 3);
  assert.equal(envelope.passedCount, 1);
  assert.equal(envelope.failedCount, 1);
  assert.equal(envelope.skippedCount, 1);
  assert.equal(envelope.orphanTests, 1);
  assert.equal(envelope.items.length, 3);
}

describe('persistAndReportVerify — the recording step of ux-lock-run verify', () => {
  it('both writes succeed → ok, exit 0, and the items writer got the RUN id', async () => {
    const w = writers();
    const { envelope, exitCode } = await call({}, w);
    assert.equal(exitCode, 0);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.runId, 'run-1');
    assert.equal(envelope.itemsInserted, 3);
    assert.equal(envelope.error, undefined);
    assert.equal(w.calls.items.length, 1);
    assert.deepEqual(w.calls.items[0].slice(0, 2), ['run-1', 'plan-1']);
    assert.equal(w.calls.items[0][2], ITEMS);
    assertReportComplete(envelope);
  });

  it('the items write FAILS → ok:false, PERSIST_FAILED, exit 4 (the reported defect)', async () => {
    const w = writers({ items: { ok: false, inserted: 0, reason: 'column "run_id" is of type uuid but expression is of type text' } });
    const { envelope, exitCode } = await call({}, w);
    assert.equal(exitCode, VERIFY_PERSIST_FAILED_EXIT);
    assert.equal(exitCode, 4);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'PERSIST_FAILED');
    assert.equal(envelope.persistFailed, 'items');
    assert.match(envelope.error.message, /run_id/);
    assert.equal(envelope.itemsInserted, 0);
    // The run row DID land, so its id is reported — it exists with no criteria.
    assert.equal(envelope.runId, 'run-1');
    assertReportComplete(envelope);
  });

  it('the items writer THROWS → treated exactly like a reported failure', async () => {
    const w = writers({ items: () => { throw new Error('connection reset'); } });
    const { envelope, exitCode } = await call({}, w);
    assert.equal(exitCode, VERIFY_PERSIST_FAILED_EXIT);
    assert.equal(envelope.persistFailed, 'items');
    assert.match(envelope.error.message, /connection reset/);
    assertReportComplete(envelope);
  });

  it('the run write fails → items are never attempted, exit 4, persistFailed:run', async () => {
    const w = writers({ run: { ok: false, cloud: true, runId: null, reason: 'parent-not-found', message: 'no such plan' } });
    const { envelope, exitCode } = await call({}, w);
    assert.equal(exitCode, VERIFY_PERSIST_FAILED_EXIT);
    assert.equal(envelope.persistFailed, 'run');
    assert.equal(envelope.runId, null);
    assert.equal(w.calls.items.length, 0, 'no run row → nothing to attach criteria to');
    assert.equal('itemsInserted' in envelope, false);
    assertReportComplete(envelope);
  });

  it('a short write (row-count-mismatch) is a failure, not a success with a smaller number', async () => {
    const w = writers({ items: { ok: false, inserted: 2, reason: 'row-count-mismatch', message: 'INSERT affected 2 of 3 row(s)' } });
    const { envelope, exitCode } = await call({}, w);
    assert.equal(exitCode, VERIFY_PERSIST_FAILED_EXIT);
    assert.equal(envelope.itemsInserted, 2);
  });

  it('a DEGRADED items write (skipped column missing) is recorded → exit 0, degradation surfaced', async () => {
    const w = writers({ items: { ok: true, inserted: 3, degraded: 'skipped-column-missing' } });
    const { envelope, exitCode } = await call({}, w);
    assert.equal(exitCode, 0);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.itemsDegraded, 'skipped-column-missing');
  });

  it('cloud off → documented skip: ok, exit 0, no writer called', async () => {
    const w = writers();
    const { envelope, exitCode } = await call({ cloud: false }, w);
    assert.equal(exitCode, 0);
    assert.equal(envelope.ok, true);
    assert.match(envelope.hint, /AUDIT_DB_URL unset/);
    assert.equal(w.calls.run.length + w.calls.items.length, 0);
    assertReportComplete(envelope);
  });

  it('no --plan-id → documented skip: ok, exit 0, no writer called', async () => {
    const w = writers();
    const { envelope, exitCode } = await call({ planId: null }, w);
    assert.equal(exitCode, 0);
    assert.equal(envelope.ok, true);
    assert.equal(w.calls.run.length + w.calls.items.length, 0);
  });

  it('criteria failures alone never change the exit code — verify is a report', async () => {
    const allFail = ITEMS.map((i) => ({ ...i, passed: false, errorMessage: 'boom' }));
    const { exitCode } = await call({ items: allFail });
    assert.equal(exitCode, 0);
  });
});

describe('verifyPersistOutcome — the decision', () => {
  it('a missing writer result is a failure, never a pass', () => {
    assert.equal(verifyPersistOutcome({ cloud: true, planId: 'p', runRes: null }).ok, false);
    assert.equal(verifyPersistOutcome({ cloud: true, planId: 'p', runRes: { ok: true, runId: 'r' }, itemsRes: null }).persistFailed, 'items');
  });
});
