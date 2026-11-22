/**
 * @fileoverview The two audit-store reads of scripts/solo-control-audit.mjs
 * (target discovery, external-arm findings) plus the pure partition of the
 * discovery rows. Extracted from that over-1000-line file (it may not grow) so
 * the SQL is a testable string and the row handling is testable without a DB.
 *
 * @module scripts/lib/solo-control/store-queries
 */

/**
 * Discovery. A unit's identity is `(audited_sha, audited_tree)`; `commit_sha` is HEAD at capture time (the PARENT of a
 * dirty-tree audit). A row with NEITHER captured is an unresolved identity too, so it is NOT filtered out here: the
 * `WHERE ... IS NOT NULL` form dropped it silently, and an in-process count of what a filter excluded is impossible from the
 * same query (caught by the Gemini gate on the original plan). Dedup by `ar.id`, partition in JS.
 */
export const DISCOVER_COMMITS_SQL = `SELECT DISTINCT ON (ar.id) ar.id, ar.commit_sha, ar.audited_sha, ar.audited_tree
       FROM audit_findings f JOIN audit_runs ar ON ar.id = f.run_id
      WHERE f.arm IN ('B','C') AND ar.stage_type = $1
      ORDER BY ar.id`;

/**
 * External-arm (A/B/C) findings for a commit set, one row per (commit, arm, canonical_id). The pick among re-audits is
 * DETERMINISTIC: newest audit run first, then run id and fingerprint as a total order — an ORDER BY of only the DISTINCT ON
 * keys leaves which re-audit's row survives to the planner.
 */
export const EXTERNAL_FINDINGS_SQL = `SELECT DISTINCT ON (v.commit_sha, v.arm, v.canonical_id)
            v.commit_sha, v.arm, v.severity, v.outcome, v.canonical_id, v.finding_fingerprint,
            af.category, af.primary_file, af.detail_snapshot AS detail
       FROM model_ab_finding_scores v
       JOIN audit_runs ar ON ar.id = v.run_id
       LEFT JOIN audit_findings af
              ON af.run_id = v.run_id AND af.finding_fingerprint = v.finding_fingerprint
      WHERE v.stage_type = $1 AND v.commit_sha = ANY($2::text[]) AND v.arm IN ('A','B','C')
      ORDER BY v.commit_sha, v.arm, v.canonical_id, ar.created_at DESC, v.run_id DESC, v.finding_fingerprint`;

async function defaultQuery(sql, params) {
  const { query } = await import('../db/query.mjs');
  return query(sql, params);
}

/**
 * Partition raw `{commit_sha, audited_sha, audited_tree}` rows into usable audit units vs. incomplete-identity rows (either
 * field — or both — missing), and dedup units by the COMPOSITE `(audited_sha, audited_tree)` pair, never `audited_tree`
 * alone (two different diffs can land on the same tree from different HEADs). Pure.
 * @returns {{resolved: {commitSha:string, auditedSha:string, auditedTree:string}[], unresolvedIncompleteIdentityCount: number}}
 */
export function partitionDiscoveredRows(rows) {
  let unresolvedIncompleteIdentityCount = 0;
  const seen = new Set();
  const resolved = [];
  for (const row of rows) {
    if (!row.audited_sha || !row.audited_tree) { unresolvedIncompleteIdentityCount++; continue; }
    const key = `${row.audited_sha}:${row.audited_tree}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ commitSha: row.commit_sha, auditedSha: row.audited_sha, auditedTree: row.audited_tree });
  }
  return { resolved, unresolvedIncompleteIdentityCount };
}

/** @param {string} stageType @param {{query?: Function}} [deps] */
export async function discoverCommits(stageType, { query = defaultQuery } = {}) {
  const r = await query(DISCOVER_COMMITS_SQL, [stageType]);
  return partitionDiscoveredRows(r.rows);
}

/** @param {string[]} commits @param {string} stageType @param {{query?: Function}} [deps] */
export async function fetchExternalFindings(commits, stageType, { query = defaultQuery } = {}) {
  const r = await query(EXTERNAL_FINDINGS_SQL, [stageType, commits]);
  return r.rows;
}
