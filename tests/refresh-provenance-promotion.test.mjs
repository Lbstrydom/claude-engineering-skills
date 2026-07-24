/**
 * @fileoverview Cluster A / Phase 2 — a refresh must promote incremental → full
 * when the vector-space identity changes (D3/H4). Otherwise an incremental run
 * re-embeds only touched files while publishing the new provenance, silently
 * mixing two vector spaces the read-side guard can't detect.
 *
 * Tests the pure decision seam `provenanceRequiresFullReembed`. Importing
 * refresh.mjs must NOT run the pipeline — guarded by its CLI main-guard.
 *
 * docs/plans/tiered-pipeline-refresh-god-module-decomposition.md (Phase 4):
 * both `provenanceRequiresFullReembed` and `finalizeRefreshMode` now live in
 * refresh-mode.mjs, not refresh.mjs — import path updated. `finalizeRefreshMode`
 * cases added below (not just the import-path change): the hermetic ones drive
 * the cloud-disabled degradation of `getActiveSnapshot` (returns null without
 * touching the network — same technique already established elsewhere in this
 * suite for `getFreshImportersOrNull`); the two DB-gated ones seed a REAL prior
 * published snapshot via `openRefreshRun`/`publishRefreshRun` (the actual
 * pipeline, not hand-rolled fakes — `getActiveSnapshot`/`getRefreshRun` are
 * plain named ESM exports this repo's own convention says cannot be
 * `t.mock.method`'d).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { provenanceRequiresFullReembed, finalizeRefreshMode } from '../scripts/symbol-index/refresh-mode.mjs';

describe('provenanceRequiresFullReembed (D3/H4)', () => {
  const AZ_LARGE = 'https://contoso-ai-dev.openai.azure.com::text-embedding-3-large';
  const AZ_SMALL = 'https://contoso-ai-dev.openai.azure.com::text-embedding-3-small';
  const AZ_OTHER_RESOURCE = 'https://other.openai.azure.com::text-embedding-3-large';

  test('provenance changed (different deployment) → promote to full', () => {
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: AZ_SMALL }, AZ_LARGE), true);
  });

  test('SAME alias, DIFFERENT endpoint → promote to full (the H8 mix we must catch)', () => {
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: AZ_OTHER_RESOURCE }, AZ_LARGE), true);
  });

  test('legacy bare-name index vs qualified → promote to full (the one rebuild that clears D2)', () => {
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: 'gemini-embedding-001' }, AZ_LARGE), true);
  });

  test('provenance unchanged → stays incremental (no false full-rebuild)', () => {
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: AZ_LARGE }, AZ_LARGE), false);
  });

  test('no prior snapshot → not a provenance change (first-ever refresh handled elsewhere)', () => {
    assert.equal(provenanceRequiresFullReembed(null, AZ_LARGE), false);
    assert.equal(provenanceRequiresFullReembed({}, AZ_LARGE), false);
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: null }, AZ_LARGE), false);
  });

  test('public path unchanged (Gemini id equal) → incremental', () => {
    assert.equal(
      provenanceRequiresFullReembed({ activeEmbeddingModel: 'gemini-embedding-001' }, 'gemini-embedding-001'),
      false,
    );
  });
});

describe('finalizeRefreshMode — hermetic branches (cloud disabled → prior is always null)', () => {
  let savedUrl;
  before(() => { savedUrl = process.env.AUDIT_DB_URL; delete process.env.AUDIT_DB_URL; });
  after(() => { if (savedUrl !== undefined) process.env.AUDIT_DB_URL = savedUrl; });

  test('mode already full → pure passthrough, getActiveSnapshot never even consulted', async () => {
    const result = await finalizeRefreshMode({
      mode: 'full', sinceCommit: 'abc123', repoId: 'r1',
      embedProfile: { provenanceId: 'm1' }, logOk: () => {},
    });
    assert.deepEqual(result, { mode: 'full', sinceCommit: 'abc123', prior: null });
  });

  test('incremental + sinceCommit already given + no prior → stays incremental, unchanged', async () => {
    const result = await finalizeRefreshMode({
      mode: 'incremental', sinceCommit: 'abc123', repoId: 'r1',
      embedProfile: { provenanceId: 'm1' }, logOk: () => {},
    });
    assert.deepEqual(result, { mode: 'incremental', sinceCommit: 'abc123', prior: null });
  });

  test('incremental + no sinceCommit + no prior anchor → promotes to full (no-anchor branch)', async () => {
    const logged = [];
    const result = await finalizeRefreshMode({
      mode: 'incremental', sinceCommit: null, repoId: 'r1',
      embedProfile: { provenanceId: 'm1' }, logOk: (s) => logged.push(s),
    });
    assert.deepEqual(result, { mode: 'full', sinceCommit: null, prior: null });
    assert.ok(logged.some((s) => s.includes('no prior snapshot anchor')), 'must log why it promoted');
  });
});

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const dbSkip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

describe('finalizeRefreshMode — with a REAL prior published snapshot', { skip: dbSkip }, () => {
  let savedUrl, getPool, closePool, _resetForTest, assertDisposableDbUrl, upsertRepoByUuid, openRefreshRun, publishRefreshRun;
  let repoId;
  const REPO_UUID = `test-refresh-mode-${crypto.randomUUID()}`;

  before(async () => {
    ({ getPool, closePool, _resetForTest, assertDisposableDbUrl } = await import('../scripts/lib/db/client.mjs'));
    ({ upsertRepoByUuid } = await import('../scripts/lib/store/repo.mjs'));
    ({ openRefreshRun, publishRefreshRun } = await import('../scripts/lib/store/arch/refresh-runs.mjs'));

    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    if (/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(TEST_URL)) {
      process.env.AUDIT_DB_SSL_MODE = 'disable';
    }
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'refresh-mode-test-repo', fingerprint: null });
    repoId = repo.id;
  });

  after(async () => {
    const errors = [];
    try {
      const pool = await getPool();
      if (pool) {
        for (const [sql, params] of [
          [`DELETE FROM refresh_runs WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM audit_repos WHERE id = $1`, [repoId]],
        ]) {
          try { await pool.query(sql, params); } catch (err) { errors.push(new Error(`${sql}: ${err?.message || err}`)); }
        }
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      try { await closePool(); } catch { /* env already restored */ }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'teardown failed — disposable DB may have residual rows');
  });

  test('provenance changed: promotes to full WITHOUT deriving sinceCommit (else-if ordering — the anchor branch never runs)', async () => {
    const opened = await openRefreshRun({ repoId, mode: 'full', walkStartCommit: 'prior-walk-sha-1' });
    await publishRefreshRun({ repoId, refreshId: opened.refreshId, activeEmbeddingModel: 'old-model-x', activeEmbeddingDim: 768 });

    const logged = [];
    const result = await finalizeRefreshMode({
      mode: 'incremental', sinceCommit: null, repoId,
      embedProfile: { provenanceId: 'new-model-y' }, logOk: (s) => logged.push(s),
    });
    assert.equal(result.mode, 'full');
    // The load-bearing assertion: if a future edit ever ran BOTH branches
    // (turning the `else if` into two independent `if`s), sinceCommit would
    // come back populated from prior.walk_start_commit even though provenance
    // changed. It must stay null — proof the anchor-derivation branch never
    // ran once provenance-change already decided full.
    assert.equal(result.sinceCommit, null, 'anchor derivation must never run once provenance-change already promoted to full');
    assert.equal(result.prior.refreshId, opened.refreshId);
    assert.ok(logged.some((s) => s.includes('embedding provenance changed')), 'must log the provenance-change reason, not the no-anchor reason');
    assert.ok(!logged.some((s) => s.includes('no prior snapshot anchor')));
  });

  test('provenance unchanged + no sinceCommit: derives the anchor from getRefreshRun(prior.refreshId) — never the in-progress run\'s own id', async () => {
    const opened = await openRefreshRun({ repoId, mode: 'full', walkStartCommit: 'prior-walk-sha-2' });
    await publishRefreshRun({ repoId, refreshId: opened.refreshId, activeEmbeddingModel: 'stable-model', activeEmbeddingDim: 768 });

    const result = await finalizeRefreshMode({
      mode: 'incremental', sinceCommit: null, repoId,
      embedProfile: { provenanceId: 'stable-model' }, logOk: () => {},
    });
    // finalizeRefreshMode's own signature carries no in-progress refreshId at
    // all (only repoId) — there is structurally no OTHER id in scope it could
    // have queried instead. The behavioural proof: the derived anchor is
    // exactly the PRIOR published run's own walk_start_commit.
    assert.equal(result.sinceCommit, 'prior-walk-sha-2');
    assert.equal(result.mode, 'incremental', 'a found anchor must NOT promote to full');
    assert.equal(result.prior.refreshId, opened.refreshId);
  });
});
