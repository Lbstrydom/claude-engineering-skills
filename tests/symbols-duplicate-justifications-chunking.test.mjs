/**
 * @fileoverview Pure, DB-free regression guard for 0aa2b07f: a single
 * unchunked apply statement in `recordDuplicateJustifications` bound 4 bind
 * parameters per justification with no cap, exceeding PostgreSQL's 65,535
 * parameter limit at 16,384+ justifications. The fix chunks the apply at
 * `UPSERT_CHUNK_SIZE` (scripts/lib/store/arch/symbols.mjs). This asserts the
 * invariant the fix establishes — chunk size stays safely under the
 * parameter limit — without needing a real database connection (the
 * end-to-end behavior is covered separately by the AUDIT_DB_TEST_URL-gated
 * tests in tests/symbol-index-drift-justification.test.mjs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UPSERT_CHUNK_SIZE, chunk } from '../scripts/lib/store/arch/_shared.mjs';

const POSTGRES_MAX_PARAMS = 65_535;
const PARAMS_PER_JUSTIFICATION_ROW = 4;
// +2 for the trailing refreshId/repoId params appended once per apply statement.
const TRAILING_PARAMS = 2;

describe('recordDuplicateJustifications chunking bound (0aa2b07f)', () => {
  it('a single chunk of UPSERT_CHUNK_SIZE justifications stays well under the Postgres parameter limit', () => {
    const paramsPerChunk = UPSERT_CHUNK_SIZE * PARAMS_PER_JUSTIFICATION_ROW + TRAILING_PARAMS;
    assert.ok(
      paramsPerChunk < POSTGRES_MAX_PARAMS,
      `UPSERT_CHUNK_SIZE=${UPSERT_CHUNK_SIZE} would bind ${paramsPerChunk} params/chunk, at or over the ${POSTGRES_MAX_PARAMS} limit`,
    );
  });

  it('the unchunked (pre-fix) shape WOULD have exceeded the limit at a realistic large-refresh size — proves the bug was reachable', () => {
    const largeJustificationCount = 20_000; // plausible for a large monorepo's full duplication sweep
    const unchunkedParams = largeJustificationCount * PARAMS_PER_JUSTIFICATION_ROW + TRAILING_PARAMS;
    assert.ok(unchunkedParams > POSTGRES_MAX_PARAMS, 'sanity check: this scenario must actually exceed the limit unchunked');
  });

  it('chunking 20,000 justifications produces batches that individually never exceed the parameter limit', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ definitionId: `id-${i}` }));
    const chunks = chunk(rows, UPSERT_CHUNK_SIZE);
    assert.ok(chunks.length > 1, 'must actually split into multiple chunks for this input size');
    for (const batch of chunks) {
      const paramsInBatch = batch.length * PARAMS_PER_JUSTIFICATION_ROW + TRAILING_PARAMS;
      assert.ok(paramsInBatch <= POSTGRES_MAX_PARAMS, `a chunk of ${batch.length} rows binds ${paramsInBatch} params — exceeds the limit`);
    }
    // Every row must be accounted for exactly once across all chunks.
    const totalRows = chunks.reduce((sum, b) => sum + b.length, 0);
    assert.equal(totalRows, rows.length);
  });
});
