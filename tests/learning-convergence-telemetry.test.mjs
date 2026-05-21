import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeConvergencePredictOutcome,
} from '../scripts/learning/backfill-outcomes.mjs';

import { buildDecisionKey } from '../scripts/lib/learning/decision-logger.mjs';

// ── decision_key shape ──────────────────────────────────────────────────

describe('convergence_predict / decision_key shape', () => {
  it('uses audit-bound format `<run>:<type>:r<round>:s<seq>`', () => {
    const k = buildDecisionKey({
      decisionType: 'convergence_predict',
      auditRunId: 'run-1',
      round: 2,
      sequence: 0,
    });
    assert.equal(k, 'run-1:convergence_predict:r2:s0');
  });

  it('emits one decision per round (different keys for different rounds)', () => {
    const r1 = buildDecisionKey({ decisionType: 'convergence_predict', auditRunId: 'r', round: 1, sequence: 0 });
    const r2 = buildDecisionKey({ decisionType: 'convergence_predict', auditRunId: 'r', round: 2, sequence: 0 });
    assert.notEqual(r1, r2);
  });
});

// ── computeConvergencePredictOutcome ────────────────────────────────────

describe('convergence_predict / outcome detector', () => {
  // M3 P3 — the function now uses `deps.getRunConvergence` (or
  // `deps.learningStore.getAuditRunConvergence`) instead of a raw
  // supabase client. Test injects the typed helper directly.

  it('returns null when no run-convergence helper is provided', async () => {
    assert.equal(await computeConvergencePredictOutcome({ audit_run_id: 'r', round: 1 }, {}), null);
  });

  it('returns null when audit_run_id missing', async () => {
    const getRunConvergence = async () => null;
    assert.equal(await computeConvergencePredictOutcome({ round: 1 }, { getRunConvergence }), null);
  });

  it('returns null when run still in flight (no convergence/rigor/final)', async () => {
    const getRunConvergence = mockRunConvergence({ roundConvergedAfter: null, rigorPressureRound: null, rounds: null });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 1 },
      { getRunConvergence }
    );
    assert.equal(r, null);
  });

  it('marks the convergence round as `converged-here`', async () => {
    const getRunConvergence = mockRunConvergence({ roundConvergedAfter: 3, rigorPressureRound: null, rounds: 3 });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 3 },
      { getRunConvergence }
    );
    assert.equal(r.action, 'converged-here');
    assert.equal(r.converged_at, 3);
    assert.equal(r.round, 3);
  });

  it('marks earlier rounds as `continued`', async () => {
    const getRunConvergence = mockRunConvergence({ roundConvergedAfter: 4, rigorPressureRound: null, rounds: 4 });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 2 },
      { getRunConvergence }
    );
    assert.equal(r.action, 'continued');
  });

  it('marks rounds at/past stopAt as `wasted`', async () => {
    const getRunConvergence = mockRunConvergence({ roundConvergedAfter: 3, rigorPressureRound: null, rounds: 4 });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 4 },
      { getRunConvergence }
    );
    assert.equal(r.action, 'wasted');
  });

  it('hit_max=true when rigor_pressure_round equals decision round', async () => {
    const getRunConvergence = mockRunConvergence({ roundConvergedAfter: null, rigorPressureRound: 3, rounds: 3 });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 3 },
      { getRunConvergence }
    );
    assert.ok(r);
    assert.equal(r.hit_max, true);
  });

  it('returns null when the helper throws (Supabase-error analog)', async () => {
    const getRunConvergence = async () => { throw new Error('oops'); };
    assert.equal(
      await computeConvergencePredictOutcome({ audit_run_id: 'r1', round: 1 }, { getRunConvergence }),
      null
    );
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

function mockRunConvergence(runRow) {
  return async () => runRow;
}
