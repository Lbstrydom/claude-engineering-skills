/**
 * @fileoverview Tier-1 pins for the gate-evidence marker writer.
 *
 * The defect: `AI-Gate: passed` was structurally UNREACHABLE. Two writers were
 * missing, and only one was obvious:
 *   1. `.audit/last-audit-run.json` — `resolveEvidence` read it; nothing wrote
 *      it (4 readers, 0 writers; the on-disk file was 6 weeks stale).
 *   2. `audit_runs.round_converged_after` — `recordConvergenceState` existed
 *      with ZERO callers; all 39 live rows had it NULL.
 * `evaluateGateVerification` requires BOTH, so fixing only (1) would have made
 * things worse: `fresh` evidence forbids `not-run`, while a missing verdict
 * still refuses `passed` — leaving `waived` as the only legal value on a
 * genuinely converged audit.
 *
 * The load-bearing discipline here: every schema assertion runs the marker
 * through the REAL validator (`resolveEvidence` / `evaluateGateVerification`),
 * never a restated copy of its rules. A test that re-encoded the schema could
 * drift from the validator and pass while the marker was rejected in
 * production — which is exactly how the original hole stayed invisible.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildGateEvidence, writeGateEvidence, GATE_EVIDENCE_RELPATH } from '../scripts/lib/audit/gate-evidence.mjs';
import { resolveEvidence, evaluateGateVerification, validateTrailerInput } from '../scripts/lib/commit-trailers.mjs';

const RUN_ID = '9f3c1d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';   // a real UUID shape
const HEAD_TS = Math.floor(Date.parse('2026-07-18T10:00:00.000Z') / 1000);

/** An in-memory fs stub exposing only what `resolveEvidence` uses. */
function fsStub(contents) {
  return {
    readFileSync(p) {
      if (!(p in contents)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      const v = contents[p];
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

describe('the marker the writer produces is ACCEPTED by the real validator', () => {
  test('a fresh marker resolves as fresh, carrying the runId through', () => {
    const payload = buildGateEvidence({ runId: RUN_ID, sid: 'audit-123', round: 2, nowIso: '2026-07-18T11:00:00.000Z' });
    const ev = resolveEvidence({
      auditRunPath: '/repo/.audit/last-audit-run.json',
      headCommitTs: HEAD_TS,
      fsMod: fsStub({ '/repo/.audit/last-audit-run.json': JSON.stringify(payload) }),
    });
    assert.equal(ev.state, 'fresh', 'the writer must emit something the reader calls fresh');
    assert.equal(ev.runId, RUN_ID);
  });

  test('the payload satisfies RUN_ID_RE and a parseable ts (via the validator, not a restated rule)', () => {
    const payload = buildGateEvidence({ runId: RUN_ID, nowIso: '2026-07-18T11:00:00.000Z' });
    const ev = resolveEvidence({
      auditRunPath: '/m.json', headCommitTs: HEAD_TS,
      fsMod: fsStub({ '/m.json': JSON.stringify(payload) }),
    });
    assert.notEqual(ev.state, 'malformed');
  });

  test('MIRROR: a marker written BEFORE HEAD reads as stale, not fresh', () => {
    // Without this the freshness assertion above could pass on a writer that
    // stamped a constant far-future ts.
    const payload = buildGateEvidence({ runId: RUN_ID, nowIso: '2026-07-18T09:00:00.000Z' });
    const ev = resolveEvidence({
      auditRunPath: '/m.json', headCommitTs: HEAD_TS,
      fsMod: fsStub({ '/m.json': JSON.stringify(payload) }),
    });
    assert.equal(ev.state, 'stale');
  });
});

describe('THE REACHABILITY PIN: passed is now attainable, and only with both halves', () => {
  const freshEv = () => resolveEvidence({
    auditRunPath: '/m.json', headCommitTs: HEAD_TS,
    fsMod: fsStub({ '/m.json': JSON.stringify(buildGateEvidence({ runId: RUN_ID, nowIso: '2026-07-18T11:00:00.000Z' })) }),
  });

  test('fresh marker + a converged store row → passed is ACCEPTED', () => {
    // The whole point of the change. Before it, no input could reach here.
    const err = evaluateGateVerification({
      gate: 'passed',
      evidence: freshEv(),
      cloudEnabled: true,
      convergence: { roundConvergedAfter: 2 },
    });
    assert.equal(err, null, 'a converged, cloud-verified audit must be able to say passed');
  });

  test('fresh marker + NON-converged row → passed refused (marker alone is never enough)', () => {
    const err = evaluateGateVerification({
      gate: 'passed', evidence: freshEv(), cloudEnabled: true,
      convergence: { roundConvergedAfter: null },   // the state ALL 39 live rows were in
    });
    assert.ok(err, 'a marker proves an audit RAN, never that it PASSED');
    assert.match(err.custom, /did not converge/);
  });

  test('fresh marker + cloud off → passed refused (unverifiable ≠ verified)', () => {
    const err = evaluateGateVerification({ gate: 'passed', evidence: freshEv(), cloudEnabled: false, convergence: null });
    assert.ok(err);
    assert.match(err.custom, /verification is unavailable/);
  });

  test('the marker also unblocks the OTHER direction: fresh evidence forbids not-run', () => {
    // This is why the two writers had to ship together. With the marker alone,
    // a converged audit could say neither `not-run` (forbidden by freshness)
    // nor `passed` (refused for want of a verdict).
    const res = validateTrailerInput(
      { skill: 'ship', modelsRaw: 'claude', gate: 'not-run', messageText: null, evidence: freshEv() },
      { skillNames: ['ship'] },
    );
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.field === 'gate-evidence'));
  });

  test('and a fresh marker + converged row passes full trailer validation', () => {
    const res = validateTrailerInput(
      { skill: 'ship', modelsRaw: 'claude,gpt,gemini', gate: 'passed', messageText: null, evidence: freshEv() },
      { skillNames: ['ship'] },
    );
    assert.equal(res.ok, true, res.errors.map((e) => e.custom || e.field).join('; '));
    assert.equal(res.values.runId, RUN_ID, 'the runId must flow into the AI-Run-ID trailer');
  });
});

describe('writeGateEvidence — when it writes, and when it stays silent', () => {
  const capture = () => {
    const writes = [];
    return { writes, adapters: { atomicWriteFileSync: (p, c) => writes.push({ p, c }) } };
  };

  test('writes for a cloud-backed CODE audit', () => {
    const { writes, adapters } = capture();
    const r = writeGateEvidence({ repoRoot: '/repo', runId: RUN_ID, mode: 'code', round: 1, adapters });
    assert.equal(r.written, true);
    assert.equal(writes.length, 1);
    assert.ok(writes[0].p.endsWith(GATE_EVIDENCE_RELPATH), `unexpected path ${writes[0].p}`);
    assert.equal(JSON.parse(writes[0].c).runId, RUN_ID);
  });

  test('does NOT write without a cloud run id (no verifiable evidence)', () => {
    // A marker whose runId the store cannot resolve reads `fresh` while
    // `passed` is refused — a confusing half-state. Silence is honest.
    const { writes, adapters } = capture();
    const r = writeGateEvidence({ repoRoot: '/repo', runId: null, mode: 'code', adapters });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'no-cloud-run-id');
    assert.equal(writes.length, 0);
  });

  test('does NOT write for a PLAN audit (the gate asserts the shipped CODE was audited)', () => {
    const { writes, adapters } = capture();
    const r = writeGateEvidence({ repoRoot: '/repo', runId: RUN_ID, mode: 'plan', adapters });
    assert.equal(r.written, false);
    assert.match(r.reason, /mode-not-code/);
    assert.equal(writes.length, 0);
  });

  test('a write failure degrades to not-run rather than failing the audit', () => {
    const logs = [];
    const r = writeGateEvidence({
      repoRoot: '/repo', runId: RUN_ID, mode: 'code',
      log: (m) => logs.push(m),
      adapters: { atomicWriteFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } },
    });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'write-failed');
    assert.match(logs.join(''), /not-run/);
  });

  test('round is normalised to a number-or-null (never NaN/undefined in the JSON)', () => {
    assert.equal(buildGateEvidence({ runId: RUN_ID, round: undefined }).round, null);
    assert.equal(buildGateEvidence({ runId: RUN_ID, round: 3 }).round, 3);
    assert.equal(JSON.parse(JSON.stringify(buildGateEvidence({ runId: RUN_ID }))).sid, null);
  });
});

describe('WIRING PIN: the audit pipeline actually calls the writer', () => {
  test('legacy-production-audit imports and invokes writeGateEvidence', async () => {
    // The class this repo keeps hitting: a correct module nobody calls
    // (`recordConvergenceState` sat unused for months). Pin the call site.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(import.meta.dirname, '../scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8');
    assert.match(src, /writeGateEvidence\(\{/, 'the marker writer must be invoked by the audit');
    assert.match(src, /recordConvergenceState\(cloudRunId/, 'the convergence verdict must be recorded');
  });
});
