/**
 * @fileoverview Tests for runtime pgvector / embedding-column detection.
 * Uses a fake pool — no real database required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pgvectorAvailable,
  securityEmbeddingColumnExists,
  embeddingsEnabled,
  _resetPgvectorCacheForTest,
} from '../scripts/lib/security/pgvector-check.mjs';

function fakePool(answers) {
  let calls = 0;
  return {
    queries: [],
    async query(sql) {
      this.queries.push(sql);
      const a = answers[calls++] ?? { rowCount: 0 };
      return a;
    },
  };
}

test('pgvectorAvailable true when extension present, cached after first call', async () => {
  _resetPgvectorCacheForTest();
  const pool = fakePool([{ rowCount: 1 }]);
  assert.equal(await pgvectorAvailable(pool), true);
  // second call must be cached (no new query)
  assert.equal(await pgvectorAvailable(pool), true);
  assert.equal(pool.queries.length, 1);
});

test('pgvectorAvailable false when extension absent', async () => {
  _resetPgvectorCacheForTest();
  const pool = fakePool([{ rowCount: 0 }]);
  assert.equal(await pgvectorAvailable(pool), false);
});

test('pgvectorAvailable false when query throws', async () => {
  _resetPgvectorCacheForTest();
  const pool = { async query() { throw new Error('no db'); } };
  assert.equal(await pgvectorAvailable(pool), false);
});

test('embeddingsEnabled requires BOTH extension and column', async () => {
  _resetPgvectorCacheForTest();
  // extension present, column absent → false
  let pool = fakePool([{ rowCount: 1 }, { rowCount: 0 }]);
  assert.equal(await embeddingsEnabled(pool), false);

  _resetPgvectorCacheForTest();
  // extension present, column present → true
  pool = fakePool([{ rowCount: 1 }, { rowCount: 1 }]);
  assert.equal(await embeddingsEnabled(pool), true);

  _resetPgvectorCacheForTest();
  // extension absent → short-circuits to false (column never checked)
  pool = fakePool([{ rowCount: 0 }]);
  assert.equal(await embeddingsEnabled(pool), false);
});

test('securityEmbeddingColumnExists caches', async () => {
  _resetPgvectorCacheForTest();
  const pool = fakePool([{ rowCount: 1 }]);
  assert.equal(await securityEmbeddingColumnExists(pool), true);
  assert.equal(await securityEmbeddingColumnExists(pool), true);
  assert.equal(pool.queries.length, 1);
});
