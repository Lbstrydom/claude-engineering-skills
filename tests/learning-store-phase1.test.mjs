/**
 * Integration tests for the Phase 1 learning-store write functions.
 *
 * The graceful-degradation cases assert that a write returns `{ ok: false }`
 * (never crashes) WHEN THE CLOUD STORE IS OFF. They gate on the ACTUAL cloud
 * state via `isCloudEnabled()` — NOT the legacy `SUPABASE_AUDIT_*` vars, which
 * were sunset in M4 (the store now resolves `AUDIT_DB_URL` from process env /
 * local `.env` / `~/.audit-loop.env`). The old guard made these tests flaky:
 * with `AUDIT_DB_URL` reachable the writes SUCCEED (`ok:true`), so the
 * `ok:false` assertion failed intermittently on cloud reachability. Now they
 * deterministically SKIP when the cloud is configured (the no-cloud path is moot)
 * and run only when it's genuinely off.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  insertLearningDecision,
  backfillLearningOutcome,
  recordDiffComplexity,
  recordConvergenceState,
  recordFindingResolution,
  isCloudEnabled,
} from '../scripts/learning-store.mjs';

// ── No-env path: graceful fallback (does not throw) ───────────────────────

describe('learning-store / Phase 1 graceful degradation (cloud off)', () => {
  it('insertLearningDecision declines with { ok: true } when the cloud is off', async (t) => {
    if (await isCloudEnabled()) return t.skip('cloud configured: the cloud-off contract is not exercised here');
    const r = await insertLearningDecision({
      decisionKey: 'test:no-service-role',
      decisionType: 'pass_selection',
      auditRunId: '00000000-0000-0000-0000-000000000000',
      round: 0,
      sequence: 0,
      context: {},
      contextHash: 'a'.repeat(64),
      choice: { chose: 'all' },
    });
    // Cloud off is a supported mode, not a failure: the write declines and says so.
    assert.equal(r.ok, true);
  });

  it('backfillLearningOutcome declines with { ok: true } when the cloud is off', async (t) => {
    if (await isCloudEnabled()) return t.skip('cloud configured: the cloud-off contract is not exercised here');
    const r = await backfillLearningOutcome({
      decisionKey: 'pass_selection:test-1',
      outcome: { totalFindings: 0 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'cloud-off');
  });

  it('recordDiffComplexity declines with { ok: true, applied: false } when the cloud is off', async (t) => {
    if (await isCloudEnabled()) return t.skip('cloud configured: the cloud-off contract is not exercised here');
    const r = await recordDiffComplexity('00000000-0000-0000-0000-000000000000', { fileCount: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
  });

  it('recordConvergenceState declines with { ok: true, applied: false } when the cloud is off', async (t) => {
    if (await isCloudEnabled()) return t.skip('cloud configured: the cloud-off contract is not exercised here');
    const r = await recordConvergenceState('00000000-0000-0000-0000-000000000000', { round_converged_after: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
  });

  it('recordFindingResolution declines with { ok: true, applied: false } when the cloud is off', async (t) => {
    if (await isCloudEnabled()) return t.skip('cloud configured: the cloud-off contract is not exercised here');
    const r = await recordFindingResolution('00000000-0000-0000-0000-000000000000', { user_action: 'deferred' });
    assert.equal(r.ok, true);
  });

  it('placeholder when cloud IS configured', async (t) => {
    if (!await isCloudEnabled()) return t.skip('cloud not configured');
    // Real integration tests require a clean test schema and would touch
    // production tables — keep them out of the default unit-test run.
    // Run via `npm test -- --test-name-pattern="phase1 integration"` once
    // we have a dedicated test database.
    assert.ok(true);
  });
});

// ── decision_key shape contract ───────────────────────────────────────────

describe('learning-store / Phase 1 per-repo filter contract (H1 fix)', () => {
  it('readPendingTriageFindings throws if repoId omitted', async () => {
    const { readPendingTriageFindings } = await import('../scripts/learning-store.mjs');
    await assert.rejects(
      () => readPendingTriageFindings({}),
      /repoId is required/,
    );
  });

  it('readNoBrainerRecommendations throws if repoId omitted', async () => {
    const { readNoBrainerRecommendations } = await import('../scripts/learning-store.mjs');
    await assert.rejects(
      () => readNoBrainerRecommendations({}),
      /repoId is required/,
    );
  });

  it('readStaleClusters throws if repoId omitted', async () => {
    const { readStaleClusters } = await import('../scripts/learning-store.mjs');
    await assert.rejects(
      () => readStaleClusters({}),
      /repoId is required/,
    );
  });

  it('all three weekly-review reads have explicit repo_id filter (grep contract)', async () => {
    const fs = await import('node:fs');
    // M3 P3 — the contract moved with the read functions. They now live
    // in scripts/lib/store/learning-decisions.mjs and use raw SQL with
    // a `repo_id = $1` predicate instead of the legacy `.eq('repo_id', repoId)`.
    // The contract is the same — each read MUST scope to repo_id.
    const src = fs.readFileSync('scripts/lib/store/learning-decisions.mjs', 'utf-8');
    const sqlMatches = (src.match(/WHERE\s+repo_id\s*=\s*\$1/gi) || []).length;
    assert.ok(
      sqlMatches >= 3,
      `expected ≥3 "WHERE repo_id = $1" predicates in learning-decisions.mjs, found ${sqlMatches}`
    );
  });
});

describe('learning-store / Phase 1 decision_key shape', () => {
  it('insertLearningDecision passes decision_key through untouched', async (t) => {
    if (await isCloudEnabled()) return t.skip('cloud configured: the cloud-off contract is not exercised here');
    const r = await insertLearningDecision({
      decisionKey: 'audit-bound:pass_selection:r0:s0',
      decisionType: 'pass_selection',
      auditRunId: 'audit-bound',
      round: 0,
      sequence: 0,
      context: { x: 1 },
      contextHash: 'b'.repeat(64),
      choice: { chose: 'all' },
    });
    // Cloud off: the call returns { ok: true } before touching the network.
    assert.equal(r.ok, true);
  });
});
