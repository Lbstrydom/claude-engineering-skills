/**
 * @fileoverview Unit tests for the pass_selection outcome detector
 * (Cluster B / Phase 4, plan R1-H7). Pure — outcome counts are injected, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePassSelectionOutcome } from '../scripts/learning/backfill-outcomes.mjs';

const withCounts = (counts) => ({ getOutcomeCounts: async () => counts });

test('no audit_run_id → null (cannot resolve)', async () => {
  assert.equal(await computePassSelectionOutcome({}, withCounts({ total: 3, acceptedOrFixed: 2, anyAdjudicated: true })), null);
});

test('findings exist but none adjudicated yet → pending (null) — Phase-3 coupling', async () => {
  const r = await computePassSelectionOutcome({ audit_run_id: 'run1' }, withCounts({ total: 5, acceptedOrFixed: 0, anyAdjudicated: false }));
  assert.equal(r, null, 'must stay pending until outcome-sync labels the findings');
});

test('zero-findings guard → terminal low-yield, reward 0 (no division-by-zero)', async () => {
  const r = await computePassSelectionOutcome({ audit_run_id: 'run1' }, withCounts({ total: 0, acceptedOrFixed: 0, anyAdjudicated: false }));
  assert.equal(r.action, 'low-yield');
  assert.equal(r.reward, 0);
  assert.equal(r.total, 0);
});

test('reward >= 0.5 → useful', async () => {
  const r = await computePassSelectionOutcome({ audit_run_id: 'run1' }, withCounts({ total: 4, acceptedOrFixed: 3, anyAdjudicated: true }));
  assert.equal(r.action, 'useful');
  assert.equal(r.reward, 0.75);
  assert.equal(r.accepted_or_fixed, 3);
});

test('reward < 0.5 → low-yield', async () => {
  const r = await computePassSelectionOutcome({ audit_run_id: 'run1' }, withCounts({ total: 10, acceptedOrFixed: 2, anyAdjudicated: true }));
  assert.equal(r.action, 'low-yield');
  assert.equal(r.reward, 0.2);
});

test('counts getter throwing → null (graceful)', async () => {
  const r = await computePassSelectionOutcome({ audit_run_id: 'run1' }, { getOutcomeCounts: async () => { throw new Error('db down'); } });
  assert.equal(r, null);
});

test('null counts (cloud off) → null', async () => {
  assert.equal(await computePassSelectionOutcome({ audit_run_id: 'run1' }, withCounts(null)), null);
});
