/**
 * @fileoverview The store reads behind `telemetry-export/v1` — read-only, one
 * snapshot, repo-scoped.
 *
 * Every statement here is a SELECT (asserted by `isReadOnlyStatement` in the tests, and
 * the transaction itself is `READ ONLY`, so even a future edit cannot write). All of them
 * run inside ONE `REPEATABLE READ` transaction so the audit and upstream groups describe
 * the same instant (field-source table in `build.mjs`).
 *
 * The repo is resolved WITHOUT writing: `resolveRepoForStore` upserts an `audit_repos`
 * row, which an exporter must never do, so this looks the repo up by its stable uuid
 * through the existing strict reader and reports `repo-unregistered` when there is none.
 *
 * Nothing here returns a repo name, path, title or body: the SELECT lists name only the
 * columns the schema can carry.
 *
 * @module scripts/lib/telemetry-export/sources
 */
import { MAX_UPSTREAM_ROWS } from './schema.mjs';

export const SQL = Object.freeze({
  setTx: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
  runs: `SELECT mode, gemini_verdict, (round_converged_after IS NOT NULL) AS converged, count(*)::int AS n
           FROM audit_runs
          WHERE repo_id = $1 AND created_at >= $2 AND created_at < $3
          GROUP BY mode, gemini_verdict, (round_converged_after IS NOT NULL)`,
  findings: `SELECT f.severity, f.adjudication_outcome, f.pass_name, count(*)::int AS n
               FROM audit_findings f
               JOIN audit_runs r ON r.id = f.run_id
              WHERE r.repo_id = $1 AND r.created_at >= $2 AND r.created_at < $3
              GROUP BY f.severity, f.adjudication_outcome, f.pass_name`,
  upstream: `SELECT id, severity, created_at
               FROM upstream_issues
              WHERE repo_id = $1 AND state = 'open' AND created_at < $2
              ORDER BY created_at ASC, id ASC
              LIMIT ${MAX_UPSTREAM_ROWS}`,
  upstreamTotal: `SELECT count(*)::int AS n FROM upstream_issues WHERE repo_id = $1 AND state = 'open' AND created_at < $2`,
});

/**
 * @param {object} deps injected so the whole read is testable against a fake store
 * @param {(fn: (client: object) => Promise<any>) => Promise<any>} deps.withTx
 * @param {(sql: string, params?: any[]) => Promise<any[]>} deps.many
 * @param {(sql: string, params?: any[]) => Promise<any>} deps.query
 * @param {(uuid: string) => Promise<{id: string}|null>} deps.getRepoIdByUuid   strict lookup
 * @param {() => {repoUuid: string|null}} deps.resolveRepoIdentity
 * @returns {(w: {from: Date, to: Date}) => Promise<object>}
 */
export function makeRowReader(deps) {
  return async function readRows({ from, to }) {
    const ident = deps.resolveRepoIdentity();
    if (!ident?.repoUuid) return { status: 'repo-unresolved' };
    // strict: a DB error throws (reported as read-failed / store-unreachable), never reads as "unregistered".
    const repo = await deps.getRepoIdByUuid(ident.repoUuid);
    if (!repo) return { status: 'repo-unregistered' };

    return deps.withTx(async () => {
      await deps.query(SQL.setTx);
      const f = from.toISOString(); const t = to.toISOString();
      const runs = await deps.many(SQL.runs, [repo.id, f, t]);
      const findings = await deps.many(SQL.findings, [repo.id, f, t]);
      const upstream = await deps.many(SQL.upstream, [repo.id, t]);
      const total = await deps.many(SQL.upstreamTotal, [repo.id, t]);
      return { status: 'ok', runs, findings, upstream, totalOpen: Number(total?.[0]?.n) || 0 };
    });
  };
}
