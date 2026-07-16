/**
 * @fileoverview Tier-1 tests for the shared deterministic outcome finalize.
 * Plan: docs/plans/deterministic-outcome-capture.md (orchestrator-only v2).
 *
 * Hermetic: chdir to a temp tree; AUDIT_DB_URL unset so the cloud path uses the
 * injected MOCK store (never a real DB) and the needs-triage reconcile no-ops.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveAuditArtifacts,
  parseResultPath,
  loadAuditInputs,
  finalizeRoundOutcomes,
} from '../scripts/lib/finalize-outcomes.mjs';
import { generateTopicId } from '../scripts/lib/ledger.mjs';

let tmp, cwd0, dbUrl0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-'));
  fs.mkdirSync(path.join(tmp, '.audit'), { recursive: true });
  cwd0 = process.cwd();
  process.chdir(tmp);
  dbUrl0 = process.env.AUDIT_DB_URL;
  delete process.env.AUDIT_DB_URL; // force cloud-off for the direct reconcile call
});
afterEach(() => {
  process.chdir(cwd0);
  if (dbUrl0 === undefined) delete process.env.AUDIT_DB_URL;
  else process.env.AUDIT_DB_URL = dbUrl0;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** A finding + a ledger entry that rules it `accepted` (matched by topicId). */
function ruledPair(id, outcome = 'accepted') {
  const finding = {
    id, severity: 'HIGH', category: 'X', section: 'a.js',
    detail: `d-${id}`, _pass: 'backend', _primaryFile: 'a.js',
  };
  const entry = {
    topicId: generateTopicId(finding), findingId: id,
    adjudicationOutcome: outcome, remediationState: 'fixed', ruling: 'uphold',
  };
  return { finding, entry };
}

function outcomesLines() {
  try { return fs.readFileSync('.audit/outcomes.jsonl', 'utf-8').trim().split('\n').filter(Boolean); }
  catch { return []; }
}

describe('resolveAuditArtifacts (pure naming SSoT)', () => {
  it('maps -r3-result.json → -r2-result.json + sid', () => {
    const r = resolveAuditArtifacts({ outPath: '/tmp/sid-9-r3-result.json', round: 3 });
    assert.equal(path.basename(r.priorResultPath), 'sid-9-r2-result.json');
    assert.equal(r.sid, 'sid-9');
    assert.equal(r.priorRound, 2);
  });
  it('round 1 → no prior (null)', () => {
    assert.equal(resolveAuditArtifacts({ outPath: '/tmp/sid-r1-result.json', round: 1 }).priorResultPath, null);
  });
  it('non-matching stem → null (orchestrator no-op)', () => {
    assert.equal(resolveAuditArtifacts({ outPath: '/tmp/whatever.json', round: 2 }).priorResultPath, null);
  });
  it('filename round disagreeing with the round arg → null (drift no-op)', () => {
    // --out says r3 but the caller passed round=5 → artifact identity drifted.
    assert.equal(resolveAuditArtifacts({ outPath: '/tmp/sid-9-r3-result.json', round: 5 }).priorResultPath, null);
  });
});

describe('parseResultPath (sid + round, round-independent)', () => {
  it('extracts sid AND round for a result path', () => {
    assert.deepEqual(
      parseResultPath('/tmp/audit-code-42-r2-result.json'),
      { sid: 'audit-code-42', round: 2 },
    );
  });
  it('nulls for a non-matching path', () => {
    assert.deepEqual(parseResultPath('/tmp/whatever.json'), { sid: null, round: null });
    assert.deepEqual(parseResultPath(null), { sid: null, round: null });
  });
});

describe('loadAuditInputs (permissive, passthrough)', () => {
  it('loads + preserves underscore annotations; wraps bare-array ledger', () => {
    fs.writeFileSync('r.json', JSON.stringify({ findings: [{ id: 'A' }], _cloudRunId: 'run-1' }));
    fs.writeFileSync('l.json', JSON.stringify([{ topicId: 't', findingId: 'A' }]));
    const { result, ledger } = loadAuditInputs({ resultPath: 'r.json', ledgerPath: 'l.json' });
    assert.equal(result._cloudRunId, 'run-1'); // passthrough kept it
    assert.ok(Array.isArray(ledger.entries) && ledger.entries.length === 1);
  });
  it('rejects a result without a findings array', () => {
    fs.writeFileSync('bad.json', JSON.stringify({ nope: 1 }));
    fs.writeFileSync('l.json', JSON.stringify({ entries: [] }));
    assert.throws(() => loadAuditInputs({ resultPath: 'bad.json', ledgerPath: 'l.json' }));
  });
});

describe('finalizeRoundOutcomes', () => {
  it('cloud-off: writes local once + returns the documented shape', async () => {
    const { finding, entry } = ruledPair('A');
    const result = { findings: [finding] };
    const ledger = { entries: [entry] };
    const status = await finalizeRoundOutcomes({ result, ledger, round: 2, store: null, sid: 'sid-x' });
    assert.deepEqual(
      Object.keys(status).sort(),
      ['cloudOk', 'enriched', 'labelled', 'needsTriage', 'round', 'skippedLocal', 'total'].sort(),
    );
    assert.equal(status.labelled, 1);
    assert.equal(status.total, 1);
    assert.equal(status.cloudOk, false);
    assert.equal(outcomesLines().length, 1);
  });

  it('is idempotent: a second finalize for the same key does NOT double-append', async () => {
    const { finding, entry } = ruledPair('A');
    const result = { findings: [finding] };
    const ledger = { entries: [entry] };
    const first = await finalizeRoundOutcomes({ result, ledger, round: 2, store: null, sid: 'sid-x' });
    const second = await finalizeRoundOutcomes({ result, ledger, round: 2, store: null, sid: 'sid-x' });
    assert.equal(first.skippedLocal, false);
    assert.equal(second.skippedLocal, true);
    assert.equal(outcomesLines().length, 1, 'local append must happen exactly once per key');
  });

  it('cloud-on: drives the injected store per ruled finding (mock, no DB)', async () => {
    const calls = [];
    const store = {
      recordAdjudicationEvent: async (runId, fp, ev) => { calls.push({ runId, fp, ev }); return true; },
      updatePassStatsPostDeliberation: async () => true,
      updateRunMeta: async () => true,
    };
    const { finding, entry } = ruledPair('A', 'accepted');
    const result = { findings: [finding], _cloudRunId: 'run-7' };
    const ledger = { entries: [entry] };
    const status = await finalizeRoundOutcomes({ result, ledger, round: 2, store, sid: 'run-7' });
    assert.ok(calls.length >= 1, 'store.recordAdjudicationEvent must be called');
    assert.equal(calls[0].runId, 'run-7');
    assert.equal(status.labelled, 1);
  });

  it('un-ruled findings stay pending (not labelled)', async () => {
    const result = { findings: [{ id: 'Z', severity: 'LOW', category: 'X', section: 'z.js', _pass: 'backend' }] };
    const ledger = { entries: [] };
    const status = await finalizeRoundOutcomes({ result, ledger, round: 2, store: null, sid: 'sid-z' });
    assert.equal(status.labelled, 0);
    assert.equal(outcomesLines().length, 0, 'pending findings produce no local outcome');
  });
});
