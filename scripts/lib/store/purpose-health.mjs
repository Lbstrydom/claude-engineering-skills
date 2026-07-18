/**
 * @fileoverview Purpose-health store reader (dashboard v2 Part 3). Pure DATA:
 * three repo-scoped governance COUNTs. Knows NOTHING about the purpose taxonomy
 * — the collector (collect-telemetry.mjs::collectPurposeHealth) owns that join.
 *
 * Repo-scoping is a correctness invariant: the audit DB is shared across consumer
 * repos, so every query filters `repo_id = $1`. `count(*)::int` keeps node-pg
 * from returning a bigint STRING that would crash the Zod number boundary.
 *
 * Plan: docs/plans/dashboard-purpose-view-v2.md §2 Part 3.
 *
 * @module scripts/lib/store/purpose-health
 */
import { one, many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

/**
 * @param {string} repoId
 * @param {{windowDays?: number}} [opts]
 * @returns {Promise<{cloud:boolean, recentHighFindings:number|null,
 *   plansWithFailingCriteria:number|null, refusedSecrets:number|null}>}
 *   Each metric is `null` when its individual query fails — a partial failure
 *   never sinks the whole section. `cloud:false` when the store is offline.
 */
export async function getPurposeHealth(repoId, opts = {}) {
  // Clamp to a sane positive-integer range — windowDays feeds an SQL interval;
  // a negative/zero/fractional/huge value would silently skew or blow up the
  // window. Bounded [1, 365], floored. (M2/M16)
  const raw = Number.isFinite(opts.windowDays) ? Math.floor(opts.windowDays) : 30;
  const windowDays = Math.max(1, Math.min(365, raw));
  const empty = { cloud: false, recentHighFindings: null, plansWithFailingCriteria: null, refusedSecrets: null };
  if (!repoId || !await isCloudEnabled()) return empty;

  // Each read isolated: a single failing query degrades that metric to null
  // (logged) rather than throwing the section.
  const recentHighFindings = await scalarOrNull(
    `SELECT count(*)::int AS n
       FROM audit_findings f JOIN audit_runs r ON f.run_id = r.id
      WHERE r.repo_id = $1 AND f.severity = 'HIGH'
        AND f.created_at >= now() - ($2 * interval '1 day')`,
    [repoId, windowDays], 'recentHighFindings');

  const plansWithFailingCriteria = await scalarOrNull(
    `SELECT count(DISTINCT i.plan_id)::int AS n
       FROM plan_verification_items i JOIN plans p ON i.plan_id = p.id
      WHERE p.repo_id = $1 AND i.passed = false AND i.severity IN ('P0','P1')
        AND i.created_at >= now() - ($2 * interval '1 day')`,
    [repoId, windowDays], 'plansWithFailingCriteria');

  const refusedSecrets = await scalarOrNull(
    `SELECT count(*)::int AS n
       FROM security_strategy_events
      WHERE repo_id = $1 AND event_kind = 'refused_secret'
        AND created_at >= now() - ($2 * interval '1 day')`,
    [repoId, windowDays], 'refusedSecrets');

  // v3 Part A: HIGH findings grouped by file → the collector attributes each
  // file to a domain → purpose. primary_file is nullable (its bucket becomes
  // "unattributable"). null on query failure (degrades like the scalars).
  let highByFile = null;
  try {
    highByFile = await many(
      `SELECT f.primary_file AS file, count(*)::int AS n
         FROM audit_findings f JOIN audit_runs r ON f.run_id = r.id
        WHERE r.repo_id = $1 AND f.severity = 'HIGH'
          AND f.created_at >= now() - ($2 * interval '1 day')
        GROUP BY f.primary_file`,
      [repoId, windowDays]);
  } catch (err) {
    process.stderr.write(`  [purpose-health] highByFile query failed (→ null): ${err.message}\n`);
    highByFile = null;
  }

  return { cloud: true, recentHighFindings, plansWithFailingCriteria, refusedSecrets, highByFile };
}

async function scalarOrNull(sql, params, label) {
  try {
    const row = await one(sql, params);
    return row?.n ?? 0;
  } catch (err) {
    process.stderr.write(`  [purpose-health] ${label} query failed (→ null): ${err.message}\n`);
    return null;
  }
}
