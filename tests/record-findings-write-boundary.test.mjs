/**
 * @fileoverview DB-integration proof for `recordFindings`'s NOT-NULL
 * write-boundary guard (`filterPersistableRows` in
 * scripts/lib/store/runs-findings.mjs). No existing test in this repo calls
 * `recordFindings` against a live database, so the pure-filter unit tests
 * (tests/store-finding-verification-persistence.test.mjs) prove the FILTER
 * decision in isolation but not that `recordFindings` actually persists
 * accordingly.
 *
 * Two behaviours, and the pre-fix one is the point: a truthy-but-invalid
 * severity (e.g. "CRITICAL") passed the old `!row.severity` guard, reached
 * the bulk INSERT, and hit the database's `audit_findings_severity_check`
 * CHECK constraint — which does not silently drop just that row, it fails
 * the WHOLE multi-row INSERT statement (the exact incident class the
 * guard's own 2026-07-26 comment documents for a null `category`). The fix
 * (`VALID_SEVERITIES.has(row.severity)`) filters the invalid row out before
 * it ever reaches SQL, so the rest of the batch survives.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

// Read the marker from source rather than hardcoding or importing it: the
// module is re-exported via `export *` by scripts/learning-store.mjs, whose
// surface is pinned to callable functions only, so this constant isn't
// importable — same pattern tests/final-review-persistence-isolation.test.mjs
// already uses. A loose /missing/i match (round-4 code-audit L1) would pass
// against any producer-defect marker text, not just this exact one.
const MISSING_CATEGORY_MARKER = (() => {
  const src = fs.readFileSync('scripts/lib/store/runs-findings.mjs', 'utf8');
  const m = src.match(/const MISSING_CATEGORY_MARKER = '([^']+)'/);
  assert.ok(m, 'precondition: MISSING_CATEGORY_MARKER is declared in the module');
  return m[1];
})();

describe('recordFindings — write-boundary guard (integration)', { skip }, () => {
  let mod, q, repoId, runId, savedAuditDbUrl;

  const makeFinding = (fingerprint, severity, category, extra = {}) => ({
    _hash: fingerprint,
    severity,
    category,
    section: 'src/x.js:1',
    detail: `finding ${fingerprint}`,
    ...extra,
  });

  test.before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    savedAuditDbUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedAuditDbUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    mod = await import('../scripts/lib/store/runs-findings.mjs');

    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2)
                   ON CONFLICT (id) DO NOTHING`, [repoId, `test-rfwb-${repoId.slice(0, 8)}`]);
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code')
                   ON CONFLICT (id) DO NOTHING`, [runId, repoId]);
  });

  test.after(async () => {
    if (savedAuditDbUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedAuditDbUrl;
    if (!q) return;
    // try/finally (round-3 code-audit M4): a DELETE failure must not skip
    // closePool() — an unclosed pool here leaks into the next test file
    // sharing this process.
    try {
      await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
      await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
      await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    } finally {
      const { closePool } = await import('../scripts/lib/db/client.mjs');
      await closePool();
    }
  });

  // The DB CHECK constraint itself (what happens if an invalid severity ever
  // reaches the INSERT — the failure mode the guard below exists to prevent)
  // is NOT separately assertable here: `recordFindings` applies
  // `filterPersistableRows` unconditionally, so there is no code path through
  // the public API that bypasses it post-fix. That half of the proof is a
  // ONE-TIME manual check during implementation (temporarily revert the
  // guard to `!row.severity`, confirm THIS test below goes red with
  // `result.applied === false` / `error.code === '23514'` / neither row
  // persisted, then restore the fix and confirm green) — not a permanent
  // test, since asserting on reverted code can never pass in the shipped
  // state. See the plan's Testing Strategy for the manual verification log.

  test('the write-boundary guard filters the invalid severity out BEFORE the INSERT, so the rest of the batch persists (post-fix behaviour)', async () => {
    const passName = `test-guarded-${crypto.randomUUID()}`;
    const findings = [
      makeFinding('rfwb-valid-2', 'HIGH', 'test-category'),
      makeFinding('rfwb-invalid-2', 'CRITICAL', 'test-category'),
      makeFinding('rfwb-missing-2', undefined, 'test-category'),
      makeFinding('rfwb-nocategory-2', 'MEDIUM', undefined),
    ];
    const result = await mod.recordFindings(runId, findings, passName, 1);
    assert.equal(result.applied, true, 'the guard must keep the batch alive despite two bad rows');
    assert.equal(result.rows, 2, 'only the two valid-severity rows persist');
    assert.equal(result.droppedCount, 2, 'the invalid and the missing severity are both dropped, and counted');

    const rows = await q.many(
      'SELECT finding_fingerprint, category FROM audit_findings WHERE run_id = $1 AND pass_name = $2',
      [runId, passName]
    );
    assert.deepEqual(rows.map((r) => r.finding_fingerprint).sort(), ['rfwb-nocategory-2', 'rfwb-valid-2']);
    const noCategoryRow = rows.find((r) => r.finding_fingerprint === 'rfwb-nocategory-2');
    assert.equal(noCategoryRow.category, MISSING_CATEGORY_MARKER, 'the no-category row persists with the EXACT visible marker, not dropped');
  });

  test('an invalid-severity occurrence does not consume a shared fingerprint and displace a later valid one (round-2 code-audit H4/H5)', async () => {
    // Dedup runs by finding_fingerprint; fingerprintOf() prefers `_hash` when
    // present, so two findings sharing `_hash` are "duplicates" to the dedup
    // step even though their severity differs. Before the fix, dedup ran
    // BEFORE the severity guard: if the invalid-severity one came first, it
    // would win the fingerprint's one dedup slot, the later valid one would
    // never be mapped, and filterPersistableRows would then drop the
    // survivor — losing the finding entirely despite a valid version existing
    // in the same batch. The fix reorders so dedup only ever chooses among
    // already-persistable rows.
    const passName = `test-dedup-order-${crypto.randomUUID()}`;
    const sharedHash = `rfwb-shared-${crypto.randomUUID()}`;
    const findings = [
      makeFinding(sharedHash, 'CRITICAL', 'test-category'),
      makeFinding(sharedHash, 'HIGH', 'test-category'),
    ];
    const result = await mod.recordFindings(runId, findings, passName, 1);
    assert.equal(result.applied, true);
    assert.equal(result.rows, 1, 'exactly one row persists — the valid one, not zero');

    const row = await q.one(
      'SELECT severity FROM audit_findings WHERE run_id = $1 AND pass_name = $2 AND finding_fingerprint = $3',
      [runId, passName, sharedHash]
    );
    assert.ok(row, 'the valid-severity finding must have survived');
    assert.equal(row.severity, 'HIGH');
  });
});
