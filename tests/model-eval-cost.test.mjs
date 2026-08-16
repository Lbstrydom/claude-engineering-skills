/**
 * @fileoverview `cost.mjs` — usage-event assembly and cost-row schemas.
 *
 * Split out of `tests/model-eval-core.test.mjs` (Phase 5, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/model-eval-cost
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleCostRows, buildUsageEvent, ModelEvalUsageEventSchema, CostRowSchema,
} from '../scripts/lib/model-eval/cost.mjs';

describe('cost.mjs', () => {
  test('assembleCostRows never collapses events across different runs', () => {
    const eventA = buildUsageEvent({ runId: 'run-1', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100, output_tokens: 50 } });
    const eventB = buildUsageEvent({ runId: 'run-2', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100, output_tokens: 50 } });
    const rows = assembleCostRows([eventA, eventB]);
    assert.equal(rows.length, 2);
  });

  test('buildUsageEvent persists pricingModel on the returned event, not just resolvedModel (round-6 M2 regression guard)', () => {
    const event = buildUsageEvent({ runId: 'run-3', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'azure-deployment-xyz', pricingModel: 'gpt-5.5', deploymentId: 'azure-deployment-xyz', provider: 'azure', usage: { input_tokens: 100, output_tokens: 50 } });
    assert.equal(event.pricingModel, 'gpt-5.5');
    assert.notEqual(event.pricingModel, event.resolvedModel);
  });

  test('a null/missing provider usage is tagged usageStatus:"missing" and never priced, not silently treated as zero cost (round-9 H11 regression guard)', () => {
    const event = buildUsageEvent({ runId: 'run-7', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: null });
    assert.equal(event.usageStatus, 'missing');
    assert.equal(event.costUsd, null);
    // A real, captured usage response still prices normally.
    const captured = buildUsageEvent({ runId: 'run-8', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100, output_tokens: 50 } });
    assert.equal(captured.usageStatus, 'captured');
  });

  test('usageStatus:"missing" paired with a non-null costUsd is rejected at the schema boundary (round-9 H11 regression guard)', () => {
    const base = { runId: 'run-9', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', provider: 'openai', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, inputTokens: 0, outputTokens: 0, priceTableVersion: 'v1', capturedAt: null };
    assert.throws(() => ModelEvalUsageEventSchema.parse({ ...base, usageStatus: 'missing', costUsd: 1.5 }));
    assert.doesNotThrow(() => ModelEvalUsageEventSchema.parse({ ...base, usageStatus: 'missing', costUsd: null }));
  });

  test('a non-numeric token field value is tagged "missing", not silently coerced (round-13 H4 regression guard)', () => {
    const badType = buildUsageEvent({ runId: 'run-16', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 'not-a-number', output_tokens: 50 } });
    assert.equal(badType.usageStatus, 'missing');
    assert.equal(badType.costUsd, null);
  });

  test('a negative token count is also tagged "missing", not clamped-then-treated-as-captured (round-14 M3/M4 regression guard)', () => {
    const negative = buildUsageEvent({ runId: 'run-17', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: -5, output_tokens: 50 } });
    assert.equal(negative.usageStatus, 'missing');
    assert.equal(negative.costUsd, null);
  });

  test('a non-null but unrecognized/empty usage object is also tagged usageStatus:"missing" (round-10 H2/H4 regression guard)', () => {
    const emptyObj = buildUsageEvent({ runId: 'run-11', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: {} });
    assert.equal(emptyObj.usageStatus, 'missing');
    assert.equal(emptyObj.costUsd, null);
    const unrecognizedShape = buildUsageEvent({ runId: 'run-12', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { totally_unrecognized_field: 5 } });
    assert.equal(unrecognizedShape.usageStatus, 'missing');
  });

  test('a one-sided usage object (only input OR only output tokens) is also tagged "missing" (round-11 H4 regression guard)', () => {
    const inputOnly = buildUsageEvent({ runId: 'run-13', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100 } });
    assert.equal(inputOnly.usageStatus, 'missing');
    const outputOnly = buildUsageEvent({ runId: 'run-14', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { output_tokens: 50 } });
    assert.equal(outputOnly.usageStatus, 'missing');
    const both = buildUsageEvent({ runId: 'run-15', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100, output_tokens: 50 } });
    assert.equal(both.usageStatus, 'captured');
  });

  test('a negative or non-finite costUsd is rejected (round-6 M1 regression guard)', () => {
    const base = { runId: 'run-4', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', provider: 'openai', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, usageStatus: 'captured', inputTokens: 1, outputTokens: 1, priceTableVersion: 'v1', capturedAt: null };
    assert.throws(() => ModelEvalUsageEventSchema.parse({ ...base, costUsd: -1 }));
    assert.throws(() => ModelEvalUsageEventSchema.parse({ ...base, costUsd: Infinity }));
  });

  test('a malformed (non-ISO) capturedAt string is rejected (round-7 L1 regression guard)', () => {
    const base = { runId: 'run-5', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', provider: 'openai', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, usageStatus: 'captured', inputTokens: 1, outputTokens: 1, priceTableVersion: 'v1', costUsd: null };
    assert.throws(() => ModelEvalUsageEventSchema.parse({ ...base, capturedAt: 'not-a-timestamp' }));
    assert.doesNotThrow(() => ModelEvalUsageEventSchema.parse({ ...base, capturedAt: new Date(0).toISOString() }));
    assert.doesNotThrow(() => ModelEvalUsageEventSchema.parse({ ...base, capturedAt: null }));
  });

  test('a cost row with contradictory costStatus/totalUsd is rejected (round-7 M2 regression guard)', () => {
    const base = { runId: 'run-6', role: 'auditor', armId: null, candidateRef: 'cand-1', byPhase: { generation: { usd: 5, status: 'available' } } };
    assert.throws(() => CostRowSchema.parse({ ...base, costStatus: 'available', totalUsd: null }));
    assert.throws(() => CostRowSchema.parse({ ...base, costStatus: 'unavailable', totalUsd: 5 }));
    assert.doesNotThrow(() => CostRowSchema.parse({ ...base, costStatus: 'available', totalUsd: 5 }));
  });

  test('a cost row whose totalUsd does not match the sum of its byPhase entries is rejected (round-10 M2 regression guard)', () => {
    const base = { runId: 'run-10', role: 'auditor', armId: null, candidateRef: 'cand-1', costStatus: 'available' };
    assert.throws(() => CostRowSchema.parse({ ...base, totalUsd: 5, byPhase: { generation: { usd: 3, status: 'available' } } }));
    assert.doesNotThrow(() => CostRowSchema.parse({ ...base, totalUsd: 5, byPhase: { generation: { usd: 3, status: 'available' }, extraction: { usd: 2, status: 'available' } } }));
  });

  test('costStatus:"available" with an unpriced byPhase entry is rejected — the sum-check no longer skips itself (r15h2costrowagg)', () => {
    const base = { runId: 'run-15', role: 'auditor', armId: null, candidateRef: 'cand-1' };
    // The old guard was `if (phaseValues.every(p => p.usd != null))`, i.e. it
    // disabled itself in exactly the case below, leaving an internally
    // contradictory row schema-valid and never reconciled.
    assert.throws(() => CostRowSchema.parse({
      ...base, costStatus: 'available', totalUsd: 3,
      byPhase: { generation: { usd: 3, status: 'available' }, extraction: { usd: null, status: 'unavailable' } },
    }), /every byPhase entry to be priced/);
    // an 'unavailable' row may still carry unpriced phases — nothing to sum
    assert.doesNotThrow(() => CostRowSchema.parse({
      ...base, costStatus: 'unavailable', totalUsd: null,
      byPhase: { generation: { usd: 3, status: 'available' }, extraction: { usd: null, status: 'unavailable' } },
    }));
  });

  test('the reciprocal also holds: an "unavailable" row with every phase priced is rejected (audit R1 M4)', () => {
    const base = { runId: 'run-15c', role: 'auditor', armId: null, candidateRef: 'cand-1' };
    // assembleCostRows sets 'unavailable' BECAUSE a phase was unpriced, so a
    // row claiming it while pricing every phase contradicts the status itself.
    assert.throws(() => CostRowSchema.parse({
      ...base, costStatus: 'unavailable', totalUsd: null,
      byPhase: { generation: { usd: 3, status: 'available' }, judge: { usd: 2, status: 'available' } },
    }), /at least one byPhase entry with status/);
    // an empty byPhase makes no claim either way and stays legal
    assert.doesNotThrow(() => CostRowSchema.parse({ ...base, costStatus: 'unavailable', totalUsd: null, byPhase: {} }));
  });

  test('byPhase keys are constrained to the phase enum but the map stays SPARSE (r15m2phaseenum)', () => {
    const base = { runId: 'run-15b', role: 'auditor', armId: null, candidateRef: 'cand-1', costStatus: 'available' };
    // Constrained: an off-vocabulary key is rejected (it never was before).
    assert.throws(() => CostRowSchema.parse({ ...base, totalUsd: 3, byPhase: { bogus_phase: { usd: 3, status: 'available' } } }));
    // Sparse: assembleCostRows only creates a key for a phase that actually
    // emitted events, so these must parse. `z.record(PhaseEnum, …)` — the
    // obvious fix — is EXHAUSTIVE in Zod 4 and would reject both.
    assert.doesNotThrow(() => CostRowSchema.parse({ ...base, totalUsd: 3, byPhase: { generation: { usd: 3, status: 'available' } } }));
    assert.doesNotThrow(() => CostRowSchema.parse({ ...base, totalUsd: 5, byPhase: { generation: { usd: 3, status: 'available' }, judge: { usd: 2, status: 'available' } } }));
    assert.doesNotThrow(() => CostRowSchema.parse({
      ...base, totalUsd: 6,
      byPhase: { generation: { usd: 1, status: 'available' }, extraction: { usd: 2, status: 'available' }, judge: { usd: 3, status: 'available' } },
    }));
  });
});
