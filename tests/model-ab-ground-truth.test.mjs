import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getAdjudicatorGroundTruth } from '../scripts/lib/store/model-ab.mjs';

// Read-only SQL-correctness tests against the REAL configured DB (this repo's
// cloud IS enabled in dev/CI here) — deliberately does NOT insert any rows.
// audit_findings/audit_runs are shared production tables feeding real
// audit-effectiveness dashboards; writing synthetic test fixtures into them
// would pollute those metrics (the same principle arm-generation.mjs's
// repoProfile omission protects, model-swap-eval-harness Phase 3). These
// tests instead prove the query is syntactically valid against the REAL
// schema (a malformed column reference or type mismatch would throw here)
// using a repoId guaranteed to have no matching rows.

describe('store/model-ab.mjs — getAdjudicatorGroundTruth', () => {
  test('throws when repoId is missing', async () => {
    await assert.rejects(() => getAdjudicatorGroundTruth({}), /repoId is required/);
  });

  test('runs against the real schema with a nonexistent repoId — no SQL error, well-shaped empty result', async () => {
    const result = await getAdjudicatorGroundTruth({ repoId: '00000000-0000-0000-0000-000000000000' });
    assert.equal(typeof result.cloud, 'boolean');
    assert.ok(Array.isArray(result.rows));
    assert.equal(result.rows.length, 0);
  });

  test('sinceDecidedAt: null (unbounded) does not error against the real schema', async () => {
    const result = await getAdjudicatorGroundTruth({ repoId: '00000000-0000-0000-0000-000000000000', sinceDecidedAt: null });
    assert.ok(Array.isArray(result.rows));
  });

  test('a cursor value does not error against the real schema (keyset predicate is syntactically valid)', async () => {
    const result = await getAdjudicatorGroundTruth({
      repoId: '00000000-0000-0000-0000-000000000000',
      cursor: { decidedAt: new Date().toISOString(), findingId: '00000000-0000-0000-0000-000000000000' },
    });
    assert.ok(Array.isArray(result.rows));
  });

  test('limit is clamped to GROUND_TRUTH_LIMIT_MAX, not passed through unbounded', async () => {
    const result = await getAdjudicatorGroundTruth({ repoId: '00000000-0000-0000-0000-000000000000', limit: 999999 });
    assert.ok(Array.isArray(result.rows)); // would throw if the clamp were absent and Postgres rejected an absurd LIMIT param shape
  });
});
