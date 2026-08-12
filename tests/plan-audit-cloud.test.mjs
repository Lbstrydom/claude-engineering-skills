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

test('no-argument / missing-options calls never throw synchronously (destructure guards)', async () => {
  // The never-throws contract must hold BEFORE the try blocks too — a bare
  // destructure of undefined would throw synchronously and turn best-effort
  // telemetry into a crash of the audit it records (audit finding M2).
  const r = await registerPlanAuditRun();
  assert.deepEqual(r, { cloudRunId: null, cloudRepoId: null, planLinkLost: null });
  await completePlanAuditRun('some-run-id', { findings: [] }); // no stats arg
  await completePlanAuditRun(); // nothing at all
});
