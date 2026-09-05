/**
 * @fileoverview The ownership epoch, against a real Postgres.
 *
 * Plan: docs/plans/incremental-refresh-ownership-propagation.md (Cluster B, §9).
 * Upstream report: edc0948e (Lbstrydom/wine-cellar-app).
 *
 * WHY A DB SUITE IS A DELIVERABLE HERE AND NOT A CONDITIONAL. The pure tests in
 * `tests/refresh-mode-ownership-epoch.test.mjs` cover the decision. They cannot
 * see an omitted `SELECT` field, a wrong column mapping, an epoch read from a run
 * that never published, or a candidate set that silently misses a whole table.
 * This repo has a documented incident of exactly that shape — three read paths
 * selected `refresh_runs.commit_sha`, a column that has never existed; every
 * `catch` turned SQLSTATE 42703 into the same value an empty read returns, so
 * `getActiveSnapshot` answered "no snapshot" for every healthy repo. Five audit
 * rounds and two Gemini gates missed it; a real-Postgres assertion caught it in
 * eighty seconds.
 *
 * Enrolled in BOTH `scripts/db-test-container.mjs`'s CONTRACT_SUITE_FILES and
 * `.github/workflows/postgres-parity.yml`. A suite no runner names has never
 * run, and node reports a never-run suite as a clean pass.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// `AUDIT_DB_TEST_URL`, not `AUDIT_DB_URL` — the repo-wide convention, and the
// variable `check-db-suite-enrolment.mjs` scans for. Gating on the wrong name
// makes a suite invisible to the enrolment gate, so removing it from the runner
// lists would go unnoticed: the gate could not tell it was ever coverage.
const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const dbSkip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

const REPO_UUID = `test-ownership-epoch-${crypto.randomUUID()}`;

describe('refresh_runs.ownership_rule_epoch — persistence contract', { skip: dbSkip }, () => {
  let getPool, closePool, _resetForTest, assertDisposableDbUrl, upsertRepoByUuid;
  let openRefreshRun, publishRefreshRun, getActiveSnapshot, getRefreshRun, listSnapshotFilePaths;
  let savedUrl, repoId;

  before(async () => {
    ({ getPool, closePool, _resetForTest, assertDisposableDbUrl } = await import('../scripts/lib/db/client.mjs'));
    ({ upsertRepoByUuid } = await import('../scripts/lib/store/repo.mjs'));
    ({ openRefreshRun, publishRefreshRun } = await import('../scripts/lib/store/arch/refresh-runs.mjs'));
    ({ getActiveSnapshot } = await import('../scripts/lib/store/arch/snapshots.mjs'));
    ({ getRefreshRun } = await import('../scripts/lib/store/arch/refresh-runs.mjs'));
    ({ listSnapshotFilePaths } = await import('../scripts/lib/store/arch/symbols.mjs'));

    savedUrl = process.env.AUDIT_DB_URL;
    // Writes real rows. The disposable allowlist fails CLOSED and is never
    // re-expressed as "not $VENDOR".
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    if (/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(TEST_URL)) {
      process.env.AUDIT_DB_SSL_MODE = 'disable';
    }
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'ownership-epoch-test-repo', fingerprint: null });
    repoId = repo.id;
  });

  after(async () => {
    try {
      const pool = await getPool();
      if (pool) {
        for (const [sql, params] of [
          [`DELETE FROM symbol_file_imports WHERE refresh_id IN (SELECT id FROM refresh_runs WHERE repo_id = $1)`, [repoId]],
          [`DELETE FROM refresh_runs WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM audit_repos WHERE id = $1`, [repoId]],
        ]) {
          try { await pool.query(sql, params); } catch { /* best-effort cleanup */ }
        }
      }
    } finally {
      await closePool();
      await _resetForTest();
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
    }
  });

  /**
   * Open a run through the REAL writer, not raw SQL.
   *
   * `refresh_runs` carries a partial-unique running lock, so a second open with
   * the first still in flight is rejected with REFRESH_IN_FLIGHT. Every case
   * therefore closes its run — publish to make it the active snapshot, abort
   * otherwise — and a case that deliberately wants an unpublished row aborts it
   * on the way out.
   */
  const openRun = (epoch, sha) => openRefreshRun({
    repoId, mode: 'full', walkStartCommit: sha, ownershipRuleEpoch: epoch,
  });

  const publish = (refreshId) => publishRefreshRun({
    repoId, refreshId, activeEmbeddingModel: 'prov-1', activeEmbeddingDim: 768,
  });

  /** Release the running lock without publishing. */
  const abandon = async (refreshId) => {
    const { abortRefreshRun } = await import('../scripts/lib/store/arch/refresh-runs.mjs');
    await abortRefreshRun({ repoId, refreshId, reason: 'test cleanup' });
  };

  test('the migration added the column, and it is nullable TEXT', async () => {
    const { one } = await import('../scripts/lib/db/query.mjs');
    // Asserted against the live catalog, not the migration file: the file says
    // what was intended, `information_schema` says what is there.
    const col = await one(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'refresh_runs' AND column_name = 'ownership_rule_epoch'`,
    );
    assert.ok(col, 'refresh_runs.ownership_rule_epoch must exist — run setup-postgres.mjs --migrate');
    assert.equal(col.data_type, 'text');
    assert.equal(col.is_nullable, 'YES', 'NULL is the pre-adoption state and must remain representable');
  });

  test('the epoch round-trips open → publish → getActiveSnapshot', async () => {
    const { refreshId } = await openRun('epoch-A', 'a'.repeat(40));
    await publish(refreshId);

    const snap = await getActiveSnapshot(repoId);
    assert.equal(snap?.refreshId, refreshId);
    assert.equal(snap.ownershipRuleEpoch, 'epoch-A',
      'the epoch must survive the join getActiveSnapshot already performs — an '
      + 'omitted SELECT field is exactly what a pure test cannot see');
  });

  test('the column is readable through the GET_REFRESH_RUN_COLUMNS allowlist', async () => {
    // The allowlist throws on an unknown column, so a migration landing without
    // its entry surfaces here rather than as a silent absence.
    const { refreshId } = await openRun('epoch-B', 'b'.repeat(40));
    try {
      const run = await getRefreshRun(refreshId, { repoId, select: ['ownership_rule_epoch'] });
      assert.equal(run?.ownership_rule_epoch, 'epoch-B');
    } finally { await abandon(refreshId); }
  });

  test('an UNPUBLISHED run does not change the active epoch', async () => {
    // The property that makes the epoch mean "this corpus was walked under that
    // rule". A run that opened and died must not advertise compatibility it
    // never established.
    const { refreshId: published } = await openRun('epoch-published', 'c'.repeat(40));
    await publish(published);

    // …then a later run opens with a NEWER epoch and never publishes.
    const { refreshId: orphan } = await openRun('epoch-never-published', 'd'.repeat(40));
    try {
      const snap = await getActiveSnapshot(repoId);
      assert.equal(snap.ownershipRuleEpoch, 'epoch-published',
        'the ACTIVE epoch is the published one — an open-but-unpublished run must not move it');
    } finally { await abandon(orphan); }
  });

  test('a pre-adoption run reads back NULL, not the empty string', async () => {
    // NULL is the signal the promotion predicate keys on. A writer that
    // helpfully coerced it to '' would make an unverified snapshot compare
    // unequal to every real epoch by accident rather than by rule — right answer,
    // wrong reason, and it would break the moment '' became a legal epoch.
    const { refreshId } = await openRun(null, 'e'.repeat(40));
    try {
      const run = await getRefreshRun(refreshId, { repoId, select: ['ownership_rule_epoch'] });
      assert.equal(run.ownership_rule_epoch, null);
    } finally { await abandon(refreshId); }
  });

  // ── the ownership candidate set ──────────────────────────────────────────

  test('a PURE IMPORTER is in the candidate set', async () => {
    // THE reason the query is a UNION. A file that imports modules but exports
    // no extractable symbol appears only in `symbol_file_imports.importer_path`.
    // Feeding the ownership oracle `symbol_index` alone would leave it
    // unclassified, `isDisowned` would answer false by omission, and its edges
    // would carry forward forever — the exact domain-deps-observed.json
    // corruption the filter exists to close. No symbol-level assertion can see
    // this, which is why it is here and not in the pure suite.
    const { refreshId } = await openRun('epoch-paths', '1'.repeat(40));
    const pool = await getPool();
    try {
    await pool.query(
      `INSERT INTO symbol_file_imports (refresh_id, importer_path, imported_path)
       VALUES ($1, $2, $3)`,
      [refreshId, 'src/pure-importer.mjs', 'src/target.mjs'],
    );

      const paths = await listSnapshotFilePaths({ repoId, refreshId });
      assert.ok(paths.includes('src/pure-importer.mjs'),
        'a file present only in symbol_file_imports must still be a candidate — '
        + 'a symbol_index-only query leaves every pure importer unclassified');
    } finally { await abandon(refreshId); }
  });

  test('the candidate set is bound to the owning repo', async () => {
    // `symbol_file_imports` has no repo_id column, so the binding comes from the
    // refresh_runs join. An unbound read would let another repo's paths be
    // classified against THIS repo's git — where they would all answer
    // "disowned" and be deleted.
    const { refreshId } = await openRun('epoch-scope', '2'.repeat(40));
    const pool = await getPool();
    await pool.query(
      `INSERT INTO symbol_file_imports (refresh_id, importer_path, imported_path)
       VALUES ($1, $2, $3)`,
      [refreshId, 'src/theirs.mjs', 'src/target.mjs'],
    );

    const other = await upsertRepoByUuid({
      repoUuid: `${REPO_UUID}-other`, name: 'ownership-epoch-other-repo', fingerprint: null,
    });
    try {
      const paths = await listSnapshotFilePaths({ repoId: other.id, refreshId });
      assert.deepEqual(paths, [],
        "a refreshId belonging to another repo must yield nothing, not that repo's paths");
      // Negative control: the SAME refreshId under its OWN repo does return it,
      // so the assertion above cannot pass merely because the query is broken.
      const mine = await listSnapshotFilePaths({ repoId, refreshId });
      assert.ok(mine.includes('src/theirs.mjs'), 'the owning repo must still see its own paths');
    } finally {
      await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [other.id]);
      await abandon(refreshId);
    }
  });
});
