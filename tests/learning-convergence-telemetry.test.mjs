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
  it('returns null when client missing', async () => {
    assert.equal(await computeConvergencePredictOutcome({ audit_run_id: 'r', round: 1 }, {}), null);
  });

  it('returns null when audit_run_id missing', async () => {
    const client = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) };
    assert.equal(await computeConvergencePredictOutcome({ round: 1 }, { client }), null);
  });

  it('returns null when run still in flight (no convergence/rigor/final)', async () => {
    const client = mockClient({ round_converged_after: null, rigor_pressure_round: null, rounds: null });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 1 },
      { client }
    );
    assert.equal(r, null);
  });

  it('marks the convergence round as `converged-here`', async () => {
    const client = mockClient({ round_converged_after: 3, rigor_pressure_round: null, rounds: 3 });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 3 },
      { client }
    );
    assert.equal(r.action, 'converged-here');
    assert.equal(r.converged_at, 3);
    assert.equal(r.round, 3);
  });

  it('marks earlier rounds as `continued`', async () => {
    const client = mockClient({ round_converged_after: 4, rigor_pressure_round: null, rounds: 4 });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 2 },
      { client }
    );
    assert.equal(r.action, 'continued');
  });

  it('marks rounds at/past stopAt as `wasted`', async () => {
    // If stopAt = 3 and decisionRound = 4, the row's decision shouldn't
    // exist (we wouldn't have run round 4) — but if it does, classify as wasted.
    const client = mockClient({ round_converged_after: 3, rigor_pressure_round: null, rounds: 4 });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 4 },
      { client }
    );
    assert.equal(r.action, 'wasted');
  });

  it('hit_max=true when rigor_pressure_round equals decision round', async () => {
    const client = mockClient({ round_converged_after: null, rigor_pressure_round: 3, rounds: 3 });
    const r = await computeConvergencePredictOutcome(
      { audit_run_id: 'r1', round: 3 },
      { client }
    );
    assert.ok(r);
    assert.equal(r.hit_max, true);
  });

  it('returns null on Supabase error', async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: { message: 'oops' } }),
          }),
        }),
      }),
    };
    assert.equal(await computeConvergencePredictOutcome({ audit_run_id: 'r1', round: 1 }, { client }), null);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

function mockClient(runRow) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: runRow, error: null }),
        }),
      }),
    }),
  };
}
