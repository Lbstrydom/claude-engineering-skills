/**
 * @fileoverview `markSnapshotExcluded` / `liftSnapshotExclusion` /
 * `resolveQuarantineTarget` — §7 Phase 5 of
 * docs/plans/campaign-arm-state-and-identity-integrity.md.
 *
 * LIVE, gated on `AUDIT_DB_TEST_URL` (disposable-host-only, INC-002) — same
 * pattern as tests/campaign-adjudication.test.mjs / tests/campaign-promote.test.mjs.
 * Runs under `npm run db:suites:gate`; enrolled in db-test-container.mjs's
 * `ISOLATED_SUITE_FILES` and postgres-parity.yml.
 *
 * @module tests/campaign-quarantine
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (runs under npm run db:suites:gate)';

describe('campaign quarantine mechanism against a live schema', { skip }, () => {
  let client; let store; let savedUrl;
  let repoRowId; let cohortId;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest, getPool } = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    client = await getPool();
    store = await import('../scripts/lib/store/campaign.mjs');

    const repo = await client.query("INSERT INTO audit_repos (name) VALUES ('campaign-quarantine-test-repo') RETURNING id");
    repoRowId = repo.rows[0].id;
    const campaign = await store.ensureCampaign({ repoId: repoRowId, campaignKey: 'quarantine-live-test', configDigest: 'digest1' });
    const cohort = await store.ensureCohort({ campaignId: campaign.id, lockDigest: 'lock1', resolved: { a: 1 } });
    cohortId = cohort.id;
  });

  after(async () => {
    try {
      const { closePool, _resetForTest } = await import('../scripts/lib/db/client.mjs');
      await closePool();
      await _resetForTest();
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
    }
  });

  async function mkRun() {
    const r = await client.query("INSERT INTO audit_runs (repo_id, plan_file, mode, commit_sha) VALUES ($1, 'docs/plans/x.md', 'code', 'sha-a') RETURNING id", [repoRowId]);
    return r.rows[0].id;
  }

  it('a scope="pairing" NULL-hash exclusion excludes only NULL-hash arm-runs for that snapshot, leaving a hash-bearing re-collection visible (H1)', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapNull', auditedSha: 'sha-a' });
    const runOld = await mkRun();
    const runNew = await mkRun();
    await store.recordArmRun({
      cohortId, snapshotRowId: (await store.upsertSnapshot({ cohortId, snapshotId: 'snapNull', auditedSha: 'sha-a' })).id,
      snapshotId: 'snapNull', armId: 'opus', attempt: 1, auditRunId: runOld, costUsd: 1, costStatus: 'priced',
      planContentHash: null,
    });
    await store.recordArmRun({
      cohortId, snapshotRowId: (await store.upsertSnapshot({ cohortId, snapshotId: 'snapNull', auditedSha: 'sha-a' })).id,
      snapshotId: 'snapNull', armId: 'kimi', attempt: 1, auditRunId: runNew, costUsd: 1, costStatus: 'priced',
      planContentHash: 'real-hash',
    });

    const marked = await store.markSnapshotExcluded({ cohortId, snapshotId: 'snapNull', planContentHash: null, reason: 'legacy NULL-hash pairing' });
    assert.equal(marked.applied, true);

    const rows = await store.loadCohortArmRuns(cohortId);
    const snapRows = rows.rows.filter((r) => r.snapshot_id === 'snapNull');
    assert.ok(!snapRows.some((r) => r.arm_id === 'opus'), 'the NULL-hash opus row must be excluded');
    assert.ok(snapRows.some((r) => r.arm_id === 'kimi'), 'the hash-bearing kimi row must remain visible');
  });

  it('a scope="all" exclusion excludes every arm-run for that snapshot regardless of hash', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapAll', auditedSha: 'sha-a' });
    const r1 = await mkRun();
    const r2 = await mkRun();
    const snap = await store.upsertSnapshot({ cohortId, snapshotId: 'snapAll', auditedSha: 'sha-a' });
    await store.recordArmRun({ cohortId, snapshotRowId: snap.id, snapshotId: 'snapAll', armId: 'opus', attempt: 1, auditRunId: r1, costUsd: 1, costStatus: 'priced', planContentHash: null });
    await store.recordArmRun({ cohortId, snapshotRowId: snap.id, snapshotId: 'snapAll', armId: 'kimi', attempt: 1, auditRunId: r2, costUsd: 1, costStatus: 'priced', planContentHash: 'real-hash' });

    await store.markSnapshotExcluded({ cohortId, snapshotId: 'snapAll', allPairings: true, reason: 'unrelated subject' });

    const rows = await store.loadCohortArmRuns(cohortId);
    const snapRows = rows.rows.filter((r) => r.snapshot_id === 'snapAll');
    assert.equal(snapRows.length, 0, 'ALL arm-runs for this snapshot must be excluded, regardless of hash');
  });

  it('a --snapshot naming a non-existent snapshot fails with a named, friendly error, never a raw FK violation (round 4, M1)', async () => {
    const target = await store.resolveQuarantineTarget({ repoId: repoRowId, campaignKey: 'quarantine-live-test', snapshotId: 'does-not-exist' });
    assert.equal(target.ok, false);
    assert.match(target.error, /not found/);
  });

  it('calling markSnapshotExcluded TWICE with the same scope/hash is idempotent (ON CONFLICT DO NOTHING, round 2 M1)', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapIdempotent', auditedSha: 'sha-a' });
    const first = await store.markSnapshotExcluded({ cohortId, snapshotId: 'snapIdempotent', allPairings: true, reason: 'first' });
    const second = await store.markSnapshotExcluded({ cohortId, snapshotId: 'snapIdempotent', allPairings: true, reason: 'second call, same key' });
    assert.equal(first.applied, true);
    assert.equal(second.applied, false, 'the second call is a benign no-op — already quarantined');
    const rows = await client.query("SELECT id FROM campaign_snapshot_exclusions WHERE cohort_id=$1 AND snapshot_id='snapIdempotent'", [cohortId]);
    assert.equal(rows.rows.length, 1, 'exactly one row, never a duplicate');
  });

  it('unquarantine sets lifted_at/lifted_reason and the snapshot\'s arm-runs reappear in loadCohortArmRuns (round 5, M2)', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapLift', auditedSha: 'sha-a' });
    const r1 = await mkRun();
    const snap = await store.upsertSnapshot({ cohortId, snapshotId: 'snapLift', auditedSha: 'sha-a' });
    await store.recordArmRun({ cohortId, snapshotRowId: snap.id, snapshotId: 'snapLift', armId: 'opus', attempt: 1, auditRunId: r1, costUsd: 1, costStatus: 'priced', planContentHash: null });
    await store.markSnapshotExcluded({ cohortId, snapshotId: 'snapLift', planContentHash: null, reason: 'to be lifted' });

    const before1 = await store.loadCohortArmRuns(cohortId);
    assert.ok(!before1.rows.some((r) => r.snapshot_id === 'snapLift'), 'excluded before lifting');

    const lifted = await store.liftSnapshotExclusion({ cohortId, snapshotId: 'snapLift', planContentHash: null, reason: 'correction confirmed' });
    assert.equal(lifted.applied, true);

    const dbRow = await client.query("SELECT lifted_at, lifted_reason FROM campaign_snapshot_exclusions WHERE cohort_id=$1 AND snapshot_id='snapLift'", [cohortId]);
    assert.ok(dbRow.rows[0].lifted_at);
    assert.equal(dbRow.rows[0].lifted_reason, 'correction confirmed');

    const after1 = await store.loadCohortArmRuns(cohortId);
    assert.ok(after1.rows.some((r) => r.snapshot_id === 'snapLift' && r.arm_id === 'opus'), 'the arm-run reappears once lifted');
  });

  it('re-quarantining the SAME key after a lift succeeds (the partial indexes exclude lifted rows, round 2 M1/round 5 M2)', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapRelift', auditedSha: 'sha-a' });
    await store.markSnapshotExcluded({ cohortId, snapshotId: 'snapRelift', allPairings: true, reason: 'first quarantine' });
    await store.liftSnapshotExclusion({ cohortId, snapshotId: 'snapRelift', allPairings: true, reason: 'lifted' });
    const relift = await store.markSnapshotExcluded({ cohortId, snapshotId: 'snapRelift', allPairings: true, reason: 'quarantined again' });
    assert.equal(relift.applied, true, 'a lifted row must not block a fresh exclusion for the same key');
  });

  it('calling unquarantine a SECOND time on an already-lifted key exits as a benign no-op, not the "no active exclusion" error (round 6, Gemini gate LOW)', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapDoubleLift', auditedSha: 'sha-a' });
    await store.markSnapshotExcluded({ cohortId, snapshotId: 'snapDoubleLift', allPairings: true, reason: 'q' });
    const first = await store.liftSnapshotExclusion({ cohortId, snapshotId: 'snapDoubleLift', allPairings: true, reason: 'lift 1' });
    const second = await store.liftSnapshotExclusion({ cohortId, snapshotId: 'snapDoubleLift', allPairings: true, reason: 'lift 2 (retry after a timeout)' });
    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(second.alreadyLifted, true, 'a retry on an already-lifted key must read as a benign no-op, not notFound');
    assert.equal(second.ok, true);
  });

  it('a --snapshot/--plan-hash combination that never had ANY exclusion still exits with the real "not found" error', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapNeverExcluded', auditedSha: 'sha-a' });
    const result = await store.liftSnapshotExclusion({ cohortId, snapshotId: 'snapNeverExcluded', allPairings: true, reason: 'attempted lift' });
    assert.equal(result.notFound, true);
    assert.equal(result.applied, false);
  });
});
