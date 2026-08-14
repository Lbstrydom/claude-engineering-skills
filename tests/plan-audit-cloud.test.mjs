/**
 * @fileoverview DB-free tests for the plan-audit cloud-run registration seam
 * (scripts/lib/audit/plan-audit-cloud.mjs). Per testing doctrine (Tier 2 —
 * LLM/cloud orchestration seams): assert INVARIANTS, not mocked round trips.
 * The load-bearing invariants: cloud-off degrades to nulls without throwing,
 * and a null/malformed input never turns best-effort telemetry into a crash
 * of the plan audit it merely records. Real INSERT behaviour is covered by
 * the empirical-verify doctrine (a live plan-audit run), not a mock.
 */
process.env.AUDIT_DB_URL = ''; // must precede the dynamic import below

const { registerPlanAuditRun, completePlanAuditRun, planRunCostUsd } =
  await import('../scripts/lib/audit/plan-audit-cloud.mjs');
const { costFromUsage } = await import('../scripts/lib/model-pricing.mjs');

import test from 'node:test';
import assert from 'node:assert/strict';

// `planLinkLost` joined the return shape on 2026-08-12 (durability plan
// decision 6). It is null on every degraded path asserted below and carries a
// message ONLY when the plan upsert failed against a REACHABLE store — the
// whole point being that "no plan linkage" and "lost plan linkage" stop sharing
// a value. deepEqual is kept (rather than relaxed to a subset match) precisely
// so a future field cannot be added to this contract unnoticed.
test('registerPlanAuditRun: cloud off → nulls incl. planLinkLost, never throws', async () => {
  const r = await registerPlanAuditRun({
    repoProfile: { repoFingerprint: 'x' },
    planFile: 'docs/plans/example.md',
  });
  assert.deepEqual(r, { cloudRunId: null, cloudRepoId: null, planLinkLost: null });
});

test('registerPlanAuditRun: null repoProfile → nulls, never throws', async () => {
  const r = await registerPlanAuditRun({ repoProfile: null, planFile: 'docs/plans/example.md' });
  assert.deepEqual(r, { cloudRunId: null, cloudRepoId: null, planLinkLost: null });
});

test('completePlanAuditRun: null runId is a silent no-op', async () => {
  await completePlanAuditRun(null, { findings: [] }, { round: 1 });
});

test('completePlanAuditRun: malformed result (no findings array) is a silent no-op', async () => {
  await completePlanAuditRun('some-run-id', { verdict: 'APPROVED' }, { round: 1 });
  await completePlanAuditRun('some-run-id', null, { round: 1 });
});

// ── Plan-run pricing (2026-08-14) ────────────────────────────────────────
// Regression cover for: `audit_runs.total_cost_estimate` was NULL on every
// plan run ever recorded (0 of 55 priced, vs 136 of 178 code runs), because
// `costEstimate` defaulted to null here and the sole call site never passed
// it. The fix DERIVES the cost from `result._usage` so the omission is
// unrepresentable; these assert the derivation, both directions.
//
// A real plan-audit `_usage` payload, copied from
// .audit/audit-plan-1786349000-r3-result.json — a shape production actually
// emitted, not one invented from the reader's expectations.
const REAL_PLAN_USAGE = {
  input_tokens: 23905, cached_tokens: 1343, output_tokens: 8558,
  reasoning_tokens: 5502, latency_ms: 97232,
};

test('planRunCostUsd: a real plan-audit usage payload prices to a positive number', () => {
  const usd = planRunCostUsd({ _usage: REAL_PLAN_USAGE }, 'gpt-5.6-terra');
  assert.equal(typeof usd, 'number', 'a metered run against a priced model must produce a number');
  assert.ok(usd > 0, `expected a positive cost, got ${usd}`);
  // The value must be the pricing module's answer, not an independent
  // re-derivation that could drift from it.
  assert.equal(usd, costFromUsage(REAL_PLAN_USAGE, 'gpt-5.6-terra').totalUsd);
});

test('planRunCostUsd: unknown is null, never 0 (the anti-green invariant)', () => {
  // No usage at all — unmetered. `0` here would read as "this run was free",
  // which is the exact misreading that hid the original defect.
  assert.equal(planRunCostUsd({ findings: [] }, 'gpt-5.6-terra'), null);
  assert.equal(planRunCostUsd(null, 'gpt-5.6-terra'), null);
  assert.equal(planRunCostUsd({ _usage: null }, 'gpt-5.6-terra'), null);
  // Metered, but against a model absent from the pricing table.
  assert.equal(planRunCostUsd({ _usage: REAL_PLAN_USAGE }, '<unpriced-model>'), null);
});

test('planRunCostUsd: negative control — the assertion can fail', () => {
  // Guards against a vacuous pass: if `costFromUsage` ever started returning 0
  // or null for a priced model, the positive test above must break rather than
  // quietly agree. Proven here by asserting the distinguishing property
  // directly on a payload that MUST price.
  const priced = planRunCostUsd({ _usage: REAL_PLAN_USAGE }, 'gpt-5.6-terra');
  const unpriced = planRunCostUsd({ _usage: REAL_PLAN_USAGE }, '<unpriced-model>');
  assert.notEqual(priced, unpriced, 'priced and unpriced must not collapse to the same value');
  assert.notEqual(priced, 0, 'a metered run must never price as exactly free');
});

test('no-argument / missing-options calls never throw synchronously (destructure guards)', async () => {
  // The never-throws contract must hold BEFORE the try blocks too — a bare
  // destructure of undefined would throw synchronously and turn best-effort
  // telemetry into a crash of the audit it records (audit finding M2).
  const r = await registerPlanAuditRun();
  assert.deepEqual(r, { cloudRunId: null, cloudRepoId: null, planLinkLost: null });
  await completePlanAuditRun('some-run-id', { findings: [] }); // no stats arg
  await completePlanAuditRun(); // nothing at all
});
