/**
 * @fileoverview get-neighbourhood carries the active snapshot's coverage verdict.
 * An index that could not read the repo (0 symbols, `empty_universe`) must never
 * return the byte-identical "{records:[], hint:null}" a fully-indexed repo returns
 * when nothing is similar — that reads as "checked, go greenfield".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { getNeighbourhoodForIntent, snapshotCoverage } from '../scripts/lib/neighbourhood-query.mjs';

const REFRESH = '00000000-0000-4000-8000-000000000001';
const args = { repoUuid: '00000000-0000-5000-8000-000000000001', targetPaths: [], intentDescription: 'add a retry helper' };

function adapters(coverage, spies = {}) {
  return {
    getRepoIdByUuid: async () => ({ id: 'repo-1' }),
    getActiveSnapshot: async () => ({ refreshId: REFRESH, activeEmbeddingModel: 'm', activeEmbeddingDim: 8 }),
    // Must NEVER be reached on an empty universe — nothing to compare, and the
    // intent embedding before it is paid work.
    callNeighbourhoodRpc: async () => { spies.rpc = true; return []; },
    getGraphCoverage: async () => coverage,
  };
}

const emptyUniverse = {
  verdict: { status: 'unverified', reason: 'empty_universe' },
  extraction: { outcome: 'ok', eligible: 0 },
};

describe('getNeighbourhoodForIntent — coverage verdict', () => {
  it('an empty-universe snapshot says nothing was compared, and does not search', async () => {
    const spies = {};
    const out = await getNeighbourhoodForIntent(adapters(emptyUniverse, spies), args, os.tmpdir());
    assert.equal(out.cloud, true);
    assert.deepEqual(out.coverage, { status: 'unverified', reason: 'empty_universe', eligible: 0 });
    assert.equal(out.records.length, 0);
    assert.match(out.hint, /compared nothing/);
    assert.match(out.hint, /NOT "no similar code"/);
    assert.equal(spies.rpc, undefined, 'the RPC (and the embedding before it) must not run');
  });
});

describe('snapshotCoverage', () => {
  const active = { refreshId: REFRESH };
  const repo = { id: 'repo-1' };

  it('maps a stored verdict', async () => {
    const c = await snapshotCoverage({ getGraphCoverage: async () => ({ verdict: { status: 'verified', reason: null }, extraction: { eligible: 12 } }) }, active, repo);
    assert.deepEqual(c, { status: 'verified', reason: null, eligible: 12 });
  });
  it('no stored measurement is unknown/not_measured, never a clean verdict', async () => {
    const c = await snapshotCoverage({ getGraphCoverage: async () => null }, active, repo);
    assert.deepEqual(c, { status: 'unknown', reason: 'not_measured', eligible: null });
  });
  it('a failing read is unknown, not a throw and not clean', async () => {
    const c = await snapshotCoverage({ getGraphCoverage: async () => { throw new Error('boom'); } }, active, repo);
    assert.equal(c.status, 'unknown');
  });
  it('negative control: no reader wired claims nothing (null), so existing callers are unchanged', async () => {
    assert.equal(await snapshotCoverage({}, active, repo), null);
  });
  it('negative control: other unverified reasons are NOT the empty-universe short-circuit', async () => {
    const c = await snapshotCoverage({ getGraphCoverage: async () => ({ verdict: { status: 'unverified', reason: 'below_floor' }, extraction: { eligible: 40 } }) }, active, repo);
    assert.notEqual(c.reason, 'empty_universe');
  });
});
