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

const { registerPlanAuditRun, completePlanAuditRun } =
  await import('../scripts/lib/audit/plan-audit-cloud.mjs');

import test from 'node:test';
import assert from 'node:assert/strict';

test('registerPlanAuditRun: cloud off → {cloudRunId:null, cloudRepoId:null}, never throws', async () => {
  const r = await registerPlanAuditRun({
    repoProfile: { repoFingerprint: 'x' },
    planFile: 'docs/plans/example.md',
  });
  assert.deepEqual(r, { cloudRunId: null, cloudRepoId: null });
});

test('registerPlanAuditRun: null repoProfile → nulls, never throws', async () => {
  const r = await registerPlanAuditRun({ repoProfile: null, planFile: 'docs/plans/example.md' });
  assert.deepEqual(r, { cloudRunId: null, cloudRepoId: null });
});

test('completePlanAuditRun: null runId is a silent no-op', async () => {
  await completePlanAuditRun(null, { findings: [] }, { round: 1 });
});

test('completePlanAuditRun: malformed result (no findings array) is a silent no-op', async () => {
  await completePlanAuditRun('some-run-id', { verdict: 'APPROVED' }, { round: 1 });
  await completePlanAuditRun('some-run-id', null, { round: 1 });
});

test('no-argument / missing-options calls never throw synchronously (destructure guards)', async () => {
  // The never-throws contract must hold BEFORE the try blocks too — a bare
  // destructure of undefined would throw synchronously and turn best-effort
  // telemetry into a crash of the audit it records (audit finding M2).
  const r = await registerPlanAuditRun();
  assert.deepEqual(r, { cloudRunId: null, cloudRepoId: null });
  await completePlanAuditRun('some-run-id', { findings: [] }); // no stats arg
  await completePlanAuditRun(); // nothing at all
});
