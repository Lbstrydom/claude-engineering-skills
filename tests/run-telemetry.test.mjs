/**
 * @fileoverview Tier 1/2 unit tests for scripts/lib/audit/run-telemetry.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4d) — direct
 * coverage of this module's own exports. `runTelemetry` itself (the
 * observation/cloud-write stage) is covered end-to-end through
 * tests/finalization-characterization.test.mjs's golden-master harness
 * (cloud OFF, per this repo's no-whole-provider-mock testing doctrine) —
 * this file covers the guard function that IS independently testable:
 * `classifyShadowFailureSafe` takes an injectable import seam specifically
 * so its own recovery-failure path can be exercised without touching the
 * real audit-shadow.mjs module.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Air-gap the store (empty DSN = deliberate no-cloud; see AGENTS.md) and keep
// learning ENABLED so recordDecision actually enqueues — the parity tests
// below read the enqueued decisions back through flush() into a fake store.
process.env.AUDIT_DB_URL = '';
delete process.env.LEARNING_DISABLE;

const { classifyShadowFailureSafe, runTelemetry } = await import('../scripts/lib/audit/run-telemetry.mjs');
const { assembleFindings } = await import('../scripts/lib/audit/finding-assembly.mjs');
const logger = await import('../scripts/lib/learning/decision-logger.mjs');
const emptyWriteOutcomes = () => ({ written: 0, spilled: 0, lost: 0, skipped: 0, byWriter: {} });

describe('classifyShadowFailureSafe — guards its own recovery import', () => {
  it('falls back to a safe classification when the recovery import itself fails, instead of throwing', async () => {
    const originalErr = new Error('original shadow failure');
    const failingImporter = () => { throw new Error('module load failed'); };
    const { log, marker } = await classifyShadowFailureSafe(originalErr, failingImporter);
    assert.equal(marker, null);
    assert.match(log, /shadow failure classification unavailable/);
    assert.match(log, /original shadow failure/);
  });

  it('delegates to the real classifyShadowFailure when the import succeeds', async () => {
    const { classifyShadowFailure } = await import('../scripts/lib/audit-shadow.mjs');
    const originalErr = new Error('some shadow error');
    const direct = classifyShadowFailure(originalErr);
    const viaSafe = await classifyShadowFailureSafe(originalErr);
    assert.deepEqual(viaSafe, direct);
  });

  it('never throws, even when the recovery import\'s own error is not a real Error', async () => {
    const badImporter = () => { throw 'not an Error instance'; };
    const { log, marker } = await classifyShadowFailureSafe(new Error('x'), badImporter);
    assert.equal(marker, null);
    assert.equal(typeof log, 'string');
  });
});


// ═══════════════════════════════════════════════════════════════════════
// Telemetry / verdict parity (docs/plans/backlog-tooling-honesty.md §7,
// backlog row 723b5dc5). The convergence the telemetry records must be the
// SAME convergence the gate records — computed once in assembleFindings —
// never a local recount from raw f.severity.
// ═══════════════════════════════════════════════════════════════════════

const { minimalFinalizationData } = await import('./helpers/multi-pass-audit-fixtures.mjs');

/** The shared envelope, with a cloud run id + changed files so both telemetry blocks fire. */
const telemetryData = (overrides = {}) => minimalFinalizationData({
  changedFiles: ['a.mjs'], diffLinesChanged: 3, diffFilesChanged: 1,
  cloudRunId: '00000000-0000-4000-8000-000000000001',
  ...overrides,
});

// Two UNRELATED details: near-identical text is folded by the fuzzy dedup pass.
const DETAILS = { H1: 'unbounded retry loop on a 4xx response', H2: 'no-unused-vars: `tmp` is assigned but never read' };
function highFinding(id, extra = {}) {
  return {
    id, severity: 'HIGH', category: 'Test', section: 'a.mjs:1',
    detail: DETAILS[id], risk: 'r', recommendation: 'x',
    is_quick_fix: false, is_mechanical: false, principle: 'Test',
    classification: { sonarType: 'BUG', effort: 'MEDIUM', sourceKind: 'MODEL', sourceName: 'test' },
    ...extra,
  };
}

/** Run assembly + telemetry, then flush the logger into a capturing store. */
async function recordedDecisions(data) {
  logger._resetForTest();
  const assembled = await assembleFindings(data);
  const mergedResult = { findings: assembled.allFindings };
  await runTelemetry(data, assembled, mergedResult, { writeOutcomes: emptyWriteOutcomes() });
  const rows = [];
  await logger.flush({ store: { isCloudEnabled: async () => true, insertLearningDecision: async (e) => { rows.push(e); return true; } } });
  return { assembled, rows };
}

describe('runTelemetry — convergence parity with the verdict (723b5dc5)', () => {
  beforeEach(() => logger._resetForTest());

  it('a refuted HIGH and a LINTER HIGH do not count: verdict PASS, telemetry converged=true, highCount 0', async () => {
    const refuted = highFinding('H1', {
      verification: { verification: 'refuted', reason: 'test', verdictSeverity: 'LOW', countsTowardVerdict: false },
    });
    const linter = highFinding('H2', {
      classification: { sonarType: 'BUG', effort: 'LOW', sourceKind: 'LINTER', sourceName: 'eslint' },
    });
    const data = telemetryData({
      backendPassNames: ['backend'],
      backendResults: [{ result: { pass_name: 'backend', findings: [refuted, linter], quick_fix_warnings: [] }, usage: {}, latencyMs: 0 }],
    });
    const { assembled, rows } = await recordedDecisions(data);
    assert.equal(assembled.verdict, 'PASS', 'precondition: the real verdict excludes both findings');
    assert.equal(assembled.high, 0);

    const tier = rows.find((r) => r.decisionType === 'author_tier');
    assert.ok(tier, 'author_tier decision must be recorded when changedFiles is non-empty');
    assert.equal(tier.outcome.converged, true, 'telemetry must report the SAME convergence the verdict reached');

    const predict = rows.find((r) => r.decisionType === 'convergence_predict');
    assert.ok(predict, 'convergence_predict decision must be recorded');
    assert.equal(predict.context.highCount, 0, 'highCount must be the verdict count, not a raw f.severity recount');
    assert.equal(predict.context.totalFindings, 2, 'totalFindings still describes every finding');
  });

  it('zero counts but detectors unknown (R2+, suppression unavailable): telemetry converged=false, same reason as the gate', async () => {
    const data = telemetryData({ round: 2, isR2Plus: true, suppressionUnavailable: true });
    const { assembled, rows } = await recordedDecisions(data);
    assert.equal(assembled.high, 0);
    assert.equal(assembled.convergence.converged, false);
    assert.equal(assembled.convergence.reason, 'detector-not-run');

    const tier = rows.find((r) => r.decisionType === 'author_tier');
    assert.ok(tier);
    assert.equal(tier.outcome.converged, false, 'a count-only evaluator would say true here; the gate says detector-not-run');
  });
});
