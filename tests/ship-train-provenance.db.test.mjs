/**
 * @fileoverview `findCodeRunCandidates` — the ship-train binding query, on real
 * Postgres AND on its failure branches.
 *
 * Its pure failure branches are in tests/ship-train-provenance.test.mjs.
 *
 * The DB half needs the migrated schema intact, because a mock cannot prove the
 * SQL reaches real column names (audited_tree, audited_sha, audit_pass_stats.
 * source_model). It is an ISOLATED suite — enrolled in BOTH
 * scripts/db-test-container.mjs and .github/workflows/postgres-parity.yml.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { findCodeRunCandidates, findCodeRunForRepo } from '../scripts/lib/store/train-provenance.mjs';

const hex = (c) => c.repeat(40);

// The pure failure branches live in tests/ship-train-provenance.test.mjs.

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('findCodeRunCandidates on real Postgres (DB integration)', { skip }, () => {
  let q, repoId, otherRepoId, savedUrl;
  const ids = {};

  before(async () => {
    const client = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    await client._resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');

    repoId = crypto.randomUUID();
    otherRepoId = crypto.randomUUID();
    for (const id of [repoId, otherRepoId]) {
      await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, `train-${id.slice(0, 8)}`]);
    }
    const seed = async (key, { repo = repoId, mode = 'code', sha = null, tree = null, converged = null, ageMin = 0, finalReview = null, auditors = [] }) => {
      ids[key] = crypto.randomUUID();
      await q.query(
        `INSERT INTO audit_runs (id, repo_id, plan_file, mode, audited_sha, audited_tree, round_converged_after, final_review_model, created_at)
         VALUES ($1, $2, 'docs/plans/train-fixture.md', $3, $4, $5, $6, $7, now() - ($8 || ' minutes')::interval)`,
        [ids[key], repo, mode, sha, tree, converged, finalReview, String(ageMin)]);
      for (const m of auditors) {
        await q.query(
          `INSERT INTO audit_pass_stats (run_id, pass_name, findings_raised, findings_accepted, findings_dismissed, source_model)
           VALUES ($1, $2, 0, 0, 0, $3)`, [ids[key], `pass-${m}`, m]);
      }
      // A baseline pass row with NULL source_model must not appear in auditor_models.
      await q.query(
        `INSERT INTO audit_pass_stats (run_id, pass_name, findings_raised, findings_accepted, findings_dismissed)
         VALUES ($1, 'baseline', 0, 0, 0)`, [ids[key]]);
    };
    await seed('treeMatch', { tree: hex('a'), sha: hex('9'), converged: 2, ageMin: 30, finalReview: 'gemini-3.1-pro-preview', auditors: ['gpt-6.1-sol', 'gpt-6-astra'] });
    await seed('shaOnly', { tree: hex('f'), sha: hex('2'), converged: 1, ageMin: 20 });
    await seed('both', { tree: hex('b'), sha: hex('3'), ageMin: 10 });
    await seed('planMode', { mode: 'plan', tree: hex('a'), sha: hex('2'), ageMin: 5 });
    await seed('otherRepo', { repo: otherRepoId, tree: hex('a'), sha: hex('2'), ageMin: 1 });
    await seed('unrelated', { tree: hex('e'), sha: hex('8'), ageMin: 2 });
  });

  after(async () => {
    if (!q) return;
    const all = Object.values(ids);
    await q.query('DELETE FROM audit_pass_stats WHERE run_id = ANY($1::uuid[])', [all]);
    await q.query('DELETE FROM audit_runs WHERE id = ANY($1::uuid[])', [all]);
    await q.query('DELETE FROM audit_repos WHERE id = ANY($1::uuid[])', [[repoId, otherRepoId]]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
  });

  const ask = () => findCodeRunCandidates({ repoRowId: repoId, trees: [hex('a'), hex('b')], oids: [hex('2'), hex('3')] });

  test('returns tree and sha-only matches for this repo, code mode only, newest first', async () => {
    const r = await ask();
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.rows.map((x) => x.id), [ids.both, ids.shaOnly, ids.treeMatch]);
  });

  test('match kinds are kept apart; a row matching both is reported once, as tree', async () => {
    const byId = Object.fromEntries((await ask()).rows.map((x) => [x.id, x.matchKind]));
    assert.equal(byId[ids.treeMatch], 'tree');
    assert.equal(byId[ids.shaOnly], 'sha-only');
    assert.equal(byId[ids.both], 'tree');
  });

  test('plan-mode runs, other repos and unrelated runs are excluded', async () => {
    const got = new Set((await ask()).rows.map((x) => x.id));
    for (const k of ['planMode', 'otherRepo', 'unrelated']) assert.equal(got.has(ids[k]), false, k);
  });

  test('auditor models come from audit_pass_stats.source_model, distinct and sorted, NULLs dropped', async () => {
    const row = (await ask()).rows.find((x) => x.id === ids.treeMatch);
    assert.deepEqual(row.auditorModels, ['gpt-6-astra', 'gpt-6.1-sol']);
    assert.equal(row.finalReviewModel, 'gemini-3.1-pro-preview');
    assert.equal(row.roundConvergedAfter, 2);
  });

  test('findCodeRunForRepo resolves a code run of THIS repo, and nothing from another repo or plan mode', async () => {
    const got = await findCodeRunForRepo({ repoRowId: repoId, runId: ids.treeMatch });
    assert.equal(got.ok, true, got.reason);
    assert.deepEqual(got.run, { id: ids.treeMatch, auditedSha: hex('9'), auditedTree: hex('a'), roundConvergedAfter: 2 });
    assert.deepEqual(await findCodeRunForRepo({ repoRowId: repoId, runId: ids.otherRepo }), { ok: true, run: null });
    assert.deepEqual(await findCodeRunForRepo({ repoRowId: repoId, runId: ids.planMode }), { ok: true, run: null });
  });

  test('positive control: a query for a tree nothing carries returns ok:true with no rows', async () => {
    assert.deepEqual(await findCodeRunCandidates({ repoRowId: repoId, trees: [hex('c')], oids: [] }), { ok: true, rows: [] });
  });
});
