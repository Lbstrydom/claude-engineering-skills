import { describe, it, beforeEach, after } from 'node:test';
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
  _setOutboxDirForTest,
  _internals,
  _resolveQueueCap,
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

  it('rejects malformed key fields by TYPE + RANGE (audit R3-H)', () => {
    // non-string auditRunId, negative/non-integer counters, empty externalId all
    // fall through to the throw rather than producing a colliding/unstable key.
    assert.throws(() => buildDecisionKey({ decisionType: 'pass_selection', auditRunId: 12345, round: 0, sequence: 0 }));
    assert.throws(() => buildDecisionKey({ decisionType: 'pass_selection', auditRunId: 'r', round: -1, sequence: 0 }));
    assert.throws(() => buildDecisionKey({ decisionType: 'pass_selection', auditRunId: 'r', round: 1.5, sequence: 0 }));
    assert.throws(() => buildDecisionKey({ decisionType: 'pass_selection', auditRunId: '  ', round: 0, sequence: 0 }));
    assert.throws(() => buildDecisionKey({ decisionType: 'quickfix_hit', externalId: '' }));
    // valid still builds
    assert.equal(buildDecisionKey({ decisionType: 'quickfix_hit', externalId: 'h1' }), 'quickfix_hit:h1');
  });

  it('rejects colon-bearing id components + unknown decisionType (audit R4 delimiter)', () => {
    // a ':' in a caller id could forge an extra key segment → collision
    assert.throws(() => buildDecisionKey({ decisionType: 'pass_selection', auditRunId: 'r:1', round: 0, sequence: 0 }));
    assert.throws(() => buildDecisionKey({ decisionType: 'quickfix_hit', externalId: 'a:b' }));
    // unknown decisionType is rejected even on the direct-call path
    assert.throws(() => buildDecisionKey({ decisionType: 'not_a_type', externalId: 'h1' }),
      /unknown decisionType/);
  });
});

describe('decision-logger / resolveQueueCap (audit R3-M config validation)', () => {
  it('accepts a positive integer; rejects NaN/0/negative/partial → default 64', () => {
    assert.equal(_resolveQueueCap('128'), 128);
    assert.equal(_resolveQueueCap(undefined), 64);   // unset → default
    assert.equal(_resolveQueueCap(''), 64);
    assert.equal(_resolveQueueCap('0'), 64);          // 0 would disable the cap
    assert.equal(_resolveQueueCap('-5'), 64);
    assert.equal(_resolveQueueCap('10abc'), 64);      // Number() rejects partial parse
    assert.equal(_resolveQueueCap('abc'), 64);
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

// ── Eviction: the §2 transition table ──────────────────────────────────────
// docs/plans/learning-persona-quickfix-honest-failure.md §2 "The eviction
// transition table" is the authoritative spec; there is ONE test per row.
//
// Every test asserts all four observables TOGETHER — queue length, queue
// CONTENTS, the return value, and the counter. That combination is the point:
// a test that checks only the counter passes against the superseded
// "spill, count the failure, drop it anyway" design (R2-H4), and a test that
// checks only the length passes against a capture-then-shift implementation
// that loses the oldest entry.

const OUTBOX_FIXTURES = [];

/** A writable temp outbox dir — the spill SUCCEEDS here. */
function makeWorkingOutboxDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evict-ok-'));
  OUTBOX_FIXTURES.push(dir);
  return path.join(dir, 'outbox');
}

/**
 * An outbox dir whose ancestor is a FILE, so atomicWriteFileSync's internal
 * mkdirSync throws ENOTDIR — deterministic on every platform, no OS
 * permissions involved. Same fault the writeOutbox contract test below uses.
 */
function makeFailingOutboxDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evict-fail-'));
  OUTBOX_FIXTURES.push(dir);
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  return path.join(blocker, 'nested', 'outbox');
}

/** Silence the throttled cap warning so test output stays readable. */
function quietly(fn) {
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = original; }
}

function fillToCap(cap) {
  const keys = [];
  for (let i = 0; i < cap; i += 1) {
    keys.push(recordDecision({
      decisionType: 'auto_deferral',
      externalId: `auto_deferral_${i}`,
      context: { i }, choice: { class: 'style' },
    }));
  }
  return keys;
}

describe('decision-logger / eviction transition table (§2)', () => {
  beforeEach(() => _resetForTest());
  after(() => {
    for (const d of OUTBOX_FIXTURES.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch { /* best effort */ }
    }
  });

  // Row 1 — under cap: enqueue new, return decisionKey, no counter movement.
  it('row 1: under cap — enqueues and returns a decisionKey', () => {
    _setOutboxDirForTest(makeWorkingOutboxDir());
    const key = recordDecision({
      decisionType: 'auto_deferral',
      externalId: 'only', context: { i: 0 }, choice: { class: 'style' },
    });

    const state = _getStateForTest();
    assert.equal(typeof key, 'string');
    assert.equal(state.queueSizes.auto_deferral, 1);
    assert.deepEqual(state.queueKeys.auto_deferral, [key]);
    assert.ok(!state.evictedOutboxedCounts.auto_deferral);
    assert.ok(!state.backpressureRejectedCounts.auto_deferral);
  });

  // Row 2 — at cap, spill SUCCEEDS: shift oldest, enqueue new, return key.
  it('row 2: at cap and the spill succeeds — shifts oldest, admits new, returns a decisionKey', () => {
    const outboxDir = makeWorkingOutboxDir();
    _setOutboxDirForTest(outboxDir);
    const cap = _internals.PER_TYPE_QUEUE_CAP;
    const keys = fillToCap(cap);

    const newKey = quietly(() => recordDecision({
      decisionType: 'auto_deferral',
      externalId: 'overflow', context: { i: cap }, choice: { class: 'style' },
    }));

    const state = _getStateForTest();
    assert.equal(typeof newKey, 'string', 'a successful spill admits the new decision');
    assert.equal(state.queueSizes.auto_deferral, cap, 'queue stays bounded at the cap');
    assert.ok(
      !state.queueKeys.auto_deferral.includes(keys[0]),
      'the oldest entry must have been shifted out',
    );
    assert.ok(
      state.queueKeys.auto_deferral.includes(newKey),
      'the new entry must be present in the queue',
    );
    assert.equal(state.evictedOutboxedCounts.auto_deferral, 1);
    assert.ok(!state.backpressureRejectedCounts.auto_deferral);

    // The shifted entry is recoverable — that is what makes the shift honest.
    const spilled = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
    assert.equal(spilled.length, 1, 'the evicted entry must be on disk in the outbox');
    const written = JSON.parse(fs.readFileSync(path.join(outboxDir, spilled[0]), 'utf-8'));
    assert.equal(written.decisionKey, keys[0], 'the spilled file must be the evicted oldest entry');
  });

  // Row 3 — at cap, spill FAILS: retain oldest, refuse admission, return null.
  it('row 3: at cap and the spill fails — retains oldest, refuses the new decision, returns null', () => {
    _setOutboxDirForTest(makeFailingOutboxDir());
    const cap = _internals.PER_TYPE_QUEUE_CAP;
    const keys = fillToCap(cap);

    const result = quietly(() => recordDecision({
      decisionType: 'auto_deferral',
      externalId: 'overflow', context: { i: cap }, choice: { class: 'style' },
    }));

    const state = _getStateForTest();
    assert.equal(result, null, 'a receipt must NOT be issued for a decision that was never admitted');
    assert.equal(state.queueSizes.auto_deferral, cap, 'queue stays bounded at the cap');
    assert.ok(
      state.queueKeys.auto_deferral.includes(keys[0]),
      'the oldest entry must be RETAINED — nothing is lost when the spill fails',
    );
    assert.deepEqual(
      state.queueKeys.auto_deferral, keys,
      'queue contents must be byte-identical to before the refused call',
    );
    assert.equal(state.backpressureRejectedCounts.auto_deferral, 1);
    assert.ok(!state.evictedOutboxedCounts.auto_deferral);
  });

  // R3-H1 removed the CI carve-out: eviction is environment-independent.
  for (const row of ['row 2', 'row 3']) {
    it(`${row} is identical under CI=1 (R3-H1 removed the carve-out)`, () => {
      const oldCi = process.env.CI;
      const oldGha = process.env.GITHUB_ACTIONS;
      process.env.CI = '1';
      delete process.env.GITHUB_ACTIONS;
      try {
        const succeeds = row === 'row 2';
        _setOutboxDirForTest(succeeds ? makeWorkingOutboxDir() : makeFailingOutboxDir());
        const cap = _internals.PER_TYPE_QUEUE_CAP;
        const keys = fillToCap(cap);

        const result = quietly(() => recordDecision({
          decisionType: 'auto_deferral',
          externalId: 'overflow', context: { i: cap }, choice: { class: 'style' },
        }));

        const state = _getStateForTest();
        assert.equal(state.queueSizes.auto_deferral, cap);
        if (succeeds) {
          assert.equal(typeof result, 'string');
          assert.ok(!state.queueKeys.auto_deferral.includes(keys[0]));
          assert.equal(state.evictedOutboxedCounts.auto_deferral, 1);
        } else {
          assert.equal(result, null, 'CI must NOT get a lossy carve-out');
          assert.deepEqual(state.queueKeys.auto_deferral, keys);
          assert.equal(state.backpressureRejectedCounts.auto_deferral, 1);
        }
      } finally {
        if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
        if (oldGha !== undefined) process.env.GITHUB_ACTIONS = oldGha;
      }
    });
  }

  // Other types are still unaffected by one type's overflow (pre-existing
  // guarantee — kept, because the eviction rewrite could plausibly break it).
  it('one type reaching the cap does not evict another type', () => {
    _setOutboxDirForTest(makeWorkingOutboxDir());
    const cap = _internals.PER_TYPE_QUEUE_CAP;
    fillToCap(cap);
    quietly(() => {
      for (let i = 0; i < 5; i += 1) {
        recordDecision({
          decisionType: 'auto_deferral',
          externalId: `overflow_${i}`, context: { i }, choice: { class: 'style' },
        });
      }
    });
    const passKey = recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: { critical: true }, choice: { chose: 'all' },
    });

    const state = _getStateForTest();
    assert.equal(state.queueSizes.auto_deferral, cap);
    assert.equal(state.queueSizes.pass_selection, 1);
    assert.deepEqual(state.queueKeys.pass_selection, [passKey]);
    assert.equal(state.evictedOutboxedCounts.auto_deferral, 5);
    assert.ok(!state.evictedOutboxedCounts.pass_selection);
  });
});

// The eviction spill made a pre-existing validation gap load-bearing: the
// oldest entry is now spilled with JSON.stringify BEFORE the queue may shift,
// so an entry that cannot be serialised can never be spilled — and the §2
// table then (correctly) refuses every subsequent admission. One poison entry
// at the head of a full queue therefore wedges that decision type forever.
//
// `context` was already implicitly protected (contextHash stringifies it at
// admission), but `choice` and `outcome` were not. Refusing at admission is
// free; refusing forever afterwards is not.
describe('decision-logger / non-serialisable payloads are refused at admission', () => {
  beforeEach(() => _resetForTest());

  for (const [label, payload] of [
    ['a BigInt', { n: 10n }],
    ['a circular reference', (() => { const o = { a: 1 }; o.self = o; return o; })()],
  ]) {
    it(`rejects ${label} in choice, rather than admitting an unspillable entry`, () => {
      assert.throws(
        () => recordDecision({
          decisionType: 'auto_deferral', externalId: 'poison',
          context: { ok: 1 }, choice: payload,
        }),
        (err) => err.code === 'BAD_INPUT',
        'must refuse at the boundary where refusing costs the caller nothing',
      );
      assert.ok(
        !_getStateForTest().queueKeys.auto_deferral?.length,
        'a refused decision must not be enqueued',
      );
    });

    it(`rejects ${label} in outcome via backfillOutcome`, () => {
      const key = recordDecision({
        decisionType: 'auto_deferral', externalId: 'ok',
        context: { ok: 1 }, choice: { fine: true },
      });
      assert.throws(
        () => backfillOutcome({ decisionKey: key, outcome: payload }),
        (err) => err.code === 'BAD_INPUT',
        'backfillOutcome is a second door into the same queue and needs the same gate',
      );
    });
  }

  // The wedge itself: with the gate in place, a full queue keeps admitting.
  it('a full queue keeps admitting — no poison entry can wedge it', () => {
    _setOutboxDirForTest(makeWorkingOutboxDir());
    const cap = _internals.PER_TYPE_QUEUE_CAP;
    try {
      recordDecision({
        decisionType: 'auto_deferral', externalId: 'poison',
        context: { ok: 1 }, choice: { n: 10n },
      });
    } catch { /* expected — that is the point */ }
    fillToCap(cap);
    const admitted = quietly(() => recordDecision({
      decisionType: 'auto_deferral', externalId: 'after',
      context: {}, choice: { ok: 1 },
    }));
    assert.equal(typeof admitted, 'string', 'the queue must not be wedged by a refused payload');
  });
});

// §9 case 3 — the flush-summary contract (R1-M3). `dropped` was previously
// seeded from the eviction counter, which conflated "recoverable" with "gone".
describe('decision-logger / flush summary: dropped counts only permanent loss', () => {
  beforeEach(() => _resetForTest());

  it('a successful spill reports evictedOutboxed, never dropped', async () => {
    _setOutboxDirForTest(makeWorkingOutboxDir());
    const cap = _internals.PER_TYPE_QUEUE_CAP;
    fillToCap(cap);
    quietly(() => recordDecision({
      decisionType: 'auto_deferral',
      externalId: 'overflow', context: {}, choice: { class: 'style' },
    }));

    const summary = await flush({ store: makeMockStore() });
    assert.equal(summary.evictedOutboxed, 1);
    assert.equal(summary.backpressureRejected, 0);
    assert.equal(summary.dropped, 0, 'a spilled entry is recoverable — not dropped');
  });

  it('a failed spill reports backpressureRejected, never dropped', async () => {
    _setOutboxDirForTest(makeFailingOutboxDir());
    const cap = _internals.PER_TYPE_QUEUE_CAP;
    fillToCap(cap);
    quietly(() => recordDecision({
      decisionType: 'auto_deferral',
      externalId: 'overflow', context: {}, choice: { class: 'style' },
    }));

    const summary = await flush({ store: makeMockStore() });
    assert.equal(summary.backpressureRejected, 1);
    assert.equal(summary.evictedOutboxed, 0);
    assert.equal(
      summary.dropped, 0,
      'a refused decision was never admitted — it cannot have been dropped',
    );
  });

  it('a normal flush with no eviction reports dropped: 0', async () => {
    _setOutboxDirForTest(makeWorkingOutboxDir());
    recordDecision({
      decisionType: 'pass_selection',
      auditRunId: 'r1', round: 0, sequence: 0,
      context: {}, choice: { chose: 'all' },
    });
    const summary = await flush({ store: makeMockStore() });
    assert.equal(summary.flushed, 1);
    assert.equal(summary.dropped, 0);
    assert.equal(summary.evictedOutboxed, 0);
    assert.equal(summary.backpressureRejected, 0);
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

// ── _internals.writeOutbox — failure contract (atomic-write-adoption plan) ──
// Deterministic, cross-platform fault: point the outbox dir's ancestor at a
// FILE, not a directory. atomicWriteFileSync's internal mkdirSync then
// throws ENOTDIR every time, on every platform — no OS permissions involved.

describe('_internals.writeOutbox — failure contract', () => {
  it('returns false (does not throw) and warns when the write fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-fail-'));
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const outboxDir = path.join(blocker, 'nested', 'outbox');

    const originalWrite = process.stderr.write;
    let warned = '';
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    let result;
    try {
      result = _internals.writeOutbox(
        { decisionKey: 'k1', enqueuedAt: new Date().toISOString() },
        outboxDir,
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(result, false, 'writeOutbox must return false, not throw, on failure');
    assert.match(warned, /outbox write failed/);
  });
});
