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
  copyForwardUntouchedFiles,
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
    // try/finally so a thrown error from a DELETE can never leave
    // process.env.AUDIT_DB_URL pointed at TEST_URL for the rest of the
    // process (round-2 code audit M1). Env restoration happens BEFORE
    // closePool() (not after, inside the finally) — closePool() doesn't
    // read AUDIT_DB_URL, so ordering doesn't matter functionally, and this
    // way a hypothetical future closePool() rejection can't skip it either
    // (Gemini final-review G1 — closePool() itself already swallows its
    // only failure point, p.end(), internally, so this is defense-in-depth
    // against a future change to that function, not a fix for a live bug).
    const cleanupErrors = [];
    try {
      const pool = await getPool();
      if (pool) {
        // Each DELETE is attempted independently (a failure in one must not
        // skip the rest), but a failure is no longer swallowed — round-1
        // code audit H1/M1/M2 found the prior best-effort catches let this
        // hook report success while leaving rows behind in the disposable DB.
        const statements = [
          [`DELETE FROM symbol_index WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM symbol_definitions WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM refresh_runs WHERE repo_id = $1`, [repoId]],
        ];
        for (const [sql, params] of statements) {
          try {
            await pool.query(sql, params);
          } catch (err) {
            cleanupErrors.push(new Error(`${sql}: ${err?.message || err}`));
          }
        }
        // audit_repos is the one row `before()` guarantees exists (via
        // upsertRepoByUuid on a fresh crypto.randomUUID()) — rowCount === 0
        // here means the delete silently matched nothing, which is a real
        // signal something's wrong (round-2 code audit H2). The three
        // deletes above aren't checked the same way: they can legitimately
        // match 0 rows if the `it()` block failed before creating that data,
        // and asserting rowCount there would raise a false teardown failure
        // that masks the real test failure.
        try {
          const { rowCount } = await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [repoId]);
          if (rowCount === 0) {
            cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = ${repoId}: matched 0 rows — expected exactly 1`));
          }
        } catch (err) {
          cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = $1: ${err?.message || err}`));
        }
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      try { await closePool(); } catch { /* best-effort — env is already restored */ }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `${cleanupErrors.length} teardown step(s) failed — disposable DB may have residual rows`);
    }
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
    const clustersBefore = await getTopDuplicateClusters({ repoId, refreshId, limit: 20 });
    assert.ok(clustersBefore.some((c) => c.signatureHash === annotatedHash), 'annotated cluster present before justification');
    assert.ok(clustersBefore.some((c) => c.signatureHash === plainHash), 'plain cluster present');

    // Justify d1 (a.mjs's foo).
    await recordDuplicateJustifications(refreshId, repoId, [
      { definitionId: d1, reason: 'intentional test duplicate', target: 'b.mjs:foo', source: 'a.mjs:1' },
    ]);

    const clustersAfter = await getTopDuplicateClusters({ repoId, refreshId, limit: 20 });
    assert.ok(!clustersAfter.some((c) => c.signatureHash === annotatedHash), 'annotated cluster excluded after justification (dropped below the >1-file threshold)');
    assert.ok(clustersAfter.some((c) => c.signatureHash === plainHash), 'plain (unannotated) cluster is UNAFFECTED');

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

  // Wine-cellar-app upstream bug report (2026-07-15): duplication_excluded_count
  // stayed 0 across two real incremental refreshes despite a correctly-formatted,
  // correctly-placed pragma. Every in-memory resolution step (findRepoPragmas,
  // extract.mjs's per-touched-file walk, resolvePragmasToDefinitions) was
  // separately live-verified to work correctly — including on an INCREMENTAL-
  // mode extract.mjs invocation — ruling out the reporter's own hypothesis
  // (finalSymbols narrowing). The one seam that ISN'T covered by the tests
  // above: this file's existing tests write BOTH duplicate-pair members under
  // ONE refresh_id (a full-refresh shape). A real incremental refresh, per
  // refresh.mjs's actual step order, writes the TOUCHED file's row (step 10)
  // and resolves+applies its pragma (step 12a) BEFORE copy-forwarding the
  // UNTOUCHED duplicate partner's row from the prior refresh (step 13) — so
  // this reproduces that exact cross-refresh shape and ordering.
  it('incremental refresh: pragma on a touched file whose duplicate partner is copy-forwarded from a PRIOR refresh (the exact bug-report scenario)', async () => {
    const pool = await getPool();
    const hash = `sig-incremental-${crypto.randomUUID()}`;

    // Refresh 1 (full): fileA:foo and fileB:foo share a signature_hash.
    const r1 = await insertRefreshRun(pool, repoId);
    const defA = await makeSymbol(r1, repoId, { filePath: 'fileA.mjs', symbolName: 'foo', kind: 'function', signatureHash: hash });
    await makeSymbol(r1, repoId, { filePath: 'fileB.mjs', symbolName: 'foo', kind: 'function', signatureHash: hash });

    // Refresh 2 (incremental): ONLY fileA touched (a pragma was added above
    // foo). Mirrors refresh.mjs's REAL order: recordSymbolIndex for the
    // touched file (step 10) -> recordDuplicateJustifications (step 12a) ->
    // copyForwardUntouchedFiles for fileB (step 13) — pragma resolution and
    // write happen BEFORE fileB's row exists under refresh 2 at all.
    const r2 = await insertRefreshRun(pool, repoId);
    const defMap2 = await recordSymbolDefinitions(repoId, [{ canonicalPath: 'fileA.mjs', symbolName: 'foo', kind: 'function' }]);
    const defA2 = defMap2['fileA.mjs|foo|function'];
    assert.equal(defA2, defA, 'symbol_definitions is stable across refreshes for an unchanged declaration');

    await recordSymbolIndex(r2, repoId, [
      { definitionId: defA2, filePath: 'fileA.mjs', startLine: 2, endLine: 4, signatureHash: hash, purposeSummary: null, domainTag: null },
    ]);
    const applied = await recordDuplicateJustifications(r2, repoId, [
      { definitionId: defA2, reason: 'test pragma', target: 'fileB.mjs:foo', source: 'fileA.mjs:1' },
    ]);
    assert.equal(applied, 1, 'the UPDATE must match exactly the touched-file row just written');

    const copied = await copyForwardUntouchedFiles({
      repoId, fromRefreshId: r1, toRefreshId: r2, touchedFileSet: new Set(['fileA.mjs']),
    });
    assert.equal(copied, 1, 'fileB (untouched) copy-forwards from refresh 1 into refresh 2');

    const clusters = await getTopDuplicateClusters({ repoId, refreshId: r2, limit: 20 });
    assert.ok(!clusters.some((c) => c.signatureHash === hash), 'cluster excluded once fileB is copy-forwarded into the same refresh');

    const drift = await computeDriftScore({ repoId, refreshId: r2, simDup: 0.85, simName: 0.9 });
    assert.equal(drift.duplication_excluded_count, 1, 'the bug-report symptom: this stayed 0 in the field');
    assert.equal(drift.duplication_pairs, 0, 'the pair must not count toward the drift score once excluded');
  });

  it('copyForwardUntouchedFiles carries the duplicate_justification* columns, not just the 7 identity/summary columns', async () => {
    const pool = await getPool();
    const hash = `sig-copyfwd-${crypto.randomUUID()}`;

    const r1 = await insertRefreshRun(pool, repoId);
    const defQ = await makeSymbol(r1, repoId, { filePath: 'quiet.mjs', symbolName: 'zap', kind: 'function', signatureHash: hash });
    await makeSymbol(r1, repoId, { filePath: 'noisy.mjs', symbolName: 'zap', kind: 'function', signatureHash: hash });
    await recordDuplicateJustifications(r1, repoId, [
      { definitionId: defQ, reason: 'intentional', target: 'noisy.mjs:zap', source: 'quiet.mjs:1' },
    ]);

    // Refresh 2 touches an unrelated file; quiet.mjs copy-forwards verbatim.
    const r2 = await insertRefreshRun(pool, repoId);
    await copyForwardUntouchedFiles({
      repoId, fromRefreshId: r1, toRefreshId: r2, touchedFileSet: new Set(['unrelated.mjs']),
    });

    const row = (await pool.query(
      `SELECT duplicate_justified, duplicate_justification_reason,
              duplicate_justification_target, duplicate_justification_source
         FROM symbol_index WHERE definition_id = $1 AND refresh_id = $2`,
      [defQ, r2],
    )).rows[0];
    assert.equal(row.duplicate_justified, true, 'a justified row must stay justified when copied forward — it lands on the NOT NULL DEFAULT false otherwise');
    assert.equal(row.duplicate_justification_reason, 'intentional', 'reason survives copy-forward');
    assert.equal(row.duplicate_justification_target, 'noisy.mjs:zap', 'target survives copy-forward');
    assert.equal(row.duplicate_justification_source, 'quiet.mjs:1', 'source survives copy-forward');
  });

  it('duplication_excluded_count is STABLE across full -> incremental when the justified declaration is in an UNTOUCHED file (the field oscillation)', async () => {
    const pool = await getPool();
    const hash = `sig-oscillate-${crypto.randomUUID()}`;

    // Refresh 1 (full): both members indexed, one justified by its pragma.
    const r1 = await insertRefreshRun(pool, repoId);
    const defP = await makeSymbol(r1, repoId, { filePath: 'pragma-side.mjs', symbolName: 'dup', kind: 'function', signatureHash: hash });
    await makeSymbol(r1, repoId, { filePath: 'other-side.mjs', symbolName: 'dup', kind: 'function', signatureHash: hash });
    await recordDuplicateJustifications(r1, repoId, [
      { definitionId: defP, reason: 'intentional', target: 'other-side.mjs:dup', source: 'pragma-side.mjs:1' },
    ]);
    const driftFull = await computeDriftScore({ repoId, refreshId: r1, simDup: 0.85, simName: 0.9 });
    assert.equal(driftFull.duplication_excluded_count, 1, 'baseline: the full refresh excludes it');

    // Refresh 2 (incremental): NEITHER duplicate file is touched. The pragma
    // sweep is full-repo but pragmaCandidates comes from finalSymbols
    // (touched files only), so nothing resolves -> the re-apply list is
    // empty. Both members then arrive purely via copy-forward.
    const r2 = await insertRefreshRun(pool, repoId);
    await recordDuplicateJustifications(r2, repoId, []);
    await copyForwardUntouchedFiles({
      repoId, fromRefreshId: r1, toRefreshId: r2, touchedFileSet: new Set(['somewhere-else.mjs']),
    });

    const driftIncr = await computeDriftScore({ repoId, refreshId: r2, simDup: 0.85, simName: 0.9 });
    assert.equal(
      driftIncr.duplication_excluded_count, driftFull.duplication_excluded_count,
      'the exclusion count must not decay across an incremental refresh (field: full=5, incremental=1, repeatedly)',
    );
    assert.equal(driftIncr.duplication_pairs, 0, 'and the justified pair must still not count toward drift');
  });
});
