/**
 * @fileoverview The ship-train operation receipt: strict schema, write-once
 * planning fields, fingerprint, phase transitions, and refusal of a second
 * writer (docs/plans/ship-trains.md §2.8–§2.9).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createReceipt, readReceipt, updateReceipt, fingerprintOf, newOpId, receiptPath, canonicalJson,
  TRANSITIONS, PHASES, OP_ID_RE, ReceiptError,
} from '../scripts/lib/ship-train/receipt.mjs';
import { withFileLockSync } from '../scripts/lib/file-lock.mjs';

const oid = (c) => c.repeat(40);
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-train-receipt-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function planning(over = {}) {
  return {
    schemaVersion: 1,
    opId: 's-20261011230000-ab12',
    createdAt: '2026-10-11T23:00:00.000Z',
    repo: 'Lbstrydom/claude-engineering-skills',
    destination: { ref: 'refs/heads/main', expectedOid: oid('e') },
    basePinning: { verdict: 'none', evidence: 'rulesets: [] ; protection: 404' },
    selected: [{
      pr: 202,
      title: 'fix(store): x',
      headOid: oid('1'),
      mergeBaseOid: oid('e'),
      tier: 'urgent',
      reasons: ['reaches-consumers:3'],
      binding: { kind: 'tree', runId: 'run-1', boundCommit: oid('1'), postAuditCommits: [], reason: null },
      decision: { gate: 'converged', runId: 'run-1', auditedTree: null, models: ['claude', 'gpt'], attributionMissing: ['author'], identityProvable: false },
    }],
    overrides: { waive: [], allowUnaudited: [], endOfDay: false },
    ...over,
  };
}

describe('op ids', () => {
  test('newOpId has the s-<14 digits>-<4 hex> shape', () => {
    assert.match(newOpId(new Date('2026-10-11T23:00:00Z')), /^s-20261011230000-[0-9a-f]{4}$/);
    assert.match(newOpId(), OP_ID_RE);
  });

  test('a path is never built from a malformed op id', () => {
    assert.throws(() => receiptPath(dir, '../escape'), (e) => e.code === 'BAD_OP_ID');
  });
});

describe('create / read', () => {
  test('a created receipt starts in prepared, round-trips, and carries its fingerprint', () => {
    const r = createReceipt(dir, planning());
    assert.equal(r.phase, 'prepared');
    assert.equal(r.fingerprint, fingerprintOf(r));
    assert.deepEqual(readReceipt(dir, r.opId), r);
  });

  test('an existing op is never overwritten', () => {
    createReceipt(dir, planning());
    assert.throws(() => createReceipt(dir, planning()), (e) => e.code === 'EXISTS');
  });

  test('.strict(): an unknown key is refused', () => {
    assert.throws(() => createReceipt(dir, planning({ surprise: 1 })), (e) => e.code === 'INVALID_RECEIPT');
  });

  test('a decision with no gate (a refusal) cannot be written into a receipt', () => {
    const p = planning();
    p.selected[0].decision.gate = null;
    assert.throws(() => createReceipt(dir, p), (e) => e.code === 'INVALID_RECEIPT');
  });

  test('a planning field edited on disk is caught by the fingerprint', () => {
    const r = createReceipt(dir, planning());
    const file = receiptPath(dir, r.opId);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.selected[0].headOid = oid('2');
    fs.writeFileSync(file, JSON.stringify(json));
    assert.throws(() => readReceipt(dir, r.opId), (e) => e.code === 'FINGERPRINT_MISMATCH');
  });

  test('the fingerprint changes when any selected head changes, and not with key order', () => {
    const a = planning();
    const b = planning();
    b.selected[0].headOid = oid('2');
    assert.notEqual(fingerprintOf(a), fingerprintOf(b));
    const reordered = Object.fromEntries(Object.entries(planning()).reverse());
    assert.equal(fingerprintOf(reordered), fingerprintOf(a));
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  test('missing and unreadable receipts are distinct refusals', () => {
    assert.throws(() => readReceipt(dir, 's-20261011230000-0000'), (e) => e.code === 'NOT_FOUND');
  });
});

describe('update', () => {
  test('mutable fields can be appended; a legal phase move is recorded in history', () => {
    const r = createReceipt(dir, planning());
    const u = updateReceipt(dir, r.opId, (d) => { d.logPr = { number: 210, headOid: oid('3') }; d.phase = 'log-opened'; }, { note: 'log PR' });
    assert.equal(u.phase, 'log-opened');
    assert.deepEqual(u.logPr, { number: 210, headOid: oid('3') });
    assert.deepEqual(u.history.map((h) => h.phase), ['prepared', 'log-opened']);
  });

  test('a planning field cannot be rewritten through update', () => {
    const r = createReceipt(dir, planning());
    assert.throws(
      () => updateReceipt(dir, r.opId, (d) => { d.selected[0].decision.gate = 'passed'; }),
      (e) => e.code === 'IMMUTABLE_FIELD',
    );
    assert.equal(readReceipt(dir, r.opId).selected[0].decision.gate, 'converged');
  });

  test('an illegal phase move is refused (prepared → landed skips building and landing)', () => {
    const r = createReceipt(dir, planning());
    assert.throws(() => updateReceipt(dir, r.opId, (d) => { d.phase = 'landed'; }), (e) => e.code === 'ILLEGAL_TRANSITION');
  });

  test('abandon is legal before landing and illegal once landing has begun', () => {
    assert.ok(TRANSITIONS.built.includes('abandoned'));
    for (const p of ['landing', 'landed', 'verified', 'verified-interleaved', 'publishing', 'partial']) {
      assert.equal(TRANSITIONS[p].includes('abandoned'), false, p);
    }
  });

  test('every phase has a transition entry, and every target is a phase', () => {
    for (const p of PHASES) {
      assert.ok(Array.isArray(TRANSITIONS[p]), p);
      for (const t of TRANSITIONS[p]) assert.ok(PHASES.includes(t), `${p} → ${t}`);
    }
  });

  test('a second writer is refused, not queued', () => {
    const r = createReceipt(dir, planning());
    const lock = `${receiptPath(dir, r.opId)}.lock`;
    const outcome = withFileLockSync(lock, {}, () => {
      try {
        updateReceipt(dir, r.opId, (d) => { d.trainId = 't-20261011230000-0001'; });
        return 'wrote';
      } catch (e) {
        return e instanceof ReceiptError ? e.code : String(e);
      }
    });
    assert.deepEqual(outcome, { ok: true, value: 'LOCKED' });
    assert.equal(readReceipt(dir, r.opId).trainId, undefined);
  });
});
