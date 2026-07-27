/**
 * @fileoverview Shared DB-integration test fixture helpers (AUDIT_DB_TEST_URL-
 * gated tests). Consolidated after the audit-code duplication wave flagged
 * `insertRefreshRun` as byte-identical across
 * tests/symbol-index-drift-justification.test.mjs and
 * tests/symbols-count-for-snapshot.test.mjs (similarity 0.87,
 * symbol-index-pipeline-reliability-hardening Theme 2 M3) — same pattern as
 * tests/helpers/fixtures.mjs for filesystem/git primitives.
 *
 * @module tests/helpers/db-fixtures
 */

/**
 * Insert a `published`, `full`-mode refresh_runs row for `repoId` and return
 * its id — the minimal fixture every drift/symbol DB-integration test needs
 * before it can attach symbol_index rows to a snapshot.
 *
 * @param {import('pg').Pool} pool
 * @param {string} repoId
 * @returns {Promise<string>} the new refresh_runs.id
 */
export async function insertRefreshRun(pool, repoId) {
  const { rows } = await pool.query(
    `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'full', 'published') RETURNING id`,
    [repoId],
  );
  return rows[0].id;
}
