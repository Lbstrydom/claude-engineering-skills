import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildShadowCtx, compareAuditRunResults, runShadowTieredPipeline,
  appendShadowLog, runTieredShadowComparison,
} from '../scripts/lib/audit/tiered-shadow-compare.mjs';

describe('buildShadowCtx', () => {
  test('disables every ledger/debt write path — the load-bearing safety property', () => {
    const ctx = { runId: 'r1', ledgerFile: '/real/ledger.json', planContent: 'x', changedFiles: ['a.js'] };
    const shadow = buildShadowCtx(ctx);
    assert.equal(shadow.ledgerFile, null);
    assert.equal(shadow.noLedger, true);
    assert.equal(shadow.noDebtLedger, true);
    assert.equal(shadow.readOnlyDebt, true);
  });

  test('preserves read-only inputs unchanged (same commit, same diff)', () => {
    const ctx = { runId: 'r1', planContent: 'plan text', changedFiles: ['a.js', 'b.js'], diffText: 'diff' };
    const shadow = buildShadowCtx(ctx);
    assert.equal(shadow.planContent, 'plan text');
    assert.deepEqual(shadow.changedFiles, ['a.js', 'b.js']);
    assert.equal(shadow.diffText, 'diff');
  });

  test('runId is suffixed, never collides with the real run', () => {
    const shadow = buildShadowCtx({ runId: 'abc123' });
    assert.equal(shadow.runId, 'abc123-shadow');
  });
});

describe('compareAuditRunResults', () => {
  const finding = (detail, severity = 'HIGH') => ({ category: 'bug', section: 'x.js', detail, severity });

  test('counts overlap/only-legacy/only-tiered via semanticId content-hash, not identity', () => {
    const legacy = { findings: [finding('shared bug'), finding('legacy-only bug')], runStatus: 'complete', _usage: { costUsd: 1.5 }, _pass_timings: { total: '10.0s' } };
    const tiered = { findings: [finding('shared bug'), finding('tiered-only bug')], runStatus: 'complete', _usage: { costUsd: 0.5 }, _pass_timings: { total: '4.0s' } };
    const cmp = compareAuditRunResults(legacy, tiered);
    assert.equal(cmp.legacyFindingCount, 2);
    assert.equal(cmp.tieredFindingCount, 2);
    assert.equal(cmp.overlapCount, 1);
    assert.equal(cmp.onlyLegacyCount, 1);
    assert.equal(cmp.onlyTieredCount, 1);
  });

  test('cost and latency deltas read from the shared _usage/_pass_timings contract', () => {
    const legacy = { findings: [], runStatus: 'complete', _usage: { costUsd: 2 }, _pass_timings: { total: '12.5s' } };
    const tiered = { findings: [], runStatus: 'complete', _usage: { costUsd: 0.8 }, _pass_timings: { total: '5.1s' } };
    const cmp = compareAuditRunResults(legacy, tiered);
    assert.equal(cmp.legacyCostUsd, 2);
    assert.equal(cmp.tieredCostUsd, 0.8);
    assert.equal(cmp.legacyLatencySec, 12.5);
    assert.equal(cmp.tieredLatencySec, 5.1);
  });

  test('missing/malformed cost or timing fields resolve to null, never a fabricated 0', () => {
    const cmp = compareAuditRunResults({ findings: [] }, { findings: [] });
    assert.equal(cmp.legacyCostUsd, null);
    assert.equal(cmp.legacyLatencySec, null);
  });

  test('runStatus is passed through for fallback_legacy visibility', () => {
    const cmp = compareAuditRunResults({ findings: [], runStatus: 'complete' }, { findings: [], runStatus: 'fallback_legacy' });
    assert.equal(cmp.legacyRunStatus, 'complete');
    assert.equal(cmp.tieredRunStatus, 'fallback_legacy');
  });
});

describe('runShadowTieredPipeline', () => {
  test('never throws — a provider error resolves ok:false, not a rejection', async () => {
    const outcome = await runShadowTieredPipeline({ runId: 'r1' }, {
      runTieredAuditPipeline: async () => { throw new Error('provider exploded'); },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /provider exploded/);
    assert.equal(typeof outcome.latencyMs, 'number');
  });

  test('a hung pipeline times out rather than hanging forever', async () => {
    const outcome = await runShadowTieredPipeline({ runId: 'r1' }, {
      runTieredAuditPipeline: () => new Promise(() => {}), // never resolves
      timeoutMs: 20,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /timed out/);
  });

  test('success resolves ok:true with the real result', async () => {
    const fakeResult = { findings: [], runStatus: 'complete' };
    const outcome = await runShadowTieredPipeline({ runId: 'r1' }, {
      runTieredAuditPipeline: async () => fakeResult,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result, fakeResult);
  });

  // Regression (found live 2026-07-13, running this exact suite): the losing
  // side of Promise.race left an uncleared setTimeout handle, keeping the
  // event loop alive for the full default timeout (20 min) after a FAST
  // success — every caller (including this test file's own run) would hang.
  // A default-timeout call must not keep the process alive once resolved.
  test('a fast success does not leave a dangling timer alive (would hang the process at the default 20-min timeout otherwise)', async () => {
    const before = process._getActiveHandles ? process._getActiveHandles().length : null;
    await runShadowTieredPipeline({ runId: 'r1' }, { runTieredAuditPipeline: async () => ({ findings: [] }) });
    if (before !== null) {
      const after = process._getActiveHandles().length;
      assert.ok(after <= before, `expected no net-new active handles after a fast success, before=${before} after=${after}`);
    }
  });

  test('the pipeline is invoked with a shadow-safe ctx (ledgerFile disabled)', async () => {
    let capturedCtx = null;
    await runShadowTieredPipeline({ runId: 'r1', ledgerFile: '/real/ledger.json' }, {
      runTieredAuditPipeline: async (ctx) => { capturedCtx = ctx; return { findings: [] }; },
    });
    assert.equal(capturedCtx.ledgerFile, null);
  });
});

describe('appendShadowLog + runTieredShadowComparison (file I/O)', () => {
  let dir, logPath;
  test('writes one JSON record per call, creating the parent dir', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-shadow-'));
    logPath = path.join(dir, 'nested', 'log.jsonl');
    appendShadowLog({ a: 1 }, logPath);
    appendShadowLog({ a: 2 }, logPath);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].a, 1);
    assert.equal(lines[1].a, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a write failure is swallowed, never thrown (fail-open telemetry)', () => {
    assert.doesNotThrow(() => appendShadowLog({ a: 1 }, '\0invalid\0path'));
  });

  test('runTieredShadowComparison: successful shadow + legacy writes a full comparison record', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-shadow-'));
    logPath = path.join(dir, 'log.jsonl');
    const legacyResultPromise = Promise.resolve({ findings: [], runStatus: 'complete', _usage: { costUsd: 1 }, _pass_timings: { total: '5.0s' } });
    await runTieredShadowComparison({
      ctx: { runId: 'r1' },
      legacyResultPromise,
      runTieredAuditPipeline: async () => ({ findings: [], runStatus: 'complete', _usage: { costUsd: 0.3 }, _pass_timings: { total: '2.0s' } }),
      logPath,
    });
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(record.legacyOk, true);
    assert.equal(record.shadowOk, true);
    assert.ok(record.comparison);
    assert.equal(record.comparison.legacyCostUsd, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a legacy failure is recorded with comparison:null, never a crash', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-shadow-'));
    logPath = path.join(dir, 'log.jsonl');
    await runTieredShadowComparison({
      ctx: { runId: 'r1' },
      legacyResultPromise: Promise.reject(new Error('legacy blew up')),
      runTieredAuditPipeline: async () => ({ findings: [] }),
      logPath,
    });
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(record.legacyOk, false);
    assert.equal(record.comparison, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a shadow failure is recorded with shadowOk:false + shadowError, comparison:null', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-shadow-'));
    logPath = path.join(dir, 'log.jsonl');
    await runTieredShadowComparison({
      ctx: { runId: 'r1' },
      legacyResultPromise: Promise.resolve({ findings: [], runStatus: 'complete' }),
      runTieredAuditPipeline: async () => { throw new Error('tiered blew up'); },
      logPath,
    });
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(record.legacyOk, true);
    assert.equal(record.shadowOk, false);
    assert.match(record.shadowError, /tiered blew up/);
    assert.equal(record.comparison, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
