import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { getNeighbourhoodForIntent } from '../scripts/lib/neighbourhood-query.mjs';

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-nq-test-'));
  return dir;
}

describe('getNeighbourhoodForIntent', () => {
  it('rejects invalid args with BAD_INPUT', async () => {
    const adapters = {
      getRepoIdByUuid: async () => null,
      getActiveSnapshot: async () => null,
      callNeighbourhoodRpc: async () => [],
    };
    await assert.rejects(
      () => getNeighbourhoodForIntent(adapters, {}),
      err => err.code === 'BAD_INPUT'
    );
  });

  it('returns hint when repo not found', async () => {
    const adapters = {
      getRepoIdByUuid: async () => null,
      getActiveSnapshot: async () => null,
      callNeighbourhoodRpc: async () => [],
    };
    const root = tempRoot();
    const out = await getNeighbourhoodForIntent(adapters, {
      repoUuid: '00000000-0000-5000-8000-000000000001',
      targetPaths: [],
      intentDescription: 'test',
    }, root);
    // Store connected, repo unregistered: NOT `cloud:false` (offline).
    assert.equal(out.cloud, true);
    assert.equal(out.repoRegistered, false);
    assert.equal(out.records.length, 0);
    assert.match(out.hint, /arch:refresh/);
  });

  it('returns hint when no active snapshot', async () => {
    const adapters = {
      getRepoIdByUuid: async () => ({ id: 'repo-id-1' }),
      getActiveSnapshot: async () => null,
      callNeighbourhoodRpc: async () => [],
    };
    const root = tempRoot();
    const out = await getNeighbourhoodForIntent(adapters, {
      repoUuid: '00000000-0000-5000-8000-000000000001',
      targetPaths: [],
      intentDescription: 'test',
    }, root);
    assert.equal(out.cloud, true);
    // Negative control: a REGISTERED repo with no snapshot must not claim it is unregistered.
    assert.notEqual(out.repoRegistered, false);
    assert.equal(out.refreshId, null);
    assert.match(out.hint, /arch:refresh/);
  });

  it('throws EMBEDDING_MISMATCH when active model not configured', async () => {
    const adapters = {
      getRepoIdByUuid: async () => ({ id: 'repo-id-1' }),
      getActiveSnapshot: async () => ({
        refreshId: '00000000-0000-4000-8000-000000000001',
        activeEmbeddingModel: null,
        activeEmbeddingDim: null,
      }),
      callNeighbourhoodRpc: async () => [],
    };
    const root = tempRoot();
    await assert.rejects(
      () => getNeighbourhoodForIntent(adapters, {
        repoUuid: '00000000-0000-5000-8000-000000000001',
        targetPaths: [],
        intentDescription: 'test',
      }, root),
      err => err.code === 'EMBEDDING_MISMATCH'
    );
  });
});
