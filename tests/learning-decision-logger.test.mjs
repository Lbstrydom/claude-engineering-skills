import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  recordDecision,
  backfillOutcome,
  flush,
  reconcileOutbox,
  buildDecisionKey,
  _resetForTest,
  _getStateForTest,
  _internals,
} from '../scripts/lib/learning/decision-logger.mjs';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockStore({ failOn = null } = {}) {
  const inserted = [];
  const updated = [];
  return {
    inserted, updated,
    isCloudEnabled: () => true,
    insertLearningDecision: async (entry) => {
      if (failOn === 'insert') return { ok: false, error: 'simulated' };
      inserted.push(entry);
      return { ok: true };
    },
    backfillLearningOutcome: async (entry) => {
      if (failOn === 'backfill') return { ok: false, error: 'simulated' };
      updated.push(entry);
      return { ok: true };
    },
  };
}

function tmpOutbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'learning-outbox-'));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('decision-logger / buildDecisionKey', () => {
  beforeEach(() => _resetForTest());

  it('audit-bound format: <run>:<type>:r<round>:s<seq>', () => {
    const k = buildDecisionKey({
      decisionType: 'pass_selection',
      auditRunId: '11111111-1111-1111-1111-111111111111',
      round: 0,
      sequence: 0,
    });
    assert.equal(k, '11111111-1111-1111-1111-111111111111:pass_selection:r0:s0');
  });

  it('off-audit format: <type>:<external_id>', () => {
    const k = buildDecisionKey({
      decisionType: 'quickfix_hit',
      externalId: 'abcd-1234',
    });
    assert.equal(k, 'quickfix_hit:abcd-1234');
  });

  it('throws when neither audit-bound nor external_id provided', () => {
    assert.throws(() => buildDecisionKey({ decisionType: 'pass_selection' }));
  });
});

describe('decision-logger / recordDecision validation', () => {
  beforeEach(() => _resetForTest());

  it('rejects malformed input shape', () => {
    assert.throws(() => recordDecision(null));
    assert.throws(() => recordDecision({}));
    assert.throws(() => recordDecision({ decisionType: 'pass_selection' }));
  });

  it('rejects unknown decisionType', () => {
    assert.throws(() => recordDecision({
      decisionType: 'not_a_real_type',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: {}, choice: { x: 1 },
    }));
  });

  it('rejects when audit-bound fields incomplete AND no externalId', () => {
    assert.throws(() => recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', // missing round + sequence
      context: {}, choice: { x: 1 },
    }));
  });

  it('accepts audit-bound input', () => {
    const k = recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: {}, choice: { chose: 'all' },
    });
    assert.equal(k, 'r1:pass_selection:r0:s0');
  });

  it('accepts off-audit (external_id) input', () => {
    const k = recordDecision({
      decisionType: 'quickfix_hit',
      externalId: 'h1',
      context: { pattern: 'x' }, choice: { action: 'flagged' },
    });
    assert.equal(k, 'quickfix_hit:h1');
  });

  it('LEARNING_DISABLE=1 short-circuits to null', () => {
    const old = process.env.LEARNING_DISABLE;
    process.env.LEARNING_DISABLE = '1';
    try {
      const k = recordDecision({
        decisionType: 'pass_selection',
        auditRunId: 'r1', round: 0, sequence: 0,
        context: {}, choice: {},
      });
      assert.equal(k, null);
    } finally {
      if (old === undefined) delete process.env.LEARNING_DISABLE;
      else process.env.LEARNING_DISABLE = old;
    }
  });
});

describe('decision-logger / per-type sub-queue caps', () => {
  beforeEach(() => _resetForTest());

  it('drops oldest of SAME type when cap exceeded; other types untouched', () => {
    const cap = _internals.PER_TYPE_QUEUE_CAP;
    // Fill auto_deferral past cap.
    for (let i = 0; i < cap + 5; i += 1) {
      recordDecision({
        decisionType: 'auto_deferral',
        externalId: `auto_deferral_${i}`,
        context: { i }, choice: { class: 'style' },
      });
    }
    // Insert one pass_selection — must NOT be evicted by auto_deferral overflow.
    recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: { critical: true }, choice: { chose: 'all' },
    });

    const state = _getStateForTest();
    assert.equal(state.queueSizes.auto_deferral, cap, 'auto_deferral must be capped');
    assert.equal(state.queueSizes.pass_selection, 1, 'pass_selection must not be evicted by other type overflow');
    assert.equal(state.droppedCounts.auto_deferral, 5);
    assert.ok(!state.droppedCounts.pass_selection);
  });
});

describe('decision-logger / flush + outbox', () => {
  beforeEach(() => _resetForTest());

  it('flushes successfully when cloud is enabled and store accepts', async () => {
    const store = makeMockStore();
    recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: {}, choice: { chose: 'all' },
    });
    const summary = await flush({ store, outboxDir: tmpOutbox() });
    assert.equal(summary.flushed, 1);
    assert.equal(store.inserted.length, 1);
  });

  it('outboxes locally when store reports failure (non-CI env)', async () => {
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    const store = makeMockStore({ failOn: 'insert' });
    const dir = tmpOutbox();
    recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: {}, choice: { chose: 'all' },
    });
    const summary = await flush({ store, outboxDir: dir });
    assert.equal(summary.flushed, 0);
    // CI flag is read at module-load; in this test environment it may be set.
    if (_internals.CI_ENV_FLAG) {
      assert.equal(summary.lostInCI, 1);
    } else {
      assert.equal(summary.outboxed, 1);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      assert.equal(files.length, 1);
    }
  });

  it('reconcileOutbox is idempotent — replaying succeeded files is a no-op', async () => {
    const dir = tmpOutbox();
    // Manually write an outbox file
    const entry = {
      decisionKey: 'pass_selection:test-1',
      decisionType: 'pass_selection',
      externalId: 'test-1',
      context: {}, choice: { chose: 'all' }, outcome: null,
      enqueuedAt: new Date().toISOString(),
    };
    const filePath = path.join(dir, 'test-entry.json');
    fs.writeFileSync(filePath, JSON.stringify(entry));

    const store = makeMockStore();
    const r1 = await reconcileOutbox({ store, outboxDir: dir });
    assert.equal(r1.processed, 1);
    assert.equal(r1.succeeded, 1);
    assert.equal(fs.existsSync(filePath), false, 'successful file deleted');

    // Second reconcile finds nothing.
    const r2 = await reconcileOutbox({ store, outboxDir: dir });
    assert.equal(r2.processed, 0);
  });

  it('backfillOutcome on a queued entry mutates the entry in-place', async () => {
    const store = makeMockStore();
    const k = recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: {}, choice: { chose: 'all' },
    });
    backfillOutcome({ decisionKey: k, outcome: { totalFindings: 10 } });
    const summary = await flush({ store, outboxDir: tmpOutbox() });
    assert.equal(summary.flushed, 1);
    assert.deepEqual(store.inserted[0].outcome, { totalFindings: 10 });
  });

  it('backfillOutcome on already-flushed entry enqueues an UPDATE', async () => {
    const store = makeMockStore();
    const k = recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: {}, choice: { chose: 'all' },
    });
    await flush({ store, outboxDir: tmpOutbox() });

    // After flush, queue is empty.  backfill should enqueue a new update.
    backfillOutcome({ decisionKey: k, outcome: { totalFindings: 5 } });
    const summary = await flush({ store, outboxDir: tmpOutbox() });
    assert.equal(summary.flushed, 1);
    assert.equal(store.updated.length, 1);
    assert.equal(store.updated[0].decisionKey, k);
  });
});
