import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Air-gap the cloud write `runTieredShadowComparison` now performs
// (2026-07-13 — real Supabase persistence added alongside the local log).
// Matches the EXISTING convention in run-multi-pass-code-audit-harness.test.mjs
// EXACTLY, including WHY it must be a dynamic import: a static
// `import ... from` is hoisted in ESM and evaluates before this file's own
// top-level body runs, so a plain env override placed above a static import
// would NOT reliably take effect first. Only a dynamic `await import()`,
// which executes in normal top-to-bottom order, guarantees the override
// lands before the module (and its store/db transitive imports) evaluates.
// Prior value captured + restored so this override never leaks into a
// differently-configured process.
const _priorAuditDbUrl = process.env.AUDIT_DB_URL;
process.env.AUDIT_DB_URL = '';
process.on('exit', () => {
  if (_priorAuditDbUrl === undefined) delete process.env.AUDIT_DB_URL;
  else process.env.AUDIT_DB_URL = _priorAuditDbUrl;
});

const {
  buildShadowCtx, compareAuditRunResults, runShadowTieredPipeline,
  appendShadowLog, runTieredShadowComparison,
} = await import('../scripts/lib/audit/tiered-shadow-compare.mjs');

describe('buildShadowCtx', () => {
  test('disables every ledger/debt write path — the load-bearing safety property', () => {
    const ctx = { runId: 'r1', ledgerFile: '/real/ledger.json', planContent: 'x', changedFiles: ['a.js'] };
    const shadow = buildShadowCtx(ctx);
    assert.equal(shadow.ledgerFile, null);
    assert.equal(shadow.noLedger, true);
    assert.equal(shadow.noDebtLedger, true);
    assert.equal(shadow.readOnlyDebt, true);
    assert.equal(shadow.noCloudRecording, true);
  });

  test('preserves read-only inputs unchanged (same commit, same diff)', () => {
    const ctx = { runId: 'r1', planContent: 'plan text', changedFiles: ['a.js', 'b.js'], diffText: 'diff' };
    const shadow = buildShadowCtx(ctx);
    assert.equal(shadow.planContent, 'plan text');
    assert.deepEqual(shadow.changedFiles, ['a.js', 'b.js']);
    assert.equal(shadow.diffText, 'diff');
  });

  test('runId is left unchanged — collision-avoidance is now noCloudRecording, not id-mangling', () => {
    // Previously suffixed to `${runId}-shadow` to dodge colliding with the
    // real run's audit_runs row — not a valid uuid, so every write attempt
    // failed loudly instead of writing nothing. noCloudRecording blocks the
    // write outright, so runId stays a valid, real id — still useful as a
    // local telemetry label (tiered-pipeline.mjs's `_sid`).
    const shadow = buildShadowCtx({ runId: 'abc123' });
    assert.equal(shadow.runId, 'abc123');
    assert.equal(shadow.noCloudRecording, true);
  });
});

// `runLegacyProductionAudit` is not exposed for dependency injection (a giant
// orchestrator reading real provider/store modules), and its cloud-recording
// block is only reachable with a live AUDIT_DB_URL — not hermetically
// unit-mockable (see run-unification.test.mjs's identical reasoning for
// recordRunStart). Static guard instead: pins that noCloudRecording is
// destructured with the correct default AND actually gates the block that
// sets cloudRepoId/cloudRunId, so a future refactor can't silently drop the
// check and resume trying (and failing) to write shadow-fallback audit_runs
// rows under an invalid `<uuid>-shadow` id.
describe('runLegacyProductionAudit — noCloudRecording wiring (static regression guard)', () => {
  test('noCloudRecording is destructured from ctx with a safe default', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8',
    );
    assert.match(src, /noCloudRecording\s*=\s*false/,
      'expected `noCloudRecording = false` in the ctx destructure');
  });

  test('the cloud-recording gate checks !noCloudRecording', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8',
    );
    assert.match(src, /if\s*\(!noCloudRecording\s*&&\s*\(await isCloudEnabled\(\)\)\s*&&\s*repoProfile\)/,
      'expected the cloud-recording block\'s entry condition to short-circuit on !noCloudRecording');
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

  // 2026-07-14 incident: the fallback reason was never persisted, so 20/20
  // silent fallbacks across two repos were invisible in stored telemetry —
  // confirming the cause required a live repro instead of a DB query.
  test('fallbackReason is passed through so a fallback is diagnosable without a live repro', () => {
    const cmp = compareAuditRunResults(
      { findings: [], runStatus: 'complete' },
      { findings: [], runStatus: 'fallback_legacy', fallbackReason: 'required generator failed: sonnet: boom' },
    );
    assert.equal(cmp.tieredFallbackReason, 'required generator failed: sonnet: boom');
  });

  test('fallbackReason is null (never undefined) when the tiered run completed normally', () => {
    const cmp = compareAuditRunResults({ findings: [], runStatus: 'complete' }, { findings: [], runStatus: 'complete' });
    assert.equal(cmp.tieredFallbackReason, null);
  });

  // 2026-07-15: two `complete` shadow runs landed with 0 tiered findings
  // against 8-14 legacy findings each — genuinely undiagnosable, because
  // neither generatorOutcomes nor the per-stage counts (both already
  // computed on the full tieredResult) were ever copied into the persisted
  // comparison. Same failure shape as the fallbackReason incident above:
  // the data existed in memory and was thrown away before it reached
  // storage. These two fields close that gap.
  test('generatorOutcomes and stageBreakdown are passed through so a 0-finding complete run is diagnosable', () => {
    const generatorOutcomes = [
      { model: 'z-ai/glm-5.2', role: 'required', status: 'succeeded', findingCount: 3 },
      { model: 'claude-sonnet-5', role: 'required', status: 'succeeded', findingCount: 2 },
    ];
    const stageBreakdown = {
      discoveryRawFindings: 5, stage0Verified: 0, stage0Rejected: 5,
      stage1MechanicalDismissed: 0, stage1Escalated: 0, stage1ConfirmedSurvivor: 0, stage1BudgetExhausted: 0,
      stage2Verified: 0, stage2Reversed: 0, stage2ConfirmedDismissal: 0, stage2MissedCandidate: 0, stage2Unresolved: 0,
    };
    const cmp = compareAuditRunResults(
      { findings: [], runStatus: 'complete' },
      { findings: [], runStatus: 'complete', generatorOutcomes, _stageBreakdown: stageBreakdown },
    );
    assert.deepEqual(cmp.tieredGeneratorOutcomes, generatorOutcomes);
    assert.deepEqual(cmp.tieredStageBreakdown, stageBreakdown);
    // This exact shape (5 raw findings, 0 verified by Stage 0) is what
    // "generators produced candidates but Stage 0 rejected all of them"
    // looks like — distinguishable now from "generators found nothing"
    // (discoveryRawFindings: 0), which was impossible before this fix.
    assert.equal(cmp.tieredStageBreakdown.discoveryRawFindings, 5);
    assert.equal(cmp.tieredStageBreakdown.stage0Verified, 0);
  });

  test('generatorOutcomes and stageBreakdown are null (never undefined) when absent', () => {
    const cmp = compareAuditRunResults({ findings: [] }, { findings: [] });
    assert.equal(cmp.tieredGeneratorOutcomes, null);
    assert.equal(cmp.tieredStageBreakdown, null);
  });
});

// tiered-pipeline.mjs's success-path return isn't hermetically unit-testable
// end-to-end (Stage 0/1/2 need real provider adapters + evidence-triage
// input shapes — see the Stage 2 fail-fast describe block below for why this
// file only injection-tests the entry guard). Static guard instead: pins
// that `_stageBreakdown` is built from the SAME variables as
// `overall_reasoning` immediately above it, so the two can't silently drift
// apart (e.g. a future edit changing what `overall_reasoning` counts
// without updating the structured mirror, or vice versa).
describe('runTieredAuditPipeline — _stageBreakdown wiring (static regression guard)', () => {
  test('_stageBreakdown counts use the same source variables as overall_reasoning', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf-8',
    );
    assert.match(src, /discoveryRawFindings:\s*rawFindings\.length/);
    assert.match(src, /stage0Verified:\s*stage0Verified\.length/);
    assert.match(src, /stage0Rejected:\s*envelopes\.length\s*-\s*stage0Verified\.length/);
    assert.match(src, /stage1MechanicalDismissed:\s*triageResult\.mechanicalDismissed\.length/);
    assert.match(src, /stage2Verified:\s*stage2Result\.verified\.length/);
    assert.match(src, /stage2Unresolved:\s*stage2Result\.unresolved\.length/);
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
