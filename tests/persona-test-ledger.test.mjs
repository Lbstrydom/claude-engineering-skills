/**
 * @fileoverview Phase 3 ledger tests.
 *
 * Covers:
 *   - openLedger persists immediately (write-once probe — fails fast if path
 *     is not writable)
 *   - appendStep persists after every step (crash-safe)
 *   - recordCandidate persists + de-duplicates
 *   - setVerdicts is in-memory; close() does the final validated write
 *   - close() fails Zod validation on bad terminal state
 *   - Zero-step ledger is a valid terminal state (R2-H2)
 *   - normaliseForReplay strips timestamps, sorts arrays, byte-identical
 *     across two equivalent ledgers (Gemini-R4-G3 acceptance)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openLedger,
  normaliseForReplay,
  SESSIONS_DIR,
  _internals,
} from '../scripts/lib/persona-test/ledger.mjs';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readLedger(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function baseStep(over = {}) {
  return {
    stepIndex: 0,
    plan: 'Open the cellar',
    actionLabel: 'navigate',
    witness: {
      stepIndex: 0,
      domClaims: [],
      networkClaims: [],
      undeclaredDomClaims: [],
      partialCapture: false,
      customClaims: {},
    },
    contradictions: [],
    freshness: [],
    warnings: [],
    durationMs: 123,
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// openLedger
// ────────────────────────────────────────────────────────────────────────────

describe('openLedger — initial persistence', () => {
  it('writes the initial record before any steps (write-once probe)', () => {
    const handle = openLedger(tmpDir, 'SID-1', { journeyKey: 'oliver', canaryName: 'oliver-x' });
    assert.ok(fs.existsSync(handle.ledgerPath));
    const onDisk = readLedger(handle.ledgerPath);
    assert.equal(onDisk.sessionId, 'SID-1');
    assert.equal(onDisk.journeyKey, 'oliver');
    assert.equal(onDisk.canaryName, 'oliver-x');
    assert.equal(onDisk.rigVerdict, 'fatal');     // pessimistic default
    assert.equal(onDisk.truncated, true);
    assert.deepEqual(onDisk.steps, []);
  });

  it('places sessions under <repoRoot>/.persona-test/sessions/<SID>.json', () => {
    const handle = openLedger(tmpDir, 'SID-2', { journeyKey: 'k' });
    const expected = path.join(tmpDir, SESSIONS_DIR, 'SID-2.json');
    assert.equal(handle.ledgerPath, expected);
  });

  it('refuses bad inputs', () => {
    assert.throws(() => openLedger('',     'SID', { journeyKey: 'k' }), /repoRoot/);
    assert.throws(() => openLedger(tmpDir, '',    { journeyKey: 'k' }), /sessionId/);
    assert.throws(() => openLedger(tmpDir, 'SID', {}),                  /journeyKey/);
  });

  it('persists fixtureSeed when provided', () => {
    const handle = openLedger(tmpDir, 'SID-3', {
      journeyKey: 'oliver', fixtureSeed: 'wine-cellar-2026-05', canaryName: null,
    });
    const onDisk = readLedger(handle.ledgerPath);
    assert.equal(onDisk.fixtureSeed, 'wine-cellar-2026-05');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// appendStep / recordCandidate — per-step atomic write
// ────────────────────────────────────────────────────────────────────────────

describe('openLedger — incremental writes', () => {
  it('persists after every appendStep', () => {
    const handle = openLedger(tmpDir, 'SID-A', { journeyKey: 'k' });
    handle.appendStep(baseStep({ stepIndex: 0 }));
    assert.equal(readLedger(handle.ledgerPath).steps.length, 1);
    handle.appendStep(baseStep({ stepIndex: 1 }));
    assert.equal(readLedger(handle.ledgerPath).steps.length, 2);
  });

  it('recordCandidate persists + de-duplicates by specId', () => {
    const handle = openLedger(tmpDir, 'SID-B', { journeyKey: 'k' });
    handle.recordCandidate('spec-1');
    handle.recordCandidate('spec-1');         // dup
    handle.recordCandidate('spec-2');
    assert.deepEqual(readLedger(handle.ledgerPath).candidateSpecIds, ['spec-1', 'spec-2']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// setVerdicts + close
// ────────────────────────────────────────────────────────────────────────────

describe('openLedger — setVerdicts is in-memory; close finalises', () => {
  it('setVerdicts does NOT persist; close writes the validated final', () => {
    const handle = openLedger(tmpDir, 'SID-C', { journeyKey: 'k', canaryName: 'oliver' });
    const beforeOnDisk = readLedger(handle.ledgerPath);
    assert.equal(beforeOnDisk.rigVerdict, 'fatal');

    handle.setVerdicts({
      rigVerdict: 'healthy',
      canaryVerdict: 'passed',
      failureReason: null,
      truncated: false,
    });
    // Still on disk: previous pessimistic write.
    assert.equal(readLedger(handle.ledgerPath).rigVerdict, 'fatal');

    const closed = handle.close();
    const afterOnDisk = readLedger(handle.ledgerPath);
    assert.equal(closed.rigVerdict, 'healthy');
    assert.equal(afterOnDisk.rigVerdict, 'healthy');
    assert.equal(afterOnDisk.canaryVerdict, 'passed');
    assert.equal(afterOnDisk.failureReason, null);
    assert.equal(afterOnDisk.truncated, false);
    assert.ok(afterOnDisk.endedAt && afterOnDisk.endedAt !== afterOnDisk.startedAt
      || afterOnDisk.endedAt === afterOnDisk.startedAt);
  });

  it('close on a zero-step ledger is a valid terminal state (R2-H2)', () => {
    const handle = openLedger(tmpDir, 'SID-Z', { journeyKey: 'k' });
    handle.setVerdicts({
      rigVerdict: 'fatal',
      canaryVerdict: 'not-applicable',
      failureReason: 'manifest-missing',
      truncated: false,
    });
    const closed = handle.close();
    assert.equal(closed.steps.length, 0);
    assert.equal(closed.rigVerdict, 'fatal');
    assert.equal(closed.failureReason, 'manifest-missing');
  });

  it('close throws Zod failure on bad rigVerdict', () => {
    const handle = openLedger(tmpDir, 'SID-Bad', { journeyKey: 'k' });
    handle.setVerdicts({ rigVerdict: 'wibble' });
    assert.throws(() => handle.close(), /schema validation failed/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// normaliseForReplay — idempotency invariant
// ────────────────────────────────────────────────────────────────────────────

describe('normaliseForReplay', () => {
  function makeLedgerWithNoise(extra = {}) {
    return {
      schemaVersion: 1, sessionId: 'SID', canaryName: 'oliver',
      journeyKey: 'oliver', fixtureSeed: 'seed-1',
      startedAt: '2026-05-20T10:00:00Z',
      steps: [
        {
          stepIndex: 0, plan: 'Open cellar', actionLabel: 'navigate',
          witness: {
            stepIndex: 0,
            domClaims: [
              { surfaceId: 'b-row', engineField: 'f', domValueRaw: 'true',
                freshness: 'current', scope: null, key: null,
                locator: {kind:'role',role:'status'}, visible: true },
              { surfaceId: 'a-row', engineField: 'f', domValueRaw: 'true',
                freshness: 'current', scope: null, key: null,
                locator: {kind:'role',role:'status'}, visible: true },
            ],
            networkClaims: [
              { surfaceId: 'b-row', engineField: 'f', scope: null, key: null,
                value: true, sourceUrl: '/api/cellar', receivedAt: '2026-05-20T10:00:01Z' },
              { surfaceId: 'a-row', engineField: 'f', scope: null, key: null,
                value: true, sourceUrl: '/api/cellar', receivedAt: '2026-05-20T10:00:02Z' },
            ],
            undeclaredDomClaims: [],
            partialCapture: false, customClaims: {},
          },
          contradictions: [], freshness: [], warnings: [], durationMs: 42,
        },
      ],
      candidateSpecIds: [], rigVerdict: 'healthy',
      canaryVerdict: 'passed', failureReason: null, stepFailureReason: null,
      truncated: false, endedAt: '2026-05-20T10:00:03Z',
      ...extra,
    };
  }

  it('strips top-level timestamps', () => {
    const out = normaliseForReplay(makeLedgerWithNoise());
    assert.equal(out.startedAt, '');
    assert.equal(out.endedAt, '');
  });

  it('strips per-step durationMs', () => {
    const out = normaliseForReplay(makeLedgerWithNoise());
    assert.equal(out.steps[0].durationMs, 0);
  });

  it('strips per-network-claim receivedAt', () => {
    const out = normaliseForReplay(makeLedgerWithNoise());
    for (const n of out.steps[0].witness.networkClaims) {
      assert.equal(n.receivedAt, '');
    }
  });

  it('sorts domClaims + networkClaims by stable key', () => {
    const out = normaliseForReplay(makeLedgerWithNoise());
    const ids = out.steps[0].witness.domClaims.map((c) => c.surfaceId);
    assert.deepEqual(ids, ['a-row', 'b-row']);
    const netIds = out.steps[0].witness.networkClaims.map((c) => c.surfaceId);
    assert.deepEqual(netIds, ['a-row', 'b-row']);
  });

  it('two equivalent ledgers normalise to byte-identical JSON (Gemini-R4-G3 acceptance)', () => {
    // Same data, different ordering + different timestamps.
    const a = makeLedgerWithNoise();
    const b = makeLedgerWithNoise({
      startedAt: '2099-01-01T00:00:00Z',
      endedAt:   '2099-01-01T00:00:99Z',
    });
    // Mutate b's step to reverse claim ordering + bump durations + timestamps.
    b.steps[0].witness.domClaims.reverse();
    b.steps[0].witness.networkClaims.reverse();
    b.steps[0].durationMs = 9999;
    for (const n of b.steps[0].witness.networkClaims) n.receivedAt = '2099-01-01T00:00:00Z';

    const na = normaliseForReplay(a);
    const nb = normaliseForReplay(b);
    assert.equal(JSON.stringify(na), JSON.stringify(nb));
  });

  it('does not mutate the input ledger', () => {
    const orig = makeLedgerWithNoise();
    const snapshot = JSON.parse(JSON.stringify(orig));
    normaliseForReplay(orig);
    assert.deepEqual(orig, snapshot);
  });

  it('throws on non-object input', () => {
    assert.throws(() => normaliseForReplay(null), /must be an object/);
    assert.throws(() => normaliseForReplay('x'),  /must be an object/);
  });
});

describe('_internals', () => {
  it('stableCompareDom orders by surface then engineField then scope then key', () => {
    const cmp = _internals.stableCompareDom;
    assert.ok(cmp({surfaceId:'a',engineField:'f'}, {surfaceId:'b',engineField:'f'}) < 0);
    assert.ok(cmp({surfaceId:'a',engineField:'g'}, {surfaceId:'a',engineField:'f'}) > 0);
  });
});
