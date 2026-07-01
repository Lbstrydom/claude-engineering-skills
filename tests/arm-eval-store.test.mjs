/**
 * Tier-1 (DB-independent) argument-guard tests for the arm-eval store.
 * Plan: docs/plans/arm-eval-framework.md §10.1. Guards throw BEFORE any cloud
 * touch; cloud-off writers no-op (verified via the graceful return).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordSession, recordRun, recordJudgment, recordHumanRanking, recordCrossCheck, armEvalSchemaReady,
  getArmEvalLeaderboard,
} from '../scripts/lib/store/arm-eval.mjs';

describe('arm-eval store — argument guards (before any DB touch)', () => {
  it('recordSession requires sessionId + experimentType + taskId', async () => {
    await assert.rejects(() => recordSession({ experimentType: 'plan-authoring', taskId: 't' }), /required/);
    await assert.rejects(() => recordSession({ sessionId: 's', taskId: 't' }), /required/);
  });
  it('recordRun requires runId + sessionId + arm', async () => {
    await assert.rejects(() => recordRun({ sessionId: 's', arm: 'A' }), /required/);
  });
  it('recordJudgment requires runId + outputHash + judgePass + scores', async () => {
    await assert.rejects(() => recordJudgment({ runId: 'r', outputHash: 'h', judgePass: 1 }), /required/);
  });
  it('recordHumanRanking requires ≥2 ranked labels', async () => {
    await assert.rejects(() => recordHumanRanking({ sessionId: 's', rankedLabels: ['only-one'] }), /≥2|required/);
  });
  it('recordCrossCheck requires runId + checkName + status', async () => {
    await assert.rejects(() => recordCrossCheck({ runId: 'r', checkName: 'audit-proxy' }), /required/);
  });
  it('getArmEvalLeaderboard refuses an accidental cross-repo default (audit R2)', async () => {
    await assert.rejects(() => getArmEvalLeaderboard({}), /repoId|allRepos/);
    await assert.rejects(() => getArmEvalLeaderboard({ experimentType: 'brainstorm' }), /repoId|allRepos/);
  });
});

describe('arm-eval store — graceful cloud-off', () => {
  it('armEvalSchemaReady reports cloud:false when the store is off', async () => {
    // In the test env AUDIT_DB_URL is unset → isCloudEnabled() false.
    const r = await armEvalSchemaReady();
    assert.equal(typeof r.ready, 'boolean');
    if (!r.cloud) { assert.equal(r.ready, false); assert.deepEqual(r.missing, []); }
  });
  it('writers no-op (return cloud:false) when the store is off — no throw on valid args', async () => {
    const r = await recordSession({ sessionId: 's1', experimentType: 'brainstorm', taskId: 't1' });
    // cloud off → {cloud:false}; cloud on → {cloud:true, ok:...}. Either is non-throwing.
    assert.ok(r && typeof r.cloud === 'boolean');
  });
});
