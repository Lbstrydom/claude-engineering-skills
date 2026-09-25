/**
 * Unit tests for scripts/lib/store/finding-write.mjs — the write-boundary
 * primitive (Root Cause 2 of
 * docs/plans/runs-findings-write-boundary-hardening.md).
 *
 * Pure Tier-1: a fake client stands in for a real pg client/pool, so no
 * database is needed to prove the isCallerTx contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyFindingWrite } from '../scripts/lib/store/finding-write.mjs';

function fakeClient({ rowCount, throws } = {}) {
  return {
    calls: 0,
    async query(text, values) {
      this.calls += 1;
      if (throws) throw throws;
      return { rowCount, rows: [] };
    },
  };
}

describe('applyFindingWrite', () => {
  it('returns a written outcome when the affected count meets expectAffected', async () => {
    const client = fakeClient({ rowCount: 1 });
    const result = await applyFindingWrite(client, { text: 'UPDATE x SET y=1', values: [] });
    assert.deepEqual(result, { outcome: 'written', affected: 1 });
  });

  describe('isCallerTx: true (client is inside an open transaction)', () => {
    it('rethrows a real DB error rather than swallowing it', async () => {
      const err = new Error('constraint violation');
      const client = fakeClient({ throws: err });
      await assert.rejects(
        () => applyFindingWrite(client, { text: 'INSERT ...' }, { isCallerTx: true }),
        (e) => e === err
      );
    });

    it('throws on an under-count against expectAffected — a 0-row result is not silently accepted', async () => {
      const client = fakeClient({ rowCount: 0 });
      await assert.rejects(
        () => applyFindingWrite(client, { text: 'UPDATE ...' }, { expectAffected: 1, isCallerTx: true }),
        /expected 1 affected row/
      );
    });
  });

  describe('isCallerTx: false (default — no enclosing transaction)', () => {
    it('catches a DB error and returns a typed failed outcome instead of throwing', async () => {
      const err = new Error('connection reset');
      const client = fakeClient({ throws: err });
      const result = await applyFindingWrite(client, { text: 'INSERT ...' }, { isCallerTx: false });
      assert.equal(result.outcome, 'failed');
      assert.equal(result.error, err);
    });

    it('catches an under-count and returns a typed not-found outcome instead of throwing', async () => {
      const client = fakeClient({ rowCount: 0 });
      const result = await applyFindingWrite(client, { text: 'UPDATE ...' }, { expectAffected: 1, isCallerTx: false });
      assert.deepEqual(result, { outcome: 'not-found', affected: 0 });
    });

    it('is the default when isCallerTx is omitted entirely', async () => {
      const client = fakeClient({ rowCount: 0 });
      const result = await applyFindingWrite(client, { text: 'UPDATE ...' });
      assert.equal(result.outcome, 'not-found');
    });
  });
});
