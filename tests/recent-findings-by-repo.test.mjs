// Contract for getRecentFindingsByRepo — the store query behind /persona-test
// Phase 0d enrichment (replaces the dead PostgREST curl removed in M4). Uses
// the same {many, isCloudEnabled, getRepoIdByName} DI seam as getRunFindings,
// so the contract is asserted without a live DB.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRecentFindingsByRepo } from '../scripts/lib/store/runs-findings.mjs';

function fake({ rows = [], cloud = true, repoId = 'repo-1' } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      isCloudEnabled: async () => cloud,
      getRepoIdByName: async (name) => { calls.push({ resolve: name }); return repoId; },
      many: async (sql, params) => { calls.push({ sql, params }); return rows; },
    },
  };
}

const ROW = {
  id: 'f-1', run_id: 'r-1', severity: 'HIGH', category: '[backend] X',
  primary_file: 'src/a.js', detail_snapshot: 'boom', created_at: '2026-06-14T00:00:00Z',
};

describe('getRecentFindingsByRepo', () => {
  it('returns [] when cloud is disabled (no repo lookup, no query)', async () => {
    const f = fake({ cloud: false });
    const out = await getRecentFindingsByRepo({ repoName: 'owner/repo' }, f.deps);
    assert.deepEqual(out, []);
    assert.equal(f.calls.length, 0);
  });

  it('returns [] when neither repoId nor repoName is given', async () => {
    const f = fake();
    assert.deepEqual(await getRecentFindingsByRepo({}, f.deps), []);
    assert.equal(f.calls.length, 0);
  });

  it('prefers a canonical repoId — queries directly, never resolves by name', async () => {
    const f = fake({ rows: [ROW] });
    const out = await getRecentFindingsByRepo({ repoId: 'repo-canonical', repoName: 'owner/repo' }, f.deps);
    assert.equal(out.length, 1);
    assert.ok(!f.calls.some((c) => c.resolve), 'must not call getRepoIdByName when repoId is supplied');
    const q = f.calls.find((c) => c.sql);
    assert.equal(q.params[0], 'repo-canonical');
  });

  it('returns [] when the repo name does not resolve', async () => {
    const f = fake({ repoId: null });
    const out = await getRecentFindingsByRepo({ repoName: 'unknown' }, f.deps);
    assert.deepEqual(out, []);
    assert.ok(f.calls.some((c) => c.resolve === 'unknown'));
    assert.ok(!f.calls.some((c) => c.sql)); // never queried findings
  });

  it('maps rows to the domain shape (id/runId/severity/category/file/detail/createdAt)', async () => {
    const f = fake({ rows: [ROW] });
    const out = await getRecentFindingsByRepo({ repoName: 'owner/repo' }, f.deps);
    assert.deepEqual(out, [{
      id: 'f-1', runId: 'r-1', severity: 'HIGH', category: '[backend] X',
      file: 'src/a.js', detail: 'boom', createdAt: '2026-06-14T00:00:00Z',
    }]);
  });

  it('joins findings→runs on the resolved repo_id and filters by severity', async () => {
    const f = fake({ rows: [] });
    await getRecentFindingsByRepo({ repoName: 'owner/repo', severities: ['HIGH'] }, f.deps);
    const q = f.calls.find((c) => c.sql);
    assert.match(q.sql, /JOIN audit_runs r ON r\.id = f\.run_id/);
    assert.match(q.sql, /WHERE r\.repo_id = \$1 AND f\.severity = ANY\(\$2\)/);
    assert.deepEqual(q.params[1], ['HIGH']);
  });

  it('clamps limit to [1,100] and defaults severities to HIGH/MEDIUM', async () => {
    const f = fake({ rows: [] });
    await getRecentFindingsByRepo({ repoName: 'owner/repo', limit: 9999 }, f.deps);
    const q = f.calls.find((c) => c.sql);
    assert.equal(q.params[2], 100);
    assert.deepEqual(q.params[1], ['HIGH', 'MEDIUM']);
  });
});
