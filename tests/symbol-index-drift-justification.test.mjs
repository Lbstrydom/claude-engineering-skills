/**
 * @fileoverview Integration test (Tier 2/3 hybrid, disposable DB) for the
 * end-to-end @duplicate-justification -> excluded-from-drift-score path
 * (arch-drift-duplication-cleanup plan). Exercises recordDuplicateJustifications,
 * top_duplicate_clusters, and drift_score together against real rows — this
 * is the one seam where a silent miscount (excluding too much or too little)
 * would be a real regression, so it gets a real DB, not a mock.
 *
 * Env-gated: requires AUDIT_DB_TEST_URL. Skips cleanly when absent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import {
  recordSymbolDefinitions,
  recordSymbolIndex,
  recordDuplicateJustifications,
} from '../scripts/lib/store/arch/symbols.mjs';
import { computeDriftScore, getTopDuplicateClusters } from '../scripts/lib/store/arch/neighbourhood.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl, repoId;
const REPO_UUID = `test-duplicate-justification-${crypto.randomUUID()}`;

async function insertRefreshRun(pool, repoId) {
  const { rows } = await pool.query(
    `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'full', 'published') RETURNING id`,
    [repoId],
  );
  return rows[0].id;
}

async function makeSymbol(refreshId, repoId, { filePath, symbolName, kind, signatureHash }) {
  const defMap = await recordSymbolDefinitions(repoId, [{ canonicalPath: filePath, symbolName, kind }]);
  const definitionId = defMap[`${filePath}|${symbolName}|${kind}`];
  await recordSymbolIndex(refreshId, repoId, [{
    definitionId, filePath, startLine: 1, endLine: 5, signatureHash, purposeSummary: null, domainTag: null,
  }]);
  return definitionId;
}

describe('duplicate-justification exclusion — end-to-end (disposable DB)', { skip }, () => {
  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'duplicate-justification-test-repo', fingerprint: null });
    repoId = repo.id;
  });

  after(async () => {
    const pool = await getPool();
    if (pool) {
      try {
        // round-4 L2 fix: each DELETE gets its own try/catch — a shared
        // block meant a failure in the FIRST statement silently skipped
        // every later one, leaving partial residue in the disposable DB
        // while the test still appeared to clean up fine.
        try { await pool.query(`DELETE FROM symbol_index WHERE repo_id = $1`, [repoId]); } catch { /* best-effort */ }
        try { await pool.query(`DELETE FROM symbol_definitions WHERE repo_id = $1`, [repoId]); } catch { /* best-effort */ }
        try { await pool.query(`DELETE FROM refresh_runs WHERE repo_id = $1`, [repoId]); } catch { /* best-effort */ }
        try { await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [repoId]); } catch { /* best-effort */ }
      } catch { /* best-effort cleanup */ }
    }
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedUrl;
  });

  it('a justified pair drops out of top_duplicate_clusters + drift_score, an unannotated pair does not', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);

    // Annotated pair: 2 files sharing a signature_hash, one will be justified.
    const annotatedHash = `sig-annotated-${crypto.randomUUID()}`;
    const d1 = await makeSymbol(refreshId, repoId, { filePath: 'a.mjs', symbolName: 'foo', kind: 'function', signatureHash: annotatedHash });
    await makeSymbol(refreshId, repoId, { filePath: 'b.mjs', symbolName: 'foo', kind: 'function', signatureHash: annotatedHash });

    // Unannotated pair: a completely separate duplicate, never justified.
    const plainHash = `sig-plain-${crypto.randomUUID()}`;
    await makeSymbol(refreshId, repoId, { filePath: 'c.mjs', symbolName: 'bar', kind: 'function', signatureHash: plainHash });
    await makeSymbol(refreshId, repoId, { filePath: 'd.mjs', symbolName: 'bar', kind: 'function', signatureHash: plainHash });

    // Before justification: both clusters present.
    const before = await getTopDuplicateClusters({ repoId, refreshId, limit: 20 });
    assert.ok(before.some((c) => c.signatureHash === annotatedHash), 'annotated cluster present before justification');
    assert.ok(before.some((c) => c.signatureHash === plainHash), 'plain cluster present');

    // Justify d1 (a.mjs's foo).
    await recordDuplicateJustifications(refreshId, repoId, [
      { definitionId: d1, reason: 'intentional test duplicate', target: 'b.mjs:foo', source: 'a.mjs:1' },
    ]);

    const after = await getTopDuplicateClusters({ repoId, refreshId, limit: 20 });
    assert.ok(!after.some((c) => c.signatureHash === annotatedHash), 'annotated cluster excluded after justification (dropped below the >1-file threshold)');
    assert.ok(after.some((c) => c.signatureHash === plainHash), 'plain (unannotated) cluster is UNAFFECTED');

    const drift = await computeDriftScore({ repoId, refreshId, simDup: 0.85, simName: 0.9 });
    assert.equal(drift.duplication_excluded_count, 1, 'exactly one declaration excluded');
  });

  it('a full reset+reapply un-flags a previously-justified row when justifications is empty on the next call (round-1 H1 regression)', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    const hash = `sig-reset-${crypto.randomUUID()}`;
    const d1 = await makeSymbol(refreshId, repoId, { filePath: 'e.mjs', symbolName: 'baz', kind: 'function', signatureHash: hash });
    await makeSymbol(refreshId, repoId, { filePath: 'f.mjs', symbolName: 'baz', kind: 'function', signatureHash: hash });

    await recordDuplicateJustifications(refreshId, repoId, [
      { definitionId: d1, reason: 'r', target: 'f.mjs:baz', source: 'e.mjs:1' },
    ]);
    let clusters = await getTopDuplicateClusters({ repoId, refreshId, limit: 20 });
    assert.ok(!clusters.some((c) => c.signatureHash === hash), 'excluded while justified');

    // Simulate the pragma being removed before the next refresh: call with
    // an EMPTY justifications array for the SAME refresh_id.
    await recordDuplicateJustifications(refreshId, repoId, []);
    clusters = await getTopDuplicateClusters({ repoId, refreshId, limit: 20 });
    assert.ok(clusters.some((c) => c.signatureHash === hash), 'cluster REAPPEARS once the justification is removed — the exact bug round-1 H1 found');
  });

  it('a changed reason/target overwrites the old value, not appends or leaves stale data (round-4 M9)', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    const hash = `sig-changed-${crypto.randomUUID()}`;
    const d1 = await makeSymbol(refreshId, repoId, { filePath: 'j.mjs', symbolName: 'quux', kind: 'function', signatureHash: hash });
    await makeSymbol(refreshId, repoId, { filePath: 'k.mjs', symbolName: 'quux', kind: 'function', signatureHash: hash });

    await recordDuplicateJustifications(refreshId, repoId, [
      { definitionId: d1, reason: 'original reason', target: 'k.mjs:quux', source: 'j.mjs:1' },
    ]);
    let row = (await pool.query(
      `SELECT duplicate_justification_reason, duplicate_justification_source FROM symbol_index WHERE definition_id = $1 AND refresh_id = $2`,
      [d1, refreshId],
    )).rows[0];
    assert.equal(row.duplicate_justification_reason, 'original reason');
    assert.equal(row.duplicate_justification_source, 'j.mjs:1');

    // Simulate the pragma's comment being edited before the next refresh —
    // same definition, different reason/source.
    await recordDuplicateJustifications(refreshId, repoId, [
      { definitionId: d1, reason: 'updated reason', target: 'k.mjs:quux', source: 'j.mjs:2' },
    ]);
    row = (await pool.query(
      `SELECT duplicate_justification_reason, duplicate_justification_source FROM symbol_index WHERE definition_id = $1 AND refresh_id = $2`,
      [d1, refreshId],
    )).rows[0];
    assert.equal(row.duplicate_justification_reason, 'updated reason', 'new reason replaces the old one, not appended');
    assert.equal(row.duplicate_justification_source, 'j.mjs:2', 'new source replaces the old one, not stale');
  });

  it('a 3-member cluster with ONE member justified still reports with file_count 2, not fully suppressed', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    const hash = `sig-triple-${crypto.randomUUID()}`;
    const d1 = await makeSymbol(refreshId, repoId, { filePath: 'g.mjs', symbolName: 'qux', kind: 'function', signatureHash: hash });
    await makeSymbol(refreshId, repoId, { filePath: 'h.mjs', symbolName: 'qux', kind: 'function', signatureHash: hash });
    await makeSymbol(refreshId, repoId, { filePath: 'i.mjs', symbolName: 'qux', kind: 'function', signatureHash: hash });

    await recordDuplicateJustifications(refreshId, repoId, [
      { definitionId: d1, reason: 'r', target: 'h.mjs:qux', source: 'g.mjs:1' },
    ]);
    const clusters = await getTopDuplicateClusters({ repoId, refreshId, limit: 20 });
    const cluster = clusters.find((c) => c.signatureHash === hash);
    assert.ok(cluster, 'cluster still reported — 2 unjustified members remain');
    assert.equal(cluster.fileCount, 2);
  });
});
