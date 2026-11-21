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
import { strictCount } from './build.mjs';

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
 * @param {object} [opts]
 * @param {(client: object) => Promise<void>} [opts.extraReads]  `telemetry-export --report` only: more reads INSIDE the
 *   same snapshot transaction, after the export's own. It never changes what this returns. `--print` and delivery
 *   never pass it, so the exported document is byte-identical to what it was without the hook. Its own errors are its
 *   caller's to isolate (`report.mjs` runs each group under a SAVEPOINT); one that escapes fails the read.
 * @returns {(w: {from: Date, to: Date}) => Promise<object>}
 */
export function makeRowReader(deps, { extraReads } = {}) {
  return async function readRows({ from, to }) {
    const ident = deps.resolveRepoIdentity();
    if (!ident?.repoUuid) {
      if (!extraReads) return { status: 'repo-unresolved' };
      // `--report` only: its groups are store-wide and need no repo, so they still run in a snapshot. The export's own groups
      // stay unmeasured exactly as without the hook.
      return deps.withTx(async (client) => {
        await deps.query(SQL.setTx);
        await extraReads(client);
        return { status: 'repo-unresolved' };
      });
    }
    // The export's own reads. INSIDE the snapshot: the repo row and the aggregates scoped to it describe the same instant, so a repo
    // removed in between cannot turn into "an empty week". Strict lookup: a DB error throws (read-failed /
    // store-unreachable), never reads as "unregistered".
    const readExport = async () => {
      const repo = await deps.getRepoIdByUuid(ident.repoUuid);
      if (!repo) return { status: 'repo-unregistered' };
      const f = from.toISOString(); const t = to.toISOString();
      const runs = await deps.many(SQL.runs, [repo.id, f, t]);
      const findings = await deps.many(SQL.findings, [repo.id, f, t]);
      const upstream = await deps.many(SQL.upstream, [repo.id, t]);
      const total = await deps.many(SQL.upstreamTotal, [repo.id, t]);
      // The total row must exist and be a real count: a missing row read as 0 would be a measured "no open reports".
      return { status: 'ok', runs, findings, upstream, totalOpen: strictCount(total?.[0]?.n, 'upstream total') };
    };
    return deps.withTx(async (client) => {
      await deps.query(SQL.setTx);
      if (!extraReads) return readExport();
      // `--report` only. The export's reads run under a SAVEPOINT so one failing (a schema fault) cannot abort the transaction the
      // report's store-wide groups still need. The hook runs regardless; the export's error then surfaces for the export groups,
      // exactly as it does without the hook. (The default path above issues no extra statement: --print is unchanged.)
      await deps.query('SAVEPOINT export_reads');
      let result; let exportError = null;
      try {
        result = await readExport();
        await deps.query('RELEASE SAVEPOINT export_reads');
      } catch (err) {
        exportError = err;
        // If the connection cannot even undo, nothing more can run: surface the original error.
        try { await deps.query('ROLLBACK TO SAVEPOINT export_reads'); } catch { throw err; }
      }
      await extraReads(client);
      if (exportError) throw exportError;
      return result;
    });
  };
}
